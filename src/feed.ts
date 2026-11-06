import { WebSocket } from 'ws';
import type { Clock } from './clock.js';

export const HEARTBEAT_MS = 2_500; // the docs' sample interval; the server drops a silent connection after 15 s

export interface FeedFill {
  id: number;
  orderId: number;
  contractId: number;
  action: 'Buy' | 'Sell';
  qty: number;
}

export interface FeedOptions {
  wsUrl: string;
  clock: Clock;
  accountId: number;
  getToken: () => Promise<string | null>;
  onFill: (fill: FeedFill) => Promise<void>;
  /** Runs after every connection is up, the first included. */
  onConnected: () => Promise<void>;
  stallMs: number;
  /** Real-time wait for a frame the server should answer at once. */
  replyDeadlineMs?: number;
}

/**
 * The master feed: one socket, authorize, one sync per connection, heartbeats, reconnect. Frames
 * are handled one at a time in arrival order. Virtual time moves through `tick`, which the driver
 * calls at least every HEARTBEAT_MS of clock time.
 */
export class Feed {
  private ws: WebSocket | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly waiters = new Map<number, (status: number) => void>();
  private pongWaiter: (() => void) | undefined;
  private lastPing = 0;
  private lastServer = 0;
  private seq = 2;
  private closing = false;
  private failure: unknown;
  private readonly replyDeadlineMs: number;

  constructor(private readonly opts: FeedOptions) {
    this.replyDeadlineMs = opts.replyDeadlineMs ?? 500;
  }

  /** Opens the socket and syncs once. Returns false when the connection could not be established. */
  async connect(): Promise<boolean> {
    const token = await this.opts.getToken();
    if (!token) return false;
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;
    const opened = new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(false));
      ws.once('close', () => resolve(false));
      ws.on('error', () => {}); // a dropped socket shows up as a closed one on the next tick
      ws.on('message', (data) => {
        const text = data.toString();
        if (text === 'o') resolve(true);
        else this.onMessage(text);
        this.lastServer = this.opts.clock.now();
      });
    });
    if (!(await opened)) return false;

    if ((await this.request(`authorize\n0\n\n${token}`, 0)) !== 200) return false;
    const sync = { splitResponses: true, accounts: [this.opts.accountId], entityTypes: ['fill'] };
    if ((await this.request(`user/syncrequest\n1\n\n${JSON.stringify(sync)}`, 1)) !== 200) return false;
    this.lastPing = this.opts.clock.now();
    await this.opts.onConnected();
    return true;
  }

  /** Heartbeat and stall detection. Reconnects when the socket is gone or the server went silent. */
  async tick(): Promise<void> {
    if (this.closing) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
      return;
    }
    const now = this.opts.clock.now();
    if (now - this.lastPing >= HEARTBEAT_MS) {
      this.lastPing = now;
      const pong = new Promise<void>((resolve) => (this.pongWaiter = resolve));
      this.ws.send('[]');
      await withDeadline(pong, this.replyDeadlineMs);
    }
    if (this.opts.clock.now() - this.lastServer >= this.opts.stallMs) {
      this.ws.terminate();
      await this.connect();
    }
  }

  /** Every frame the server sent before this call has been received and handled. */
  async settle(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const id = this.seq++;
      await withDeadline(this.request(`__barrier\n${id}\n\n`, id), this.replyDeadlineMs); // simulator-only frame
    }
    await this.chain;
    if (this.failure) throw this.failure;
  }

  close(): void {
    this.closing = true;
    this.ws?.terminate();
  }

  private request(frame: string, id: number): Promise<number> {
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.ws?.send(frame);
    });
  }

  private onMessage(text: string): void {
    if (text === 'h') {
      this.pongWaiter?.();
      return;
    }
    if (!text.startsWith('a[')) return;
    for (const item of JSON.parse(text.slice(1)) as Array<Record<string, any>>) {
      if (item.e === 'props' && item.d?.entityType === 'fill' && item.d?.eventType === 'Created') {
        const fill = item.d.entity as FeedFill;
        this.chain = this.chain.then(() => this.opts.onFill(fill)).catch((reason: unknown) => {
          this.failure = reason;
        });
      } else if (typeof item.i === 'number') {
        this.waiters.get(item.i)?.(item.s as number);
        this.waiters.delete(item.i);
      }
    }
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

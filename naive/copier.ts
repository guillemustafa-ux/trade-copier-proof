import type { Book } from '../sim/book.js';
import { Api } from '../src/api.js';
import type { Clock } from '../src/clock.js';
import { Feed, HEARTBEAT_MS, type FeedFill } from '../src/feed.js';

/**
 * A deliberately simple copier, the comparator in `npm run demo`. It keeps its state in memory,
 * retries on any failure, replays recent fills after a reconnect, treats any 200 as placed, and
 * closes with what it believes it sent.
 *
 * It models a class of failure. It is NOT anyone's real copier, and this repo makes no claim about
 * why any real copier duplicates orders.
 */
const RETRIES = 3;
const REPLAYED_FILLS = 5;

export interface NaiveOptions {
  clock: Clock;
  apiUrl: string;
  wsUrl: string;
  book: Book;
  sizing: (accountId: number) => { multiplier: number; maxContracts: number; enabled: boolean };
  /** Virtual time between orders on one login, the same pace the engine uses in the demo. */
  minBatchIntervalMs: number;
  httpTimeoutMs?: number;
}

export class NaiveCopier {
  private readonly api: Api;
  private readonly feed: Feed;
  private readonly tokens = new Map<string, string>();
  private readonly believed = new Map<number, number>();
  private readonly queue: FeedFill[] = [];
  private symbol = '';
  private connections = 0;

  constructor(private readonly opts: NaiveOptions) {
    this.api = new Api(opts.apiUrl, opts.httpTimeoutMs ?? 5_000);
    this.feed = new Feed({
      wsUrl: opts.wsUrl,
      clock: opts.clock,
      accountId: opts.book.master.accountId,
      getToken: () => this.token(opts.book.master.login),
      onFill: async (fill) => {
        this.queue.push(fill);
      },
      onConnected: () => this.onConnected(),
      stallMs: 10_000,
    });
  }

  async start(): Promise<void> {
    await this.feed.connect();
    await this.feed.settle();
  }

  stop(): void {
    this.feed.close();
  }

  async runUntilIdle(): Promise<void> {
    await this.feed.settle();
    while (this.queue.length) await this.copy(this.queue.shift()!);
  }

  async runFor(ms: number): Promise<void> {
    await this.hopTo(this.opts.clock.now() + ms);
    await this.runUntilIdle();
  }

  /** Closes every account with what it believes it holds, on the same pacing as a copy. */
  async closeAll(): Promise<void> {
    const orders = new Map<string, Array<{ accountId: number; action: 'Buy' | 'Sell'; qty: number; clOrdId: string }>>();
    let seq = 0;
    for (const account of this.opts.book.accounts) {
      const net = this.believed.get(account.id) ?? 0;
      if (net === 0) continue;
      this.believed.set(account.id, 0);
      const list = orders.get(account.login) ?? [];
      list.push({ accountId: account.id, action: net > 0 ? 'Sell' : 'Buy', qty: Math.abs(net), clOrdId: `n-close-${seq++}-${account.id}` });
      orders.set(account.login, list);
    }
    await this.fanOut(orders);
  }

  private async hopTo(t: number): Promise<void> {
    const { clock } = this.opts;
    while (clock.now() < t) {
      await clock.advanceTo(Math.min(t, clock.now() + HEARTBEAT_MS));
      await this.feed.tick();
    }
    await this.feed.settle();
  }

  private async onConnected(): Promise<void> {
    this.connections++;
    if (this.connections === 1) return;
    // Nothing is remembered, so after a reconnect it plays the recent fills again to be safe.
    const token = await this.token(this.opts.book.master.login);
    const raw = await this.api.get('fill/list', token);
    if (raw.status === 200) this.queue.push(...(raw.json as FeedFill[]).slice(-REPLAYED_FILLS));
  }

  private async copy(fill: FeedFill): Promise<void> {
    if (!this.symbol) {
      const token = await this.token(this.opts.book.master.login);
      this.symbol = (await this.api.get(`contract/item?id=${fill.contractId}`, token)).json?.name ?? '';
    }
    const orders = new Map<string, Array<{ accountId: number; action: 'Buy' | 'Sell'; qty: number; clOrdId: string }>>();
    for (const account of this.opts.book.accounts) {
      const sizing = this.opts.sizing(account.id);
      if (!sizing.enabled) continue;
      const qty = Math.min(sizing.maxContracts, Math.trunc(fill.qty * sizing.multiplier)); // per fill: partial fills round wrong
      if (qty === 0) continue;
      const list = orders.get(account.login) ?? [];
      // It does send a clOrdId. The server stores it and does not enforce it, so that alone protects nothing.
      list.push({ accountId: account.id, action: fill.action, qty, clOrdId: `n-${fill.id}-${account.id}` });
      orders.set(account.login, list);
      this.believed.set(account.id, (this.believed.get(account.id) ?? 0) + (fill.action === 'Buy' ? qty : -qty));
    }
    await this.fanOut(orders);
  }

  /** One order per login at a time, all logins side by side, one virtual pacing slot per round. */
  private async fanOut(orders: Map<string, Array<{ accountId: number; action: 'Buy' | 'Sell'; qty: number; clOrdId: string }>>): Promise<void> {
    const logins = [...orders.values()];
    const rounds = Math.max(0, ...logins.map((l) => l.length));
    const names = [...orders.keys()];
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        names.map(async (login) => {
          const order = orders.get(login)![round];
          if (order) await this.send(login, order);
        }),
      );
      await this.hopTo(this.opts.clock.now() + this.opts.minBatchIntervalMs);
    }
  }

  private async send(login: string, order: { accountId: number; action: 'Buy' | 'Sell'; qty: number; clOrdId: string }): Promise<void> {
    const body = { accountId: order.accountId, accountSpec: login, action: order.action, symbol: this.symbol, orderQty: order.qty, orderType: 'Market', isAutomated: true, clOrdId: order.clOrdId };
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const raw = await this.api.request('POST', 'order/placeorder', await this.token(login), body);
      if (raw.status === 200) return; // any 200 is taken as placed, including a penalty or a rejection
      if (raw.status === 401) this.tokens.delete(login); // a fresh session, never a renewal
    }
  }

  private async token(login: string): Promise<string> {
    const known = this.tokens.get(login);
    if (known) return known;
    const entry = login === this.opts.book.master.login ? this.opts.book.master : this.opts.book.logins.find((l) => l.name === login)!;
    const raw = await this.api.request('POST', 'auth/accesstokenrequest', undefined, { name: login, password: entry.password });
    const token = String(raw.json?.accessToken ?? '');
    if (token) this.tokens.set(login, token);
    return token;
  }
}

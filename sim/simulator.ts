import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { Clock } from '../src/clock.js';
import type { Book } from './book.js';
import type { Fault, FaultRule, LostMode } from './faults.js';

/**
 * A local server speaking the documented Tradovate paths and shapes, that misbehaves on purpose.
 * Facts and modeled assumptions: docs/sources.md. It has no timers: delays, expiry and penalties
 * are computed from the injected clock when a request arrives.
 */
export const TOKEN_LIFE_MS = 80 * 60_000;
const HOUR_MS = 3_600_000;
const IDLE_DROP_MS = 15_000;
const EARLY_RETRIES_BEFORE_429 = 3; // modeled: the docs say "eventually", with no number
const SIM_PRICE = 5000.25;

export const DEFAULT_CONTRACT = { id: 3001, name: 'ESZ6' };

interface Session {
  login: string;
  token: string;
  expiresAt: number;
  closed: boolean;
}
interface LoginState {
  name: string;
  password: string;
  userId: number;
  accountIds: Set<number>;
  sessions: Session[];
  lockedUntil: number;
  captcha: boolean;
  penalty?: { ticket: string; until: number; backoffMs: number; early: number };
  inFlight: number;
  maxInFlight: number;
}
export interface SimOrder {
  id: number;
  accountId: number;
  contractId: number;
  action: 'Buy' | 'Sell';
  qty: number;
  clOrdId?: string;
  isAutomated: boolean;
  ordStatus: string;
  /** Simulated acceptance time: the virtual arrival plus a fixed per-account network delay. */
  acceptedAt: number;
  arrivedAt: number;
  visibleAt: number;
  applied: boolean;
  filled: number;
  login: string;
  viaTicket: boolean;
}
export interface SimFill {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  tradeDate: { year: number; month: number; day: number };
  action: 'Buy' | 'Sell';
  qty: number;
  price: number;
  active: boolean;
  finallyPaired: number;
  at: number;
}
export interface SimRequest {
  at: number;
  endpoint: string;
  login?: string;
  accountId?: number;
  clOrdId?: string;
  ticket?: string;
  status: number;
}
interface FeedConn {
  ws: WebSocket;
  login?: string;
  synced: boolean;
  syncs: number;
  stalled: boolean;
  lastRecv: number;
}
interface SimPosition {
  id: number;
  accountId: number;
  contractId: number;
  netPos: number;
  bought: number;
  sold: number;
  boughtValue: number;
  soldValue: number;
}
type Body = Record<string, unknown>;

export interface SimulatorOptions {
  clock: Clock;
  book: Book;
  plan?: FaultRule[];
  /** Status an evicted token answers with: the docs list 408, 429 or 500 level errors. */
  evictStatus?: number;
}

export class Simulator {
  readonly requests: SimRequest[] = [];
  readonly orders: SimOrder[] = [];
  readonly fills: SimFill[] = [];
  heartbeats = 0;
  framesDropped = 0;
  url = '';
  wsUrl = '';

  private readonly clock: Clock;
  private readonly plan: FaultRule[];
  private readonly evictStatus: number;
  private readonly logins = new Map<string, LoginState>();
  private readonly accountNames = new Map<number, string>();
  private readonly positions = new Map<string, SimPosition>();
  private readonly tokens = new Map<string, Session>();
  private readonly counts = new Map<string, number>();
  private readonly conns = new Set<FeedConn>();
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private seq = 1;

  constructor(opts: SimulatorOptions) {
    this.clock = opts.clock;
    this.plan = opts.plan ?? [];
    this.evictStatus = opts.evictStatus ?? 500;
    const add = (name: string, password: string, accountIds: number[]) =>
      this.logins.set(name, {
        name,
        password,
        userId: this.logins.size + 1,
        accountIds: new Set(accountIds),
        sessions: [],
        lockedUntil: 0,
        captcha: false,
        inFlight: 0,
        maxInFlight: 0,
      });
    add(opts.book.master.login, opts.book.master.password, [opts.book.master.accountId]);
    this.accountNames.set(opts.book.master.accountId, 'MASTER');
    for (const login of opts.book.logins) add(login.name, login.password, login.accountIds);
    for (const account of opts.book.accounts) this.accountNames.set(account.id, account.name);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((reason: unknown) => {
        if (!res.headersSent) this.json(res, 500, { errorText: String(reason) });
      });
    });
    this.wss = new WebSocketServer({ server: this.server, path: '/v1/websocket' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}/v1/websocket`;
  }

  async close(): Promise<void> {
    for (const conn of this.conns) conn.ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- scenario controls and ground truth, used by tests and the demo ------------------------

  /** The master trades: one order, one fill per entry of `fills`, frames delivered in `delivery` order. */
  masterTrade(t: { action: 'Buy' | 'Sell'; fills: number[]; delivery?: number[] }): number[] {
    const master = [...this.logins.values()][0]!;
    const accountId = [...master.accountIds][0]!;
    const now = this.clock.now();
    const qty = t.fills.reduce((a, b) => a + b, 0);
    const order = this.newOrder(master.name, accountId, t.action, qty, DEFAULT_CONTRACT.id, undefined, true);
    order.applied = true;
    order.filled = qty;
    order.ordStatus = 'Filled';
    order.acceptedAt = now;
    const fills = t.fills.map((q) => this.addFill(order, q));
    for (const index of t.delivery ?? t.fills.map((_, i) => i)) this.emitFill(fills[index]!);
    return fills.map((f) => f.id);
  }

  /** A position that was already on the account, not placed by any copier. */
  seedPosition(accountId: number, netPos: number): void {
    const login = this.loginOfAccount(accountId);
    const order = this.newOrder(login.name, accountId, netPos > 0 ? 'Buy' : 'Sell', Math.abs(netPos), DEFAULT_CONTRACT.id, undefined, false);
    order.applied = true;
    order.filled = order.qty;
    order.ordStatus = 'Filled';
    this.addFill(order, order.qty);
  }

  /** The current feed connection goes silent: no frames, no heartbeat replies. Its frames are lost. */
  stallFeed(): void {
    for (const conn of this.conns) conn.stalled = true;
  }

  /** Opens a session for a login as another client would, closing the oldest past two. */
  openSession(login: string): string {
    return this.createSession(this.logins.get(login)!).token;
  }

  ordersOf(accountId: number): SimOrder[] {
    return this.orders.filter((o) => o.accountId === accountId);
  }

  positionOf(accountId: number, contractId = DEFAULT_CONTRACT.id): number {
    this.materialize();
    return this.positions.get(`${accountId}:${contractId}`)?.netPos ?? 0;
  }

  /** Requests the server saw, optionally for one endpoint and login. */
  count(endpoint?: string, login?: string): number {
    return this.requests.filter((r) => (!endpoint || r.endpoint === endpoint) && (!login || r.login === login)).length;
  }

  /** Sessions still open for a login. */
  sessions(login: string): number {
    return this.logins.get(login)!.sessions.filter((s) => !s.closed).length;
  }

  maxInFlight(login: string): number {
    return this.logins.get(login)!.maxInFlight;
  }

  // ---- HTTP ------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const path = url.pathname.toLowerCase();
    const raw = await readBody(req);
    if (path === '/__control/clock') {
      if (req.method === 'POST') await this.clock.advanceTo((JSON.parse(raw) as { to: number }).to);
      return this.json(res, 200, { now: this.clock.now() });
    }
    if (!path.startsWith('/v1/')) return this.json(res, 404, {});
    const endpoint = path.slice(4);
    const body = (raw ? JSON.parse(raw) : {}) as Body;
    this.materialize();
    this.dropIdleConnections();

    const entry: SimRequest = { at: this.clock.now(), endpoint, status: 0 };
    if (typeof body.accountId === 'number') entry.accountId = body.accountId;
    if (typeof body.clOrdId === 'string') entry.clOrdId = body.clOrdId;
    if (typeof body['p-ticket'] === 'string') entry.ticket = body['p-ticket'];
    this.requests.push(entry);
    res.once('finish', () => (entry.status = res.statusCode));

    if (endpoint === 'auth/accesstokenrequest') return this.accessTokenRequest(body, res, entry);

    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const session = this.tokens.get(token);
    if (!session) return this.json(res, 401, { errorText: 'Access is denied' });
    const login = this.logins.get(session.login)!;
    entry.login = login.name;

    const now = this.clock.now();
    if (login.lockedUntil > now) {
      login.lockedUntil = now + HOUR_MS; // documented: every early call resets the one-hour clock
      return this.empty(res, 429);
    }
    if (session.closed) return this.empty(res, this.evictStatus);
    if (now >= session.expiresAt) return this.json(res, 401, { errorText: 'Access is denied' });

    login.inFlight++;
    login.maxInFlight = Math.max(login.maxInFlight, login.inFlight);
    res.once('close', () => login.inFlight--);
    return this.route(endpoint, login, session, url, body, res);
  }

  private route(endpoint: string, login: LoginState, session: Session, url: URL, body: Body, res: ServerResponse): void {
    const id = Number(url.searchParams.get('id'));
    if (endpoint === 'order/placeorder') return this.placeOrder(login, session, body, res);
    const rule = this.matchRule(endpoint, login, Number(url.searchParams.get('masterid')) || undefined);
    if (rule?.fault.kind === 'lostBeforeAccept') return this.lose(res, rule.fault.mode);

    const mine = (accountId: number) => login.accountIds.has(accountId);
    const visible = this.orders.filter((o) => o.applied && mine(o.accountId));
    switch (endpoint) {
      case 'auth/renewaccesstoken':
        return this.renew(login, session, res);
      case 'auth/me':
        return this.json(res, 200, { userId: login.userId, name: login.name, status: 'Active' });
      case 'order/cancelorder':
        return this.cancelOrder(login, body, res);
      case 'order/list':
        return this.json(res, 200, visible.map(orderEntity));
      case 'order/deps':
        return this.json(res, 200, visible.filter((o) => o.accountId === Number(url.searchParams.get('masterid'))).map(orderEntity));
      case 'order/item': {
        const order = visible.find((o) => o.id === id);
        return order ? this.json(res, 200, orderEntity(order)) : this.json(res, 404, {});
      }
      case 'fill/list':
        return this.json(res, 200, this.fills.filter((f) => visible.some((o) => o.id === f.orderId)).map(fillEntity));
      case 'fill/item': {
        const fill = this.fills.find((f) => f.id === id);
        return fill ? this.json(res, 200, fillEntity(fill)) : this.json(res, 404, {});
      }
      case 'position/list':
        return this.json(res, 200, [...this.positions.values()].filter((p) => mine(p.accountId)).map((p) => this.positionEntity(p)));
      case 'account/list':
        return this.json(res, 200, [...login.accountIds].map((accountId) => ({ id: accountId, name: this.accountNames.get(accountId), userId: login.userId, active: true, accountType: 'Customer' })));
      case 'contract/item':
        return id === DEFAULT_CONTRACT.id ? this.json(res, 200, { ...DEFAULT_CONTRACT, contractMaturityId: 1, timestamp: new Date(this.clock.now()).toISOString() }) : this.json(res, 404, {});
      default:
        return this.json(res, 404, {});
    }
  }

  private accessTokenRequest(body: Body, res: ServerResponse, entry: SimRequest): void {
    const login = this.logins.get(String(body.name));
    if (!login || login.password !== body.password) return this.json(res, 200, { errorText: 'Incorrect username or password.' });
    entry.login = login.name;
    if (login.lockedUntil > this.clock.now()) {
      login.lockedUntil = this.clock.now() + HOUR_MS;
      return this.empty(res, 429);
    }
    const session = this.createSession(login);
    this.json(res, 200, this.tokenResponse(login, session));
  }

  private renew(login: LoginState, session: Session, res: ServerResponse): void {
    this.tokens.delete(session.token); // modeled: the previous token stops working at once
    session.token = this.newToken(login.name);
    session.expiresAt = this.clock.now() + TOKEN_LIFE_MS;
    this.tokens.set(session.token, session);
    this.json(res, 200, this.tokenResponse(login, session));
  }

  private createSession(login: LoginState): Session {
    const session: Session = { login: login.name, token: this.newToken(login.name), expiresAt: this.clock.now() + TOKEN_LIFE_MS, closed: false };
    login.sessions.push(session);
    this.tokens.set(session.token, session);
    const open = login.sessions.filter((s) => !s.closed);
    for (const old of open.slice(0, Math.max(0, open.length - 2))) old.closed = true;
    return session;
  }

  private newToken(login: string): string {
    return `sim-token-${login}-${this.seq++}`;
  }

  private tokenResponse(login: LoginState, session: Session) {
    return {
      accessToken: session.token,
      expirationTime: new Date(session.expiresAt).toISOString(),
      userStatus: 'Active',
      userId: login.userId,
      name: login.name,
    };
  }

  // ---- orders ----------------------------------------------------------------------------------

  private placeOrder(login: LoginState, session: Session, body: Body, res: ServerResponse): void {
    if (login.captcha) return this.empty(res, 423);
    if (typeof body.action !== 'string' || typeof body.symbol !== 'string' || typeof body.orderQty !== 'number' || typeof body.orderType !== 'string') {
      return this.json(res, 400, { errorText: 'action, symbol, orderQty and orderType are required' });
    }
    const accountId = Number(body.accountId);
    let viaTicket = false;
    const penalty = login.penalty;
    if (penalty) {
      const now = this.clock.now();
      if (now < penalty.until || body['p-ticket'] !== penalty.ticket) {
        penalty.until = Math.max(now, penalty.until) + penalty.backoffMs; // documented: p-time is additive
        penalty.early++;
        if (penalty.early > EARLY_RETRIES_BEFORE_429) {
          login.lockedUntil = now + HOUR_MS;
          login.penalty = undefined;
          return this.empty(res, 429);
        }
        return this.json(res, 200, this.ticketBody(penalty.ticket, Math.ceil((penalty.until - now) / 1000)));
      }
      login.penalty = undefined;
      viaTicket = true;
    }
    if (!login.accountIds.has(accountId)) return this.json(res, 200, { failureReason: 'Unauthorized', failureText: 'Account does not belong to this user' });
    if (body.symbol !== DEFAULT_CONTRACT.name) return this.json(res, 200, { failureReason: 'InvalidContract', failureText: 'Unknown symbol' });

    const rule = viaTicket ? undefined : this.matchRule('order/placeorder', login, accountId);
    const fault: Fault | undefined = rule?.fault;
    const accept = (visibleAfterMs = 0, filled?: number) => {
      const order = this.newOrder(login.name, accountId, body.action as 'Buy' | 'Sell', body.orderQty as number, DEFAULT_CONTRACT.id, body.clOrdId as string | undefined, body.isAutomated === true);
      order.viaTicket = viaTicket;
      order.visibleAt = this.clock.now() + visibleAfterMs;
      if (filled !== undefined) order.filled = filled;
      this.materialize();
      return order;
    };
    switch (fault?.kind) {
      case 'lostAfterAccept':
        accept(fault.visibleAfterMs ?? 0);
        return this.lose(res, fault.mode);
      case 'lostBeforeAccept':
        return this.lose(res, fault.mode);
      case 'delayedVisibility':
        return this.json(res, 200, { orderId: accept(fault.delayMs).id });
      case 'penalty': {
        const ticket = `sim-ticket-${this.seq++}`;
        login.penalty = { ticket, until: this.clock.now() + fault.pTime * 1000, backoffMs: fault.pTime * 1000, early: 0 };
        return this.json(res, 200, this.ticketBody(ticket, fault.pTime));
      }
      case 'captcha':
        login.captcha = true;
        return this.json(res, 200, { ...this.ticketBody(`sim-ticket-${this.seq++}`, 3600), 'p-captcha': true });
      case 'lockout429':
        login.lockedUntil = this.clock.now() + HOUR_MS;
        return this.empty(res, 429);
      case 'evict':
        for (let i = 0; i < 2 && !session.closed; i++) this.createSession(login);
        return this.empty(res, this.evictStatus);
      case 'expireToken':
        session.expiresAt = this.clock.now();
        return this.json(res, 401, { errorText: 'Access is denied' });
      case 'reject':
        return this.json(res, 200, { failureReason: fault.reason, failureText: `Simulated rejection: ${fault.reason}` });
      case 'partialFill':
        return this.json(res, 200, { orderId: accept(0, fault.filled).id });
      default:
        return this.json(res, 200, { orderId: accept().id });
    }
  }

  private cancelOrder(login: LoginState, body: Body, res: ServerResponse): void {
    const order = this.orders.find((o) => o.id === body.orderId && login.accountIds.has(o.accountId));
    if (!order || order.ordStatus !== 'Working') return this.json(res, 200, { failureReason: 'TooLate', failureText: 'Order is not working' });
    order.ordStatus = 'Canceled';
    this.json(res, 200, { commandId: this.seq++ });
  }

  private newOrder(login: string, accountId: number, action: 'Buy' | 'Sell', qty: number, contractId: number, clOrdId: string | undefined, isAutomated: boolean): SimOrder {
    const now = this.clock.now();
    const nth = this.bump(`latency:${accountId}`);
    const order: SimOrder = {
      id: this.seq++,
      accountId,
      contractId,
      action,
      qty,
      isAutomated,
      ordStatus: 'PendingNew',
      arrivedAt: now,
      acceptedAt: now + simulatedDelayMs(accountId, nth),
      visibleAt: now,
      applied: false,
      filled: qty,
      login,
      viaTicket: false,
      ...(clOrdId ? { clOrdId } : {}),
    };
    this.orders.push(order);
    return order;
  }

  /** Orders past their visibility time become visible and fill. Worst case: nothing shows before that. */
  private materialize(): void {
    const now = this.clock.now();
    for (const order of this.orders) {
      if (order.applied || order.visibleAt > now) continue;
      order.applied = true;
      order.ordStatus = order.filled < order.qty ? 'Working' : 'Filled';
      if (order.filled > 0) this.addFill(order, order.filled);
    }
  }

  private addFill(order: SimOrder, qty: number): SimFill {
    const at = this.clock.now();
    const d = new Date(at);
    const fill: SimFill = {
      id: this.seq++,
      orderId: order.id,
      contractId: order.contractId,
      timestamp: d.toISOString(),
      tradeDate: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
      action: order.action,
      qty,
      price: SIM_PRICE,
      active: true,
      finallyPaired: 0,
      at,
    };
    this.fills.push(fill);
    const key = `${order.accountId}:${order.contractId}`;
    const position = this.positions.get(key) ?? { id: this.seq++, accountId: order.accountId, contractId: order.contractId, netPos: 0, bought: 0, sold: 0, boughtValue: 0, soldValue: 0 };
    if (order.action === 'Buy') {
      position.bought += qty;
      position.boughtValue += qty * SIM_PRICE;
      position.netPos += qty;
    } else {
      position.sold += qty;
      position.soldValue += qty * SIM_PRICE;
      position.netPos -= qty;
    }
    this.positions.set(key, position);
    return fill;
  }

  private positionEntity(p: SimPosition) {
    const d = new Date(this.clock.now());
    return {
      ...p,
      timestamp: d.toISOString(),
      tradeDate: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
      prevPos: 0,
    };
  }

  private loginOfAccount(accountId: number): LoginState {
    for (const login of this.logins.values()) if (login.accountIds.has(accountId)) return login;
    throw new Error(`Unknown account ${accountId}`);
  }

  private matchRule(endpoint: string, login: LoginState, accountId?: number): FaultRule | undefined {
    const nthAccount = accountId === undefined ? 0 : this.bump(`${endpoint}:a${accountId}`);
    const nthLogin = this.bump(`${endpoint}:l${login.name}`);
    return this.plan.find((rule) => {
      if ((rule.endpoint ?? 'order/placeorder') !== endpoint) return false;
      if (rule.accountId !== undefined) return rule.accountId === accountId && (rule.nth === undefined || rule.nth === nthAccount);
      if (rule.login !== undefined) return rule.login === login.name && (rule.nth === undefined || rule.nth === nthLogin);
      return false;
    });
  }

  private bump(key: string): number {
    const value = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, value);
    return value;
  }

  private ticketBody(ticket: string, pTime: number) {
    return { 'p-ticket': ticket, 'p-time': pTime, 'p-message': 'Rate limit exceeded: simulated penalty' };
  }

  private lose(res: ServerResponse, mode: LostMode = 'reset'): void {
    if (mode === 'http500') return this.empty(res, 500);
    if (mode === 'reset') res.socket?.destroy();
    // 'timeout': never answer; the connection stays open until the client gives up or the server closes.
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  private empty(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'content-length': 0 });
    res.end();
  }

  // ---- WebSocket -------------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const conn: FeedConn = { ws, synced: false, syncs: 0, stalled: false, lastRecv: this.clock.now() };
    this.conns.add(conn);
    ws.on('close', () => this.conns.delete(conn));
    ws.on('error', () => this.conns.delete(conn));
    ws.on('message', (data) => this.onFrame(conn, data.toString()));
    ws.send('o');
  }

  private onFrame(conn: FeedConn, text: string): void {
    conn.lastRecv = this.clock.now();
    if (text === '[]') {
      this.heartbeats++;
      if (!conn.stalled) conn.ws.send('h');
      return;
    }
    if (conn.stalled) return;
    const [endpoint, rawId, , payload] = text.split('\n');
    const id = Number(rawId);
    const reply = (s: number, d?: unknown) => conn.ws.send(`a${JSON.stringify([{ s, i: id, ...(d === undefined ? {} : { d }) }])}`);
    if (endpoint === 'authorize') {
      const session = this.tokens.get(payload ?? '');
      if (!session || session.closed || this.clock.now() >= session.expiresAt) return reply(401);
      conn.login = session.login;
      return reply(200);
    }
    if (endpoint === '__barrier') return reply(200); // simulator-only: every earlier frame has been delivered
    if (!conn.login) return reply(401);
    if (endpoint === 'user/syncrequest') {
      this.requests.push({ at: this.clock.now(), endpoint: 'user/syncrequest', login: conn.login, status: 200 });
      conn.syncs++;
      if (conn.syncs > 1) return reply(400, { errorText: 'Exactly one sync request per connection' });
      conn.synced = true;
      return reply(200, {});
    }
    reply(404);
  }

  private emitFill(fill: SimFill): void {
    const frame = `a${JSON.stringify([{ e: 'props', d: { entityType: 'fill', eventType: 'Created', entity: fillEntity(fill) } }])}`;
    let sent = false;
    for (const conn of this.conns) {
      if (conn.synced && !conn.stalled && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(frame);
        sent = true;
      }
    }
    if (!sent) this.framesDropped++;
  }

  private dropIdleConnections(): void {
    const now = this.clock.now();
    for (const conn of this.conns) if (now - conn.lastRecv > IDLE_DROP_MS) conn.ws.terminate();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** The documented Order entity: no quantity, no symbol. */
function orderEntity(o: SimOrder) {
  return {
    id: o.id,
    accountId: o.accountId,
    contractId: o.contractId,
    timestamp: new Date(o.arrivedAt).toISOString(),
    action: o.action,
    ordStatus: o.ordStatus,
    admin: false,
    ...(o.clOrdId ? { clOrdId: o.clOrdId } : {}),
  };
}

/** The documented Fill entity: no accountId. */
function fillEntity(f: SimFill) {
  const { at: _at, ...entity } = f;
  return entity;
}

/** A fixed 20-99 ms per account and per order, for reported simulated latency only. */
function simulatedDelayMs(accountId: number, nth: number): number {
  return 20 + ((accountId * 2654435761 + nth * 40503) >>> 0) % 80;
}

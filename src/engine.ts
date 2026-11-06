import type { Book } from '../sim/book.js';
import { Api, classifyPlace, type PlaceOutcome, type Raw } from './api.js';
import type { Clock } from './clock.js';
import { crashNow, type CrashPoint } from './crash.js';
import { Feed, HEARTBEAT_MS, type FeedFill } from './feed.js';
import { Sessions } from './sessions.js';
import { DEFAULT_SIZING, expectedNet, Store, type AccountRow, type IntentRow, type Sizing } from './store.js';

export type { Sizing };

export interface EngineOptions {
  databaseUrl: string;
  clock: Clock;
  apiUrl: string;
  wsUrl: string;
  book: Book;
  sizing?: (accountId: number) => Sizing;
  /** After an ambiguous send: how long an order may stay invisible before the one re-send. */
  graceMs?: number;
  /** Requests in flight per login. */
  concurrency?: number;
  /** Virtual time between batches on one login. */
  minBatchIntervalMs?: number;
  /** Renew this long before expiry; 15 minutes is the docs' sample. */
  renewMarginMs?: number;
  /** Real-time limit on one HTTP call. */
  httpTimeoutMs?: number;
  /** Feed silence that counts as a stall. */
  stallMs?: number;
  /** Penalty tickets one intent may take before it stops with an alert. */
  maxPenalties?: number;
  crash?: { at: CrashPoint; after: number };
}

export interface DriftRow {
  accountId: number;
  contractId: number;
  login: string;
  expected: number;
  actual: number;
  drift: number;
  duplicateClOrdIds: string[];
}

export interface ReconcileReport {
  rows: DriftRow[];
  /** Accounts that could not be read, for example on a stopped login. */
  unverifiedAccounts: number[];
}

export interface CloseoutResult {
  accountId: number;
  sent: boolean;
  qty: number;
  action?: 'Buy' | 'Sell';
  clOrdId?: string;
  unreachable?: boolean;
}

const LOOKUP_RETRY_MS = 5_000;
const MAX_LOOKUP_FAILURES = 5;

export class Engine {
  readonly store: Store;
  private readonly api: Api;
  private readonly sessions: Sessions;
  private readonly feed: Feed;
  private readonly clock: Clock;
  private readonly graceMs: number;
  private readonly concurrency: number;
  private readonly minBatchIntervalMs: number;
  private readonly maxPenalties: number;
  private readonly crash: EngineOptions['crash'];
  private readonly contractNames = new Map<number, string>();
  private readonly accountSpecs: Map<number, string>;
  private placedSinceStart = 0;

  constructor(private readonly opts: EngineOptions) {
    this.clock = opts.clock;
    this.graceMs = opts.graceMs ?? 30_000;
    this.concurrency = opts.concurrency ?? 4;
    this.minBatchIntervalMs = opts.minBatchIntervalMs ?? 50;
    this.maxPenalties = opts.maxPenalties ?? 5;
    this.crash = opts.crash;
    this.accountSpecs = new Map(opts.book.accounts.map((a) => [a.id, a.name]));
    this.store = new Store(opts.databaseUrl);
    this.api = new Api(opts.apiUrl, opts.httpTimeoutMs ?? 5_000);
    this.sessions = new Sessions(this.store, this.api, this.clock, opts.renewMarginMs ?? 15 * 60_000);
    this.feed = new Feed({
      wsUrl: opts.wsUrl,
      clock: this.clock,
      accountId: opts.book.master.accountId,
      getToken: () => this.sessions.ensure(opts.book.master.login),
      onFill: (fill) => this.onMasterFill(fill),
      onConnected: () => this.recoverFills(),
      stallMs: opts.stallMs ?? 10_000,
    });
  }

  async init(): Promise<void> {
    await this.store.migrate();
    await this.store.seed(this.opts.book, this.opts.sizing ?? (() => DEFAULT_SIZING));
  }

  /** Everything comes from Postgres, so a restart is the same path as a first start. */
  async start(): Promise<void> {
    await this.store.recoverInFlight(this.clock.now());
    await this.sessions.ensureAll();
    await this.feed.connect();
    await this.feed.settle();
  }

  async stop(): Promise<void> {
    this.feed.close();
    await this.store.close();
  }

  // ---- driving ---------------------------------------------------------------------------------

  async settleFeed(): Promise<void> {
    await this.feed.settle();
  }

  /** Does everything that is due now, one batch per login. Returns whether anything was due. */
  async step(): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.store.pickWork(now, this.concurrency);
    if (!rows.length) return false;
    const byLogin = new Map<string, IntentRow[]>();
    for (const row of rows) {
      const list = byLogin.get(row.login_name);
      if (list) list.push(row);
      else byLogin.set(row.login_name, [row]);
    }
    await Promise.all([...byLogin].map(([login, work]) => this.processLogin(login, work, now)));
    return true;
  }

  async runUntilIdle(): Promise<void> {
    await this.feed.settle();
    for (;;) {
      if (await this.step()) continue;
      const next = await this.store.nextDue();
      if (next === null) return;
      await this.hopTo(next);
    }
  }

  async runFor(ms: number): Promise<void> {
    await this.hopTo(this.clock.now() + ms);
    await this.runUntilIdle();
  }

  /** Moves the clock in steps short enough to keep the feed alive and tokens fresh. */
  private async hopTo(t: number): Promise<void> {
    while (this.clock.now() < t) {
      await this.clock.advanceTo(Math.min(t, this.clock.now() + HEARTBEAT_MS));
      await this.feed.tick();
      await this.sessions.renewDue();
    }
    await this.feed.settle();
  }

  // ---- master feed -----------------------------------------------------------------------------

  /** A fill has no accountId and no symbol: both come through its Order and its Contract. */
  private async onMasterFill(fill: FeedFill): Promise<void> {
    if (await this.store.hasFill(fill.id)) return;
    const master = this.opts.book.master;
    const token = await this.sessions.ensure(master.login);
    if (!token) return;
    const order = await this.api.get(`order/item?id=${fill.orderId}`, token);
    if (order.status !== 200 || order.json.accountId !== master.accountId) return;
    const symbol = await this.contractName(fill.contractId, token);
    if (!symbol) return;
    await this.ingest(fill, symbol);
    this.maybeCrash('after_intent_write');
  }

  /** Gap recovery. The docs describe no replay, so every connection re-reads the fill list. */
  private async recoverFills(): Promise<void> {
    const token = await this.sessions.ensure(this.opts.book.master.login);
    if (!token) return;
    const raw = await this.api.get('fill/list', token);
    if (raw.status !== 200) return;
    const fills = (raw.json as FeedFill[]).slice().sort((a, b) => a.id - b.id);
    for (const fill of fills) await this.onMasterFill(fill);
  }

  private async contractName(contractId: number, token: string): Promise<string | undefined> {
    const known = this.contractNames.get(contractId);
    if (known) return known;
    const raw = await this.api.get(`contract/item?id=${contractId}`, token);
    if (raw.status !== 200) return undefined;
    this.contractNames.set(contractId, raw.json.name);
    return raw.json.name as string;
  }

  /**
   * One transaction: the fill, the master position, and every follower's intent. It commits before
   * any send. Sizing works on the cumulative master position, so partial fills add up and a late
   * frame lands on the right total.
   */
  private async ingest(fill: FeedFill, symbol: string): Promise<void> {
    const now = this.clock.now();
    await this.store.tx(async (c) => {
      const inserted = await c.query(
        `insert into master_fills (fill_id, order_id, contract_id, symbol, action, qty, ingested_at)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (fill_id) do nothing returning fill_id`,
        [fill.id, fill.orderId, fill.contractId, symbol, fill.action, fill.qty, now],
      );
      if (!inserted.rowCount) return; // this fill was already planned: a repeated frame stops here

      await c.query(`insert into master_net (contract_id, symbol, net) values ($1, $2, 0) on conflict (contract_id) do nothing`, [fill.contractId, symbol]);
      const before = Number((await c.query('select net from master_net where contract_id = $1 for update', [fill.contractId])).rows[0].net);
      const after = before + (fill.action === 'Buy' ? fill.qty : -fill.qty);
      await c.query('update master_net set net = $2 where contract_id = $1', [fill.contractId, after]);

      const killed = (await c.query(`select 1 from settings where key = 'kill_switch' and value = 'on'`)).rowCount === 1;
      const believed = new Map<number, number>();
      if (killed) {
        const rows = (
          await c.query(
            `select follower_account_id as id, sum(case when action = 'Buy' then qty else -qty end)::int as net from intents
             where contract_id = $1 and state in ('PLANNED', 'SENDING', 'ACKED', 'UNKNOWN') group by 1`,
            [fill.contractId],
          )
        ).rows;
        for (const row of rows) believed.set(Number(row.id), row.net);
      }

      const accounts = (await c.query<AccountRow>('select * from accounts where enabled order by id')).rows;
      const plan = { ids: [] as number[], logins: [] as string[], clOrdIds: [] as string[], actions: [] as string[], qtys: [] as number[], reduces: [] as boolean[], states: [] as string[], details: [] as (string | null)[], dues: [] as (number | null)[] };
      for (const account of accounts) {
        const fromNet = expectedNet(before, account);
        const toNet = expectedNet(after, account);
        const delta = toNet - fromNet;
        if (delta === 0) continue;
        let qty = Math.abs(delta);
        let state = 'PLANNED';
        let detail: string | null = null;
        if (killed) {
          // Only what moves the follower's own position toward flat is allowed, and never past it.
          const held = believed.get(Number(account.id)) ?? 0;
          const allowed = held !== 0 && Math.sign(held) !== Math.sign(delta) ? Math.min(qty, Math.abs(held)) : 0;
          if (allowed === 0) {
            state = 'BLOCKED';
            detail = 'kill_switch';
          } else {
            qty = allowed;
          }
        }
        plan.ids.push(Number(account.id));
        plan.logins.push(account.login_name);
        plan.clOrdIds.push(`tc-${fill.id}-${account.id}`);
        plan.actions.push(delta > 0 ? 'Buy' : 'Sell');
        plan.qtys.push(qty);
        plan.reduces.push(Math.abs(toNet) < Math.abs(fromNet));
        plan.states.push(state);
        plan.details.push(detail);
        plan.dues.push(state === 'PLANNED' ? now : null);
      }
      await c.query(
        `insert into intents (master_fill_id, follower_account_id, login_name, cl_ord_id, action, symbol, contract_id, qty, reduces, state, detail, due_at, created_at)
         select $1, a, l, o, x, $2, $3, q, r, s, d, u, $4
         from unnest($5::bigint[], $6::text[], $7::text[], $8::text[], $9::int[], $10::boolean[], $11::text[], $12::text[], $13::bigint[]) as t(a, l, o, x, q, r, s, d, u)
         on conflict do nothing`,
        [fill.id, symbol, fill.contractId, now, plan.ids, plan.logins, plan.clOrdIds, plan.actions, plan.qtys, plan.reduces, plan.states, plan.details, plan.dues],
      );
    });
  }

  // ---- sender and resolver ---------------------------------------------------------------------

  private async processLogin(login: string, rows: IntentRow[], now: number): Promise<void> {
    const token = await this.sessions.ensure(login);
    if (!token) return;

    const resend = (await Promise.all(rows.filter((r) => r.state === 'UNKNOWN').map((r) => this.resolve(r, token, now)))).filter((r): r is IntentRow => r !== undefined);
    if ((await this.store.login(login)).state !== 'ACTIVE') return;

    // A ticket holder goes alone: anything else on this login would only add to its penalty.
    const planned = rows.filter((r) => r.state === 'PLANNED');
    const ticket = planned.find((r) => r.p_ticket);
    const sending = ticket ? [ticket] : [...resend, ...planned];
    if (sending.length) {
      await this.store.markSending(sending.map((r) => r.id));
      const results = await Promise.all(sending.map(async (row) => ({ row, outcome: await this.send(row, token) })));
      await this.applyOutcomes(login, results, now);
      this.maybeCrash('mid_fanout', results.length);
    }
    await this.store.setNotBefore(login, now + this.minBatchIntervalMs);
  }

  private async send(row: IntentRow, token: string): Promise<PlaceOutcome> {
    const raw = await this.api.request('POST', 'order/placeorder', token, {
      accountSpec: this.accountSpecs.get(row.follower_account_id),
      accountId: row.follower_account_id,
      action: row.action,
      symbol: row.symbol,
      orderQty: row.qty,
      orderType: 'Market',
      isAutomated: true,
      clOrdId: row.cl_ord_id,
      ...(row.p_ticket ? { 'p-ticket': row.p_ticket } : {}),
    });
    this.maybeCrash('after_send_before_ack');
    const outcome = classifyPlace(raw);
    this.maybeCrash('after_ack_before_commit');
    return outcome;
  }

  private async applyOutcomes(login: string, results: Array<{ row: IntentRow; outcome: PlaceOutcome }>, now: number): Promise<void> {
    let stop: { reason: string; detail: string } | undefined;
    let suspect = false;
    let pauseUntil = 0;
    await this.store.tx(async (c) => {
      for (const { row, outcome } of results) {
        switch (outcome.kind) {
          case 'placed':
            await c.query(`update intents set state = 'ACKED', order_id = $2, acked_at = $3, due_at = null, p_ticket = null where id = $1`, [row.id, outcome.orderId, now]);
            break;
          case 'rejected':
            await c.query(`update intents set state = 'REJECTED', due_at = null, detail = $2 where id = $1`, [row.id, outcome.reason]);
            await c.query('insert into alerts (at, login_name, kind, detail) values ($1, $2, $3, $4)', [now, login, 'order_rejected', `${row.cl_ord_id}: ${outcome.reason}`]);
            break;
          case 'penalty':
            if (row.penalties + 1 >= this.maxPenalties) {
              await c.query(`update intents set state = 'BLOCKED', due_at = null, detail = 'penalty_limit' where id = $1`, [row.id]);
              await c.query('insert into alerts (at, login_name, kind, detail) values ($1, $2, $3, $4)', [now, login, 'penalty_limit', `${row.cl_ord_id}: ${row.penalties + 1} penalty tickets`]);
            } else {
              // Not placed: back to PLANNED, and this attempt does not count as a send.
              await c.query(`update intents set state = 'PLANNED', p_ticket = $2, penalties = penalties + 1, sends = sends - 1, due_at = $3 where id = $1`, [row.id, outcome.ticket, now + outcome.waitMs]);
            }
            pauseUntil = Math.max(pauseUntil, now + outcome.waitMs);
            break;
          case 'captcha':
            stop = { reason: 'p_captcha', detail: `${row.cl_ord_id}: p-captcha, this operation cannot be retried from a third-party application; try again in an hour` };
            break;
          case 'lockout':
            stop = { reason: 'http_429', detail: `${row.cl_ord_id}: HTTP 429, wait one hour; every call before that resets the clock` };
            break;
          case 'ambiguous':
            // The order may exist. It is never re-sent from here: the resolver looks first.
            await c.query(`update intents set state = 'UNKNOWN', unknown_since = $2, due_at = $2, detail = $3 where id = $1`, [row.id, now, outcome.why]);
            suspect = suspect || outcome.suspect;
            break;
        }
      }
    });
    if (stop) await this.store.blockLogin(now, login, stop.reason, stop.detail);
    else if (suspect) await this.store.setSuspect(login, true);
    if (pauseUntil) await this.store.setNotBefore(login, pauseUntil);
  }

  /** Lists the account's orders and matches clOrdId. Returns the row when it must be re-sent. */
  private async resolve(row: IntentRow, token: string, now: number): Promise<IntentRow | undefined> {
    const raw = await this.api.get(`order/deps?masterid=${row.follower_account_id}`, token);
    if (raw.status !== 200 || raw.json?.['p-ticket']) {
      await this.lookupFailed(row, raw, now);
      return undefined;
    }
    const found = (raw.json as Array<{ id: number; clOrdId?: string }>).find((o) => o.clOrdId === row.cl_ord_id);
    if (found) {
      await this.store.pool.query(`update intents set state = 'ACKED', adopted = true, order_id = $2, acked_at = $3, due_at = null where id = $1`, [row.id, found.id, now]);
      return undefined;
    }
    const graceEnds = (row.unknown_since ?? now) + this.graceMs;
    if (now < graceEnds) {
      await this.store.pool.query('update intents set due_at = $2 where id = $1', [row.id, graceEnds]);
      return undefined;
    }
    if (row.sends >= 2) {
      // Already re-sent once and still nothing to show for it: a person decides, never a third send.
      await this.park(row, now, 'still absent after the one re-send');
      return undefined;
    }
    return row;
  }

  private async lookupFailed(row: IntentRow, raw: Raw, now: number): Promise<void> {
    if (raw.status === 429) return this.store.blockLogin(now, row.login_name, 'http_429', 'order/deps answered 429');
    if (raw.status === 423 || raw.json?.['p-captcha']) return this.store.blockLogin(now, row.login_name, 'p_captcha', 'order/deps answered p-captcha');
    if (raw.json?.['p-ticket']) {
      const until = now + Number(raw.json['p-time'] ?? 0) * 1000;
      await this.store.pool.query('update intents set due_at = $2 where id = $1', [row.id, until]);
      return this.store.setNotBefore(row.login_name, until);
    }
    if (raw.status === 408 || raw.status === 401 || raw.status >= 500) await this.store.setSuspect(row.login_name, true);
    if (row.lookup_failures + 1 >= MAX_LOOKUP_FAILURES) return this.park(row, now, `${MAX_LOOKUP_FAILURES} failed lookups`);
    await this.store.pool.query('update intents set lookup_failures = lookup_failures + 1, due_at = $2 where id = $1', [row.id, now + LOOKUP_RETRY_MS]);
  }

  private async park(row: IntentRow, now: number, why: string): Promise<void> {
    await this.store.pool.query(`update intents set due_at = null, detail = $2 where id = $1`, [row.id, why]);
    await this.store.alert(now, row.login_name, 'unresolved_intent', `${row.cl_ord_id}: ${why}`);
  }

  private maybeCrash(point: CrashPoint, placed = 0): void {
    if (this.crash?.at !== point) return;
    this.placedSinceStart += placed;
    if (point !== 'mid_fanout' || this.placedSinceStart >= this.crash.after) crashNow(point);
  }

  // ---- reconciler ------------------------------------------------------------------------------

  /** Expected net per follower against what the server holds. It reports; it only acts when told to. */
  async reconcile(opts: { autoClose?: boolean } = {}): Promise<ReconcileReport> {
    const now = this.clock.now();
    const nets = await this.store.masterNetRows();
    const accounts = (await this.store.accounts()).filter((a) => a.enabled);
    const byLogin = groupBy(accounts, (a) => a.login_name);
    const rows: DriftRow[] = [];
    const unverified: number[] = [];

    await Promise.all(
      [...byLogin].map(async ([login, list]) => {
        const held = await this.readPositions(login);
        if (!held) {
          unverified.push(...list.map((a) => Number(a.id)));
          return;
        }
        const token = (await this.store.login(login)).access_token ?? '';
        for (const account of list) {
          const id = Number(account.id);
          const contracts = new Set<number>([...nets.map((n) => Number(n.contract_id)), ...[...held.keys()].filter((k) => k.startsWith(`${id}:`)).map((k) => Number(k.split(':')[1]))]);
          for (const contractId of contracts) {
            const net = Number(nets.find((n) => Number(n.contract_id) === contractId)?.net ?? 0);
            const expected = expectedNet(net, account);
            const actual = held.get(`${id}:${contractId}`) ?? 0;
            if (actual === expected) continue;
            rows.push({ accountId: id, contractId, login, expected, actual, drift: actual - expected, duplicateClOrdIds: await this.duplicatesOn(id, token) });
          }
        }
      }),
    );
    rows.sort((a, b) => a.accountId - b.accountId);
    unverified.sort((a, b) => a - b);
    await this.saveDrift(rows, unverified, accounts, now);

    if (opts.autoClose && rows.length) {
      await this.closeoutMany(rows.map((r) => r.accountId), { to: 'expected' });
    }
    return { rows, unverifiedAccounts: unverified };
  }

  /** `position/list` for a login as `account:contract` to net, or undefined when it cannot be read. */
  private async readPositions(login: string): Promise<Map<string, number> | undefined> {
    const token = await this.sessions.ensure(login);
    if (!token) return undefined;
    const raw = await this.api.get('position/list', token);
    if (raw.status === 429) {
      await this.store.blockLogin(this.clock.now(), login, 'http_429', 'position/list answered 429');
      return undefined;
    }
    if (raw.status !== 200 || raw.json?.['p-ticket']) return undefined;
    const held = new Map<string, number>();
    for (const p of raw.json as Array<{ accountId: number; contractId: number; netPos: number }>) held.set(`${p.accountId}:${p.contractId}`, p.netPos);
    return held;
  }

  /** The same clOrdId on two orders: the server accepted a re-send of something it had already. */
  private async duplicatesOn(accountId: number, token: string): Promise<string[]> {
    const raw = await this.api.get(`order/deps?masterid=${accountId}`, token);
    if (raw.status !== 200) return [];
    const seen = new Map<string, number>();
    for (const order of raw.json as Array<{ clOrdId?: string }>) if (order.clOrdId) seen.set(order.clOrdId, (seen.get(order.clOrdId) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id).sort();
  }

  private async saveDrift(rows: DriftRow[], unverified: number[], accounts: AccountRow[], now: number): Promise<void> {
    const loginOf = new Map(accounts.map((a) => [Number(a.id), a.login_name]));
    await this.store.tx(async (c) => {
      await c.query('delete from drift');
      for (const r of rows) {
        await c.query(
          `insert into drift (account_id, contract_id, login_name, expected, actual, drift, duplicate_cl_ord_ids, checked_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [r.accountId, r.contractId, r.login, r.expected, r.actual, r.drift, r.duplicateClOrdIds, now],
        );
      }
      for (const id of unverified) {
        await c.query(`insert into drift (account_id, contract_id, login_name, unverified, checked_at) values ($1, 0, $2, true, $3)`, [id, loginOf.get(id), now]);
      }
    });
  }

  // ---- closeout and kill switch ----------------------------------------------------------------

  /**
   * Flattens exactly what the server says the account holds, so a duplicate position stays
   * closable. `to: 'expected'` removes only the excess. The order is tagged by clOrdId, not
   * customTag50 (a value there is denied unless NinjaTrader configured an allow-list).
   */
  async closeout(accountId: number, opts: { to?: 'flat' | 'expected' } = {}): Promise<CloseoutResult> {
    const [result] = await this.closeoutMany([accountId], opts);
    return result!;
  }

  async closeoutMany(accountIds: number[], opts: { to?: 'flat' | 'expected' } = {}): Promise<CloseoutResult[]> {
    await this.runUntilIdle(); // anything still pending settles first; its effect has to be in the position we read
    const now = this.clock.now();
    const wanted = new Set(accountIds);
    const accounts = (await this.store.accounts()).filter((a) => wanted.has(Number(a.id)));
    const nets = await this.store.masterNetRows();
    const results: CloseoutResult[] = [];

    for (const [login, list] of groupBy(accounts, (a) => a.login_name)) {
      const held = await this.readPositions(login);
      const token = held ? await this.sessions.ensure(login) : null;
      if (!held || !token) {
        results.push(...list.map((a) => ({ accountId: Number(a.id), sent: false, qty: 0, unreachable: true })));
        continue;
      }
      for (const account of list) {
        const id = Number(account.id);
        const result: CloseoutResult = { accountId: id, sent: false, qty: 0 };
        for (const [key, actual] of held) {
          const [holder, contract] = key.split(':').map(Number) as [number, number];
          if (holder !== id) continue;
          const net = Number(nets.find((n) => Number(n.contract_id) === contract)?.net ?? 0);
          const target = opts.to === 'expected' ? expectedNet(net, account) : 0;
          const excess = actual - target;
          if (excess === 0) continue;
          const symbol = await this.contractName(contract, token);
          if (!symbol) continue;
          const action = excess > 0 ? 'Sell' : 'Buy';
          const inserted = await this.store.pool.query<{ cl_ord_id: string }>(
            `insert into intents (kind, follower_account_id, login_name, cl_ord_id, action, symbol, contract_id, qty, reduces, state, due_at, created_at)
             select 'CLOSE', $1::bigint, $2, 'close-' || $1::bigint::text || '-' || $3::bigint::text || '-' || (1 + (select count(*) from intents where kind = 'CLOSE' and follower_account_id = $1::bigint and contract_id = $3::bigint))::text,
                    $4, $5, $3::bigint, $6::int, true, 'PLANNED', $7::bigint, $7::bigint
             returning cl_ord_id`,
            [id, login, contract, action, symbol, Math.abs(excess), now],
          );
          Object.assign(result, { sent: true, qty: result.qty + Math.abs(excess), action, clOrdId: inserted.rows[0]!.cl_ord_id });
        }
        results.push(result);
      }
    }
    await this.runUntilIdle();
    return results.sort((a, b) => a.accountId - b.accountId);
  }

  /** On: entries stop, including those waiting to be sent. Closes and reductions still go out. */
  async setKillSwitch(on: boolean): Promise<void> {
    const now = this.clock.now();
    await this.store.tx(async (c) => {
      await c.query(`insert into settings (key, value) values ('kill_switch', $1) on conflict (key) do update set value = excluded.value`, [on ? 'on' : 'off']);
      if (on) await c.query(`update intents set state = 'BLOCKED', detail = 'kill_switch', due_at = null where state = 'PLANNED' and kind = 'COPY' and not reduces`);
      await c.query('insert into alerts (at, login_name, kind, detail) values ($1, null, $2, $3)', [now, on ? 'kill_switch_on' : 'kill_switch_off', on ? 'new entries are blocked' : 'new entries flow again']);
    });
  }

  // ---- read side -------------------------------------------------------------------------------

  intents(filter: { accountId?: number }): Promise<IntentRow[]> {
    return this.store.intents(filter);
  }

  intentCounts() {
    return this.store.intentCounts();
  }

  alerts() {
    return this.store.alerts();
  }

  loginHealth() {
    return this.store.logins();
  }

  async masterNet(): Promise<number> {
    const rows = await this.store.masterNetRows();
    return rows.reduce((sum, r) => sum + Number(r.net), 0);
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

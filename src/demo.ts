import { makeBook, type Book } from '../sim/book.js';
import type { FaultRule } from '../sim/faults.js';
import { Simulator } from '../sim/simulator.js';
import { NaiveCopier } from '../naive/copier.js';
import { VirtualClock } from './clock.js';
import { Engine } from './engine.js';
import { createDatabase, dropDatabase, startPostgres } from './pg-scratch.js';

/**
 * `npm run demo`: one seeded chaos scenario, run once against the naive copier and once against the
 * engine, each on its own simulator with the same fault plan. Every number comes from the
 * simulator's ground truth, never from what a copier believes. Nothing in the report varies between
 * runs with the same seed.
 */
export interface DemoOptions {
  seed: number;
  logins: number;
  accounts: number;
  /** Runs the engine against this database instead of starting one. */
  databaseUrl?: string;
}

export interface CopierNumbers {
  name: string;
  ordersPlaced: number;
  ordersPerAccountMin: number;
  ordersPerAccountMax: number;
  ordersPerAccountAvg: number;
  duplicatedOrders: number;
  /** Second placements in the same virtual second as the first: an immediate retry. */
  duplicatesImmediate: number;
  /** Second placements later than that: a replay, or a re-send after the grace window. */
  duplicatesLater: number;
  wrongPositionAccounts: number;
  wrongPositionContracts: number;
  missedCopies: number;
  residualContracts: number;
  residualAccounts: number;
  requestsSpent: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
}

export interface DemoResult {
  options: { seed: number; logins: number; accounts: number };
  faults: Record<string, number>;
  naive: CopierNumbers;
  engine: CopierNumbers & { stoppedLogins: string[]; residualOnStoppedLogins: number; wrongBreakdown: { stoppedLogins: number; rejected: number; other: number }; missedBreakdown: { stoppedLogins: number; rejected: number; other: number }; blockedIntents: number; rejectedIntents: number; unknownIntents: number; flaggedDuplicates: number; alerts: Record<string, number> };
  report: string;
}

const PACING_MS = 50;
const GRACE_MS = 30_000;
const STALL_TAIL_MS = 15_000;
const TRADE_GAP_MS = 60_000;

/** The master's day: entries, partial fills, a repeated frame, out-of-order frames, a feed stall. */
const SCENARIO: Array<{ action: 'Buy' | 'Sell'; fills: number[]; delivery?: number[]; stallBefore?: boolean }> = [
  { action: 'Buy', fills: [2], delivery: [0, 0] },
  { action: 'Buy', fills: [1, 2], delivery: [1, 0, 1] },
  { action: 'Sell', fills: [1], stallBefore: true },
  { action: 'Sell', fills: [2] },
];
export const MASTER_NET_AT_END = 2;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sizing: every tenth account trades double, every 25th is capped at one contract, every 40th is off. */
export function demoSizing(accountId: number) {
  return { multiplier: accountId % 10 === 0 ? 2 : 1, maxContracts: accountId % 25 === 0 ? 1 : 100, enabled: accountId % 40 !== 0 };
}

/** What a follower should hold at the end of the scenario. */
function demoExpected(accountId: number): number {
  const s = demoSizing(accountId);
  return s.enabled ? Math.min(s.maxContracts, Math.trunc(MASTER_NET_AT_END * s.multiplier)) : 0;
}

/** Faults by identity, so the same plan does the same thing however requests interleave. */
export function buildPlan(seed: number, book: Book): { plan: FaultRule[]; counts: Record<string, number> } {
  const random = mulberry32(seed);
  const scale = book.accounts.length / 1000;
  const followers = book.accounts.filter((a) => demoSizing(a.id).enabled);
  const order = followers.map((a) => a.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const loginOf = new Map(book.accounts.map((a) => [a.id, a.login]));
  // Each of these logins takes one login-wide fault, so account faults stay off them.
  const logins = book.logins.map((l) => l.name);
  const special = { penalty: logins[1 % logins.length]!, captcha: logins[2 % logins.length]!, lockout: logins[3 % logins.length]!, evict: logins[4 % logins.length]!, expiry: logins[5 % logins.length]! };
  const specials = new Set(Object.values(special));
  const free = order.filter((id) => !specials.has(loginOf.get(id)!));

  const plan: FaultRule[] = [];
  const counts: Record<string, number> = {};
  const take = (name: string, n: number, make: (id: number) => FaultRule) => {
    const wanted = Math.max(1, Math.round(n * scale));
    counts[name] = wanted;
    for (const id of free.splice(0, wanted)) plan.push(make(id));
  };
  take('response lost after accept (connection reset)', 30, (accountId) => ({ accountId, nth: 1, fault: { kind: 'lostAfterAccept' } }));
  take('response lost after accept (HTTP 500)', 15, (accountId) => ({ accountId, nth: 2, fault: { kind: 'lostAfterAccept', mode: 'http500' } }));
  take('response lost before accept', 30, (accountId) => ({ accountId, nth: 1, fault: { kind: 'lostBeforeAccept' } }));
  take('order visible 10 s late, inside the grace window', 10, (accountId) => ({ accountId, nth: 1, fault: { kind: 'lostAfterAccept', visibleAfterMs: 10_000 } }));
  take('order visible 45 s late, after the grace window', 3, (accountId) => ({ accountId, nth: 1, fault: { kind: 'lostAfterAccept', visibleAfterMs: GRACE_MS + 15_000 } }));
  take('follower rejection (locked account)', 10, (accountId) => ({ accountId, fault: { kind: 'reject', reason: 'TradingLocked' } }));
  take('partial follower fill', 5, (accountId) => ({ accountId, nth: 1, fault: { kind: 'partialFill', filled: 1 } }));
  const onLogin = (name: string, nth: number, fault: FaultRule['fault'], label: string) => {
    plan.push({ login: name, nth, fault });
    counts[label] = 1;
  };
  onLogin(special.penalty, 2, { kind: 'penalty', pTime: 15 }, 'penalty in a 200 body (logins)');
  onLogin(special.captcha, 3, { kind: 'captcha' }, 'p-captcha (logins)');
  onLogin(special.lockout, 4, { kind: 'lockout429' }, 'HTTP 429 lockout (logins)');
  onLogin(special.evict, 5, { kind: 'evict' }, 'session eviction (logins)');
  onLogin(special.expiry, 6, { kind: 'expireToken' }, 'token expiry during fan-out (logins)');
  return { plan, counts };
}

async function playScenario(sim: Simulator, clock: VirtualClock, copier: { runUntilIdle(): Promise<void>; runFor(ms: number): Promise<void> }): Promise<void> {
  for (const trade of SCENARIO) {
    if (trade.stallBefore) sim.stallFeed();
    sim.masterTrade(trade);
    await (trade.stallBefore ? copier.runFor(STALL_TAIL_MS) : copier.runUntilIdle());
    await copier.runFor(TRADE_GAP_MS - (clock.now() % TRADE_GAP_MS));
  }
}

/** Reads the outcome from the simulator, the only side that knows what really happened. */
function measure(name: string, sim: Simulator, book: Book, closedBefore: Map<number, number>, closedAfter: Map<number, number>, prefix: RegExp, fillTimes: Map<number, number>): CopierNumbers {
  const copies = sim.orders.filter((o) => o.clOrdId && prefix.test(o.clOrdId));
  const firstPlaced = new Map<string, number>();
  let duplicatesImmediate = 0;
  let duplicatesLater = 0;
  for (const o of copies) {
    const first = firstPlaced.get(o.clOrdId!);
    if (first === undefined) firstPlaced.set(o.clOrdId!, o.arrivedAt);
    else if (o.arrivedAt - first < 1_000) duplicatesImmediate++;
    else duplicatesLater++;
  }
  const perAccount = book.accounts.map((a) => copies.filter((o) => o.accountId === a.id).length);
  let wrongAccounts = 0;
  let wrongContracts = 0;
  let missed = 0;
  for (const a of book.accounts) {
    const d = Math.abs((closedBefore.get(a.id) ?? 0) - demoExpected(a.id));
    if (d) {
      wrongAccounts++;
      wrongContracts += d;
    }
    if (demoSizing(a.id).enabled && !copies.some((o) => o.accountId === a.id)) missed++;
  }
  const latencies = copies
    .map((o) => {
      const fill = Number(/(\d+)-\d+$/.exec(o.clOrdId!)?.[1]);
      const at = fillTimes.get(fill);
      return at === undefined ? undefined : o.acceptedAt - at;
    })
    .filter((v): v is number => v !== undefined)
    .sort((x, y) => x - y);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
  return {
    name,
    ordersPlaced: copies.length,
    ordersPerAccountMin: Math.min(...perAccount),
    ordersPerAccountMax: Math.max(...perAccount),
    ordersPerAccountAvg: copies.length / book.accounts.length,
    duplicatedOrders: duplicatesImmediate + duplicatesLater,
    duplicatesImmediate,
    duplicatesLater,
    wrongPositionAccounts: wrongAccounts,
    wrongPositionContracts: wrongContracts,
    missedCopies: missed,
    residualContracts: [...closedAfter.values()].reduce((sum, v) => sum + Math.abs(v), 0),
    residualAccounts: [...closedAfter.values()].filter((v) => v !== 0).length,
    requestsSpent: sim.requests.length,
    latencyP50Ms: pct(50),
    latencyP99Ms: pct(99),
  };
}

export async function runNaive(options: { seed: number; logins: number; accounts: number }): Promise<CopierNumbers> {
  const book = makeBook(options);
  const clock = new VirtualClock();
  const sim = new Simulator({ clock, book, plan: buildPlan(options.seed, book).plan });
  await sim.listen();
  const copier = new NaiveCopier({ clock, apiUrl: `${sim.url}/v1`, wsUrl: sim.wsUrl, book, sizing: demoSizing, minBatchIntervalMs: PACING_MS });
  try {
    await copier.start();
    await playScenario(sim, clock, copier);
    const before = new Map(book.accounts.map((a) => [a.id, sim.positionOf(a.id)]));
    const fillTimes = new Map(sim.fills.filter((f) => isMasterFill(sim, f.orderId)).map((f) => [f.id, f.at]));
    await copier.closeAll();
    await copier.runFor(TRADE_GAP_MS);
    const after = new Map(book.accounts.map((a) => [a.id, sim.positionOf(a.id)]));
    return measure('Naive copier', sim, book, before, after, /^n-\d+-/, fillTimes);
  } finally {
    copier.stop();
    await sim.close();
  }
}

function isMasterFill(sim: Simulator, orderId: number): boolean {
  return sim.orders.some((o) => o.id === orderId && o.accountId === 1);
}

export async function runEngine(options: { seed: number; logins: number; accounts: number; databaseUrl: string }): Promise<DemoResult['engine']> {
  const book = makeBook(options);
  const clock = new VirtualClock();
  const sim = new Simulator({ clock, book, plan: buildPlan(options.seed, book).plan });
  await sim.listen();
  const engine = new Engine({ databaseUrl: options.databaseUrl, clock, apiUrl: `${sim.url}/v1`, wsUrl: sim.wsUrl, book, sizing: demoSizing, concurrency: 1, minBatchIntervalMs: PACING_MS, graceMs: GRACE_MS });
  try {
    await engine.init();
    await engine.start();
    await playScenario(sim, clock, engine);
    await engine.runFor(TRADE_GAP_MS);
    const before = new Map(book.accounts.map((a) => [a.id, sim.positionOf(a.id)]));
    const fillTimes = new Map(sim.fills.filter((f) => isMasterFill(sim, f.orderId)).map((f) => [f.id, f.at]));
    const report = await engine.reconcile();
    const flaggedDuplicates = report.rows.reduce((sum, r) => sum + r.duplicateClOrdIds.length, 0);
    const health = await engine.loginHealth();
    const stopped = health.filter((l) => l.state === 'BLOCKED').map((l) => l.name);
    const counts = await engine.intentCounts();
    await engine.closeoutMany(book.accounts.map((a) => a.id));
    await engine.runFor(TRADE_GAP_MS);
    const after = new Map(book.accounts.map((a) => [a.id, sim.positionOf(a.id)]));
    const numbers = measure('Engine', sim, book, before, after, /^tc-\d+-/, fillTimes);
    const residualOnStoppedLogins = book.accounts.filter((a) => stopped.includes(a.login)).reduce((sum, a) => sum + Math.abs(after.get(a.id) ?? 0), 0);
    const rejected = new Set((await engine.intents({})).filter((i) => i.state === 'REJECTED').map((i) => Number(i.follower_account_id)));
    const cause = (a: { id: number; login: string }) => (stopped.includes(a.login) ? 'stoppedLogins' : rejected.has(a.id) ? 'rejected' : 'other');
    const wrongBreakdown = { stoppedLogins: 0, rejected: 0, other: 0 };
    const missedBreakdown = { stoppedLogins: 0, rejected: 0, other: 0 };
    for (const a of book.accounts) {
      if ((before.get(a.id) ?? 0) !== demoExpected(a.id)) wrongBreakdown[cause(a)]++;
      if (demoSizing(a.id).enabled && !sim.ordersOf(a.id).some((o) => o.clOrdId?.startsWith('tc-'))) missedBreakdown[cause(a)]++;
    }
    const alerts: Record<string, number> = {};
    for (const alert of await engine.alerts()) alerts[alert.kind] = (alerts[alert.kind] ?? 0) + 1;
    return {
      ...numbers,
      stoppedLogins: stopped,
      residualOnStoppedLogins,
      wrongBreakdown,
      missedBreakdown,
      blockedIntents: counts.BLOCKED ?? 0,
      rejectedIntents: counts.REJECTED ?? 0,
      unknownIntents: counts.UNKNOWN ?? 0,
      flaggedDuplicates,
      alerts,
    };
  } finally {
    await engine.stop();
    await sim.close();
  }
}

export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const { seed, logins, accounts } = options;
  const book = makeBook({ logins, accounts });
  const faults = buildPlan(seed, book).counts;
  const naive = await runNaive({ seed, logins, accounts });

  let databaseUrl = options.databaseUrl;
  let cleanup = async () => {};
  if (!databaseUrl) {
    const server = await startPostgres('trade-copier-demo-');
    const name = `trade_copier_demo_${process.pid}_${Date.now()}`;
    databaseUrl = await createDatabase(server.baseUrl, name);
    cleanup = async () => {
      await dropDatabase(server.baseUrl, name);
      await server.stop();
    };
  }
  try {
    const engine = await runEngine({ seed, logins, accounts, databaseUrl });
    const result = { options: { seed, logins, accounts }, faults, naive, engine, report: '' };
    result.report = renderReport(result);
    return result;
  } finally {
    await cleanup();
  }
}

export function renderReport(r: Omit<DemoResult, 'report'>): string {
  const row = (label: string, pick: (c: CopierNumbers) => string | number) => `| ${label} | ${pick(r.naive)} | ${pick(r.engine)} |`;
  const lines = [
    '# COPY_REPORT',
    '',
    `Seed ${r.options.seed}, ${r.options.accounts} simulated accounts across ${r.options.logins} logins plus one master. The same scenario and fault plan ran against both copiers, each on its own simulator. Every number below is read from the simulator's records and generated by \`npm run demo\`. Never connected to Tradovate or NinjaTrader.`,
    '',
    '| Measured | Naive copier | Engine |',
    '| --- | --- | --- |',
    row('Copy orders placed', (c) => c.ordersPlaced),
    row('Orders per account, min / avg / max', (c) => `${c.ordersPerAccountMin} / ${c.ordersPerAccountAvg.toFixed(2)} / ${c.ordersPerAccountMax}`),
    row('Duplicated orders (same clOrdId placed twice)', (c) => c.duplicatedOrders),
    row('... retried at once', (c) => c.duplicatesImmediate),
    row('... placed later (a replay, or a re-send after the grace window)', (c) => c.duplicatesLater),
    row('Accounts with a wrong position at end of scenario', (c) => c.wrongPositionAccounts),
    row('Contracts of wrong position', (c) => c.wrongPositionContracts),
    row('Accounts with a missed copy (no order at all)', (c) => c.missedCopies),
    row('Accounts left holding a position after closeout', (c) => c.residualAccounts),
    row('Residual contracts after closeout', (c) => c.residualContracts),
    row('Requests spent', (c) => c.requestsSpent),
    row('Simulated copy latency, p50 (ms)', (c) => c.latencyP50Ms),
    row('Simulated copy latency, p99 (ms)', (c) => c.latencyP99Ms),
    '',
    'Latency is simulated: virtual time from master fill to order acceptance, made of pacing, penalties, grace windows, feed stalls and a fixed 20-99 ms per order. No network was measured.',
    '',
    '## What the engine reported about itself',
    '',
    `- Logins stopped and alerted, nothing sent on them afterwards: ${r.engine.stoppedLogins.length ? r.engine.stoppedLogins.join(', ') : 'none'}.`,
    `- Intents BLOCKED ${r.engine.blockedIntents}, REJECTED ${r.engine.rejectedIntents}, still UNKNOWN ${r.engine.unknownIntents}, at the end of the scenario.`,
    `- Wrong positions by cause: ${r.engine.wrongBreakdown.stoppedLogins} on logins it stopped, ${r.engine.wrongBreakdown.rejected} on accounts the server rejected, ${r.engine.wrongBreakdown.other} others (partial follower fills and the duplicates below).`,
    `- Missed copies by cause: ${r.engine.missedBreakdown.stoppedLogins} on logins it stopped, ${r.engine.missedBreakdown.rejected} on accounts the server rejected, ${r.engine.missedBreakdown.other} others.`,
    `- Duplicated clOrdIds flagged by the reconciler: ${r.engine.flaggedDuplicates}. These are the orders visible after the grace window, the limit the README states: the engine cannot see them in time, and a re-send follows.`,
    `- Alerts: ${Object.entries(r.engine.alerts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    `- Residual contracts on logins it stopped: ${r.engine.residualOnStoppedLogins} of ${r.engine.residualContracts}. It sends nothing there and says so; a person decides what happens next.`,
    '',
    '## Fault plan',
    '',
    '| Fault | Accounts or logins |',
    '| --- | --- |',
    ...Object.entries(r.faults).map(([name, count]) => `| ${name} | ${count} |`),
    '| repeated and out-of-order master frames, one master feed stall | every account |',
    '',
  ];
  return lines.join('\n');
}

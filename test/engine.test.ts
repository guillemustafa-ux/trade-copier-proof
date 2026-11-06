import { afterEach, describe, expect, test } from 'vitest';
import { CRASH_POINTS } from '../src/crash.js';
import { killedBySigkill, rig, runEngineProcess, type Rig, type RigOptions } from './support/rig.js';

const A = 1001;
const B = 1002;
const C = 1003;
const GRACE_MS = 30_000; // the engine's default

let current: Rig | undefined;
async function setup(opts: RigOptions = {}): Promise<Rig> {
  current = await rig(opts);
  return current;
}
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const placed = (r: Rig, accountId: number) => r.sim.requests.filter((q) => q.endpoint === 'order/placeorder' && q.accountId === accountId);
const lookups = (r: Rig, accountId: number) => r.sim.requests.filter((q) => q.endpoint === 'order/deps' && q.accountId === accountId);
const intent = async (r: Rig, accountId: number, clOrdPrefix = 'tc-') => {
  const rows = await r.engine.intents({ accountId });
  return rows.filter((row) => row.cl_ord_id.startsWith(clOrdPrefix));
};

describe('fan-out', () => {
  test('(a) 1,000 accounts, one master fill: one order per enabled account, flagged, keyed and sized', async () => {
    const r = await setup({
      logins: 50,
      accounts: 1000,
      sizing: (id) => ({ multiplier: id % 5 === 0 ? 2 : 1, maxContracts: id % 11 === 0 ? 1 : 100, enabled: id % 7 !== 0 }),
    });
    const [fillId] = r.sim.masterTrade({ action: 'Buy', fills: [3] });
    await r.engine.runUntilIdle();

    let enabled = 0;
    let contracts = 0;
    for (const { id } of r.book.accounts) {
      const orders = r.sim.ordersOf(id);
      if (id % 7 === 0) {
        expect(orders).toHaveLength(0);
        continue;
      }
      enabled++;
      const qty = Math.min(id % 5 === 0 ? 6 : 3, id % 11 === 0 ? 1 : 100);
      contracts += qty;
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ isAutomated: true, clOrdId: `tc-${fillId}-${id}`, qty, action: 'Buy' });
      expect(r.sim.positionOf(id)).toBe(qty);
    }
    expect(enabled).toBe(857);
    expect(contracts).toBe(2883);
    expect(r.sim.count('order/placeorder')).toBe(857);
    expect((await r.engine.intentCounts()).ACKED).toBe(857);
    for (const login of r.book.logins) {
      expect(r.sim.sessions(login.name)).toBe(1);
      expect(r.sim.maxInFlight(login.name)).toBeLessThanOrEqual(4); // the default per-login concurrency
    }
    // Pacing: 20 accounts minus the disabled ones at 4 per batch, one batch every 50 virtual ms.
    const login1 = r.sim.requests.filter((q) => q.endpoint === 'order/placeorder' && q.login === 'login-01').map((q) => q.at);
    expect(new Set(login1).size).toBeGreaterThan(1);
    const times = [...new Set(login1)].sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(50);
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });

  test('(b) duplicate and out-of-order master frames: no extra order', async () => {
    const r = await setup({ accounts: 3 });
    const fills = r.sim.masterTrade({ action: 'Buy', fills: [1, 2], delivery: [1, 0, 1, 0] });
    await r.engine.runUntilIdle();

    for (const id of [A, B, C]) {
      expect(r.sim.ordersOf(id).map((o) => o.clOrdId).sort()).toEqual([`tc-${fills[0]}-${id}`, `tc-${fills[1]}-${id}`].sort());
      expect(r.sim.positionOf(id)).toBe(3);
    }
    expect(r.sim.count('order/placeorder')).toBe(6);
    expect((await r.engine.intentCounts()).ACKED).toBe(6);
    expect(await r.engine.masterNet()).toBe(3);
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });
});

describe('ambiguous outcomes', () => {
  test.each(['reset', 'timeout', 'http500'] as const)('(c) response lost after accept (%s): adopted by lookup, one order, no re-send', async (mode) => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'lostAfterAccept', mode } }], config: { httpTimeoutMs: 300 } });
    r.sim.masterTrade({ action: 'Buy', fills: [2] });
    await r.engine.runUntilIdle();

    expect(r.sim.ordersOf(A)).toHaveLength(1);
    expect(placed(r, A)).toHaveLength(1);
    expect(r.sim.positionOf(A)).toBe(2);
    expect(r.sim.positionOf(B)).toBe(2);
    expect(lookups(r, A).length).toBeGreaterThanOrEqual(1);
    const [row] = await intent(r, A);
    expect(row).toMatchObject({ state: 'ACKED', adopted: true, sends: 1, order_id: r.sim.ordersOf(A)[0]!.id });
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });

  test('(c) response lost after accept, order visible only inside the grace window: adopted on the re-check, no re-send', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'lostAfterAccept', visibleAfterMs: GRACE_MS - 10_000 } }] });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    expect(r.sim.ordersOf(A)).toHaveLength(1);
    expect(placed(r, A)).toHaveLength(1);
    expect(r.sim.positionOf(A)).toBe(1);
    expect((await intent(r, A))[0]).toMatchObject({ state: 'ACKED', adopted: true, sends: 1 });
  });

  test('(d) response lost before accept: re-sent once after the grace window, one order', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'lostBeforeAccept' } }] });
    const t0 = r.clock.now();
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    const sends = placed(r, A);
    expect(sends).toHaveLength(2);
    expect(sends[0]!.at).toBe(t0);
    expect(sends[1]!.at).toBeGreaterThanOrEqual(t0 + GRACE_MS);
    expect(sends[1]!.at).toBeLessThan(t0 + GRACE_MS + 1_000);
    expect(sends[1]!.clOrdId).toBe(sends[0]!.clOrdId);
    expect(r.sim.ordersOf(A)).toHaveLength(1);
    expect(r.sim.positionOf(A)).toBe(1);
    expect((await intent(r, A))[0]).toMatchObject({ state: 'ACKED', adopted: false, sends: 2 });
    // Looked up before the grace window ended and again after it, before re-sending.
    expect(lookups(r, A).map((q) => q.at)).toEqual([t0 + 50, t0 + GRACE_MS]);
  });

  test('(d) a re-send that is also lost is not sent a third time: it stays UNKNOWN and alerts', async () => {
    const r = await setup({
      accounts: 2,
      plan: [
        { accountId: A, nth: 1, fault: { kind: 'lostBeforeAccept' } },
        { accountId: A, nth: 2, fault: { kind: 'lostBeforeAccept' } },
      ],
    });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    expect(placed(r, A)).toHaveLength(2);
    expect(r.sim.ordersOf(A)).toHaveLength(0);
    expect((await intent(r, A))[0]).toMatchObject({ state: 'UNKNOWN', sends: 2 });
    expect((await r.engine.alerts()).map((a) => a.kind)).toEqual(['unresolved_intent']);
    expect((await r.engine.reconcile()).rows).toMatchObject([{ accountId: A, expected: 1, actual: 0, drift: -1 }]);
  });

  test('(e) order appears after the grace window, the honest hole: the re-send happens, the reconciler flags two orders, closeout removes the excess', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'lostAfterAccept', visibleAfterMs: GRACE_MS + 30_000 } }] });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    // The duplicate is real: the first order was invisible through the whole grace window.
    expect(placed(r, A)).toHaveLength(2);
    expect((await intent(r, A))[0]).toMatchObject({ state: 'ACKED', adopted: false, sends: 2 });
    await r.engine.runFor(GRACE_MS + 30_000);
    expect(r.sim.ordersOf(A)).toHaveLength(2);
    expect(r.sim.positionOf(A)).toBe(2);

    const report = await r.engine.reconcile();
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ accountId: A, expected: 1, actual: 2, drift: 1 });
    expect(report.rows[0]!.duplicateClOrdIds).toEqual([r.sim.ordersOf(A)[0]!.clOrdId]);
    // The default is report: nothing was sent to fix it.
    expect(r.sim.count('order/placeorder')).toBe(3);

    const close = await r.engine.closeout(A, { to: 'expected' });
    expect(close).toMatchObject({ sent: true, qty: 1, action: 'Sell' });
    expect(r.sim.positionOf(A)).toBe(1);
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });

  test('(e) auto-close is explicit config: with it on, the same excess is removed by the reconcile itself', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'lostAfterAccept', visibleAfterMs: GRACE_MS + 30_000 } }] });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();
    await r.engine.runFor(GRACE_MS + 30_000);
    expect(r.sim.ordersOf(A)).toHaveLength(2);
    expect(r.sim.positionOf(A)).toBe(2);
    await r.engine.reconcile({ autoClose: true });

    expect(r.sim.positionOf(A)).toBe(1);
    expect(r.sim.positionOf(B)).toBe(1);
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });
});

describe('restart', () => {
  test.each(CRASH_POINTS)('(f) process killed at %s, restarted: one order per account', async (crashAt) => {
    const r = await setup({ logins: 2, accounts: 6, noEngine: true });
    const [fillId] = r.sim.masterTrade({ action: 'Buy', fills: [2] });

    const first = await runEngineProcess(r, { crashAt, crashAfter: 2 });
    expect(first.crashedAt).toBe(crashAt);
    expect(killedBySigkill(first)).toBe(true);
    expect(first.completed).toBe(false);
    if (crashAt === 'after_intent_write') expect(r.sim.count('order/placeorder')).toBe(0);
    if (crashAt === 'mid_fanout') expect(r.sim.count('order/placeorder')).toBeLessThan(6);

    const second = await runEngineProcess(r);
    expect(second.output).toContain('engine: idle');
    expect(second.completed).toBe(true);

    for (const { id } of r.book.accounts) {
      expect(r.sim.ordersOf(id).map((o) => o.clOrdId)).toEqual([`tc-${fillId}-${id}`]);
      expect(r.sim.positionOf(id)).toBe(2);
    }
    expect(r.sim.count('order/placeorder')).toBe(6);
    const rows = await r.engine.intents({});
    expect(rows.map((row) => row.state)).toEqual(Array(6).fill('ACKED'));
    // The restart reused the sessions stored in Postgres rather than opening new ones.
    expect(r.sim.count('auth/accesstokenrequest')).toBe(3);
  });
});

describe('penalties', () => {
  test('(g) penalty in a 200 body: not counted as placed, retried with the ticket after p-time', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'penalty', pTime: 15 } }], config: { concurrency: 1 } });
    const t0 = r.clock.now();
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.settleFeed();
    await r.engine.step();

    const [pending] = await intent(r, A);
    expect(pending).toMatchObject({ state: 'PLANNED', order_id: null, penalties: 1 });
    expect(r.sim.ordersOf(A)).toHaveLength(0);

    await r.engine.runUntilIdle();
    const sends = placed(r, A);
    expect(sends).toHaveLength(2);
    expect(sends[0]!.ticket).toBeUndefined();
    expect(sends[1]!.ticket).toMatch(/^sim-ticket-/);
    expect(sends[1]!.at).toBe(t0 + 15_000);
    expect(sends[1]!.clOrdId).toBe(sends[0]!.clOrdId);
    expect(r.sim.ordersOf(A)).toHaveLength(1);
    expect(r.sim.ordersOf(A)[0]!.viaTicket).toBe(true);
    expect((await intent(r, A))[0]).toMatchObject({ state: 'ACKED', penalties: 1, sends: 1 });
    expect(r.sim.positionOf(B)).toBe(1);
    expect(await r.engine.alerts()).toEqual([]);
  });

  test.each([
    ['(h) p-captcha', { kind: 'captcha' } as const, 'p_captcha'],
    ['(i) 429', { kind: 'lockout429' } as const, 'http_429'],
  ])('%s: only that login stops, no further requests on it, alert raised, other logins complete', async (_name, fault, alertKind) => {
    const stopped = 1006; // the second account of login-02, which holds 1005 to 1008
    const r = await setup({ logins: 3, accounts: 12, plan: [{ accountId: stopped, nth: 1, fault }], config: { concurrency: 1 } });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    const after = r.sim.count(undefined, 'login-02');
    await r.engine.runFor(2 * 3_600_000);
    await r.engine.reconcile();
    expect(r.sim.count(undefined, 'login-02')).toBe(after);

    const health = await r.engine.loginHealth();
    expect(health.find((l) => l.name === 'login-02')).toMatchObject({ state: 'BLOCKED', blocked_reason: alertKind });
    expect(health.filter((l) => l.state === 'BLOCKED')).toHaveLength(1);

    expect(r.sim.ordersOf(1005)).toHaveLength(1); // sent before the stop
    for (const id of [1006, 1007, 1008]) {
      expect(r.sim.ordersOf(id)).toHaveLength(0);
      expect((await intent(r, id))[0]!.state).toBe('BLOCKED');
    }
    for (const id of [1001, 1002, 1003, 1004, 1009, 1010, 1011, 1012]) expect(r.sim.ordersOf(id)).toHaveLength(1);
    expect(await r.engine.intentCounts()).toEqual({ ACKED: 9, BLOCKED: 3 });

    const alerts = await r.engine.alerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: alertKind, login_name: 'login-02' });
  });
});

describe('sessions', () => {
  test.each([500, 408])('(j) session eviction during fan-out (%i): no duplicate, re-auth recorded', async (evictStatus) => {
    const r = await setup({ accounts: 4, evictStatus, plan: [{ accountId: B, nth: 1, fault: { kind: 'evict' } }], config: { concurrency: 1 } });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    for (const id of [1001, 1002, 1003, 1004]) {
      expect(r.sim.ordersOf(id)).toHaveLength(1);
      expect(r.sim.positionOf(id)).toBe(1);
    }
    expect(placed(r, B)).toHaveLength(2); // the evicted send, then one after the lookup and the grace window
    expect((await r.engine.loginHealth()).find((l) => l.name === 'login-01')).toMatchObject({ state: 'ACTIVE', reauths: 1, renewals: 0 });
    expect(r.sim.count('auth/accesstokenrequest', 'login-01')).toBe(2);
    expect((await r.engine.alerts()).map((a) => a.kind)).toEqual(['session_lost']);
  });

  test('(j) an eviction answered with 429 looks like the lockout and is treated as one: the login stops, no duplicate', async () => {
    const r = await setup({ accounts: 4, evictStatus: 429, plan: [{ accountId: B, nth: 1, fault: { kind: 'evict' } }], config: { concurrency: 1 } });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    expect(r.sim.ordersOf(A)).toHaveLength(1);
    for (const id of [1002, 1003, 1004]) expect(r.sim.ordersOf(id)).toHaveLength(0);
    expect((await r.engine.loginHealth()).find((l) => l.name === 'login-01')).toMatchObject({ state: 'BLOCKED', blocked_reason: 'http_429', reauths: 0 });
    expect((await r.engine.alerts()).map((a) => a.kind)).toEqual(['http_429']);
  });

  test('(k) token close to expiry: renewed before it expires, same session, no re-auth', async () => {
    const r = await setup({ accounts: 3 });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();
    await r.engine.runFor(70 * 60_000);
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    for (const id of [A, B, C]) expect(r.sim.positionOf(id)).toBe(2);
    expect(r.sim.count('order/placeorder')).toBe(6);
    expect(r.sim.count('auth/renewaccesstoken', 'login-01')).toBe(1);
    expect(r.sim.count('auth/renewaccesstoken', 'master')).toBe(1);
    expect(r.sim.count('auth/accesstokenrequest')).toBe(2);
    expect(r.sim.sessions('login-01')).toBe(1);
    expect((await r.engine.loginHealth()).find((l) => l.name === 'login-01')).toMatchObject({ renewals: 1, reauths: 0 });
    expect(await r.engine.alerts()).toEqual([]);
  });

  test('(k) token expired during fan-out: no duplicate, re-auth recorded', async () => {
    const r = await setup({ accounts: 3, plan: [{ accountId: B, nth: 1, fault: { kind: 'expireToken' } }], config: { concurrency: 1 } });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();

    for (const id of [A, B, C]) expect(r.sim.ordersOf(id)).toHaveLength(1);
    expect(placed(r, B)).toHaveLength(2);
    expect((await r.engine.loginHealth()).find((l) => l.name === 'login-01')).toMatchObject({ reauths: 1 });
    expect((await r.engine.alerts()).map((a) => a.kind)).toEqual(['session_lost']);
  });
});

describe('sizing and feed gaps', () => {
  test('(l) partial master fills: followers sum correctly', async () => {
    const r = await setup({ accounts: 2, sizing: () => ({ multiplier: 0.5, maxContracts: 100, enabled: true }) });
    r.sim.masterTrade({ action: 'Buy', fills: [3, 3, 4] });
    await r.engine.runUntilIdle();

    // 0.5 of 3, 6, 10 is 1, 3, 5: per-fill rounding would give 1 + 1 + 2 = 4.
    for (const id of [A, B]) {
      expect(r.sim.ordersOf(id).map((o) => o.qty)).toEqual([1, 2, 2]);
      expect(r.sim.positionOf(id)).toBe(5);
    }
    expect(await r.engine.masterNet()).toBe(10);
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });

  test('(l) a partial follower fill is reported as drift, not re-sent', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 1, fault: { kind: 'partialFill', filled: 1 } }] });
    r.sim.masterTrade({ action: 'Buy', fills: [3] });
    await r.engine.runUntilIdle();

    expect(placed(r, A)).toHaveLength(1);
    expect(r.sim.positionOf(A)).toBe(1);
    expect((await r.engine.reconcile()).rows).toMatchObject([{ accountId: A, expected: 3, actual: 1, drift: -2 }]);
  });

  test('(m) master feed stall and reconnect: fills missed during the gap are copied once', async () => {
    const r = await setup({ accounts: 3 });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();
    expect(r.sim.count('user/syncrequest')).toBe(1);

    r.sim.stallFeed();
    const gap = r.sim.masterTrade({ action: 'Buy', fills: [2, 1] });
    expect(r.sim.framesDropped).toBe(2);
    await r.engine.runFor(15_000);

    for (const id of [A, B, C]) {
      expect(r.sim.ordersOf(id)).toHaveLength(3);
      expect(r.sim.ordersOf(id).filter((o) => gap.some((f) => o.clOrdId === `tc-${f}-${id}`))).toHaveLength(2);
      expect(r.sim.positionOf(id)).toBe(4);
    }
    expect(r.sim.count('user/syncrequest')).toBe(2); // one per connection
    expect(r.sim.count('fill/list')).toBeGreaterThanOrEqual(2);
    expect(r.sim.heartbeats).toBeGreaterThanOrEqual(4);
    expect(await r.engine.masterNet()).toBe(4);
    expect((await r.engine.reconcile()).rows).toEqual([]);
  });

  test('(m) a connection dropped by the server reconnects and recovers the same way', async () => {
    const r = await setup({ accounts: 2 });
    r.sim.dropFeed();
    const gap = r.sim.masterTrade({ action: 'Sell', fills: [1] });
    await r.engine.runFor(5_000);

    for (const id of [A, B]) {
      expect(r.sim.ordersOf(id).map((o) => o.clOrdId)).toEqual([`tc-${gap[0]}-${id}`]);
      expect(r.sim.positionOf(id)).toBe(-1);
    }
    expect(r.sim.count('user/syncrequest')).toBe(2);
  });
});

describe('rejection, closeout, kill switch', () => {
  test('(n) follower rejection: no retry loop, intent REJECTED, drift reported', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, fault: { kind: 'reject', reason: 'TradingLocked' } }] });
    r.sim.masterTrade({ action: 'Buy', fills: [2] });
    await r.engine.runUntilIdle();
    await r.engine.runFor(10 * 60_000);

    expect(placed(r, A)).toHaveLength(1);
    expect(r.sim.ordersOf(A)).toHaveLength(0);
    expect((await intent(r, A))[0]).toMatchObject({ state: 'REJECTED', detail: 'TradingLocked', sends: 1 });
    expect(r.sim.positionOf(B)).toBe(2);
    expect((await r.engine.reconcile()).rows).toMatchObject([{ accountId: A, expected: 2, actual: 0, drift: -2 }]);
    expect((await r.engine.alerts()).map((a) => a.kind)).toEqual(['order_rejected']);
  });

  test('(o) a pre-existing duplicate position: closeout flattens exactly it', async () => {
    const r = await setup({ accounts: 2 });
    r.sim.seedPosition(A, 3);
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();
    expect(r.sim.positionOf(A)).toBe(4);
    expect((await r.engine.reconcile()).rows).toMatchObject([{ accountId: A, expected: 1, actual: 4, drift: 3 }]);

    const close = await r.engine.closeout(A);
    expect(close).toMatchObject({ sent: true, qty: 4, action: 'Sell', clOrdId: 'close-1001-3001-1' });
    expect(r.sim.positionOf(A)).toBe(0);
    expect(r.sim.positionOf(B)).toBe(1);
    expect(r.sim.ordersOf(A).at(-1)).toMatchObject({ qty: 4, action: 'Sell', isAutomated: true, clOrdId: 'close-1001-3001-1' });

    // Idempotent: asked again, the position is already flat and nothing is sent.
    expect(await r.engine.closeout(A)).toMatchObject({ sent: false, qty: 0 });
    expect(r.sim.ordersOf(A)).toHaveLength(3); // the seeded one, the copy, the close
  });

  test('(o) a closeout whose response is lost is adopted, never sent twice', async () => {
    const r = await setup({ accounts: 2, plan: [{ accountId: A, nth: 2, fault: { kind: 'lostAfterAccept' } }] });
    r.sim.masterTrade({ action: 'Buy', fills: [2] });
    await r.engine.runUntilIdle();
    await r.engine.closeout(A);

    expect(r.sim.positionOf(A)).toBe(0);
    expect(r.sim.ordersOf(A)).toHaveLength(2);
    expect((await intent(r, A, 'close-'))[0]).toMatchObject({ state: 'ACKED', adopted: true, sends: 1 });
    expect(await r.engine.closeout(A)).toMatchObject({ sent: false, qty: 0 });
  });

  test('(p) kill switch: entries blocked, closes allowed', async () => {
    const r = await setup({ accounts: 2 });
    r.sim.masterTrade({ action: 'Buy', fills: [2] });
    await r.engine.runUntilIdle();

    await r.engine.setKillSwitch(true);
    expect((await r.engine.alerts()).map((a) => a.kind)).toEqual(['kill_switch_on']);
    const entry = r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();
    expect(r.sim.count('order/placeorder')).toBe(2);
    expect(r.sim.positionOf(A)).toBe(2);
    expect((await r.engine.intents({ accountId: A })).find((i) => i.master_fill_id === entry[0])).toMatchObject({ state: 'BLOCKED', detail: 'kill_switch' });

    r.sim.masterTrade({ action: 'Sell', fills: [1] });
    await r.engine.runUntilIdle();
    expect(r.sim.count('order/placeorder')).toBe(4);
    expect(r.sim.positionOf(A)).toBe(1);

    // A reduction never crosses zero while the switch is on: it would open the other side.
    r.sim.masterTrade({ action: 'Sell', fills: [4] });
    await r.engine.runUntilIdle();
    expect(r.sim.positionOf(A)).toBe(0);
    expect(r.sim.ordersOf(A).at(-1)).toMatchObject({ action: 'Sell', qty: 1 });

    const reopen = await r.engine.closeout(B);
    expect(reopen).toMatchObject({ sent: false, qty: 0 });

    // Back on: new entries flow again, and what the switch skipped stays visible as drift.
    await r.engine.setKillSwitch(false);
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.runUntilIdle();
    expect(r.sim.positionOf(A)).toBe(1);
    expect((await r.engine.reconcile()).rows).toMatchObject([
      { accountId: A, expected: -1, actual: 1, drift: 2 },
      { accountId: B, expected: -1, actual: 1, drift: 2 },
    ]);
  });

  test('(p) kill switch set while entries wait to be sent: they are blocked too', async () => {
    const r = await setup({ accounts: 2 });
    r.sim.masterTrade({ action: 'Buy', fills: [1] });
    await r.engine.settleFeed();
    await r.engine.setKillSwitch(true);
    await r.engine.runUntilIdle();

    expect(r.sim.count('order/placeorder')).toBe(0);
    expect(await r.engine.intentCounts()).toMatchObject({ BLOCKED: 2 });
  });

  test('(p) closeout still works with the switch on', async () => {
    const r = await setup({ accounts: 1 });
    r.sim.masterTrade({ action: 'Buy', fills: [2] });
    await r.engine.runUntilIdle();
    await r.engine.setKillSwitch(true);

    expect(await r.engine.closeout(A)).toMatchObject({ sent: true, qty: 2, action: 'Sell' });
    expect(r.sim.positionOf(A)).toBe(0);
  });
});

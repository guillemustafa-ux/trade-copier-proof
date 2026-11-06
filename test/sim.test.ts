import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { makeBook } from '../sim/book.js';
import { Simulator, TOKEN_LIFE_MS } from '../sim/simulator.js';
import type { FaultRule } from '../sim/faults.js';
import { VirtualClock } from '../src/clock.js';

const ACCOUNT = 1001;
const body = (over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  accountSpec: 'login-01',
  action: 'Buy',
  symbol: 'ESZ6',
  orderQty: 2,
  orderType: 'Market',
  isAutomated: true,
  clOrdId: 'c-1',
  ...over,
});

let sim: Simulator | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

async function start(plan: FaultRule[] = [], evictStatus?: number) {
  const clock = new VirtualClock();
  const book = makeBook({ logins: 1, accounts: 2 });
  sim = new Simulator({ clock, book, plan, ...(evictStatus ? { evictStatus } : {}) });
  await sim.listen();
  const api = async (method: string, path: string, token: string | undefined, payload?: unknown) => {
    const res = await fetch(`${sim!.url}/v1/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };
  const login = async (name = 'login-01') =>
    (await api('POST', 'auth/accesstokenrequest', undefined, { name, password: 'sim-password' })).json.accessToken as string;
  return { clock, book, api, login, sim: sim! };
}

describe('simulator: documented paths and shapes', () => {
  test('placeorder requires action, symbol, orderQty, orderType and answers with an orderId', async () => {
    const { api, login } = await start();
    const token = await login();
    const bad = await api('POST', 'order/placeorder', token, { accountId: ACCOUNT, action: 'Buy' });
    expect(bad.status).toBe(400);
    const ok = await api('POST', 'order/placeorder', token, body());
    expect(ok.status).toBe(200);
    expect(ok.json.orderId).toBeGreaterThan(0);
  });

  test('an Order has no quantity and echoes clOrdId; a Fill has no accountId; a Position has netPos', async () => {
    const { api, login } = await start();
    const token = await login();
    const { orderId } = (await api('POST', 'order/placeorder', token, body())).json;
    const order = (await api('GET', `order/item?id=${orderId}`, token)).json;
    expect(order).toMatchObject({ id: orderId, accountId: ACCOUNT, action: 'Buy', ordStatus: 'Filled', clOrdId: 'c-1', admin: false });
    expect(order).not.toHaveProperty('orderQty');
    expect(order).not.toHaveProperty('symbol');
    const fills = (await api('GET', 'fill/list', token)).json;
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ orderId, qty: 2, action: 'Buy', active: true });
    expect(fills[0]).not.toHaveProperty('accountId');
    const positions = (await api('GET', 'position/list', token)).json;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ accountId: ACCOUNT, netPos: 2, bought: 2, sold: 0 });
    const accounts = (await api('GET', 'account/list', token)).json;
    expect(accounts.map((a: { id: number }) => a.id)).toEqual([1001, 1002]);
    expect((await api('GET', 'contract/item?id=3001', token)).json.name).toBe('ESZ6');
  });

  test('order/deps lists one account; order/list lists every account of the login', async () => {
    const { api, login } = await start();
    const token = await login();
    await api('POST', 'order/placeorder', token, body());
    await api('POST', 'order/placeorder', token, body({ accountId: 1002, clOrdId: 'c-2' }));
    expect((await api('GET', 'order/deps?masterid=1001', token)).json.map((o: { clOrdId: string }) => o.clOrdId)).toEqual(['c-1']);
    expect((await api('GET', 'order/list', token)).json).toHaveLength(2);
  });

  test('clOrdId is stored and echoed, never enforced as unique', async () => {
    const { api, login, sim } = await start();
    const token = await login();
    const first = await api('POST', 'order/placeorder', token, body());
    const second = await api('POST', 'order/placeorder', token, body());
    expect(first.json.orderId).not.toBe(second.json.orderId);
    expect(sim.ordersOf(ACCOUNT).map((o) => o.clOrdId)).toEqual(['c-1', 'c-1']);
    expect(sim.positionOf(ACCOUNT)).toBe(4);
  });

  test('cancelorder cancels the working remainder of a partial fill and refuses a filled order', async () => {
    const { api, login, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'partialFill', filled: 1 } }]);
    const token = await login();
    const { orderId } = (await api('POST', 'order/placeorder', token, body())).json;
    expect(sim.positionOf(ACCOUNT)).toBe(1);
    expect((await api('POST', 'order/cancelorder', token, { orderId })).json.commandId).toBeGreaterThan(0);
    expect(sim.ordersOf(ACCOUNT)[0]?.ordStatus).toBe('Canceled');
    expect((await api('POST', 'order/cancelorder', token, { orderId })).json.failureReason).toBe('TooLate');
  });
});

describe('simulator: faults over real sockets', () => {
  test('response lost after the order was accepted: the caller sees a failure, the order exists', async () => {
    const { api, login, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'lostAfterAccept' } }]);
    const token = await login();
    await expect(api('POST', 'order/placeorder', token, body())).rejects.toThrow();
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(1);
    expect(sim.positionOf(ACCOUNT)).toBe(2);
  });

  test('response lost before it was accepted: the caller sees a failure, no order exists', async () => {
    const { api, login, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'lostBeforeAccept', mode: 'http500' } }]);
    const token = await login();
    expect((await api('POST', 'order/placeorder', token, body())).status).toBe(500);
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(0);
    expect(sim.positionOf(ACCOUNT)).toBe(0);
  });

  test('an order can stay out of order/deps and positions until a delay passes', async () => {
    const { api, login, clock, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'delayedVisibility', delayMs: 5_000 } }]);
    const token = await login();
    await api('POST', 'order/placeorder', token, body());
    expect((await api('GET', 'order/deps?masterid=1001', token)).json).toEqual([]);
    expect((await api('GET', 'position/list', token)).json).toEqual([]);
    await clock.advanceTo(clock.now() + 5_000);
    expect((await api('GET', 'order/deps?masterid=1001', token)).json).toHaveLength(1);
    expect((await api('GET', 'position/list', token)).json[0].netPos).toBe(2);
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(1);
  });

  test('penalty in a 200: nothing placed; an early retry adds back-off; the ticket after p-time is handled', async () => {
    const { api, login, clock, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'penalty', pTime: 15 } }]);
    const token = await login();
    const first = await api('POST', 'order/placeorder', token, body());
    expect(first.status).toBe(200);
    expect(first.json['p-time']).toBe(15);
    expect(first.json.orderId).toBeUndefined();
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(0);

    const early = await api('POST', 'order/placeorder', token, body({ 'p-ticket': first.json['p-ticket'] }));
    expect(early.json['p-time']).toBe(30);
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(0);

    await clock.advanceTo(clock.now() + 30_000);
    const handled = await api('POST', 'order/placeorder', token, body({ 'p-ticket': first.json['p-ticket'] }));
    expect(handled.json.orderId).toBeGreaterThan(0);
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(1);
  });

  test('p-captcha: nothing placed and a retry gets 423', async () => {
    const { api, login, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'captcha' } }]);
    const token = await login();
    const first = await api('POST', 'order/placeorder', token, body());
    expect(first.status).toBe(200);
    expect(first.json['p-captcha']).toBe(true);
    expect((await api('POST', 'order/placeorder', token, body({ 'p-ticket': first.json['p-ticket'] }))).status).toBe(423);
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(0);
  });

  test('429: empty body, every call on that login answers 429 and resets the hour', async () => {
    const { api, login, clock } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'lockout429' } }]);
    const token = await login();
    const first = await api('POST', 'order/placeorder', token, body());
    expect(first.status).toBe(429);
    expect(first.text).toBe('');
    await clock.advanceTo(clock.now() + 3_599_000);
    expect((await api('GET', 'order/list', token)).status).toBe(429);
    await clock.advanceTo(clock.now() + 3_599_000);
    expect((await api('GET', 'order/list', token)).status).toBe(429);
    await clock.advanceTo(clock.now() + 3_600_000);
    // The hour is over. The old token outlived its 80 minutes in the meantime, so log in again.
    expect((await api('GET', 'order/list', token)).status).toBe(401);
    expect((await api('GET', 'order/list', await login())).status).toBe(200);
  });

  test('a third session closes the oldest; its token then answers with the eviction status', async () => {
    const { api, login, sim } = await start([], 408);
    const oldest = await login();
    await login();
    expect((await api('GET', 'order/list', oldest)).status).toBe(200);
    await login();
    expect((await api('GET', 'order/list', oldest)).status).toBe(408);
    expect(sim.sessions('login-01')).toBe(2);
  });

  test('the evict fault closes the session before the order is handled', async () => {
    const { api, login, sim } = await start([{ accountId: ACCOUNT, nth: 1, fault: { kind: 'evict' } }]);
    const token = await login();
    expect((await api('POST', 'order/placeorder', token, body())).status).toBe(500);
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(0);
  });

  test('tokens live 80 minutes; renewal extends the session without opening another', async () => {
    const { api, login, clock, sim } = await start();
    const token = await login();
    await clock.advanceTo(clock.now() + TOKEN_LIFE_MS - 1_000);
    const renewed = await api('GET', 'auth/renewaccesstoken', token);
    expect(renewed.json.accessToken).not.toBe(token);
    expect(sim.sessions('login-01')).toBe(1);
    expect((await api('GET', 'auth/me', token)).status).toBe(401);
    await clock.advanceTo(clock.now() + TOKEN_LIFE_MS - 1_000);
    expect((await api('GET', 'auth/me', renewed.json.accessToken)).status).toBe(200);
    await clock.advanceTo(clock.now() + 1_000);
    expect((await api('GET', 'auth/me', renewed.json.accessToken)).status).toBe(401);
  });

  test('a follower rejection is a 200 with failureReason and no order', async () => {
    const { api, login, sim } = await start([{ accountId: ACCOUNT, fault: { kind: 'reject', reason: 'TradingLocked' } }]);
    const token = await login();
    const res = await api('POST', 'order/placeorder', token, body());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ failureReason: 'TradingLocked' });
    expect(res.json.orderId).toBeUndefined();
    expect(sim.ordersOf(ACCOUNT)).toHaveLength(0);
  });
});

describe('simulator: master feed', () => {
  async function connect(wsUrl: string, token: string) {
    const ws = new WebSocket(wsUrl);
    const frames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', (data) => {
        frames.push(data.toString());
        if (data.toString() === 'o') resolve();
      });
    });
    ws.send(`authorize\n0\n\n${token}`);
    ws.send(`user/syncrequest\n1\n\n${JSON.stringify({ splitResponses: true, accounts: [1], entityTypes: ['fill'] })}`);
    return { ws, frames };
  }
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };
  const fillFrames = (frames: string[]) => frames.filter((f) => f.includes('"entityType":"fill"'));

  test('one sync per connection; a second one on the same connection is refused', async () => {
    const { api, sim } = await start();
    const token = (await api('POST', 'auth/accesstokenrequest', undefined, { name: 'master', password: 'sim-password' })).json.accessToken;
    const { ws, frames } = await connect(sim.wsUrl, token);
    await until(() => frames.some((f) => f.includes('"i":1')));
    ws.send(`user/syncrequest\n2\n\n{}`);
    await until(() => frames.some((f) => f.includes('"s":400')));
    expect(sim.count('user/syncrequest')).toBe(2);
    ws.close();
  });

  test('a repeated and out-of-order frame is delivered as planned; the fill list holds each fill once', async () => {
    const { api, sim } = await start();
    const token = (await api('POST', 'auth/accesstokenrequest', undefined, { name: 'master', password: 'sim-password' })).json.accessToken;
    const { ws, frames } = await connect(sim.wsUrl, token);
    await until(() => frames.some((f) => f.includes('"i":1')));
    const ids = sim.masterTrade({ action: 'Buy', fills: [1, 2], delivery: [1, 0, 1] });
    await until(() => fillFrames(frames).length === 3);
    const delivered = fillFrames(frames).map((f) => JSON.parse(f.slice(1))[0].d.entity.id);
    expect(delivered).toEqual([ids[1], ids[0], ids[1]]);
    expect((await api('GET', 'fill/list', token)).json).toHaveLength(2);
    ws.close();
  });

  test('a stalled connection goes silent and its frames are lost; the fill list still holds them', async () => {
    const { api, sim } = await start();
    const token = (await api('POST', 'auth/accesstokenrequest', undefined, { name: 'master', password: 'sim-password' })).json.accessToken;
    const { ws, frames } = await connect(sim.wsUrl, token);
    await until(() => frames.some((f) => f.includes('"i":1')));
    sim.stallFeed();
    sim.masterTrade({ action: 'Buy', fills: [2] });
    ws.send('[]');
    await new Promise((r) => setTimeout(r, 50));
    expect(fillFrames(frames)).toHaveLength(0);
    expect(frames).not.toContain('h');
    expect((await api('GET', 'fill/list', token)).json).toHaveLength(1);
    ws.terminate();
  });

  test('the server drops a connection that sends nothing for 15 seconds', async () => {
    const { api, clock, sim } = await start();
    const token = (await api('POST', 'auth/accesstokenrequest', undefined, { name: 'master', password: 'sim-password' })).json.accessToken;
    const { ws, frames } = await connect(sim.wsUrl, token);
    await until(() => frames.some((f) => f.includes('"i":1')));
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await clock.advanceTo(clock.now() + 15_001);
    await api('GET', 'order/list', token);
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

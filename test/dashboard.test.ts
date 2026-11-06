import { afterEach, expect, test } from 'vitest';
import { startDashboard } from '../src/dashboard.js';
import { rig, type Rig } from './support/rig.js';

let current: Rig | undefined;
let stopServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stopServer?.();
  await current?.close();
  current = undefined;
});

test('(t) dashboard JSON: per-login health, intents by state, accounts with drift, alerts', async () => {
  const r = await rig({
    logins: 2,
    accounts: 4,
    config: { concurrency: 1 },
    plan: [
      { accountId: 1001, fault: { kind: 'reject', reason: 'TradingLocked' } },
      { accountId: 1004, nth: 1, fault: { kind: 'captcha' } },
    ],
  });
  current = r;
  r.sim.masterTrade({ action: 'Buy', fills: [1] });
  await r.engine.runUntilIdle();
  await r.engine.reconcile();

  const server = await startDashboard(r.engine.store, 0);
  stopServer = server.close;
  const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
    logins: Array<Record<string, unknown>>;
    intents: Record<string, number>;
    drift: Array<Record<string, unknown>>;
    unverifiedAccounts: number[];
    alerts: Array<Record<string, unknown>>;
    killSwitch: boolean;
  };

  expect(state.logins.map((l) => [l.name, l.state, l.blockedReason])).toEqual([
    ['login-01', 'ACTIVE', null],
    ['login-02', 'BLOCKED', 'p_captcha'],
    ['master', 'ACTIVE', null],
  ]);
  expect(state.logins[0]).not.toHaveProperty('password');
  expect(state.logins[0]).not.toHaveProperty('access_token');
  expect(state.logins[0]).not.toHaveProperty('accessToken');
  expect(state.intents).toEqual({ ACKED: 2, REJECTED: 1, BLOCKED: 1 });
  expect(state.drift).toEqual([{ accountId: 1001, contractId: 3001, login: 'login-01', expected: 1, actual: 0, drift: -1, duplicateClOrdIds: [] }]);
  expect(state.unverifiedAccounts).toEqual([1003, 1004]);
  expect(state.alerts.map((a) => a.kind)).toEqual(['order_rejected', 'p_captcha']);
  expect(state.killSwitch).toBe(false);

  const html = await fetch(server.url);
  expect(html.status).toBe(200);
  expect(html.headers.get('content-type')).toContain('text/html');
  expect(await html.text()).toContain('trade-copier-proof');

  // Read-only: nothing on it can change state.
  expect((await fetch(`${server.url}/api/state`, { method: 'POST' })).status).toBe(405);
  expect((await fetch(`${server.url}/nothing`)).status).toBe(404);
});

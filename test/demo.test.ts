import { expect, inject, test } from 'vitest';
import { makeBook } from '../sim/book.js';
import { buildPlan, runDemo, runEngine, runNaive } from '../src/demo.js';
import { resetDatabase } from './support/rig.js';

test('(q) the naive copier under the seeded chaos shows duplicates and residual contracts, literal numbers', async () => {
  const naive = await runNaive({ seed: 42, logins: 50, accounts: 1000 });
  expect(naive).toMatchObject({
    ordersPlaced: 8938,
    duplicatedOrders: 4493,
    duplicatesImmediate: 43,
    duplicatesLater: 4450,
    wrongPositionAccounts: 965,
    wrongPositionContracts: 8637,
    missedCopies: 78,
    residualAccounts: 73,
    residualContracts: 151,
    requestsSpent: 13399,
  });
});

test('(q) the engine under the same seed: 3 duplicates, all flagged, and what it could not reach it says so', async () => {
  const url = inject('databaseUrl');
  await resetDatabase(url);
  const engine = await runEngine({ seed: 42, logins: 50, accounts: 1000, databaseUrl: url });
  expect(engine).toMatchObject({
    ordersPlaced: 4506,
    duplicatedOrders: 3,
    duplicatesImmediate: 0,
    duplicatesLater: 3,
    flaggedDuplicates: 3,
    wrongPositionAccounts: 52,
    missedCopies: 44,
    residualAccounts: 5,
    residualContracts: 10,
    residualOnStoppedLogins: 10,
    stoppedLogins: ['login-03', 'login-04'],
    blockedIntents: 34,
    rejectedIntents: 50,
    unknownIntents: 0,
    alerts: { http_429: 1, order_rejected: 50, p_captcha: 1, session_lost: 2 },
  });
});

test('the fault plan is a pure function of the seed and the book', () => {
  const book = makeBook({ logins: 50, accounts: 1000 });
  expect(buildPlan(42, book)).toEqual(buildPlan(42, book));
  expect(buildPlan(42, book)).not.toEqual(buildPlan(7, book));
  expect(buildPlan(42, book).counts).toMatchObject({ 'response lost after accept (connection reset)': 30, 'order visible 45 s late, after the grace window': 3 });
});

test('(r) demo: the report is byte-identical for the same seed and differs for another', async () => {
  const url = inject('databaseUrl');
  const run = async (seed: number) => {
    await resetDatabase(url);
    return runDemo({ seed, logins: 10, accounts: 200, databaseUrl: url });
  };
  const first = await run(42);
  const second = await run(42);
  expect(second.report).toBe(first.report);
  const other = await run(7);
  expect(other.report).not.toBe(first.report);
  expect(first.report).toContain('| Duplicated orders (same clOrdId placed twice) |');
  expect(first.report).toContain('Latency is simulated');
});

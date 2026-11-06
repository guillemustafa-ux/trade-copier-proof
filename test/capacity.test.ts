import { expect, test } from 'vitest';
import { capacity, renderCapacity } from '../src/capacity.js';

test('(s) 50 logins, 1,000 accounts, one egress /24: renewals are the first limit, literal numbers', () => {
  const c = capacity({ logins: 50, accounts: 1000, egressIps: 1 });
  expect(c.accountsPerLogin).toBe(20);
  expect(c.renewalsPerHour).toBe(37.5);
  expect(c.renewalBudgetPerHour).toBe(15);
  expect(c.minEgressForRenewals).toBe(3);
  expect(c.maxLoginsOnEgress).toBe(20);
  expect(c.syncPerWave).toBe(50);
  expect(c.syncBudgetPerHour).toBe(300);
  expect(c.fullWavesPerHour).toBe(6);
  expect(c.tradesPerHourUserLimit).toBe(250);
  expect(c.tradesPerHourVendorPerLogin).toBe(75);
  expect(c.tradesPerHourVendorPerSubnet).toBe(1.5);
  expect(c.firstLimit).toBe('renewals');

  const text = renderCapacity(c);
  expect(text).toContain('37.5 per hour');
  expect(text).toContain('documented');
  expect(text).toContain('vendor-reported');
  expect(text).toContain('At least 3 egress /24s');
  expect(c.renewalsPerHourOneLoginPerAccount).toBe(750);
  expect(text).toContain('with one login per prop account, 1000 logins need 750 renewals per hour');
});

test('(s) the first limit assumes renewed sessions: re-authenticating costs 0 in the table, but opens a session', () => {
  const text = renderCapacity(capacity({ logins: 50, accounts: 1000, egressIps: 1 }));
  expect(text).toContain('This holds only if sessions are renewed.');
  expect(text).toContain('accesstokenrequest counts failed requests only [documented], so re-authenticating every 80 minutes costs 0 in the endpoint table');
  expect(text).toContain('it opens a session, and past two the oldest is closed [documented], which evicts what that user has open');
  expect(text).toContain('Logins and egress /24s, not accounts, as long as sessions are renewed:');
});

test('(s) one login per prop account: 600 logins need 450 renewals per hour, literal numbers', () => {
  const c = capacity({ logins: 600, accounts: 600, egressIps: 1 });
  expect(c.accountsPerLogin).toBe(1);
  expect(c.renewalsPerHour).toBe(450);
  expect(c.renewalsPerHourOneLoginPerAccount).toBe(450);
  expect(c.renewalBudgetPerHour).toBe(15);
  expect(c.minEgressForRenewals).toBe(30);
  expect(c.maxLoginsOnEgress).toBe(20);
  expect(c.fullWavesPerHour).toBe(0.5);
  expect(c.tradesPerHourUserLimit).toBe(5000);
  expect(c.tradesPerHourVendorPerLogin).toBe(1500);
  expect(c.tradesPerHourVendorPerSubnet).toBe(2.5);
  expect(c.firstLimit).toBe('renewals');

  const text = renderCapacity(c);
  expect(text).toContain('Needed: 450 per hour');
  expect(text).toContain('with one login per prop account, 600 logins need 450 renewals per hour');
  expect(text).toContain('At least 30 egress /24s');
});

test('(s) doubling the accounts leaves the first limit alone; doubling the logins moves it', () => {
  const more = capacity({ logins: 50, accounts: 2000, egressIps: 1 });
  expect(more.renewalsPerHour).toBe(37.5);
  expect(more.firstLimit).toBe('renewals');
  expect(more.tradesPerHourUserLimit).toBe(125);

  const doubled = capacity({ logins: 100, accounts: 1000, egressIps: 1 });
  expect(doubled.renewalsPerHour).toBe(75);
  expect(doubled.minEgressForRenewals).toBe(5);
});

test('(s) with enough egress /24s, renewals stop being the first limit and placements per login take over', () => {
  const c = capacity({ logins: 50, accounts: 1000, egressIps: 3 });
  expect(c.renewalBudgetPerHour).toBe(45);
  expect(c.firstLimit).toBe('placements');
  expect(c.tradesPerHourVendorPerSubnet).toBe(4.5);
  expect(renderCapacity(c)).toContain('placements per trade');
});

test('(s) all accounts on one login: it is the accounts per login that bind, and the output says so', () => {
  const c = capacity({ logins: 1, accounts: 1000, egressIps: 1 });
  expect(c.renewalsPerHour).toBe(0.75);
  expect(c.firstLimit).toBe('placements');
  expect(c.accountsPerLogin).toBe(1000);
  expect(c.tradesPerHourUserLimit).toBe(5);
  expect(c.tradesPerHourVendorPerLogin).toBe(1.5);
  expect(renderCapacity(c)).toContain('1000 accounts per login');
});

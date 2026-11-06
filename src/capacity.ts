export const LIMITS = {
  tokenLifeMinutes: 80,
  renewPerHourPerSubnet: 15,
  syncPerHourPerSubnet: 300,
  userRequestsPerHour: 5_000,
  /** Vendor-reported, not in the official table. See docs/sources.md. */
  vendorPlacementsPerHour: 1_500,
};

export interface CapacityInput {
  logins: number;
  accounts: number;
  egressIps: number;
  placementLimit?: number;
}

export interface Capacity extends CapacityInput {
  accountsPerLogin: number;
  renewalsPerHour: number;
  renewalBudgetPerHour: number;
  minEgressForRenewals: number;
  maxLoginsOnEgress: number;
  syncPerWave: number;
  syncBudgetPerHour: number;
  fullWavesPerHour: number;
  tradesPerHourUserLimit: number;
  tradesPerHourVendorPerLogin: number;
  tradesPerHourVendorPerSubnet: number;
  firstLimit: 'renewals' | 'sync' | 'placements';
}

/** Arithmetic from the documented limits; nothing is measured against a server here. */
export function capacity(input: CapacityInput): Capacity {
  const { logins, accounts, egressIps } = input;
  const placementLimit = input.placementLimit ?? LIMITS.vendorPlacementsPerHour;
  const accountsPerLogin = Math.ceil(accounts / logins);
  const renewalsPerHour = (logins * 60) / LIMITS.tokenLifeMinutes;
  const renewalBudgetPerHour = LIMITS.renewPerHourPerSubnet * egressIps;
  const syncBudgetPerHour = LIMITS.syncPerHourPerSubnet * egressIps;
  const fullWavesPerHour = syncBudgetPerHour / logins;
  return {
    ...input,
    accountsPerLogin,
    renewalsPerHour,
    renewalBudgetPerHour,
    minEgressForRenewals: Math.ceil(renewalsPerHour / LIMITS.renewPerHourPerSubnet),
    maxLoginsOnEgress: Math.floor((renewalBudgetPerHour * LIMITS.tokenLifeMinutes) / 60),
    syncPerWave: logins,
    syncBudgetPerHour,
    fullWavesPerHour,
    tradesPerHourUserLimit: LIMITS.userRequestsPerHour / accountsPerLogin,
    tradesPerHourVendorPerLogin: placementLimit / accountsPerLogin,
    tradesPerHourVendorPerSubnet: (placementLimit * egressIps) / accounts,
    // Renewals run whether or not anyone trades, so they bind first once they exceed their budget.
    firstLimit: renewalsPerHour > renewalBudgetPerHour ? 'renewals' : fullWavesPerHour < 1 ? 'sync' : 'placements',
  };
}

export function renderCapacity(c: Capacity): string {
  const placementLimit = c.placementLimit ?? LIMITS.vendorPlacementsPerHour;
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, ''));
  const over = c.renewalsPerHour > c.renewalBudgetPerHour;
  const lines = [
    `Capacity: ${c.logins} logins, ${c.accounts} accounts, ${c.egressIps} egress /24 (${c.accountsPerLogin} accounts per login). Arithmetic only; no server was asked.`,
    '',
    'Session renewals',
    `  Token life ${LIMITS.tokenLifeMinutes} minutes [documented]; renewaccesstoken ${LIMITS.renewPerHourPerSubnet} per hour per /24, all requests count [documented].`,
    `  Needed: ${n(c.renewalsPerHour)} per hour even renewing at the last moment. Available: ${c.renewalBudgetPerHour} per hour. ${over ? 'OVER BUDGET.' : 'Fits.'}`,
    `  This egress holds at most ${c.maxLoginsOnEgress} logins. These logins need at least ${c.minEgressForRenewals} egress /24s.`,
    '',
    'Reconnect waves',
    `  syncrequest ${LIMITS.syncPerHourPerSubnet} per hour per /24, all requests count [documented]; one sync per connection [documented].`,
    `  If every login holds a socket, one wave costs ${c.syncPerWave} syncs, so ${n(c.fullWavesPerHour)} full waves per hour fit. This engine syncs the master only: 1 sync per wave.`,
    '',
    'Placements per trade',
    `  One trade costs ${c.accountsPerLogin} placements on each login, ${c.accounts} in total.`,
    `  User limit ${LIMITS.userRequestsPerHour} requests per hour per user [documented; the docs say the top limit is set per partner]: ${n(c.tradesPerHourUserLimit)} trades per hour, counting nothing but placements.`,
    `  placeorder is not in the official table. ${placementLimit} per hour [vendor-reported, CrossTrade, configurable, not verified]:`,
    `    read per login, as the vendor does: ${n(c.tradesPerHourVendorPerLogin)} trades per hour.`,
    `    read per /24, as the official page keys penalty tickets: ${n(c.tradesPerHourVendorPerSubnet)} trades per hour.`,
    '',
    'What sets the first limit',
  ];
  if (c.firstLimit === 'renewals') {
    lines.push(
      `  Logins and egress /24s, not accounts: ${c.logins} logins need ${n(c.renewalsPerHour)} renewals per hour against ${c.renewalBudgetPerHour}, with no trade placed and whatever the account count.`,
      `  Implication: At least ${c.minEgressForRenewals} egress /24s for this many logins, with renewals spread across the hour. A bigger server changes nothing here; a second address in the same /24 does not either.`,
    );
  } else if (c.firstLimit === 'sync') {
    lines.push(`  Reconnect waves: ${c.logins} logins with a socket each exceed the sync budget in one wave. Implication: keep sockets to the master, or add egress /24s.`);
  } else {
    lines.push(
      `  Renewals fit, so placements per trade bind first, and with ${c.accountsPerLogin} accounts per login that ratio is the number to manage: ${n(c.tradesPerHourVendorPerLogin)} to ${n(c.tradesPerHourUserLimit)} trades per hour per login, or ${n(c.tradesPerHourVendorPerSubnet)} if the vendor's limit is really per /24.`,
      `  Implication: spread accounts over logins, and logins over egress /24s, then measure the real placement limit on a demo account before relying on either reading.`,
    );
  }
  lines.push('', 'Sources: docs/sources.md.');
  return lines.join('\n');
}

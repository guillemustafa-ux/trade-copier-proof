import { capacity, renderCapacity } from './capacity.js';

/** `npm run capacity -- --logins N --accounts M --egress-ips K [--placement-limit P]` */
function arg(name: string, fallback: string): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = Number(index >= 0 ? process.argv[index + 1] : fallback);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(1);
  }
  return value;
}

console.log(
  renderCapacity(
    capacity({
      logins: arg('logins', '50'),
      accounts: arg('accounts', '1000'),
      egressIps: arg('egress-ips', '1'),
      placementLimit: arg('placement-limit', '1500'),
    }),
  ),
);

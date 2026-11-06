import { startDashboard } from './dashboard.js';
import { runEngine } from './demo.js';
import { createDatabase, dropDatabase, startPostgres } from './pg-scratch.js';
import { Store } from './store.js';

/**
 * `npm run dashboard -- [--port N] [--seed N] [--logins N] [--accounts N]`
 * Runs the seeded chaos scenario through the engine on a throwaway database, then serves what it
 * left there until Ctrl-C.
 */
function arg(name: string, fallback: string): number {
  const index = process.argv.indexOf(`--${name}`);
  return Number(index >= 0 ? process.argv[index + 1] : fallback);
}

const server = await startPostgres('trade-copier-dashboard-');
const name = `trade_copier_dashboard_${process.pid}_${Date.now()}`;
const databaseUrl = await createDatabase(server.baseUrl, name);
console.log('Running the seeded scenario through the engine ...');
await runEngine({ seed: arg('seed', '42'), logins: arg('logins', '50'), accounts: arg('accounts', '1000'), databaseUrl });

const store = new Store(databaseUrl);
const dashboard = await startDashboard(store, arg('port', '3100'));
console.log(`Dashboard: ${dashboard.url}  (JSON: ${dashboard.url}/api/state). Ctrl-C stops it and drops the database.`);

const stop = async () => {
  await dashboard.close();
  await store.close();
  await dropDatabase(server.baseUrl, name);
  await server.stop();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

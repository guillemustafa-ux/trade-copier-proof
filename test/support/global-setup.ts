import type { TestProject } from 'vitest/node';
import { createDatabase, dropDatabase, startPostgres } from '../../src/pg-scratch.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** One real Postgres and one brand-new database for the whole run; the tests reset its tables. */
export default async function setup(project: TestProject) {
  const server = await startPostgres();
  const name = `trade_copier_test_${process.pid}_${Date.now()}`;
  const databaseUrl = await createDatabase(server.baseUrl, name);
  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await dropDatabase(server.baseUrl, name);
    await server.stop();
  };
}

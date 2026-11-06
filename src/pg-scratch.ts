import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

export interface ScratchPostgres {
  baseUrl: string;
  stop: () => Promise<void>;
}

/**
 * A real Postgres for a run.
 *  - DATABASE_URL set: use that server (CI uses a postgres:16 service container).
 *  - otherwise: start Postgres 16 with `embedded-postgres` in a fresh directory under the OS
 *    temp dir (never inside the repo) and remove it afterwards.
 * Callers create their own throwaway database, so an existing DATABASE_URL is never written to
 * outside it.
 */
export async function startPostgres(prefix = 'trade-copier-pg-'): Promise<ScratchPostgres> {
  const external = (process.env.DATABASE_URL || '').replace(/"/g, '');
  if (external) return { baseUrl: external, stop: async () => {} };

  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  const port = await freePort();
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // Quiet on success, but keep the output so a failed initdb/start can say why.
  const output: string[] = [];
  const keep = (message: unknown) => output.push(...describe(message).split(/\r?\n/));
  const server = new EmbeddedPostgres({
    databaseDir: join(dataRoot, 'data'),
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: keep,
    onError: keep,
  });
  try {
    await server.initialise();
    await server.start();
  } catch (reason) {
    throw new Error(`embedded-postgres failed to start: ${describe(reason)}\n${output.slice(-40).join('\n')}`);
  }
  return {
    baseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

export async function createDatabase(baseUrl: string, name: string): Promise<string> {
  await runSql(baseUrl, `create database ${name}`);
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

export async function dropDatabase(baseUrl: string, name: string): Promise<void> {
  await runSql(baseUrl, `drop database if exists ${name} with (force)`);
}

async function runSql(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return typeof value === 'string' ? value : String(value);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

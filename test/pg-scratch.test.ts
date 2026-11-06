import pg from 'pg';
import { expect, inject, test } from 'vitest';

test('the suite runs on a fresh PostgreSQL database, 16 or newer', async () => {
  const client = new pg.Client({ connectionString: inject('databaseUrl') });
  await client.connect();
  try {
    const version = await client.query<{ server_version_num: string }>('show server_version_num');
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160000);
    const tables = await client.query(`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'pg_scratch_marker'`);
    expect(tables.rowCount).toBe(0);
  } finally {
    await client.end();
  }
});

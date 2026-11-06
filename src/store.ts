import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { Book } from '../sim/book.js';

pg.types.setTypeParser(20, Number); // bigint: ids and millisecond times fit in a double here

export interface Sizing {
  multiplier: number;
  maxContracts: number;
  enabled: boolean;
}

export const DEFAULT_SIZING: Sizing = { multiplier: 1, maxContracts: 1_000_000, enabled: true };

export type IntentState = 'PLANNED' | 'SENDING' | 'ACKED' | 'UNKNOWN' | 'REJECTED' | 'BLOCKED';

export interface IntentRow {
  id: number;
  kind: 'COPY' | 'CLOSE';
  master_fill_id: number | null;
  follower_account_id: number;
  login_name: string;
  cl_ord_id: string;
  action: 'Buy' | 'Sell';
  symbol: string;
  contract_id: number;
  qty: number;
  reduces: boolean;
  state: IntentState;
  order_id: number | null;
  sends: number;
  adopted: boolean;
  p_ticket: string | null;
  penalties: number;
  lookup_failures: number;
  unknown_since: number | null;
  due_at: number | null;
  detail: string | null;
  created_at: number;
  acked_at: number | null;
}

export interface LoginRow {
  name: string;
  password: string;
  state: 'ACTIVE' | 'BLOCKED';
  blocked_reason: string | null;
  access_token: string | null;
  token_expires_at: number | null;
  not_before_at: number;
  suspect: boolean;
  renewals: number;
  reauths: number;
}

export interface AccountRow {
  id: number;
  name: string;
  login_name: string;
  multiplier: string;
  max_contracts: number;
  enabled: boolean;
}

export interface AlertRow {
  id: number;
  at: number;
  login_name: string | null;
  kind: string;
  detail: string;
}

/** What a follower should hold for a master net position. Never rounds up, never exceeds the cap. */
export function expectedNet(masterNet: number, account: { multiplier: number | string; max_contracts: number }): number {
  const sized = Math.trunc(Number((masterNet * Number(account.multiplier)).toFixed(6)));
  return Math.max(-account.max_contracts, Math.min(account.max_contracts, sized));
}

export class Store {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    await this.pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }

  async seed(book: Book, sizing: (accountId: number) => Sizing): Promise<void> {
    const logins = [book.master.login, ...book.logins.map((l) => l.name)];
    const passwords = [book.master.password, ...book.logins.map((l) => l.password)];
    await this.pool.query(
      `insert into logins (name, password) select * from unnest($1::text[], $2::text[]) on conflict (name) do nothing`,
      [logins, passwords],
    );
    const sized = book.accounts.map((a) => sizing(a.id));
    await this.pool.query(
      `insert into accounts (id, name, login_name, multiplier, max_contracts, enabled)
       select * from unnest($1::bigint[], $2::text[], $3::text[], $4::numeric[], $5::int[], $6::boolean[])
       on conflict (id) do nothing`,
      [
        book.accounts.map((a) => a.id),
        book.accounts.map((a) => a.name),
        book.accounts.map((a) => a.login),
        sized.map((s) => s.multiplier),
        sized.map((s) => s.maxContracts),
        sized.map((s) => s.enabled),
      ],
    );
  }

  async login(name: string): Promise<LoginRow> {
    return (await this.pool.query<LoginRow>('select * from logins where name = $1', [name])).rows[0]!;
  }

  async logins(): Promise<LoginRow[]> {
    return (await this.pool.query<LoginRow>('select * from logins order by name')).rows;
  }

  async accounts(): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>('select * from accounts order by id')).rows;
  }

  async account(id: number): Promise<AccountRow | undefined> {
    return (await this.pool.query<AccountRow>('select * from accounts where id = $1', [id])).rows[0];
  }

  async storeToken(name: string, token: string, expiresAt: number, kind: 'first' | 'renewal' | 'reauth'): Promise<void> {
    await this.pool.query(
      `update logins set access_token = $2, token_expires_at = $3, suspect = false,
         renewals = renewals + $4, reauths = reauths + $5 where name = $1`,
      [name, token, expiresAt, kind === 'renewal' ? 1 : 0, kind === 'reauth' ? 1 : 0],
    );
  }

  async setSuspect(name: string, suspect: boolean): Promise<void> {
    await this.pool.query('update logins set suspect = $2 where name = $1', [name, suspect]);
  }

  async setNotBefore(name: string, at: number): Promise<void> {
    await this.pool.query('update logins set not_before_at = greatest(not_before_at, $2) where name = $1', [name, at]);
  }

  async alert(at: number, loginName: string | null, kind: string, detail: string): Promise<void> {
    await this.pool.query('insert into alerts (at, login_name, kind, detail) values ($1, $2, $3, $4)', [at, loginName, kind, detail]);
  }

  async alerts(): Promise<AlertRow[]> {
    return (await this.pool.query<AlertRow>('select * from alerts order by id')).rows;
  }

  /** This login stops: nothing more is sent on it, and what it still owed becomes BLOCKED. */
  async blockLogin(at: number, name: string, reason: string, detail: string): Promise<void> {
    await this.tx(async (c) => {
      const res = await c.query(`update logins set state = 'BLOCKED', blocked_reason = $2 where name = $1 and state = 'ACTIVE'`, [name, reason]);
      if (!res.rowCount) return;
      await c.query(
        `update intents set state = 'BLOCKED', due_at = null, detail = coalesce(detail, $2)
         where login_name = $1 and state in ('PLANNED', 'SENDING', 'UNKNOWN')`,
        [name, reason],
      );
      await c.query('insert into alerts (at, login_name, kind, detail) values ($1, $2, $3, $4)', [at, name, reason, detail]);
    });
  }

  async tx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (reason) {
      await client.query('rollback');
      throw reason;
    } finally {
      client.release();
    }
  }

  /** Due work, at most `limit` per login: lookups first, then tickets, then the oldest. */
  async pickWork(now: number, limit: number): Promise<IntentRow[]> {
    const res = await this.pool.query<IntentRow>(
      `with ranked as (
         select i.*, row_number() over (
           partition by i.login_name
           order by case when i.state = 'UNKNOWN' then 0 when i.p_ticket is not null then 1 else 2 end, i.id
         ) as rn
         from intents i join logins l on l.name = i.login_name
         where i.state in ('PLANNED', 'UNKNOWN') and i.due_at <= $1 and l.state = 'ACTIVE' and l.not_before_at <= $1
       )
       select * from ranked where rn <= $2 order by login_name, rn`,
      [now, limit],
    );
    return res.rows;
  }

  async nextDue(): Promise<number | null> {
    const res = await this.pool.query<{ t: number | null }>(
      `select min(greatest(i.due_at, l.not_before_at)) as t
       from intents i join logins l on l.name = i.login_name
       where i.state in ('PLANNED', 'UNKNOWN') and i.due_at is not null and l.state = 'ACTIVE'`,
    );
    return res.rows[0]?.t ?? null;
  }

  /** Committed before any network call: a crash after this point leaves SENDING, never a silent send. */
  async markSending(ids: number[]): Promise<void> {
    await this.pool.query(`update intents set state = 'SENDING', sends = sends + 1 where id = any($1::bigint[])`, [ids]);
  }

  async intents(filter: { accountId?: number }): Promise<IntentRow[]> {
    const res = filter.accountId
      ? await this.pool.query<IntentRow>('select * from intents where follower_account_id = $1 order by id', [filter.accountId])
      : await this.pool.query<IntentRow>('select * from intents order by id');
    return res.rows;
  }

  async intentCounts(): Promise<Partial<Record<IntentState, number>>> {
    const res = await this.pool.query<{ state: IntentState; n: number }>('select state, count(*)::int as n from intents group by state');
    return Object.fromEntries(res.rows.map((r) => [r.state, r.n]));
  }

  async setting(key: string): Promise<string | undefined> {
    return (await this.pool.query<{ value: string }>('select value from settings where key = $1', [key])).rows[0]?.value;
  }

  async masterNetRows(): Promise<Array<{ contract_id: number; symbol: string; net: number }>> {
    return (await this.pool.query('select * from master_net order by contract_id')).rows;
  }

  /** After a restart nothing is known about what was in flight: it may have reached the server. */
  async recoverInFlight(now: number): Promise<void> {
    await this.pool.query(
      `update intents set state = 'UNKNOWN', unknown_since = $1, due_at = $1, detail = 'in flight when the process stopped' where state = 'SENDING'`,
      [now],
    );
  }

  async hasFill(fillId: number): Promise<boolean> {
    return Boolean((await this.pool.query('select 1 from master_fills where fill_id = $1', [fillId])).rowCount);
  }
}

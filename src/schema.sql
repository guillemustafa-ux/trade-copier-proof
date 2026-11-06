-- All engine state. A restart reads everything from here; nothing is kept only in memory.
-- Times are milliseconds from the injected clock.

create table if not exists logins (
  name text primary key,
  password text not null,                 -- simulator credential; a real deployment keeps this in a secret store
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'BLOCKED')),
  blocked_reason text,
  access_token text,                      -- stored so a restart reuses the session instead of opening another
  token_expires_at bigint,
  not_before_at bigint not null default 0,
  suspect boolean not null default false, -- a request failed in a way that may mean the session is gone
  renewals int not null default 0,
  reauths int not null default 0
);

create table if not exists accounts (
  id bigint primary key,
  name text not null,
  login_name text not null references logins (name),
  multiplier numeric not null default 1,
  max_contracts int not null default 1000000,
  enabled boolean not null default true
);

create table if not exists master_fills (
  fill_id bigint primary key,
  order_id bigint not null,
  contract_id bigint not null,
  symbol text not null,
  action text not null,
  qty int not null,
  ingested_at bigint not null
);

create table if not exists master_net (
  contract_id bigint primary key,
  symbol text not null,
  net int not null
);

create table if not exists intents (
  id bigserial primary key,
  kind text not null default 'COPY' check (kind in ('COPY', 'CLOSE')),
  master_fill_id bigint references master_fills (fill_id),
  follower_account_id bigint not null references accounts (id),
  login_name text not null references logins (name),
  cl_ord_id text not null unique,         -- deterministic per pair; the server does not enforce uniqueness
  action text not null,
  symbol text not null,
  contract_id bigint not null,
  qty int not null,
  reduces boolean not null default false, -- moves the follower toward flat
  state text not null check (state in ('PLANNED', 'SENDING', 'ACKED', 'UNKNOWN', 'REJECTED', 'BLOCKED')),
  order_id bigint,
  sends int not null default 0,
  adopted boolean not null default false,
  p_ticket text,
  penalties int not null default 0,
  lookup_failures int not null default 0,
  unknown_since bigint,
  due_at bigint,                          -- null: parked, waiting for nothing
  detail text,
  created_at bigint not null,
  acked_at bigint,
  unique (master_fill_id, follower_account_id)
);
create index if not exists intents_due on intents (login_name, state, due_at);

create table if not exists alerts (
  id bigserial primary key,
  at bigint not null,
  login_name text,
  kind text not null,
  detail text not null
);

create table if not exists settings (
  key text primary key,
  value text not null
);

-- The latest reconcile, read by the dashboard.
create table if not exists drift (
  account_id bigint not null,
  contract_id bigint not null,
  login_name text not null,
  expected int,
  actual int,
  drift int,
  duplicate_cl_ord_ids text[] not null default '{}',
  unverified boolean not null default false,
  checked_at bigint not null,
  primary key (account_id, contract_id)
);

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Store } from './store.js';

/**
 * Read-only: one HTML page and one JSON endpoint over what the engine stored. It has no auth
 * framework, listens on 127.0.0.1 and is a local demo. Tokens and passwords never leave Postgres.
 */
export async function dashboardState(store: Store) {
  const logins = await store.logins();
  const drift = await store.pool.query('select * from drift order by account_id, contract_id');
  const alerts = await store.alerts();
  return {
    logins: logins.map((l) => ({
      name: l.name,
      state: l.state,
      blockedReason: l.blocked_reason,
      tokenExpiresAt: l.token_expires_at,
      renewals: l.renewals,
      reauths: l.reauths,
    })),
    intents: await store.intentCounts(),
    drift: drift.rows
      .filter((d) => !d.unverified)
      .map((d) => ({
        accountId: Number(d.account_id),
        contractId: Number(d.contract_id),
        login: d.login_name,
        expected: d.expected,
        actual: d.actual,
        drift: d.drift,
        duplicateClOrdIds: d.duplicate_cl_ord_ids,
      })),
    unverifiedAccounts: drift.rows.filter((d) => d.unverified).map((d) => Number(d.account_id)),
    alerts: alerts.map((a) => ({ at: a.at, login: a.login_name, kind: a.kind, detail: a.detail })),
    killSwitch: (await store.setting('kill_switch')) === 'on',
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>trade-copier-proof</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; color: #1b1f24; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 1.75rem; }
  table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid #d8dde3; padding: .25rem .5rem; text-align: left; font-variant-numeric: tabular-nums; }
  .blocked { color: #a4161a; font-weight: 600; }
  .note { color: #57606a; }
</style>
</head>
<body>
<h1>trade-copier-proof</h1>
<p class="note">Read-only view of the engine's Postgres state, simulated accounts only. <span id="kill"></span></p>
<h2>Intents by state</h2><table id="intents"></table>
<h2>Logins</h2><table id="logins"></table>
<h2>Accounts with drift</h2><table id="drift"></table>
<p class="note" id="unverified"></p>
<h2>Alerts</h2><table id="alerts"></table>
<script>
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fill = (id, heads, rows) => {
  document.getElementById(id).innerHTML = '<tr>' + heads.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('');
};
fetch('/api/state').then((r) => r.json()).then((s) => {
  document.getElementById('kill').textContent = 'Kill switch: ' + (s.killSwitch ? 'ON' : 'off') + '.';
  fill('intents', ['State', 'Count'], Object.entries(s.intents).map(([k, v]) => [esc(k), esc(v)]));
  fill('logins', ['Login', 'State', 'Reason', 'Renewals', 'Re-auths'], s.logins.map((l) => [
    esc(l.name), l.state === 'BLOCKED' ? '<span class="blocked">BLOCKED</span>' : esc(l.state), esc(l.blockedReason), esc(l.renewals), esc(l.reauths)]));
  fill('drift', ['Account', 'Login', 'Expected', 'Actual', 'Drift', 'Duplicated clOrdIds'], s.drift.map((d) => [
    esc(d.accountId), esc(d.login), esc(d.expected), esc(d.actual), esc(d.drift), esc(d.duplicateClOrdIds.join(', '))]));
  document.getElementById('unverified').textContent = s.unverifiedAccounts.length
    ? s.unverifiedAccounts.length + ' accounts could not be read: they are on logins the engine stopped, and it sends nothing there.' : '';
  fill('alerts', ['Kind', 'Login', 'Detail'], s.alerts.map((a) => [esc(a.kind), esc(a.login), esc(a.detail)]));
});
</script>
</body>
</html>
`;

export async function startDashboard(store: Store, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (path !== '/' && path !== '/api/state') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      return;
    }
    dashboardState(store).then(
      (state) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state)),
      (reason: unknown) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(reason) })),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

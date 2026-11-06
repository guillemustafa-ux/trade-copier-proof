# trade-copier-proof

A web-side trade copier that fans one master account out to 1,000 simulated accounts over the
documented Tradovate API, with every order written to Postgres before it is sent. A simulator that
misbehaves on purpose runs it through lost responses, penalties, session evictions, crashes and feed
gaps. In those scenarios it placed no duplicate order, with one exception this repo exists to show
plainly: [an order that stays invisible past the grace window](#the-honest-hole).

**It was never connected to Tradovate or NinjaTrader.** Everything here runs against a local
simulator built from the public docs, with no credentials of any kind. See
[Limitations](#limitations-stated-plainly).

It answers this ask, quoted from a job post:

> "I currently have a custom built copier inside of ninjatrader that handles over 600 accounts. I
> would like to transition this to a web based copier. Due to the size of my portfolio ninja trader
> is becoming less and less useful as the system often freezes and creates duplicate orders that can
> be unclose-able. I'd like a web based option where I could take a trade in Tradovate/ninja trader
> and the trade would be copied directly into the other accounts I trade"
>
> "Going forward I plan to add hundreds of accounts and eventually get to 1000+ accounts I am trading
> via prop firms so the build must be able to handle that"

| The ask | Where it is answered |
| --- | --- |
| "duplicate orders" | [the measured table](#what-the-demo-measured), [failure to mechanism](#failure-to-mechanism), and [what still duplicates](#the-honest-hole) |
| "unclose-able" | `closeout` sizes from the position on the server, not from belief: test (o) |
| "often freezes" | [what the cloud changes](#what-moving-to-the-cloud-changes-and-what-it-does-not), and a stop that survives: test (f). This repo makes no claim about why any particular copier freezes |
| "1000+ accounts" | test (a) at 1,000 accounts over 50 logins, and [capacity](#capacity-what-sets-the-first-limit): as long as sessions are renewed, logins and egress addresses bind before accounts do |
| "take a trade in Tradovate/ninja trader" | the master is read through Tradovate's user sync. A NinjaTrader-side master was not built |
| "via prop firms" | [prop firm note](#prop-firm-note): rules differ per firm and are the trader's decision |

## Quick path

Node 22.12 or later (exercised locally on Node 24.16, Windows 11). No Docker, no API key.

```bash
npm ci
npm test                     # the whole suite, against a throwaway PostgreSQL 16
npm run demo                 # naive copier and engine on one seeded scenario; writes COPY_REPORT.md
npm run capacity -- --logins 50 --accounts 1000 --egress-ips 1
npm run dashboard            # runs the scenario, then serves a read-only page on 127.0.0.1:3100
npm run footgun intent-after-send
```

`npm test` and `npm run demo` use `DATABASE_URL` if it is set; otherwise they start PostgreSQL 16 with
[`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) in a fresh directory under the
OS temp dir and remove it afterwards. Either way they work in a database they create and drop.

## What the demo measured

`npm run demo`, seed 42: 1,000 accounts across 50 logins plus one master, the same scenario and fault
plan against both copiers. Every number is read from the simulator's records. The report is
byte-identical for the same seed: test (r) pins that at 200 accounts, and this 1,000-account report
was compared by running it twice. This table is [`COPY_REPORT.md`](COPY_REPORT.md):

| Measured | Naive copier | Engine |
| --- | --- | --- |
| Copy orders placed | 8938 | 4506 |
| Orders per account, min / avg / max | 0 / 8.94 / 11 | 0 / 4.51 / 6 |
| Duplicated orders (same clOrdId placed twice) | 4493 | 3 |
| ... retried at once | 43 | 0 |
| ... repeated master frame | 1789 | 0 |
| ... replay after reconnect | 2661 | 0 |
| ... re-send after the grace window | 0 | 3 |
| Accounts with a wrong position at end of scenario | 965 | 52 |
| Contracts of wrong position | 8637 | 102 |
| Accounts with a missed copy (no order at all) | 78 | 44 |
| Accounts left holding a position after closeout | 73 | 5 |
| Residual contracts after closeout | 151 | 10 |
| Requests spent | 13399 | 5846 |
| Simulated copy latency, p50 (ms) | 1996 | 867 |
| Simulated copy latency, p99 (ms) | 135914 | 15987 |

How to read the engine's column, because it is not all zeros and should not be:

- **3 duplicates.** The plan makes 3 orders visible only after the grace window. The engine re-sent
  them. All 3 positions drifted, so the reconciler flagged all 3: it looks for duplicates only on
  accounts that drifted. See [the honest hole](#the-honest-hole).
- **52 wrong positions and 44 missed copies.** 34 of each are on the two logins the plan stops (one
  `p-captcha`, one `429`): the engine sends nothing there and raises an alert, so those accounts fall
  behind on purpose. 10 of each are accounts the server rejected. The other 8 wrong positions are 5
  partial follower fills and the 3 duplicates above. The report measures this split.
- **10 residual contracts, 5 accounts.** All 10 are on the two stopped logins. A person decides what
  happens there.

Almost all of the naive copier's 4,493 duplicates come from two modeled behaviours with no dedupe
behind them: 2,661 from replaying recent fills to every account after the reconnect, and 1,789 from
copying a repeated master frame. Only 43 are retries at once. So the gap says what those two
behaviours cost on this scenario, not how often a real copier does them. **It is a deliberately
simple model of a failure class** (in-memory state, retry on timeout, replay after a reconnect, close
orders sized from what it believes it sent), in [`naive/copier.ts`](naive/copier.ts). It is not
anyone's real copier, and this repo makes no claim about why any real copier duplicates orders.

Latency is simulated: virtual time from master fill to order acceptance, made of pacing, penalties,
grace windows, feed stalls and a fixed 20-99 ms per order. No network was measured.

## Failure to mechanism

Each row is proven against the simulator over real sockets, through the same entry points a
deployment would use. Letters are test names in [`test/engine.test.ts`](test/engine.test.ts).

| Failure | What the engine does | Test |
| --- | --- | --- |
| A master frame repeats or arrives out of order | Dedupes by fill id. Sizing works on the cumulative master position, so order does not change the total | (b) |
| Timeout, reset or 5xx on a send | The intent becomes UNKNOWN and is never re-sent blind. It lists that account's orders and matches `clOrdId`: found means adopt | (c) |
| The order is not there yet | Waits the grace window (30 s by default), looks again, and only then re-sends, once | (d) |
| The re-send is lost too | Stays UNKNOWN and alerts. There is no third send | (d) |
| The process is killed at any of four named points | The intent row commits before the network call. On restart, what was in flight goes through the same lookup | (f), real child process killed with SIGKILL |
| A 200 body carrying `p-ticket` | Not a placed order. Waits `p-time`, then re-sends the identical body with the ticket | (g) |
| `p-captcha`, or HTTP 429 | That login stops: its intents become BLOCKED, an alert is raised, no further request goes to it. Other logins finish | (h), (i) |
| A third session evicts the engine's | `auth/me` detects it and the session is replaced. The failed send still goes through the lookup. A 429 here reads as a lockout and is treated as one | (j) |
| A token nearing 80 minutes | Renewed 15 minutes before expiry in the same session. A penalty on the renewal waits rather than opening a session | (k) |
| Partial master fills | 0.5 of 3, 6 and 10 is 1, 3, 5: per-fill rounding would give 4 | (l) |
| Feed stall or drop | Heartbeats, silence detection, reconnect with one sync per connection, then the fill list closes the gap | (m) |
| A follower rejection | REJECTED after one send, an alert, and drift in the next reconcile. No retry loop | (n) |
| A position nobody can explain | `closeout` reads `position/list` and sends exactly that, tagged and idempotent | (o) |
| Stop now | The kill switch blocks entries, including those waiting to go. Closes still pass. A reduction is sized from the position read at send time, and held back while another order on that pair is unresolved. [What that covers](#what-the-kill-switch-covers) | (p), (l) |

The reconciler reports by default. Auto-close is explicit config: `reconcile({ autoClose: true })`.

### What the kill switch covers

With the switch on, a reduction is cut to the `position/list` read at send time, after taking off any
close in the same batch, and goes only toward flat. Test (p) pins that it stops at flat after a partial
fill (holding +1, believing 3, `Sell 1`), when it was already waiting as the switch went on, with
several in one batch, and next to a close.

While another order on that pair is UNKNOWN or SENDING, a reduction is blocked
(`kill_switch_inflight`). A send with no answer that stays absent after the grace window is not
re-sent: it is blocked with an alert, and `closeout` is the way out. If the read answers 429, 423 or
`p-captcha`, the login stops and nothing is sent. A `p-ticket` holds the batch until `p-time`. Other
failures retry, and after 5 reads the reductions are blocked with an alert
(`kill_switch_position_unread`).

**Not covered:** an ACKED order that has not filled yet is not in the read, so a reduction can still
cross zero, and test (p) pins that too. **With the switch off**, a reduction is sized from the master,
not from the position, so after a partial fill it can cross zero (holding +1, `Sell 3`, position -2),
and the reconciler flags the drift: test (l).

## The honest hole

Without a server-side uniqueness check, one case cannot be closed from the client side. **The docs do
not say `clOrdId` is unique, and the simulator does not enforce it.** So:

1. The order is accepted and the response is lost.
2. The order stays out of `order/deps` and out of positions for longer than the grace window.
3. The engine looks twice, finds nothing, and re-sends once, as it must or the copy would be missed.
4. The first order appears. There are now two.

Test (e) runs exactly this and asserts the duplicate is real. What the engine does is contain it: the
reconciler flags the two orders on the same `clOrdId`, and `closeout` removes the excess. A longer
grace window makes the hole smaller and every lost-before-accept copy later; it does not close it.
Whether a real server can stay silent that long is **not verified**: it is the worst behaviour the
docs do not rule out.

## What moving to the cloud changes, and what it does not

| Changes | Does not change |
| --- | --- |
| No desktop platform sits in the copy path: fills arrive on a socket, placements go over REST | The API limits. They are per `/24` and per user, wherever the process runs |
| State outlives the process: kill it anywhere and it resumes (f) | A lost response is still ambiguous, and `clOrdId` is still not enforced, so [the hole](#the-honest-hole) remains |
| Egress addresses become a design choice, which is what the limits turn on | Cloud addresses can be shared: "you may share limits with them" if another client sends from your `/24` |
| It can be watched from a browser (a read-only dashboard here) and stopped by a kill switch | Two sessions per user. With a third, "the oldest sessions are closed", so the trader's own logins can evict the copier. The docs: "Your API user should be a dedicated user" |
| It can run with the desktop off | Prop firm rules |

Whether this removes a given copier's freezes is not something this repo can show: it never ran
anyone's copier.

## Capacity: what sets the first limit

```text
$ npm run capacity -- --logins 50 --accounts 1000 --egress-ips 1

Session renewals
  Token life 80 minutes [documented]; renewaccesstoken 15 per hour per /24, all requests count [documented].
  Needed: 37.5 per hour even renewing at the last moment. Available: 15 per hour. OVER BUDGET.
  This egress holds at most 20 logins. These logins need at least 3 egress /24s.
  This holds only if sessions are renewed. accesstokenrequest counts failed requests only [documented], so re-authenticating every 80 minutes costs 0 in the endpoint table, but it opens a session, and past two the oldest is closed [documented], which evicts what that user has open.
  Accounts per login is unknown: with one login per prop account, 1000 logins need 750 renewals per hour.

Reconnect waves
  syncrequest 300 per hour per /24, all requests count [documented]; one sync per connection [documented].
  If every login holds a socket, one wave costs 50 syncs, so 6 full waves per hour fit. This engine syncs the master only: 1 sync per wave.

Placements per trade
  One trade costs 20 placements on each login, 1000 in total.
  User limit 5000 requests per hour per user [documented; the docs say the top limit is set per partner]: 250 trades per hour, counting nothing but placements.
  placeorder is not in the official table. 1500 per hour [vendor-reported, CrossTrade, configurable, not verified]:
    read per login, as the vendor does: 75 trades per hour.
    read per /24, as the official page keys penalty tickets: 1.5 trades per hour.
```

**The arithmetic confirms it, as long as sessions are renewed: logins and egress addresses bind first,
not accounts.** Doubling the accounts to 2,000 leaves the renewal line at 37.5 per hour; doubling the
logins moves it to 75. Test (s) pins these with literal numbers.

Re-authenticating every 80 minutes instead costs 0 in the endpoint table, because `accesstokenrequest`
counts failed requests only, but it opens a session, and the two-session rule evicts what that user
has open. Accounts per login is unknown: with one login per prop account, 600 logins need 450 renewals
per hour, against 15 per `/24`.

With enough `/24`s the limit moves to placements, and the number to manage is accounts per login: put
all 1,000 accounts on one login and one trade costs 1,000 placements, which is 5 trades per hour on
the documented limit and 1.5 on the vendor's. The vendor's limit needs measuring before anyone relies
on it: if it is keyed by `/24`, as the official page says penalty tickets are, the same 1,000-account
fan-out fits only 1.5 times an hour per `/24`.

Scaling out is described, not built. This is one engine process. Several would each own a set of
logins and an egress `/24`, sharing Postgres.

## Prop firm note

Rules differ per firm and are the trader's decision. **This repo does not check compliance with any
firm's rules, and no firm's rules were read for it.**

The official docs say of the Demo environment: "Most of your users trade exclusively in this
environment." A vendor, CrossTrade, says "Tradovate-based firm logins generally live in Tradovate's
Demo environment" and, on bots and copiers, "Firms disagree sharply here." Those two vendor
statements are not verified here. Read your firm's current rules before pointing anything at those
accounts.

## The suite bites: footguns

The suite asserts literal numbers. Each file in [`footguns/`](footguns/) is a small patch that puts
one real mistake back. `npm run footgun <name>` applies it, runs the whole suite, reverts it, and
prints `PASS` only when **exactly** the tests listed in [`footguns/manifest.json`](footguns/manifest.json)
fail and every other test stays green. The mapping below is what was measured on 2026-11-06:

| Footgun | The mistake | Tests that fail |
| --- | --- | --- |
| `blind-retry-on-timeout` | An ambiguous send is re-sent at once, with no lookup | (c) all four, (d) both, (o) lost close, (q) engine |
| `treat-200-as-placed` | Any 200 counts as a placed order | (g), (h), (n), (q) engine, (t) |
| `intent-after-send` | SENDING is committed after the network call | (f) `after_send_before_ack`, (f) `after_ack_before_commit` |
| `no-grace-window` | One empty lookup is enough to re-send | (c) inside the window, (d) first case, (q) engine |
| `ignore-captcha` | `p-captcha` is read as an ordinary penalty | (h) |
| `feed-no-dedupe` | A repeated fill is ingested again | (b), (m) first case |
| `close-from-belief` | `closeout` sizes from its own intents | (e) both, (o) pre-existing position, (q) engine |

Two results worth reading. `feed-no-dedupe` does not produce a second order: the unique key on
`(master_fill_id, follower_account_id)` still stops it, and what breaks is the master position, counted
twice. And `intent-after-send` fails only the crash tests, which is the point of killing a real process:
without a crash, that ordering bug is invisible.

## Limitations, stated plainly

- **Never connected to Tradovate or NinjaTrader.** No real accounts, no live or demo credentials, no
  order has ever left this machine.
- **The simulator is built from the docs and fills their silences with assumptions.** Each one is
  labelled `modeled assumption` in [docs/sources.md](docs/sources.md). A real server can behave
  differently, including better.
- **Latency is simulated.** It says nothing about real round trips.
- **`clOrdId` uniqueness is undocumented**, and the order placement limit is not in the official
  table. The 1,500 figure is vendor-reported and not verified.
- **A NinjaTrader-side master was not built.** The master feed is the Tradovate user sync. Whether a
  trade placed from NinjaTrader shows up on it is not verified.
- **Rate limits are not enforced by the simulator.** Penalties arrive where the fault plan puts them,
  and capacity is arithmetic. The engine reacts to penalties; it does not budget renewals or
  placements per `/24` ahead of time, and it does not spread renewals across the hour.
- **One engine process, one master account, market orders.** Other order types, stops and brackets
  are not modeled.
- **A stopped login stays stopped.** Resuming one after the hour is a person's decision and has no
  command yet. Its BLOCKED intents stay visible.
- **Secrets are not handled for real.** Passwords and tokens sit in Postgres in plain text because
  they are simulator values. A deployment would need a secret store and encryption at rest.
- **The dashboard has no authentication.** It is read-only and listens on 127.0.0.1, as a local demo.
- **Results hold for these scenarios.** A finite fault plan on one machine shows what it shows.
- **The CI workflow has not run yet.** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is
  included for Ubuntu (`postgres:16`), Windows (PostgreSQL 17) and every footgun; everything quoted
  here was run locally on Windows 11 with embedded PostgreSQL 16.

## Layout

```text
sim/simulator.ts     HTTP + WebSocket server: documented paths and shapes, virtual clock, planned faults
sim/faults.ts        the fault plan: by account or login, n-th call, never by arrival order
src/engine.ts        ingest, sender, resolver, reconciler, closeout, kill switch, driver
src/feed.ts          master socket: authorize, one sync per connection, heartbeat, reconnect
src/sessions.ts      one session per login: renew before expiry, detect eviction, re-auth
src/api.ts           REST client and the classifier for what a response really means
src/store.ts, src/schema.sql   every piece of state, in Postgres
src/demo.ts          the seeded scenario and COPY_REPORT.md
src/capacity.ts      the arithmetic from the documented limits
src/dashboard.ts     one read-only page and one JSON endpoint
naive/copier.ts      the comparator: a model of a failure class
test/                (a)-(t), simulator shapes, real crash tests
footguns/            one patch per reintroduced mistake + the tests it must fail
docs/sources.md      every third-party claim, quoted with its URL, and every modeled assumption
```

## License

MIT

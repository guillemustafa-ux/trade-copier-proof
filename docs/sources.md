# Sources

Every statement in this repo about Tradovate, NinjaTrader or a vendor comes from one of these pages,
fetched on 2026-11-05. Each quote below was checked word for word against a downloaded copy of the
page by a script (Markdown emphasis and backticks removed before comparing). Page text was treated
as data. Nothing here was checked against a live or demo Tradovate server: this repo never connected
to one.

The API docs are the official NT Connect docs. Base: `https://partner.ninjatrader.com/connect`.
Their index is <https://partner.ninjatrader.com/connect/llms.txt>.

## Official docs

### Rate limits: `/overview/core-concepts/rate-limits.md`

- "Applied per user (by user ID) across all endpoints"
- "Applied per IPv4 /24 subnet or individual full IPv6 address for specific endpoints"
- "Endpoint limits use a rolling one-hour window, not a fixed hourly reset."
- Shared addresses: "you may share limits with them."
- User-level table, Authenticated row: 5,000 per hour, 5,000 per minute, 5,000 per second.
- Endpoint table, `Limit/Hour`, `Back-off (sec)`, `Requests Counted`:
  - `accesstokenrequest`: 5, 15, Failed only
  - `renewaccesstoken`: 15, 15, All
  - `me`: 10, 30, Failed only
  - `syncrequest`: 300, 3, All
  - `dryrun`: 500, 1, All
- `placeorder` is absent from every table on the page (searched: zero occurrences of the word
  `placeorder`). The page's "Order Endpoints" table holds only `dryrun`.
- "Endpoints showing \"n/a\" do not have specific endpoint-level limits. They follow the standard user-level rate limits."
- "When you receive a penalty ticket, the request was not handled and the server has imposed a time penalty."
- `p-ticket`: "must be included as an additional parameter in the request body's JSON when retrying"
- `p-time`: "wait this long before retrying the call"
- `p-captcha`: "when true, the operation cannot be tried again from a third-party application and users should be alerted that they should try the operation again in an hour"
- 429: "Wait one hour before sending another request" and "Cannot be resolved programmatically from third-party applications"
- "Don't implement infinite retry loops - Set maximum retry attempts"

### Penalty tickets: `/overview/core-concepts/penalty-tickets.md`

Not on the parent's list; linked from the rate limits page and read because it changes the design.

- "Is keyed to your IP's /24 subnet, not to your user or API key, so callers on a subnet or a shared IP share a limit."
- "To resolve a p-ticket, wait the number of seconds in the response's p-time, then resend the identical request body with the p-ticket value added as an extra field."
- "p-time is additive: it is calculated by adding a back-off to any remaining p-time."
- "If you retry too many times before the p-time elapses, you will eventually receive an HTTP 429, a user-level limit across all your endpoints."
- "If you retry before the hour has elapsed, each call returns another HTTP 429 (empty body, no wait time to read) and resets the one-hour clock."
- "Don't route many users through one IP. Because limits are counted per subnet, funneling many users through a single outbound address makes them share one limit. Spread traffic across addresses where you can."
- "The one thing set per partner is your overall traffic top limit, the user-level request rate that governs HTTP 429 responses."

### Error handling: `/overview/core-concepts/error-handling.md`

- `423`: "A 423 (Locked) is returned when a penalty ticket requires a reCAPTCHA (p-captcha) and the retry doesn't include a solved reCAPTCHA."
- `500`: "One common case of a 500 level error is an internal timeout being hit."
- `401`, from the page's sample code: "// Token expired - refresh and retry"

### Place order: `/api/rest-api-endpoints/orders/place-order.md`

- `POST https://live.tradovateapi.com/v1/order/placeorder`
- Body: `action`, `symbol`, `orderQty`, `orderType` required; `accountSpec`, `accountId`, `clOrdId`,
  `customTag50`, `isAutomated` optional.
- Sample comment: "must be true if this isn't an order made directly by a human"
- Response `PlaceOrderResult`: `failureReason`, `failureText`, `orderId`, all optional. `failureReason`
  allowed values include `Success`, `TradingLocked`, `MaxPosLimitReached`, `InvalidContract`.
- `clOrdId` has a type and no description. The page says nothing about uniqueness (searched:
  zero occurrences of `unique`, `duplicate`, `idempot`). **Undocumented.**

### Operator ID: `/overview/trading/operator-id-and-passthrough.md`

Not on the parent's list; linked from the place order page.

- "Every order carries an operator ID: a value that identifies who placed it."
- `customTag50` table, user with neither mechanism configured, field sent: "Denied"
- "A denied request returns an access-denied error. Nothing is placed."

So the engine never sends `customTag50`: on an unconfigured user that alone is denied. Its orders are
tagged through `clOrdId`.

### Automated orders: `/resources/reference/terminology.md`

- "You MUST include the isAutomated flag set to true in the request body."
- "The trading environment where users trade on their Demo accounts."
- "Most of your users trade exclusively in this environment."

### Orders: `/api/rest-api-endpoints/orders/order-item.md`, `order-list.md`, `order-dependents.md`, `cancel-order.md`

- `GET /order/item`: "Fetches Order entity by `id` field"; the only query parameter is `id`. There is
  no lookup by `clOrdId` anywhere on these pages.
- `GET /order/list`: "Fetches all Order entities"; no parameters.
- `GET /order/deps`: "Fetches all Order entities associated to Account entity"; `masterid`: "Account entity ID".
- Order fields: `accountId`, `timestamp`, `action`, `ordStatus`, `admin`, `id`, `contractId`,
  `spreadDefinitionId`, `executionProviderId`, `ocoId`, `parentId`, `linkedId`, `clOrdId`. There is
  no quantity and no symbol on the Order, so the engine reads sizes from positions, never from orders.
- `ordStatus` allowed values: `Canceled`, `Completed`, `Expired`, `Filled`, `PendingCancel`,
  `PendingNew`, `PendingReplace`, `Rejected`, `Suspended`, `Unknown`, `Working`.
- `POST /order/cancelorder`: "Make a request to cancel an order."; `orderId` required; responds with
  `failureReason`, `failureText`, `commandId`.

### Fills: `/api/rest-api-endpoints/orders/fill-item.md`, `fill-list.md`

- `GET /fill/list`: "Fetches all Fill entities"; no parameters.
- Fill fields: `orderId`, `contractId`, `timestamp`, `tradeDate`, `action`, `qty`, `price`, `active`,
  `finallyPaired`, `id`. No `accountId`: a fill is tied to an account only through its Order.

### Positions and accounts: `/api/rest-api-endpoints/positions/position-list.md`, `/api/rest-api-endpoints/accounting/account-list.md`

- `GET /position/list`: "Fetches all Position entities". Fields include `accountId`, `contractId`,
  `netPos`, `bought`, `sold`.
- `GET /account/list`: "Fetches all Account entities". Fields include `name`, `userId`, `id`, `active`.

### Contract item: `/api/rest-api-endpoints/contract-library/contract-item.md`

Not on the parent's list. Needed because a fill carries `contractId` and `placeorder` wants `symbol`.

- `GET /contract/item`: "Fetches Contract entity by `id` field". Fields include `name`, `id`.

### Sessions: `/api/rest-api-endpoints/authentication/access-token-request.md`, `renew-access-token.md`

- "Access tokens expire after 80 minutes."
- "Each token response includes an expirationTime field with the exact expiry time."
- "This session is tracked, and you are limited to two concurrent sessions."
- "Once a third (or additional) session is created, the oldest sessions are closed."
- "Your oldest sessions will be closed, and subsequent calls using the old access tokens will throw 408, 429, or 500 level errors."
- "Your API user should be a dedicated user that doesn't require more than two concurrent logins."
- Renewal: "Extends the current session without creating a new one."
- `renewAccessToken` sample: "if expiration is within 15 mins, renew"

### WebSocket: `/overview/core-concepts/web-sockets/user-syncrequest.md`, `connection-overview.md`

- "After your WebSocket is authorized, send user/syncrequest once as a one-time bootstrap for that connection."
- "the backend expects exactly one sync request per connection lifecycle"
- "Every WebSocket request uses the same format: the endpoint, a request ID, an optional query, and an optional body, each on its own line."
- `entityTypes`: "omitting the field delivers every type"
- `userSessionStats`: "These events are informational and are not a disconnect signal."
- Connection limits: "Total connections per user" default 50.
- "The server drops any connection that sends nothing for 15 seconds."
- "If not, treat it as a heartbeat, idle, or network issue and reconnect."
- Sample code: "private readonly heartbeatInterval: number = 2500; // 2.5 seconds" and "this.ws.send('[]');"
- Sample code: "// Correct Tradovate format: authorize\n[request ID]\n\n[access token]"
- Duplicate delivery, ordering and gap recovery across a reconnect are not described on either page
  (searched: zero occurrences of `duplicate`, `gap`, `replay`, `at-least-once`). **Undocumented.**

### Environments: `/resources/reference/environments.md`

- Production demo REST: `https://demo.tradovateapi.com/v1`; production demo WebSocket:
  `wss://demo.tradovateapi.com/v1/websocket`.

## Vendor claims (not official, labelled wherever they are used)

### CrossTrade: order placement limit

<https://crosstrade.io/blog/understanding-tradovate-api-rate-limits>

- "Order placement is limited to 1,500 requests per hour, a figure Tradovate reports in its penalty tickets rather than in its published tables."
- "Copying multiplies every placement by the number of followers, and every follower on a login draws on the same 1,500 per hour placement limit."

Not verified here. Note the tension: the vendor describes it as per login, and it arrives as a
penalty ticket, which the official page says "Is keyed to your IP's /24 subnet, not to your user or
API key". If the placement limit is really keyed by `/24`, it is stricter than the vendor's reading.
`npm run capacity` prints both readings.

### CrossTrade: prop firm accounts

<https://crosstrade.io/blog/how-to-trade-tradovate-webhooks-without-a-vps>

- "Tradovate-based firm logins generally live in Tradovate's Demo environment and can be linked through Link Demo."

<https://crosstrade.io/blog/tradovate-automation-guide>

- "Firms disagree sharply here."
- "Some allow bots and copiers outright, some allow copying only between your own accounts, and some prohibit automation on evaluation and funded accounts altogether."

Not verified here. No firm's rules were read for this repo.

## Modeled assumptions (where the docs are silent the simulator takes the worst reasonable behaviour)

| Topic | What the docs say | What `sim/` does |
| --- | --- | --- |
| `clOrdId` uniqueness | nothing | stored and echoed, never enforced as unique: two orders may carry the same value |
| Feed delivery | nothing on duplicates, order, gaps | a frame can repeat, arrive out of order, or be lost across a reconnect |
| Order visibility | nothing | an accepted order may be absent from `order/deps` and from positions for a while |
| Ambiguous failure | nothing on whether the order exists after a reset, timeout or 5xx | the order may or may not exist; the client cannot tell from the failure |
| Which status an evicted token gets | "408, 429, or 500 level errors" | configurable, 500 by default |
| Expired token | the sample treats 401 as expired | 401 |
| Rejection | `failureReason` on a 200 | `{ failureReason, failureText }` with no `orderId` on a 200 |
| Props frame | "Create or Update \"props\" event" | `a[{"e":"props","d":{"entityType":"fill","eventType":"Created","entity":{...}}}]` |
| Sync reply body | "initializes your account state" | `{"s":200,"i":1,"d":{}}`; the engine recovers through `fill/list`, not this body |
| Server heartbeat | sample handles single-character frames | answers `[]` with `h`, silent when the connection is stalled |
| Second sync on a connection | "exactly one" | `{"s":400}` on that request |
| Penalty without a ticket | "must be included" | a new ticket with a longer `p-time` |
| Renewed token | sample stores the renewal's `accessToken` | a new token string; the previous one stops working at once |
| GET retried after a penalty | the ticket goes in the "JSON body" and a GET has none | the engine waits `p-time` and repeats the GET; `sim/` issues penalties only where the fault plan puts them |
| Early retries before a 429 | "eventually" | 3 early retries, then a 429 lockout |
| 1,500 placements per hour | not in the official table | not enforced by `sim/`; configurable reading in `npm run capacity` |
| Penalty scope | "Is keyed to your IP's /24 subnet, not to your user or API key" | per login: a ticket, p-captcha or 423 affects only the login that received it. Lenient, not the worst case |

The penalty scope row is the one exception to this section's heading: the docs are not silent there,
and `sim/` takes the lenient reading. The engine does not model egress at all.

# Shopify orders into Nexus: webhooks and a poll backstop (plan)

2026-09-26 · plan only, nothing built · base `origin/main` 074c1cf54 · to be reviewed before any build. Evidence: code on
main, public shopify.dev pages, read-only production aggregates (19:22 UTC; the reading role bypasses row security;
positive controls: Amazon and eBay orders and ledger rows are present). Paths are under `apps/api/src/` unless stated.

## 1. Goal and proof

Every Shopify order created at or after activation (T0) reaches Nexus within seconds by webhook, or within one poll
period if the webhook is lost. It holds stock once, each fulfilment takes only its own units, and cancellations and
refunds settle by the stock model (R1–R10, C1 in `docs/channel-connections/2026-09-26-STOCK-MODEL.md`). Met when all
five pass on production:

1. One real order after T0 gives one `Order` (SHOPIFY, linked to its connection) with its lines, one open hold per
   product for the ordered units at IT-MAIN, and the ORDER_PLACED cascade queued for that product's other channels.
2. The same order arriving again (Shopify retry, poll re-read, manual replay) leaves holds and movements unchanged.
3. Fulfilled in Shopify: the hold is taken exactly once (units = ordered), SHIPPED, `shippedAt` set, no open holds.
4. A second order, cancelled before fulfilment, releases its hold, creates no stock; each ledger row ends `done`.
5. SHOPIFY ledger: 0 `dlq`, no `failed` row older than 1 h; poll freshness `fresh`; every subscription `already_ours`.

## 2. Current state vs target

| Area | Today (verified) | Target |
|---|---|---|
| Orders in Nexus | **0 Shopify `Order` rows and 0 Shopify ledger rows, ever** (stronger than "none since May"). 1 active connection (connected, heartbeat; `lastInboundAt` null) with `read_orders`, `read_fulfillments`, `read_order_edits`, **not `read_all_orders`** (only the last 60 days are readable). App secret and routing alias present | Orders from T0 on |
| Stock model | PR #32's order logic is on main; its migrations (`20260926n/o/u/v_cx_*`) are applied in production | Reused, not rebuilt |
| Registration | `services/shopify/webhook-registration.service.ts` (P2.4) creates all 12 topics per shop over GraphQL. **Never run:** the call log holds 7 `webhookSubscriptions` reads, 0 creates. It sends `callbackUrl`, **deprecated in 2026-07** (now `uri`). It would also subscribe `products/update` (overwrites Nexus `Product.name` with the Shopify title) and `products/delete` (sets a Nexus product INACTIVE) | A named **order topic set**; `uri`; nightly reconcile |
| Subscription kind | Shop-specific. Shopify **deletes shop-specific subscriptions that keep failing**; app-config ones (`shopify.app.toml`) are not deleted and are Shopify's recommendation; compliance topics are app-config only | GraphQL for orders now (code exists) + reconcile; app config later, with the privacy topics |
| API version | One constant, `services/shopify/api-version.ts` = `2026-07` (current latest). A shop-specific subscription keeps the version of the request that created it (`apiVersion`). **No upgrade owner named** (P5.3 made the bump one line) | Reconcile reports subscriptions off the constant; owner in §5 |
| HMAC | Correct: raw body, HMAC-SHA256 base64 with the connected app's client secret, constant-time compare; bad signature 401 (recorded), missing secret 503 | No change |
| Dedupe / claims | Ledger key `X-Shopify-Webhook-Id`; PR #4's generic claim (`services/cx/ingress/claims.ts`) owns SHOPIFY rows (only eBay excluded): lease, retry worker, dead letters. **Gap:** a deferring handler (`InboundDeferred`) is answered **500**, so Shopify retries and may delete the subscription | A deferral is answered 200 (recorded and held) |
| Order writer (`routes/shopify-webhooks.ts`) | (a) `cancelled_at` ignored; only `voided`/`refunded` count as CANCELLED; `partially_refunded` maps to PENDING (status goes backwards). (b) `orders/updated` never rewrites lines: an edit keeps old holds. (c) No order-level lock (eBay, Amazon, Etsy have one). (d) No stale-snapshot guard; Shopify does not guarantee order. (e) An unmatched line or failed hold is only logged (R5 unmet). (f) `channelConnectionId` never set. (g) SKU match only; production has **0 Shopify listings, 0 products with `shopifyProductId`**. (h) `refunds/create` calls `findUnique({ where: { sku } })`, which Product's workspace+SKU key does not accept (expected to throw; untested); `Return` has no unique refund id. (i) An update for an unknown order falls through to *create*: without T0, an old order touched after go-live is imported, and taken again if shipped (double deduction) | One writer for webhook and poll, (a)–(i) closed |
| Missing topics | A cancelled fulfilment arrives as `fulfillments/update` (status `cancelled`; there is no `fulfillments/cancelled` topic); its units stay taken. Also `orders/edited`, `orders/cancelled` | Subscribed; handled per D2 |
| Poll | None (Shopify jobs: quantity read-back, linked automation). The gateway reads only REST rate headers; GraphQL reports cost in the body (`extensions.cost`) | Poll backstop + freshness alert |
| Location | Holds use IT-MAIN, active in the Shopify business. **0 `SHOPIFY_LOCATION` rows**: needed only for the inventory mirror and for writing quantities to Shopify (gated), not for holds | Owner confirms the shipping warehouse (§5) |
| Uninstall | `app/uninstalled` revokes the account and alerts (P2.6) | Poll skips it; one notice counts its open holds |

## 3. Slices (one PR each; every switch OFF by default)

Switches: `NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1` on API, worker and scheduler together (the Etsy lesson), and
`NEXUS_ENABLE_SHOPIFY_ORDERS_POLL_CRON=1` on the scheduler. Off: order topics are recorded, answered 200 and held;
nothing else changes. No PR registers subscriptions; that is an activation step. Tests are red first; transactional
arms on real PostgreSQL (`services/stock-model-postgres.vitest.test.ts` harness); races via
`test-support/concurrent-database.ts` (PGlite has one connection and cannot show a race). Every slice: mutation checks,
`tsc`, `scripts/check-inbound-ledger.mjs`, `scripts/check-stock-writer-lock.mjs`.

**S1: switch and T0 (small).** New `services/shopify/order-ingest.ts` on the model of `services/etsy/receipt-ingest.ts`:
the flag; T0 written once by an explicit action, never by processing. Additive migration `ShopifyOrderIngest`
(connectionId, activatedAt, cursor, lease, last poll status, backlog; `EtsyReceiptIngest`'s shape). Order handlers
defer while off; an order created before T0 (also via the update-to-create fall-through, or a refund) is recorded as
skipped and writes nothing; the receiver answers 200 to a deferral. *Tests:* off → no Order, no hold, attempt not
spent, HTTP 200; pre-T0 create/update/refund → nothing written; T0 idempotent (first writer wins). *Risk:* T0 is the
double-deduction guard; removing it must turn a test red.

**S2: one order writer (medium, largest).** Move the order logic to `services/shopify/order-writer.ts` unchanged, then
change it commit by commit: (c) order-level lock; (d) skip a snapshot older than the stored `updated_at` (fulfilments
still merged by id); (a) `cancelled_at` means CANCELLED, through the existing R4/C1 settlement, and an unknown financial
status never moves status backwards; (b) lines upserted on every update, open hold per product = units still to ship,
taken units never change (R4); (g) match by this connection's listing `variantId`, then SKU (the eBay rule);
(e) unmatched line, shortfall or missing warehouse recorded on the order, one owner notice (R5); (f) set
`channelConnectionId`; (h) refund lookup by the workspace SKU key, plus an additive unique key on
`(workspaceId, channel, channelReturnId)` (0 Shopify returns today). *Tests:* every PR #32 Shopify arm stays green
(R10, B4, C1 ×3, C5). New arms: cancel without refund; edit 3→1 before fulfilment; refund of an unshipped unit on a
partly fulfilled line; stale "paid" after "fulfilled"; concurrent create+update and webhook+poll; shortfall → recorded +
exactly 1 notice; refund mirror resolves its product. Quantity semantics (`current_quantity`, `fulfillable_quantity`)
pinned with recorded payloads.

**S3: topics, registration, reconcile (medium).** Registration takes a topic set. `ORDER_TOPICS`: ORDERS_CREATE,
ORDERS_UPDATED, ORDERS_CANCELLED, ORDERS_EDITED, FULFILLMENTS_CREATE, FULFILLMENTS_UPDATE, REFUNDS_CREATE,
APP_UNINSTALLED, APP_SCOPES_UPDATE; sends `uri`, reads `uri` and `apiVersion`. New receivers, handlers and replay
entries (`services/cx/ingress/handlers.ts`): `orders/cancelled` (full order → writer), `fulfillments/update` (record
status; a cancel after a take per D2), `orders/edited` (read the order back by GraphQL → writer). The receiver records
`X-Shopify-API-Version`. Nightly reconcile for activated accounts: re-creates a missing order topic, alerts once. Not in
the set: product topics, `inventory_levels/update`, privacy topics (each needs its own review; privacy is app-config
only). *Tests:* registration fixture (`created`/`already_ours`/`elsewhere`/`refused`, set only, `uri`); ledger gate
equal (received = registered = replayable); reconcile restores a deleted topic; version mismatch alerts.

**S4: poll backstop and freshness (medium).** `jobs/shopify-orders-poll.job.ts` + `services/shopify/orders-read.ts`,
every 10 min (`NEXUS_SHOPIFY_ORDERS_POLL_MINUTES`), leased per account. Recent path:
`orders(sortKey: UPDATED_AT, query: "updated_at:>=<cursor − 10 min> created_at:>=<T0>")`; the cursor advances only after
a page commits, lease-fenced. Convergence path (hourly): re-read every order Nexus still holds open by id
(`nodes(ids:)`), so a lost fulfilment or cancel still lands. Rate: pages kept under Shopify's 1,000-point single-query
cap; read `extensions.cost.throttleStatus`, stop early when low; THROTTLED → next run, cursor kept. No
`read_all_orders`: an open order 55+ days old sends a notice. Revoked account → SKIPPED, not stale. Stale when no run
succeeded in 2 periods → bell notice + Health line (Etsy E6). *Tests:* overlap/cursor/pagination; lost lease stops the
cursor; throttle; a GraphQL snapshot and the webhook payload of one order give the same Order and holds; revoked skip;
stale notice.

**S5: shadow report and runbook (small).** A read-only route (0 writes; `kind: 'read'` channel calls), last 30 days,
counts only: orders, lines, lines matched by variant / SKU / unmatched, orders unfulfilled now and their units,
fulfilment locations used, test orders. Runbook `docs/channel-connections/SHOPIFY-ORDERS-ACTIVATION.md`. *Test:* 0 DB
writes (spy), 0 non-read channel calls.

**Risks.** Shopify expects an answer within 5 s and retries 8 times over 4 h: handler time is measured in week 1, and if
p95 > 2 s the receiver answers after the ledger write and the claim runs in the background. A wrong SKU match holds the
wrong product and lowers its other channels, hence the S5 gate. Out-of-order delivery is covered by S2(d).

## 4. What goes live when the switches are on, and first activation

Immediately: Shopify orders from T0 appear in Nexus with lines and customer; holds at IT-MAIN lower available stock and
**the cascade lowers eBay and Amazon FBM quantities within seconds** (the point: no cross-channel oversell);
fulfilments take units; cancellations and refunds release or keep units per R4/C1 with owner notices; refunds create
Return rows (stock back only when booked in). **Nothing is written to Shopify except the subscriptions**; the publish,
ship-confirm, refund and cancel switches stay off.

Activation, one quiet hour:
1. S1–S5 merged and deployed with switches OFF; migrations applied.
2. Run S5. Gate: 0 unmatched lines (or Owner-accepted), one fulfilment location matching IT-MAIN, unfulfilled counted.
3. Set T0 for the one account (the database clock's second, never rewritten).
4. Ingest switch on for API, worker and scheduler together; poll switch on for the scheduler.
5. Register the order set; every topic `created` or `already_ours`, else stop.
6. Poll "Run now": SUCCESS, freshness `fresh`.
7. Proofs 1–5, then a daily check for 7 days.

**Rollback:** ingest switch off on all three. Deliveries are still recorded, answered 200 and processed after
re-enabling; holds already made follow their normal lifecycle; T0 never moves.

## 5. Owner actions and decisions

**Actions:** (1) Confirm Shopify orders ship from the same warehouse as eBay and Amazon FBM (IT-MAIN); if not, stop:
routing by location becomes a slice first. (2) Your word for each live step: the S5 read, T0, the switches (you set
them on Railway), the subscription creation. (3) Place one cheap order and cancel it (proof 4). (4) At T0, handle
Shopify orders still unfulfilled as you do today (S5 gives the count). (5) Name the owner of the quarterly API-version
bump. Proposal: the channel-connections lane, each Jan/Apr/Jul/Oct; registration re-runs at each bump, because
subscriptions keep the version they were created with.

**D1: history.** (A) Only orders created at or after T0 (the Etsy H1 rule). (B) Also hold orders still unfulfilled at T0
(≤ 60 days). **Recommended: A.** B double-counts any unit already adjusted by hand; S5 shows how many orders B would
cover, so this can be revisited.

**D2: a fulfilment cancelled in Shopify after Nexus took its units.** (A) Record it and tell the owner once; units stay
taken until the count is corrected. (B) Put the units back and hold them again automatically (a new stock door).
**Recommended: A.** It matches R4 ("stock comes back only through a booked-in return"), and the usual case (a
fulfilment re-done to fix tracking) is already right: the re-fulfilment takes nothing extra (the R1 cap).

## 6. Estimate

S1 1 day · S2 3 · S3 2 · S4 2.5 · S5 0.5 · review rounds about 2: **about 10–11 working days**; critical path
S1 → S2 → S4. Owner time about 1 hour over two sittings (S5 review, activation).

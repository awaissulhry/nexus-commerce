# Real-Time FBM Inventory Sync — Perfection Program (RT series)

**Date:** 2026-07-19 · **Status: PROPOSAL — AWAITING OWNER GATE** (no code changes made; this doc + read-only probes only)
**Owner directive:** "All inventories sync in real time for all FBM offers across all platforms, extremely accurate, best in class. FBA excluded — Amazon-managed."
This supersedes the 2026-07-06 decision to defer real-time (owner re-opened it explicitly).

**Invariants that never change, in any phase:**
1. **FBA quantity untouchable** — `isFbaListing` fail-closed guard, `buildAmazonListingPatch` qty-strip, `guardFbaQtyFlip` submit-boundary block, flat-file `/submit` reject, fba-flip-guard + fba-drift-detector crons. Nothing in this program weakens any of them.
2. **Per-listing writes only** — nothing ever writes `StockLevel`/`totalStock` from a listing-level save (FM Phase 1 invariant).
3. **Shared pool model** stays (per-channel allocation remains rejected).

---

## 1. Measured baseline (prod, 2026-07-19, read-only probes `_rtq-probe*.mts`)

**Latency — QUANTITY_UPDATE, last 7d** (`OutboundSyncQueue.syncedAt − createdAt`):

| Channel | rows | SUCCESS | FAILED | p50 | p90 | p99 | <40s |
|---|---|---|---|---|---|---|---|
| AMAZON | 917 | 747 | 0 | **3.9 min** | **38.8 min** | 47 min | 9/1295 total |
| EBAY | 1,116 | 502 | 483→470 | **6.0 min** | **34.4 min** | 48 min | ↑ |

- Burst congestion measured: 2026-07-18 19h UTC — **1,028 rows created in 1h, p50 26 min, max 59 min** (bulk import).
- **Order ingestion lag (Amazon, `Order.createdAt − purchaseDate`)**: p50 **11 min**, p90 28 min. The 5 most recent **FBM** orders: +5/+9/+12/+12/+16 min — all poll-bound. `amazon-sqs-poll` runs every ~30s on prod (8,575 runs/3d) **but ORDER_CHANGE isn't delivering** (subscription/queue wiring dead — FBM orders still arrive via the 15-min poll).
- eBay failures: 395 `RETRY_SCHEDULED` + 75 `MAX_RETRIES_EXCEEDED`; 308/470 later succeeded on the same listing (eventually consistent = "in sync but slow"). Poison source: **eBay item `256552369326` is ended on eBay but ACTIVE in `SharedListingMembership` (24 SKUs)** — 41 failed pushes/7d, each burst tripping the per-marketplace circuit (~10-min freezes for ALL eBay listings; the "Retry in 438s" storms).
- **Follow/Pinned distribution (FBM):** Amazon IT 185 Follow / 77 Pinned, DE 129/75, ES 69/56, FR 65/52 (≈**260 Pinned**, the legacy auto-pin artifact — never reconciled). eBay: 266 Follow / 0 Pinned. **stockBuffer = 0 everywhere** (the Buffer feature is unused).
- **Drift right now (ACTIVE FBM):** 154 Following OK, **48 drifted** (e.g. `xracing*` on Amazon IT advertising 2–3 units with pool available 0 — live oversell exposure), **75 Following with `quantity=null`** (never materialized, never pushed: IT 24 / DE 48 / ES 3), 14 Pinned diverged.
- **Ledger split-brain: 54 products with `totalStock>0` and ZERO warehouse `StockLevel` rows** (VENTRA family ×9 + xracing…) backing **86 ACTIVE Amazon listings / ~96 advertised units**. `recomputeProductTotalStock` is warehouse-ledger-only, so the first real stock movement on any of them **zeroes** totalStock; the cascade would zero their listings. Minting source: Amazon flat-file/xlsm product-create seeds `Product.totalStock` from the file qty **without ledger rows** (`flat-file.service.ts:1642` area); nothing seeds `StockLevel` (only `applyStockMovement` ever creates ledger rows).
- Queue hygiene: 2 QUANTITY_UPDATE:EBAY rows stuck **23+ days** (IN_PROGRESS/PENDING zombies — crashed mid-dispatch, never reclaimed); 75 MAX_RETRIES_EXCEEDED rows are terminal but **not dead-lettered** (`isDead=false` on the cron path) so the DLQ tab never shows them.
- Reservations: 0 open (clean). Reconcile suite alive on prod (sync-drift-detection + ebay-readback 30-min, latency-watchdog + reservation-reconcile hourly, inventory-reconcile + fba-drift-detector daily). `/api/health` **hardcodes `redis: "connected"`** (never pings).

## 2. Root causes (all verified in code at exact sites)

**Latency chain (a sale on X → qty on Y):**
- **L1 — Instant lane structurally dead.** `lib/queue.ts:43-57` builds ioredis config as `{ url: REDIS_URL, tls, … }` — **ioredis has no `url` option**; it silently dials `localhost:6379`. On Railway there is no localhost Redis → every `addJobSafely` times out (2.5s) → 30s enqueue circuit → all pushes fall to the cron. (With a `redis://` scheme the else-branch ignores REDIS_URL entirely — same outcome. Local `.env` is now `rediss://` Upstash; prod state unknown but the measured 9/1295 <40s proves the lane is dead regardless.) `ENABLE_QUEUE_WORKERS` must also be `1` for consumers (`index.ts:391`).
- **L2 — Drain is single-file.** The unconditional 60s autopilot (`sync.worker.ts:60`) processes eligible rows **sequentially** (no `take`, FIFO, 45s/item timeout), throttled by the Amazon gate at **2 req/s** (`amazon-publish-gate.service.ts:70`) → a 1,000-row burst needs ~25–35 min (measured 26).
- **L3 — Order ingestion is poll-bound.** Amazon FBM order → pool requires the 15-min `amazon-orders-sync` poll because ORDER_CHANGE→SQS isn't delivering (subscription wiring, `amazon-notifications-boot.service.ts` / SQS policy). eBay order webhook (`ebay-notification.routes.ts`) needs `EBAY_NOTIFICATION_VERIFICATION_TOKEN` + one-time `POST /api/admin/setup-ebay-notifications` — prod state unverified (zero eBay orders yet).
- **L4 — Amazon-FBM + Shopify sale cascades never use the instant lane** even when it works: hand-rolled `OutboundSyncQueue.create` with `holdUntil:+30s`, no BullMQ job (`amazon-orders.service.ts:982-998`, `shopify-webhooks.ts:469-486`; cancellations `order-cancellation/index.ts:191` +15s). Only `applyStockMovement(ORDER_PLACED…)` paths (= eBay sales, returns-restock) pair rows with instant jobs (`stock-movement.service.ts:474-498`).
- **L5 — Many row-creators are cron-only by construction** (no instant enqueue): both flat-file saves, listing-activation, bulk-action, catalog routes, dashboard resync (list in agent audit §Q6-B).
- **L6 — Circuit-breaker freezes.** One poison listing (ended item still ACTIVE membership) trips the per-`(connection, marketplace)` eBay circuit → 10-min whole-marketplace lockouts, repeatedly.

**Accuracy gaps:**
- **A1 — Membership lifecycle:** no auto-deactivation on eBay error 21916750 ("inserzione scaduta"); dispatch keeps pushing at a dead ItemID. (`syncSharedTradingQuantity` has no ended-listing handling.)
- **A2 — Ledger split-brain** (54 products / 86 listings / 96 phantom units) + minting path still open (xlsm/flat-file create writes bare totalStock; owner's new Excel-first workflow makes this the DEFAULT create path!).
- **A3 — 75 Following FBM listings `quantity=null`** — cascade never ran for them; nothing ever pushes.
- **A4 — ~260 legacy Pinned Amazon FBM listings** frozen off the pool (unpin was an open decision, never executed).
- **A5 — Dispatch-time staleness on two lanes:** Shopify (`payload.quantity` only, no re-read/no clamp, `outbound-sync.service.ts:1479`) and shared-Trading (`:1167`, qty frozen at enqueue). Amazon/eBay have re-read+clamp; these don't.
- **A6 — Cron-path terminal failures invisible:** `handleSyncFailure` (`:1572-1603`) sets MAX_RETRIES_EXCEEDED but not `isDead` → DLQ blind; backoff 2s/4s/8s is too tight for circuit-open windows (retries burn while the circuit is still open → premature terminal).
- **A7 — Zombie rows:** IN_PROGRESS crash-orphans are never reclaimed (stale-lock covers the cron mutex, not rows).
- **A8 — 25004 stale-offer self-heal exists only in the manual flat-file push** (`ebay-variation-push.service.ts:1298-1364`), not in queue dispatch.
- **A9 — xlsm workflow traps:** (i) **Export-for-Amazon writes a stale FBM qty snapshot** (`ChannelListing.quantity` at grid time — uploading later overwrites live synced values on Seller Central); (ii) **qty-import-ON pins NEW rows** (no `follow` value → legacy branch sets `followMasterQuantity:false`, `flat-file.service.ts:1284-1296`) — new listings silently stop following the pool.
- **A10 — Observability lies:** `/api/health` hardcodes redis "connected"; `outbound-latency` has no 1h window; latency-breach events are in-memory only (not persisted); `docs/INVENTORY-SYNC.md` stale in 3 places (ENABLE_QUEUE_WORKERS default, drift thresholds, sqs/inventory crons "running").

## 3. Target SLOs (best-in-class definition)

| Metric | Today (p50/p90) | Target |
|---|---|---|
| Pool change → all FBM channels updated | 4–6 min / 35–39 min | **p50 ≤ 10s, p95 ≤ 60s** |
| Amazon FBM sale known to Nexus | 11 min / 28 min | **≤ 60s** (ORDER_CHANGE via SQS) |
| eBay sale known to Nexus | (webhook if configured, else 15 min) | **≤ 30s** (Platform Notifications verified) |
| Bulk import (1,000 rows) fully pushed | ~60 min | **≤ 5 min** (workers ×5 + right rate limits) |
| Following-listing drift older than 30 min | 48 listings right now | **0** (self-healing reconcile) |
| FBA quantity writes | 0 (guarded) | **0 — invariant** |
| Terminal-failed pushes invisible to operator | 75/7d | **0** (dead-letter + surfacing + auto-heal) |

Commercial benchmark: leading multichannel tools (Linnworks/ChannelEngine/Veeqo class) advertise "near-real-time" cross-channel sync, typically minutes; sub-minute end-to-end puts Nexus at/above the commercial bar. (Research annex §7.)

## 4. Phased plan

Order chosen so accuracy substrate lands before speed (fast wrong numbers are worse than slow right ones). Each phase: implement → tests → deploy → **verify on prod with the `_rtq-*` probes** → commit+push. Live-gate flips and data repairs get explicit owner sign-off per standing rules.

### RT.0 — Truth & hygiene substrate (accuracy first, no cadence change)
1. **Ledger backfill (data repair, owner-gated dry-run→apply):** seed WAREHOUSE `StockLevel` rows from `Product.totalStock` for the 54 no-ledger products via `applyStockMovement(reason:'RECONCILIATION'-class, outerTx)` so movements/audit exist; dry-run report first (`_rtq-ledger-backfill --dry-run` lists product, totalStock, listings affected). totalStock is treated as truth (owner reconciles counts, per standing rule — no auto-zeroing, ever).
2. **Close the minting path:** Amazon flat-file/xlsm product-create seeds the ledger (movement `INITIAL_STOCK`) instead of writing bare `totalStock` (`buildProductCreateInput` callers); eBay create already writes 0.
3. **Materialize the 75 null-qty Following listings:** one bounded pass running the cascade per affected product (after #1 so pools are true) → fills `quantity` + enqueues pushes.
4. **Queue janitor** (new small job or fold into autopilot tick): reclaim IN_PROGRESS older than 30 min → PENDING(+note); cron-path terminal failures set `isDead/diedAt` + `SYNC_DEAD` (parity with BullMQ path); purge/park PENDING older than 7d; one-time cleanup of the 2 zombie rows + 75 invisible terminals.
5. **Membership lifecycle:** dispatch failure handler maps eBay "ended/not modifiable" errors (21916750 family) → `SharedListingMembership.status='ENDED'` + stop fan-out (fail-closed: only on the explicit error codes); wire `ebay-status-reconcile` cron (exists, default OFF) as the daily backstop; immediate data fix: mark item `256552369326` ENDED (owner confirm — 24 SKUs).
6. **Retry/backoff fix:** backoff 2s/4s/8s → 30s/2m/10m with jitter, and circuit-open failures **don't consume retry budget** (they're not the row's fault) — kills the premature MAX_RETRIES_EXCEEDED class.

### RT.1 — Revive the instant lane (the big latency unlock)
1. **Fix `lib/queue.ts` connection construction:** pass the URL as ioredis's first positional arg (`new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false, …tls for rediss })`), keep host/port fallback; honest `initializeQueue` ping already exists.
2. **Redis decision (owner):** recommend **Railway Redis** (private network, no command cap, ~$5/mo) over Upstash free tier (500K cmds/month — BullMQ polling can exhaust it; then it degrades back to cron silently). Either works after the fix; Railway is the durable choice.
3. **Env flips (owner does / approves):** `ENABLE_QUEUE_WORKERS=1` + `REDIS_URL` on Railway.
4. **Honest health:** `/api/health` performs a real bounded Redis ping + exposes `dispatchPath` (`immediate-bullmq` / `cron-60s-only`) so the lane is remotely verifiable forever.
5. **Verify:** canary movement → measure <10s; `_rtq-probe.mts` p50 collapses; autopilot logs show "skipped (BullMQ-owned)".

### RT.2 — Instant lane everywhere + burst throughput
1. **One `enqueueOutboundRows()` helper** (rows created + `addJobSafely` each, priority by reason, delay = holdUntil delta) adopted at every cron-only creator: amazon-orders cascade (**hold 30s→0**, it IS order-driven), shopify-webhooks (30s→0), order-cancellation (15s→0), both flat-file saves (keep 30s — deliberate coalesce window for bursty saves), stock-import (keep), listing-activation, bulk-action, catalog/dashboard routes.
2. **Amazon gate 2/s → 5/s burst 10** (SP-API listings PATCH published limit, confirmed; PATCH has a priority lane that bypasses feed queues) with jitter; BullMQ worker concurrency 5 already parallelizes across channels — 1,000-row burst ≈ 3–4 min.
3. Keep coalescing (`NEXUS_SYNC_ORDERING_V2`) — with faster drains it fires less but still guards bursts.
4. **eBay per-listing debounce (REQUIRED, not optional):** eBay caps **~250 revises per listing per calendar day** across ReviseInventoryStatus/bulkUpdatePriceQuantity/ReviseFixedPriceItem — a seconds-level engine must collapse changes per ItemID: batch up to 4 SKUs per Trading call (25 for Inventory-API `bulk_update_price_quantity`), only-push-net-change (`lastQtyPushed` check exists), and a short per-item debounce window (10–30s) so one pool event = one revise per listing.
5. (Optional, flagged) bulk-import fast path: >500 qty rows for one marketplace → single `JSON_LISTINGS_FEED` (now 25k messages/feed, 5 feeds/5min) instead of N PATCHes. Only if measured needed after 1–2.

### RT.3 — Real-time ingestion (sales known in seconds)
1. **Amazon ORDER_CHANGE end-to-end:** diagnose why SQS delivers nothing (subscription state via `amazon-notifications.routes.ts` admin surface; SQS queue policy for SP-API's SNS; `ensureAmazonNotificationSubscription` boot logs). Fix wiring; add a subscription self-check to diagnostics (subscriptionId + destination status + last-message-at). Tighten the poll loop to continuous long-poll (`WaitTimeSeconds=20`) so delivery→ingest ≤ ~25s. FBA messages stay acked-and-skipped (pool-irrelevant). 15-min orders poll stays as backstop.
2. **eBay Platform Notifications live:** set `EBAY_NOTIFICATION_VERIFICATION_TOKEN` + `EBAY_NOTIFICATION_ENDPOINT_URL` on Railway, run the one-time subscribe endpoint, verify via watchdog/diagnostics `ebayNotificationsActive:true`. Narrow the webhook handler from full-7d-resync to single-order fetch (speed under volume). **Backstop poll tightened 15 → 5 min** — eBay has NO REST order webhook in 2026; SOAP notifications are best-effort (failed deliveries are never resent, repeated failures make eBay stop sending), so the poll floor carries real weight.
3. **Shopify:** webhooks already real-time; add an hourly missed-webhook orders poll when Shopify starts transacting (deferred until then).
4. **(Phase-2 addition) `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` subscription** (EventBridge workflow): Amazon pushes an event whenever an FBM listing's quantity changes from ANY source — catches Seller Central manual edits and the owner's own .xlsm uploads instantly, feeding the drift healer instead of waiting for daily reconcile.

### RT.4 — Dispatch accuracy hardening
1. **Shared-Trading re-read:** `syncSharedTradingQuantity` recomputes pool available−buffer at dispatch (same `computeAvailableToPublish` math) instead of trusting enqueue-time payload; membership-ENDED skip (from RT.0.5).
2. **Shopify re-read + clamp:** mirror the Amazon/eBay `resolveDispatchQuantity` + `applyOversellClamp` pattern; when Shopify transacts, migrate the write to GraphQL `inventorySetQuantities` with `compareQuantity` compare-and-set (the only marketplace-native out-of-order write guard; REST `inventory_levels/set` has none and REST is legacy since 2025).
3. **Port the 25004 stale-offer self-heal** into queue `syncToEbay`.
4. **Dead-path sweep** (workaround-sweep rule): delete `channel-sync.worker` no-op push handlers, the never-started `jobs/sync.job.ts` orchestrator stack, `ebay.provider.updateStock/updatePrice` (image publish stays).

### RT.5 — Follow correctness at scale (owner-gated data ops)
1. **Unpin audit → bulk Set Follow:** report of the ~260 Pinned Amazon FBM listings (pin value vs pool, deliberate-looking vs artifact); owner selects; execute via the existing bulk follow endpoint (FBA excluded automatically). **Runs after RT.0.1** so following them is safe.
2. **Drift self-healing:** extend the 30-min `sync-drift-detection` pass: Following FBM listing whose `quantity ≠ pool−buffer` → enqueue corrective push (bounded/audited; report-only first week, then auto).
3. **Buffer strategy (owner decision):** with sub-minute sync, recommendation = buffer 0 for single-channel SKUs, **buffer 1 for SKUs live on 2+ channels with pool ≤ 3** (cheap oversell insurance exactly where races bite); bulk-settable via the existing Buffer tools. Velocity-aware buffers stay backlog (C1).

### RT.6 — Excel-first workflow integration
1. **Export-for-Amazon qty policy:** default **blank FBM qty cells** on export (sync owns quantities — symmetric with qty-import-OFF), with an explicit "include current quantities" toggle for full-snapshot exports (owner's complete-control principle).
2. **Import creates followers:** new rows created via the wizard get `follow='Follow'` semantics (no legacy pin), so Excel-created listings track the pool from birth; qty-import-ON on NEW products seeds the **ledger** (RT.0.2) rather than pinning listings.
3. **First-publish push guarantee:** after a new listing flips `isPublished`, ensure one cascade/push materializes its qty (listing-activation path verified + covered by RT.5.2 healer).

### RT.7 — Observability & proof
1. Control-Tower SLO tiles: outbound p50/p95 (add 1h window), order ingest lag per channel, dead-letter count, circuit states, `dispatchPath`, eBay/Amazon notification liveness (last-message-at).
2. Persist `sync.latency.breach` + `sync.realtime.degraded` (SyncHealthLog) — alerts must survive restarts.
3. Refresh `docs/INVENTORY-SYNC.md` (3 stale claims) + add this program's runbook; keep `_rtq-probe*.mts` as the regression battery; re-run the full baseline after each phase and append numbers here.

## 5. Owner decisions needed (the gate)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve program + phase order | RT.0 → RT.7 as above |
| D2 | Redis: Railway addon vs Upstash | **Railway Redis** (~$5/mo) |
| D3 | Env flips: `ENABLE_QUEUE_WORKERS=1`, SQS/eBay notification vars | Yes, at RT.1/RT.3 with verification each |
| D4 | Ledger backfill apply after dry-run report (54 products) | Yes — totalStock treated as truth |
| D5 | Mark eBay item 256552369326 membership ENDED | Yes (it is ended on eBay; error-proven) |
| D6 | Unpin list from RT.5.1 report | Owner picks from report |
| D7 | Buffer default (0 vs 1-on-shared-small-pool) | Buffer 1 where pool ≤3 & 2+ channels |
| D8 | Export xlsm FBM qty: blank-by-default with toggle | Blank by default |
| D9 | Enable eBay **Out-of-Stock control** (account setting): at qty 0 a GTC listing hides instead of ending (keeps history/SEO; auto-ends only after ~3 zero months) | Enable — makes zero-pushes safe |

## 6. What is explicitly OUT of scope
- Any FBA quantity write, ever (guards untouched; FBA drift detector stays).
- Per-channel stock allocation (rejected previously; unchanged).
- Auto-correcting warehouse counts (owner reconciles physical stock; system heals *listing* qty to pool, never the pool to listings).

## 7. Research annex (platform facts feeding the design — verified 2026-07-19, sources in session report)
**Amazon**
- **ORDER_CHANGE** is the current order notification (replaced ORDER_STATUS_CHANGE, 2023); fires on new orders (Pending in the payload schema, carries `FulfillmentType` MFN/AFN so FBA drops trivially); delivery "usually seconds, up to 2 min at peak" (Amazon's words); SQS **and** EventBridge destinations; at-least-once → dedupe on `NotificationId`; rare pathological delays documented → poll backstop stays mandatory. SQS grant principal: AWS account 437568002678.
- **`patchListingsItem`**: 5 req/s, burst 10 per seller; Amazon positions PATCH for "critical price/inventory updates" with a priority lane bypassing feed queues. `fulfillment_availability` can be patched alone.
- **JSON_LISTINGS_FEED**: 25,000 messages/feed, 5 feeds/5 min. **All XML/flat-file listings FEEDS are dead** (FATAL since 2025-07-31) — any legacy feed path is dead weight.
- **`LISTINGS_ITEM_MFN_QUANTITY_CHANGE`** (EventBridge family): event on every FBM qty change from any source — the Amazon-side drift alarm. `ITEM_INVENTORY_EVENT_CHANGE`: hourly aggregates for reconciliation.
- SP-API remains free (the 2026 fee program was cancelled 2026-05-12).

**eBay**
- **No REST seller-order webhook exists in 2026** — the Notification API has no order topic; SOAP-era Platform Notifications (`FixedPriceTransaction` etc. via SetNotificationPreferences) remain the only push, are best-effort (failures never resent; repeated failures → eBay stops sending to the AppId), and eBay itself instructs pairing them with periodic `getOrders` polling. Trading API is NOT deprecated (2025 killed Finding/Shopping/Merchandising only).
- **~250 revises per listing per calendar day** across ReviseInventoryStatus / ReviseFixedPriceItem / bulkUpdatePriceQuantity — the binding constraint for a seconds-level engine; forces per-listing coalescing (sustained ≈ 1 revise/listing/6 min). ReviseInventoryStatus: 4 SKUs/call, 6,000 calls/15s short-window cap; `bulk_update_price_quantity`: 25 SKUs/call (Inventory-API listings only; Trading required for ItemID-tracked/shared listings — matches our dual-lane dispatch).
- **Out-of-Stock control** (account setting): qty-0 GTC listings hide instead of ending (D9).

**Shopify**
- GraphQL-only for new work (REST legacy since 2025); **`inventorySetQuantities`** with per-row `compareQuantity` CAS (+`@idempotent` as of API 2026-04) is the correct write; 250 rows/call; rate = points bucket (Standard 100/50 → ~5 calls/s sustained). Webhooks: delivery not guaranteed — dedupe `X-Shopify-Webhook-Id`, reconcile via `updated_at` queries; 8 retries/4h then subscription deletion; Pub/Sub or EventBridge destinations recommended at scale. `orders/create` latency ~2s typical, p99 >10s (third-party measurements).

**Commercial bar**
- No commercial multichannel tool publishes a seconds-level SLA; ChannelEngine's own docs state sync "takes at least 10–15 minutes" (stock import hourly by default). Linnworks/Veeqo/Sellercloud claim non-numeric "real-time." **A working p50 ≤10s engine beats the commercial class outright.**
- Industry accuracy patterns confirmed as standard: per-channel buffers, reserve-on-ingest (sellable = physical − open orders), kill-switch at 0, at-least-once dedupe keys, `LastUpdatedAfter`-style reconciliation sweeps — Nexus already implements reserve-on-ingest + buffers + clamps; this program completes the set (dedupe anchors, CAS on Shopify, drift alarms).

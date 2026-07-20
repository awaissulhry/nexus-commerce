# Shared Pool → Amazon FBM Inventory Sync — Full-System Study

**Date:** 2026-07-20 (~03:00 UTC) · **Status: STUDY — read-only, no code changed. Proposal at §6 AWAITING OWNER GATE.**
**Owner ask:** understand everything that exists, study how the shared pool syncs to Amazon (FBM only), and define the path to "extremely accurate, no chance of error." FBA quantities remain untouchable throughout.
**Method:** 4 parallel code-architecture sweeps (pool model · Amazon lane · ingestion+eBay lane · crons/observability), 3 read-only prod-DB probes (`_sync-study-live.mts`, `_sync-study-anomalies.mts`, `_sync-study-final.mts`), prod `/api/health`, plus the RT program docs (`2026-07-19-realtime-fbm-sync-perfection.md`, `INVENTORY-SYNC.md`).

---

## 0. Executive summary

1. **The engine is built, complete, and internally correct.** The RT.0–RT.7 program (2026-07-19/20) plus the overnight P0/P0b/P0c fixes delivered a real-time architecture that is genuinely best-in-class on paper AND in the database: of 417 published Amazon Following-FBM listings, **415 match the pool exactly, 0 drift, 2 nulls** (both are the known GALE listings the fail-closed FBA guard correctly refuses). The instant lane dispatches ≈2s after grace; order cascades are 0-hold.

2. **Exactly one thing separates today from "Amazon in sync": the SP-API listings-WRITE authorization is still returning HTTP 403** (`Access to requested resource is denied`) on every real attempt, as of 03:00 UTC. The overnight "successes" (1,751 in 6h) were **false greens from before the P0b honesty fix deployed (~01:45 UTC)** — the hourly histogram flips from `ok=539/fail=4` (01h) to `ok=0/fail=6` (02h onward) at exactly the deploy boundary. The token in Railway still lacks the **Product Listing** role. **540 quantity rows are parked** (budget-free circuit deferrals) and auto-deliver the moment auth works; the read-back heal re-drives the rest. §4 has the exact owner runbook.

3. **The new closed loop works.** `amazon-qty-readback` ran its first live pass at 02:38: compared 545 listings across IT/DE/ES (FR report empty), found **172 listings where Amazon's actual quantity differs from intended**, logged them, and enqueued 100 corrective pushes (its cap). That is the true current damage on Amazon — it self-heals once auth is fixed.

4. **The FBA invariant held under fire.** 137 queue rows for FBA-signal SKUs in 2h produced **zero** Amazon attempts — the dispatch guard skipped every one. (The `fba-flip-guard` "ALERT: 13 FBA quantity pushes" is a false alarm: it reads queue-row status, which marks guard-skips as SUCCESS; the attempts audit proves nothing was sent. Finding L, §5.)

5. **Two silent breakages found on the eBay side** (the lane everyone believes "works" — outbound does; these are ingestion/verification):
   - **The eBay orders poll has failed 100% of runs for 7+ days** (every day: 0 ok). Root cause found in code: both `syncEbayOrders` and `syncEbayOrdersInRange` pass the connection **object** to `getValidToken(connectionId: string)` — the inner Prisma lookup throws before any HTTP call (hidden from tsc by an `(prisma as any)` cast). With webhooks not yet configured (owner still owes the env), **an eBay sale today would never decrement the pool.** Zero eBay orders so far is the only reason nothing broke.
   - **The 30-min eBay quantity read-back is structurally blind**: it GETs Inventory-API items per SKU, but all current eBay inventory is Trading-lane (31 ItemIDs / 711 memberships) → `checked=129 recorded=0 errors=129` every run.

6. **The deepest architectural risk is silent failure, and it is systemic.** The brand-new P0c auth tripwire is **dead code in the production configuration** — it's nested inside `if (!immediate)`, so it only runs when the instant lane is already degraded (confirmed live: 14 auth failures in 3h, zero `CHANNEL_AUTH_FAILURE` rows). Even if it fired, `SyncHealthLog` has **no UI reader anywhere**, tripwire events are ephemeral in-browser SSE, there is no email/push channel, and the 60s autopilot itself writes no CronRun row. The 403 era lasted weeks precisely because of this class. §6 AS.1/AS.2 is the cure.

**Verdict:** don't rebuild anything — the sync design is right (pool authority → cascade → queue → guarded dispatch → independent read-back). What remains is: (a) the owner's auth-role fix, (b) making silent failure impossible, (c) repairing the two broken eBay loops, (d) a short list of structural hardenings. That is the AS program (§6).

---

## 1. Goal and standing invariants

Owner directives in force:
- All **FBM** listings follow the shared pool in real time, across Amazon (IT/DE/FR/ES), eBay (IT/DE), Shopify (connected, not transacting). Extremely accurate; best in class.
- **FBA quantity untouchable** — Amazon manages it. The guard stack (all verified present and exercised live today): `isFbaListing` fail-closed (`outbound-sync.service.ts:311`), `buildAmazonListingPatch` qty-strip (`:254`), `guardFbaQtyFlip` submit-boundary hard block (`amazon-sp-api.client.ts:487`), flat-file `/submit` reject, `fba-flip-guard` (10-min) + `fba-drift-detector` (daily) crons with auto-restore.
- **Pool is the authority**; listing-level saves never write `StockLevel`/`totalStock`. Uncounted products (empty ledger) are never zeroed and never invent stock.
- **Shared pool, no per-channel allocation** (rejected; unchanged). Per-listing `stockBuffer` exists (currently 0 everywhere — no multi-channel product has a small pool today; re-check via `_rt5-buffers.mts` when that changes).

---

## 2. The system as built (architecture map)

### 2.1 The pool
- **Ledger:** `StockLevel` per (location × product): `quantity`, `reserved`, `available = quantity − reserved` (DB CHECK). Locations typed `WAREHOUSE` (the merchant/FBM pool) vs `AMAZON_FBA` (mirror only, excluded).
- **`Product.totalStock`** = cached `SUM(StockLevel.quantity)` over WAREHOUSE only (`recomputeProductTotalStock`, `stock-movement.service.ts:191`). Derived, never source of truth.
- **Published quantity math** (`available-to-publish.service.ts:140`): `available = max(0, warehouseAvailable − stockBuffer)` for FBM (reservations already inside `available`); FBA reads Amazon's sellable and is never pushed.
- **Single write entrypoint:** `applyStockMovement` (`stock-movement.service.ts:252`) — ledger row → totalStock recompute → audit `StockMovement` → in-tx cascade → post-commit instant enqueue + read-cache refresh. ~30 call sites (orders, returns, stock page, imports, inbound, transfers, webhooks) — all inventoried, all route through it. `recascadeProduct` (`:874`) re-runs the cascade without a movement, refusing uncounted pools (`NO_LEDGER`).
- **Uncounted guard (P0, `3335d0730`):** empty WAREHOUSE ledger = UNCOUNTED, not zero — positive live quantities are snapshot-skipped, shared fan-out skipped; counted-to-zero still cascades honestly.

### 2.2 The cascade (`cascadeQuantityToListings`, `stock-movement.service.ts:602`)
Per listing: resolve fulfillment (`resolveListingFulfillmentMethod:41`) → write `quantity = pool available − buffer` **only if** Following + FBM + counted; FBA/Pinned get `masterQuantity` snapshot only. On change: `version++`, `lastSyncStatus=PENDING`, one `OutboundSyncQueue` row (`QUANTITY_UPDATE`, `holdUntil` = **0 for order-driven** reasons / +30s otherwise). Superseded PENDING rows for the same listings are **coalesced → CANCELLED** (`sync-coalesce.ts`, `NEXUS_SYNC_ORDERING_V2`). Shared-eBay fan-out builds **one row per ItemID** with `payload.updates[]` (`ebay-shared-fanout.service.ts:64`), no-op SKUs dropped against `lastQtyPushed`.

### 2.3 Dispatch
- **Instant lane:** post-commit `enqueueOutboundRowsInstant`/`fireOutboundJobs` (`outbound-enqueue.ts`) → BullMQ (`jobId = row.id` dedupe, delay honors each row's holdUntil), worker concurrency 5. Live on Railway Redis; measured ≈2s after hold. `addJobSafely` never throws (2.5s timeout → 30s enqueue-circuit → row rides the cron).
- **Backstop:** unconditional 60s autopilot (`sync.worker.ts:60`) drains PENDING past holdUntil, skipping rows with live BullMQ jobs.
- **Amazon execution (`syncToAmazon`, `outbound-sync.service.ts:810`):** re-read current listing qty at dispatch (`resolveDispatchQuantity:362`) → FBA guard (fail-closed, drops qty) → oversell clamp to warehouse available−buffer (`applyOversellClamp:375`, emits `sync.oversell.clamped`) → patch `fulfillment_availability:[{fulfillment_channel_code:"DEFAULT", quantity}]` → publish gate → per-(seller,marketplace) circuit (3 fails/5min → open 10min) → token bucket 5/s burst 10 → `submitListingPayload` `PATCH /listings/2021-08-01/items/{seller}/{sku}?marketplaceIds=…&issueLocale=en_US` with honest error parsing (non-OK → parsed `errors[]`; ERROR-severity `issues[]` → failure) and the `guardFbaQtyFlip` hard block. LWA token cached 50 min in-process.
- **Failure dispositions (`computeFailureDisposition:106`):** circuit-open/rate-limit/debounce → **deferral, no retry budget** (`CIRCUIT_OPEN_DEFERRED`, retry ~5min); retryable → 30s/2m/10m + jitter; terminal → dead-letter (`isDead`, `SYNC_DEAD`). Janitor (15-min) reclaims crashed IN_PROGRESS, expires stale PENDING, dead-letters invisibles.

### 2.4 Ingestion (how the pool learns of sales)
- **Amazon:** SQS continuous long-poll (~55s/min coverage; delivered notification → ingest ≈1s; `WebhookEvent` dedupe on messageId). 7 subscription types live (destination rebuilt 2026-07-20; `ORDER_CHANGE` + `ORDER_STATUS_CHANGE` both normalized). AFN (FBA) orders acked+skipped. MFN order → `reserveOpenOrder` → **`recascadeProduct(ORDER_PLACED)` 0-hold priority-1**. Fallback: 15-min orders poll (running). **Delivery still unproven — every tick reads "no messages"; first organic order is the proof point** (if silent after several orders → EventBridge route).
- **eBay:** NO reliable push exists (2026); the **5-min poll IS the floor** → `applyStockMovement(ORDER_PLACED, −qty)`. Webhook handlers exist for legacy sale topics + `order.created` (30-min ranged sync) but need `EBAY_NOTIFICATION_VERIFICATION_TOKEN` + endpoint + one-time subscribe (owner still owes). **Both poll and webhook order paths are currently broken — Finding D, §5.**
- **Shopify:** `orders/create` webhook fully wired (reserve → recascade 0-hold); hourly missed-webhook poll deferred until it transacts.

### 2.5 Verification loops (the closed loop)
- **`amazon-qty-readback`** (P0c; daily 04:15 UTC + boot directive): `GET_MERCHANT_LISTINGS_ALL_DATA` per IT/DE/FR/ES → diff Amazon actual vs intended for published Following FBM (FBA excluded both sides) → `SyncHealthLog CHANNEL_QTY_READBACK` (24h dedupe) + bounded corrective pushes (cap 100).
- **`sync-drift-detection`** (30-min): DB-side drift (listing vs pool) → recascade self-heal (cap 25).
- **eBay:** `ebay-item-status-reconcile` daily GetItem status → memberships ENDED; dispatch-time ended-listing auto-heal (21916750); 25004 stale-offer self-heal; **quantity read-back blind (Finding F)**.
- **FBA:** `fba-flip-guard` 10-min (queue-based — false-alarm prone, Finding L) + `fba-drift-detector` daily (report-based, reliable).
- **`latency-watchdog`** hourly: p95 vs 60s → `LATENCY_BREACH`; P0c publish-health tripwires **(dead code in prod config — Finding B)**.

### 2.6 Why eBay outbound works (contrast)
Correct locale headers; per-ItemID batching ≤4 SKUs/Trading-call; dispatch-time pool re-read with no-op drop (a fully-no-op row spends NO revise — the ~250 revises/listing/day budget is the binding constraint); 15s per-item debounce; validation-vs-transient failure split so one bad listing can't freeze the marketplace circuit; per-chunk `lastQtyPushed` writeback. The Amazon lane now has re-read + clamp + honest errors; it lacks lifecycle reconcile and had no read-back until P0c (and no real-time drift push — Finding W).

---

## 3. Live prod state (probes, 2026-07-20 ~02:40–03:05 UTC)

### 3.1 The decisive timeline — Amazon publish attempts per hour (success/fail)
| Hour (UTC) | ok | fail | Reading |
|---|---|---|---|
| 07-19 19h–01h | 391 / 555 / 2 / 14 / 1,061 / 29 / 539 | 0…4 | **False-green era** — pre-P0b client reported HTTP failures as success |
| 07-20 01h | 539 | 4 | P0b (honest errors) deploys ~01:45 |
| 07-20 02h→10h (CEST clock) | **0** | ~6/h | **Honest era** — every real attempt = `HTTP 403 — Unauthorized: Access to requested resource is denied.` (~6/h = circuit half-open probes; the rest defer budget-free) |

Reads work (orders, reports, notifications) — writes 403 ⇒ the token lacks the **Product Listing** role. Last "success" 01:21:30 was a false green. **No Amazon listings write has verifiably succeeded since the token re-auth era began** — June's pushes applied, so the role existed then and was lost in a re-auth (Solution Provider Portal migration forces role re-selection; the role tick must be SAVED on the app before authorizing).

### 3.2 Queue: 540 rows parked as `FAILED/CIRCUIT_OPEN_DEFERRED` (isDead=false, budget-free — auto-deliver on auth fix); 812 dead-lettered in 24h (403s burned retry budget pre-deferral — re-drivable via Control Tower "Retry failed" / readback heal). 1 IN_PROGRESS. Oldest open row 2026-07-02 (1 stray).

### 3.3 Read-back first pass (02:38): `compared=545 mismatches=172 logged=74 healEnqueued=100 [IT:227cmp/60diff DE:194cmp/49diff FR:empty ES:124cmp/63diff]`. Samples: GALE_JACKET_YELLOW_XXL_FBM ES — Amazon 23 vs intended 33; …M_FBM ES — 16 vs 23. This is the visible Amazon-side damage; it self-heals post-auth-fix (heal pushes currently 403-parked too).

### 3.4 DB-internal accuracy (the engine itself): Amazon Following-FBM published 417 → **415 exact match, 0 drift, 2 null** (GALE listing-FBM/product-FBA conflicts, guard-refused = correct). eBay Following published 265 → 234 match, 0 drift, 31 null (Trading-lane rows whose truth lives in `SharedListingMembership.lastQtyPushed`, not `ChannelListing.quantity`). **The cascade/fan-out engine has zero internal drift.**

### 3.5 FBA invariant: 137 FBA-signal queue rows (MISANO / GALE / Amazon-native SKUs, from the takeover/resync waves) → **0 `ChannelPublishAttempt` rows** for those SKUs in 2h. Nothing sent. `fba-flip-guard` alert = queue-status false positive; its auto-restore fired (safe — re-asserts AMAZON_EU, skips no-FBA-stock SKUs) but is churn.

### 3.6 Notifications: `amazon-sqs-poll` continuous ticks all "no messages" — zero deliveries ever on the rebuilt destination. No organic order has occurred overnight, so still unproven, not yet alarming. **Standing watchpoint:** first organic order must show `messages=N`.

### 3.7 eBay orders poll: **0 ok / 54–125 failed per day, every day for the 7-day retention window.** Zero `OutboundApiCallLog` rows for `getOrders` ⇒ failure precedes HTTP ⇒ `getValidToken(connection)` (object passed where `connectionId: string` expected; `ebay-orders.service.ts:605` + `:690`; hidden by `(prisma as any)`). eBay orders sync has plausibly **never** worked since the cron was enabled. (Separate: `ebay-financial-sync` 403 errorId 215001 = missing finances scope — unrelated to inventory but same "re-auth with all scopes" family.)

### 3.8 eBay readback: `checked=129 recorded=0 errors=129` every 30 min (Inventory-API GET per SKU vs Trading-lane-only topology: 31 active ItemIDs, 711 ACTIVE / 68 ENDED memberships).

### 3.9 `/api/health`: `build b770f48d` (P0c live), `amazonPublish ENABLED`, `dispatchPath immediate-bullmq`, redis connected (real ping). `LATENCY_BREACH` rows show 24h p95 36–59 min — inflated by the parked wave; expect recovery within 24h of auth fix.

---

## 4. The single blocker — exact owner runbook (P0-A)

Amazon snapshots **roles into the refresh token at authorization time**. The sequence matters:

1. **Solution Provider Portal → the app (`amzn1.sp.solution.*`) → edit roles → tick “Product Listing” (and Inventory) → SAVE the app.** (Ticking without saving, or authorizing before saving, mints another role-less token — this is what happened on the first attempt.)
2. **Seller Central → re-authorize the app** → copy the NEW refresh token.
3. **Railway → set `AMAZON_REFRESH_TOKEN`** (client also reads `AMAZON_LWA_CLIENT_ID/SECRET`; seller `AMAZON_SELLER_ID`) → redeploy/restart. Note: the LWA access token is cached ~50 min in-process — a restart clears it immediately.
4. **Verify (10 min later):** `npx tsx apps/api/scripts/_p0b-attempts.mts` → expect `live/success` rows with real quantities and no 403s. Then watch the parked wave drain (540 deferrals re-fire ≤5 min after the circuit closes).
5. **Confirm on Amazon:** trigger the read-back on demand (insert CronRun directive `amazon-qty-readback-request` RUNNING + restart, or wait for 04:15 UTC) → expect `mismatches` to collapse toward 0 within a day. Seller Central Manage Inventory is the human check.

Nothing else is required — no re-runs, no data repair. The queue design already parked everything safely.

---

## 5. Gap analysis — ranked findings (the "no chance of error" audit)

**Solid and verified (no action):** single pool entrypoint + audit ledger; uncounted guard; coalescing; dispatch re-read; oversell clamp; 3-layer FBA stack (proven under live fire §3.5); BullMQ jobId dedupe + janitor; per-ItemID batching/debounce/budget defense; ended-listing heal; honest `/api/health`; order-driven 0-hold cascades; idempotent order ingest.

| # | Sev | Finding | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| A | **P0** | Amazon listings-write 403 — token lacks Product Listing role | §3.1; every attempt since 01:48 | No push reaches Amazon; 172 listings stale there | Owner runbook §4 (no code) |
| B | **P1** | **P0c auth/failure-rate tripwires are dead code in prod config** — nested inside `if (!immediate)` | `latency-watchdog.job.ts:119→124-175`; live-confirmed: 14×403 in 3h, 0 `CHANNEL_AUTH_FAILURE` rows | The silent-credential class stays silent exactly when the system is healthy-looking | Un-nest: run tripwires unconditionally each tick |
| C | **P1** | 403/auth failures classified retryable → burn 3-try budget → generic `MAX_RETRIES_EXCEEDED` dead-letters | `computeFailureDisposition` has no auth class; 812 dead-lettered/24h | Auth outages present as noise, not as "channel down"; rows need manual re-drive | New disposition: auth-class → budget-free deferral (like circuit) + distinct `AUTH_REQUIRED` errorCode + tripwire |
| D | **P1** | **eBay order ingestion 100% broken** — connection object passed to `getValidToken(connectionId: string)` (poll + webhook range path) | `ebay-orders.service.ts:605,690`; §3.7 | An eBay sale would never decrement the pool → cross-channel oversell; masked only by zero eBay orders to date | One-line fix (`connection.id`) + type the cast + regression test + prove a green run |
| E | **P1** | Alerting cannot reach the operator: `SyncHealthLog` has **no UI reader**; tripwire/reconcile events are ephemeral in-process SSE (5-min replay); no email/push anywhere; 60s autopilot + dlq-monitor write no CronRun | observability sweep §(D)1-5,10 | Any future silent failure repeats the 403 pattern: discovered via zeroed inventory, not alerts | AS.2: durable health surface + notification channel |
| F | **P1** | eBay qty read-back blind for Trading-lane listings (`errors=129` every run, `recorded=0`) | §3.8; `ebay-inventory-readback.service.ts` GETs Inventory-API per SKU | No independent eBay qty verification at all; noisy cron masks real errors | GetItem-based readback per ItemID (variations carry per-SKU qty) or scope the Inventory-API sweep to non-shared listings only |
| G | P2 | Read-back scope: 4 markets hardcoded, **pinned listings excluded**, daily-only | `amazon-qty-readback.job.ts:28,102-113` | Pinned FBM and any future market never verified; ≤24h blind window | Compare pinned vs pin value; markets from config; optional 2×/day |
| H | P2 | Dispatch double-run race: PENDING→IN_PROGRESS via plain update (no CAS); cron-vs-BullMQ skip is TOCTOU and fails open on Redis timeout | `outbound-sync.service.ts:613,670`; `sync.worker.ts:24-38` | Duplicate SP-API/Trading writes (converge via re-read, but waste budget + duplicate audits) | `updateMany({where:{id, syncStatus:'PENDING'}})` claim; skip-on-0 |
| I | P2 | 45s `withTimeout` doesn't cancel the in-flight HTTP; late success still records | `:615,676` | Row FAILED while Amazon applied it; audit/queue diverge; redundant retry | AbortController; reconcile late outcome |
| J | P2 | `AMAZON_PUBLISH_MODE=sandbox` PATCHes the **production** host (only create-path swaps hosts) while marking rows dry-run/SKIPPED | `amazon-sp-api.client.ts:563-590` | Live write masquerading as no-op if that mode is ever set | Sandbox host swap or reject the mode on this path |
| K | P2 | Per-process state: publish circuit + 5/s bucket + eBay revise-day counter are in-memory | `amazon-publish-gate.service.ts:24,74-78`; `outbound-sync.service.ts:54` | Restart amnesia; wrong if ever >1 instance | Document single-instance assumption now; Redis-back when scaling |
| L | P2 | Cascade-vs-dispatch FBA classifier disagreement: cascade uses `resolveListingFulfillmentMethod` (listing-explicit FBM wins), dispatch uses fail-closed `isFbaListing` → rows created then guard-skipped; `fba-flip-guard` reads queue SUCCESS ⇒ **false CRITICAL alerts every 10 min** + pointless auto-restores | §3.5; `fba-flip-guard.job.ts:35-51` | Alarm fatigue on the most important alert in the system | Guard verifies via `ChannelPublishAttempt`; align cascade skip with `isFbaListing`; fix the 2 GALE listing rows' method |
| M | P2 | Order cascades + shared fan-out are fire-and-forget (`void`, tx-suppressed errors) | `amazon-orders.service.ts:965`; `stock-movement.service.ts:796-801` | A cascade throw = silent stale listings until 30-min self-heal | Acceptable with drift self-heal ON; add failure counters to CronRun/log-metric |
| N | P2 | Manual-hold reservations (`reserveStock` via stock routes) change `available` but never recascade | `stock-level.service.ts:68-144`; `stock.routes.ts:3669` | Listing over-advertises until next movement/30-min heal | Recascade after reservation mutations |
| O | P2 | `stock-import` batched engine re-implements the cascade **without the uncounted guard**; `listing-activation` computes qty with no uncounted guard either | `stock-import.service.ts:1023-1133`; `listing-activation-sync.service.ts:56` | Edge-case zero-push over live qty from those two paths | Port `ledgerUncounted` skip to both |
| P | P2 | Direct `totalStock` writers bypass ledger+cascade: Etsy/Woo inbound webhooks, `product-sync.service`, legacy variant rollups | pool sweep §(D)1 (6 sites) | Dormant channels today, but any activation re-mints ledger split-brain (the A2 class) | Route through `applyStockMovement` or hard-disable |
| Q | P2 | `quantityOverride` vs `quantity` column hazard persists for any new writer | `follow-master.service.ts:12-18` | A one-column writer desyncs push paths | Lint/test convention; document in runbook |
| R | P3 | `SyncHealthLog` unbounded (retention job excludes it); readback logged=74 vs mismatches=172 (24h dedupe hides recurrence counts) | `observability-retention.job.ts:16` | Table growth; underreported recurrence | Add retention + occurrence counter |
| S | P3 | Directive rows (`amazon-qty-readback-request`, recycle) require hand-inserted DB rows | grep: no creator route | Tribal-knowledge ops | Small admin endpoint/script |
| T | P3 | Docs/routes still advertise 8 notification types incl. SQS-invalid `LISTINGS_ITEM_STATUS_CHANGE`; parser handles undeliverable type | `amazon-notifications.routes.ts:194-203` | Confusing ops surface | Align to the 7-type canonical list |
| U | P3 | `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` (Amazon-side FBM qty-change push, EventBridge-only) not adopted | boot service comment `:166` | Seller-Central/manual edits invisible until daily read-back | Adopt post-AS.2 if the blind window matters |
| V | P3 | FR read-back returned an empty report (no FR merchant listings?) — unconfirmed | §3.3 | FR coverage unknown | Confirm FR listing state once auth is fixed |

---

## 6. Proposed hardening program — **AS series** (Amazon Sync; awaiting gate)

Order: truth first, then loops, then structure. Every phase: tests → deploy → prod-verify with the probe battery → commit+push. No FBA guard is ever weakened; no code touches `StockLevel`/`totalStock` from listing paths.

- **AS.0 — Auth fix (owner, no code).** §4 runbook. Success = live/success attempts + parked wave drained + readback mismatches → ~0. *Everything else is worth little until this lands.*
- **AS.1 — Kill the silent-failure class (small diff, highest value).** Un-nest the watchdog tripwires (B); add auth-class failure disposition — budget-free park + `AUTH_REQUIRED` code + immediate tripwire row & SSE (C); `fba-flip-guard` verifies via attempts before alerting, restores only on confirmed sends (L); CronRun rows for autopilot + dlq-monitor (E-partial).
- **AS.2 — Alerts an operator actually sees.** The deferred Control-Tower SLO/health tiles + a `SyncHealthLog` reader surface (unresolved conflicts by type, auth/channel-down banners from DB not SSE) + one out-of-app channel (email digest on CRITICAL classes: CHANNEL_AUTH_FAILURE, PUBLISH_FAILURE_RATE, flip-guard-confirmed, readback mismatches > threshold, ingestion-cron failing > N runs). Retention for SyncHealthLog (R).
- **AS.3 — eBay ingestion repair + proof.** Fix `getValidToken(connection.id)` both sites + type the service returns (D); prove a green poll run; then owner sets the notification env + one-time subscribe (still owed from RT.3); add "orders-poll failing streak" to the AS.2 alert set so this can never silently rot again.
- **AS.4 — Close the remaining verification blind spots.** eBay Trading-lane qty read-back via GetItem per ItemID (F) or explicitly retire the Inventory-API sweep for shared listings (stop the 129-error noise either way); Amazon read-back covers pinned listings + config-driven markets (G); confirm FR (V); optional second daily readback pass.
- **AS.5 — Structural hardening.** Atomic dispatch claim (H); AbortController on dispatch timeout (I); sandbox host fix (J); uncounted-guard parity in stock-import + listing-activation (O); recascade after manual reservations (N); align cascade FBA skip with `isFbaListing` + repair the 2 GALE rows (L-root); route/disable the 6 pool-bypass writers (P); document single-instance circuit assumption (K).
- **AS.6 — Optional excellence.** `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` via EventBridge for instant Amazon-side drift (U); directive-row admin endpoint (S); docs alignment (T); notification-type cleanup.

**What "no chance of error" means once AS.0–AS.5 land:** every quantity that leaves Nexus is re-derived from the pool at send time, clamped, FBA-triple-guarded, delivered with honest error semantics, independently verified against Amazon's own report within 24h (with self-heal), and any failure class — auth, rate, validation, delivery, ingestion — reaches a durable alert surface within one hour. The residual risk is reduced to marketplace-side processing lag, which the read-back closes daily and the parked-queue design absorbs safely.

---

## 7. Direct answers to the owner's questions

- **"Why does eBay work but Amazon doesn't?"** The engine is symmetric and healthy on both. Amazon delivery is blocked by one external fact — the app authorization lost the Product Listing (write) role during a re-auth, and until last night the client's error handling hid every failure as success. eBay outbound never depended on that token. (Caveat discovered by this study: eBay **ingestion** — the orders poll — has been silently failing too; it just hasn't mattered yet because eBay hasn't had an order.)
- **"Is the shared pool accurate?"** Yes. Internally: 415/417 Amazon listings match the pool to the unit, zero drift; eBay's Trading lane converges via `lastQtyPushed` with no-op protection. Amazon's own site currently shows 172 stale quantities — that is delivery, not pool math, and it self-heals after AS.0.
- **"Can it be perfect?"** The write path is already defense-in-depth. What was missing — and what this study found live, twice — is that failures could be *invisible*. AS.1/AS.2 make silence impossible; AS.3/AS.4 close the last unverified loops. That combination is the honest definition of "no chance of error."

---

## 8. Appendix

- **Probes (read-only, re-runnable):** `apps/api/scripts/_sync-study-live.mts` (attempt/queue/cron/health snapshot), `_sync-study-anomalies.mts` (FBA-signal vs attempts, real failures, health-log samples), `_sync-study-final.mts` (histograms, backlog, drift, eBay topology). Plus the RT battery `_rtq-probe*.mts`, `_rt1-latency-check.mts`, `_p0b-attempts.mts`.
- **Key env gates** (all default ON unless noted): `NEXUS_ENABLE_AMAZON_PUBLISH` (master, ENABLED), `ENABLE_QUEUE_WORKERS=1`+`REDIS_URL` (instant lane, live), `NEXUS_SYNC_ORDERING_V2`, `NEXUS_OVERSELL_CLAMP`, `NEXUS_QTY_READBACK` (+`_HEAL_MAX=100`), `NEXUS_DRIFT_SELF_HEAL` (+`_HEAL_MAX=25`), `NEXUS_QUEUE_JANITOR`, `NEXUS_EBAY_ITEM_RECONCILE`, `NEXUS_ENABLE_AMAZON_SQS_POLL=1`+`AMAZON_SQS_QUEUE_URL`, `NEXUS_ENABLE_EBAY_ORDERS_CRON=1`, `NEXUS_ENABLE_AMAZON_ORDERS_CRON=1`, `NEXUS_LATENCY_WATCHDOG` (+`_P95_BREACH_MS=60000`).
- **Companion docs:** `docs/INVENTORY-SYNC.md` (operator runbook), `docs/superpowers/plans/2026-07-19-realtime-fbm-sync-perfection.md` (RT program + research annex: SP-API rates, eBay revise caps, notification semantics).

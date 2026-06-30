# Real-Time Inventory Sync — Hardening Program (Design Spec)

**Date:** 2026-06-30
**Branch:** `worktree-inventory-col`
**Status:** Approved roadmap shape; per-phase plans pending
**Owner:** Awais + Claude

---

## 1. Goal

Make cross-channel, cross-marketplace real-time inventory sync **provably correct and best-in-class**: when stock changes on any channel (or in our warehouse), the right available quantity reaches every other live channel quickly, no channel ever oversells, and any drift is visible and self-correcting. Today the system is sound in the common case but has specific correctness, latency, reconciliation, and observability gaps. This program closes them in priority order.

## 2. Scope & non-goals

**Live channels (drive priority):** Amazon (FBA + FBM, EU markets) and eBay are transacting in production today. Shopify is connected but **not yet transacting** — Shopify work is built on the same channel-agnostic paths but sequenced *behind* eBay.

**In scope:** outbound quantity push correctness/latency, inbound order-driven decrement + cross-channel re-sync, reservation lifecycle, oversell guards, reconciliation/drift backstops, and the operator control-tower UX.

**Non-goals:** pricing/repricing logic (separate PH-series), listing content sync, WooCommerce/Etsy (out of channel scope), order financial reconciliation (DA-RT, done). We touch FBA only to *preserve* the existing fail-closed guard — we do not change FBA quantity ownership.

## 3. Current architecture (as-built, for reference)

**Source of truth:** our DB for FBM / eBay / Shopify; **Amazon is the source of truth for FBA quantities.**

```
Stock change (order / edit / return / drift)
  └─ applyStockMovement()                          [stock-movement.service.ts]
       ├─ StockLevel (quantity / reserved / available) + StockMovement audit
       ├─ recompute Product.totalStock              (WAREHOUSE locations only; FBA excluded)
       ├─ cascadeQuantityToListings()               → ChannelListing.quantity + OutboundSyncQueue rows
       └─ post-commit: enqueue BullMQ jobs           (ORDER-driven delay 0; manual edit 30s grace)
  Consumers:
    • BullMQ worker (immediate, concurrency 5)       [bullmq-sync.worker.ts]  — only if ENABLE_QUEUE_WORKERS=1
    • sync.worker cron (every 60s)                   [sync.worker.ts]         — backstop / sole consumer if BullMQ off
  Push (each behind rate-limit + circuit-breaker gates):
    • Amazon  Listings PATCH, FBA-skip fail-closed   [outbound-sync.service.ts + amazon-sp-api.client.ts]
    • eBay    Inventory API / Trading API revise      [outbound-sync.service.ts]
    • Shopify inventory_levels/set                    [outbound-sync.service.ts]
Inbound:
    • Amazon  SQS poll ~30s (FBM orders + FBA qty changes)        [amazon-sqs-poll.job.ts]
    • eBay    Platform Notifications webhook (order.created→sync,  [ebay-notification.routes.ts]
              order.cancelled→restock, ItemRevised→drift) + 15-min poll backstop (default-OFF)
    • Shopify webhooks (orders/create, inventory_levels/update)   [shopify-webhooks.ts]
Safety/backstops:
    • fba-flip-guard (10m, auto-restore) · fba-drift-detector (daily) · sync-drift-detection (30m, alert)
    • channel-stock-event auto-apply ≤1u · reservation-sweep (5m, PENDING_ORDER only) · pool-drift (alert)
```

**Key data model:** `StockLevel` (quantity/reserved/available) per `StockLocation` (WAREHOUSE | AMAZON_FBA | CHANNEL_RESERVED); `StockReservation` (HARD/SOFT, OPEN_ORDER/PENDING_ORDER); `StockMovement` (append-only audit, `balanceAfter`); `ChannelListing` (per channel×marketplace; `quantity`, `stockBuffer`, `fulfillmentMethod`, `followMasterQuantity`, `version` for CAS); `ChannelStockEvent` (inbound drift); `FbaInventoryDetail` (per-FC SELLABLE/etc.). ATP via `atp-channel.service.ts`; available-to-publish via `available-to-publish.service.ts`.

## 4. What's solid (preserve, do not regress)

- Single transactional mutation path with full audit (`StockMovement.balanceAfter`).
- **FBA fail-closed guard** (`isFbaListing` + hard block in SP-API client + 10-min flip-guard + auto-restore) — strongest piece; untouched except to extend its *pattern* to other channels.
- Reservation ledger separating `reserved` from consumed `quantity`.
- Idempotent order ingestion on `(channel, channelOrderId)` + `(orderId, lineItemId)`.
- Atomic cascade + 60s cron backstop (work never lost if Redis dies).

## 5. Prioritized problems (the work)

| # | Severity | Problem | Evidence |
|---|----------|---------|----------|
| 1 | 🔴 | **Last-writer-wins on outbound quantity** — concurrent movements can push an older qty after a newer one; `jobId` dedups identical jobs only, cascade doesn't CAS the pushed value. | `stock-movement.service.ts` cascade; `bullmq-sync.worker.ts` concurrency 5 |
| 2 | 🔴 | **Cross-channel latency config-dependent** — `<5s` only if `ENABLE_QUEUE_WORKERS=1`; else bounded by 60s cron. No priority lane / SLA. | `index.ts:367`, `sync.worker.ts:60` |
| 3 | 🔴 | **Oversell warn-only off Amazon** — eBay/Shopify can publish qty > available; pool-drift alert-only. | `ebay-flat-file.routes.ts`, `fulfillment-pool-drift.service.ts` |
| 4 | 🔴 | **`OPEN_ORDER` reservations never auto-expire** (365-day TTL; sweep handles `PENDING_ORDER` only). | `stock-level.service.ts` sweep; `reservation-sweep.job.ts` |
| 5 | 🟡 | **No scheduled reconciliation** — `reconcileAllAmazonMarketplaces()` on-demand only. | `channel-reconciliation.service.ts` |
| 6 | 🟡 | **No eBay/Shopify inventory read-back** — drift only via webhooks; Shopify drops unmapped-location events; eBay read-back absent. | `channel-stock-event.service.ts`, `shopify-webhooks.ts` |
| 7 | 🟡 | **eBay real-time hinges on prod notification setup + possible legacy/REST topic gap.** | `ebay-notification.routes.ts:233,467` |
| 8 | 🟡 | **FBA sellable staleness 0–15m; DLQ no auto-escalation / no bulk-retry; circuit-open silently defers.** | `amazon-inventory-sync.job.ts`, `dlq-monitor.job.ts`, publish gates |
| 9 | 🟢 | **No per-SKU×channel live status, one-click resync, delta preview, suppress/hold, scheduled publish; negative-available not surfaced; phase9 dedup dead code.** | `StockWorkspace.tsx`, `outbound-sync-phase9.service.ts` |

## 6. Cross-cutting design decisions

These shared decisions are referenced by multiple phases; per-phase plans implement them.

1. **Monotonic sequence stamping (fixes #1).** Each cascade write carries a per-listing monotonically increasing sequence (derived from the `StockMovement` id/timestamp or an explicit counter). The dispatch records `lastAppliedSeq` per `(channelListingId)`; a push is **skipped if its seq < lastAppliedSeq** (a newer value already won). Only the newest pending qty per listing is dispatched (coalesce). This is last-writer-**by-sequence**, not by wall-clock arrival.

2. **Single oversell chokepoint (fixes #3), policy = hard-block & clamp.** All outbound quantity dispatch funnels through one guard that computes `availableToPublish` and **clamps the pushed qty to ≤ available, logs, and emits an event**. This mirrors the FBA hard-block. Applied to eBay + Shopify + Amazon-FBM (never FBA — FBA stays fail-closed/skip).

3. **Reservation release by order status, not blind TTL (fixes #4).** A reconciliation releases/closes `OPEN_ORDER` reservations whose order is cancelled / terminal / provably stale, instead of relying on a 365-day TTL. Orphan-hold safety sweep added.

4. **Canary harness (Phase 0, reused everywhere).** A synthetic test SKU whose stock we perturb on demand, measuring true round-trip latency (provider-timestamp → channel-confirmed) per channel. This is both the latency SLO monitor and the regression harness for every later phase.

5. **Safety:** every behavior change ships behind a flag where the existing code uses one, defaults chosen per the "ship live, not dark" preference once verified; FBA guard is never weakened; no destructive migrations without explicit approval.

## 7. Phases

Each phase is independently shippable, has its own detailed implementation plan (written + approved before coding), reuses the Phase 0 canary as its regression test, is verified on prod, then committed/pushed.

### Phase 0 — Baseline & Truth *(read-only / instrumentation; no behavior change)*
- Confirm prod config: `ENABLE_QUEUE_WORKERS`, eBay Platform Notifications active?, Shopify status.
- Add end-to-end latency instrumentation + **synthetic canary** for Amazon + eBay.
- One-time reconciliation sweep (Amazon + eBay) to quantify current drift (units, SKUs, € exposure).
- **Acceptance:** a "current state" readout + a reusable canary command. **Risk:** none.

### Phase 1 — Outbound Ordering Correctness 🔴
- Implement sequence stamping + coalesce (decision §6.1); wire up the dead `(listing+syncType)` dedup.
- **Acceptance:** concurrent-movement race test proves the channel settles on the newest qty; canary shows no latency regression.

### Phase 2 — Symmetric Hard Oversell Guard 🔴
- Implement single oversell chokepoint with hard-block & clamp (decision §6.2). eBay first, Shopify same path.
- **Acceptance:** over-qty push lands clamped to available; unit + integration tests; FBA path provably unchanged.

### Phase 3 — Reservation Lifecycle Correctness 🔴
- Release-by-status reconciliation + orphan sweep (decision §6.3); surface (optionally block) negative-available.
- **Acceptance:** cancel-then-release and stuck-order-release tests; no stock stays locked; negative-available visible.

### Phase 4 — Real-Time Latency Hardening 🟡
- Confirm/enable immediate push; order-driven priority lane; make eBay webhook primary (close topic gap), 15-min poll a true backstop; SLA + breach alerting via the canary.
- **Acceptance:** measured order→channel p95 within target on prod; alert fires on injected breach.

### Phase 5 — Reconciliation & Drift Backstop 🟡
- Scheduled reconciliation cron (Amazon + eBay) with auto-heal direction rules; eBay inventory read-back; Shopify read-back (lower priority); conflict escalation; cumulative-drift alerting.
- **Acceptance:** seeded drift is detected and healed/escalated per rules within one cron cycle.

### Phase 6 — Operator Control Tower 🟢
- Per-SKU×channel live sync status, one-click resync, delta preview, per-marketplace suppress/hold, bulk-retry of failed/dead rows, real-time negative-available banner, DLQ auto-escalation. Built on the design system.
- **Acceptance:** operator can see and act on every SKU's cross-channel state from one surface.

### Phase 7 — Best-in-Class Polish 🟢
- Velocity-aware safety buffer; per-channel allocation/fencing for high-risk SKUs; journal `followMasterQuantity` toggles; remove `phase9` dead code; refresh docs.

## 8. Testing strategy

- **Canary** (Phase 0) is the spine: every phase runs it before/after to prove no regression.
- **Unit tests** for pure logic (sequence comparison, clamp math, reservation-release predicate) — extends existing `*.vitest.test.ts` patterns.
- **Integration tests** against the outbound queue + channel-handler seams (the codebase already has `outbound-sync.*.vitest.test.ts`, `atp-channel.service.test.ts`).
- **Prod verification** per the "verify on prod, not Docker" rule: commit+push → Railway/Vercel → observe via `/sync-logs/live` and the canary.

## 9. Risks & rollback

- **FBA regression** is the highest-consequence risk — every phase includes an explicit assertion that FBA listings still skip merchant-qty push; the 10-min flip-guard + auto-restore remain the safety net.
- **Clamp surprising operators** (Phase 2) — emit a clear event + surface in the control tower so a clamp is never silent.
- **Reconciliation healing the wrong direction** (Phase 5) — explicit, tested direction rules; start in detect-only, flip to auto-heal after Phase 0 quantifies real drift.
- Each phase is flag-guarded where the surrounding code already uses flags; rollback = flip the flag / revert the phase commit. Work is isolated on `worktree-inventory-col`.

## 10. Open items to resolve in Phase 0

- Exact prod values of `ENABLE_QUEUE_WORKERS`, eBay notification subscription state, Shopify publish gate.
- Whether the eBay legacy Trading-API sale topics actually drive ingestion or only the REST `marketplace.order.created` topic does.
- Real current drift magnitude (sets whether Phase 5 starts auto-healing or detect-only).

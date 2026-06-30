# Phase 5 — Reconciliation & Drift Backstop — Implementation Plan

> **STATUS: AWAITING USER APPROVAL — do not implement until approved.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make silent inventory drift **visible and self-correcting**. Today we only learn that a channel's real inventory diverged from ours if a webhook happens to fire — there's no scheduled truth-check, and **no read-back at all for eBay/Shopify**. This phase adds scheduled reconciliation (Amazon) + an **eBay inventory read-back** that feeds the existing drift pipeline, plus slow-bleed and stale-conflict alerting.

**Architecture:** Maximum reuse of existing machinery. (1) Schedule the existing `reconcileAllAmazonMarketplaces()` (already reporting-only). (2) Read eBay's current published quantity (the `GET inventory_item` the eBay service already does) and feed it into the existing `recordChannelStockEvent()` pipeline — which already classifies drift, auto-applies ≤1u, and routes the rest to `/fulfillment/stock/channel-drift` for review. (3) A small cron that sums recent auto-applied drift (slow-bleed) and escalates stale `SyncHealthLog` conflicts. New events surface on the order-events bus. **Detect-first**: nothing auto-heals beyond the existing ≤1u threshold; bigger drift is surfaced for the operator.

**Tech Stack:** Prisma (`ChannelListing`, `ChannelStockEvent`, `SyncHealthLog`), `channel-reconciliation.service.ts`, `channel-stock-event.service.ts` (`recordChannelStockEvent`), eBay Inventory API (`marketplaces/ebay.service.ts` GET pattern), `order-events.service.ts`, `cron-observability.ts`, Vitest, TypeScript (ESM `.js`).

## Global Constraints

- **Detect-first / reuse the existing auto-apply policy.** This phase does NOT introduce new auto-healing. eBay read-back feeds `recordChannelStockEvent`, whose existing ≤1u auto-apply + REVIEW_NEEDED behavior is unchanged. Amazon reconciliation stays reporting-only.
- **No schema migration.** Uses existing models; new events are TS union members.
- **Flag-guarded, default ON** per cron: `NEXUS_RECONCILE_CRON`, `NEXUS_EBAY_READBACK`, `NEXUS_DRIFT_ALERTS` (`=0` ⇒ that cron not scheduled).
- **Bounded + rate-aware.** eBay read-back caps SKUs per run (`NEXUS_EBAY_READBACK_MAX`, default 200) and logs when capped; it reuses any existing eBay API call recording/rate handling (`recordApiCall`). Read-only external calls; never writes to the channel.
- **Shopify read-back is deferred** (not transacting; no read method exists yet) — the read-back service is written eBay-first with a clear seam for Shopify later. Note it in code, don't silently skip.
- **Observability only beyond the existing pipeline** — emits/logs; the only stock mutation is the existing `recordChannelStockEvent` ≤1u auto-apply path. Emit failures swallowed.
- Branch only (`worktree-inventory-col`); isolate into the inventory-sync PR set at consolidation. Commit + push per task.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/reconcile-alerts.ts` (create) | Pure helpers: `reconcileDriftExceeds(report, pct)`, `cumulativeDriftBreaches(events, threshold)`, `staleConflictCutoff(now, days)`. |
| `apps/api/src/services/reconcile-alerts.vitest.test.ts` (create) | Unit tests for the pure helpers. |
| `apps/api/src/services/ebay-inventory-readback.service.ts` (create) | `readBackEbayInventory(opts)` — read eBay published qty per active listing → `recordChannelStockEvent`. |
| `apps/api/src/jobs/reconcile-cron.job.ts` (create) | Daily: `reconcileAllAmazonMarketplaces()` + drift alert + cumulative-drift + stale-conflict escalation. |
| `apps/api/src/jobs/ebay-readback.job.ts` (create) | 30-min: `readBackEbayInventory()`. |
| `apps/api/src/services/order-events.service.ts` (modify) | Add `sync.reconcile.drift`, `sync.drift.cumulative`, `sync.conflict.stale` union members. |
| `apps/api/src/index.ts` (modify) | Start both crons at boot. |

---

### Task 1: pure reconcile/drift-alert helpers + tests + event members

**Files:** create `reconcile-alerts.ts` + test; modify `order-events.service.ts`.

**Interfaces:**
- `reconcileDriftExceeds(driftPct: number | null, thresholdPct: number): boolean` — true when `driftPct` is a number and `Math.abs(driftPct) > thresholdPct`.
- `cumulativeDriftBreaches(absDriftUnits: number, thresholdUnits: number): boolean` — true when `absDriftUnits > thresholdUnits`.
- `staleConflictCutoff(nowMs: number, days: number): Date` — `new Date(nowMs - days*86_400_000)`.
- Event members: `{ type: 'sync.reconcile.drift'; channel: string; marketplace?: string|null; metric: string; driftPct: number; ts: number }`, `{ type: 'sync.drift.cumulative'; channel: string; absDriftUnits: number; windowHours: number; ts: number }`, `{ type: 'sync.conflict.stale'; count: number; olderThanDays: number; ts: number }`.

- [ ] **Step 1: failing test** (`reconcile-alerts.vitest.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { reconcileDriftExceeds, cumulativeDriftBreaches, staleConflictCutoff } from './reconcile-alerts.js'

describe('reconcileDriftExceeds', () => {
  it('flags abs drift over the threshold, ignores null', () => {
    expect(reconcileDriftExceeds(12, 5)).toBe(true)
    expect(reconcileDriftExceeds(-12, 5)).toBe(true)
    expect(reconcileDriftExceeds(3, 5)).toBe(false)
    expect(reconcileDriftExceeds(5, 5)).toBe(false) // strict >
    expect(reconcileDriftExceeds(null, 5)).toBe(false)
  })
})
describe('cumulativeDriftBreaches', () => {
  it('flags strictly over the unit threshold', () => {
    expect(cumulativeDriftBreaches(11, 10)).toBe(true)
    expect(cumulativeDriftBreaches(10, 10)).toBe(false)
  })
})
describe('staleConflictCutoff', () => {
  it('returns now minus N days', () => {
    const now = Date.parse('2026-07-01T00:00:00.000Z')
    expect(staleConflictCutoff(now, 3).toISOString()).toBe('2026-06-28T00:00:00.000Z')
  })
})
```

- [ ] **Step 2: run, verify fail.**

- [ ] **Step 3: implement** (`reconcile-alerts.ts`)

```ts
/** Phase 5 — pure alert predicates for the reconciliation/drift crons. */
export function reconcileDriftExceeds(driftPct: number | null, thresholdPct: number): boolean {
  return typeof driftPct === 'number' && Math.abs(driftPct) > thresholdPct
}
export function cumulativeDriftBreaches(absDriftUnits: number, thresholdUnits: number): boolean {
  return absDriftUnits > thresholdUnits
}
export function staleConflictCutoff(nowMs: number, days: number): Date {
  return new Date(nowMs - days * 86_400_000)
}
```

- [ ] **Step 4: run, verify pass.**

- [ ] **Step 5: add the three event union members** to `order-events.service.ts` (next to the other `sync.*` members), exact shapes above.

- [ ] **Step 6: typecheck + commit** — `npx tsc --noEmit`; commit `feat(inventory-sync): P5.1 reconcile-alert helpers + drift events`.

---

### Task 2: eBay inventory read-back → ChannelStockEvent

**Files:** create `ebay-inventory-readback.service.ts`; create `ebay-readback.job.ts`; modify `index.ts`.

**Interfaces:** `readBackEbayInventory(opts?: { maxSkus?: number }): Promise<{ checked: number; recorded: number; errors: number; capped: boolean }>`.

Design (verified):
- For each **active eBay `ChannelListing`** (`channel: 'EBAY', listingStatus: 'ACTIVE'`), resolve its SKU, call eBay `GET /sell/inventory/v1/inventory_item/{sku}` (mirror the GET in `marketplaces/ebay.service.ts:113-149`, via `recordApiCall`), and extract `availability.shipToLocationAvailability.quantity`.
- Feed each observation into the **existing** `recordChannelStockEvent({ channel: 'EBAY', sku, channelReportedQty: qty, channelEventId, rawPayload })`. This reuses CS.1's drift classification, ≤1u auto-apply, and REVIEW_NEEDED routing — **no new drift logic**.
- `channelEventId = \`ebay-readback:${sku}:${yyyyMmDdHh}\`` (one observation per SKU per run-hour; `recordChannelStockEvent` is idempotent on `(channel, channelEventId)`, so a re-read in the same hour dedups, and the next hour records a fresh observation).
- Bounded by `maxSkus` (default `NEXUS_EBAY_READBACK_MAX` = 200); set `capped` + log if exceeded. Per-SKU try/catch (one 404/timeout doesn't abort the sweep).

- [ ] **Step 1: implement the read-back service** — `ebay-inventory-readback.service.ts`. Add a small exported helper for the bucket id and the qty extraction so they're unit-testable:
  - `export function ebayReadbackEventId(sku: string, d: Date): string` → `ebay-readback:${sku}:${d.toISOString().slice(0,13)}`
  - `export function extractEbayPublishedQty(item: any): number | null` → `item?.availability?.shipToLocationAvailability?.quantity` coerced to a non-negative number, else null.
  Then the orchestrator loops active eBay listings, GETs each, and calls `recordChannelStockEvent`. (Full code authored at implementation time, mirroring the existing GET + `recordApiCall` pattern.)

> **Implementer note:** read `marketplaces/ebay.service.ts:111-160` for the exact GET + auth + `recordApiCall` shape to reuse; do NOT hand-roll a new auth path. Confirm `recordChannelStockEvent`'s input keys (`channel`, `sku`, `channelReportedQty`, `channelEventId`, `rawPayload`) against `channel-stock-event.service.ts`. Add `extractEbayPublishedQty` + `ebayReadbackEventId` tests to a new `ebay-inventory-readback.vitest.test.ts` (pure parts only).

- [ ] **Step 2: create the cron** — `ebay-readback.job.ts`, 30-min default (`'*/30 * * * *'`), `NEXUS_EBAY_READBACK=0` disables, `recordCronRun('ebay-readback', …)` returns `checked=… recorded=… errors=… (capped)`. Mirror a sibling cron's scaffold.

- [ ] **Step 3: register at boot** in `index.ts` (mirror a sibling start).

- [ ] **Step 4: typecheck + tests + commit** — `npx tsc --noEmit`; `npx vitest run src/services/ebay-inventory-readback.vitest.test.ts`; commit `feat(inventory-sync): P5.2 eBay inventory read-back → ChannelStockEvent (NEXUS_EBAY_READBACK)`.

---

### Task 3: reconcile cron — Amazon drift + cumulative-bleed + stale-conflict escalation

**Files:** create `reconcile-cron.job.ts`; modify `index.ts`.

Design:
- Daily (`'45 3 * * *'` — after the Amazon T+1 ingests; `NEXUS_RECONCILE_CRON=0` disables), `recordCronRun('inventory-reconcile', …)`:
  1. **Amazon drift:** `reconcileAllAmazonMarketplaces({ daysBack: 30 })`; for each per-marketplace/metric drift %, if `reconcileDriftExceeds(driftPct, NEXUS_RECONCILE_DRIFT_PCT ?? 5)` → `publishOrderEvent('sync.reconcile.drift', …)`. Detect-only.
  2. **Cumulative bleed:** sum `Math.abs(drift)` over `ChannelStockEvent` rows with `status='AUTO_APPLIED'` in the last `NEXUS_DRIFT_WINDOW_HOURS` (default 168 = 7d) per channel; if `cumulativeDriftBreaches(sum, NEXUS_CUMULATIVE_DRIFT_UNITS ?? 25)` → `publishOrderEvent('sync.drift.cumulative', …)`. Catches slow bleed from repeated ≤1u auto-applies.
  3. **Stale conflicts:** count `SyncHealthLog` rows with `resolutionStatus='UNRESOLVED'` and `createdAt < staleConflictCutoff(now, NEXUS_STALE_CONFLICT_DAYS ?? 3)`; if `> 0` → `publishOrderEvent('sync.conflict.stale', …)`.
  - Each emit in try/catch; summarise counts in the cron return.

> **Implementer note:** confirm the `ChannelStockEvent` field used for drift magnitude (read `channel-stock-event.service.ts` / schema — likely a `drift` Int) and `MultiMarketplaceReconciliationReport`'s per-metric drift-% shape (read `channel-reconciliation.service.ts` around the report assembly). Gate `NEXUS_DRIFT_ALERTS=0` to disable the cumulative + stale checks independently of the Amazon reconcile.

- [ ] **Step 1: create the cron** per the design above.
- [ ] **Step 2: register at boot** in `index.ts`.
- [ ] **Step 3: typecheck + commit + push** — `npx tsc --noEmit`; commit `feat(inventory-sync): P5.3 reconcile cron — Amazon drift + cumulative bleed + stale-conflict escalation`; push.

---

## Self-Review
- **Spec coverage:** scheduled reconciliation (Task 3 Amazon), eBay/Shopify read-back (Task 2 eBay; Shopify deferred with a seam), conflict escalation + cumulative-drift alerting (Task 3). Auto-heal direction stays the existing ≤1u policy (detect-first), per the spec's "start detect-only."
- **Placeholder scan:** thresholds have concrete env defaults; the only non-inline code ("authored at implementation time") is the eBay GET orchestrator, which is pinned to an exact existing pattern + two unit-tested pure helpers.
- **Type consistency:** the three pure helpers + three event shapes defined in Task 1, consumed by name in Tasks 2-3.
- **Risk:** the only external load is eBay read GETs (bounded by `maxSkus`, reusing `recordApiCall`); the only stock mutation is the pre-existing ≤1u auto-apply inside `recordChannelStockEvent`; everything else is read + emit. All crons flag-guarded, default ON.

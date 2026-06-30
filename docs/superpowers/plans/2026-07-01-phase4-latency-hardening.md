# Phase 4 (remainder) — Real-Time Latency Hardening — Implementation Plan

> **STATUS: AWAITING USER APPROVAL — do not implement until approved.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make order-driven pushes win under load, and make latency/real-time degradation **visible** instead of silent. (P4.1 — eBay legacy-path real-time ingestion — already shipped.)

**Architecture:** Two additive, flag-guarded changes. (1) An order-driven **priority** on the outbound BullMQ enqueue so sale-driven quantity pushes jump ahead of manual edits when the worker is saturated. (2) An hourly **latency/health watchdog** cron that reuses the Phase-0 `sync-metrics` latency math + the diagnostics readout to emit `sync.latency.breach` / `sync.realtime.degraded` events on the existing order-events bus (surfaced by RT alerting). Thresholds are env-configurable with sensible defaults, **tuned from the deployed baseline**.

**Tech Stack:** BullMQ (`outboundSyncQueue.add` priority), `sync-metrics.ts` (`computeLatencyStats`), `order-events.service.ts` bus, `cron-observability.ts`, Vitest, TypeScript (ESM `.js`).

## Global Constraints

- **No schema migration.** Priority is a BullMQ job option; the two new events are TS union members.
- **Flag-guarded, default ON.** Priority lane: `NEXUS_OUTBOUND_PRIORITY` (`=0` ⇒ omit priority = exact prior behavior). Watchdog cron: `NEXUS_LATENCY_WATCHDOG` (`=0` ⇒ cron not scheduled).
- **Thresholds are env-configurable** (`NEXUS_LATENCY_P95_BREACH_MS`, default e.g. 60000) and **explicitly marked for post-baseline tuning** — the mechanism ships now, the numbers get calibrated once the Phases 0-3 PR is deployed and `outbound-latency` shows real data.
- **Observability only — never block a push.** Priority only reorders waiting jobs; the watchdog only reads + emits. Emit failures are swallowed (matching other bus emitters).
- **Don't regress the order-driven `delay: 0` / manual `delay: 30s` behavior** — priority is added alongside, not instead.
- Branch only (`worktree-inventory-col`); isolate into the inventory-sync PR set at consolidation. Commit + push per task.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/sync-priority.ts` (create) | Pure `outboundEnqueuePriority(reason)` — maps an order-driven reason to a BullMQ priority. |
| `apps/api/src/services/sync-priority.vitest.test.ts` (create) | Unit tests for the priority mapping. |
| `apps/api/src/services/stock-movement.service.ts` (modify) | Pass `priority` into the existing `outboundSyncQueue.add(...)` (flag-guarded). |
| `apps/api/src/services/sync-metrics.ts` (modify) | Add a pure `evaluateLatencyBreach(channels, thresholdMs)` over `ChannelLatency[]`. |
| `apps/api/src/services/sync-metrics.vitest.test.ts` (modify) | Tests for `evaluateLatencyBreach`. |
| `apps/api/src/services/order-events.service.ts` (modify) | Add `sync.latency.breach` + `sync.realtime.degraded` union members. |
| `apps/api/src/jobs/latency-watchdog.job.ts` (create) | Hourly cron: compute recent outbound latency + diagnostics, emit breach/degraded events. |
| `apps/api/src/index.ts` (modify) | Start the watchdog cron at boot. |

---

### Task 1: order-driven priority lane

**Files:** create `sync-priority.ts` + test; modify `stock-movement.service.ts`.

**Interfaces:** `export function outboundEnqueuePriority(reason: string): number | undefined` — returns `1` (highest) for an order-driven reason, `undefined` otherwise (BullMQ treats absent priority as lowest/normal).

- [ ] **Step 1: failing test** (`sync-priority.vitest.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { outboundEnqueuePriority } from './sync-priority.js'

describe('outboundEnqueuePriority', () => {
  it('prioritises order-driven reasons (highest = 1)', () => {
    for (const r of ['ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RESTOCKED']) {
      expect(outboundEnqueuePriority(r)).toBe(1)
    }
  })
  it('leaves manual/other reasons unprioritised (undefined)', () => {
    expect(outboundEnqueuePriority('MANUAL_ADJUSTMENT')).toBeUndefined()
    expect(outboundEnqueuePriority('SYNC_RECONCILIATION')).toBeUndefined()
  })
})
```

- [ ] **Step 2: run, verify fail** — `cd apps/api && npx vitest run src/services/sync-priority.vitest.test.ts` → FAIL (module missing).

- [ ] **Step 3: implement** (`sync-priority.ts`)

```ts
/**
 * Phase 4 — order-driven outbound pushes (a real sale) should win the worker
 * over manual edits when jobs queue up. BullMQ: lower number = higher priority;
 * absent = normal. Mirrors the ORDER_DRIVEN_REASONS set used for the delay:0 path.
 */
const ORDER_DRIVEN = new Set(['ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RESTOCKED'])

export function outboundEnqueuePriority(reason: string): number | undefined {
  return ORDER_DRIVEN.has(reason) ? 1 : undefined
}
```

- [ ] **Step 4: run, verify pass.**

- [ ] **Step 5: wire into the enqueue** — `stock-movement.service.ts`, the existing `await outboundSyncQueue.add('sync-job', {...}, { delay: enqueueDelay, jobId: queueId })` (~line 476). Add the import and a flag-guarded `priority`:

```ts
import { outboundEnqueuePriority } from './sync-priority.js'
// ...
const priority =
  process.env.NEXUS_OUTBOUND_PRIORITY === '0' ? undefined : outboundEnqueuePriority(reason)
await outboundSyncQueue.add(
  'sync-job',
  { queueId, productId, syncType: 'QUANTITY_UPDATE', source: 'STOCK_MOVEMENT', reason },
  { delay: enqueueDelay, jobId: queueId, ...(priority !== undefined ? { priority } : {}) },
)
```

> **Implementer note:** keep `delay`/`jobId` exactly as-is; only spread `priority` when defined (BullMQ rejects `priority: undefined` in some versions). Confirm `reason` is in scope at the enqueue (it is — used for `enqueueDelay`).

- [ ] **Step 6: typecheck + commit** — `cd apps/api && npx tsc --noEmit`; then commit `feat(inventory-sync): P4.2 order-driven outbound priority lane (NEXUS_OUTBOUND_PRIORITY)`.

---

### Task 2: latency/health watchdog + alert events

**Files:** modify `sync-metrics.ts` (+ test) + `order-events.service.ts`; create `latency-watchdog.job.ts`; modify `index.ts`.

**Interfaces:**
- `export function evaluateLatencyBreach(channels: ChannelLatency[], thresholdMs: number): Array<{ channel: string; p95Ms: number }>` — returns channels whose `p95Ms` exceeds `thresholdMs`.
- Event members: `{ type: 'sync.latency.breach'; channel: string; p95Ms: number; thresholdMs: number; window: string; ts: number }` and `{ type: 'sync.realtime.degraded'; reason: string; ts: number }`.

- [ ] **Step 1: failing test for `evaluateLatencyBreach`** (`sync-metrics.vitest.test.ts`)

```ts
import { evaluateLatencyBreach } from './sync-metrics.js'

describe('evaluateLatencyBreach', () => {
  const mk = (channel: string, p95Ms: number | null) => ({
    channel, pendingCount: 0, sampleCount: 1, p50Ms: p95Ms, p95Ms, p99Ms: p95Ms,
    minMs: p95Ms, maxMs: p95Ms, histogram: [],
  })
  it('flags only channels over the threshold', () => {
    const out = evaluateLatencyBreach([mk('AMAZON', 90_000), mk('EBAY', 3_000)], 60_000)
    expect(out).toEqual([{ channel: 'AMAZON', p95Ms: 90_000 }])
  })
  it('ignores channels with null p95 (no samples)', () => {
    expect(evaluateLatencyBreach([mk('AMAZON', null)], 60_000)).toEqual([])
  })
})
```

- [ ] **Step 2: run, verify fail.**

- [ ] **Step 3: implement `evaluateLatencyBreach`** (append to `sync-metrics.ts`)

```ts
export function evaluateLatencyBreach(
  channels: ChannelLatency[],
  thresholdMs: number,
): Array<{ channel: string; p95Ms: number }> {
  return channels
    .filter((c) => typeof c.p95Ms === 'number' && c.p95Ms > thresholdMs)
    .map((c) => ({ channel: c.channel, p95Ms: c.p95Ms as number }))
}
```

- [ ] **Step 4: run, verify pass.**

- [ ] **Step 5: add the two event union members** to `order-events.service.ts` (next to the other `sync.*` members):

```ts
  | { type: 'sync.latency.breach'; channel: string; p95Ms: number; thresholdMs: number; window: string; ts: number }
  | { type: 'sync.realtime.degraded'; reason: string; ts: number }
```

- [ ] **Step 6: create the watchdog cron** (`latency-watchdog.job.ts`) — hourly, flag-guarded. It: (a) queries the last 24h of `OutboundSyncQueue` rows (same shape as `outbound-latency.routes.ts`), builds `ChannelLatency[]` via `buildOutboundLatencyResponse`, runs `evaluateLatencyBreach` against `NEXUS_LATENCY_P95_BREACH_MS` (default 60000), and `publishOrderEvent('sync.latency.breach')` per breached channel; (b) reads the diagnostics inputs (queue-workers flag + eBay-notification readiness, same as the diagnostics route) and emits `sync.realtime.degraded` if `dispatchPath` is `cron-60s-only` or eBay notifications are inactive. Wrap each emit in try/catch; summarise counts in the `recordCronRun` return. (Mirror `sales-drift-detector.job.ts` structure.)

> **Implementer note:** reuse the exact `OutboundSyncQueue` select + window from `outbound-latency.routes.ts` and the config reads from `inventory-sync-diagnostics.routes.ts` — do NOT duplicate the latency math (call `buildOutboundLatencyResponse` + `evaluateLatencyBreach`). Default schedule `'30 * * * *'`; env override `NEXUS_LATENCY_WATCHDOG_SCHEDULE`; disable on `NEXUS_LATENCY_WATCHDOG=0`.

- [ ] **Step 7: register at boot** in `index.ts` (mirror a sibling cron start, e.g. `startReservationReconcileCron`).

- [ ] **Step 8: typecheck + run touched tests + commit + push** — `npx tsc --noEmit`; `npx vitest run src/services/sync-metrics.vitest.test.ts src/services/sync-priority.vitest.test.ts`; commit `feat(inventory-sync): P4.3 latency/realtime watchdog + alert events`; push.

---

## Post-baseline tuning (tracked, not blocking)
Once the Phases 0-3 PR is deployed and `/api/admin/outbound-latency` shows real numbers, set `NEXUS_LATENCY_P95_BREACH_MS` to a value just above normal p95 (e.g. 1.5× observed) so the watchdog alerts on genuine degradation, not noise. Until then the 60s default is a safe placeholder.

## Self-Review
- **Spec coverage:** Phase 4 remaining items — order-driven priority (Task 1), SLA/breach + realtime-degraded alerting (Task 2). Immediate-push *enablement* is config (`ENABLE_QUEUE_WORKERS`, operator/Railway) — surfaced by the degraded event, not code. eBay-primary already done (P4.1).
- **Placeholder scan:** thresholds have concrete defaults + a tuning note; no TODOs.
- **Type consistency:** `outboundEnqueuePriority(string): number|undefined`, `evaluateLatencyBreach(ChannelLatency[], number)`, the two event shapes — defined once, consumed by name.
- **Risk:** both changes are additive + flag-guarded; priority only reorders waiting jobs (can't drop/delay a push); the watchdog is read-only + emit-only.

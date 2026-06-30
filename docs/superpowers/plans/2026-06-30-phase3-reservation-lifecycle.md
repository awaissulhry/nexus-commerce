# Phase 3 — Reservation Lifecycle Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `OPEN_ORDER` reservations from locking stock forever. Today they're released only by `consumeOpenOrder` (on SHIPPED) or `releaseOpenOrder` (on a cancellation cascade); an order that reaches a terminal state by any other path leaves its reservation active for the 365-day TTL, so `available` stays wrongly depressed (phantom stockouts). This phase adds a periodic reconciliation that resolves orphaned `OPEN_ORDER` reservations **by order status** — and is deliberately conservative: it only auto-acts on unambiguous cases.

**Architecture:** A pure `classifyOpenOrderReconciliation(orderStatus, ageMs, staleMs)` decision function (fully unit-tested) + a thin orchestrator `reconcileOpenOrderReservations()` that groups active `OPEN_ORDER` reservations by order, classifies each, and calls the existing **idempotent** `releaseOpenOrder` / `consumeOpenOrder`. A new hourly cron runs it (flag `NEXUS_RESERVATION_RECONCILE`, default ON). Ambiguous cases are logged + counted, never auto-acted. A cheap negative-`available` scan is surfaced in the same pass.

**Tech Stack:** Prisma (`StockReservation`, `Order`, `StockLevel`), `stock-level.service.ts` (existing idempotent `consumeOpenOrder`/`releaseOpenOrder`), `cron-observability.ts` (`recordCronRun`), Vitest, TypeScript (ESM `.js` imports).

## Global Constraints

- **Release vs consume vs alert — the safety core.** For an active `OPEN_ORDER` reservation (`releasedAt = null AND consumedAt = null AND reason = 'OPEN_ORDER'`) whose order is:
  - `CANCELLED` → **release** (`releaseOpenOrder`) — never shipped; free the hold without touching `quantity`.
  - `SHIPPED` or `DELIVERED` → **consume** (`consumeOpenOrder`) — the unit physically left; decrement `quantity`+`reserved`. (Releasing here would wrongly inflate `available`.)
  - `REFUNDED` or `RETURNED` → **alert only** — ambiguous (depends whether it shipped first + how returns restocked); log + count, never auto-act.
  - non-terminal (`PENDING`/`PROCESSING`/`PARTIALLY_SHIPPED`/`ON_HOLD`/`AWAITING_PAYMENT`) and **older than `staleMs`** → **alert only** — an order legitimately awaiting fulfillment must keep its hold.
  - otherwise → **skip** (active order, hold is correct).
- **Reuse the existing idempotent ops.** `releaseOpenOrder({ orderId, reason })` and `consumeOpenOrder({ orderId })` already exist, are idempotent on already-settled reservations, and key by `orderId`. Do NOT write new stock-mutation logic.
- **Flag-guarded, default ON.** The cron no-ops when `process.env.NEXUS_RESERVATION_RECONCILE === '0'`.
- **Conservative cadence + bound.** Hourly; cap the number of orders processed per run (e.g. 500) and log if capped — never an unbounded sweep.
- **No schema migration.** Uses existing models/fields only.
- **Observability:** the cron's `recordCronRun` summary reports `released/consumed/alerted/negativeAvailable` counts; alert cases also `logger.warn`. No new event-union member this phase.
- Branch only (`worktree-inventory-col`); isolate to its own PR at consolidation. Commit + push per task.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/reservation-reconcile.ts` (create) | Pure `classifyOpenOrderReconciliation(...)` + orchestrator `reconcileOpenOrderReservations(opts)`. |
| `apps/api/src/services/reservation-reconcile.vitest.test.ts` (create) | Unit tests for the classifier (the decision matrix). |
| `apps/api/src/jobs/reservation-reconcile.job.ts` (create) | Hourly cron wrapper (`recordCronRun('reservation-reconcile', …)`), flag-guarded. |
| `apps/api/src/index.ts` (modify) | Start the cron at boot (mirror `startReservationSweepCron`). |

---

### Task 1: `classifyOpenOrderReconciliation` pure decision function + tests

**Files:**
- Create: `apps/api/src/services/reservation-reconcile.ts` (classifier only for this task)
- Test: `apps/api/src/services/reservation-reconcile.vitest.test.ts`

**Interfaces:**
- Produces: `export type ReconcileAction = 'release' | 'consume' | 'alert' | 'skip'`
- Produces: `export function classifyOpenOrderReconciliation(orderStatus: string, ageMs: number, staleMs: number): ReconcileAction`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/reservation-reconcile.vitest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyOpenOrderReconciliation } from './reservation-reconcile.js'

const DAY = 24 * 60 * 60 * 1000
const STALE = 90 * DAY

describe('classifyOpenOrderReconciliation', () => {
  it('releases a held reservation for a CANCELLED order', () => {
    expect(classifyOpenOrderReconciliation('CANCELLED', 1 * DAY, STALE)).toBe('release')
  })
  it('consumes for SHIPPED and DELIVERED (unit left — must decrement quantity)', () => {
    expect(classifyOpenOrderReconciliation('SHIPPED', 1 * DAY, STALE)).toBe('consume')
    expect(classifyOpenOrderReconciliation('DELIVERED', 1 * DAY, STALE)).toBe('consume')
  })
  it('only alerts (never auto-acts) for REFUNDED / RETURNED — ambiguous', () => {
    expect(classifyOpenOrderReconciliation('REFUNDED', 1 * DAY, STALE)).toBe('alert')
    expect(classifyOpenOrderReconciliation('RETURNED', 1 * DAY, STALE)).toBe('alert')
  })
  it('skips a fresh non-terminal order (hold is legitimate)', () => {
    expect(classifyOpenOrderReconciliation('PROCESSING', 2 * DAY, STALE)).toBe('skip')
    expect(classifyOpenOrderReconciliation('PENDING', 10 * DAY, STALE)).toBe('skip')
  })
  it('alerts (does NOT release) a stale non-terminal order past staleMs', () => {
    expect(classifyOpenOrderReconciliation('PROCESSING', 120 * DAY, STALE)).toBe('alert')
    expect(classifyOpenOrderReconciliation('ON_HOLD', 200 * DAY, STALE)).toBe('alert')
  })
  it('skips unknown statuses defensively', () => {
    expect(classifyOpenOrderReconciliation('SOME_NEW_STATUS', 1 * DAY, STALE)).toBe('skip')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && npx vitest run src/services/reservation-reconcile.vitest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the classifier**

Create `apps/api/src/services/reservation-reconcile.ts` with (for this task) just:

```ts
/**
 * Phase 3 — decide what to do with an active OPEN_ORDER reservation whose
 * order has moved on. Conservative: only auto-act on unambiguous cases.
 *
 *   CANCELLED            -> release  (never shipped; free the hold)
 *   SHIPPED | DELIVERED  -> consume  (unit left; decrement quantity)
 *   REFUNDED | RETURNED  -> alert    (ambiguous; surface, don't auto-act)
 *   non-terminal & stale -> alert    (legitimately may still await fulfillment)
 *   otherwise            -> skip     (fresh, active — hold is correct)
 */
export type ReconcileAction = 'release' | 'consume' | 'alert' | 'skip'

const NON_TERMINAL = new Set([
  'PENDING',
  'PROCESSING',
  'PARTIALLY_SHIPPED',
  'ON_HOLD',
  'AWAITING_PAYMENT',
])

export function classifyOpenOrderReconciliation(
  orderStatus: string,
  ageMs: number,
  staleMs: number,
): ReconcileAction {
  if (orderStatus === 'CANCELLED') return 'release'
  if (orderStatus === 'SHIPPED' || orderStatus === 'DELIVERED') return 'consume'
  if (orderStatus === 'REFUNDED' || orderStatus === 'RETURNED') return 'alert'
  if (NON_TERMINAL.has(orderStatus)) return ageMs > staleMs ? 'alert' : 'skip'
  return 'skip'
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/api && npx vitest run src/services/reservation-reconcile.vitest.test.ts` → PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reservation-reconcile.ts apps/api/src/services/reservation-reconcile.vitest.test.ts
git commit -m "feat(inventory-sync): P3.1 classifyOpenOrderReconciliation decision fn"
```

---

### Task 2: `reconcileOpenOrderReservations` orchestrator

**Files:**
- Modify: `apps/api/src/services/reservation-reconcile.ts` (add the orchestrator below the classifier)

**Interfaces:**
- Consumes: `classifyOpenOrderReconciliation` (Task 1); `releaseOpenOrder`, `consumeOpenOrder` from `./stock-level.service.js`; Prisma `stockReservation` / `order` / `stockLevel`.
- Produces: `export async function reconcileOpenOrderReservations(opts?: { staleMs?: number; maxOrders?: number; actor?: string }): Promise<{ scanned: number; released: number; consumed: number; alerted: number; negativeAvailable: number; capped: boolean }>`

Notes (verified):
- Active OPEN_ORDER reservation filter: `{ reason: 'OPEN_ORDER', releasedAt: null, consumedAt: null, orderId: { not: null } }` (StockReservation has `orderId`, `reason`, `releasedAt`, `consumedAt`).
- `releaseOpenOrder({ orderId, reason })` and `consumeOpenOrder({ orderId })` are idempotent and act on all open reservations for the order — so process **one orderId once**, not per-reservation.
- Order has `status` (the `OrderStatus` enum) and `updatedAt`.

- [ ] **Step 1: Implement the orchestrator** (append to `reservation-reconcile.ts`)

```ts
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { releaseOpenOrder, consumeOpenOrder } from './stock-level.service.js'

const DEFAULT_STALE_MS = 90 * 24 * 60 * 60 * 1000 // 90d
const DEFAULT_MAX_ORDERS = 500

export async function reconcileOpenOrderReservations(opts?: {
  staleMs?: number
  maxOrders?: number
  actor?: string
}): Promise<{
  scanned: number
  released: number
  consumed: number
  alerted: number
  negativeAvailable: number
  capped: boolean
}> {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS
  const maxOrders = opts?.maxOrders ?? DEFAULT_MAX_ORDERS
  const actor = opts?.actor ?? 'reservation-reconcile'

  // Distinct orderIds with an active OPEN_ORDER reservation.
  const active = await prisma.stockReservation.findMany({
    where: { reason: 'OPEN_ORDER', releasedAt: null, consumedAt: null, orderId: { not: null } },
    select: { orderId: true },
    distinct: ['orderId'],
    take: maxOrders + 1,
  })
  const capped = active.length > maxOrders
  const orderIds = active.slice(0, maxOrders).map((r) => r.orderId!).filter(Boolean)

  let released = 0
  let consumed = 0
  let alerted = 0

  if (orderIds.length > 0) {
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, status: true, updatedAt: true },
    })
    const now = Date.now()
    for (const o of orders) {
      const ageMs = now - o.updatedAt.getTime()
      const action = classifyOpenOrderReconciliation(String(o.status), ageMs, staleMs)
      try {
        if (action === 'release') {
          released += await releaseOpenOrder({ orderId: o.id, reason: 'reconcile: order terminal (cancelled)', actor })
        } else if (action === 'consume') {
          consumed += await consumeOpenOrder({ orderId: o.id, actor })
        } else if (action === 'alert') {
          alerted++
          logger.warn('reservation-reconcile: open reservation needs review', {
            orderId: o.id,
            status: o.status,
            ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)),
          })
        }
      } catch (err) {
        logger.warn('reservation-reconcile: action failed (non-fatal)', {
          orderId: o.id,
          action,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // Cheap negative-available surfacing (if the DB CHECK ever lets one through).
  const negativeAvailable = await prisma.stockLevel.count({ where: { available: { lt: 0 } } })
  if (negativeAvailable > 0) {
    logger.warn('reservation-reconcile: negative available detected', { count: negativeAvailable })
  }

  if (capped) {
    logger.warn('reservation-reconcile: order scan capped', { maxOrders })
  }

  return { scanned: orderIds.length, released, consumed, alerted, negativeAvailable, capped }
}
```

> **Implementer note:** confirm `releaseOpenOrder`'s arg shape accepts `{ orderId, reason, actor }` (read `stock-level.service.ts` ~line 420) — if `actor` isn't a param, drop it. Confirm `consumeOpenOrder` returns `number` (it does) and `releaseOpenOrder` returns `number` (verify; if it returns void, count it as `+1` per order instead of `+= await`). Confirm `Order.updatedAt` exists (it's a standard Prisma field). The classifier is already imported (same file).

- [ ] **Step 2: Typecheck + tests**

Run: `cd apps/api && npx tsc --noEmit` → no errors.
Run: `cd apps/api && npx vitest run src/services/reservation-reconcile.vitest.test.ts` → still green (classifier unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/reservation-reconcile.ts
git commit -m "feat(inventory-sync): P3.2 reconcileOpenOrderReservations orchestrator"
```

---

### Task 3: Hourly cron + boot wiring (flag-guarded)

**Files:**
- Create: `apps/api/src/jobs/reservation-reconcile.job.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `reconcileOpenOrderReservations` (Task 2), `recordCronRun` (`../utils/cron-observability.js`).

- [ ] **Step 1: Create the cron job** — `apps/api/src/jobs/reservation-reconcile.job.ts`

```ts
/**
 * Phase 3 — hourly reconciliation of orphaned OPEN_ORDER reservations.
 * Releases holds for cancelled orders, consumes for shipped/delivered, and
 * alerts (logs) on ambiguous cases. Gated by NEXUS_RESERVATION_RECONCILE.
 */
import cron from 'node-cron'
import { reconcileOpenOrderReservations } from '../services/reservation-reconcile.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'

const JOB = 'reservation-reconcile'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startReservationReconcileCron(): void {
  if (process.env.NEXUS_RESERVATION_RECONCILE === '0') {
    logger.info('reservation-reconcile cron: disabled via env')
    return
  }
  if (scheduledTask) {
    logger.warn('reservation-reconcile cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_RESERVATION_RECONCILE_SCHEDULE ?? '15 * * * *' // hourly at :15
  if (!cron.validate(schedule)) {
    logger.error('reservation-reconcile cron: invalid schedule, not starting', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB, async () => {
      const r = await reconcileOpenOrderReservations()
      return `scanned=${r.scanned} released=${r.released} consumed=${r.consumed} alerted=${r.alerted} negAvail=${r.negativeAvailable}${r.capped ? ' (capped)' : ''}`
    }).catch((err) => {
      logger.error('reservation-reconcile cron: run failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('reservation-reconcile cron started', { schedule })
}
```

> **Implementer note:** confirm `recordCronRun(name, fn)` returns the handler result and that returning a string summary is the convention (it is — see other jobs like `fba-flip-guard.job.ts`). Mirror the exact import style of a sibling job.

- [ ] **Step 2: Register at boot** — `apps/api/src/index.ts`

Add the import next to `startReservationSweepCron`:

```ts
import { startReservationReconcileCron } from "./jobs/reservation-reconcile.job.js";
```

And call it where the other cron starts are invoked (next to `startReservationSweepCron()`):

```ts
startReservationReconcileCron();
```

> **Implementer note:** find the existing `startReservationSweepCron` import + call site in `index.ts` and place these immediately adjacent, mirroring the pattern.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit + push**

```bash
git add apps/api/src/jobs/reservation-reconcile.job.ts apps/api/src/index.ts
git commit -m "feat(inventory-sync): P3.3 hourly reservation-reconcile cron (NEXUS_RESERVATION_RECONCILE)"
git push
```

---

## Self-Review

**1. Spec coverage** — Spec Phase 3 (release-by-status for never-expiring OPEN_ORDER reservations + surface negative-available): Task 1 (the decision matrix), Task 2 (orchestrator using the existing idempotent ops + negative-available scan), Task 3 (cron). The blind 365-day TTL is now backstopped by a status-driven hourly reconciliation.

**2. Placeholder scan** — No vague steps. Three implementer notes are concrete signature confirmations (`releaseOpenOrder`/`consumeOpenOrder` return types + args; `recordCronRun` convention; `index.ts` call site) — necessary because they live in unchanged code.

**3. Type consistency** — `ReconcileAction` + `classifyOpenOrderReconciliation(string, number, number)` defined in Task 1, used in Task 2. `reconcileOpenOrderReservations(opts?): Promise<{…counts…}>` defined in Task 2, called in Task 3.

**Safety note:** the only stock mutations go through the existing idempotent `releaseOpenOrder`/`consumeOpenOrder`; the phase never writes stock directly. Auto-action is restricted to unambiguous statuses (CANCELLED→release, SHIPPED/DELIVERED→consume); everything ambiguous is alert-only. Flag `NEXUS_RESERVATION_RECONCILE=0` disables the cron entirely. The orchestrator is bounded (`maxOrders`, logged when capped).

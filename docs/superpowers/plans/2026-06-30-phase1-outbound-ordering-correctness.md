# Phase 1 — Outbound Ordering Correctness (kill last-writer-wins) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the last-writer-wins race where a stale quantity can overwrite a fresher one on a channel, by (a) re-reading the *current* `ChannelListing.quantity` at dispatch instead of pushing the snapshot captured at enqueue, and (b) coalescing superseded PENDING quantity rows so only the latest dispatches.

**Architecture:** Two small, independently-testable additions behind one kill-switch flag (`NEXUS_SYNC_ORDERING_V2`, default ON). A pure `resolveDispatchQuantity()` co-located in `outbound-sync.service.ts` (tested via the existing db-mocked suite), and a tiny isolated `sync-coalesce.ts` module (`coalescePendingQuantityRows()`) tested with a mock transaction. No schema migration: coalescing reuses the existing `OutboundSyncStatus.CANCELLED` value that `processSingle` already skips (the undo-grace path).

**Tech Stack:** Fastify/Prisma/BullMQ, Vitest, TypeScript (ESM, `.js` import extensions).

## Global Constraints

- **No schema migration.** Coalescing sets `syncStatus = 'CANCELLED'` (an existing enum value already handled by `processSingle` at `outbound-sync.service.ts:367`). Do not add columns or enum values.
- **FBA guard untouched.** The re-read only substitutes the quantity *value*; `isFbaListing()` and the FBA qty-skip in `buildAmazonListingPatch()` are unchanged. An FBA listing still drops the quantity patch regardless of the value.
- **Flag-guarded, default ON.** Both behaviors gate on `process.env.NEXUS_SYNC_ORDERING_V2 !== '0'`. Setting `NEXUS_SYNC_ORDERING_V2=0` restores the exact old behavior (kill-switch).
- **Coalesce targets `syncStatus = 'PENDING'` only** — never `IN_PROGRESS` (in-flight) or `CANCELLED`. Never touches FBA/non-quantity rows (`syncType = 'QUANTITY_UPDATE'` only).
- **Live channels are Amazon + eBay.** The dispatch re-read is wired for Amazon + eBay (both already fetch the `ChannelListing`). Shopify re-read is explicitly deferred (Shopify isn't transacting and its dispatch path doesn't currently fetch the listing) — coalescing still covers Shopify. Note this in code, don't silently skip it.
- **Branch only.** All work stays on `worktree-inventory-col`. No merge to main, no deploy, no live-gate flip without separate approval.
- Commit + push per task (pre-push hook builds `apps/api`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/outbound-sync.service.ts` (modify) | Add exported pure `resolveDispatchQuantity()`; wire the re-read (flag-guarded) into `syncToAmazon` + `syncToEbay`. |
| `apps/api/src/services/outbound-sync.vitest.test.ts` (modify) | Unit tests for `resolveDispatchQuantity`. |
| `apps/api/src/services/sync-coalesce.ts` (create) | Isolated `coalescePendingQuantityRows(tx, ids)` — the only logic, no heavy imports, trivially testable. |
| `apps/api/src/services/sync-coalesce.vitest.test.ts` (create) | Mock-transaction tests for the coalescer. |
| `apps/api/src/services/stock-movement.service.ts` (modify) | Call `coalescePendingQuantityRows(tx, cascadedListingIds)` inside the cascade tx, before `createMany` (flag-guarded). |

---

### Task 1: `resolveDispatchQuantity` pure helper + tests

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (add an exported function near the other exported pure helpers like `buildAmazonListingPatch`)
- Test: `apps/api/src/services/outbound-sync.vitest.test.ts`

**Interfaces:**
- Produces: `export function resolveDispatchQuantity(currentListingQty: number | null | undefined, payloadQty: number | null | undefined): number | undefined`

- [ ] **Step 1: Write the failing test** (append to `outbound-sync.vitest.test.ts`)

```ts
import { resolveDispatchQuantity } from './outbound-sync.service.js'

describe('Phase 1 — resolveDispatchQuantity (re-read latest at dispatch)', () => {
  it('prefers the current listing quantity over the stale payload snapshot', () => {
    expect(resolveDispatchQuantity(45, 50)).toBe(45)
  })
  it('treats 0 as a real current value (not falsy-skipped)', () => {
    expect(resolveDispatchQuantity(0, 50)).toBe(0)
  })
  it('falls back to the payload snapshot when current is null/undefined', () => {
    expect(resolveDispatchQuantity(null, 50)).toBe(50)
    expect(resolveDispatchQuantity(undefined, 50)).toBe(50)
  })
  it('returns undefined when neither is available', () => {
    expect(resolveDispatchQuantity(null, undefined)).toBeUndefined()
    expect(resolveDispatchQuantity(undefined, null)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts`
Expected: FAIL — `resolveDispatchQuantity` is not exported.

- [ ] **Step 3: Implement** (add near the other exported helpers in `outbound-sync.service.ts`)

```ts
/**
 * Phase 1 — at dispatch time, the freshest committed quantity is the current
 * ChannelListing.quantity (the cascade always updates it transactionally to the
 * latest value). Pushing that instead of the payload snapshot prevents a stale
 * in-flight job from overwriting a newer value (last-writer-wins). `0` is a real
 * value (out of stock) and must not be treated as falsy.
 */
export function resolveDispatchQuantity(
  currentListingQty: number | null | undefined,
  payloadQty: number | null | undefined,
): number | undefined {
  if (typeof currentListingQty === 'number') return currentListingQty
  return payloadQty ?? undefined
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts`
Expected: PASS (all prior + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/outbound-sync.service.ts apps/api/src/services/outbound-sync.vitest.test.ts
git commit -m "feat(inventory-sync): P1.1 resolveDispatchQuantity helper (re-read latest)"
```

---

### Task 2: `sync-coalesce` module + tests

**Files:**
- Create: `apps/api/src/services/sync-coalesce.ts`
- Test: `apps/api/src/services/sync-coalesce.vitest.test.ts`

**Interfaces:**
- Produces: `export async function coalescePendingQuantityRows(tx: { outboundSyncQueue: { updateMany: (args: any) => Promise<{ count: number }> } }, channelListingIds: string[]): Promise<number>`
  - (The narrow structural `tx` type keeps the module testable with a mock and free of heavy imports; the real `Prisma.TransactionClient` satisfies it.)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/sync-coalesce.vitest.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { coalescePendingQuantityRows } from './sync-coalesce.js'

describe('coalescePendingQuantityRows', () => {
  it('cancels prior PENDING QUANTITY_UPDATE rows for the given listings', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 })
    const tx = { outboundSyncQueue: { updateMany } }
    const n = await coalescePendingQuantityRows(tx, ['l1', 'l2'])
    expect(n).toBe(3)
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        channelListingId: { in: ['l1', 'l2'] },
        syncType: 'QUANTITY_UPDATE',
        syncStatus: 'PENDING',
      },
      data: { syncStatus: 'CANCELLED' },
    })
  })

  it('is a no-op (no query) for an empty listing set', async () => {
    const updateMany = vi.fn()
    const tx = { outboundSyncQueue: { updateMany } }
    const n = await coalescePendingQuantityRows(tx, [])
    expect(n).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && npx vitest run src/services/sync-coalesce.vitest.test.ts`
Expected: FAIL — `./sync-coalesce.js` not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/sync-coalesce.ts`:

```ts
/**
 * Phase 1 — coalesce superseded outbound quantity rows.
 *
 * When a stock movement cascades a fresh QUANTITY_UPDATE for a listing, any
 * older PENDING QUANTITY_UPDATE rows for the same listing are now stale. Mark
 * them CANCELLED (an existing OutboundSyncStatus value that processSingle
 * already skips — same mechanism as the undo-grace) so only the latest value
 * dispatches. Targets PENDING only: never an in-flight (IN_PROGRESS) row, never
 * a non-quantity sync, never FBA-specifics (those ride the same QUANTITY_UPDATE
 * rows and are handled at dispatch by the FBA guard).
 *
 * Runs inside the caller's transaction so the cancel + the fresh insert are atomic.
 */
type CoalesceTx = {
  outboundSyncQueue: {
    updateMany: (args: unknown) => Promise<{ count: number }>
  }
}

export async function coalescePendingQuantityRows(
  tx: CoalesceTx,
  channelListingIds: string[],
): Promise<number> {
  if (channelListingIds.length === 0) return 0
  const res = await tx.outboundSyncQueue.updateMany({
    where: {
      channelListingId: { in: channelListingIds },
      syncType: 'QUANTITY_UPDATE',
      syncStatus: 'PENDING',
    },
    data: { syncStatus: 'CANCELLED' },
  })
  return res.count
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/api && npx vitest run src/services/sync-coalesce.vitest.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sync-coalesce.ts apps/api/src/services/sync-coalesce.vitest.test.ts
git commit -m "feat(inventory-sync): P1.2 coalescePendingQuantityRows (cancel superseded)"
```

---

### Task 3: Wire both behaviors into the live paths (flag-guarded)

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (re-read in `syncToAmazon` + `syncToEbay`)
- Modify: `apps/api/src/services/stock-movement.service.ts` (coalesce call in `cascadeQuantityToListings`)

**Interfaces:**
- Consumes: `resolveDispatchQuantity` (Task 1), `coalescePendingQuantityRows` (Task 2).

- [ ] **Step 1: Coalesce in the cascade** — `stock-movement.service.ts`

Add the import at the top with the other service imports:

```ts
import { coalescePendingQuantityRows } from './sync-coalesce.js'
```

In `cascadeQuantityToListings`, inside the `if (queueRowsToCreate.length > 0) {` block, **immediately before** `await tx.outboundSyncQueue.createMany({ data: queueRowsToCreate })`, insert:

```ts
    // P1 — the listings that actually receive a fresh queue row this cascade.
    // Scope cancel == replace so coalesce can't cancel a pending row for a
    // channel that isn't getting a replacement (a cascaded listing on a
    // non-syncable channel is in cascadedListingIds but has no fresh row).
    const replacedListingIds = queueRowsToCreate
      .map((r) => r.channelListingId)
      .filter((id): id is string => Boolean(id))
    // P1 — cancel stale PENDING quantity rows for these listings before
    // inserting the fresh ones, so an older snapshot can't dispatch after the
    // new value. Same tx → atomic. Kill-switch: NEXUS_SYNC_ORDERING_V2=0.
    if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0') {
      await coalescePendingQuantityRows(tx, replacedListingIds)
    }
```

Then change the following `justEnqueued` query's `where.channelListingId.in` and `take` from `cascadedListingIds` to `replacedListingIds` so the re-query scope matches the fresh rows exactly.

> **Correction (reviewer P1.3 minor, applied 2026-06-30):** the original plan coalesced on `cascadedListingIds`, which is a superset (it includes cascaded listings on channels outside `validTargets`). Scoping to `replacedListingIds` (the listings in `queueRowsToCreate`) makes cancel-scope == replace-scope. For the in-scope channel set (Amazon/eBay/Shopify, all `validTargets`) the two sets are equal, so behavior is unchanged today; this removes a latent footgun if a future channel is cascaded but not synced.

- [ ] **Step 2: Re-read at dispatch — Amazon** — `outbound-sync.service.ts`, in `syncToAmazon`

**Immediately before** the line `const amazonPayload = buildAmazonListingPatch(payload, marketplaceId, productType, isFba ? "FBA" : "FBM");`, insert:

```ts
    // P1 — push the CURRENT listing quantity (the latest committed value), not
    // the stale enqueue-time snapshot. FBA listings still drop the qty patch
    // below regardless of value. Kill-switch: NEXUS_SYNC_ORDERING_V2=0.
    if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0' && cl && payload.quantity !== undefined) {
      payload.quantity = resolveDispatchQuantity(cl.quantity, payload.quantity);
    }
```

(`cl` is the `ChannelListing` already fetched earlier in `syncToAmazon`. `resolveDispatchQuantity` is in this same file — no import needed.)

- [ ] **Step 3: Re-read at dispatch — eBay** — `outbound-sync.service.ts`, in `syncToEbay`

In `syncToEbay`, after the `ChannelListing` (`cl`) is fetched and **before** the warehouse-available cap comparison (`if (payload.quantity > cap)`), insert:

```ts
    // P1 — base the eBay push on the CURRENT listing quantity, then apply the
    // warehouse cap below. Kill-switch: NEXUS_SYNC_ORDERING_V2=0.
    if (process.env.NEXUS_SYNC_ORDERING_V2 !== '0' && cl && payload.quantity !== undefined) {
      payload.quantity = resolveDispatchQuantity(cl.quantity, payload.quantity);
    }
```

> **Implementer note:** confirm the exact variable name for the fetched eBay `ChannelListing` in `syncToEbay` (the cap block reads `cl?.stockBuffer`, so it is `cl`). Place the insert after that `cl` is resolved and before the `cap` comparison. Do NOT add a re-read to `syncToShopify` (out of scope this phase — see Global Constraints).

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the touched suites**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts src/services/sync-coalesce.vitest.test.ts`
Expected: all green (the wiring doesn't change the pure helpers; this confirms no import/typo regressions).

- [ ] **Step 6: Commit + push**

```bash
git add apps/api/src/services/outbound-sync.service.ts apps/api/src/services/stock-movement.service.ts
git commit -m "feat(inventory-sync): P1.3 wire re-read + coalesce behind NEXUS_SYNC_ORDERING_V2"
git push
```

---

## Self-Review

**1. Spec coverage** — The spec's Phase 1 (decision §6.1: monotonic-by-value ordering + coalesce) is delivered as: re-read-latest (Tasks 1+3) + coalesce-superseded (Tasks 2+3). The plan deliberately implements the *re-read* form rather than a new `seq` column, achieving the same "newest value wins" guarantee with no migration (documented in Architecture). Airtight per-push sequence numbering is noted as a possible future hardening, not required for the race this phase closes.

**2. Placeholder scan** — No TBD/vague steps. The one "implementer note" (confirm the eBay `cl` variable + insert point) is a concrete placement instruction, not hand-waving.

**3. Type consistency** — `resolveDispatchQuantity(number|null|undefined, number|null|undefined): number|undefined` is defined in Task 1 and called identically in Task 3. `coalescePendingQuantityRows(tx, string[]): Promise<number>` defined in Task 2, called in Task 3 with `(tx, cascadedListingIds)`.

**Risk note:** Task 3 is the only behavior-changing step and the only one touching the hot path; it is fully flag-guarded (`NEXUS_SYNC_ORDERING_V2=0` = exact old behavior) and ships on the branch only. The FBA qty-skip is downstream of the re-read and unaffected (value substitution can't re-enable a dropped FBA patch).

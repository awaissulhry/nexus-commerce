# Phase 2 — Symmetric Hard Oversell Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** No FBM channel can publish more units than the warehouse can ship. eBay-FBM already clamps to the warehouse pool at dispatch; this phase adds the same clamp to **Amazon-FBM** (currently unclamped) and makes every clamp **emit an observable event** instead of clamping silently.

**Architecture:** A pure `applyOversellClamp(requested, available)` helper + a new `sync.oversell.clamped` event on the existing `order-events` bus (surfaced by RT alerting). Amazon-FBM gets a warehouse-pool fetch + clamp (mirroring eBay's existing `whRows` pattern), gated by `NEXUS_OVERSELL_CLAMP` (default ON). eBay keeps its always-on clamp but now emits the event. FBA listings are never clamped (Amazon owns that quantity; the FBA guard already drops the merchant-qty patch).

**Tech Stack:** Fastify/Prisma, the `order-events.service.ts` pub/sub bus, `available-to-publish.service.ts` (`computeAvailableToPublish`), Vitest, TypeScript (ESM `.js` imports).

## Global Constraints

- **FBA never clamped.** The clamp applies to FBM dispatch only. FBA listings keep the existing fail-closed qty-skip (`buildAmazonListingPatch` drops the patch). Never compute or push a merchant quantity for an FBA listing.
- **eBay must not regress.** eBay's existing warehouse cap stays always-on (it's pre-existing defence-in-depth). This phase only *adds* the event emission to it and refactors it to share the pure helper — the clamp value/behavior must be identical.
- **New Amazon clamp is flag-guarded** on `process.env.NEXUS_OVERSELL_CLAMP !== '0'` (default ON; `=0` = no Amazon clamp, exact pre-phase behavior).
- **Clamp math = `computeAvailableToPublish` semantics** for FBM: `available = max(0, warehouseAvailable − stockBuffer)`, where `warehouseAvailable = Σ StockLevel.available` over WAREHOUSE locations (already reserved-adjusted; `pendingReserved = 0` for FBM).
- **Observability only — never block ingestion.** Clamping reduces the pushed quantity; it must never throw or fail the sync. Emit-event failures are swallowed (logged), like the other bus emitters.
- Shopify dispatch clamp is **deferred** (not transacting; its dispatch path has no warehouse fetch) — note in code, don't silently skip.
- Branch only; no migration (the event is a TS union member, not a DB enum); no merge/deploy without separate approval. Commit + push per task.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/order-events.service.ts` (modify) | Add the `sync.oversell.clamped` variant to the `OrderEvent` union. |
| `apps/api/src/services/outbound-sync.service.ts` (modify) | Add exported pure `applyOversellClamp()`; wire the Amazon-FBM clamp (flag-guarded) + emit; refactor eBay clamp to the shared helper + emit. |
| `apps/api/src/services/outbound-sync.vitest.test.ts` (modify) | Unit tests for `applyOversellClamp`. |

---

### Task 1: `applyOversellClamp` pure helper + `sync.oversell.clamped` event type

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (add exported helper near `resolveDispatchQuantity`)
- Modify: `apps/api/src/services/order-events.service.ts` (extend the `OrderEvent` union)
- Test: `apps/api/src/services/outbound-sync.vitest.test.ts`

**Interfaces:**
- Produces: `export function applyOversellClamp(requested: number, available: number): { quantity: number; clamped: boolean }`
- Produces (event union member): `{ type: 'sync.oversell.clamped'; sku: string; channel: string; marketplace?: string | null; requested: number; clampedTo: number; available: number; ts: number }`

- [ ] **Step 1: Write the failing test** (append to `outbound-sync.vitest.test.ts`)

```ts
import { applyOversellClamp } from './outbound-sync.service.js'

describe('Phase 2 — applyOversellClamp', () => {
  it('clamps a request above available down to available', () => {
    expect(applyOversellClamp(50, 12)).toEqual({ quantity: 12, clamped: true })
  })
  it('passes through when request is within available', () => {
    expect(applyOversellClamp(8, 12)).toEqual({ quantity: 8, clamped: false })
  })
  it('is a no-op at exact equality', () => {
    expect(applyOversellClamp(12, 12)).toEqual({ quantity: 12, clamped: false })
  })
  it('clamps to 0 when nothing is available', () => {
    expect(applyOversellClamp(5, 0)).toEqual({ quantity: 0, clamped: true })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts`
Expected: FAIL — `applyOversellClamp` not exported.

- [ ] **Step 3: Implement the helper** (in `outbound-sync.service.ts`, near `resolveDispatchQuantity`)

```ts
/**
 * Phase 2 — hard oversell guard. Clamp a requested dispatch quantity to what
 * the backing pool can actually ship. `clamped` flags an overshoot so the
 * caller can emit a sync.oversell.clamped event (never silent). Pure.
 */
export function applyOversellClamp(
  requested: number,
  available: number,
): { quantity: number; clamped: boolean } {
  if (requested > available) return { quantity: available, clamped: true }
  return { quantity: requested, clamped: false }
}
```

- [ ] **Step 4: Extend the `OrderEvent` union** in `order-events.service.ts`

Add this member to the `export type OrderEvent =` union (place it next to the other `sync.*` members like `sync.dlq.threshold`):

```ts
  // P2 — an outbound push was clamped to the backing pool (oversell prevented).
  // Surfaced via RT alerting so a clamp is never silent.
  | {
      type: 'sync.oversell.clamped'
      sku: string
      channel: string
      marketplace?: string | null
      requested: number
      clampedTo: number
      available: number
      ts: number
    }
```

- [ ] **Step 5: Run it, verify it passes**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts` → PASS (all prior + 4 new).
Then: `cd apps/api && npx tsc --noEmit` → no errors (confirms the union extension typechecks).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/outbound-sync.service.ts apps/api/src/services/outbound-sync.vitest.test.ts apps/api/src/services/order-events.service.ts
git commit -m "feat(inventory-sync): P2.1 applyOversellClamp helper + sync.oversell.clamped event"
```

---

### Task 2: Wire the Amazon-FBM clamp (flag-guarded) + emit

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (`syncToAmazon`)

**Interfaces:**
- Consumes: `applyOversellClamp` (Task 1), `computeAvailableToPublish` (from `./available-to-publish.service.js`), `publishOrderEvent` (from `./order-events.service.js`).

Notes (verified): `syncToAmazon` already computes `isFba` and (Phase 1) re-reads `payload.quantity = resolveDispatchQuantity(cl.quantity, payload.quantity)` right before `const amazonPayload = buildAmazonListingPatch(...)`. The Amazon path has **no** warehouse fetch today — add one for the FBM clamp, mirroring eBay's `whRows` query.

- [ ] **Step 1: Add the imports** at the top of `outbound-sync.service.ts` (if not already present)

```ts
import { computeAvailableToPublish } from './available-to-publish.service.js'
import { publishOrderEvent } from './order-events.service.js'
```

- [ ] **Step 2: Insert the Amazon-FBM clamp** — in `syncToAmazon`, **after** the Phase-1 re-read line (`payload.quantity = resolveDispatchQuantity(cl.quantity, payload.quantity)`) and **before** `const amazonPayload = buildAmazonListingPatch(...)`:

```ts
    // P2 — hard oversell guard for Amazon-FBM. FBA is never clamped (Amazon
    // owns the qty; buildAmazonListingPatch drops the patch for FBA anyway).
    // Kill-switch: NEXUS_OVERSELL_CLAMP=0.
    if (
      process.env.NEXUS_OVERSELL_CLAMP !== '0' &&
      !isFba &&
      payload.quantity !== undefined &&
      product?.id
    ) {
      const whRows = await prisma.stockLevel.findMany({
        where: { productId: product.id, location: { type: 'WAREHOUSE' } },
        select: { available: true },
      })
      const warehouseAvailable = whRows.reduce((s, r) => s + (r.available ?? 0), 0)
      const { available } = computeAvailableToPublish({
        fulfillmentMethod: 'FBM',
        warehouseAvailable,
        fbaSellable: 0,
        stockBuffer: cl?.stockBuffer ?? 0,
      })
      const { quantity, clamped } = applyOversellClamp(payload.quantity, available)
      if (clamped) {
        payload.quantity = quantity
        try {
          publishOrderEvent({
            type: 'sync.oversell.clamped',
            sku,
            channel: 'AMAZON',
            marketplace: marketplaceId,
            requested: payload.quantity, // already clamped — see note below
            clampedTo: quantity,
            available,
            ts: Date.now(),
          })
        } catch { /* observability must never break the sync */ }
      }
    }
```

> **Implementer note:** capture the pre-clamp value BEFORE reassigning `payload.quantity` so the event's `requested` is the original request, not the clamped value. i.e. read `const requested = payload.quantity` at the top of the block and use it in both `applyOversellClamp(requested, available)` and the event's `requested: requested`. Also confirm `sku` and `marketplaceId` are in scope in `syncToAmazon` (they are — `sku` is derived near the top, `marketplaceId` is resolved for the patch).

- [ ] **Step 3: Typecheck + tests**

Run: `cd apps/api && npx tsc --noEmit` → no errors.
Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/outbound-sync.service.ts
git commit -m "feat(inventory-sync): P2.2 Amazon-FBM oversell clamp + emit (NEXUS_OVERSELL_CLAMP)"
```

---

### Task 3: Refactor eBay clamp to the shared helper + emit

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (`syncToEbay`)

Notes: `syncToEbay` already computes `warehouseAvailable` (from `whRows`) and `cap`, then `if (payload.quantity > cap) { ...log...; payload.quantity = cap }`. Replace that inline clamp with `applyOversellClamp` and emit the event on clamp. The clamp VALUE must stay identical (`cap` = `available`).

- [ ] **Step 1: Replace the inline eBay cap** — find the existing block:

```ts
        if (payload.quantity > cap) {
          logger.warn(
            `[EBAY] capping ${sku} quantity ${payload.quantity} -> ${cap} (warehouse available ${warehouseAvailable}, buffer ${cl?.stockBuffer ?? 0})`,
          );
          payload.quantity = cap;
        }
```

Replace it with:

```ts
        const requested = payload.quantity
        const { quantity: clampedQty, clamped } = applyOversellClamp(requested, cap)
        if (clamped) {
          logger.warn(
            `[EBAY] capping ${sku} quantity ${requested} -> ${clampedQty} (warehouse available ${warehouseAvailable}, buffer ${cl?.stockBuffer ?? 0})`,
          );
          payload.quantity = clampedQty;
          try {
            publishOrderEvent({
              type: 'sync.oversell.clamped',
              sku,
              channel: 'EBAY',
              marketplace: marketplaceId,
              requested,
              clampedTo: clampedQty,
              available: cap,
              ts: Date.now(),
            })
          } catch { /* observability must never break the sync */ }
        }
```

> **Implementer note:** confirm the exact variable names in `syncToEbay` (`cap`, `warehouseAvailable`, `cl`, `sku`, `marketplaceId`) and that this block sits inside the `if (payload.quantity !== undefined && product?.id)` guard where `cap` is defined. `applyOversellClamp` + `publishOrderEvent` are already imported from Task 1/2 — do not duplicate imports. The clamp value is unchanged (`cap`), so eBay behavior is identical except for the added event.

- [ ] **Step 2: Typecheck + tests**

Run: `cd apps/api && npx tsc --noEmit` → no errors.
Run: `cd apps/api && npx vitest run src/services/outbound-sync.vitest.test.ts` → green.

- [ ] **Step 3: Commit + push**

```bash
git add apps/api/src/services/outbound-sync.service.ts
git commit -m "feat(inventory-sync): P2.3 eBay clamp via shared helper + emit oversell event"
git push
```

---

## Self-Review

**1. Spec coverage** — Spec §6.2 (single oversell chokepoint, hard-block & clamp, applied to eBay + Amazon-FBM, FBA never clamped, emit-on-clamp): Task 1 (pure helper + event), Task 2 (Amazon-FBM clamp+emit), Task 3 (eBay emit + shared helper). Shopify deferred per Global Constraints (not transacting). The "single chokepoint" is the shared `applyOversellClamp` + `computeAvailableToPublish` pair, used identically by both channels.

**2. Placeholder scan** — No vague steps. The two implementer notes are concrete (capture pre-clamp `requested`; confirm in-scope variable names) — required because the exact surrounding variable names live in unchanged code.

**3. Type consistency** — `applyOversellClamp(number, number): { quantity, clamped }` defined in Task 1, used identically in Tasks 2-3. The `sync.oversell.clamped` event shape (Task 1) matches both `publishOrderEvent` call sites (Tasks 2-3): `sku/channel/marketplace/requested/clampedTo/available/ts`.

**Risk note:** Amazon-FBM clamp is the only new behavior and is flag-guarded (`NEXUS_OVERSELL_CLAMP=0` disables). eBay's clamp value is unchanged (only an event is added). FBA is explicitly excluded from both. The extra warehouse query in `syncToAmazon` runs once per FBM Amazon dispatch — acceptable (mirrors eBay).

## Operator runbook note (from consolidated review)

- `NEXUS_OVERSELL_CLAMP=0` disables only the **Amazon-FBM** clamp. eBay's warehouse clamp is pre-existing defence-in-depth and stays **unconditional**, and its new `sync.oversell.clamped` emission is likewise unconditional. So with both `NEXUS_OVERSELL_CLAMP=0` and `NEXUS_SYNC_ORDERING_V2=0` the **pushed quantities** are byte-identical to pre-change, but the eBay path may still emit `sync.oversell.clamped` events on RT alerting (it only fires when eBay was *already* clamping silently before — i.e. it surfaces a previously-hidden oversell condition, it does not change what's pushed). Don't be alarmed by these events when the kill-switches are flipped.
- `sync.oversell.clamped` events are advisory observability (an oversell was *prevented*); they are not failures.

# Channel/Market-Scoped Removal + Inventory Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "remove" in each flat-file editor affect **only that channel + market's listing** — never the shared `Product`, its stock, or other channels' listings — fixing the bug where deleting from the eBay flat file removes the SKU from the Amazon flat file too.

**Architecture:** Add a channel/market-scoped removal path that deletes a `ChannelListing` row (best-effort delists it) while leaving the `Product` untouched. eBay: a new `remove-channel-listing` intent in the existing delete service, made the default for normal rows (shared-variant rows keep `remove-listing`). Amazon: a new `removeAmazonListing` service + `POST /api/amazon/flat-file/remove` route, replacing the editor's cosmetic (local-only) delete. Every removal is protected by an inventory-invariant test that fails if `Product` is ever mutated.

**Tech Stack:** Fastify (apps/api, Node ESM), Prisma (packages/database), Next.js/React (apps/web), Vitest. Mock-prisma unit tests (no live DB).

## Global Constraints

- **Inventory invariant (I2/I3):** no removal operation may mutate `Product` (no `deletedAt`, no stock/SKU change). Removal touches only `ChannelListing`. `Product.deletedAt` stays reachable only via the explicit (future Action-column) "Delete product" verb — NOT built here.
- **ESM:** every relative import in `apps/api` ends in `.js` (Node ESM crash-loops otherwise).
- **Untouchable-file exception:** edits to `apps/web/src/app/products/{amazon,ebay}-flat-file/` are permitted for THIS plan only, additive and surgical (spec `docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md` is the approval).
- **Design-system primitives** only for any new UI (`apps/web/src/design-system`); no hand-rolled modals/buttons.
- **Do NOT touch** the FF2 workbook v2 engine, config/OAuth/marketplace tables, or the scoped-load queries (that is Plan 2).
- **Commit + push** after each task (this plan is doc/code, no migrations/destructive ops).
- Verify locally with `cd apps/api && npx vitest run <file>` + `npx tsc -p apps/api/tsconfig.json --noEmit`; web with `npx tsc -p apps/web/tsconfig.json --noEmit`.

---

## File Structure

**Modified (apps/api):**
- `src/services/ebay-flat-file-delete.service.ts` — add `remove-channel-listing` intent + `channelListing` to the injectable prisma interface + `channelListingsRemoved` on the result.
- `src/services/ebay-flat-file-delete.service.vitest.test.ts` — add isolation + inventory-guard tests.
- `src/routes/amazon-flat-file.routes.ts` — add `POST /amazon/flat-file/remove`.

**Created (apps/api):**
- `src/services/amazon/amazon-flat-file-remove.service.ts` — `removeAmazonListing(prisma, target)`.
- `src/services/amazon/amazon-flat-file-remove.service.vitest.test.ts` — tests.

**Modified (apps/web — untouchable exception, surgical):**
- `src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` — `DeleteIntent` union + `deriveDeleteIntent` default → `remove-channel-listing`; confirm-modal copy → "Remove from eBay {market}".
- `src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` — wire the delete action to `POST /amazon/flat-file/remove` with a confirm, replacing the local-only removal.

**Docs / tracking:**
- `.superpowers/sdd/scoped-removal-progress.md` — progress ledger.

---

## Task 1: eBay `remove-channel-listing` intent (service)

**Files:**
- Modify: `apps/api/src/services/ebay-flat-file-delete.service.ts`
- Test: `apps/api/src/services/ebay-flat-file-delete.service.vitest.test.ts`

**Interfaces:**
- Consumes: existing `runEbayFlatFileDelete(prisma, targets)`, `tryDelist(itemId, marketplace, productId?)`.
- Produces: new intent value `'remove-channel-listing'`; `EbayDeletePrisma.channelListing: { findMany; deleteMany }`; `DeleteTargetResult.channelListingsRemoved?: number`.

- [ ] **Step 1: Write the failing tests**

Add to `ebay-flat-file-delete.service.vitest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runEbayFlatFileDelete } from './ebay-flat-file-delete.service.js'

describe('remove-channel-listing — channel/market isolation + inventory guard', () => {
  function guardPrisma(deleteManyAssert: (args: any) => void) {
    // product has NO update/updateMany → any attempt to soft-delete throws → guard.
    return {
      product: {
        findFirst: async () => ({ id: 'p1', sku: 'SKU1', ebayItemId: null }),
        findMany: async () => [],                       // no children
      },
      sharedListingMembership: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      channelListing: {
        findMany: async () => [{ externalListingId: 'IT-ITEM-1' }],
        deleteMany: async (a: any) => { deleteManyAssert(a); return { count: 1 } },
      },
      $transaction: async (fn: any) => fn({
        product: {
          update: () => { throw new Error('Product.update must NOT be called (inventory guard)') },
          updateMany: () => { throw new Error('Product.updateMany must NOT be called') },
        },
        sharedListingMembership: { deleteMany: async () => ({ count: 0 }) },
        channelListing: { deleteMany: async (a: any) => { deleteManyAssert(a); return { count: 1 } } },
      }),
    }
  }

  it('removes only the EBAY listing for the target marketplace; Product untouched', async () => {
    const prisma = guardPrisma((a) => {
      expect(a.where.channel).toBe('EBAY')
      expect(a.where.marketplace).toBe('IT')
    })
    const [res] = await runEbayFlatFileDelete(prisma as any, [
      { sku: 'SKU1', productId: 'p1', marketplace: 'IT', intent: 'remove-channel-listing' },
    ])
    expect(res.error).toBeUndefined()
    expect(res.intent).toBe('remove-channel-listing')
    expect(res.softDeleted).toEqual([])          // inventory guard: nothing soft-deleted
    expect(res.channelListingsRemoved).toBe(1)
  })

  it('errors (does not throw) when the product is missing', async () => {
    const prisma = guardPrisma(() => {})
    ;(prisma.product as any).findFirst = async () => null
    const [res] = await runEbayFlatFileDelete(prisma as any, [
      { sku: 'GONE', marketplace: 'IT', intent: 'remove-channel-listing' },
    ])
    expect(res.error).toMatch(/not found/i)
    expect(res.channelListingsRemoved).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/ebay-flat-file-delete.service.vitest.test.ts`
Expected: FAIL — `'remove-channel-listing'` is not an accepted intent (falls through to the unknown-intent branch / type error).

- [ ] **Step 3: Extend the types**

In `ebay-flat-file-delete.service.ts`, extend the `DeleteIntent` union and results/interfaces:

```ts
export type DeleteIntent =
  | 'delete-product'
  | 'delete-family'
  | 'remove-listing'
  | 'remove-channel-listing' // NEW: channel+market-scoped; ChannelListing only, Product untouched
```

Add to `DeleteTargetResult`:

```ts
export interface DeleteTargetResult {
  sku: string
  intent: DeleteIntent
  softDeleted: string[]
  membershipsRemoved: number
  channelListingsRemoved?: number // NEW
  delisted: boolean
  error?: string
}
```

Add a `ChannelListingTable` interface and thread it into `EbayDeletePrisma` (both top-level and the `$transaction` tx shape):

```ts
interface ChannelListingTable {
  findMany(args: unknown): Promise<unknown[]>
  deleteMany(args: unknown): Promise<{ count: number }>
}

export interface EbayDeletePrisma {
  product: ProductTable
  sharedListingMembership: MembershipTable
  channelListing: ChannelListingTable // NEW
  $transaction<T>(
    fn: (tx: {
      product: ProductTable
      sharedListingMembership: MembershipTable
      channelListing: ChannelListingTable // NEW
    }) => Promise<T>,
  ): Promise<T>
}
```

- [ ] **Step 4: Add the handler + dispatch**

Add the `case` in `processTarget`'s switch (alongside the existing intents):

```ts
    case 'remove-channel-listing':
      return handleRemoveChannelListing(prisma, target)
```

Add the handler (mirrors `handleDeleteFamily`'s family gathering, but deletes `ChannelListing`, never `Product`):

```ts
// ── remove-channel-listing ───────────────────────────────────────────────────
// Channel+market-scoped: removes the EBAY ChannelListing(s) for this row's
// product (and its children when the row is a parent) in ONE marketplace.
// The Product is intentionally never modified — inventory invariant (I2/I3).
async function handleRemoveChannelListing(
  prisma: EbayDeletePrisma,
  target: DeleteTarget,
): Promise<DeleteTargetResult> {
  const { sku, marketplace, productId } = target

  const product = (await prisma.product.findFirst({
    where: productId ? { id: productId } : { sku },
    select: { id: true, sku: true, ebayItemId: true },
  } as any)) as { id: string; sku: string; ebayItemId?: string | null } | null

  if (!product) {
    return {
      sku,
      intent: 'remove-channel-listing',
      softDeleted: [],
      membershipsRemoved: 0,
      channelListingsRemoved: 0,
      delisted: false,
      error: `Product not found: ${productId ?? sku}`,
    }
  }

  // Parent row → include non-deleted children so "remove from eBay {market}"
  // clears the whole family's presence in that one market.
  const children = (await prisma.product.findMany({
    where: { parentId: product.id, deletedAt: null },
    select: { id: true },
  } as any)) as Array<{ id: string }>
  const productIds = [product.id, ...children.map((c) => c.id)]

  // Collect ItemIDs for best-effort delist BEFORE the listings are deleted.
  const listings = (await prisma.channelListing.findMany({
    where: { productId: { in: productIds }, channel: 'EBAY', marketplace },
    select: { externalListingId: true },
  } as any)) as Array<{ externalListingId: string | null }>

  let channelListingsRemoved = 0
  await prisma.$transaction(async (tx) => {
    const del = await tx.channelListing.deleteMany({
      where: { productId: { in: productIds }, channel: 'EBAY', marketplace },
    } as any)
    channelListingsRemoved = (del as { count: number }).count
    // Product is intentionally NOT modified here.
  })

  const delistIds = new Set<string>(
    [
      ...listings.map((l) => l.externalListingId),
      product.ebayItemId ?? null,
    ].filter((x): x is string => Boolean(x)),
  )
  let delisted = false
  for (const iid of delistIds) {
    const ok = await tryDelist(iid, marketplace, product.id)
    if (ok) delisted = true
  }

  return {
    sku: product.sku,
    intent: 'remove-channel-listing',
    softDeleted: [],
    membershipsRemoved: 0,
    channelListingsRemoved,
    delisted,
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/ebay-flat-file-delete.service.vitest.test.ts`
Expected: PASS (all, including the pre-existing intent tests). Then `npx tsc -p apps/api/tsconfig.json --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/ebay-flat-file-delete.service.ts apps/api/src/services/ebay-flat-file-delete.service.vitest.test.ts
git commit -m "feat(ebay): remove-channel-listing intent — channel/market-scoped removal, Product untouched"
```

---

## Task 2: eBay client — default normal-row delete → scoped removal

**Files:**
- Modify: `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` (`DeleteIntent` L432; `deriveDeleteIntent` L435-453; `EbayDeleteConfirmModal` L474+)

**Interfaces:**
- Consumes: `POST /api/ebay/flat-file/delete` (unchanged endpoint; now accepts `intent: 'remove-channel-listing'` from Task 1).
- Produces: normal (non-shared) rows send `intent: 'remove-channel-listing'`; shared rows unchanged (`remove-listing`).

- [ ] **Step 1: Extend the client `DeleteIntent` union (L432)**

```ts
type DeleteIntent = 'delete-product' | 'delete-family' | 'remove-listing' | 'remove-channel-listing'
```

- [ ] **Step 2: Change the default in `deriveDeleteIntent` (L435-453)**

Replace the body so shared rows stay membership-scoped and everything else becomes channel/market-scoped (the service resolves parent-vs-child family scope itself, so the client no longer needs the `delete-family`/`delete-product` split for the intent):

```ts
function deriveDeleteIntent(row: EbayRow, _allRows: EbayRow[]): DeleteIntent {
  // Synthesized shared-membership rows → remove just that membership.
  if (row._shared === true) return 'remove-listing'
  // All other rows → remove ONLY this channel+market's listing (Product untouched).
  return 'remove-channel-listing'
}
```

(`countFamilyChildren` L455-465 stays — the confirm modal still uses it for the "…and N variants" message.)

- [ ] **Step 3: Update the confirm-modal copy (`EbayDeleteConfirmModal`, L474+)**

Reword the modal so it reads as a channel-scoped removal, not a product deletion. Replace the family/variant heading text with copy that names the marketplace and makes clear the product itself is kept. Minimum change — the heading/description strings:

```tsx
// Heading:
<h2>Remove from eBay {marketplace}</h2>
// Body (per row / summary):
<p>
  This removes {familyCount > 0
    ? `${familyCount} listing${familyCount === 1 ? '' : 's'} (and ${variantCount} variant${variantCount === 1 ? '' : 's'})`
    : `${variantCount} listing${variantCount === 1 ? '' : 's'}`} from eBay {marketplace}.
  The product and its stock stay in Nexus, and other channels are untouched.
</p>
```

Pass `marketplace` into `EbayDeleteConfirmModal` (it is already in scope at the call site, L2336-2337) as a prop if not already present.

- [ ] **Step 4: Verify types + behavior**

Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit`
Expected: clean. Manual: the delete confirm now reads "Remove from eBay {market}"; the request payload carries `intent: "remove-channel-listing"` for normal rows (verify in the Network tab against prod after deploy).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
git commit -m "feat(ebay-flat-file): delete button removes only this channel+market's listing (scoped)"
```

---

## Task 3: Amazon `removeAmazonListing` service

**Files:**
- Create: `apps/api/src/services/amazon/amazon-flat-file-remove.service.ts`
- Test: `apps/api/src/services/amazon/amazon-flat-file-remove.service.vitest.test.ts`

**Interfaces:**
- Consumes: `dispatchChannelDelist(job)` from `../channel-delist.service.js` (supports `targetChannel: 'AMAZON'`).
- Produces: `removeAmazonListing(prisma, { productId, marketplace }): Promise<RemoveAmazonResult>` where `RemoveAmazonResult = { productId; marketplace; channelListingsRemoved; delisted; error? }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { removeAmazonListing } from './amazon-flat-file-remove.service.js'

describe('removeAmazonListing — market-scoped, Product untouched', () => {
  it('removes only the AMAZON listing for the target marketplace', async () => {
    const seen: any = {}
    const prisma = {
      product: {
        findFirst: async () => ({ id: 'p1', amazonAsin: 'B00TEST' }),
        findMany: async () => [],               // no children
      },
      channelListing: {
        findMany: async () => [{ externalListingId: 'B00TEST' }],
        deleteMany: async (a: any) => { seen.where = a.where; return { count: 1 } },
      },
      // No product.update anywhere → soft-delete is structurally impossible (guard).
      $transaction: async (fn: any) => fn({
        channelListing: { deleteMany: async (a: any) => { seen.txWhere = a.where; return { count: 1 } } },
      }),
    }
    const res = await removeAmazonListing(prisma as any, { productId: 'p1', marketplace: 'IT' })
    expect(res.error).toBeUndefined()
    expect(res.channelListingsRemoved).toBe(1)
    expect(seen.txWhere.channel).toBe('AMAZON')
    expect(seen.txWhere.marketplace).toBe('IT')
  })

  it('returns an error (no throw) when product is missing', async () => {
    const prisma = {
      product: { findFirst: async () => null, findMany: async () => [] },
      channelListing: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      $transaction: async (fn: any) => fn({ channelListing: { deleteMany: async () => ({ count: 0 }) } }),
    }
    const res = await removeAmazonListing(prisma as any, { productId: 'nope', marketplace: 'IT' })
    expect(res.error).toMatch(/not found/i)
    expect(res.channelListingsRemoved).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/amazon/amazon-flat-file-remove.service.vitest.test.ts`
Expected: FAIL — module `./amazon-flat-file-remove.service.js` not found.

- [ ] **Step 3: Implement the service**

```ts
// apps/api/src/services/amazon/amazon-flat-file-remove.service.ts
/**
 * Market-scoped Amazon listing removal. Deletes the AMAZON ChannelListing(s)
 * for a product (and its children when it is a parent) in ONE marketplace,
 * best-effort delists, and NEVER modifies the Product (inventory invariant).
 */
import { dispatchChannelDelist } from '../channel-delist.service.js'

export interface RemoveAmazonTarget { productId: string; marketplace: string }
export interface RemoveAmazonResult {
  productId: string
  marketplace: string
  channelListingsRemoved: number
  delisted: boolean
  error?: string
}

interface RemovePrisma {
  product: {
    findFirst(a: unknown): Promise<unknown>
    findMany(a: unknown): Promise<unknown[]>
  }
  channelListing: {
    findMany(a: unknown): Promise<unknown[]>
    deleteMany(a: unknown): Promise<{ count: number }>
  }
  $transaction<T>(
    fn: (tx: { channelListing: { deleteMany(a: unknown): Promise<{ count: number }> } }) => Promise<T>,
  ): Promise<T>
}

export async function removeAmazonListing(
  prisma: RemovePrisma,
  target: RemoveAmazonTarget,
): Promise<RemoveAmazonResult> {
  const { productId, marketplace } = target

  const product = (await prisma.product.findFirst({
    where: { id: productId },
    select: { id: true },
  } as any)) as { id: string } | null

  if (!product) {
    return { productId, marketplace, channelListingsRemoved: 0, delisted: false, error: `Product not found: ${productId}` }
  }

  const children = (await prisma.product.findMany({
    where: { parentId: product.id, deletedAt: null },
    select: { id: true },
  } as any)) as Array<{ id: string }>
  const ids = [product.id, ...children.map((c) => c.id)]

  const listings = (await prisma.channelListing.findMany({
    where: { productId: { in: ids }, channel: 'AMAZON', marketplace },
    select: { externalListingId: true },
  } as any)) as Array<{ externalListingId: string | null }>

  let channelListingsRemoved = 0
  await prisma.$transaction(async (tx) => {
    const del = await tx.channelListing.deleteMany({
      where: { productId: { in: ids }, channel: 'AMAZON', marketplace },
    } as any)
    channelListingsRemoved = (del as { count: number }).count
    // Product intentionally untouched.
  })

  let delisted = false
  for (const l of listings) {
    if (!l.externalListingId) continue
    try {
      const r = await dispatchChannelDelist({
        queueId: `amz-rm-${product.id}-${marketplace}`,
        productId: product.id,
        channelListingId: null,
        targetChannel: 'AMAZON',
        targetRegion: marketplace,
        externalListingId: l.externalListingId,
        syncType: 'DELETE_LISTING',
        payload: { channelAction: 'delete' },
      } as any)
      if ((r as { success?: boolean })?.success) delisted = true
    } catch { /* best-effort; never blocks the committed removal */ }
  }

  return { productId, marketplace, channelListingsRemoved, delisted }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/amazon/amazon-flat-file-remove.service.vitest.test.ts` → PASS. Then `npx tsc -p apps/api/tsconfig.json --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/amazon/amazon-flat-file-remove.service.ts apps/api/src/services/amazon/amazon-flat-file-remove.service.vitest.test.ts
git commit -m "feat(amazon): removeAmazonListing — market-scoped removal, Product untouched"
```

---

## Task 4: Amazon `POST /amazon/flat-file/remove` route

**Files:**
- Modify: `apps/api/src/routes/amazon-flat-file.routes.ts`

**Interfaces:**
- Consumes: `removeAmazonListing` (Task 3), the route's existing `prisma` instance.
- Produces: `POST /api/amazon/flat-file/remove` with body `{ targets: Array<{ productId: string; marketplace: string }> }` → `{ results: RemoveAmazonResult[] }`.

- [ ] **Step 1: Add the import (top of file, `.js` extension)**

```ts
import { removeAmazonListing } from '../services/amazon/amazon-flat-file-remove.service.js'
```

- [ ] **Step 2: Register the route** (near the other `fastify.post('/amazon/flat-file/...')` handlers)

```ts
fastify.post<{ Body: { targets?: Array<{ productId: string; marketplace: string }> } }>(
  '/amazon/flat-file/remove',
  async (request, reply) => {
    const targets = request.body?.targets ?? []
    const results = []
    for (const t of targets) {
      if (!t?.productId || !t?.marketplace) {
        results.push({ productId: t?.productId ?? '', marketplace: t?.marketplace ?? '', channelListingsRemoved: 0, delisted: false, error: 'productId and marketplace are required' })
        continue
      }
      results.push(await removeAmazonListing(prisma, t))
    }
    return reply.send({ results })
  },
)
```

- [ ] **Step 3: Verify it compiles + a smoke test**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit` → clean.
Add a minimal route-level test only if the file already has a route test harness; otherwise the service test (Task 3) is the coverage and this step is the tsc check plus a manual `curl` against the deployed API after push:
`curl -sX POST "$API/api/amazon/flat-file/remove" -H 'content-type: application/json' -d '{"targets":[]}'` → `{"results":[]}`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/amazon-flat-file.routes.ts
git commit -m "feat(amazon): POST /amazon/flat-file/remove route (market-scoped listing removal)"
```

---

## Task 5: Amazon client — wire delete to the real removal endpoint

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (`deleteSelected` L2836; `onDeleteRows` call site L5778)

**Interfaces:**
- Consumes: `POST /api/amazon/flat-file/remove` (Task 4); the client's current `marketplace` and selected rows (each row carries a product id — confirm the field name in-file, e.g. `_productId`/`productId`).
- Produces: persistent market-scoped removal + a design-system confirm dialog, replacing the local-only `setRows` behavior.

- [ ] **Step 1: Add a confirm + fetch removal handler**

Replace the cosmetic body of the delete path so it (a) opens a DS confirm dialog naming the marketplace, (b) on confirm POSTs the selected rows' product ids, (c) removes the rows from the grid only after a successful response. Concrete handler (adapt the row→productId accessor to the in-file field name):

```tsx
const removeFromAmazon = useCallback(async (rowsToRemove: AmazonRow[]) => {
  const targets = rowsToRemove
    .map((r) => ({ productId: String((r as any)._productId ?? (r as any).productId ?? ''), marketplace }))
    .filter((t) => t.productId)
  if (!targets.length) return
  try {
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { results } = await res.json() as { results: Array<{ productId: string; channelListingsRemoved: number; error?: string }> }
    const removedIds = new Set(results.filter((r) => !r.error && r.channelListingsRemoved > 0).map((r) => r.productId))
    setRows((prev) => prev.filter((r) => !removedIds.has(String((r as any)._productId ?? (r as any).productId ?? ''))))
    const removed = removedIds.size
    toast.success(`Removed ${removed} listing${removed === 1 ? '' : 's'} from Amazon ${marketplace} — product and stock kept.`)
  } catch (err) {
    toast.error('Remove from Amazon failed: ' + (err instanceof Error ? err.message : String(err)))
  }
}, [marketplace, setRows, toast])
```

- [ ] **Step 2: Route the delete UI through a confirm**

Change `deleteSelected` (L2836) and the `onDeleteRows` handler (L5778) so that instead of only calling `setRows(...)` they open a DS confirm modal ("Remove N listing(s) from Amazon {marketplace}? The product and its stock stay in Nexus; other channels are untouched.") whose confirm action calls `removeFromAmazon(selectedRows)`. Reuse the existing modal/confirm primitive already imported in this file (match the pattern used elsewhere in the client); do not hand-roll.

- [ ] **Step 3: Verify**

Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit` → clean.
Manual (after deploy): deleting an Amazon row now persists (does NOT reappear on reload) and the same SKU still shows in the eBay editor.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx
git commit -m "feat(amazon-flat-file): delete removes the Amazon listing for this market (persistent, scoped)"
```

---

## Task 6: Cross-channel isolation proof + docs + ledger

**Files:**
- Test: `apps/api/src/services/ebay-flat-file-delete.service.vitest.test.ts` (add one summary test)
- Create: `.superpowers/sdd/scoped-removal-progress.md`
- Modify: `docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md` (mark Plan 1 delivered)

- [ ] **Step 1: Add the headline isolation test**

```ts
describe('inventory + cross-channel isolation (Plan 1 headline invariant)', () => {
  it('remove-channel-listing removes eBay/IT only and reports zero soft-deletes', async () => {
    const calls: string[] = []
    const prisma = {
      product: { findFirst: async () => ({ id: 'p1', sku: 'X', ebayItemId: null }), findMany: async () => [] },
      sharedListingMembership: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      channelListing: {
        findMany: async () => [],
        deleteMany: async (a: any) => { calls.push(`${a.where.channel}/${a.where.marketplace}`); return { count: 1 } },
      },
      $transaction: async (fn: any) => fn({
        product: { update: () => { throw new Error('guard') }, updateMany: () => { throw new Error('guard') } },
        sharedListingMembership: { deleteMany: async () => ({ count: 0 }) },
        channelListing: { deleteMany: async (a: any) => { calls.push(`${a.where.channel}/${a.where.marketplace}`); return { count: 1 } } },
      }),
    }
    const [res] = await runEbayFlatFileDelete(prisma as any, [{ sku: 'X', productId: 'p1', marketplace: 'IT', intent: 'remove-channel-listing' }])
    expect(res.softDeleted).toEqual([])
    expect(calls.every((c) => c === 'EBAY/IT')).toBe(true) // never AMAZON, never another market
  })
})
```

Run: `cd apps/api && npx vitest run src/services/ebay-flat-file-delete.service.vitest.test.ts` → PASS.

- [ ] **Step 2: Write the progress ledger**

Create `.superpowers/sdd/scoped-removal-progress.md` with a line per completed task (`Task N: complete (commits <base7>..<head7>, review clean)`), starting empty and appended by the controller during execution.

- [ ] **Step 3: Mark Plan 1 delivered in the spec**

Append to §8 of the spec a note: "Plan 1 (channel/market-scoped removal + inventory guard) delivered — see `docs/superpowers/plans/2026-07-06-channel-market-scoped-removal.md`. Scoped-view load (C3) and the Action column remain."

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/ebay-flat-file-delete.service.vitest.test.ts .superpowers/sdd/scoped-removal-progress.md docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md
git commit -m "test(flat-file): cross-channel isolation invariant + Plan 1 tracking"
```

---

## Self-review notes (coverage vs spec)

- **C4 (eBay delete nukes Product)** → Tasks 1-2 (default normal-row delete becomes `remove-channel-listing`).
- **C5 (Amazon cosmetic delete)** → Tasks 3-5 (real market-scoped removal).
- **Invariant I2/I3 (no Product mutation)** → guard tests in Tasks 1, 3, 6 (mock prisma without `product.update`).
- **Deferred (by design):** scoped-view load (C3), the staged Action column + Deactivate/End/Delete-product verbs, and `ReviseFixedPriceItem` are Plans 2-3, not this plan.
- **Rollback:** every change is additive/behavioral; revert the commits to restore prior behavior. No schema migration.

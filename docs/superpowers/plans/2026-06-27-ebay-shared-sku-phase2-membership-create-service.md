# eBay Shared-SKU — Phase 2: SharedListingMembership model + create service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SharedListingMembership` Prisma model (+ migration, NOT applied) and `apps/api/src/services/ebay-shared-listing-push.service.ts` that takes flat-file rows grouped by parent, builds Trading-API `AddFixedPriceItem` input, calls Phase 1's `addFixedPriceItem` to create the listing (dry-run by default), and records one `SharedListingMembership` per variant SKU. Idempotent: skip creation if memberships already exist for that (marketplace, parentSku).

**Architecture:** Pure mapper (`buildSharedListingInput`) → orchestrator (`createSharedListing`, with injectable `addFixedPriceItem` + prisma for testability) → top-level fan-out (`pushSharedListings`) grouping rows by family. Reuses Phase 1's `ebay-trading-api.service.ts` for the actual eBay call. Reads — does not modify — `ebay-variation-push.service.ts` patterns.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Prisma (postgres/Neon), vitest 4. No new deps.

**Scope boundary:** Phase 2 does NOT wire the service into any route/flat-file (Phase 4) and does NOT enqueue fan-out sync (Phase 3). The migration is created but **NOT applied** — applying happens when this branch merges to `main` (Railway `prisma migrate deploy` on deploy), which is a gated approval step OUTSIDE this plan.

## Global Constraints

- **eBay only.** Do not touch Amazon/Shopify.
- **Use Phase 1's `addFixedPriceItem` (Trading API)** from `apps/api/src/services/ebay-trading-api.service.ts` — signature: `addFixedPriceItem(input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }): Promise<{ itemId: string }>`. Do NOT call `pushVariationGroup` (Inventory API) — it forces unique SKUs and defeats the shared-SKU goal.
- **`conditionId` is the numeric eBay ConditionID** (e.g. `'1000'` = New). Flat-file rows carry `condition` as that numeric string already — pass it straight through; do NOT map to the Inventory-API enum.
- **No DB writes in tests.** Inject prisma + `addFixedPriceItem` into the orchestrator; unit-test with mocks. No local DB exists.
- **Migration is NOT applied in this plan.** Generate the migration SQL via `prisma migrate diff` (no DB needed) and `prisma generate` for client types only.
- **Markets:** IT, DE, FR, ES, UK. Currency: EUR for IT/DE/FR/ES, GBP for UK. Country (item location) defaults to row `item_location_country` else `'IT'` (Xavia is Italy-based).
- **Do NOT modify** `apps/api/src/providers/ebay.provider.ts`, `apps/api/src/services/ebay-variation-push.service.ts`, `ebay-flat-file.routes.ts`, or the `/products/ebay-flat-file` page (those are Phase 4 / out of scope).
- **Test runner:** vitest. Per-file: `cd apps/api && npx vitest run <path>`. Prisma commands run from `packages/database` (schema at `packages/database/prisma/schema.prisma`).
- Repo conventions (verbatim): models use `id String @id @default(cuid())`, `DateTime @updatedAt`, named compound uniques `@@unique([...], name: "...")` optional, `@@index([...])`. Migration dirs: `packages/database/prisma/migrations/YYYYMMDD_<snake_tag>/migration.sql`.

---

### Task 1: `SharedListingMembership` model + migration (NOT applied) + client generate

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (add model)
- Create: `packages/database/prisma/migrations/20260627_shared_listing_membership/migration.sql`

**Interfaces:**
- Produces: Prisma model `SharedListingMembership` → `prisma.sharedListingMembership` client accessor with fields `{ id, marketplace, sku, itemId, parentSku, productId, variationSpecifics, status, lastQtyPushed, lastPushedAt, lastError, createdAt, updatedAt }`.

- [ ] **Step 1: Snapshot current schema (for a clean diff)**

Run: `cd packages/database && cp prisma/schema.prisma /tmp/schema-before.prisma`
Expected: copy succeeds (no output).

- [ ] **Step 2: Add the model to `schema.prisma`**

Append this block at the end of `packages/database/prisma/schema.prisma`:

```prisma
/// Maps one shared variant SKU to every eBay listing (ItemID) that contains it,
/// so a stock change can fan out to all of them. See docs/superpowers/specs/2026-06-27-ebay-shared-variant-sku-sync-design.md
model SharedListingMembership {
  id                 String    @id @default(cuid())
  marketplace        String // 'IT' | 'DE' | 'FR' | 'ES' | 'UK'
  sku                String // shared variant SKU (eBay Custom Label)
  itemId             String // eBay ItemID of the listing containing this variant
  parentSku          String // parent listing grouping (operator-facing)
  productId          String? // Nexus product whose StockLevel feeds this SKU
  variationSpecifics Json // { "Size": "M", "Color": "Nero" }
  status             String    @default("ACTIVE") // ACTIVE | ENDED
  lastQtyPushed      Int?
  lastPushedAt       DateTime?
  lastError          String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  @@unique([marketplace, itemId, sku])
  @@index([sku, marketplace])
  @@index([productId])
}
```

- [ ] **Step 3: Validate schema**

Run: `cd packages/database && npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 4: Generate the migration SQL via diff (NO database touched)**

Run:
```bash
cd packages/database && mkdir -p prisma/migrations/20260627_shared_listing_membership && \
npx prisma migrate diff \
  --from-schema-datamodel /tmp/schema-before.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260627_shared_listing_membership/migration.sql
```
Expected: a `migration.sql` containing `CREATE TABLE "SharedListingMembership"` plus its unique + two indexes, and nothing else (only the new table).

- [ ] **Step 5: Verify the migration SQL is the new table only**

Run: `grep -c 'CREATE TABLE' packages/database/prisma/migrations/20260627_shared_listing_membership/migration.sql` (expect `1`) and `grep -c 'CREATE.*INDEX' .../migration.sql` (expect `3` — one unique + two indexes).
Expected: exactly 1 CREATE TABLE, 3 indexes. If the diff produced unrelated statements, STOP — the snapshot was wrong.

- [ ] **Step 6: Generate the Prisma client (types only — no DB)**

Run: `cd packages/database && npx prisma generate`
Expected: "Generated Prisma Client" — `prisma.sharedListingMembership` is now typed. (Note: in the worktree this updates the symlinked client; the table is created only when this branch merges and Railway runs `prisma migrate deploy`.)

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260627_shared_listing_membership/migration.sql
git commit -m "feat(ebay-shared): SharedListingMembership model + migration (not applied)"
```

---

### Task 2: Pure mapper `buildSharedListingInput`

**Files:**
- Create: `apps/api/src/services/ebay-shared-listing-push.service.ts`
- Test: `apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts`

**Interfaces:**
- Consumes: `AddFixedPriceItemInput`, `TradingVariation` from `./ebay-trading-api.service.js`.
- Produces:
```ts
export type SharedRow = Record<string, unknown> // a flat-file EbayRow
export type CapQtyFn = (productId: string | undefined, sku: string, requested: number, market?: string) => number
export function buildSharedListingInput(
  parentRow: SharedRow,
  variantRows: SharedRow[],
  market: string,
  capQty?: CapQtyFn,
): AddFixedPriceItemInput
```
- Behavior: `variationSpecificNames` = aspect axes (from `aspect_*` keys, underscores→spaces) that have >1 distinct value across `variantRows`. Each variation: `sku` from `row.sku`; `price` from `row[`${mkt}_price`] ?? row.price`; `quantity` = `capQty(row._productId, row.sku, Number(row[`${mkt}_qty`] ?? row.quantity ?? 0), market)` (or the raw number if no capQty); `specifics` = `{ [axis]: row['aspect_'+axis.replace(/ /g,'_')] }` for each axis. Title/description/categoryId/conditionId from `parentRow` (fallback to first variant). `currency` by market; `country` = `parentRow.item_location_country ?? 'IT'`. `pictureUrls` = `image_1..image_6` from parentRow (non-empty). `policies` from parentRow's `fulfillment_policy_id`/`payment_policy_id`/`return_policy_id` (undefined if absent). (Row-key reference: `ebay-feed.service.ts` `EbayFlatRow` lines 21–73; market prefix + capToFbm contract mirror `ebay-flat-file.routes.ts:713`.)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildSharedListingInput } from './ebay-shared-listing-push.service.js'

const parent = {
  sku: 'LNR-BLK', _isParent: true, title: 'Inner Liner', description: '<p>x</p>',
  category_id: '57988', condition: '1000', item_location_country: 'IT',
  image_1: 'https://img/a.jpg', fulfillment_policy_id: 'F1', payment_policy_id: 'P1', return_policy_id: 'R1',
}
const variants = [
  { sku: 'LNR-BLK-M', it_price: 49.9, it_qty: 5, aspect_Size: 'M', _productId: 'p1' },
  { sku: 'LNR-BLK-L', it_price: 49.9, it_qty: 3, aspect_Size: 'L', _productId: 'p2' },
]

describe('buildSharedListingInput', () => {
  const input = buildSharedListingInput(parent, variants, 'IT')

  it('derives variation axis names from aspect_* keys with >1 value', () => {
    expect(input.variationSpecificNames).toEqual(['Size'])
  })
  it('builds one variation per row with sku/price/qty/specifics', () => {
    expect(input.variations).toHaveLength(2)
    expect(input.variations[0]).toMatchObject({ sku: 'LNR-BLK-M', price: 49.9, quantity: 5, specifics: { Size: 'M' } })
    expect(input.variations[1]).toMatchObject({ sku: 'LNR-BLK-L', quantity: 3, specifics: { Size: 'L' } })
  })
  it('takes listing fields from the parent and currency/country from market', () => {
    expect(input.title).toBe('Inner Liner')
    expect(input.categoryId).toBe('57988')
    expect(input.conditionId).toBe('1000')
    expect(input.currency).toBe('EUR')
    expect(input.country).toBe('IT')
    expect(input.pictureUrls).toEqual(['https://img/a.jpg'])
    expect(input.policies).toEqual({ fulfillmentPolicyId: 'F1', paymentPolicyId: 'P1', returnPolicyId: 'R1' })
  })
  it('applies the capQty function to quantities', () => {
    const cap: any = vi.fn(() => 2)
    const capped = buildSharedListingInput(parent, variants, 'IT', cap)
    expect(capped.variations.every((v) => v.quantity === 2)).toBe(true)
    expect(cap).toHaveBeenCalledWith('p1', 'LNR-BLK-M', 5, 'IT')
  })
  it('UK market uses GBP', () => {
    expect(buildSharedListingInput(parent, [{ sku: 'X', uk_price: 9, uk_qty: 1, aspect_Size: 'M' }], 'UK').currency).toBe('GBP')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/services/ebay-shared-listing-push.service.ts
import type { AddFixedPriceItemInput, TradingVariation } from './ebay-trading-api.service.js'

export type SharedRow = Record<string, unknown>
export type CapQtyFn = (productId: string | undefined, sku: string, requested: number, market?: string) => number

const CURRENCY_BY_MARKET: Record<string, string> = { IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', UK: 'GBP' }

function str(v: unknown): string { return v == null ? '' : String(v) }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export function buildSharedListingInput(
  parentRow: SharedRow,
  variantRows: SharedRow[],
  market: string,
  capQty?: CapQtyFn,
): AddFixedPriceItemInput {
  const mkt = market.toUpperCase()
  const prefix = mkt.toLowerCase()

  // Axis detection: aspect_* keys with >1 distinct value across variants.
  const valueSets = new Map<string, Set<string>>()
  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const name = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!name) continue
        if (!valueSets.has(name)) valueSets.set(name, new Set())
        valueSets.get(name)!.add(v)
      }
    }
  }
  const variationSpecificNames = [...valueSets.entries()].filter(([, s]) => s.size > 1).map(([n]) => n)

  const variations: TradingVariation[] = variantRows.map((row) => {
    const sku = str(row.sku)
    const rawQty = num(row[`${prefix}_qty`] ?? row.quantity)
    const quantity = capQty ? capQty(row._productId as string | undefined, sku, rawQty, mkt) : rawQty
    const specifics: Record<string, string> = {}
    for (const name of variationSpecificNames) {
      const key = `aspect_${name.replace(/ /g, '_')}`
      const val = str(row[key])
      if (val) specifics[name] = val
    }
    return { sku, price: num(row[`${prefix}_price`] ?? row.price), quantity, specifics }
  })

  const src = parentRow ?? variantRows[0] ?? {}
  const pictureUrls = ['image_1', 'image_2', 'image_3', 'image_4', 'image_5', 'image_6']
    .map((k) => str(src[k]))
    .filter(Boolean)

  const policyVals = {
    fulfillmentPolicyId: str(src.fulfillment_policy_id) || undefined,
    paymentPolicyId: str(src.payment_policy_id) || undefined,
    returnPolicyId: str(src.return_policy_id) || undefined,
  }
  const policies = (policyVals.fulfillmentPolicyId || policyVals.paymentPolicyId || policyVals.returnPolicyId)
    ? policyVals
    : undefined

  return {
    title: str(src.title),
    description: str(src.description),
    categoryId: str(src.category_id),
    conditionId: str(src.condition) || '1000',
    country: str(src.item_location_country) || 'IT',
    currency: CURRENCY_BY_MARKET[mkt] ?? 'EUR',
    variationSpecificNames,
    variations,
    pictureUrls: pictureUrls.length ? pictureUrls : undefined,
    policies,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-shared-listing-push.service.ts apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts
git commit -m "feat(ebay-shared): pure row->AddFixedPriceItemInput mapper"
```

---

### Task 3: Orchestrator `createSharedListing` (build → addFixedPriceItem → write memberships, idempotent)

**Files:**
- Modify: `apps/api/src/services/ebay-shared-listing-push.service.ts`
- Test: `apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts`

**Interfaces:**
- Consumes: `buildSharedListingInput` (Task 2); `addFixedPriceItem` from `./ebay-trading-api.service.js`; `prisma.sharedListingMembership` (Task 1).
- Produces:
```ts
export interface SharedListingCtx {
  oauthToken: string
  market: string
  capQty?: CapQtyFn
  // injectable seams for tests:
  addFixedPriceItemFn?: (input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }) => Promise<{ itemId: string }>
  db?: { sharedListingMembership: { findFirst: Function; create: Function } }
}
export interface SharedListingResult {
  status: 'CREATED' | 'SKIPPED_EXISTS' | 'ERROR'
  itemId?: string
  parentSku: string
  market: string
  memberships: number
  message: string
}
export function createSharedListing(parentRow: SharedRow, variantRows: SharedRow[], ctx: SharedListingCtx): Promise<SharedListingResult>
```
- Behavior: resolve `parentSku = str(parentRow.sku)`. Idempotency: if `db.sharedListingMembership.findFirst({ where: { marketplace: market, parentSku } })` returns a row → return `{ status: 'SKIPPED_EXISTS', ... }` without calling eBay. Else build input, call `addFixedPriceItemFn` → `{ itemId }`, then for each variation `db.sharedListingMembership.create({ data: { marketplace, sku, itemId, parentSku, productId: <variantRow._productId>, variationSpecifics: <specifics>, lastQtyPushed: <quantity>, lastPushedAt: new Date(), status: 'ACTIVE' } })`. Return `CREATED` with the membership count. Any throw → `{ status: 'ERROR', message }` (do not rethrow).

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-shared-listing-push.service.vitest.test.ts
import { createSharedListing } from './ebay-shared-listing-push.service.js'

function mockDb(existing: unknown = null) {
  const created: any[] = []
  return {
    created,
    sharedListingMembership: {
      findFirst: vi.fn(async () => existing),
      create: vi.fn(async ({ data }: any) => { created.push(data); return data }),
    },
  }
}

describe('createSharedListing', () => {
  const ctx0 = { oauthToken: 'O', market: 'IT' as const }

  it('creates the listing and one membership per variant', async () => {
    const db = mockDb(null)
    const addFn = vi.fn(async () => ({ itemId: '110556677' }))
    const res = await createSharedListing(parent, variants, { ...ctx0, db, addFixedPriceItemFn: addFn })
    expect(res.status).toBe('CREATED')
    expect(res.itemId).toBe('110556677')
    expect(res.memberships).toBe(2)
    expect(db.created).toHaveLength(2)
    expect(db.created[0]).toMatchObject({ marketplace: 'IT', sku: 'LNR-BLK-M', itemId: '110556677', parentSku: 'LNR-BLK', variationSpecifics: { Size: 'M' } })
    expect(addFn).toHaveBeenCalledOnce()
  })

  it('is idempotent: skips creation when a membership already exists', async () => {
    const db = mockDb({ id: 'x' })
    const addFn = vi.fn(async () => ({ itemId: 'NEW' }))
    const res = await createSharedListing(parent, variants, { ...ctx0, db, addFixedPriceItemFn: addFn })
    expect(res.status).toBe('SKIPPED_EXISTS')
    expect(addFn).not.toHaveBeenCalled()
    expect(db.created).toHaveLength(0)
  })

  it('returns ERROR (no throw) when the eBay call fails', async () => {
    const db = mockDb(null)
    const addFn = vi.fn(async () => { throw new Error('eBay AddFixedPriceItem Failure: Bad category') })
    const res = await createSharedListing(parent, variants, { ...ctx0, db, addFixedPriceItemFn: addFn })
    expect(res.status).toBe('ERROR')
    expect(res.message).toMatch(/Bad category/)
    expect(db.created).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: FAIL — `createSharedListing` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-shared-listing-push.service.ts
import prisma from '../db.js'
import { addFixedPriceItem, type AddFixedPriceItemInput } from './ebay-trading-api.service.js'

export interface SharedListingCtx {
  oauthToken: string
  market: string
  capQty?: CapQtyFn
  addFixedPriceItemFn?: (input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }) => Promise<{ itemId: string }>
  db?: { sharedListingMembership: { findFirst: Function; create: Function } }
}
export interface SharedListingResult {
  status: 'CREATED' | 'SKIPPED_EXISTS' | 'ERROR'
  itemId?: string
  parentSku: string
  market: string
  memberships: number
  message: string
}

export async function createSharedListing(
  parentRow: SharedRow,
  variantRows: SharedRow[],
  ctx: SharedListingCtx,
): Promise<SharedListingResult> {
  const market = ctx.market.toUpperCase()
  const parentSku = str(parentRow.sku)
  const db = ctx.db ?? (prisma as unknown as NonNullable<SharedListingCtx['db']>)
  const addFn = ctx.addFixedPriceItemFn ?? addFixedPriceItem

  try {
    const existing = await db.sharedListingMembership.findFirst({ where: { marketplace: market, parentSku } })
    if (existing) {
      return { status: 'SKIPPED_EXISTS', parentSku, market, memberships: 0, message: 'memberships already exist for this parent+market' }
    }

    const input = buildSharedListingInput(parentRow, variantRows, market, ctx.capQty)
    const { itemId } = await addFn(input, { oauthToken: ctx.oauthToken, market })

    let count = 0
    for (let i = 0; i < input.variations.length; i++) {
      const v = input.variations[i]
      await db.sharedListingMembership.create({
        data: {
          marketplace: market,
          sku: v.sku,
          itemId,
          parentSku,
          productId: (variantRows[i]?._productId as string | undefined) ?? null,
          variationSpecifics: v.specifics,
          lastQtyPushed: v.quantity,
          lastPushedAt: new Date(),
          status: 'ACTIVE',
        },
      })
      count++
    }
    return { status: 'CREATED', itemId, parentSku, market, memberships: count, message: `created ${count} memberships` }
  } catch (err) {
    return { status: 'ERROR', parentSku, market, memberships: 0, message: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-shared-listing-push.service.ts apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts
git commit -m "feat(ebay-shared): createSharedListing orchestrator (idempotent, membership writeback)"
```

---

### Task 4: Fan-out `pushSharedListings` (group rows by family)

**Files:**
- Modify: `apps/api/src/services/ebay-shared-listing-push.service.ts`
- Test: `apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts`

**Interfaces:**
- Consumes: `createSharedListing` (Task 3).
- Produces: `export function pushSharedListings(rows: SharedRow[], ctx: SharedListingCtx): Promise<SharedListingResult[]>`.
- Behavior: group rows into families by key `(row.platformProductId ?? row.sku)` (mirrors `ebay-flat-file.routes.ts:755-760`). Within a family, the parent is the row with `_isParent === true` (or `_productId === platformProductId`), else the first row; the rest are variants (if none flagged, all rows are variants). Call `createSharedListing(parent, variants, ctx)` per family sequentially. Return the array of results.

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-shared-listing-push.service.vitest.test.ts
import { pushSharedListings } from './ebay-shared-listing-push.service.js'

describe('pushSharedListings', () => {
  it('groups rows into families and creates one listing per family', async () => {
    const db = mockDb(null)
    const addFn = vi.fn(async () => ({ itemId: 'IT-' + Math.random().toString(36).slice(2, 6) }))
    const rows = [
      { sku: 'A', _isParent: true, platformProductId: 'A', title: 'A', category_id: '1', condition: '1000' },
      { sku: 'A-M', platformProductId: 'A', it_price: 5, it_qty: 1, aspect_Size: 'M', _productId: 'a1' },
      { sku: 'A-L', platformProductId: 'A', it_price: 5, it_qty: 1, aspect_Size: 'L', _productId: 'a2' },
      { sku: 'B', _isParent: true, platformProductId: 'B', title: 'B', category_id: '1', condition: '1000' },
      { sku: 'B-M', platformProductId: 'B', it_price: 7, it_qty: 2, aspect_Size: 'M', _productId: 'b1' },
    ]
    const results = await pushSharedListings(rows, { oauthToken: 'O', market: 'IT', db, addFixedPriceItemFn: addFn })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'CREATED')).toBe(true)
    expect(addFn).toHaveBeenCalledTimes(2)
    expect(db.created).toHaveLength(3) // A: 2 variants, B: 1 variant
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: FAIL — `pushSharedListings` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-shared-listing-push.service.ts
export async function pushSharedListings(rows: SharedRow[], ctx: SharedListingCtx): Promise<SharedListingResult[]> {
  const families = new Map<string, SharedRow[]>()
  for (const row of rows) {
    const key = (row.platformProductId as string | undefined) ?? str(row.sku)
    if (!families.has(key)) families.set(key, [])
    families.get(key)!.push(row)
  }

  const isParent = (r: SharedRow) =>
    r._isParent === true ||
    (r._productId != null && r.platformProductId != null && String(r._productId) === String(r.platformProductId))

  const results: SharedListingResult[] = []
  for (const familyRows of families.values()) {
    const parent = familyRows.find(isParent) ?? familyRows[0]
    const variantsAll = familyRows.filter((r) => !isParent(r))
    const variants = variantsAll.length > 0 ? variantsAll : familyRows
    results.push(await createSharedListing(parent, variants, ctx))
  }
  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-shared-listing-push.service.ts apps/api/src/services/ebay-shared-listing-push.service.vitest.test.ts
git commit -m "feat(ebay-shared): pushSharedListings family fan-out"
```

---

## Phase 2 exit verification (after all tasks)

- [ ] `cd apps/api && npx vitest run src/services/ebay-shared-listing-push.service.vitest.test.ts` — all green.
- [ ] `cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'ebay-shared-listing|sharedListingMembership' || echo "no type errors in new code"` — confirm the new code (incl. `prisma.sharedListingMembership` usage) type-checks.
- [ ] Confirm files touched are ONLY: `packages/database/prisma/schema.prisma`, the new migration dir, and the two `ebay-shared-listing-push.service.*` files. `ebay-variation-push.service.ts` / `ebay-flat-file.routes.ts` / `ebay.provider.ts` untouched.

## GATED — do NOT do in this plan
- **Do NOT run `prisma migrate deploy` / apply the migration to any database.**
- **Do NOT merge this branch to `main` without explicit user approval** — Railway's start runs `prisma migrate deploy`, so merging auto-applies the `SharedListingMembership` table on the next deploy. The controller pauses here and asks the user before merging (per the standing migration-approval rule).

## Notes for the executor
- Keep a SINGLE consolidated `import { ... } from 'vitest'` at the top of the test file (append-merge across tasks).
- `prisma generate` in the worktree updates the symlinked client (shared with main) — that is expected and harmless (additive type; table created only on the gated deploy).
- The orchestrator's `db`/`addFixedPriceItemFn` seams exist for tests; in real use they default to the live `prisma` and Phase-1 `addFixedPriceItem`.

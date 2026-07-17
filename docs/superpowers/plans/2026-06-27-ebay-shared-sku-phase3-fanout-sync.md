# eBay Shared-SKU — Phase 3: inventory FAN-OUT to all shared listings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a shared variant SKU's available quantity changes, push the new quantity to **every** eBay listing (ItemID) that contains it. Reuse the existing stock→queue→worker fan-out (no new queue, no new worker, no new cron): the stock cascade additionally enqueues one `OutboundSyncQueue` row **per `SharedListingMembership`** for the changed SKU, tagged `payload.pushVia:'TRADING'`; the existing eBay worker (`OutboundSyncService.syncToEbay`) grows ONE branch that — when it sees `payload.pushVia === 'TRADING'` — calls Phase 1's `reviseInventoryStatus({ itemId, sku, quantity }, { oauthToken, market })` (Trading API `ReviseInventoryStatus`) instead of the Inventory-API GET-merge-PUT path.

**Architecture:**
```
applyStockMovement (existing)
  └─ cascadeQuantityToListings(tx, args)               [stock-movement.service.ts ~565]
        ├─ (existing) ChannelListing fan-out → OutboundSyncQueue QUANTITY_UPDATE rows
        └─ (NEW) enqueueSharedTradingFanout(tx, {productId, sku?, market?, capQty})  ← Task 2
              └─ look up SharedListingMembership rows (status ACTIVE) for the changed product/SKU
              └─ compute capped qty per membership (reuse computeAvailableToPublish — same maths as the cascade above)
              └─ insert OutboundSyncQueue rows:
                   productId, channelListingId: null, targetChannel: 'EBAY',
                   syncType: 'QUANTITY_UPDATE', holdUntil,
                   externalListingId: itemId,
                   payload: { source:'STOCK_MOVEMENT_SHARED', pushVia:'TRADING',
                              sku, itemId, market, marketplaceId, quantity, oldQuantity }
        └─ return queuedSyncIds  (now includes the shared rows so applyStockMovement enqueues BullMQ jobs for them)

OutboundSyncService.syncToEbay(queueItem)                [outbound-sync.service.ts ~673]
  └─ (NEW, top of method) if queueItem.payload.pushVia === 'TRADING':
        return this.syncSharedTradingQuantity(queueItem)   ← Task 4
           ├─ gate (getEbayPublishMode) / connection lookup / circuit / rate-limit / dry-run  (reuse existing helpers)
           ├─ token = ebayAuthService.getValidToken(connection.id)
           ├─ reviseInventoryStatus({ itemId, sku, quantity }, { oauthToken: token, market })
           └─ writeback SharedListingMembership.lastQtyPushed/lastPushedAt/lastError
  └─ (else) existing Inventory-API path unchanged
```

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Prisma (postgres/Neon), BullMQ (existing `outboundSyncQueue`), vitest 4. **No new deps. No new tables. No migration.** The discriminator lives in `payload` JSON (`payload.pushVia:'TRADING'`), reusing the existing `OutboundSyncQueue` model verbatim — confirmed below.

**Scope boundary:** Phase 3 does NOT add any route/UI (that is Phase 4) and does NOT change how memberships are *created* (Phase 2). It only wires the *quantity fan-out*. The `SharedListingMembership` table is created when this branch merges (Railway `prisma migrate deploy`), a gated step OUTSIDE this plan — see GATED below.

## Global Constraints

- **eBay only.** Do NOT touch Amazon/Shopify/Woo code paths. The new branch is fully contained inside `syncToEbay` and a new private method; Amazon/Shopify dispatch is unchanged.
- **Reuse the existing fan-out.** Do NOT create a new queue, worker, BullMQ queue, or cron. Enqueue into the SAME `OutboundSyncQueue` table inside the SAME `cascadeQuantityToListings` transaction so the existing `applyStockMovement` BullMQ-enqueue loop (stock-movement.service.ts:471-499) and the existing `processSingle`/`processPendingSyncs` drain pick the rows up unchanged.
- **No new column.** Use `payload.pushVia:'TRADING'` as the discriminator (avoids a migration). Verified the model already has `payload Json`, `externalListingId String?`, `targetChannel SyncChannel` and allows `channelListingId = null` (only "at least one of productId/channelListingId" is required, and `productId` is set). `OutboundSyncQueue` model: `packages/database/prisma/schema.prisma:5136-5193` — fields used: `productId`, `channelListingId?`, `targetChannel`, `targetRegion?`, `syncStatus`, `syncType`, `payload`, `externalListingId?`, `holdUntil?`, `maxRetries`.
- **Use Phase 1's `reviseInventoryStatus`** from `apps/api/src/services/ebay-trading-api.service.ts:231-238` — exact signature:
  `reviseInventoryStatus(input: { itemId: string; sku: string; quantity: number }, ctx: { oauthToken: string; market: string }): Promise<void>`.
  `market` is the **2-letter** code (`IT|DE|FR|ES|UK`) — `siteIdForMarket` (`ebay-trading-api.service.ts:18-22`) maps it to the Site ID. Do NOT pass `EBAY_IT` here.
- **Token acquisition mirrors the existing eBay worker:** `ebayAuthService.getValidToken(connection.id)` where `connection = prisma.channelConnection.findFirst({ where: { channelType:'EBAY', isActive:true }, orderBy:{ updatedAt:'desc' } })`. See `outbound-sync.service.ts:762-765` (connection lookup) and `:825-834` (token fetch). Import already present: `outbound-sync.service.ts:26`.
- **Reuse the cap maths.** Pushed quantity is reserved-adjusted warehouse-available minus buffer, identical to the ChannelListing cascade: `computeAvailableToPublish({ fulfillmentMethod:'FBM', warehouseAvailable, fbaSellable:0, stockBuffer }).available` (`available-to-publish.service.ts:49-57`; cascade usage `stock-movement.service.ts:637-645`). Shared eBay listings are FBM (own-warehouse) — Trading-API `ReviseInventoryStatus` is a merchant-fulfilled call.
- **`market` mapping (both directions):**
  - membership.marketplace is the 2-letter code (`'IT'|'DE'|'FR'|'ES'|'UK'`) — pass straight to `reviseInventoryStatus` as `market`.
  - `payload.marketplaceId` for logging/circuit/rate-limit uses the existing eBay form `'EBAY_' + (market==='UK'?'GB':market)` (the existing worker keys circuit/rate-limit + `ebayCurrencyForMarket` on `EBAY_GB`; see `outbound-sync.service.ts:53`, `:676`).
- **`SharedListingMembership` model** (Phase 2): fields used here — `marketplace`, `sku`, `itemId`, `productId?`, `status` (`'ACTIVE'`), `lastQtyPushed`, `lastPushedAt`, `lastError`. Indexes `@@index([sku, marketplace])` and `@@index([productId])` make the lookups cheap. Source: `packages/database/prisma/schema.prisma` (model `SharedListingMembership`).
- **No DB/network in tests.** Inject `prisma` (or just the `sharedListingMembership` + `outboundSyncQueue` accessors) and `reviseInventoryStatus` into the new functions via optional params; unit-test with mocks. No local DB exists; do not call real eBay.
- **Test runner:** vitest. Per-file: `cd apps/api && npx vitest run <path>`.
- **Do NOT modify** `apps/api/src/services/ebay-trading-api.service.ts`, `ebay-shared-listing-push.service.ts` (Phase 1/2 are done), `ebay-variation-push.service.ts`, `ebay-flat-file.routes.ts`, `ebay.provider.ts`, or the flat-file pages. New code lives in stock-movement.service.ts (one call site + one new function) and outbound-sync.service.ts (one branch + one new method), plus a new shared helper module for the enqueue/cap logic so it is unit-testable without the stock transaction.

---

### Task 1: Pure helper — build the shared Trading fan-out queue rows

Put the testable, side-effect-free logic in its own module so we never need the stock `$transaction` in tests. It takes membership rows + a per-membership capped quantity and returns ready-to-insert `OutboundSyncQueue` create-inputs.

**Files:**
- Create: `apps/api/src/services/ebay-shared-fanout.service.ts`
- Test: `apps/api/src/services/ebay-shared-fanout.service.vitest.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SharedMembershipRow {
  sku: string
  itemId: string
  marketplace: string // 'IT'|'DE'|'FR'|'ES'|'UK'
  productId: string | null
}
/** marketplace 2-letter -> eBay marketplaceId form used for logging/circuit/rate-limit. */
export function ebayMarketplaceIdForMarket(market: string): string // 'IT' -> 'EBAY_IT', 'UK' -> 'EBAY_GB'

export interface SharedFanoutRow {
  productId: string | null
  channelListingId: null
  targetChannel: 'EBAY'
  targetRegion: string // the 2-letter market
  syncStatus: 'PENDING'
  syncType: 'QUANTITY_UPDATE'
  holdUntil: Date
  externalListingId: string // = itemId
  maxRetries: number
  payload: {
    source: 'STOCK_MOVEMENT_SHARED'
    pushVia: 'TRADING'
    sku: string
    itemId: string
    market: string         // 2-letter, for reviseInventoryStatus
    marketplaceId: string  // 'EBAY_xx', for logging/circuit/rate-limit
    quantity: number
    oldQuantity: number | null
    productId: string | null
  }
}
/**
 * Pure builder: one OutboundSyncQueue create-input per membership.
 * `cappedQtyFor(m)` returns the already-pool-capped quantity for that membership
 * (caller computes it from warehouse-available − buffer); rows whose qty equals
 * `lastQtyPushed` (passed per row) are dropped as no-ops.
 */
export function buildSharedFanoutRows(
  memberships: Array<SharedMembershipRow & { lastQtyPushed: number | null }>,
  cappedQtyFor: (m: SharedMembershipRow) => number,
  holdUntil: Date,
): SharedFanoutRow[]
```
- Behavior: for each membership, `quantity = cappedQtyFor(m)`; **skip** the row if `quantity === m.lastQtyPushed` (nothing changed — avoid wasted jobs, mirrors the cascade's `newListingQty !== listing.quantity` guard at `stock-movement.service.ts:647`). Otherwise emit a `SharedFanoutRow` with `externalListingId = m.itemId`, `targetRegion = m.marketplace`, `payload.market = m.marketplace`, `payload.marketplaceId = ebayMarketplaceIdForMarket(m.marketplace)`, `payload.quantity = quantity`, `payload.oldQuantity = m.lastQtyPushed`, `maxRetries: 3`. `ebayMarketplaceIdForMarket('UK') === 'EBAY_GB'`; all others `'EBAY_' + market.toUpperCase()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/ebay-shared-fanout.service.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { buildSharedFanoutRows, ebayMarketplaceIdForMarket } from './ebay-shared-fanout.service.js'

const hold = new Date('2026-06-27T00:00:00Z')
const members = [
  { sku: 'LNR-M', itemId: '110', marketplace: 'IT', productId: 'p1', lastQtyPushed: 9 },
  { sku: 'LNR-M', itemId: '220', marketplace: 'IT', productId: 'p1', lastQtyPushed: 3 }, // same sku, 2nd listing
  { sku: 'LNR-L', itemId: '330', marketplace: 'DE', productId: 'p2', lastQtyPushed: 5 },
]

describe('ebayMarketplaceIdForMarket', () => {
  it('maps UK -> EBAY_GB and others -> EBAY_xx', () => {
    expect(ebayMarketplaceIdForMarket('UK')).toBe('EBAY_GB')
    expect(ebayMarketplaceIdForMarket('IT')).toBe('EBAY_IT')
    expect(ebayMarketplaceIdForMarket('de')).toBe('EBAY_DE')
  })
})

describe('buildSharedFanoutRows', () => {
  it('emits one TRADING row per membership, itemId in externalListingId + payload', () => {
    const rows = buildSharedFanoutRows(members, () => 4, hold)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      productId: 'p1', channelListingId: null, targetChannel: 'EBAY',
      targetRegion: 'IT', syncType: 'QUANTITY_UPDATE', externalListingId: '110',
      holdUntil: hold, maxRetries: 3,
    })
    expect(rows[0].payload).toMatchObject({
      source: 'STOCK_MOVEMENT_SHARED', pushVia: 'TRADING', sku: 'LNR-M', itemId: '110',
      market: 'IT', marketplaceId: 'EBAY_IT', quantity: 4, oldQuantity: 9,
    })
    expect(rows[2].payload).toMatchObject({ market: 'DE', marketplaceId: 'EBAY_DE', itemId: '330' })
  })

  it('drops no-op rows where capped qty equals lastQtyPushed', () => {
    // cap returns each membership's lastQtyPushed -> all no-ops
    const rows = buildSharedFanoutRows(members, (m) =>
      (members.find((x) => x.itemId === m.itemId)?.lastQtyPushed ?? -1), hold)
    expect(rows).toHaveLength(0)
  })

  it('emits a row when lastQtyPushed is null (never pushed)', () => {
    const fresh = [{ sku: 'X', itemId: '1', marketplace: 'IT', productId: 'p', lastQtyPushed: null }]
    expect(buildSharedFanoutRows(fresh, () => 0, hold)).toHaveLength(1) // 0 !== null
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-fanout.service.vitest.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/services/ebay-shared-fanout.service.ts
//
// Phase 3 — builds OutboundSyncQueue create-inputs that fan a shared variant
// SKU's quantity out to every eBay listing (ItemID) containing it. Tagged
// payload.pushVia:'TRADING' so the existing OutboundSyncService.syncToEbay
// worker routes them through Phase-1 reviseInventoryStatus instead of the
// Inventory-API path. Pure + side-effect-free so it is unit-testable without
// the stock transaction or the network.

export interface SharedMembershipRow {
  sku: string
  itemId: string
  marketplace: string
  productId: string | null
}

export function ebayMarketplaceIdForMarket(market: string): string {
  const m = (market ?? '').toUpperCase()
  return m === 'UK' ? 'EBAY_GB' : `EBAY_${m}`
}

export interface SharedFanoutPayload {
  source: 'STOCK_MOVEMENT_SHARED'
  pushVia: 'TRADING'
  sku: string
  itemId: string
  market: string
  marketplaceId: string
  quantity: number
  oldQuantity: number | null
  productId: string | null
}
export interface SharedFanoutRow {
  productId: string | null
  channelListingId: null
  targetChannel: 'EBAY'
  targetRegion: string
  syncStatus: 'PENDING'
  syncType: 'QUANTITY_UPDATE'
  holdUntil: Date
  externalListingId: string
  maxRetries: number
  payload: SharedFanoutPayload
}

export function buildSharedFanoutRows(
  memberships: Array<SharedMembershipRow & { lastQtyPushed: number | null }>,
  cappedQtyFor: (m: SharedMembershipRow) => number,
  holdUntil: Date,
): SharedFanoutRow[] {
  const rows: SharedFanoutRow[] = []
  for (const m of memberships) {
    const quantity = Math.max(0, Math.trunc(cappedQtyFor(m)))
    if (m.lastQtyPushed != null && quantity === m.lastQtyPushed) continue // no-op
    rows.push({
      productId: m.productId,
      channelListingId: null,
      targetChannel: 'EBAY',
      targetRegion: m.marketplace,
      syncStatus: 'PENDING',
      syncType: 'QUANTITY_UPDATE',
      holdUntil,
      externalListingId: m.itemId,
      maxRetries: 3,
      payload: {
        source: 'STOCK_MOVEMENT_SHARED',
        pushVia: 'TRADING',
        sku: m.sku,
        itemId: m.itemId,
        market: m.marketplace,
        marketplaceId: ebayMarketplaceIdForMarket(m.marketplace),
        quantity,
        oldQuantity: m.lastQtyPushed,
        productId: m.productId,
      },
    })
  }
  return rows
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-fanout.service.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-shared-fanout.service.ts apps/api/src/services/ebay-shared-fanout.service.vitest.test.ts
git commit -m "feat(ebay-shared): pure builder for Trading-API quantity fan-out rows"
```

---

### Task 2: `enqueueSharedTradingFanout` — look up memberships, compute capped qty, insert queue rows (in-tx)

The orchestrator that runs inside the stock cascade transaction: query `SharedListingMembership` (ACTIVE) for the changed product, cap each by the warehouse pool (passed in), build rows via Task 1, `createMany` them, and return the ids of the rows just enqueued (so `applyStockMovement` can add BullMQ jobs).

**Files:**
- Modify: `apps/api/src/services/ebay-shared-fanout.service.ts`
- Test: `apps/api/src/services/ebay-shared-fanout.service.vitest.test.ts`

**Interfaces:**
- Consumes: `buildSharedFanoutRows` (Task 1); `computeAvailableToPublish` from `./available-to-publish.service.js`; a Prisma transaction client (or an injected stub exposing `sharedListingMembership.findMany`, `outboundSyncQueue.createMany`, `outboundSyncQueue.findMany`).
- Produces:
```ts
export interface SharedFanoutDeps {
  sharedListingMembership: { findMany: Function }
  outboundSyncQueue: { createMany: Function; findMany: Function }
}
export interface SharedFanoutArgs {
  productId: string
  /** Reserved-adjusted own-warehouse available for this product (cascade already
   *  computed it — pass it straight through). */
  warehouseAvailable: number
  /** Overselling buffer to subtract (the cascade reads ChannelListing.stockBuffer;
   *  shared listings have no ChannelListing, so default 0 unless a future per-SKU
   *  buffer exists). */
  stockBuffer?: number
  holdUntil: Date
  /** Optional: restrict to a single changed SKU (else all of the product's
   *  memberships re-push). */
  sku?: string
}
/** Returns the OutboundSyncQueue ids enqueued (so the caller adds BullMQ jobs). */
export async function enqueueSharedTradingFanout(
  db: SharedFanoutDeps,
  args: SharedFanoutArgs,
): Promise<string[]>
```
- Behavior:
  1. `where = { productId, status: 'ACTIVE' }`; if `args.sku` set, add `sku: args.sku`. `const memberships = await db.sharedListingMembership.findMany({ where, select: { sku:true, itemId:true, marketplace:true, productId:true, lastQtyPushed:true } })`.
  2. If none → return `[]` (no work).
  3. `const cap = () => computeAvailableToPublish({ fulfillmentMethod:'FBM', warehouseAvailable: args.warehouseAvailable, fbaSellable:0, stockBuffer: args.stockBuffer ?? 0 }).available` — same number for every membership of this product (all FBM own-warehouse). [If per-market caps are ever needed, swap to a per-`m.marketplace` lookup — out of scope now.]
  4. `const rows = buildSharedFanoutRows(memberships, cap, args.holdUntil)`. If empty → return `[]`.
  5. `await db.outboundSyncQueue.createMany({ data: rows })`.
  6. Re-read the just-enqueued ids: `db.outboundSyncQueue.findMany({ where: { productId: args.productId, channelListingId: null, syncType:'QUANTITY_UPDATE', syncStatus:'PENDING' }, orderBy:{ createdAt:'desc' }, take: rows.length, select:{ id:true } })` → return `r.id` array. (Mirrors the cascade's just-enqueued re-read at `stock-movement.service.ts:702-712`, but keyed on `channelListingId: null` to isolate shared rows from the ChannelListing rows enqueued in the same tx.)

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-shared-fanout.service.vitest.test.ts
import { enqueueSharedTradingFanout } from './ebay-shared-fanout.service.js'
import { vi } from 'vitest'

function mockDb(members: any[]) {
  const created: any[] = []
  return {
    created,
    sharedListingMembership: { findMany: vi.fn(async () => members) },
    outboundSyncQueue: {
      createMany: vi.fn(async ({ data }: any) => { created.push(...data); return { count: data.length } }),
      findMany: vi.fn(async () => created.map((_, i) => ({ id: `q${i}` }))),
    },
  }
}

describe('enqueueSharedTradingFanout', () => {
  const hold = new Date('2026-06-27T00:00:00Z')

  it('enqueues one row per ACTIVE membership, capped by warehouse-available − buffer', async () => {
    const db = mockDb([
      { sku: 'A', itemId: '1', marketplace: 'IT', productId: 'p', lastQtyPushed: 0 },
      { sku: 'A', itemId: '2', marketplace: 'IT', productId: 'p', lastQtyPushed: 0 },
    ])
    const ids = await enqueueSharedTradingFanout(db, { productId: 'p', warehouseAvailable: 10, stockBuffer: 2, holdUntil: hold })
    expect(db.sharedListingMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'p', status: 'ACTIVE' } }),
    )
    expect(db.created).toHaveLength(2)
    expect(db.created[0].payload.quantity).toBe(8) // 10 − 2 buffer
    expect(db.created[0].externalListingId).toBe('1')
    expect(db.created[0].payload.pushVia).toBe('TRADING')
    expect(ids).toEqual(['q0', 'q1'])
  })

  it('filters to a single SKU when args.sku is set', async () => {
    const db = mockDb([{ sku: 'A', itemId: '1', marketplace: 'IT', productId: 'p', lastQtyPushed: 0 }])
    await enqueueSharedTradingFanout(db, { productId: 'p', warehouseAvailable: 5, holdUntil: hold, sku: 'A' })
    expect(db.sharedListingMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'p', status: 'ACTIVE', sku: 'A' } }),
    )
  })

  it('returns [] and enqueues nothing when no memberships', async () => {
    const db = mockDb([])
    const ids = await enqueueSharedTradingFanout(db, { productId: 'p', warehouseAvailable: 5, holdUntil: hold })
    expect(ids).toEqual([])
    expect(db.outboundSyncQueue.createMany).not.toHaveBeenCalled()
  })

  it('returns [] when every membership is a no-op (qty unchanged)', async () => {
    const db = mockDb([{ sku: 'A', itemId: '1', marketplace: 'IT', productId: 'p', lastQtyPushed: 8 }])
    const ids = await enqueueSharedTradingFanout(db, { productId: 'p', warehouseAvailable: 10, stockBuffer: 2, holdUntil: hold })
    expect(ids).toEqual([]) // cap = 8 === lastQtyPushed
    expect(db.outboundSyncQueue.createMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-fanout.service.vitest.test.ts`
Expected: FAIL — `enqueueSharedTradingFanout` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-shared-fanout.service.ts
import { computeAvailableToPublish } from './available-to-publish.service.js'

export interface SharedFanoutDeps {
  sharedListingMembership: { findMany: Function }
  outboundSyncQueue: { createMany: Function; findMany: Function }
}
export interface SharedFanoutArgs {
  productId: string
  warehouseAvailable: number
  stockBuffer?: number
  holdUntil: Date
  sku?: string
}

export async function enqueueSharedTradingFanout(
  db: SharedFanoutDeps,
  args: SharedFanoutArgs,
): Promise<string[]> {
  const where: Record<string, unknown> = { productId: args.productId, status: 'ACTIVE' }
  if (args.sku) where.sku = args.sku

  const memberships = (await db.sharedListingMembership.findMany({
    where,
    select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true },
  })) as Array<SharedMembershipRow & { lastQtyPushed: number | null }>
  if (memberships.length === 0) return []

  const capped = computeAvailableToPublish({
    fulfillmentMethod: 'FBM',
    warehouseAvailable: args.warehouseAvailable,
    fbaSellable: 0,
    stockBuffer: args.stockBuffer ?? 0,
  }).available

  const rows = buildSharedFanoutRows(memberships, () => capped, args.holdUntil)
  if (rows.length === 0) return []

  await db.outboundSyncQueue.createMany({ data: rows })
  const justEnqueued = (await db.outboundSyncQueue.findMany({
    where: {
      productId: args.productId,
      channelListingId: null,
      syncType: 'QUANTITY_UPDATE',
      syncStatus: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    take: rows.length,
    select: { id: true },
  })) as Array<{ id: string }>
  return justEnqueued.map((r) => r.id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-shared-fanout.service.vitest.test.ts`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-shared-fanout.service.ts apps/api/src/services/ebay-shared-fanout.service.vitest.test.ts
git commit -m "feat(ebay-shared): enqueueSharedTradingFanout — in-tx membership lookup + queue insert"
```

---

### Task 3: Hook the fan-out into the stock cascade

Call `enqueueSharedTradingFanout` from inside `cascadeQuantityToListings` (same tx), and fold its returned ids into the `queuedSyncIds` the cascade already returns — so `applyStockMovement`'s existing BullMQ-enqueue loop picks them up with no change there.

**Files:**
- Modify: `apps/api/src/services/stock-movement.service.ts`

**Interfaces:**
- `cascadeQuantityToListings` already computes `warehouseAvailable` (`stock-movement.service.ts:596-598`) and `holdUntil` (`:616-618`) and returns `{ cascadedListingIds, snapshottedListingIds, queuedSyncIds }` (`:715`). We append the shared queue ids to `queuedSyncIds`.

- [ ] **Step 1: Add the import (top of file, near line 7)**

```ts
import { enqueueSharedTradingFanout } from './ebay-shared-fanout.service.js'
```

- [ ] **Step 2: Call the fan-out just before the `return` of `cascadeQuantityToListings`**

Locate the existing tail (verbatim, `stock-movement.service.ts:699-716`):

```ts
  let queuedSyncIds: string[] = []
  if (queueRowsToCreate.length > 0) {
    await tx.outboundSyncQueue.createMany({ data: queueRowsToCreate })
    const justEnqueued = await tx.outboundSyncQueue.findMany({
      where: {
        channelListingId: { in: cascadedListingIds },
        syncType: 'QUANTITY_UPDATE',
        syncStatus: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      take: cascadedListingIds.length,
      select: { id: true },
    })
    queuedSyncIds = justEnqueued.map((r) => r.id)
  }

  return { cascadedListingIds, snapshottedListingIds, queuedSyncIds }
```

Insert the shared fan-out **between** the `if` block and the `return`:

```ts
  // Phase 3 — shared-SKU eBay fan-out. Every SharedListingMembership for this
  // product (one row per ItemID that contains the variant SKU) gets a Trading-API
  // quantity push enqueued in THIS tx, so a single stock change updates all the
  // shared eBay listings via the existing queue+worker. channelListingId is null
  // on these rows (the shared SKU is not a ChannelListing); the worker routes
  // them by payload.pushVia:'TRADING'. Best-effort: a failure here must not roll
  // back the stock movement — the ChannelListing cascade above is the source of
  // truth and these rows are also healed by the next backstop drain.
  try {
    const sharedIds = await enqueueSharedTradingFanout(
      tx as unknown as Parameters<typeof enqueueSharedTradingFanout>[0],
      {
        productId,
        warehouseAvailable,
        stockBuffer: 0, // shared listings have no per-listing ChannelListing buffer (yet)
        holdUntil,
      },
    )
    if (sharedIds.length > 0) queuedSyncIds = [...queuedSyncIds, ...sharedIds]
  } catch (err) {
    logger.warn('cascadeQuantityToListings: shared eBay fan-out enqueue failed (non-fatal)', {
      productId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return { cascadedListingIds, snapshottedListingIds, queuedSyncIds }
```

> Note: `tx` is a `Prisma.TransactionClient`, which structurally provides `sharedListingMembership.findMany` / `outboundSyncQueue.createMany` / `outboundSyncQueue.findMany` — the cast just narrows it to the injected-deps shape. `applyStockMovement` already iterates `queuedSyncIds` to add BullMQ `sync-job`s (`stock-movement.service.ts:471-499`); the shared ids ride that loop unchanged, so they get the same `enqueueDelay` (0 for order-driven, else 30s grace).

- [ ] **Step 3: Type-check the change**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'stock-movement|ebay-shared-fanout' || echo "no type errors in touched files"`
Expected: "no type errors in touched files".

- [ ] **Step 4: Smoke-test the existing stock-movement suite still passes (no regression)**

Run: `cd apps/api && npx vitest run src/services/stock-movement 2>&1 | tail -20` (if a suite exists; if none, skip — the unit coverage is in Task 2).
Expected: green, or "No test files found" (acceptable — the new logic is covered by Task 2's injected-deps tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stock-movement.service.ts
git commit -m "feat(ebay-shared): fan out shared eBay quantity from the stock cascade"
```

---

### Task 4: `syncToEbay` Trading branch — route `pushVia:'TRADING'` rows to `reviseInventoryStatus`

Add ONE early branch to `OutboundSyncService.syncToEbay`: when the queue row is a shared Trading row, call a new private `syncSharedTradingQuantity` that reuses the existing gate/connection/circuit/rate-limit/dry-run scaffolding and then calls Phase 1's `reviseInventoryStatus`, writing the result back to `SharedListingMembership`.

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts`
- Test: `apps/api/src/services/outbound-sync.shared-trading.vitest.test.ts` (new file — keeps the large existing test file untouched)

**Interfaces:**
- Consumes: `reviseInventoryStatus` from `./ebay-trading-api.service.js`; the existing module helpers `getEbayPublishMode`, `checkEbayCircuit`, `acquireEbayPublishToken`, `recordEbayOutcome`, `ebayAuthService.getValidToken`, `writeAttemptLog`, `prisma` (all already imported/defined in this file). The Phase-1 fn is injected via an optional static seam so the test never hits the network.
- Reads off the queue row: `queueItem.payload.{ pushVia, sku, itemId, market, marketplaceId, quantity }` and `queueItem.externalListingId` (= itemId, fallback). `queueItem.product` is the related Product (may be null; the Trading path keys on `payload.sku`, NOT `product.sku`).

- [ ] **Step 1: Add the injectable seam + branch dispatch**

Near the top of the `OutboundSyncService` class (or as a module-level binding), add an overridable reference so tests can stub the network call:

```ts
// at module scope, after the existing imports in outbound-sync.service.ts
import { reviseInventoryStatus as ebayReviseInventoryStatus } from './ebay-trading-api.service.js'

// test seam — overridable in unit tests; defaults to the real Phase-1 fn.
export const __ebayTrading = {
  reviseInventoryStatus: ebayReviseInventoryStatus,
}
```

Add the branch as the FIRST statement inside `syncToEbay(queueItem)` (before the existing `const { product, payload, id: queueId } = queueItem;` / cap block at `outbound-sync.service.ts:674`):

```ts
    // Phase 3 — shared-SKU Trading-API quantity fan-out. These rows have no
    // ChannelListing and must use ReviseInventoryStatus (multi-listing shared
    // SKU), NOT the Inventory-API GET-merge-PUT path below.
    if (queueItem?.payload?.pushVia === 'TRADING') {
      return this.syncSharedTradingQuantity(queueItem);
    }
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/services/outbound-sync.shared-trading.vitest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the service.
vi.mock('../db.js', () => {
  const connection = { id: 'conn1' }
  return {
    default: {
      channelConnection: { findFirst: vi.fn(async () => connection) },
      sharedListingMembership: { updateMany: vi.fn(async () => ({ count: 1 })) },
      outboundSyncQueue: { update: vi.fn(async () => ({})), findUnique: vi.fn(), findMany: vi.fn() },
    },
  }
})
// Force the eBay publish mode to "live" and stub auth + rate/circuit so we reach the call.
vi.mock('./ebay-auth.service.js', () => ({
  ebayAuthService: { getValidToken: vi.fn(async () => 'TOKEN-XYZ') },
}))

import prisma from '../db.js'
import { OutboundSyncService, __ebayTrading } from './outbound-sync.service.js'

describe('syncToEbay TRADING branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
    process.env.EBAY_PUBLISH_MODE = 'live'
  })

  const queueItem = {
    id: 'q1',
    externalListingId: '110556677',
    product: { id: 'p1', sku: 'PARENT' },
    payload: {
      pushVia: 'TRADING', sku: 'LNR-M', itemId: '110556677',
      market: 'IT', marketplaceId: 'EBAY_IT', quantity: 7,
    },
  }

  it('calls reviseInventoryStatus with itemId/sku/quantity + market and reports SUCCESS', async () => {
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(spy).toHaveBeenCalledWith(
      { itemId: '110556677', sku: 'LNR-M', quantity: 7 },
      { oauthToken: 'TOKEN-XYZ', market: 'IT' },
    )
    expect(res.success).toBe(true)
    expect(res.channel).toBe('EBAY')
    // membership writeback (lastQtyPushed/lastPushedAt, lastError cleared)
    expect((prisma as any).sharedListingMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketplace: 'IT', itemId: '110556677', sku: 'LNR-M' },
        data: expect.objectContaining({ lastQtyPushed: 7, lastError: null }),
      }),
    )
  })

  it('does NOT touch the Inventory-API path (no fetch) for TRADING rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any)
    vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    await (svc as any).syncToEbay(queueItem)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports FAILED + records lastError when reviseInventoryStatus throws', async () => {
    vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockRejectedValue(new Error('eBay ReviseInventoryStatus Failure: Item not found'))
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Item not found/)
    expect((prisma as any).sharedListingMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastError: expect.stringMatching(/Item not found/) }) }),
    )
  })

  it('is a dry-run no-op (no call) when EBAY_PUBLISH_MODE is not live', async () => {
    process.env.EBAY_PUBLISH_MODE = 'dry-run'
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(spy).not.toHaveBeenCalled()
    expect(res.success).toBe(true) // dry-run reports success-but-dryRun
    expect(res.dryRun ?? res.status === 'SUCCESS').toBeTruthy()
  })
})
```

> Confirm the exact env-var names + mode helper before finalising the test: read `getEbayPublishMode` (defined in this module) and align `process.env` setup so `mode === 'live'`. If `getEbayPublishMode` reads other/additional flags, set them in `beforeEach`. (The names above match the documented flags `NEXUS_ENABLE_EBAY_PUBLISH` + `EBAY_PUBLISH_MODE`; verify, don't assume.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.shared-trading.vitest.test.ts`
Expected: FAIL — `syncSharedTradingQuantity` not implemented / branch missing.

- [ ] **Step 4: Implement `syncSharedTradingQuantity`**

Add this private method to `OutboundSyncService` (next to `syncToEbay`). It reuses the SAME gate/connection/circuit/rate-limit/dry-run sequence as `syncToEbay` (lines 751-821) but swaps the network step for `reviseInventoryStatus`, and writes back to the membership:

```ts
  /**
   * Phase 3 — shared-SKU quantity fan-out via Trading API ReviseInventoryStatus.
   * These OutboundSyncQueue rows carry payload.pushVia:'TRADING' and have no
   * ChannelListing; the SKU lives in MANY listings (one membership per ItemID),
   * which the multi-variation shared listing model needs (the Inventory API
   * forces unique SKUs and can't address a shared SKU). Reuses the eBay gate +
   * connection + circuit + rate-limit + dry-run scaffolding from syncToEbay.
   */
  private async syncSharedTradingQuantity(queueItem: any): Promise<SyncResult> {
    const { payload, id: queueId } = queueItem;
    const sku: string = payload?.sku ?? "(unknown sku)";
    const itemId: string = payload?.itemId ?? queueItem.externalListingId ?? "";
    const market: string = payload?.market ?? "IT";
    const marketplaceId: string = payload?.marketplaceId ?? `EBAY_${market}`;
    const quantity: number = Math.max(0, Math.trunc(Number(payload?.quantity ?? 0)));
    const digest = digestPayload({ quantity });

    const writeMembership = async (data: Record<string, unknown>) => {
      try {
        await prisma.sharedListingMembership.updateMany({
          where: { marketplace: market, itemId, sku },
          data,
        });
      } catch { /* writeback is best-effort */ }
    };

    // 1. Feature flag
    const mode = getEbayPublishMode();
    if (mode === "gated") {
      return { success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "eBay outbound sync gated",
        error: "NEXUS_ENABLE_EBAY_PUBLISH=false — set true to enable eBay outbound sync." };
    }

    // 2. Connection lookup
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: "EBAY", isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!connection) {
      return { success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "No active eBay connection", error: "No active eBay connection — link an eBay account in Settings first." };
    }

    // 3. Circuit breaker
    const circuit = checkEbayCircuit(connection.id, marketplaceId);
    if (!circuit.ok) {
      return { success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "Circuit open", error: circuit.error ?? "Circuit open" };
    }

    // 4. Rate limiter
    const t0 = Date.now();
    const acquired = await acquireEbayPublishToken(connection.id, marketplaceId);
    if (!acquired.ok) {
      return { success: false, queueId, channel: "EBAY", status: "FAILED",
        message: "Rate limited", error: acquired.error ?? "Rate limited" };
    }

    // 5. Dry-run short-circuit (parity with syncToEbay — no membership writeback on a no-op)
    if (mode === "dry-run") {
      recordEbayOutcome(connection.id, marketplaceId, true);
      writeAttemptLog({ channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
        productId: payload?.productId ?? null, mode: "dry-run", outcome: "success",
        payloadDigest: digest, durationMs: Date.now() - t0 });
      return { success: true, queueId, channel: "EBAY", status: "SUCCESS",
        message: `Shared ${sku}@${itemId} dry-run (ReviseInventoryStatus)`, dryRun: true };
    }

    // 6. Auth
    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err) {
      const message = `Could not obtain eBay token: ${err instanceof Error ? err.message : String(err)}`;
      recordEbayOutcome(connection.id, marketplaceId, false);
      await writeMembership({ lastError: message });
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message: "eBay auth failed", error: message };
    }

    // 7. The Trading-API call (Phase 1). Guard the itemId so we never call with an empty ID.
    if (!itemId) {
      const message = `shared Trading row missing itemId (sku ${sku})`;
      await writeMembership({ lastError: message });
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message, error: message };
    }
    try {
      await __ebayTrading.reviseInventoryStatus({ itemId, sku, quantity }, { oauthToken: token, market });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordEbayOutcome(connection.id, marketplaceId, false);
      writeAttemptLog({ channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
        productId: payload?.productId ?? null, mode, outcome: "failed",
        payloadDigest: digest, errorMessage: message.slice(0, 500), durationMs: Date.now() - t0 });
      await writeMembership({ lastError: message.slice(0, 500) });
      return { success: false, queueId, channel: "EBAY", status: "FAILED", message: "Failed to sync to eBay (Trading)", error: message };
    }

    // 8. Success — record outcome, log, write back the membership.
    recordEbayOutcome(connection.id, marketplaceId, true);
    writeAttemptLog({ channel: "EBAY", marketplace: marketplaceId, sellerId: connection.id, sku,
      productId: payload?.productId ?? null, mode, outcome: "success",
      payloadDigest: digest, durationMs: Date.now() - t0 });
    await writeMembership({ lastQtyPushed: quantity, lastPushedAt: new Date(), lastError: null });
    return { success: true, queueId, channel: "EBAY", status: "SUCCESS",
      message: `Shared ${sku} qty ${quantity} pushed to ItemID ${itemId} (${market})` };
  }
```

> Before finalising: confirm `digestPayload`, `writeAttemptLog`, `getEbayPublishMode`, `checkEbayCircuit`, `acquireEbayPublishToken`, `recordEbayOutcome` are all in module scope of `outbound-sync.service.ts` (they are used by the existing `syncToEbay`, lines 715-938 — so all in scope). Match the `SyncResult` field names by reading the type. If `getEbayPublishMode` only returns `'gated'|'dry-run'|'sandbox'|'live'`, treat `'sandbox'` like `'live'` here (it points the base URL at sandbox in the Inventory path; for Trading, `callTradingApi` already routes to the sandbox endpoint via `EBAY_SANDBOX`/`NEXUS_EBAY_REAL_API` — so a `'sandbox'`/`'live'` mode both proceed to the call and let `callTradingApi`'s own env gate decide dry-run-vs-real).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/outbound-sync.shared-trading.vitest.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'outbound-sync|ebay-trading-api|ebay-shared-fanout' || echo "no type errors in touched files"
```
Expected: "no type errors in touched files".

```bash
git add apps/api/src/services/outbound-sync.service.ts apps/api/src/services/outbound-sync.shared-trading.vitest.test.ts
git commit -m "feat(ebay-shared): syncToEbay Trading branch -> reviseInventoryStatus + membership writeback"
```

---

## Phase 3 exit verification (after all tasks)

- [ ] `cd apps/api && npx vitest run src/services/ebay-shared-fanout.service.vitest.test.ts src/services/outbound-sync.shared-trading.vitest.test.ts` — all green.
- [ ] `cd apps/api && npx tsc --noEmit 2>&1 | grep -E 'ebay-shared-fanout|outbound-sync|stock-movement' || echo "no type errors in new code"` — confirm the touched files type-check.
- [ ] Confirm the only files touched are: NEW `ebay-shared-fanout.service.ts` (+ test), NEW `outbound-sync.shared-trading.vitest.test.ts`, and EDITS to `stock-movement.service.ts` (one import + one block) and `outbound-sync.service.ts` (one import + one seam + one branch + one method). `ebay-trading-api.service.ts`, `ebay-shared-listing-push.service.ts`, `ebay-variation-push.service.ts`, `ebay-flat-file.routes.ts`, `ebay.provider.ts` are UNTOUCHED.
- [ ] Manual trace (read-only): a stock change on a product with ACTIVE memberships → `cascadeQuantityToListings` enqueues N shared `OutboundSyncQueue` rows (`channelListingId=null`, `payload.pushVia='TRADING'`, `externalListingId=itemId`) → `applyStockMovement` adds BullMQ jobs for them → `processSingle`→`dispatchSync`→`syncToEbay` sees `pushVia==='TRADING'` → `syncSharedTradingQuantity` → `reviseInventoryStatus`. No new queue/worker/cron introduced.

## GATED — do NOT do in this plan
- **Do NOT run `prisma migrate deploy` / apply any migration.** Phase 3 adds NO migration (discriminator is in `payload`), but it depends on the Phase-2 `SharedListingMembership` table, which is created only when this branch merges to `main` and Railway runs `prisma migrate deploy`.
- **Do NOT merge this branch to `main` without explicit user approval** — merging auto-applies the Phase-2 table on the next deploy (standing migration-approval rule). The controller pauses here and asks before merging.
- **Do NOT enable live pushes as part of this plan.** `NEXUS_ENABLE_EBAY_PUBLISH` / `EBAY_PUBLISH_MODE` / `NEXUS_EBAY_REAL_API` stay at their current values; the code defaults to dry-run/gated. Flipping live flags is a separate gated step.

## Notes for the executor
- The shared rows deliberately set `channelListingId: null`. `OutboundSyncQueue` requires "at least one of productId/channelListingId"; `productId` carries the relation. The just-enqueued re-read in Task 2 keys on `channelListingId: null` to avoid colliding with the ChannelListing rows the cascade enqueues in the same tx.
- The fan-out qty uses the SAME `computeAvailableToPublish` pool maths as the ChannelListing cascade, so a shared listing and a (hypothetical) direct ChannelListing for the same product would publish the same number — no oversell-skew between paths. Defensive cap in `syncToEbay`'s Inventory path (`outbound-sync.service.ts:685-713`) does NOT run for the Trading branch (it short-circuits first); the cap is already applied at enqueue time.
- `__ebayTrading` is the test seam for the network call. In production it is the real Phase-1 `reviseInventoryStatus` — do not remove it.
- Keep a SINGLE consolidated `import { ... } from 'vitest'` at the top of each test file.
- If a future need arises for per-market caps or a per-SKU buffer, swap Task 2's single `capped` for a per-`marketplace` lookup and thread a buffer in — out of scope here.

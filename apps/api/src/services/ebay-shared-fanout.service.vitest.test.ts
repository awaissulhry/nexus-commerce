// apps/api/src/services/ebay-shared-fanout.service.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
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

describe('buildSharedFanoutRows (RT.2 — one row per ITEM, updates[] batched)', () => {
  it('emits one TRADING row per ItemID with all changed SKUs in updates[]', () => {
    const rows = buildSharedFanoutRows(members, () => 4, hold)
    expect(rows).toHaveLength(3) // three distinct itemIds here
    expect(rows[0]).toMatchObject({
      productId: 'p1', channelListingId: null, targetChannel: 'EBAY',
      targetRegion: 'IT', syncType: 'QUANTITY_UPDATE', externalListingId: '110',
      holdUntil: hold, maxRetries: 3,
    })
    expect(rows[0].payload).toMatchObject({
      source: 'STOCK_MOVEMENT_SHARED', pushVia: 'TRADING', itemId: '110',
      market: 'IT', marketplaceId: 'EBAY_IT',
    })
    expect(rows[0].payload.updates).toEqual([{ sku: 'LNR-M', quantity: 4, oldQuantity: 9 }])
    expect(rows[2].payload).toMatchObject({ market: 'DE', marketplaceId: 'EBAY_DE', itemId: '330' })
  })

  it('groups MULTIPLE SKUs of one ItemID into a single row (the 250/day-cap fix)', () => {
    const multi = [
      { sku: 'V-S', itemId: '900', marketplace: 'IT', productId: 'p1', lastQtyPushed: 1 },
      { sku: 'V-M', itemId: '900', marketplace: 'IT', productId: 'p1', lastQtyPushed: 2 },
      { sku: 'V-L', itemId: '900', marketplace: 'IT', productId: 'p1', lastQtyPushed: 3 },
      { sku: 'V-XL', itemId: '900', marketplace: 'IT', productId: 'p1', lastQtyPushed: 4 },
      { sku: 'V-2XL', itemId: '900', marketplace: 'IT', productId: 'p1', lastQtyPushed: 5 },
    ]
    const rows = buildSharedFanoutRows(multi, () => 7, hold)
    expect(rows).toHaveLength(1)
    expect(rows[0].externalListingId).toBe('900')
    expect(rows[0].payload.updates).toHaveLength(5)
    expect(rows[0].payload.updates.map((u) => u.sku)).toEqual(['V-S', 'V-M', 'V-L', 'V-XL', 'V-2XL'])
    expect(rows[0].payload.updates.every((u) => u.quantity === 7)).toBe(true)
  })

  it('drops no-op SKUs inside an item; item with zero changed SKUs emits no row', () => {
    const rows = buildSharedFanoutRows(members, (m) =>
      (members.find((x) => x.itemId === m.itemId)?.lastQtyPushed ?? -1), hold)
    expect(rows).toHaveLength(0)
  })

  it('mixed item: only the CHANGED SKUs appear in updates[]', () => {
    const mixed = [
      { sku: 'K-A', itemId: '77', marketplace: 'IT', productId: 'p', lastQtyPushed: 6 }, // no-op at cap 6
      { sku: 'K-B', itemId: '77', marketplace: 'IT', productId: 'p', lastQtyPushed: 2 }, // changes
    ]
    const rows = buildSharedFanoutRows(mixed, () => 6, hold)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.updates).toEqual([{ sku: 'K-B', quantity: 6, oldQuantity: 2 }])
  })

  it('emits a row when lastQtyPushed is null (never pushed)', () => {
    const fresh = [{ sku: 'X', itemId: '1', marketplace: 'IT', productId: 'p', lastQtyPushed: null }]
    const rows = buildSharedFanoutRows(fresh, () => 0, hold)
    expect(rows).toHaveLength(1) // 0 !== null
    expect(rows[0].payload.updates).toEqual([{ sku: 'X', quantity: 0, oldQuantity: null }])
  })
})

// Task 2 tests
import { enqueueSharedTradingFanout } from './ebay-shared-fanout.service.js'

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

  it('enqueues one row per ITEM (RT.2), capped by warehouse-available − buffer', async () => {
    const db = mockDb([
      { sku: 'A', itemId: '1', marketplace: 'IT', productId: 'p', lastQtyPushed: 0 },
      { sku: 'A', itemId: '2', marketplace: 'IT', productId: 'p', lastQtyPushed: 0 },
    ])
    const ids = await enqueueSharedTradingFanout(db, { productId: 'p', warehouseAvailable: 10, stockBuffer: 2, holdUntil: hold })
    expect(db.sharedListingMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'p', status: 'ACTIVE' } }),
    )
    expect(db.created).toHaveLength(2) // two distinct itemIds
    expect(db.created[0].payload.updates).toEqual([{ sku: 'A', quantity: 8, oldQuantity: 0 }]) // 10 − 2 buffer
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

/**
 * Step 4 (Send to FBA), Part D — Amazon's inbound numbers are KEPT (working / shipped / receiving), never as FBA stock.
 *
 * Before: the 15-min FBA sweep summed the three inbound buckets into one number and threw it away; three readers (the
 * FBA→FBM conversion guard, the delete warnings, Claude's fba-inventory) expected `FbaInventoryDetail` INBOUND rows that
 * nothing wrote. Now the sweep stores ONE INBOUND row per seller SKU × the sweep's marketplace (fulfilment centre 'ALL',
 * `rawData = { working, shipped, receiving }`), and the AMAZON-EU-FBA StockLevel stays Amazon's fulfillable number only.
 *
 * The real sweep (`amazon-inventory.service.ts` → `AmazonService.fetchFBAInventory`) over a real PostgreSQL in-process
 * (PGlite: production schema + row-level security). Amazon's getInventorySummaries answer comes from a fake SP client
 * (`lib/amazon-sp-client.js` stubbed) in the shape of the FBA Inventory v1 model: nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as any,
  account: null as string | null,
  pages: [] as Array<Array<Record<string, unknown>>>,
  calls: [] as Array<Record<string, unknown>>,
  fail: false,
}))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('./advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
// The SP client: Amazon's getInventorySummaries answer, page by page (the library merges `pagination` into the result,
// so `nextToken` sits next to `inventorySummaries`). The account chooser answers `state.account`.
vi.mock('../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => {
    if (!state.account) throw new Error('no Amazon account')
    return { id: state.account }
  }),
  amazonCredsConfigured: vi.fn(async () => true),
  amazonSpClient: () => ({
    callAPI: async (req: { operation: string; query: Record<string, unknown> }) => {
      state.calls.push({ operation: req.operation, ...req.query })
      if (state.fail) throw new Error('Amazon answered 503')
      const page = req.query.nextToken ? Number(req.query.nextToken) : 0
      const nextToken = page + 1 < state.pages.length ? String(page + 1) : undefined
      return { granularity: { granularityType: 'Marketplace' }, inventorySummaries: state.pages[page] ?? [], ...(nextToken ? { nextToken } : {}) }
    },
  }),
}))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { amazonInventoryService, inboundOf } from './amazon-inventory.service.js'
import { AmazonService } from './marketplaces/amazon.service.js'
import { listPerFcTotals } from './fba-pan-eu.service.js'
import { readFbaUnits } from './pim/fulfilment-conversion-guard.js'

const IT = 'APJ6JRA9NG5V4'
const DE = 'A1PA6795UKMFR9'
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const pid: Record<string, string> = {}
const loc = { main: '', fba: '' }

/** One getInventorySummaries item, in the model's shape. */
const item = (sku: string, d: { fulfillable?: number; working?: number; shipped?: number; receiving?: number; condition?: string } = {}) => ({
  asin: `B0${sku.replace(/[^A-Z0-9]/g, '')}`.slice(0, 10), fnSku: `X0${sku}`, sellerSku: sku, condition: d.condition ?? 'NewItem',
  lastUpdatedTime: '2026-10-07T10:00:00Z', productName: sku,
  totalQuantity: (d.fulfillable ?? 0) + (d.working ?? 0) + (d.shipped ?? 0) + (d.receiving ?? 0),
  inventoryDetails: {
    fulfillableQuantity: d.fulfillable ?? 0,
    inboundWorkingQuantity: d.working ?? 0, inboundShippedQuantity: d.shipped ?? 0, inboundReceivingQuantity: d.receiving ?? 0,
    reservedQuantity: { totalReservedQuantity: 0 }, unfulfillableQuantity: { totalUnfulfillableQuantity: 0 },
  },
})
const amazonSays = (...pages: Array<Array<Record<string, unknown>>>) => { state.pages = pages; state.calls = []; state.fail = false }
const fullSweep = () => scoped(() => amazonInventoryService.syncFBAInventory({ marketplaceId: IT }))
const refresh = (skus: string[]) => scoped(() => amazonInventoryService.syncFBAInventoryForSkus(skus, { marketplaceId: IT }))

const inboundRows = () => scoped(() => prisma.fbaInventoryDetail.findMany({
  where: { condition: 'INBOUND' },
  select: { sku: true, productId: true, marketplaceId: true, fulfillmentCenterId: true, quantity: true, rawData: true, firstReceivedAt: true, lastSyncedAt: true },
  orderBy: [{ marketplaceId: 'asc' }, { sku: 'asc' }, { fulfillmentCenterId: 'asc' }],
}))
const allRow = async (sku: string, marketplaceId = IT) => (await inboundRows()).find((r) => r.sku === sku && r.marketplaceId === marketplaceId && r.fulfillmentCenterId === 'ALL') ?? null
const fbaLevel = (sku: string) => scoped(async () => (await prisma.stockLevel.findFirst({ where: { productId: pid[sku], locationId: loc.fba }, select: { quantity: true } }))?.quantity ?? null)
const movements = (sku: string) => scoped(() => prisma.stockMovement.findMany({ where: { productId: pid[sku] }, select: { change: true, reason: true, locationId: true }, orderBy: { createdAt: 'asc' } }))

beforeAll(() => scoped(async () => {
  state.account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'inb-amazon', externalAccountId: 'inb-amazon', isActive: true, isPrimary: true } as never })).id
  loc.main = (await prisma.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'IT-MAIN', name: 'Own warehouse (test)' } })).id
  loc.fba = (await prisma.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA (test)' } })).id
  for (const sku of ['INB-A', 'INB-B', 'INB-ZERO', 'INB-GONE']) {
    pid[sku] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10 } as never })).id
  }
  // INB-B sells on Amazon under its own seller SKU (the S7 own-SKU match).
  await prisma.channelListing.create({ data: {
    productId: pid['INB-B'], channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: state.account,
    aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, liveChannelSku: 'INB-B-IT', channelSku: 'INB-B-IT',
  } as never })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('Amazon\'s inbound numbers (the FBA sweep)', () => {
  it('fetchFBAInventory keeps working / shipped / receiving apart, page after page and condition after condition (inboundQuantity is still their sum)', async () => {
    amazonSays([item('INB-A', { fulfillable: 3, working: 10, shipped: 2 })], [item('INB-A', { fulfillable: 1, working: 1, receiving: 4, condition: 'UsedLikeNew' })])
    const rows = await scoped(() => new AmazonService().fetchFBAInventory({ marketplaceId: IT }))
    expect(rows).toEqual([expect.objectContaining({
      sku: 'INB-A', fulfillableQuantity: 4, inboundQuantity: 17, inboundWorkingQuantity: 11, inboundShippedQuantity: 2, inboundReceivingQuantity: 4,
    })])
    expect(state.calls).toEqual([
      expect.objectContaining({ operation: 'getInventorySummaries', details: true, granularityType: 'Marketplace', granularityId: IT }),
      expect.objectContaining({ operation: 'getInventorySummaries', nextToken: '1' }),
    ])
  })

  it('a sweep stores ONE INBOUND row per seller SKU (fulfilment centre ALL) on its product; the FBA number stays the fulfillable units, written as before', async () => {
    amazonSays([
      item('INB-A', { fulfillable: 5, working: 12, shipped: 7, receiving: 3 }),
      item('INB-B-IT', { fulfillable: 2, shipped: 4 }),
      item('NOT-IN-NEXUS', { working: 1 }),
    ])
    const summary = await fullSweep()
    expect(summary).toMatchObject({ rowsFetched: 3, productsUpdated: 2, skusNotFoundInDb: 1, inboundRowsWritten: 3, inboundRowsCleared: 0, errors: [] })
    expect(await allRow('INB-A')).toMatchObject({ productId: pid['INB-A'], quantity: 22, rawData: { working: 12, shipped: 7, receiving: 3 }, firstReceivedAt: null })
    // The own seller SKU is the row's key; its product is the listing's.
    expect(await allRow('INB-B-IT')).toMatchObject({ productId: pid['INB-B'], quantity: 4, rawData: { working: 0, shipped: 4, receiving: 0 } })
    // A SKU Nexus does not know: Amazon's number is kept under its SKU, on no product (never a guessed one).
    expect(await allRow('NOT-IN-NEXUS')).toMatchObject({ productId: null, quantity: 1 })
    // 🔴 Nexus never writes the FBA quantity from inbound: the mirror is the fulfillable units, one movement at the FBA mirror only.
    expect([await fbaLevel('INB-A'), await fbaLevel('INB-B')]).toEqual([5, 2])
    expect(await movements('INB-A')).toEqual([{ change: 5, reason: 'SYNC_RECONCILIATION', locationId: loc.fba }])
    expect((await movements('INB-B')).every((m) => m.locationId === loc.fba)).toBe(true)
  })

  it('an unchanged FBA number (delta 0, no movement) still refreshes the inbound row', async () => {
    const before = (await allRow('INB-A'))!.lastSyncedAt
    amazonSays([item('INB-A', { fulfillable: 5, shipped: 20, receiving: 2 }), item('INB-B-IT', { fulfillable: 2, shipped: 4 }), item('NOT-IN-NEXUS', { working: 1 })])
    const summary = await fullSweep()
    expect(summary).toMatchObject({ productsUpdated: 0, productsUnchanged: 2, inboundRowsWritten: 3 })
    const row = await allRow('INB-A')
    expect(row).toMatchObject({ quantity: 22, rawData: { working: 0, shipped: 20, receiving: 2 } })
    expect(row!.lastSyncedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(await movements('INB-A')).toHaveLength(1)
    expect(await fbaLevel('INB-A')).toBe(5)
  })

  it('nothing inbound → no row: a bounded refresh removes only the SKUs it saw with 0; a full sweep removes every SKU it did not write; other marketplaces and fulfilment centres stay', async () => {
    amazonSays([item('INB-ZERO', { working: 3 }), item('INB-GONE', { shipped: 4 })])
    await refresh(['INB-ZERO', 'INB-GONE'])
    // Another marketplace's row and a per-fulfilment-centre row (the Pan-EU breakdown) are not this sweep's.
    await scoped(async () => {
      await prisma.fbaInventoryDetail.create({ data: { productId: pid['INB-A'], sku: 'INB-A', marketplaceId: DE, fulfillmentCenterId: 'ALL', condition: 'INBOUND', quantity: 9, rawData: { working: 9, shipped: 0, receiving: 0 } } })
      await prisma.fbaInventoryDetail.create({ data: { productId: pid['INB-A'], sku: 'INB-A', marketplaceId: IT, fulfillmentCenterId: 'MXP6', condition: 'INBOUND', quantity: 6 } })
    })

    amazonSays([item('INB-ZERO', { fulfillable: 1 })])
    const bounded = await refresh(['INB-ZERO'])
    expect(bounded).toMatchObject({ inboundRowsWritten: 0, inboundRowsCleared: 1 })
    expect(await allRow('INB-ZERO')).toBeNull()
    expect((await allRow('INB-GONE'))?.quantity).toBe(4) // a bounded refresh never removes a SKU it did not see

    amazonSays([item('INB-A', { fulfillable: 5, working: 2 })])
    const full = await fullSweep()
    expect(full).toMatchObject({ inboundRowsWritten: 1, inboundRowsCleared: 3 }) // INB-B-IT, NOT-IN-NEXUS, INB-GONE
    expect((await inboundRows()).map((r) => `${r.marketplaceId === IT ? 'IT' : 'DE'}:${r.fulfillmentCenterId}:${r.sku}:${r.quantity}`))
      .toEqual(['DE:ALL:INB-A:9', 'IT:ALL:INB-A:2', 'IT:MXP6:INB-A:6'])
    // Removed, not zeroed: the FBA numbers were not touched.
    expect([await fbaLevel('INB-A'), await fbaLevel('INB-B')]).toEqual([5, 2])
  })

  it('an empty report removes nothing; a failed read writes and removes nothing', async () => {
    amazonSays([])
    expect(await fullSweep()).toMatchObject({ rowsFetched: 0, inboundRowsWritten: 0, inboundRowsCleared: 0 })
    state.fail = true
    const failed = await fullSweep()
    expect(failed.errors).toEqual([{ sku: 'FETCH', error: 'Amazon answered 503' }])
    expect((await inboundRows()).map((r) => `${r.fulfillmentCenterId}:${r.sku}:${r.quantity}`)).toEqual(['ALL:INB-A:9', 'ALL:INB-A:2', 'MXP6:INB-A:6'])
  })

  it('the readers that expected INBOUND rows now get them: the FBA→FBM conversion guard counts them; the per-FC totals skip the ALL row', async () => {
    amazonSays([item('INB-B-IT', { fulfillable: 2, working: 1, shipped: 3 })])
    await refresh(['INB-B-IT'])
    const units = await scoped(() => readFbaUnits([pid['INB-B']], ['INB-B']))
    expect(units.get(pid['INB-B'])).toEqual({ onHand: 2, reserved: 0, inbound: 4 })
    const perFc = await scoped(() => listPerFcTotals())
    expect(perFc.map((b) => `${b.fulfillmentCenterId}:${b.inbound}`)).toEqual(['MXP6:6'])
  })
})

describe('inboundOf', () => {
  it('sums the three buckets; a missing, negative or odd bucket counts 0', () => {
    expect(inboundOf({ inboundWorkingQuantity: 2, inboundShippedQuantity: 5, inboundReceivingQuantity: 1 })).toEqual({ working: 2, shipped: 5, receiving: 1, units: 8 })
    expect(inboundOf({ inboundWorkingQuantity: -3, inboundShippedQuantity: Number.NaN })).toEqual({ working: 0, shipped: 0, receiving: 0, units: 0 })
    expect(inboundOf({})).toEqual({ working: 0, shipped: 0, receiving: 0, units: 0 })
  })
})

/**
 * A bulk override's quantity, buffer and publish flag (2026-09-30, "fix it as well").
 *
 * 🔴 WHAT THIS GUARDS. `MARKETPLACE_OVERRIDE_UPDATE` wrote `quantityOverride`, `followMasterQuantity`, `stockBuffer`
 * and `isPublished` straight onto the listing and queued nothing: the job said COMPLETED and the channel never got the
 * number. Now each goes the way the app's single-listing edit of it goes, and nowhere else:
 *   - a fixed quantity / follow the stock → `setFollowMasterQuantity` (the Studio matrix's and Sync Control's
 *     primitive; a typed number is staged first, as the matrix does), one QUANTITY_UPDATE row;
 *   - a buffer → `setStockBuffer` (the matrix's buffer cell);
 *   - the publish flag → refused, as `PATCH /listings/:id` refuses it (the listing channel workflow publishes).
 * Owner rules held here: FBA quantity is never touched (refused by name); an Amazon EU quantity is ONE number for every
 * EU market, so it changes the whole open EU group or nothing; a closed Amazon offer is never reopened by a quantity.
 *
 * Each arm compares the bulk action with the single edit's own primitive on a twin listing. Real PostgreSQL
 * in-process (PGlite): these arms test what a write stores, not a race.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// The real primitives, wrapped so an arm can see the bulk action called them.
vi.mock('./follow-master.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./follow-master.service.js')>()
  return { ...real, setFollowMasterQuantity: vi.fn(real.setFollowMasterQuantity), setStockBuffer: vi.fn(real.setStockBuffer) }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { BulkActionService, PUBLISH_FLAG_REFUSAL } from './bulk-action.service.js'
import { setFollowMasterQuantity, setStockBuffer } from './follow-master.service.js'
import { detectEuIntentConflict } from './amazon-eu-quantity-guard.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const service = new BulkActionService(prisma as never)
const pin = vi.mocked(setFollowMasterQuantity)
const buffer = vi.mocked(setStockBuffer)

const MARKETS: Array<[string, string, string, string]> = [
  ['AMAZON', 'IT', 'EU', 'EUR'], ['AMAZON', 'DE', 'EU', 'EUR'], ['AMAZON', 'FR', 'EU', 'EUR'], ['AMAZON', 'ES', 'EU', 'EUR'],
  ['AMAZON', 'UK', 'UK', 'GBP'], ['EBAY', 'IT', 'EU', 'EUR'], ['SHOPIFY', 'GLOBAL', 'GLOBAL', 'EUR'],
]
const account: Record<string, string> = {}
beforeAll(() => scoped(async () => {
  for (const [channel, code, region, currency] of MARKETS) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region, language: 'it', languages: ['it'] } })
  }
  for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY']) {
    account[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `inventory-${channel}`, isActive: true } })).id
  }
}), 120_000)
afterEach(() => { pin.mockClear(); buffer.mockClear() })
afterAll(async () => { await state.db?.close() }, 60_000)

type Row = { channel: string; marketplace: string; fba?: boolean; closed?: boolean; pinned?: number; buffer?: number }
async function seed(id: string, rows: Row[]) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, totalStock: 7 } })
  const out: Record<string, string> = {}
  for (const r of rows) {
    const region = MARKETS.find(([c, m]) => c === r.channel && m === r.marketplace)![2]
    const row = await prisma.channelListing.create({ data: {
      productId: id, channel: r.channel, channelConnectionId: account[r.channel], channelMarket: `${r.channel}_${r.marketplace}`,
      marketplace: r.marketplace, region, price: 10, followMasterPrice: true, quantity: r.pinned ?? 5,
      quantityOverride: r.pinned ?? null, followMasterQuantity: r.pinned == null, stockBuffer: r.buffer ?? 0,
      fulfillmentMethod: r.fba ? 'FBA' : 'FBM', offerClosedAt: r.closed ? new Date() : null,
    } })
    out[`${r.channel}:${r.marketplace}`] = row.id
  }
  return out
}
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const queueOf = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
const coordinateOf = async (id: string) => {
  const l = await listing(id)
  return { productId: l.productId, channel: l.channel, marketplace: l.marketplace, channelConnectionId: l.channelConnectionId, aliasKey: l.aliasKey }
}
async function runJob(channel: string, actionPayload: Record<string, unknown>, extra: { targetProductIds?: string[]; filters?: Record<string, unknown> } = {}) {
  const job = await service.createJob({ jobName: `inventory ${channel}`, actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel, actionPayload, createdBy: 'person-1', ...extra })
  const result = await service.processJob(job.id)
  const items = await prisma.bulkActionItem.findMany({ where: { jobId: job.id } })
  return { job, result, items }
}
/** A quantity row as the channel will read it, without the fields that name the row, its product or who sent it. */
const qtyShape = (row: Record<string, any>) => {
  const { productId: _p, actor: _a, ...payload } = row.payload
  return { targetChannel: row.targetChannel, targetRegion: row.targetRegion, syncStatus: row.syncStatus, syncType: row.syncType,
    maxRetries: row.maxRetries, channelConnectionId: row.channelConnectionId, payload }
}
const qtyColumns = (l: Record<string, any>) => ({ quantity: l.quantity, quantityOverride: l.quantityOverride, followMasterQuantity: l.followMasterQuantity, stockBuffer: l.stockBuffer, lastSyncStatus: l.lastSyncStatus })

describe('each inventory field reaches the channel the way the single-listing edit sends it', () => {
  it('🔴 a fixed quantity: the same columns and QUANTITY_UPDATE row as the Studio matrix (stage the number, then pin)', () => scoped(async () => {
    const bulk = (await seed('qty-bulk', [{ channel: 'EBAY', marketplace: 'IT' }]))['EBAY:IT']
    const single = (await seed('qty-single', [{ channel: 'EBAY', marketplace: 'IT' }]))['EBAY:IT']

    const { result, items } = await runJob('EBAY', { quantityOverride: 4 }, { targetProductIds: ['qty-bulk'] })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1, failedItems: 0 })
    expect(items[0].afterState).toMatchObject({ quantity: 4, quantityOverride: 4, followMasterQuantity: false })
    expect(pin).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EBAY', follow: false, actor: 'person-1' }))

    const coordinate = await coordinateOf(single)
    await prisma.channelListing.updateMany({ where: coordinate, data: { quantity: 4 } })
    await setFollowMasterQuantity({ productIds: ['qty-single'], channel: 'EBAY', markets: ['IT'], follow: false, actor: 'person-1', coordinates: [coordinate] })

    expect(qtyColumns(await listing(bulk))).toEqual(qtyColumns(await listing(single)))
    expect(qtyColumns(await listing(bulk))).toMatchObject({ quantity: 4, quantityOverride: 4, followMasterQuantity: false })
    const [bq, sq] = [await queueOf(bulk), await queueOf(single)]
    expect(bq.map(qtyShape)).toEqual(sq.map(qtyShape))
    expect(bq).toHaveLength(1)
    expect(bq[0]).toMatchObject({ syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING', payload: { source: 'FOLLOW_MASTER', quantity: 4, follow: false, actor: 'person-1' } })
  }), 60_000)

  it('🔴 following the stock again (quantityOverride: null or followMasterQuantity: true) is the single edit\'s FOLLOW', () => scoped(async () => {
    const viaNull = (await seed('follow-null', [{ channel: 'EBAY', marketplace: 'IT', pinned: 3 }]))['EBAY:IT']
    const viaFlag = (await seed('follow-flag', [{ channel: 'EBAY', marketplace: 'IT', pinned: 3 }]))['EBAY:IT']
    const single = (await seed('follow-single', [{ channel: 'EBAY', marketplace: 'IT', pinned: 3 }]))['EBAY:IT']
    await runJob('EBAY', { quantityOverride: null }, { targetProductIds: ['follow-null'] })
    await runJob('EBAY', { followMasterQuantity: true }, { targetProductIds: ['follow-flag'] })
    await setFollowMasterQuantity({ productIds: ['follow-single'], channel: 'EBAY', markets: ['IT'], follow: true, actor: 'person-1', coordinates: [await coordinateOf(single)] })

    const expected = qtyColumns(await listing(single))
    expect(expected).toMatchObject({ quantityOverride: null, followMasterQuantity: true })
    const expectedRows = (await queueOf(single)).map(qtyShape)
    expect(expectedRows).toEqual([expect.objectContaining({ syncType: 'QUANTITY_UPDATE', payload: expect.objectContaining({ follow: true }) })])
    for (const id of [viaNull, viaFlag]) {
      expect(qtyColumns(await listing(id))).toEqual(expected)
      expect((await queueOf(id)).map(qtyShape)).toEqual(expectedRows)
    }
  }), 60_000)

  it('🔴 a buffer is the matrix\'s buffer cell (setStockBuffer): the same columns and row', () => scoped(async () => {
    const bulk = (await seed('buf-bulk', [{ channel: 'EBAY', marketplace: 'IT' }]))['EBAY:IT']
    const single = (await seed('buf-single', [{ channel: 'EBAY', marketplace: 'IT' }]))['EBAY:IT']
    const { result } = await runJob('EBAY', { stockBuffer: 2 }, { targetProductIds: ['buf-bulk'] })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect(buffer).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EBAY', buffer: 2, actor: 'person-1' }))
    await setStockBuffer({ productIds: ['buf-single'], channel: 'EBAY', markets: ['IT'], buffer: 2, actor: 'person-1', coordinates: [await coordinateOf(single)] })
    expect(qtyColumns(await listing(bulk))).toEqual(qtyColumns(await listing(single)))
    expect((await listing(bulk)).stockBuffer).toBe(2)
    expect((await queueOf(bulk)).map(qtyShape)).toEqual((await queueOf(single)).map(qtyShape))
    expect(await queueOf(bulk)).toHaveLength(1)
  }), 60_000)

  it('a price and a quantity together: one PRICE_UPDATE through the price door and one QUANTITY_UPDATE', () => scoped(async () => {
    const id = (await seed('price-and-qty', [{ channel: 'EBAY', marketplace: 'IT' }]))['EBAY:IT']
    const { result } = await runJob('EBAY', { priceOverride: 12, quantityOverride: 2 }, { targetProductIds: ['price-and-qty'] })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect((await queueOf(id)).map((r) => [r.syncType, (r.payload as any).price ?? (r.payload as any).quantity])).toEqual([['PRICE_UPDATE', 12], ['QUANTITY_UPDATE', 2]])
  }), 60_000)
})

describe('the owner rules', () => {
  it('🔴 FBA is untouchable: the row is refused by name and NOTHING is written or queued — not even its price', () => scoped(async () => {
    const id = (await seed('fba', [{ channel: 'AMAZON', marketplace: 'UK', fba: true }]))['AMAZON:UK']
    const before = await listing(id)
    for (const payload of [{ quantityOverride: 5, priceOverride: 9 }, { stockBuffer: 1 }, { followMasterQuantity: true }]) {
      const { result, items } = await runJob('AMAZON', payload, { targetProductIds: ['fba'] })
      expect(result, JSON.stringify(payload)).toMatchObject({ status: 'FAILED', failedItems: 1 })
      expect(items[0].errorMessage).toMatch(/Amazon manages this listing's quantity \(FBA\)/)
    }
    expect(await listing(id)).toEqual(before)
    expect(await queueOf(id)).toEqual([])
    expect(pin).not.toHaveBeenCalled()
    expect(buffer).not.toHaveBeenCalled()
  }), 60_000)

  it('🔴 Amazon EU is ONE number: a job holding one EU market is refused whole; a job holding the group changes it together', () => scoped(async () => {
    const l = await seed('eu', [
      { channel: 'AMAZON', marketplace: 'IT' }, { channel: 'AMAZON', marketplace: 'DE' },
      { channel: 'AMAZON', marketplace: 'FR', closed: true }, { channel: 'AMAZON', marketplace: 'ES', fba: true },
    ])
    const snapshot = async () => Promise.all(Object.values(l).map(listing))
    const before = await snapshot()

    // Only IT: Amazon would change DE with it. Refused, nothing written anywhere (a closed FR and an FBA ES are not
    // part of the shared number, so they are not named).
    const itOnly = await runJob('AMAZON', { quantityOverride: 6 }, { targetProductIds: ['eu'], filters: { marketplace: 'IT' } })
    expect(itOnly.items.map((i) => [i.channelListingId, i.status])).toEqual([[l['AMAZON:IT'], 'FAILED']])
    expect(itOnly.items[0].errorMessage).toBe('Amazon keeps ONE quantity per SKU across the EU markets, so this change also covers DE. Include every EU market of this listing in the job (no market filter) — nothing was changed.')
    expect(await snapshot()).toEqual(before)
    for (const id of Object.values(l)) expect(await queueOf(id)).toEqual([])

    // The whole product: IT and DE change together; the closed FR offer and the FBA ES row are refused by name.
    const all = await runJob('AMAZON', { quantityOverride: 6 }, { targetProductIds: ['eu'] })
    const status = Object.fromEntries(all.items.map((i) => [i.channelListingId, [i.status, i.errorMessage]]))
    expect(status[l['AMAZON:IT']]).toEqual(['SUCCEEDED', null])
    expect(status[l['AMAZON:DE']]).toEqual(['SUCCEEDED', null])
    expect(status[l['AMAZON:FR']]![1]).toMatch(/offer is closed, and a quantity change never reopens it/)
    expect(status[l['AMAZON:ES']]![1]).toMatch(/\(FBA\)/)
    for (const m of ['IT', 'DE']) {
      expect(qtyColumns(await listing(l[`AMAZON:${m}`]))).toMatchObject({ quantity: 6, quantityOverride: 6, followMasterQuantity: false })
      expect((await queueOf(l[`AMAZON:${m}`])).map((r) => [r.syncType, (r.payload as any).quantity])).toEqual([['QUANTITY_UPDATE', 6]])
    }
    for (const m of ['FR', 'ES']) {
      expect(await listing(l[`AMAZON:${m}`])).toEqual(before.find((b) => b.id === l[`AMAZON:${m}`]))
      expect(await queueOf(l[`AMAZON:${m}`])).toEqual([])
    }
    // The EU guard sees one agreed number, so the push layer will send it.
    const rows = await snapshot()
    expect(detectEuIntentConflict(rows.map((r) => ({ marketplace: r.marketplace, followMasterQuantity: r.followMasterQuantity, quantityOverride: r.quantityOverride, quantity: r.quantity, isFba: r.fulfillmentMethod === 'FBA', offerClosed: !!r.offerClosedAt }))).conflict).toBe(false)
    // The group was changed once: one primitive call for the pair, not one per row.
    expect(pin.mock.calls.filter(([o]) => o.channel === 'AMAZON').map(([o]) => [...o.markets].sort())).toEqual([['DE', 'IT']])
  }), 60_000)

  it('a Shopify quantity is refused: the primitives serve Amazon and eBay only', () => scoped(async () => {
    const id = (await seed('shopify-qty', [{ channel: 'SHOPIFY', marketplace: 'GLOBAL' }]))['SHOPIFY:GLOBAL']
    const before = await listing(id)
    const { items } = await runJob('SHOPIFY', { quantityOverride: 2 }, { targetProductIds: ['shopify-qty'] })
    expect(items.map((i) => [i.status, i.errorMessage])).toEqual([['FAILED', 'A fixed quantity or a stock buffer is set on Amazon and eBay listings only, so nothing was changed.']])
    expect(await listing(id)).toEqual(before)
    expect(await queueOf(id)).toEqual([])
  }), 60_000)

  it('🔴 the publish flag is refused as the single-listing edit refuses it — before a job exists, and by row for a stored one', () => scoped(async () => {
    const id = (await seed('publish', [{ channel: 'AMAZON', marketplace: 'UK' }]))['AMAZON:UK']
    await expect(service.createJob({ jobName: 'pause', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['publish'], actionPayload: { isPublished: false } }))
      .rejects.toThrow(PUBLISH_FLAG_REFUSAL)
    // The built-in "Pause listings (Amazon DE)" template's shape, stored before this change.
    const stored = await prisma.bulkActionJob.create({ data: { jobName: 'stored pause', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['publish'], targetVariationIds: [], actionPayload: { isPublished: false }, status: 'PENDING', totalItems: 1 } })
    const result = await service.processJob(stored.id)
    expect(result.errors.map((e) => e.error)).toEqual([PUBLISH_FLAG_REFUSAL])
    expect((await listing(id)).isPublished).toBe(true)
    expect(await queueOf(id)).toEqual([])
  }), 60_000)

  it('a quantity or buffer that is not a whole number, zero or more, is refused before a job exists', () => scoped(async () => {
    await seed('bad-qty', [{ channel: 'EBAY', marketplace: 'IT' }])
    const create = (actionPayload: Record<string, unknown>) => service.createJob({ jobName: 'bad', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'EBAY', targetProductIds: ['bad-qty'], actionPayload })
    await expect(create({ quantityOverride: -1 })).rejects.toThrow('quantityOverride must be a whole number, zero or more.')
    await expect(create({ quantityOverride: 2.5 })).rejects.toThrow('quantityOverride must be a whole number, zero or more.')
    await expect(create({ quantityOverride: 'abc' })).rejects.toThrow('quantityOverride must be a whole number, or null to follow the stock again.')
    await expect(create({ quantityOverride: 2, followMasterQuantity: true })).rejects.toThrow('contradict each other')
    await expect(create({ quantityOverride: null, followMasterQuantity: false })).rejects.toThrow('contradict each other')
    await expect(create({ stockBuffer: -2 })).rejects.toThrow('stockBuffer must be a whole number, zero or more.')
  }), 60_000)
})

describe('the preview (dry run)', () => {
  it('🔴 shows the quantity and buffer it will ask for, and writes and queues nothing', () => scoped(async () => {
    const id = (await seed('preview-qty', [{ channel: 'EBAY', marketplace: 'IT', buffer: 1 }]))['EBAY:IT']
    const before = { listing: await listing(id), queue: await prisma.outboundSyncQueue.count(), jobs: await prisma.bulkActionJob.count() }
    const preview = await service.previewJob({ jobName: 'p', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'EBAY', targetProductIds: ['preview-qty'], actionPayload: { quantityOverride: 4, stockBuffer: 2 } })
    expect(preview.sampleItems.map((s) => [s.currentValue, s.newValue])).toEqual([[{ quantity: 'follows the stock', stockBuffer: 1 }, { quantity: 4, stockBuffer: 2 }]])
    expect({ listing: await listing(id), queue: await prisma.outboundSyncQueue.count(), jobs: await prisma.bulkActionJob.count() }).toEqual(before)
    expect(pin).not.toHaveBeenCalled()
    expect(buffer).not.toHaveBeenCalled()
  }), 60_000)
})

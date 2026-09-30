/**
 * A bulk per-channel price override reaches the channel (2026-09-30, "Get everything fixed").
 *
 * 🔴 WHAT THIS GUARDS. `MARKETPLACE_OVERRIDE_UPDATE` wrote `priceOverride` and nothing else: `followMasterPrice`
 * stayed true, `price` — the column the channel push reads — did not move, no audit or timeline row was written and
 * no PRICE_UPDATE row was queued. The job said COMPLETED and Amazon / eBay / Shopify never got the price
 * (reproduced on this database before the fix: priceOverride 19.99, price 10, followMasterPrice true, 0 queue rows).
 *
 * Now the price goes through the ONE channel price write (`writeChannelPrices`), so each arm compares the bulk
 * action with the single edit through that door: the same listing columns, the same audit, the same queue row.
 *
 * On a real PostgreSQL in-process (PGlite): these arms test what a write stores, not a race.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, fired: [] as Array<{ ids: string[]; insideTransaction: boolean }> }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', async () => {
  const { activeDatabaseTransaction } = await import('../lib/database-context.js')
  return {
    fireOutboundJobs: vi.fn(async (rows: Array<{ id: string }>) => {
      state.fired.push({ ids: rows.map((r) => r.id), insideTransaction: activeDatabaseTransaction() !== undefined })
    }),
  }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// The real door, wrapped so an arm can see that the bulk action called it.
vi.mock('./pim/channel-price-write.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pim/channel-price-write.service.js')>()
  return { ...real, writeChannelPrices: vi.fn(real.writeChannelPrices) }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { BulkActionService, marketplaceOverridePlan } from './bulk-action.service.js'
import { writeChannelPrices } from './pim/channel-price-write.service.js'

const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const scoped = <T>(work: () => Promise<T>) => withWorkspace(scope(LEGACY_WORKSPACE_ID), work)
const service = new BulkActionService(prisma as never)
const door = vi.mocked(writeChannelPrices)

const CHANNELS = [
  { channel: 'AMAZON', marketplace: 'IT', region: 'EU' },
  { channel: 'EBAY', marketplace: 'IT', region: 'EU' },
  { channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL' },
  { channel: 'ETSY', marketplace: 'GLOBAL', region: 'GLOBAL' },
] as const
const account: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  for (const { channel, marketplace, region } of CHANNELS) {
    await prisma.marketplace.create({ data: { channel, code: marketplace, name: `${channel} ${marketplace}`, currency: 'EUR', region, language: 'it', languages: ['it'] } })
    account[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `bulk-override-${channel}`, isActive: true } })).id
  }
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'AMAZON DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
}), 120_000)
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); door.mockClear() })
afterAll(async () => { await state.db?.close() }, 60_000)

type Pin = { pinned?: number }
/** A product and one listing per named channel/market, following the master price unless pinned. The listing names
 *  its account, as a live one does (the queue row's destination is then read through the transaction). */
async function seed(id: string, markets: Array<{ channel: string; marketplace: string; region: string }>, opts: Pin & { basePrice?: number } = {}) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: opts.basePrice ?? 10, totalStock: 7 } })
  const listings: Record<string, { id: string; version: number }> = {}
  for (const m of markets) {
    const pinned = opts.pinned != null
    const row = await prisma.channelListing.create({ data: {
      productId: id, channel: m.channel, channelConnectionId: account[m.channel], channelMarket: `${m.channel}_${m.marketplace}`,
      marketplace: m.marketplace, region: m.region, price: pinned ? opts.pinned : 10, priceOverride: pinned ? opts.pinned : null,
      followMasterPrice: !pinned, quantity: 5, quantityOverride: 3, followMasterQuantity: false, stockBuffer: 1,
    } })
    listings[`${m.channel}:${m.marketplace}`] = { id: row.id, version: row.version }
  }
  return listings
}
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const queueOf = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
const overridesOf = (channelListingId: string) => prisma.channelListingOverride.findMany({ where: { channelListingId } })
const timelineOf = (productId: string, channel: string) => prisma.priceChangeEvent.findMany({ where: { productId, channel } })
async function runJob(channel: string, actionPayload: Record<string, unknown>, extra: { targetProductIds?: string[]; filters?: Record<string, unknown> } = {}) {
  const job = await service.createJob({ jobName: `override ${channel}`, actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel, actionPayload, createdBy: 'person-1', ...extra })
  const result = await service.processJob(job.id)
  const items = await prisma.bulkActionItem.findMany({ where: { jobId: job.id } })
  return { job, result, items }
}
/** What a queue row says, without the fields that name the row itself or when it was made. */
const rowShape = (row: Record<string, any>) => {
  const { actor: _actor, ...payload } = row.payload
  return { targetChannel: row.targetChannel, targetRegion: row.targetRegion, syncStatus: row.syncStatus, syncType: row.syncType,
    maxRetries: row.maxRetries, externalListingId: row.externalListingId, channelConnectionId: row.channelConnectionId, payload }
}
const listingShape = (row: Record<string, any>) => ({
  price: row.price == null ? null : Number(row.price), priceOverride: row.priceOverride == null ? null : Number(row.priceOverride),
  followMasterPrice: row.followMasterPrice, syncStatus: row.syncStatus, lastSyncStatus: row.lastSyncStatus, version: row.version,
})
const quantityShape = (row: Record<string, any>) => ({ quantity: row.quantity, quantityOverride: row.quantityOverride, followMasterQuantity: row.followMasterQuantity, stockBuffer: row.stockBuffer })
const inThirtySeconds = (at: Date | null) => {
  const ms = (at?.getTime() ?? 0) - Date.now()
  return ms > 20_000 && ms <= 30_000
}

describe('a bulk channel price override goes through the ONE channel price write', () => {
  it('🔴 each channel: the same listing columns, audit and queue row as the single edit — and nothing else moves', () => scoped(async () => {
    const bulk = await seed('bulk-all', CHANNELS as never)
    const single = await seed('single-all', CHANNELS as never)
    const before = Object.fromEntries(await Promise.all(Object.values(bulk).map(async (l) => [l.id, await listing(l.id)])))
    const queuedChannels: string[] = []

    for (const [index, { channel, marketplace }] of CHANNELS.entries()) {
      const key = `${channel}:${marketplace}`
      state.fired = []
      const { result, items } = await runJob(channel, { priceOverride: 19.99 }, { targetProductIds: ['bulk-all'] })
      expect(result, channel).toMatchObject({ status: 'COMPLETED', processedItems: 1, failedItems: 0 })
      expect(items.map((i) => [i.channelListingId, i.status]), channel).toEqual([[bulk[key].id, 'SUCCEEDED']])
      // Only this channel's listing: the product's listings on the channels still to come are untouched.
      for (const later of CHANNELS.slice(index + 1)) {
        const id = bulk[`${later.channel}:${later.marketplace}`].id
        expect(listingShape(await listing(id)), `${later.channel} after the ${channel} job`).toEqual(listingShape(before[id]))
      }

      const once = await writeChannelPrices({ targets: [{ listingId: single[key].id, price: 19.99, expectedVersion: single[key].version }], actor: 'person-1', source: 'MANUAL_OVERRIDE', reason: 'matrix' })
      expect(once.results[0].outcome, channel).toBe('applied')

      const [b, s] = [await listing(bulk[key].id), await listing(single[key].id)]
      expect(listingShape(b), channel).toEqual(listingShape(s))
      expect(listingShape(b), channel).toMatchObject({ price: 19.99, priceOverride: 19.99, followMasterPrice: false, version: before[bulk[key].id].version + 1 })
      expect(b.lastOverrideBy, channel).toBe('person-1')
      // 🔴 Never a quantity: the price job leaves every quantity column exactly as it was.
      expect(quantityShape(b), channel).toEqual(quantityShape(before[bulk[key].id]))

      // 🔴 For EVERY channel, the bulk action queues exactly what the single edit queues in this same run — whatever
      // the door's channel lanes are today. No count is hard-coded per channel: when the door gains a lane (Etsy,
      // PR #205) both queue it; if the bulk ever differs from the single edit, this fails.
      const [bq, sq] = [await queueOf(bulk[key].id), await queueOf(single[key].id)]
      expect(bq.map(rowShape), channel).toEqual(sq.map(rowShape))
      expect(sq.length, `${channel}: the single edit queues at most one PRICE_UPDATE`).toBeLessThanOrEqual(1)
      if (bq.length) {
        queuedChannels.push(channel)
        expect(bq[0], channel).toMatchObject({ syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', payload: { price: 19.99, source: 'CHANNEL_PRICE_WRITE', actor: 'person-1', marketplace } })
        expect(inThirtySeconds(bq[0].holdUntil), channel).toBe(true)
        // Sent to the instant lane after the commit, never from inside the transaction.
        expect(state.fired[0], channel).toEqual({ ids: [bq[0].id], insideTransaction: false })
      }

      const [bo, so] = [await overridesOf(bulk[key].id), await overridesOf(single[key].id)]
      expect(bo.map((o) => [o.fieldName, o.previousValue, o.newValue, o.changedBy]), channel).toEqual(so.map((o) => [o.fieldName, o.previousValue, o.newValue, o.changedBy]))
      expect(bo[0].reason, channel).toMatch(/^Bulk action \S+: price /)
      const [bt, st] = [await timelineOf('bulk-all', channel), await timelineOf('single-all', channel)]
      expect(bt.map((e) => [Number(e.oldPrice), Number(e.newPrice), e.currency]), channel).toEqual(st.map((e) => [Number(e.oldPrice), Number(e.newPrice), e.currency]))
      expect(bt.map((e) => e.source), channel).toEqual(['BULK_OVERRIDE'])
    }
    // Not vacuous: the channels the door has always sent to did queue (Etsy may or may not, as the door decides).
    expect(queuedChannels).toEqual(expect.arrayContaining(['AMAZON', 'EBAY', 'SHOPIFY']))
    // Four jobs, four calls of the door, one listing each.
    expect(door.mock.calls.filter(([input]) => input.source === 'BULK_OVERRIDE').map(([input]) => input.targets.length)).toEqual([1, 1, 1, 1])
  }), 60_000)

  it('🔴 clearing the override (priceOverride: null or followMasterPrice: true) sends the master price, as the single edit does', () => scoped(async () => {
    const market = [CHANNELS[0]]
    const viaNull = await seed('clear-null', market, { pinned: 25, basePrice: 12 })
    const viaFollow = await seed('clear-follow', market, { pinned: 25, basePrice: 12 })
    const single = await seed('clear-single', market, { pinned: 25, basePrice: 12 })

    expect((await runJob('AMAZON', { priceOverride: null }, { targetProductIds: ['clear-null'] })).result).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect((await runJob('AMAZON', { followMasterPrice: true }, { targetProductIds: ['clear-follow'] })).result).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    await writeChannelPrices({ targets: [{ listingId: single['AMAZON:IT'].id, price: null, expectedVersion: single['AMAZON:IT'].version }], actor: 'person-1', source: 'MANUAL_OVERRIDE' })

    const expected = listingShape(await listing(single['AMAZON:IT'].id))
    expect(expected).toMatchObject({ price: null, priceOverride: null, followMasterPrice: true })
    const singleRow = (await queueOf(single['AMAZON:IT'].id)).map(rowShape)
    expect(singleRow).toEqual([expect.objectContaining({ syncType: 'PRICE_UPDATE', payload: expect.objectContaining({ price: 12 }) })])
    for (const l of [viaNull['AMAZON:IT'], viaFollow['AMAZON:IT']]) {
      expect(listingShape(await listing(l.id))).toEqual(expected)
      expect((await queueOf(l.id)).map(rowShape)).toEqual(singleRow)
    }
  }), 60_000)

  it('the same price again is a no-op: skipped, nothing written, nothing queued', () => scoped(async () => {
    const l = (await seed('noop', [CHANNELS[1]], { pinned: 19.99 }))['EBAY:IT']
    const before = await listing(l.id)
    const { result, items } = await runJob('EBAY', { priceOverride: 19.99 }, { targetProductIds: ['noop'] })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 0, skippedItems: 1, failedItems: 0 })
    expect(items.map((i) => i.status)).toEqual(['SKIPPED'])
    expect(await listing(l.id)).toEqual(before)
    expect(await queueOf(l.id)).toEqual([])
  }), 60_000)

  it('a payload without a price keeps its old path: written as before, the door not called, nothing queued', () => scoped(async () => {
    const l = (await seed('no-price', [CHANNELS[0]]))['AMAZON:IT']
    const before = await listing(l.id)
    const { result } = await runJob('AMAZON', { followMasterTitle: false }, { targetProductIds: ['no-price'] })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    const after = await listing(l.id)
    expect(after.followMasterTitle).toBe(false)
    expect(after.lastOverrideAt).not.toBeNull()
    expect(listingShape(after)).toEqual(listingShape(before))
    expect(door).not.toHaveBeenCalled()
    expect(await queueOf(l.id)).toEqual([])
  }), 60_000)

  it('a price and other columns land together in one transaction — or not at all', () => scoped(async () => {
    const l = (await seed('together', [CHANNELS[0]]))['AMAZON:IT']
    await runJob('AMAZON', { priceOverride: 15, followMasterTitle: false }, { targetProductIds: ['together'] })
    expect(await listing(l.id)).toMatchObject({ followMasterTitle: false, followMasterPrice: false })
    expect(Number((await listing(l.id)).price)).toBe(15)
    expect(await queueOf(l.id)).toHaveLength(1)

    // The door refuses (a listing that vanished between the job's read and its write): the other column is not written either.
    const gone = (await seed('together-refused', [CHANNELS[0]]))['AMAZON:IT']
    door.mockImplementationOnce(async (input) => ({ results: [{ listingId: input.targets[0].listingId, productId: null, channel: null, marketplace: null, outcome: 'refused', reason: 'No listing with this id', version: 0, guarded: true, queueId: null }], applied: 0, refused: 1, noop: 0, conflict: 0 }))
    const { items } = await runJob('AMAZON', { priceOverride: 15, followMasterTitle: false }, { targetProductIds: ['together-refused'] })
    expect(items.map((i) => [i.status, i.errorMessage])).toEqual([['FAILED', 'No listing with this id']])
    expect((await listing(gone.id)).followMasterTitle).toBe(true)

    // 🔴 The other way round: the price is written, then the other column fails (5000 does not fit the 5,2 column).
    // The price is rolled back with it, and nothing was queued or sent for a price that is not there.
    const late = (await seed('together-late', [CHANNELS[0]]))['AMAZON:IT']
    const lateBefore = await listing(late.id)
    state.fired = []
    const failedLate = await runJob('AMAZON', { priceOverride: 15, priceAdjustmentPercent: 5000 }, { targetProductIds: ['together-late'] })
    expect(failedLate.items.map((i) => i.status)).toEqual(['FAILED'])
    expect(door).toHaveBeenLastCalledWith(expect.objectContaining({ targets: [expect.objectContaining({ listingId: late.id, price: 15 })] }))
    expect(await listing(late.id)).toEqual(lateBefore)
    expect(await queueOf(late.id)).toEqual([])
    expect(await overridesOf(late.id)).toEqual([])
    expect(state.fired).toEqual([])
  }), 60_000)
})

describe('the preview (the bulk action\'s dry run)', () => {
  it('🔴 writes nothing, queues nothing, and shows the plan the run executes — for the job\'s channel only', () => scoped(async () => {
    const l = await seed('preview', [CHANNELS[0], CHANNELS[1]], { pinned: 25 })
    const snapshot = async () => ({
      listings: await prisma.channelListing.findMany({ where: { productId: 'preview' }, orderBy: { id: 'asc' } }),
      queue: await prisma.outboundSyncQueue.count(), overrides: await prisma.channelListingOverride.count(),
      timeline: await prisma.priceChangeEvent.count(), jobs: await prisma.bulkActionJob.count(), items: await prisma.bulkActionItem.count(),
    })
    const before = await snapshot()
    const preview = await service.previewJob({ jobName: 'preview', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['preview'], actionPayload: { priceOverride: 18.5, stockBuffer: 2 } })
    expect(await snapshot()).toEqual(before)
    expect(door).not.toHaveBeenCalled()
    // Before the fix this threw "Unknown action type: MARKETPLACE_OVERRIDE_UPDATE", and it sampled every channel.
    expect(preview).toEqual({ affectedCount: 1, sampleItems: [expect.objectContaining({
      id: l['AMAZON:IT'].id, status: 'processed', currentValue: { price: 25, stockBuffer: 1 }, newValue: { price: 18.5, stockBuffer: 2 },
    })] })
    const clear = await service.previewJob({ jobName: 'preview', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'EBAY', targetProductIds: ['preview'], actionPayload: { followMasterPrice: true } })
    expect(clear.sampleItems.map((s) => [s.id, s.currentValue, s.newValue])).toEqual([[l['EBAY:IT'].id, { price: 25 }, { price: 'follows the master price' }]])
    expect(await snapshot()).toEqual(before)
  }), 60_000)
})

describe('per-row errors are reported, never swallowed', () => {
  it('🔴 a price changed elsewhere during the run is not overwritten: that row FAILS and says why; a quantity write in between is not a change', () => scoped(async () => {
    const a = (await seed('row-a', [CHANNELS[0]]))['AMAZON:IT']
    const b = (await seed('row-b', [CHANNELS[0]]))['AMAZON:IT']
    const c = (await seed('row-c', [CHANNELS[0]]))['AMAZON:IT']
    const real = (service as any).processItem.bind(service)
    vi.spyOn(service as any, 'processItem').mockImplementation(async (item: any, job: any) => {
      // Someone sets B's price in the Studio after the job read the listings, before the job reaches B.
      if (item.id === b.id) await writeChannelPrices({ targets: [{ listingId: b.id, price: 30, expectedVersion: b.version }], actor: 'studio', source: 'MANUAL_OVERRIDE' })
      // A write that is not a price bumps C's version.
      if (item.id === c.id) await prisma.channelListing.update({ where: { id: c.id }, data: { title: 'renamed', version: { increment: 1 } } })
      return real(item, job)
    })
    const { result, items } = await runJob('AMAZON', { priceOverride: 19.99 }, { targetProductIds: ['row-a', 'row-b', 'row-c'] })

    expect(result).toMatchObject({ status: 'PARTIALLY_COMPLETED', processedItems: 2, failedItems: 1 })
    expect(result.errors.map((e) => e.itemId)).toEqual([b.id])
    const failed = items.find((i) => i.channelListingId === b.id)!
    expect(failed.status).toBe('FAILED')
    expect(failed.errorMessage).toMatch(/changed after the job read it, so it was not overwritten/)
    const job = await prisma.bulkActionJob.findUniqueOrThrow({ where: { id: result.jobId } })
    expect(job.lastError).toMatch(/not overwritten/)
    // B keeps the Studio price and only the Studio's queue row; A and C carry the bulk price.
    expect(Number((await listing(b.id)).price)).toBe(30)
    expect((await queueOf(b.id)).map((r) => (r.payload as any).actor)).toEqual(['studio'])
    for (const l of [a, c]) {
      expect(Number((await listing(l.id)).price)).toBe(19.99)
      expect((await queueOf(l.id)).map((r) => (r.payload as any).price)).toEqual([19.99])
    }
  }), 60_000)

  it('a payload every row would refuse is refused before a job exists; one already stored fails each row by name', () => scoped(async () => {
    await seed('bad-payload', [CHANNELS[0]])
    const create = (actionPayload: Record<string, unknown>) => service.createJob({ jobName: 'bad', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['bad-payload'], actionPayload })
    await expect(create({ followMasterPrice: false })).rejects.toThrow('followMasterPrice: false needs the price to send')
    await expect(create({ priceOverride: 'abc' })).rejects.toThrow('priceOverride must be a number')
    await expect(create({ priceOverride: 20, followMasterPrice: true })).rejects.toThrow('contradict each other')
    await expect(create({})).rejects.toThrow('at least one override field required')
    // A job stored before this check (a schedule or an old row): every row fails, by name, and nothing is written.
    const stored = await prisma.bulkActionJob.create({ data: { jobName: 'stored', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['bad-payload'], targetVariationIds: [], actionPayload: { priceOverride: -5 }, status: 'PENDING', totalItems: 1 } })
    const result = await service.processJob(stored.id)
    expect(result).toMatchObject({ status: 'FAILED', failedItems: 1 })
    expect(result.errors.map((e) => e.error)).toEqual(['priceOverride must be zero or more.'])
    const row = await prisma.channelListing.findFirstOrThrow({ where: { productId: 'bad-payload' } })
    expect(listingShape(row)).toMatchObject({ price: 10, priceOverride: null, followMasterPrice: true })
    expect(await queueOf(row.id)).toEqual([])
  }), 60_000)

  it('the plan never hands a price to the other columns (the price has one way out)', () => {
    for (const payload of [{ priceOverride: 5 }, { priceOverride: null }, { followMasterPrice: true }, { priceOverride: 5, followMasterPrice: false, stockBuffer: 1 }]) {
      const plan = marketplaceOverridePlan(payload)
      expect(plan.price, JSON.stringify(payload)).not.toBeUndefined()
      expect(Object.keys(plan.columns).filter((k) => /price/i.test(k) && k !== 'priceAdjustmentPercent'), JSON.stringify(payload)).toEqual([])
    }
  })
})

describe('the market scope holds — a price for Amazon DE never goes to Amazon IT', () => {
  it('🔴 product ids and a market filter together: only that market, and a retry of failed rows keeps it', () => scoped(async () => {
    const l = await seed('scope', [CHANNELS[0], { channel: 'AMAZON', marketplace: 'DE', region: 'EU' }])
    const it_ = l['AMAZON:IT']; const de = l['AMAZON:DE']
    const itBefore = listingShape(await listing(it_.id))
    // Someone changes DE's price mid-run, so the DE row fails and is retried.
    const real = (service as any).processItem.bind(service)
    let once = true
    vi.spyOn(service as any, 'processItem').mockImplementation(async (item: any, job: any) => {
      if (item.id === de.id && once) { once = false; await writeChannelPrices({ targets: [{ listingId: de.id, price: 30, expectedVersion: de.version }], actor: 'studio', source: 'MANUAL_OVERRIDE' }) }
      return real(item, job)
    })
    const first = await runJob('AMAZON', { priceOverride: 21 }, { targetProductIds: ['scope'], filters: { marketplace: 'DE' } })
    expect(first.items.map((i) => [i.channelListingId, i.status])).toEqual([[de.id, 'FAILED']])

    const retry = await service.retryFailedItems(first.job.id)
    expect(retry.filters).toEqual({ marketplace: 'DE' })
    const second = await service.processJob(retry.id)
    expect(second).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect(Number((await listing(de.id)).price)).toBe(21)
    // Amazon IT: never touched, never queued, by either job.
    expect(listingShape(await listing(it_.id))).toEqual(itBefore)
    expect(await queueOf(it_.id)).toEqual([])
  }), 60_000)
})

describe('another business', () => {
  it('🔴 with profiles ON, a job never touches or queues another business\'s listing, even when named by id', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    const OTHER = 'ws_other_bulk_override'
    await state.db.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [OTHER])
    const theirs = await withWorkspace(scope(OTHER), async () => {
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
      // Its own seller account (an active account is unique across businesses by its marketplace identity).
      const acct = await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'other-amazon', externalAccountId: 'OTHER-MERCHANT-TEST', isActive: true } })
      await prisma.product.create({ data: { id: 'other-product', sku: 'OTHER-SKU', name: 'other', basePrice: 10 } })
      return prisma.channelListing.create({ data: { productId: 'other-product', channel: 'AMAZON', channelConnectionId: acct.id, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU', price: 10, followMasterPrice: true } })
    })
    const raw = async () => (await state.db.db.query(`SELECT price::float8 AS price, "priceOverride"::float8 AS "priceOverride", "followMasterPrice", version FROM "ChannelListing" WHERE id = $1`, [theirs.id])).rows[0]
    const rawQueue = async () => (await state.db.db.query(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "channelListingId" = $1`, [theirs.id])).rows[0].n
    const theirsBefore = await raw()
    // Positive control: the scope is real here — their listing exists, and this business cannot see it.
    expect(await withWorkspace(scope(OTHER), () => prisma.channelListing.findUnique({ where: { id: theirs.id } }))).not.toBeNull()
    expect(await scoped(() => prisma.channelListing.findUnique({ where: { id: theirs.id } }))).toBeNull()

    const mine = await scoped(() => seed('mine-profiles-on', [CHANNELS[0]]))
    const { result, items } = await scoped(() => runJob('AMAZON', { priceOverride: 9.5 }, { targetProductIds: ['mine-profiles-on', 'other-product'] }))

    expect(items.map((i) => i.channelListingId)).toEqual([mine['AMAZON:IT'].id])
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1, failedItems: 0 })
    expect(await raw()).toEqual(theirsBefore)
    expect(await rawQueue()).toBe(0)
    const queued = (await state.db.db.query(`SELECT "workspaceId" FROM "OutboundSyncQueue" WHERE "channelListingId" = $1`, [mine['AMAZON:IT'].id])).rows
    expect(queued).toEqual([{ workspaceId: LEGACY_WORKSPACE_ID }])
  }, 60_000)
})

describe('the source scan — the bulk action writes no channel price itself', () => {
  /*
   * Every line of bulk-action.service.ts that names a channel price column, and why it is not a write. A new line
   * fails here until someone names it: a direct `priceOverride` / `price` / `followMasterPrice` write would take the
   * price around the door again — written, audited nowhere, queued never, which is the bug this file exists for.
   */
  const NOT_A_WRITE: Array<[string, string]> = [
    ['state snapshot (history diff)', 'price: item.price != null ? Number(item.price) : null,'],
    ['state snapshot (history diff)', 'priceOverride:'],
    ['state snapshot (history diff)', 'item.priceOverride != null ? Number(item.priceOverride) : null,'],
    ['state snapshot (history diff)', 'followMasterPrice: item.followMasterPrice ?? null,'],
    ['state re-read (select)', 'price: true,'],
    ['state re-read (select)', 'priceOverride: true,'],
    ['state re-read (select)', 'followMasterPrice: true,'],
    ['A-17 own price as read', "function ownPriceAsRead(listing: Pick<ChannelListing, 'price' | 'priceOverride' | 'followMasterPrice'>)"],
    ['A-17 own price as read', 'const override = listing.priceOverride == null ? null : Number(listing.priceOverride);'],
    ['A-17 own price as read', 'if (listing.followMasterPrice === false) return override ?? (listing.price == null ? null : Number(listing.price));'],
    ['the plan\'s own variable (a type annotation)', 'let price: number | null | undefined;'],
    ['the plan reads the payload', "if ('priceOverride' in payload) {"],
    ['the plan reads the payload', 'const v = numOrNull(payload.priceOverride);'],
    ['the plan reads the payload', "throw new BulkActionInputError('priceOverride must be a number, or null to follow the master price again.');"],
    ['the plan reads the payload', "throw new BulkActionInputError('priceOverride must be zero or more.');"],
    ['the plan reads the payload', 'if (payload.followMasterPrice === true) {'],
    ['the plan reads the payload', "throw new BulkActionInputError('priceOverride and followMasterPrice: true contradict each other: send one of them.');"],
    ['the plan reads the payload', '} else if (payload.followMasterPrice === false && price == null) {'],
    ['the plan reads the payload', "throw new BulkActionInputError('followMasterPrice: false needs the price to send: set priceOverride to it.');"],
    ['preview display', 'listing.followMasterPrice === false'],
    ['preview display', '? Number(listing.priceOverride ?? listing.price)'],
    ['CHANNEL_BATCH reads the listing', 'price: true,'],
    ['CHANNEL_BATCH sends through its account', 'await syncShopifyLinkedListing(shopifyRow, accountId, { price: value });'],
  ]
  const source = readFileSync(fileURLToPath(new URL('./bulk-action.service.ts', import.meta.url)), 'utf8')
  const lines = source.split('\n').map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((r) => !r.text.startsWith('//') && !r.text.startsWith('*') && !r.text.startsWith('/*'))
  const named = lines.filter((r) => /\b(priceOverride|followMasterPrice)\b|(^|[^a-zA-Z.])price\s*:/.test(r.text))

  it('every line that names a channel price column is a named read, and none of the names is stale', () => {
    expect(named.length).toBeGreaterThan(0) // positive control: the scan sees the file
    expect(named.filter((r) => !NOT_A_WRITE.some(([, snippet]) => r.text === snippet || r.text.startsWith(snippet))).map((r) => `${r.line}: ${r.text}`)).toEqual([])
    expect(NOT_A_WRITE.filter(([, snippet]) => !named.some((r) => r.text === snippet || r.text.startsWith(snippet)))).toEqual([])
  })
  it('the override handler calls the door', () => {
    const handler = source.slice(source.indexOf('private async processMarketplaceOverrideUpdate('), source.indexOf('private async countItemsByFilters('))
    expect(handler).toContain('writeChannelPrices({')
    expect(handler).not.toMatch(/channelListing\.(update|updateMany)\([^)]*price/i)
  })
})

/**
 * The channel price door's MACHINE mode, and the snapshot repricer's Match Amazon through it (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. Match Amazon (a listing that FOLLOWS the master under MATCH_AMAZON takes no price from the
 * master: a machine sets it from the lowest competitor) is kept, but no longer as a writer of its own. A machine price
 * now goes through the ONE door (`machinePrice`, named reason `repricer`) with the door's gates: only on a following
 * Match Amazon listing (which stays following), above 0, inside the product's floor/ceiling in the master currency only
 * (never compared across currencies), held in Nexus for a paused listing or a draft — stored, audited and ONE PENDING
 * PRICE_UPDATE on the 30 s hold. The snapshot repricer (`runRepricerTick`, live only with NEXUS_REPRICER_LIVE=1, OFF
 * in production today) sets the engine's Match Amazon suggestion through it, and sends any other follower its own
 * rule price, never the suggestion.
 *
 * Real PostgreSQL in-process (PGlite), the pattern of `price-door-follower.vitest.test.ts`. Every id is invented.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { runRepricerTick } from '../repricer-scheduler.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'UK', name: 'United Kingdom', currency: 'GBP', region: 'EU', language: 'en', languages: ['en'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'machine-price', isActive: true } })).id
}), 120_000)
afterEach(() => { vi.unstubAllEnvs() })
afterAll(async () => { await state.db?.close() }, 60_000)

interface Seed {
  marketplace?: string
  follow?: boolean
  rule?: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
  price?: number
  listing?: Record<string, unknown>
  product?: Record<string, unknown>
}
/** A product at master 20 and one live Amazon listing FOLLOWING it under Match Amazon at 20, unless told otherwise. */
async function seed(sku: string, s: Seed = {}) {
  const marketplace = s.marketplace ?? 'IT'
  const follow = s.follow ?? true
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 20, ...s.product } as never })
  return prisma.channelListing.create({ data: {
    productId: product.id, channel: 'AMAZON', channelConnectionId: account, channelMarket: `AMAZON_${marketplace}`, marketplace, region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${sku}`,
    price: s.price ?? 20, priceOverride: follow ? null : (s.price ?? 20), followMasterPrice: follow, masterPrice: 20,
    pricingRule: s.rule ?? 'MATCH_AMAZON',
    ...s.listing,
  } as never })
}
const machine = (listingId: string, machinePrice: number) =>
  writeChannelPrices({ targets: [{ listingId, machinePrice, unguardedReason: 'repricer' }], actor: 'repricer:test', source: 'REPRICER', reason: 'test' })
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const pending = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' } })
/** Everything a refused change must leave exactly as it was. */
const footprint = async (l: { id: string; productId: string }) => ({
  listing: await listing(l.id),
  queue: await prisma.outboundSyncQueue.count({ where: { channelListingId: l.id } }),
  overrides: await prisma.channelListingOverride.count({ where: { channelListingId: l.id } }),
  timeline: await prisma.priceChangeEvent.count({ where: { productId: l.productId } }),
})
const inThirtySeconds = (at: Date | null) => {
  const ms = (at?.getTime() ?? 0) - Date.now()
  return ms > 20_000 && ms <= 30_000
}

describe('🔴 machine mode: a Match Amazon price set through the door, with the door\'s gates', () => {
  it('a FOLLOWING Match Amazon listing: 18.50 stored, still following, audited, ONE pending row on the 30 s hold; the same price again is a no-op', () => scoped(async () => {
    const l = await seed('TEST-MA-SET')
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'applied', guarded: false, sentPrice: 18.5, version: l.version + 1 })
    expect(r.results[0].queueId).toBeTruthy()
    expect(r.results[0].notSent).toBeUndefined()
    const after = await listing(l.id)
    expect(Number(after.price)).toBe(18.5)
    expect(after).toMatchObject({ followMasterPrice: true, priceOverride: null, pricingRule: 'MATCH_AMAZON', syncStatus: 'PENDING' })
    const rows = await pending(l.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(r.results[0].queueId)
    expect(rows[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 18.5, pricingRule: 'MATCH_AMAZON', machinePrice: true, actor: 'repricer:test' })
    expect(inThirtySeconds(rows[0].holdUntil)).toBe(true)
    expect(await prisma.channelListingOverride.count({ where: { channelListingId: l.id, fieldName: 'price', newValue: '18.5', changedBy: 'repricer:test' } })).toBe(1)
    expect(await prisma.priceChangeEvent.count({ where: { productId: l.productId } })).toBe(1)

    const again = await machine(l.id, 18.5)
    expect(again.results[0]).toMatchObject({ outcome: 'noop', queueId: null })
    expect(await pending(l.id)).toHaveLength(1)
    expect((await listing(l.id)).version).toBe(l.version + 1)
  }))

  it('a FIXED following listing is refused: its rule decides its price; nothing written', () => scoped(async () => {
    const l = await seed('TEST-MA-FIXED', { rule: 'FIXED' })
    const before = await footprint(l)
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'TEST-MA-FIXED on AMAZON IT does not follow Match Amazon, so a machine price is not set on it: its own rule or its pin decides its price.' })
    expect(await footprint(l)).toEqual(before)
  }))

  it('a PINNED Match Amazon listing (not following) is refused: its pin decides its price; nothing written', () => scoped(async () => {
    const l = await seed('TEST-MA-PINNED', { follow: false, price: 24 })
    const before = await footprint(l)
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'TEST-MA-PINNED on AMAZON IT does not follow Match Amazon, so a machine price is not set on it: its own rule or its pin decides its price.' })
    expect(await footprint(l)).toEqual(before)
  }))

  it('EUR, above the product\'s ceiling: refused with the bounds clause; nothing written', () => scoped(async () => {
    const l = await seed('TEST-MA-CEIL', { product: { maxPrice: 15 } })
    const before = await footprint(l)
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'TEST-MA-CEIL on AMAZON IT was not set by Match Amazon: 18.50 is above its pricing ceiling of 15.00. Nothing was changed.' })
    expect(await footprint(l)).toEqual(before)
  }))

  it('EUR, below the product\'s floor: refused the same way', () => scoped(async () => {
    const l = await seed('TEST-MA-FLOOR', { product: { minPrice: 19 } })
    const before = await footprint(l)
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'TEST-MA-FLOOR on AMAZON IT was not set by Match Amazon: 18.50 is below its pricing floor of 19.00. Nothing was changed.' })
    expect(await footprint(l)).toEqual(before)
  }))

  it('a GBP market above that EUR ceiling: applied — a GBP price is never compared with EUR bounds', () => scoped(async () => {
    const l = await seed('TEST-MA-GBP', { marketplace: 'UK', product: { maxPrice: 15 } })
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'applied', sentPrice: 18.5 })
    expect(Number((await listing(l.id)).price)).toBe(18.5)
    const rows = await pending(l.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({ price: 18.5, machinePrice: true, marketplace: 'UK' })
  }))

  it('a paused listing: the price is stored in Nexus, nothing is queued, and the answer says why', () => scoped(async () => {
    const l = await seed('TEST-MA-PAUSED', { listing: { syncPaused: true } })
    const r = await machine(l.id, 18.5)
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null, notSent: 'The price 18.50 is saved in Nexus. Nothing was sent: this listing\'s sync is paused.' })
    expect(r.results[0].sentPrice).toBeUndefined()
    const after = await listing(l.id)
    expect(Number(after.price)).toBe(18.5)
    expect(after.followMasterPrice).toBe(true)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: l.id } })).toBe(0)
  }))

  it('a machine price of 0 is refused; nothing written', () => scoped(async () => {
    const l = await seed('TEST-MA-ZERO')
    const before = await footprint(l)
    const r = await machine(l.id, 0)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'TEST-MA-ZERO on AMAZON IT was not set by Match Amazon: the new price would be 0.00, and a price must be above 0. Nothing was changed.' })
    expect(await footprint(l)).toEqual(before)
  }))

  it('a machine price changes nothing else: one with another field is refused', () => scoped(async () => {
    const l = await seed('TEST-MA-MIXED')
    const before = await footprint(l)
    const r = await writeChannelPrices({ targets: [{ listingId: l.id, machinePrice: 18.5, sale: { value: 17, start: '2026-10-01', end: '2026-10-05' }, unguardedReason: 'repricer' }], actor: 'repricer:test', source: 'REPRICER' })
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'A send or a machine price changes nothing else: send it on its own.' })
    expect(await footprint(l)).toEqual(before)
  }))
})

describe('🔴 the snapshot repricer sets Match Amazon through the door\'s machine mode', () => {
  it('dry-run writes nothing; live: the Match Amazon suggestion is set on the following Match Amazon listing, and a FIXED follower gets its rule price, never the suggestion', () => scoped(async () => {
    const suggestion = (price: number) => ({ suggestion: { kind: 'MATCH_AMAZON', price, reason: `Match Amazon suggestion: ${price}` } })
    // A following Match Amazon listing at 20; the engine shows its price (20) and suggests the competitor undercut 18.49.
    const ma = await seed('TEST-RP-MATCH')
    await prisma.pricingSnapshot.create({ data: { sku: 'TEST-RP-MATCH', channel: 'AMAZON', marketplace: 'IT', computedPrice: 20, currency: 'EUR', source: 'LISTING_PRICE', breakdown: suggestion(18.49) } })
    // A FIXED follower whose stored price is stale at 18 (master 20): the engine's rule price is 20. A Match Amazon
    // suggestion in its breakdown is not its price.
    const fixed = await seed('TEST-RP-FIXED', { rule: 'FIXED', price: 18 })
    await prisma.pricingSnapshot.create({ data: { sku: 'TEST-RP-FIXED', channel: 'AMAZON', marketplace: 'IT', computedPrice: 20, currency: 'EUR', source: 'MASTER_INHERIT', breakdown: suggestion(15) } })
    // A PINNED Match Amazon listing: a suggestion never moves a pin.
    const pinned = await seed('TEST-RP-PINNED', { follow: false, price: 24 })
    await prisma.pricingSnapshot.create({ data: { sku: 'TEST-RP-PINNED', channel: 'AMAZON', marketplace: 'IT', computedPrice: 24, currency: 'EUR', source: 'CHANNEL_OVERRIDE', breakdown: suggestion(18.49) } })
    const ids = [ma.id, fixed.id, pinned.id]

    // Dry run (the switch unset, as in production today): nothing is written or queued.
    const dry = await runRepricerTick(prisma as never)
    expect(dry).toMatchObject({ liveMode: false, enqueued: 0 })
    expect(dry.dryRunWouldEnqueue).toBeGreaterThanOrEqual(2)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: { in: ids } } })).toBe(0)
    expect(Number((await listing(ma.id)).price)).toBe(20)

    vi.stubEnv('NEXUS_REPRICER_LIVE', '1')
    const live = await runRepricerTick(prisma as never)
    expect(live.liveMode).toBe(true)
    expect(live.enqueued).toBeGreaterThanOrEqual(2)

    // Match Amazon: the suggestion, stored and queued through the machine mode; still following.
    const maAfter = await listing(ma.id)
    expect(Number(maAfter.price)).toBe(18.49)
    expect(maAfter).toMatchObject({ followMasterPrice: true, priceOverride: null, pricingRule: 'MATCH_AMAZON' })
    const maRows = await pending(ma.id)
    expect(maRows).toHaveLength(1)
    expect(maRows[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 18.49, machinePrice: true, pricingRule: 'MATCH_AMAZON' })
    expect(inThirtySeconds(maRows[0].holdUntil)).toBe(true)

    // FIXED: its rule price from the master (20), through the follower mode — not the 15 in its breakdown.
    const fixedAfter = await listing(fixed.id)
    expect(Number(fixedAfter.price)).toBe(20)
    expect(fixedAfter).toMatchObject({ followMasterPrice: true, priceOverride: null, pricingRule: 'FIXED' })
    const fixedRows = await pending(fixed.id)
    expect(fixedRows).toHaveLength(1)
    expect(fixedRows[0].payload).toMatchObject({ price: 20 })
    expect((fixedRows[0].payload as Record<string, unknown>).machinePrice).toBeUndefined()

    // The pin is untouched.
    expect(Number((await listing(pinned.id)).price)).toBe(24)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: pinned.id } })).toBe(0)

    // A second live run: everything is at its price, nothing more is queued.
    await runRepricerTick(prisma as never)
    expect(await pending(ma.id)).toHaveLength(1)
    expect(await pending(fixed.id)).toHaveLength(1)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: { in: ids } } })).toBe(2)
  }))
})

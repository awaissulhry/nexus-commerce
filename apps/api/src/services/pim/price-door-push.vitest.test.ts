/**
 * `/pricing`'s "Push price" (`pushPriceUpdate`) goes through the ONE channel price door's SEND mode (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. The push sent Amazon the snapshot's number DIRECTLY (`amazonSpApiClient.patchListingPrice`, or a
 * merge on the live offer), outside the outbound queue, and wrote IN_SYNC itself; the other channels got a queue row of
 * the push's own, with no hold and no cancel of a waiting row. Now every channel is ONE PENDING PRICE_UPDATE row from
 * the door (`resend`, named reason `pricing-push`) carrying the price the LISTING holds, on the 30 s hold, replacing a
 * waiting row; a paused listing, a draft, a price of 0 and a price outside the floor/ceiling (master currency only) are
 * refused by name with nothing queued. The Amazon client is a trap here: any call fails the file.
 *
 * Real PostgreSQL in-process (PGlite), the pattern of `price-door-follower.vitest.test.ts`. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, amazonCalls: [] as string[] }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// 🔴 The trap: every method of the Amazon client records its name and throws. The push must never reach it.
vi.mock('../../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: new Proxy({}, {
    get: (_target, key) => (key === 'then' ? undefined : (..._args: unknown[]) => {
      state.amazonCalls.push(String(key))
      throw new Error(`Unexpected direct Amazon call: ${String(key)}`)
    }),
  }),
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { pushPriceUpdate } from '../pricing-outbound.service.js'
import { writeChannelPrices } from './channel-price-write.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  const market = (channel: string, code: string, currency: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'en', languages: ['en'] } })
  await market('AMAZON', 'IT', 'EUR')
  await market('EBAY', 'DE', 'EUR')
  await market('EBAY', 'UK', 'GBP')
  for (const channel of ['AMAZON', 'EBAY']) {
    accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `push-${channel}`, isActive: true } })).id
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

interface Seed {
  channel?: 'AMAZON' | 'EBAY'
  marketplace?: string
  /** A pinned listing's own price; `undefined` = following the master. */
  pinned?: number
  price?: number
  rule?: 'FIXED' | 'PERCENT_OF_MASTER'
  adj?: number
  listing?: Record<string, unknown>
  product?: Record<string, unknown>
}
/** A product at master 20 and one live listing (Amazon IT unless told otherwise). */
async function seed(sku: string, s: Seed = {}) {
  const channel = s.channel ?? 'AMAZON'
  const marketplace = s.marketplace ?? 'IT'
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 20, ...s.product } as never })
  const pinned = s.pinned !== undefined
  return prisma.channelListing.create({ data: {
    productId: product.id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${sku}`,
    price: s.price ?? (pinned ? s.pinned : 20), priceOverride: pinned ? s.pinned : null, followMasterPrice: !pinned, masterPrice: 20,
    pricingRule: s.rule ?? 'FIXED', priceAdjustmentPercent: s.adj ?? null,
    ...s.listing,
  } as never })
}
const push = (sku: string, channel = 'AMAZON', marketplace = 'IT') => pushPriceUpdate(prisma as never, { sku, channel, marketplace })
const rows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE' }, orderBy: { createdAt: 'asc' } })
const pending = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' } })
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const inThirtySeconds = (at: Date | null) => {
  const ms = (at?.getTime() ?? 0) - Date.now()
  return ms > 20_000 && ms <= 30_000
}

describe('🔴 Push price is ONE queued row from the price door — never a direct channel call', () => {
  it('Amazon, pinned at 25: queued (not sent), ONE pending row at 25 marked resend, on the 30 s hold; the waiting row is replaced', () => scoped(async () => {
    const l = await seed('TEST-PUSH-PIN', { pinned: 24 })
    await prisma.pricingSnapshot.create({ data: { sku: 'TEST-PUSH-PIN', channel: 'AMAZON', marketplace: 'IT', computedPrice: 23.4, currency: 'EUR', source: 'CHANNEL_OVERRIDE' } })
    // A price change still waiting in its hold: the pin from 24 to 25.
    const waiting = await writeChannelPrices({ targets: [{ listingId: l.id, price: 25, expectedVersion: l.version }], actor: 'person-1', source: 'MANUAL_OVERRIDE' })
    expect(waiting.results[0]).toMatchObject({ outcome: 'applied' })
    const firstRow = waiting.results[0].queueId!
    const before = await listing(l.id)

    const result = await push('TEST-PUSH-PIN')
    // The price the LISTING holds (25), not the stale snapshot number (23.40).
    expect(result).toMatchObject({ ok: true, queued: true, pushedPrice: 25, currency: 'EUR', channel: 'AMAZON', marketplace: 'IT' })
    const live = await pending(l.id)
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(result.queueId)
    expect(live[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 25, resend: true, actor: 'pricing-push', marketplace: 'IT' })
    expect(inThirtySeconds(live[0].holdUntil)).toBe(true)
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: firstRow } })).syncStatus).toBe('CANCELLED')
    // Nothing else about the listing changed: still pinned at 25, one version on, waiting to be sent.
    const after = await listing(l.id)
    expect(after).toMatchObject({ followMasterPrice: false, syncStatus: 'PENDING', version: before.version + 1 })
    expect([Number(after.price), Number(after.priceOverride)]).toEqual([25, 25])
    expect(state.amazonCalls).toEqual([])
  }))

  it('the push leaves an audit trace on the listing: who pushed, and which price', () => scoped(async () => {
    const l = await seed('TEST-PUSH-AUDIT', { pinned: 25 })
    const result = await push('TEST-PUSH-AUDIT')
    expect(result).toMatchObject({ ok: true, queued: true, pushedPrice: 25 })
    const audit = await prisma.channelListingOverride.findMany({ where: { channelListingId: l.id, changedBy: 'pricing-push' } })
    expect(audit.length).toBeGreaterThanOrEqual(1)
    expect(audit.map((a) => a.reason).join(' ')).toContain('Push price (/pricing)')
  }))

  it('a FOLLOWING listing (PERCENT_OF_MASTER +10, master 20) whose stored price is stale at 20: stores 22 and queues 22', () => scoped(async () => {
    const l = await seed('TEST-PUSH-FOLLOW', { rule: 'PERCENT_OF_MASTER', adj: 10, price: 20 })
    const result = await push('TEST-PUSH-FOLLOW')
    expect(result).toMatchObject({ ok: true, queued: true, pushedPrice: 22 })
    const after = await listing(l.id)
    expect(Number(after.price)).toBe(22)
    expect(after).toMatchObject({ followMasterPrice: true, priceOverride: null, pricingRule: 'PERCENT_OF_MASTER' })
    const live = await pending(l.id)
    expect(live).toHaveLength(1)
    expect(live[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 22 })
    // The recomputed price is audited and on the timeline, as the cascade's.
    expect(await prisma.channelListingOverride.count({ where: { channelListingId: l.id, fieldName: 'price', newValue: '22' } })).toBe(1)
    expect(await prisma.priceChangeEvent.count({ where: { productId: l.productId } })).toBe(1)
    expect(state.amazonCalls).toEqual([])
  }))

  it('a paused listing: refused with the push lock\'s sentence; nothing queued, nothing written', () => scoped(async () => {
    const l = await seed('TEST-PUSH-PAUSED', { pinned: 25, listing: { syncPaused: true } })
    const result = await push('TEST-PUSH-PAUSED')
    expect(result).toMatchObject({ ok: false, pushedPrice: null, error: 'Listing sync is paused. Resume sync before sending changes.', refusal: { code: 'PUSH_SYNC_PAUSED' } })
    expect(await rows(l.id)).toEqual([])
    expect((await listing(l.id)).version).toBe(l.version)
    expect(state.amazonCalls).toEqual([])
  }))

  it('a still-draft listing: the door refuses it by name (Publish sends it); nothing queued', () => scoped(async () => {
    const l = await seed('TEST-PUSH-DRAFT', { pinned: 25, listing: { listingStatus: 'DRAFT', isPublished: false, externalListingId: null } })
    const result = await push('TEST-PUSH-DRAFT')
    expect(result).toMatchObject({ ok: false, pushedPrice: null, error: 'TEST-PUSH-DRAFT on AMAZON IT: nothing was sent — this listing is a draft that has not been published; Publish sends it.' })
    expect(await rows(l.id)).toEqual([])
    expect((await listing(l.id)).version).toBe(l.version)
  }))

  it('EUR, pinned at 25 with the product\'s ceiling at 20: refused with the bounds clause; nothing queued', () => scoped(async () => {
    const l = await seed('TEST-PUSH-CEIL', { pinned: 25, product: { maxPrice: 20 } })
    const result = await push('TEST-PUSH-CEIL')
    expect(result).toMatchObject({ ok: false, pushedPrice: null, error: 'TEST-PUSH-CEIL on AMAZON IT: nothing was sent — 25.00 is above its pricing ceiling of 20.00. Change the price, or the floor or ceiling on the product.' })
    expect(await rows(l.id)).toEqual([])
    expect((await listing(l.id)).version).toBe(l.version)
    expect(state.amazonCalls).toEqual([])
  }))

  it('a GBP market pinned at 25 with that EUR ceiling of 20: queued — a GBP price is never compared with EUR bounds', () => scoped(async () => {
    const l = await seed('TEST-PUSH-GBP', { channel: 'EBAY', marketplace: 'UK', pinned: 25, product: { maxPrice: 20 } })
    const result = await push('TEST-PUSH-GBP', 'EBAY', 'UK')
    expect(result).toMatchObject({ ok: true, queued: true, pushedPrice: 25, channel: 'EBAY' })
    const live = await pending(l.id)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ targetChannel: 'EBAY', payload: { price: 25, resend: true, marketplace: 'UK' } })
  }))

  it('a listing holding 0: refused, a price must be above 0; nothing queued', () => scoped(async () => {
    const l = await seed('TEST-PUSH-ZERO', { pinned: 0 })
    const result = await push('TEST-PUSH-ZERO')
    expect(result).toMatchObject({ ok: false, pushedPrice: null, error: 'TEST-PUSH-ZERO on AMAZON IT: nothing was sent — it holds 0.00, and a price must be above 0.' })
    expect(await rows(l.id)).toEqual([])
  }))

  it('no arm of this file reached the Amazon client', () => {
    expect(state.amazonCalls).toEqual([])
  })
})

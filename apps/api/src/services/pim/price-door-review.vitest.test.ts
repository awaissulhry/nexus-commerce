/**
 * The price door after the independent review (2026-10-01): four rules a write must keep.
 *
 *  1. A sale goes out WITH a price (Amazon replaces the offer with what the row carries). A listing that holds no price
 *     of its own got the rule's price from the master — in EUR, also on a GBP market. The master's number is used only
 *     in the master currency; otherwise the sale is refused by name and nothing is written.
 *  2. Push price on a pinned listing whose stored price is not its pinned price (rows from older writers): the pinned
 *     price is sent, and stored in the same compare-and-set write, audited — Nexus shows what was sent.
 *  3. A change computed from the product's master price is not written once that master price has moved: the door reads
 *     the product FOR SHARE inside its transaction and decides again with the new one (a snapshot-only cascade write
 *     does not bump the listing's version, so the compare-and-set alone would not see it). Forced deterministically
 *     here; the multi-connection race is in `price-door-concurrency.vitest.test.ts`.
 *  4. A typed price or a sale on a paused listing or a still-draft is kept in Nexus and not queued — as a follower
 *     price is — and the answer says why.
 *
 * Real PostgreSQL in-process (PGlite), the harness of `price-door-follower.vitest.test.ts`. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, beforeNextTransaction: null as null | (() => Promise<void>) }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  // The client as every module sees it, with one seam: `beforeNextTransaction` runs (once) just before the next
  // transaction opens — how arm 3 puts a committed master price change between the door's read and its write.
  const client = new Proxy(state.db.client, {
    get(target, property) {
      if (property === '$transaction' && state.beforeNextTransaction) {
        const hook = state.beforeNextTransaction
        state.beforeNextTransaction = null
        return async (...args: unknown[]) => { await hook(); return target.$transaction(...args) }
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { default: client, prisma: client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices, type PriceWriteTarget } from './channel-price-write.service.js'
import { MasterPriceService } from '../master-price.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  // The sale-window columns are raw SQL, not in schema.prisma (as `price-door-sale-removal` adds them).
  await state.db.db.query(`ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE, ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE`)
  const market = (channel: string, code: string, currency: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'en', languages: ['en'] } })
  await market('AMAZON', 'IT', 'EUR')
  await market('AMAZON', 'UK', 'GBP')
  await market('EBAY', 'DE', 'EUR')
  for (const channel of ['AMAZON', 'EBAY']) {
    accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `review-${channel}`, isActive: true } })).id
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

/** A product at master 10 and one live listing; following at 10 (FIXED) unless told otherwise. */
async function seed(id: string, s: { channel?: 'AMAZON' | 'EBAY'; marketplace?: string; listing?: Record<string, unknown> } = {}) {
  const channel = s.channel ?? 'EBAY'
  const marketplace = s.marketplace ?? 'DE'
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10 } as never })
  return prisma.channelListing.create({ data: {
    productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`,
    price: 10, masterPrice: 10, followMasterPrice: true, pricingRule: 'FIXED',
    ...s.listing,
  } as never })
}
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const rows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE' }, orderBy: { createdAt: 'asc' } })
const write = (target: PriceWriteTarget, actor = 'person-1') => writeChannelPrices({ targets: [target], actor, source: 'MANUAL_OVERRIDE', reason: 'review' })
const sale = { value: 8, start: '2026-11-01', end: '2026-11-30' }

describe('1 · a sale goes out with a price — never the master\'s EUR number as another market\'s price', () => {
  it('🔴 a GBP listing that holds no price of its own: the sale is refused by name, nothing written, nothing queued', () => scoped(async () => {
    const l = await seed('rv-sale-gbp', { channel: 'AMAZON', marketplace: 'UK', listing: { price: null } })
    const r = await write({ listingId: l.id, sale, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'refused' })
    expect(r.results[0].reason).toBe('RV-SALE-GBP on AMAZON UK: the sale was not set — a sale is sent with the listing\'s price, and this listing holds none in GBP (the master price is in EUR; Nexus does not convert it). Set the listing\'s own price first. Nothing was changed.')
    expect(await listing(l.id)).toMatchObject({ salePrice: null, version: l.version })
    expect(await rows(l.id)).toEqual([])
  }))

  it('an EUR listing that holds no price of its own still sends its rule\'s price (the master currency) beside the sale', () => scoped(async () => {
    const l = await seed('rv-sale-eur', { channel: 'AMAZON', marketplace: 'IT', listing: { price: null } })
    const r = await write({ listingId: l.id, sale, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied' })
    const [row] = await rows(l.id)
    expect(row.payload).toMatchObject({ price: 10, salePrice: 8, salePriceStart: sale.start, salePriceEnd: sale.end })
  }))

  it('a GBP listing WITH its own price sends that price beside the sale, as before', () => scoped(async () => {
    const l = await seed('rv-sale-gbp-own', { channel: 'AMAZON', marketplace: 'UK', listing: { price: 17 } })
    const r = await write({ listingId: l.id, sale, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied' })
    expect((await rows(l.id))[0].payload).toMatchObject({ price: 17, salePrice: 8 })
  }))
})

describe('2 · Push price on a pinned listing stores the pinned price it sends', () => {
  it('🔴 override 50, price 45 (an older writer): stores 50 and sends 50, audited, on the timeline', () => scoped(async () => {
    const l = await seed('rv-push-pin', { listing: { followMasterPrice: false, priceOverride: 50, price: 45 } })
    const r = await write({ listingId: l.id, resend: true, unguardedReason: 'pricing-push' }, 'pricing-push')
    expect(r.results[0]).toMatchObject({ outcome: 'applied', sentPrice: 50 })
    const stored = await listing(l.id)
    expect([Number(stored.price), Number(stored.priceOverride), stored.followMasterPrice]).toEqual([50, 50, false])
    expect((await rows(l.id)).map((row) => (row.payload as { price?: number }).price)).toEqual([50])
    const audit = await prisma.channelListingOverride.findMany({ where: { channelListingId: l.id, fieldName: 'price' } })
    expect(audit.map((a) => [a.previousValue, a.newValue, a.changedBy])).toEqual([['45', '50', 'pricing-push']])
    const timeline = await prisma.priceChangeEvent.findMany({ where: { productId: l.productId } })
    expect(timeline.map((e) => [Number(e.oldPrice), Number(e.newPrice)])).toEqual([[45, 50]])
  }))

  it('a pinned listing whose stored price IS its pinned price: sent, stored price unchanged, no timeline entry', () => scoped(async () => {
    const l = await seed('rv-push-same', { listing: { followMasterPrice: false, priceOverride: 30, price: 30 } })
    const r = await write({ listingId: l.id, resend: true, unguardedReason: 'pricing-push' }, 'pricing-push')
    expect(r.results[0]).toMatchObject({ outcome: 'applied', sentPrice: 30 })
    expect(await prisma.priceChangeEvent.count({ where: { productId: l.productId } })).toBe(0)
  }))
})

describe('3 · a change decided from a master price that moved is decided again', () => {
  it('🔴 hand-back of a pinned listing while the master moves 10 → 12 (a snapshot-only cascade write): the listing follows at 12, and 12 is queued', () => scoped(async () => {
    const l = await seed('rv-race-handback', { listing: { followMasterPrice: false, priceOverride: 25, price: 25 } })
    // The master price changes in the gap between the door's read and its write: just before the door opens its
    // transaction, MasterPriceService commits 10 → 12 (its cascade only snapshots a pinned listing: no version bump).
    let interleaved = false
    state.beforeNextTransaction = async () => {
      interleaved = true
      await new MasterPriceService(prisma as never).update(l.productId, 12, { actor: 'other-person' })
    }
    const r = await write({ listingId: l.id, follow: true, unguardedReason: 'channel-follows' })
    state.beforeNextTransaction = null
    expect(interleaved).toBe(true)
    expect(r.results[0]).toMatchObject({ outcome: 'applied', retried: true })
    const stored = await listing(l.id)
    expect([stored.followMasterPrice, Number(stored.price), Number(stored.masterPrice)]).toEqual([true, 12, 12])
    const pending = (await rows(l.id)).filter((row) => row.syncStatus === 'PENDING')
    expect(pending.map((row) => (row.payload as { price?: number }).price)).toEqual([12])
  }))
})

describe('4 · a typed price or a sale on a paused listing or a still-draft is kept in Nexus, not queued, and says why', () => {
  it('🔴 a pin on a paused listing: stored, nothing queued, sync state untouched, the sentence says so', () => scoped(async () => {
    const l = await seed('rv-hold-paused', { listing: { syncPaused: true, followMasterPrice: false, priceOverride: 20, price: 20 } })
    const r = await write({ listingId: l.id, price: 22, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null, notSent: 'The price 22.00 is saved in Nexus. Nothing was sent: this listing\'s sync is paused. It is sent when the listing resumes.' })
    const stored = await listing(l.id)
    expect([Number(stored.price), Number(stored.priceOverride), stored.syncStatus]).toEqual([22, 22, l.syncStatus])
    // Nothing queued; round 5: ONE held row (never dispatched) that the resume sends once (`price-door-held`).
    expect((await rows(l.id)).map((row) => [row.syncStatus, row.errorCode, (row.payload as { price?: number }).price])).toEqual([['SKIPPED', 'PUSH_SYNC_PAUSED', 22]])
  }))

  it('🔴 a pin and a sale on a still-draft (never published): stored, nothing queued; Publish sends it', () => scoped(async () => {
    const l = await seed('rv-hold-draft', { channel: 'AMAZON', marketplace: 'IT', listing: { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, followMasterPrice: false, priceOverride: 20, price: 20 } })
    const r = await write({ listingId: l.id, price: 21, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(r.results[0].notSent).toMatch(/^The price 21\.00 is saved in Nexus\. Nothing was sent: this listing is a draft that has not been published; Publish sends it\.$/)
    const s = await write({ listingId: l.id, sale, expectedVersion: l.version + 1 })
    expect(s.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(s.results[0].notSent).toMatch(/^The sale 8\.00 is saved in Nexus\./)
    expect(Number((await listing(l.id)).salePrice)).toBe(8)
    // Nothing queued. Round 5: Publish carries the pin, so the pin is not held; Amazon's publication sends no sale, so
    // the sale is ONE held row (never dispatched) that the go-live sends once (`price-door-held`).
    expect((await rows(l.id)).map((row) => [row.syncStatus, row.errorCode, (row.payload as { salePrice?: number }).salePrice])).toEqual([['SKIPPED', 'PRICE_HELD_DRAFT', 8]])
  }))

  it('a pin on a live listing is queued, as before', () => scoped(async () => {
    const l = await seed('rv-hold-live', { listing: { followMasterPrice: false, priceOverride: 20, price: 20 } })
    const r = await write({ listingId: l.id, price: 22, expectedVersion: l.version })
    expect(r.results[0].notSent).toBeUndefined()
    expect((await rows(l.id)).map((row) => (row.payload as { price?: number }).price)).toEqual([22])
  }))
})

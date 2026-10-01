/**
 * The promotion scheduler sets and ends a promotion's sale through the ONE channel price door (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. The scheduler wrote `ChannelListing.salePrice` alone: no sale dates, no audit, and nothing
 * queued, so no promotion ever reached a channel; ending one (the tick, or `DELETE /pricing/promotions/:id`) was a raw
 * write of `salePrice: null`, so the channels kept the sale. Now each sale is the door's sale (named reason
 * `promotion`): the event's window as the sale's dates, an audit row by `promotion:<event>`, ONE PENDING PRICE_UPDATE
 * on the hold; ending it is the door's sale removal (`saleRemoved` on Amazon). eBay and Etsy listings have no sale
 * (the Studio matrix's own sentences) and are skipped. A sale an operator changed after the promotion is never cleared
 * by the promotion's end.
 *
 * Real PostgreSQL in-process (PGlite), the pattern of `pim/price-door-follower.vitest.test.ts`. Each arm scopes its
 * promotion to its own product type, so the arms do not reach each other's listings. Every id is invented.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// The engine's snapshot refresh after a tick is not what this file is about.
vi.mock('./pricing-snapshot.service.js', () => ({ refreshSnapshotsForSkus: vi.fn(async () => ({ rowsRefreshed: 0 })), refreshAllSnapshots: vi.fn(async () => ({ rowsRefreshed: 0 })) }))
// The scheduler's own timeline entry (PH.1): only for a listing the door applied. The door's helpers stay real.
vi.mock('./price-history.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./price-history.service.js')>()),
  recordPriceChange: vi.fn(async () => undefined),
}))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { recordPriceChange } from './price-history.service.js'
import { endPromotionSales, runPromotionScheduler } from './promotion-scheduler.service.js'
import { writeChannelPrices } from './pim/channel-price-write.service.js'
import { resetSaleWindowColumnCache } from './pim/sale-window.js'
import { logger } from '../utils/logger.js'

const A = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(A, work)
const accounts: Record<string, string> = {}
let app: FastifyInstance

const DAY = 86_400_000
/** The UTC midnight nearest to now: inside the scheduler's "started in the last 12 h / next 12 h" window. */
const enteringStart = () => new Date(Math.round(Date.now() / DAY) * DAY)
const iso = (d: Date) => d.toISOString().slice(0, 10)

beforeAll(async () => {
  // The two MX.1 window columns are raw SQL, not in schema.prisma; the deployed databases carry them
  // (migration 20260913_mx1_sale_price_window), this disposable one gets the same two statements.
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await scoped(async () => {
    const market = (channel: string, code: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    await market('AMAZON', 'IT')
    await market('EBAY', 'IT')
    await market('ETSY', 'GLOBAL')
    for (const channel of ['AMAZON', 'EBAY', 'ETSY']) {
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `promo-${channel}`, externalAccountId: `test-promo-${channel}`, isActive: true } })).id
    }
  })
  const { default: routes } = await import('../routes/pricing.routes.js')
  app = Fastify()
  // Every request runs inside the business, as the global workspace hook does in production.
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(A, done) })
  await app.register(routes)
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

/** A product of its own product type (the arm's promotion scope) with a live, pinned listing at 20 on each channel asked. */
async function seed(id: string, channels: Array<'AMAZON' | 'EBAY' | 'ETSY'>) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 20, productType: `TYPE_${id.toUpperCase()}` } as never })
  const listings: Record<string, { id: string; productId: string; version: number }> = {}
  for (const channel of channels) {
    const marketplace = channel === 'ETSY' ? 'GLOBAL' : 'IT'
    listings[channel] = await prisma.channelListing.create({ data: {
      productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}-${channel}`,
      price: 20, priceOverride: 20, followMasterPrice: false, masterPrice: 20,
    } as never })
  }
  return listings
}
/** An event with one price action scoped to the product's own type. */
async function promotion(id: string, window: { start: Date; end: Date }, action: { action: 'FIXED_PRICE' | 'PERCENT_OFF'; value: number; channel?: string | null }) {
  const event = await prisma.retailEvent.create({ data: { name: `Promo ${id}`, startDate: window.start, endDate: window.end, source: 'CUSTOM' } })
  await prisma.retailEventPriceAction.create({ data: { eventId: event.id, channel: action.channel === undefined ? 'AMAZON' : action.channel, productType: `TYPE_${id.toUpperCase()}`, action: action.action, value: action.value } })
  return event
}
const listingRow = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const rows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE' }, orderBy: { createdAt: 'asc' } })
const pending = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' } })
const saleAudits = (channelListingId: string) => prisma.channelListingOverride.findMany({ where: { channelListingId, fieldName: 'salePrice' }, orderBy: { createdAt: 'asc' } })
const windowOf = async (id: string) => {
  const [row] = await prisma.$queryRawUnsafe<Array<{ start: string | null; end: string | null }>>(`SELECT to_char("salePriceStart", 'YYYY-MM-DD') AS start, to_char("salePriceEnd", 'YYYY-MM-DD') AS end FROM "ChannelListing" WHERE id = $1`, id)
  return row
}
const inThirtySeconds = (at: Date | null) => {
  const ms = (at?.getTime() ?? 0) - Date.now()
  return ms > 20_000 && ms <= 30_000
}
/** The scheduler's timeline entries (PH.1) for one product: [channel, source, newPrice]. Other arms' events tick too. */
const timeline = (productId: string) => vi.mocked(recordPriceChange).mock.calls
  .map((c) => c[1] as { productId: string; channel: string; source: string; newPrice: unknown })
  .filter((e) => e.productId === productId)
  .map((e) => [e.channel, e.source, e.newPrice])
/** A promotion's sale as the door sets it, for an event that has already ended (its dates in the past). */
async function promotionSale(listingId: string, eventId: string, value: number, start: string, end: string) {
  const r = await writeChannelPrices({ targets: [{ listingId, sale: { value, start, end }, unguardedReason: 'promotion' }], actor: `promotion:${eventId}`, source: 'PROMO_START' })
  expect(r.results[0].outcome).toBe('applied')
}

describe('a promotion starts: its sale goes through the price door', () => {
  it('🔴 FIXED_PRICE 15 on Amazon: salePrice 15 with the event\'s window, ONE pending PRICE_UPDATE carrying it, an audit row by promotion:<event>; the next tick changes nothing', () => scoped(async () => {
    const { AMAZON: amazon } = await seed('promo-enter', ['AMAZON'])
    const start = enteringStart()
    const end = new Date(start.getTime() + 2 * DAY)
    const event = await promotion('promo-enter', { start, end }, { action: 'FIXED_PRICE', value: 15 })
    vi.mocked(recordPriceChange).mockClear()

    await runPromotionScheduler(prisma as never)

    const stored = await listingRow(amazon.id)
    expect(Number(stored.salePrice)).toBe(15)
    // The pinned price is untouched: a sale is not a price change.
    expect(Number(stored.price)).toBe(20)
    expect(stored.priceOverride == null ? null : Number(stored.priceOverride)).toBe(20)
    expect(await windowOf(amazon.id)).toEqual({ start: iso(start), end: iso(end) })
    const queued = await pending(amazon.id)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ targetChannel: 'AMAZON', syncType: 'PRICE_UPDATE', externalListingId: 'ITEM-promo-enter-AMAZON' })
    expect(queued[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', actor: `promotion:${event.id}`, price: 20, salePrice: 15, salePriceStart: iso(start), salePriceEnd: iso(end) })
    expect('saleRemoved' in (queued[0].payload as object)).toBe(false)
    expect(inThirtySeconds(queued[0].holdUntil)).toBe(true)
    const audits = await saleAudits(amazon.id)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ changedBy: `promotion:${event.id}`, previousValue: null, newValue: `15 ${iso(start)}→${iso(end)}` })
    // The scheduler's timeline entry, for the one listing the door applied.
    expect(timeline(amazon.productId)).toEqual([['AMAZON', 'PROMO_START', '15.00']])

    // The same promotion again: the door's no-op — no second row, no second audit, no second timeline entry.
    vi.mocked(recordPriceChange).mockClear()
    await runPromotionScheduler(prisma as never)
    expect(await rows(amazon.id)).toHaveLength(1)
    expect(await saleAudits(amazon.id)).toHaveLength(1)
    expect(timeline(amazon.productId)).toEqual([])
  }))

  it('🔴 a ONE-DAY event (startDate == endDate, inclusive) stays on sale all day and ends after it — it was ended on the tick that started it', () => scoped(async () => {
    const { AMAZON: amazon } = await seed('promo-one-day', ['AMAZON'])
    const today = new Date(Math.floor(Date.now() / DAY) * DAY)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(today.getTime() + 6 * 3_600_000)) // 06:00 UTC on the event's day
      const event = await promotion('promo-one-day', { start: today, end: today }, { action: 'FIXED_PRICE', value: 15 })
      await runPromotionScheduler(prisma as never)
      expect(Number((await listingRow(amazon.id)).salePrice)).toBe(15)
      expect((await pending(amazon.id)).map((r) => (r.payload as { salePrice?: unknown }).salePrice)).toEqual([15])
      // A later tick the same day: still on sale, nothing new.
      vi.setSystemTime(new Date(today.getTime() + 20 * 3_600_000))
      await runPromotionScheduler(prisma as never)
      expect(Number((await listingRow(amazon.id)).salePrice)).toBe(15)
      expect(await rows(amazon.id)).toHaveLength(1)
      // The day after: the sale ends.
      vi.setSystemTime(new Date(today.getTime() + 25 * 3_600_000))
      await runPromotionScheduler(prisma as never)
      expect((await listingRow(amazon.id)).salePrice).toBeNull()
      expect((await pending(amazon.id))[0].payload).toMatchObject({ actor: `promotion-clear:${event.id}`, saleRemoved: true })
    } finally {
      vi.useRealTimers()
    }
  }))

  it('🔴 a promotion on every channel: eBay and Etsy have no listing sale and are skipped — no salePrice, no row, no audit — while Amazon is applied', () => scoped(async () => {
    const listings = await seed('promo-all', ['AMAZON', 'EBAY', 'ETSY'])
    const start = enteringStart()
    await promotion('promo-all', { start, end: new Date(start.getTime() + 2 * DAY) }, { action: 'FIXED_PRICE', value: 12.5, channel: null })
    vi.mocked(recordPriceChange).mockClear()

    await runPromotionScheduler(prisma as never)

    expect(Number((await listingRow(listings.AMAZON.id)).salePrice)).toBe(12.5)
    expect(await pending(listings.AMAZON.id)).toHaveLength(1)
    for (const channel of ['EBAY', 'ETSY'] as const) {
      const stored = await listingRow(listings[channel].id)
      expect(stored.salePrice, channel).toBeNull()
      expect(stored.version, channel).toBe(listings[channel].version)
      expect(await rows(listings[channel].id), channel).toEqual([])
      expect(await saleAudits(listings[channel].id), channel).toEqual([])
    }
    expect(timeline(listings.AMAZON.productId).map(([channel]) => channel)).toEqual(['AMAZON'])
  }))

  it('PERCENT_OFF prices the sale from the engine\'s price, in the one cents helper (10.10 − 15 % = 8.585 → 8.59)', () => scoped(async () => {
    const { AMAZON: amazon } = await seed('promo-percent', ['AMAZON'])
    await prisma.channelListing.update({ where: { id: amazon.id }, data: { price: 10.1, priceOverride: 10.1 } })
    const start = enteringStart()
    await promotion('promo-percent', { start, end: new Date(start.getTime() + 2 * DAY) }, { action: 'PERCENT_OFF', value: 15 })

    await runPromotionScheduler(prisma as never)

    expect(Number((await listingRow(amazon.id)).salePrice)).toBe(8.59)
    const queued = await pending(amazon.id)
    expect(queued).toHaveLength(1)
    expect(queued[0].payload).toMatchObject({ price: 10.1, salePrice: 8.59 })

    // 🔴 The next tick of the same running promotion changes nothing: the sale is the promotion's price off the
    // listing's OWN price, never a discount on the sale it already set (8.59 − 15 % = 7.30 on the second tick, and
    // so on every tick while the event is in its start window, each one queued to the channel).
    await runPromotionScheduler(prisma as never)
    expect(Number((await listingRow(amazon.id)).salePrice)).toBe(8.59)
    expect(await rows(amazon.id)).toHaveLength(1)
  }))
})

// ── 2026-10-01 review: a sale is a price in ONE currency, held to the product's own bounds, sent or not set ───────
describe('🔴 a promotion\'s sale: one currency, the product\'s own floor/ceiling, and only where a sale is sent', () => {
  type Market = { channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'; marketplace: string }
  beforeAll(() => scoped(async () => {
    const market = (channel: string, code: string, currency: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'en', languages: ['en'] } })
    await market('AMAZON', 'UK', 'GBP'); await market('AMAZON', 'SE', 'SEK'); await market('AMAZON', 'PL', 'PLN'); await market('AMAZON', 'DE', 'EUR')
    await market('EBAY', 'UK', 'GBP'); await market('SHOPIFY', 'GLOBAL', 'EUR'); await market('WOOCOMMERCE', 'GLOBAL', 'EUR')
    for (const channel of ['SHOPIFY', 'WOOCOMMERCE']) {
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `promo-${channel}`, externalAccountId: `test-promo-${channel}`, isActive: true } as never })).id
    }
  }), 60_000)

  /** A product of its own type (floor/ceiling as given) with a live listing pinned at 20 on each market asked. */
  async function seedMarkets(id: string, markets: Market[], product: Record<string, unknown> = {}) {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 20, productType: `TYPE_${id.toUpperCase()}`, ...product } as never })
    const out: Record<string, { id: string }> = {}
    for (const m of markets) {
      out[`${m.channel}:${m.marketplace}`] = await prisma.channelListing.create({ data: {
        productId: id, channel: m.channel, channelConnectionId: accounts[m.channel], channelMarket: `${m.channel}_${m.marketplace}`, marketplace: m.marketplace, region: 'EU',
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}-${m.channel}-${m.marketplace}`,
        price: 20, priceOverride: 20, followMasterPrice: false, masterPrice: 20,
      } as never })
    }
    return out
  }
  async function promotionAt(id: string, action: { action: 'FIXED_PRICE' | 'PERCENT_OFF'; value: number; channel: string | null; marketplace?: string }) {
    const start = enteringStart()
    const event = await prisma.retailEvent.create({ data: { name: `Promo ${id}`, startDate: start, endDate: new Date(start.getTime() + 2 * DAY), source: 'CUSTOM' } })
    await prisma.retailEventPriceAction.create({ data: { eventId: event.id, channel: action.channel, marketplace: action.marketplace ?? null, productType: `TYPE_${id.toUpperCase()}`, action: action.action, value: action.value } as never })
    return event
  }
  /** One tick: its result, and the listings it skipped by name ([listingId, reason]). */
  async function tick() {
    const info = vi.spyOn(logger, 'info')
    try {
      const result = await runPromotionScheduler(prisma as never)
      const skipped = info.mock.calls.filter((c) => c[0] === 'promotion skipped on a listing').map((c) => c[1] as { listingId: string; reason: string })
      return { result, skipped }
    } finally {
      info.mockRestore()
    }
  }
  const untouched = async (listingId: string) => {
    expect((await listingRow(listingId)).salePrice).toBeNull()
    expect(await rows(listingId)).toEqual([])
    expect(await saleAudits(listingId)).toEqual([])
  }

  it('🔴 FIXED_PRICE 15 with no market named is EUR (the master currency): set on Amazon IT and DE; Amazon UK (GBP), SE (SEK) and PL (PLN) are skipped by name and counted, nothing written', () => scoped(async () => {
    const l = await seedMarkets('promo-fx-none', [
      { channel: 'AMAZON', marketplace: 'IT' }, { channel: 'AMAZON', marketplace: 'DE' },
      { channel: 'AMAZON', marketplace: 'UK' }, { channel: 'AMAZON', marketplace: 'SE' }, { channel: 'AMAZON', marketplace: 'PL' },
    ])
    await promotionAt('promo-fx-none', { action: 'FIXED_PRICE', value: 15, channel: 'AMAZON' })
    const { result, skipped } = await tick()
    for (const key of ['AMAZON:IT', 'AMAZON:DE']) {
      expect(Number((await listingRow(l[key].id)).salePrice), key).toBe(15)
      expect((await pending(l[key].id)).map((r) => (r.payload as { salePrice?: number }).salePrice), key).toEqual([15])
    }
    for (const [key, currency] of [['AMAZON:UK', 'GBP'], ['AMAZON:SE', 'SEK'], ['AMAZON:PL', 'PLN']] as const) {
      await untouched(l[key].id)
      expect(skipped.find((x) => x.listingId === l[key].id)?.reason, key).toBe(`The fixed price EUR 15.00 is not set on a market that sells in ${currency}.`)
    }
    // Counted: every skip of this tick is a named log line, and the result counts exactly those.
    expect(result.listingsSkipped).toBe(skipped.length)
    expect(skipped.length).toBeGreaterThanOrEqual(3)
  }))

  it('🔴 FIXED_PRICE 15 for market UK is GBP: the Amazon UK listing gets £15 — never compared with the product\'s EUR ceiling of 10; eBay UK has no listing sale and is skipped', () => scoped(async () => {
    const l = await seedMarkets('promo-fx-uk', [{ channel: 'AMAZON', marketplace: 'UK' }, { channel: 'EBAY', marketplace: 'UK' }, { channel: 'AMAZON', marketplace: 'IT' }], { maxPrice: 10 })
    await promotionAt('promo-fx-uk', { action: 'FIXED_PRICE', value: 15, channel: null, marketplace: 'UK' })
    const { skipped } = await tick()
    expect(Number((await listingRow(l['AMAZON:UK'].id)).salePrice)).toBe(15)
    expect(await pending(l['AMAZON:UK'].id)).toHaveLength(1)
    await untouched(l['EBAY:UK'].id)
    expect(skipped.find((x) => x.listingId === l['EBAY:UK'].id)?.reason).toBeTruthy()
    // The Italian listing is not in this promotion's scope (market UK): not touched, not skipped.
    await untouched(l['AMAZON:IT'].id)
    expect(skipped.some((x) => x.listingId === l['AMAZON:IT'].id)).toBe(false)
  }))

  it('🔴 a sale outside the product\'s own EUR floor/ceiling is skipped with the shared verdict, nothing written', () => scoped(async () => {
    const l = await seedMarkets('promo-fx-ceiling', [{ channel: 'AMAZON', marketplace: 'IT' }], { maxPrice: 12 })
    const floor = await seedMarkets('promo-fx-floor', [{ channel: 'AMAZON', marketplace: 'IT' }], { minPrice: 18 })
    await promotionAt('promo-fx-ceiling', { action: 'FIXED_PRICE', value: 15, channel: 'AMAZON' })
    await promotionAt('promo-fx-floor', { action: 'PERCENT_OFF', value: 25, channel: 'AMAZON' })
    const { skipped } = await tick()
    await untouched(l['AMAZON:IT'].id)
    expect(skipped.find((x) => x.listingId === l['AMAZON:IT'].id)?.reason).toBe('Not changed: 15.00 is above its pricing ceiling of 12.00.')
    // 20 − 25 % = 15.00, below the floor of 18.
    await untouched(floor['AMAZON:IT'].id)
    expect(skipped.find((x) => x.listingId === floor['AMAZON:IT'].id)?.reason).toBe('Not changed: 15.00 is below its pricing floor of 18.00.')
  }))

  it('🔴 a sale of 0 is skipped — PERCENT_OFF 100 in the master currency, and a FIXED 0 in another currency (no bounds there, the zero rule still)', () => scoped(async () => {
    const pct = await seedMarkets('promo-pct-zero', [{ channel: 'AMAZON', marketplace: 'IT' }])
    const gbp = await seedMarkets('promo-gbp-zero', [{ channel: 'AMAZON', marketplace: 'UK' }])
    await promotionAt('promo-pct-zero', { action: 'PERCENT_OFF', value: 100, channel: 'AMAZON' })
    await promotionAt('promo-gbp-zero', { action: 'FIXED_PRICE', value: 0, channel: 'AMAZON', marketplace: 'UK' })
    const { skipped } = await tick()
    for (const id of [pct['AMAZON:IT'].id, gbp['AMAZON:UK'].id]) {
      await untouched(id)
      expect(skipped.find((x) => x.listingId === id)?.reason, id).toBe('Not changed: the new price would be 0.00, and a price must be above 0.')
    }
  }))

  it('🔴 Shopify and WooCommerce send no sale price: their listings are skipped by name, no row, and not counted as updated', () => scoped(async () => {
    const l = await seedMarkets('promo-shopify', [{ channel: 'SHOPIFY', marketplace: 'GLOBAL' }, { channel: 'WOOCOMMERCE', marketplace: 'GLOBAL' }, { channel: 'AMAZON', marketplace: 'IT' }])
    await promotionAt('promo-shopify', { action: 'FIXED_PRICE', value: 15, channel: null })
    const before = vi.mocked(recordPriceChange).mock.calls.length
    const { result, skipped } = await tick()
    await untouched(l['SHOPIFY:GLOBAL'].id)
    await untouched(l['WOOCOMMERCE:GLOBAL'].id)
    expect(skipped.find((x) => x.listingId === l['SHOPIFY:GLOBAL'].id)?.reason).toBe("Shopify's price sender does not send a sale price, so a promotion is not set on Shopify listings.")
    expect(skipped.find((x) => x.listingId === l['WOOCOMMERCE:GLOBAL'].id)?.reason).toBe("WooCommerce's price sender does not send a sale price, so a promotion is not set on WooCommerce listings.")
    // Only the Amazon listing was updated in this tick (the other arms' promotions were entered already).
    expect(Number((await listingRow(l['AMAZON:IT'].id)).salePrice)).toBe(15)
    expect(result.listingsUpdated).toBe(1)
    expect(vi.mocked(recordPriceChange).mock.calls.length - before).toBe(1)
  }))

  // ── Round 5: a skip is said ONCE per listing per event ─────────────────────────────────────────────────────────────
  describe('🔴 a promotion\'s skip is logged once per listing per event — not on every tick, not per action', () => {
    /** Every log line of `message` for these listings, over one tick: [listingId, reason]. */
    async function linesOf(message: string, level: 'info' | 'warn', ids: string[], run: () => Promise<unknown>) {
      const spy = vi.spyOn(logger, level)
      try {
        const result = await run()
        const lines = spy.mock.calls.filter((c) => c[0] === message).map((c) => c[1] as { listingId: string; reason: string }).filter((l) => ids.includes(l.listingId))
        return { result, lines }
      } finally {
        spy.mockRestore()
      }
    }
    const skipAudits = (listingId: string) => prisma.auditLog.findMany({ where: { entityType: 'ChannelListing', entityId: listingId, action: 'promotion-skipped' } })
    const seedMarket = async (id: string, channel: string, marketplace: string, product: Record<string, unknown> = {}, listing: Record<string, unknown> = {}) => {
      await prisma.product.upsert({ where: { id }, create: { id, sku: id.toUpperCase(), name: id, basePrice: 20, productType: `TYPE_${id.toUpperCase()}`, ...product } as never, update: {} })
      return prisma.channelListing.create({ data: {
        productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}-${channel}-${marketplace}`,
        price: 20, priceOverride: 20, followMasterPrice: false, masterPrice: 20, ...listing,
      } as never })
    }

    it('🔴 Shopify, another currency and a ceiling: each said once on the first tick; the next ticks and a second action of the event say nothing; a second event says it once more', () => scoped(async () => {
      const id = 'promo-skip-once'
      const shopify = await seedMarket(id, 'SHOPIFY', 'GLOBAL', { maxPrice: 12 })
      const uk = await seedMarket(id, 'AMAZON', 'UK')
      const it = await seedMarket(id, 'AMAZON', 'IT')
      const ids = [shopify.id, uk.id, it.id]
      // ONE event, TWO actions that both reach the Amazon listings (every channel, and Amazon).
      const start = enteringStart()
      const event = await prisma.retailEvent.create({ data: { name: `Promo ${id}`, startDate: start, endDate: new Date(start.getTime() + 2 * DAY), source: 'CUSTOM' } })
      for (const channel of [null, 'AMAZON']) {
        await prisma.retailEventPriceAction.create({ data: { eventId: event.id, channel, productType: `TYPE_${id.toUpperCase()}`, action: 'FIXED_PRICE', value: 15 } as never })
      }

      const first = await linesOf('promotion skipped on a listing', 'info', ids, () => runPromotionScheduler(prisma as never))
      expect(first.lines.map((l) => l.listingId).sort()).toEqual([...ids].sort())
      expect(first.lines.find((l) => l.listingId === shopify.id)?.reason).toBe("Shopify's price sender does not send a sale price, so a promotion is not set on Shopify listings.")
      expect(first.lines.find((l) => l.listingId === uk.id)?.reason).toBe('The fixed price EUR 15.00 is not set on a market that sells in GBP.')
      expect(first.lines.find((l) => l.listingId === it.id)?.reason).toBe('Not changed: 15.00 is above its pricing ceiling of 12.00.')
      // Counted as said: the tick's count is its lines.
      expect((first.result as { listingsSkipped: number }).listingsSkipped).toBeGreaterThanOrEqual(3)
      // Recorded once on each listing, for this event, with its reason.
      for (const l of ids) {
        const audits = await skipAudits(l)
        expect(audits, l).toHaveLength(1)
        expect(audits[0].metadata).toMatchObject({ eventId: event.id, phase: 'start' })
      }

      // The event is still in its start window: the next ticks judge the listings again, and say nothing again.
      for (let n = 0; n < 2; n++) {
        const again = await linesOf('promotion skipped on a listing', 'info', ids, () => runPromotionScheduler(prisma as never))
        expect(again.lines, `tick ${n + 2}`).toEqual([])
      }
      for (const l of ids) expect(await skipAudits(l), l).toHaveLength(1)
      for (const l of ids) {
        expect((await listingRow(l)).salePrice, l).toBeNull()
        expect(await rows(l), l).toEqual([])
      }

      // Judged on every tick still: the ceiling raised, the Italian listing gets the sale on the next tick.
      await prisma.product.update({ where: { id }, data: { maxPrice: 30 } })
      await runPromotionScheduler(prisma as never)
      expect(Number((await listingRow(it.id)).salePrice)).toBe(15)

      // Another event over the same Shopify listing is another skip: said once.
      const other = await prisma.retailEvent.create({ data: { name: `Promo ${id} 2`, startDate: start, endDate: new Date(start.getTime() + 2 * DAY), source: 'CUSTOM' } })
      await prisma.retailEventPriceAction.create({ data: { eventId: other.id, channel: 'SHOPIFY', productType: `TYPE_${id.toUpperCase()}`, action: 'FIXED_PRICE', value: 14 } as never })
      const third = await linesOf('promotion skipped on a listing', 'info', [shopify.id], () => runPromotionScheduler(prisma as never))
      expect(third.lines).toHaveLength(1)
      const fourth = await linesOf('promotion skipped on a listing', 'info', [shopify.id], () => runPromotionScheduler(prisma as never))
      expect(fourth.lines).toEqual([])
      expect((await skipAudits(shopify.id)).map((a) => (a.metadata as { eventId: string }).eventId).sort()).toEqual([event.id, other.id].sort())
    }))

    it('🔴 a promotion sale the door will not end (a GBP follower that holds no price of its own) is said once, not on every tick after the event', () => scoped(async () => {
      const id = 'promo-skip-end'
      const uk = await seedMarket(id, 'AMAZON', 'UK', {}, { price: null, priceOverride: null, followMasterPrice: true, salePrice: 15 })
      const start = new Date(enteringStart().getTime() - 6 * DAY)
      const end = new Date(enteringStart().getTime() - 2 * DAY)
      const event = await promotion(id, { start, end }, { action: 'FIXED_PRICE', value: 15 })
      // The promotion's sale, as an older writer left it (the door refuses to set a sale beside no price).
      await prisma.$executeRawUnsafe(`UPDATE "ChannelListing" SET "salePriceStart" = $1::date, "salePriceEnd" = $2::date WHERE id = $3`, iso(start), iso(end), uk.id)
      await prisma.channelListingOverride.create({ data: { channelListingId: uk.id, fieldName: 'salePrice', previousValue: null, newValue: `15 ${iso(start)}→${iso(end)}`, changedBy: `promotion:${event.id}` } })

      const first = await linesOf('promotion sale not ended on a listing', 'warn', [uk.id], () => runPromotionScheduler(prisma as never))
      expect(first.lines).toHaveLength(1)
      expect(first.lines[0].reason).toContain('this listing holds none')
      for (let n = 0; n < 2; n++) {
        const again = await linesOf('promotion sale not ended on a listing', 'warn', [uk.id], () => runPromotionScheduler(prisma as never))
        expect(again.lines, `tick ${n + 2}`).toEqual([])
      }
      const audits = await skipAudits(uk.id)
      expect(audits).toHaveLength(1)
      expect(audits[0].metadata).toMatchObject({ eventId: event.id, phase: 'end' })
      // Still not ended, and nothing queued: the refusal stands, only its saying is once.
      expect(Number((await listingRow(uk.id)).salePrice)).toBe(15)
      expect(await rows(uk.id)).toEqual([])
    }))
  })
})

describe('a promotion ends: its sale is removed through the price door', () => {
  it('🔴 the tick after the event ended clears the sale: ONE pending PRICE_UPDATE with saleRemoved on Amazon, an audit row by promotion-clear:<event>', () => scoped(async () => {
    const { AMAZON: amazon } = await seed('promo-exit', ['AMAZON'])
    const start = new Date(enteringStart().getTime() - 6 * DAY)
    const end = new Date(enteringStart().getTime() - 2 * DAY)
    const event = await promotion('promo-exit', { start, end }, { action: 'FIXED_PRICE', value: 15 })
    await promotionSale(amazon.id, event.id, 15, iso(start), iso(end))
    vi.mocked(recordPriceChange).mockClear()

    await runPromotionScheduler(prisma as never)

    const stored = await listingRow(amazon.id)
    expect(stored.salePrice).toBeNull()
    expect(await windowOf(amazon.id)).toEqual({ start: null, end: null })
    const all = await rows(amazon.id)
    // The promotion's own row was replaced in its grace window by the removal: one pending row, carrying it.
    expect(all.map((r) => r.syncStatus)).toEqual(['CANCELLED', 'PENDING'])
    expect(all[1].payload).toMatchObject({ actor: `promotion-clear:${event.id}`, price: 20, salePrice: null, salePriceStart: null, salePriceEnd: null, saleRemoved: true })
    const audits = await saleAudits(amazon.id)
    expect(audits.map((a) => a.changedBy)).toEqual([`promotion:${event.id}`, `promotion-clear:${event.id}`])
    expect(audits[1]).toMatchObject({ previousValue: `15 ${iso(start)}→${iso(end)}`, newValue: null })
    expect(timeline(amazon.productId)).toEqual([['AMAZON', 'PROMO_END', 20]])

    // Ended once: the next tick finds no sale to end.
    await runPromotionScheduler(prisma as never)
    expect(await rows(amazon.id)).toHaveLength(2)
  }))

  it('🔴 a sale an OPERATOR changed after the promotion set it is not the promotion\'s: its end leaves it alone', () => scoped(async () => {
    const { AMAZON: amazon } = await seed('promo-operator', ['AMAZON'])
    const start = new Date(enteringStart().getTime() - 6 * DAY)
    const end = new Date(enteringStart().getTime() - 2 * DAY)
    const event = await promotion('promo-operator', { start, end }, { action: 'FIXED_PRICE', value: 15 })
    await promotionSale(amazon.id, event.id, 15, iso(start), iso(end))
    const operator = await writeChannelPrices({
      targets: [{ listingId: amazon.id, sale: { value: 14, start: iso(start), end: '2099-12-31' }, expectedVersion: (await listingRow(amazon.id)).version }],
      actor: 'person-1', source: 'MANUAL_OVERRIDE',
    })
    expect(operator.results[0].outcome).toBe('applied')
    const before = await rows(amazon.id)

    await runPromotionScheduler(prisma as never)

    expect(Number((await listingRow(amazon.id)).salePrice)).toBe(14)
    expect(await windowOf(amazon.id)).toEqual({ start: iso(start), end: '2099-12-31' })
    expect(await rows(amazon.id)).toEqual(before)
    expect((await saleAudits(amazon.id)).map((a) => a.changedBy)).toEqual([`promotion:${event.id}`, 'person-1'])
  }))

  it('🔴 DELETE /pricing/promotions/:id ends the promotion\'s sales through the door and soft-deletes the event', () => scoped(async () => {
    const { AMAZON: amazon } = await seed('promo-delete', ['AMAZON'])
    // A running promotion, its sale set by the scheduler.
    const start = enteringStart()
    const end = new Date(start.getTime() + 2 * DAY)
    const event = await promotion('promo-delete', { start, end }, { action: 'FIXED_PRICE', value: 16 })
    await runPromotionScheduler(prisma as never)
    expect(Number((await listingRow(amazon.id)).salePrice)).toBe(16)

    const response = await app.inject({ method: 'DELETE', url: `/pricing/promotions/${event.id}` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, salesEnded: 1 })

    expect((await listingRow(amazon.id)).salePrice).toBeNull()
    const queued = await pending(amazon.id)
    expect(queued).toHaveLength(1)
    expect(queued[0].payload).toMatchObject({ actor: `promotion-clear:${event.id}`, salePrice: null, saleRemoved: true })
    expect((await saleAudits(amazon.id)).map((a) => a.changedBy)).toEqual([`promotion:${event.id}`, `promotion-clear:${event.id}`])
    expect(await prisma.retailEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ isActive: false })
    expect(await prisma.retailEventPriceAction.count({ where: { eventId: event.id, isActive: true } })).toBe(0)

    // A deleted promotion no longer enters: the next tick sets no sale again.
    await runPromotionScheduler(prisma as never)
    expect((await listingRow(amazon.id)).salePrice).toBeNull()
    expect(await pending(amazon.id)).toHaveLength(1)
  }))

  it('endPromotionSales touches only the sales of the promotion it names', () => scoped(async () => {
    const { AMAZON: mine } = await seed('promo-named', ['AMAZON'])
    const { AMAZON: other } = await seed('promo-other', ['AMAZON'])
    const start = new Date(enteringStart().getTime() + 20 * DAY)
    const end = new Date(start.getTime() + 2 * DAY)
    const named = await promotion('promo-named', { start, end }, { action: 'FIXED_PRICE', value: 15 })
    const unnamed = await promotion('promo-other', { start, end }, { action: 'FIXED_PRICE', value: 15 })
    await promotionSale(mine.id, named.id, 15, iso(start), iso(end))
    await promotionSale(other.id, unnamed.id, 15, iso(start), iso(end))

    expect(await endPromotionSales(prisma as never, named.id, named.name)).toBe(1)
    expect((await listingRow(mine.id)).salePrice).toBeNull()
    expect(Number((await listingRow(other.id)).salePrice)).toBe(15)
  }))
})

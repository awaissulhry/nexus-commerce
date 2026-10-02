/**
 * MCP full control 08 S5 — the pricing reads, for the pricing pages and for Claude.
 *
 *   Routes: they keep their answers now that their reads live in `services/pricing/` (pricing-rule, promotion and
 *   scheduled-price services). Written against the routes BEFORE the move and unchanged after it: the pricing rules
 *   (`GET /api/pricing-rules`, `/variation/:id`), the repricer status (`GET /api/pricing/repricer-status`), the
 *   promotions (`GET /api/pricing/promotions`) and a product's scheduled changes (`GET
 *   /api/products/:id/scheduled-changes`). (Also checked once by hand on 2026-10-01: the full answers of 6 requests,
 *   ids and times normalised, were byte-identical before and after the move.)
 *   Tools: Claude's four pricing reads, through the one door (call-tool.ts): currency and held prices shown, bounds,
 *   rules, promotions and scheduled changes, and the switches that decide whether anything would act.
 *
 * Real SQL (PGlite with the production schema); the real route plugins in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
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
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../routes/saved-view-persistence.routes.js', () => ({ default: async () => {} }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const DAY = 86_400_000
const ids = { jacket: '', gloves: '', rule: '', idleRule: '', event: '', price: '', status: '' }
let app: FastifyInstance

async function get(url: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() }
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S5-JACKET', name: 'Test jacket', basePrice: '100.00', minPrice: '80.00', maxPrice: '150.00' } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S5-GLOVES', name: 'Test gloves', basePrice: '20.00' } })).id
    ids.rule = (await db.pricingRule.create({
      data: { name: 'TEST match low', type: 'MATCH_LOW', priority: 1, minMarginPercent: '15', parameters: { offset: 0.5 }, products: { create: [{ productId: ids.jacket }] } },
    })).id
    ids.idleRule = (await db.pricingRule.create({ data: { name: 'TEST idle', type: 'FIXED_PRICE', priority: 2, parameters: {}, isActive: false } })).id
    const now = Date.now()
    ids.event = (await db.retailEvent.create({
      data: {
        name: 'TEST spring sale', startDate: new Date(now - DAY), endDate: new Date(now + 6 * DAY), channel: 'EBAY', marketplace: 'IT', expectedLift: '1.2', prepLeadTimeDays: 7,
        priceActions: { create: [{ channel: 'EBAY', marketplace: 'IT', action: 'PERCENT_OFF', value: '10' }] },
      },
    })).id
    await db.retailEvent.create({ data: { name: 'TEST summer sale', startDate: new Date(now + 30 * DAY), endDate: new Date(now + 37 * DAY), expectedLift: '1.1', prepLeadTimeDays: 7 } })
    await db.retailEvent.create({ data: { name: 'TEST winter sale', startDate: new Date(now - 60 * DAY), endDate: new Date(now - 50 * DAY), expectedLift: '1.3', prepLeadTimeDays: 7 } })
    ids.price = (await db.scheduledProductChange.create({ data: { productId: ids.jacket, kind: 'PRICE', payload: { basePrice: 110 }, scheduledFor: new Date(now + 2 * DAY), status: 'PENDING', createdBy: 'test' } })).id
    ids.status = (await db.scheduledProductChange.create({ data: { productId: ids.jacket, kind: 'STATUS', payload: { status: 'INACTIVE' }, scheduledFor: new Date(now + 9 * DAY), status: 'PENDING' } })).id
    for (const [newPrice, marketplace, at] of [[95, 'IT', '2026-09-01T10:00:00Z'], [100, 'IT', '2026-09-10T10:00:00Z'], [99, 'DE', '2026-09-05T10:00:00Z']] as const) {
      await db.priceChangeEvent.create({
        data: { productId: ids.jacket, sku: 'TEST-SKU-S5-JACKET', channel: 'EBAY', marketplace, oldPrice: '90', newPrice: String(newPrice), currency: 'EUR', source: 'MANUAL_OVERRIDE', reason: 'TEST price', actor: 'test', changedAt: new Date(at) } as never,
      })
    }
    await db.auditLog.create({ data: { entityType: 'RepricerRun', entityId: 'TEST-RUN-1', action: 'tick', after: { liveMode: false, snapshotsScanned: 12, enqueued: 0, dryRunWouldEnqueue: 3, skippedSubThreshold: 9, durationMs: 40 } } })
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  await app.register((await import('../../routes/pricing-rules.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/pricing.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/products-catalog.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S5 — the pricing read routes answer as before', () => {
  it('GET /api/pricing-rules and /variation/:id: active rules by priority; a variation\'s active rules', async () => {
    const { status, body } = await get('/api/pricing-rules')
    expect(status).toBe(200)
    expect(body.map((r: Json) => [r.name, r.type, r.priority, r.minMarginPercent, r.parameters, r.isActive])).toEqual([['TEST match low', 'MATCH_LOW', 1, '15', { offset: 0.5 }, true]])
    expect(await get('/api/pricing-rules/variation/nope')).toEqual({ status: 200, body: [] })
  })

  it('GET /api/pricing/repricer-status: the switches this process sees and the latest ticks', async () => {
    const { status, body } = await get('/api/pricing/repricer-status')
    expect(status).toBe(200)
    expect(body.config).toEqual({ cronEnabled: false, liveMode: false, thresholdPct: 1 })
    expect(body.ticks).toEqual([expect.objectContaining({ runId: 'TEST-RUN-1', action: 'tick', liveMode: false, snapshotsScanned: 12, dryRunWouldEnqueue: 3 })])
  })

  it('GET /api/pricing/promotions: active, upcoming and ended events with their price actions', async () => {
    const { status, body } = await get('/api/pricing/promotions')
    expect(status).toBe(200)
    expect(body.counts).toEqual({ active: 1, upcoming: 1, ended: 1, total: 3 })
    expect(body.active).toEqual([expect.objectContaining({ id: ids.event, name: 'TEST spring sale', priceActions: [expect.objectContaining({ action: 'PERCENT_OFF', value: '10' })] })])
    expect(body.upcoming.map((e: Json) => e.name)).toEqual(['TEST summer sale'])
    expect(body.ended.map((e: Json) => e.name)).toEqual(['TEST winter sale'])
  })

  it('GET /api/pricing/price-history: events newest first, a series per channel and market; 400 without a product', async () => {
    const { status, body } = await get(`/api/pricing/price-history?productId=${ids.jacket}`)
    expect(status).toBe(200)
    expect(body.count).toBe(3)
    expect(body.events.map((e: Json) => [e.marketplace, e.oldPrice, e.newPrice, e.currency, e.source, e.changedAt])).toEqual([
      ['IT', 90, 100, 'EUR', 'MANUAL_OVERRIDE', '2026-09-10T10:00:00.000Z'], ['DE', 90, 99, 'EUR', 'MANUAL_OVERRIDE', '2026-09-05T10:00:00.000Z'], ['IT', 90, 95, 'EUR', 'MANUAL_OVERRIDE', '2026-09-01T10:00:00.000Z'],
    ])
    expect(body.series).toEqual([
      { channel: 'EBAY', marketplace: 'IT', points: [{ t: '2026-09-01T10:00:00.000Z', price: 95 }, { t: '2026-09-10T10:00:00.000Z', price: 100 }] },
      { channel: 'EBAY', marketplace: 'DE', points: [{ t: '2026-09-05T10:00:00.000Z', price: 99 }] },
    ])
    expect((await get('/api/pricing/price-history?sku=TEST-SKU-S5-JACKET&marketplace=de&limit=1')).body.events.map((e: Json) => e.newPrice)).toEqual([99])
    expect((await get('/api/pricing/price-history?productId=' + ids.jacket + '&from=2026-09-04&to=2026-09-06')).body.count).toBe(1)
    expect(await get('/api/pricing/price-history')).toEqual({ status: 400, body: { error: 'productId or sku required' } })
  })

  it('GET /api/products/:id/scheduled-changes: the product\'s changes, soonest first', async () => {
    const { status, body } = await get(`/api/products/${ids.jacket}/scheduled-changes`)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.changes.map((c: Json) => [c.id, c.kind, c.status, c.payload])).toEqual([[ids.price, 'PRICE', 'PENDING', { basePrice: 110 }], [ids.status, 'STATUS', 'PENDING', { status: 'INACTIVE' }]])
    expect(await get(`/api/products/${ids.gloves}/scheduled-changes`)).toEqual({ status: 200, body: { ok: true, changes: [] } })
  })
})

// ── Claude's pricing reads ─────────────────────────────────────────────────────────────────────────────

describe("08 S5 — Claude's pricing reads", () => {
  const person = (permissions: string[]) => ({
    kind: 'user' as const, userId: 'u-s5', label: 'S5 test', via: 'claude' as const, workspace: business,
    permissions: { isOwner: false, permissions: new Set<string>(permissions) },
  })
  const cleared = person([...Object.values(FEATURES), ...Object.values(FIELDS)])
  const operator = person(Object.values(FEATURES))
  const call = async (name: string, args: Record<string, unknown> = {}, who = cleared): Promise<Json> => {
    const { callTool } = await import('../agents/call-tool.js')
    return (await inside(() => callTool(who, name, args))).visible
  }
  const listing = { it: '', uk: '', paused: '' }

  beforeAll(async () => {
    await inside(async () => {
      const db = database.client
      for (const [channel, code, currency] of [['EBAY', 'IT', 'EUR'], ['EBAY', 'UK', 'GBP'], ['AMAZON', 'DE', 'EUR']] as const) {
        await db.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, region: 'EU', currency, language: 'en', languages: ['en'], marketplaceId: `TEST_${channel}_${code}` } as never })
      }
      const make = (channel: string, marketplace: string, price: string, extra: Record<string, unknown> = {}) => db.channelListing.create({
        data: { productId: ids.jacket, channelMarket: `${channel}_${marketplace}`, channel, region: marketplace, marketplace, price, quantity: 3, listingStatus: 'ACTIVE', ...extra } as never,
      })
      listing.it = (await make('EBAY', 'IT', '100.00', { salePrice: '90.00' })).id
      listing.uk = (await make('EBAY', 'UK', '160.00', { followMasterPrice: false })).id
      listing.paused = (await make('AMAZON', 'DE', '100.00', { syncPaused: true })).id
      // The sale window columns (migration 20260913_mx1_sale_price_window) are not in the test schema.
      await database.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
      ;(await import('../pim/sale-window.js')).resetSaleWindowColumnCache()
      await db.$executeRawUnsafe(`UPDATE "ChannelListing" SET "salePriceStart" = '2026-10-01'::date, "salePriceEnd" = '2026-10-10'::date WHERE "id" = $1`, listing.it)
      await db.outboundSyncQueue.create({
        data: {
          productId: ids.jacket, channelListingId: listing.paused, targetChannel: 'AMAZON', syncStatus: 'SKIPPED', syncType: 'PRICE_UPDATE',
          errorCode: 'PUSH_SYNC_PAUSED', maxRetries: 0, payload: { price: 95, source: 'HELD_PRICE', held: 'PUSH_SYNC_PAUSED' },
        } as never,
      })
      await db.ebayMarkdown.create({
        data: { channelListingId: listing.it, discountType: 'PERCENT', discountValue: '10', originalPrice: '100.00', markdownPrice: '90.00', currency: 'EUR', status: 'SCHEDULED', startDate: new Date(Date.now() + DAY) } as never,
      })
      await db.scheduledProductChange.create({ data: { productId: ids.gloves, kind: 'PRICE', payload: { adjustPercent: 60 }, scheduledFor: new Date(Date.now() + 3 * DAY), status: 'PENDING' } })
      await db.product.update({ where: { id: ids.gloves }, data: { maxPrice: '30.00' } })
    })
  })

  it('price-status: currency per listing, sale window, bounds, outside-bounds and the held price; the pending scheduled price change', async () => {
    const out = await call('price-status', { productId: ids.jacket })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ sku: 'TEST-SKU-S5-JACKET', masterPrice: 100, masterCurrency: 'EUR', bounds: { min: 80, max: 150 } })
    const by = Object.fromEntries(out.data.channels.map((c: Json) => [`${c.channel}:${c.marketplace}`, c]))
    expect(by['EBAY:IT']).toMatchObject({ currency: 'EUR', takesMasterPrice: true, price: 100, salePrice: 90, saleWindow: { start: '2026-10-01', end: '2026-10-10' }, outsideBounds: null, held: null })
    expect(by['EBAY:UK']).toMatchObject({ currency: 'GBP', takesMasterPrice: false, followsMaster: false, price: 160, outsideBounds: 'above-max' })
    expect(by['AMAZON:DE']).toMatchObject({ syncPaused: true, held: { why: 'sync paused: sent when the listing resumes', price: 95 } })
    expect(out.data.scheduledPriceChanges).toEqual([{ id: ids.price, newPrice: 110, adjustPercent: null, at: expect.any(String), createdBy: 'test' }])
  })

  it('pricing-rules: active rules with their products; nothing sent; the repricer switches; margins only for a person who may see them', async () => {
    const out = await call('pricing-rules')
    expect(out.data.rules).toEqual([expect.objectContaining({ name: 'TEST match low', type: 'MATCH_LOW', products: 1, skus: ['TEST-SKU-S5-JACKET'], minMarginPercent: 15 })])
    expect(out.data.repricer).toMatchObject({ pricingCron: false, live: false, recentRuns: [expect.objectContaining({ runId: 'TEST-RUN-1' })] })
    expect(out.data.sendsNothing).toMatch(/nothing is sent/)
    expect((await call('pricing-rules', { productId: ids.gloves })).data.rules).toEqual([])
    expect((await call('pricing-rules', {}, operator)).data.rules[0]).not.toHaveProperty('minMarginPercent')
  })

  it('price-promotions: sale events by state (not applied while the pricing cron is off), eBay markdowns, dry-run eBay sends', async () => {
    const out = await call('price-promotions')
    expect(out.data.saleEvents).toMatchObject({
      counts: { active: 1, upcoming: 1, ended: 1, total: 3 }, active: [{ name: 'TEST spring sale', priceActions: [{ action: 'PERCENT_OFF', value: 10 }] }],
      applies: expect.stringContaining('pricing cron is off'),
    })
    expect(out.data.ebayMarkdowns).toEqual([expect.objectContaining({ sku: 'TEST-SKU-S5-JACKET', marketplace: 'IT', originalPrice: 100, markdownPrice: 90, currency: 'EUR', status: 'SCHEDULED' })])
    expect(out.data.ebaySends).toEqual({ markdowns: 'dry run', volumePricing: 'dry run' })
    expect((await call('price-promotions', { productId: ids.gloves })).data.ebayMarkdowns).toEqual([])
  })

  it('scheduled-price-changes: pending price changes soonest first, what each would set against today\'s price and bounds, paged', async () => {
    const out = await call('scheduled-price-changes')
    expect(out.data.items.map((c: Json) => [c.sku, c.newPrice, c.adjustPercent, c.masterPriceNow, c.wouldBe, c.outsideBounds, c.status])).toEqual([
      ['TEST-SKU-S5-JACKET', 110, null, 100, 110, null, 'PENDING'],
      ['TEST-SKU-S5-GLOVES', null, 60, 20, 32, 'above-max', 'PENDING'],
    ])
    expect(out.data).toMatchObject({ masterCurrency: 'EUR', scheduler: expect.stringContaining('runs every minute') })
    const first = await call('scheduled-price-changes', { limit: 1 })
    const second = await call('scheduled-price-changes', { limit: 1, cursor: first.data.nextCursor })
    expect([first.data.items[0].sku, second.data.items[0].sku, second.data.nextCursor]).toEqual(['TEST-SKU-S5-JACKET', 'TEST-SKU-S5-GLOVES', null])
    expect((await call('scheduled-price-changes', { productId: ids.gloves, status: 'APPLIED' })).data.items).toEqual([])
  })

  it('the pricing engine explains a listing\'s price in a business with no connected account for the channel (it failed: the listing lookup named a null account)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/pricing/explain?sku=TEST-SKU-S5-JACKET&channel=EBAY&marketplace=IT' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ currency: 'EUR', price: expect.any(Number) })
  })

  it('price-explain: the engine\'s answer for one market with its reasoning and the recent changes there; costs only with permission; an unconfigured market is refused', async () => {
    const out = await call('price-explain', { productId: ids.jacket, channel: 'ebay', marketplace: 'it' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.data).toMatchObject({ sku: 'TEST-SKU-S5-JACKET', channel: 'EBAY', marketplace: 'IT', currency: 'EUR', source: expect.any(String), price: expect.any(Number) })
    expect(out.data.reasoning.length).toBeGreaterThan(0)
    expect(out.data.recentChanges.map((c: Json) => c.newPrice)).toEqual([100, 95])
    expect(out.data.breakdown).toHaveProperty('effectiveCostBasis')
    const hidden = await call('price-explain', { productId: ids.jacket, channel: 'EBAY', marketplace: 'IT' }, operator)
    expect(hidden.data.breakdown).not.toHaveProperty('effectiveCostBasis')
    expect(hidden.data.breakdown).not.toHaveProperty('costPrice')
    expect(await call('price-explain', { productId: ids.jacket, channel: 'EBAY', marketplace: 'FR' })).toMatchObject({ ok: false, error: expect.stringContaining('No currency is configured') })
    expect(await call('price-explain', { productId: 'nope', channel: 'EBAY', marketplace: 'IT' })).toEqual({ ok: false, error: 'Product not found' })
  })

  it('two eBay accounts: price-explain takes the listing\'s own account, asks which one when the product is listed on both, and answers for the one named — never a crash', async () => {
    const db = database.client
    const accounts = await inside(async () => Promise.all([1, 2].map((n) => db.channelConnection.create({
      data: { channelType: 'EBAY', accountLabel: `TEST eBay store ${n}`, externalAccountId: `test-seller-${n}`, isActive: true, isPrimary: false } as never,
    }))))
    const gloves = await inside(() => db.channelListing.create({
      data: { productId: ids.gloves, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', price: '21.00', quantity: 1, listingStatus: 'ACTIVE', channelConnectionId: accounts[0].id } as never,
    }))
    // One listing, on one account: that account is the one.
    const one = await call('price-explain', { productId: ids.gloves, channel: 'EBAY', marketplace: 'IT' })
    expect(one, JSON.stringify(one)).toMatchObject({ ok: true, data: { sku: 'TEST-SKU-S5-GLOVES', currency: 'EUR' } })
    // Listed on both accounts: the answer names them; with accountId it answers for that one.
    await inside(() => db.channelListing.create({
      data: { productId: ids.gloves, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', price: '23.00', quantity: 1, listingStatus: 'ACTIVE', channelConnectionId: accounts[1].id } as never,
    }))
    const both = await call('price-explain', { productId: ids.gloves, channel: 'EBAY', marketplace: 'IT' })
    expect(both).toMatchObject({ ok: false, error: expect.stringContaining('TEST eBay store 2') })
    expect(both.error).toContain(accounts[0].id)
    const named = await call('price-explain', { productId: ids.gloves, channel: 'EBAY', marketplace: 'IT', accountId: accounts[1].id })
    expect(named, JSON.stringify(named)).toMatchObject({ ok: true, data: { accountId: accounts[1].id } })
    expect(await call('price-explain', { productId: ids.gloves, channel: 'EBAY', marketplace: 'IT', accountId: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining('not an active EBAY account') })
    // Listed on neither, and neither account is primary: the answer names every active account (read through the resolver).
    const unlisted = await inside(() => db.product.create({ data: { sku: 'TEST-SKU-S5-UNLISTED', name: 'Test unlisted', basePrice: '10.00' } }))
    const none = await call('price-explain', { productId: unlisted.id, channel: 'EBAY', marketplace: 'IT' })
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('accounts are active and none is primary') })
    expect(none.error).toContain(`${accounts[0].id} (TEST eBay store 1)`)
    expect(none.error).toContain(`${accounts[1].id} (TEST eBay store 2)`)
    // The pricing page's route says the same in a 400, never a 500.
    const route = await app.inject({ method: 'GET', url: '/api/pricing/explain?sku=TEST-SKU-S5-GLOVES&channel=EBAY&marketplace=IT' })
    expect(route.statusCode, route.body).toBe(400)
    expect(route.json()).toMatchObject({ code: 'account_ambiguous' })
    expect(gloves.id).toBeTruthy()
  })
})


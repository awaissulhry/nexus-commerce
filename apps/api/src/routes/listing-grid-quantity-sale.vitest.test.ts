/**
 * The listings grid's stock cell and a listing's sale, through the Studio matrix's own write (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. `PATCH /api/listings/:id` refused `{ quantity }`, so the grid's stock cell always failed; and it
 * wrote `salePrice` as a bare column — no dates, no audit, nothing queued — so a sale never reached the channel. Both
 * now take the matrix cell's rules: the quantity through the matrix's own pin (`pinTypedQuantity`: the same FBA
 * refusal, the same staging and PIN, the Amazon EU group), the sale through the price door with its window and the
 * matrix's eBay/Etsy, parent and permission refusals. A standalone product's listing (which the family matrix holds as
 * its parent row) is editable here too.
 *
 * Real PostgreSQL in-process (PGlite), the route through Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { resetSaleWindowColumnCache } from '../services/pim/sale-window.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}
let app: ReturnType<typeof Fastify>

beforeAll(async () => {
  // The two sale-window columns are raw SQL on the deployed databases (migration 20260913_mx1_sale_price_window).
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await scoped(async () => {
    const market = (channel: string, code: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'en', languages: ['en'] } })
    await market('AMAZON', 'IT'); await market('AMAZON', 'DE'); await market('EBAY', 'DE'); await market('ETSY', 'GLOBAL')
    for (const channel of ['AMAZON', 'EBAY', 'ETSY']) {
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `grid-${channel}`, isActive: true, isPrimary: true } as never })).id
    }
  })
  const { listingsSyndicationRoutes } = await import('./listings-syndication.routes.js')
  app = Fastify()
  // The request runs in the business, as the workspace hook puts it there, by a person who may edit prices.
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.headers['x-test-no-price'] !== '1') (request as any).__rbacResolved = { isOwner: true, permissions: new Set<string>() }
    else (request as any).__rbacResolved = { isOwner: false, permissions: new Set<string>() }
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

async function seed(id: string, listings: Array<{ channel: 'AMAZON' | 'EBAY' | 'ETSY'; marketplace: string; fulfillmentMethod?: 'FBA' | 'FBM' }>) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, totalStock: 20 } })
  const rows = []
  for (const l of listings) {
    rows.push(await prisma.channelListing.create({ data: { productId: id, channel: l.channel, channelConnectionId: accounts[l.channel], channelMarket: `${l.channel}_${l.marketplace}`,
      marketplace: l.marketplace, region: 'EU', listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}-${l.marketplace}`,
      price: 10, followMasterPrice: true, quantity: 5, followMasterQuantity: true, fulfillmentMethod: l.fulfillmentMethod ?? 'FBM' } as never }))
  }
  return rows
}
const patch = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => scoped(async () => app.inject({ method: 'PATCH', url: `/api/listings/${id}`, payload, headers }))
const listing = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id } }))
const queued = (channelListingId: string, syncType: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType, syncStatus: 'PENDING' } }))

describe('the grid\'s stock cell pins the quantity with the matrix\'s own pin (pinTypedQuantity)', () => {
  it('🔴 eBay: { quantity } pins the listing at it and queues one QUANTITY_UPDATE (it was always a 400)', async () => {
    const [l] = await scoped(() => seed('grid-qty', [{ channel: 'EBAY', marketplace: 'DE' }]))
    const res = await patch(l.id, { quantity: 7, expectedVersion: l.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, changed: true })
    expect(await listing(l.id)).toMatchObject({ followMasterQuantity: false, quantity: 7, quantityOverride: 7 })
    expect((await queued(l.id, 'QUANTITY_UPDATE')).length).toBe(1)
  })

  it('🔴 an Amazon-managed (FBA) listing is refused with the matrix\'s sentence and nothing is written', async () => {
    const [l] = await scoped(() => seed('grid-fba', [{ channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBA' }]))
    const before = await listing(l.id)
    const res = await patch(l.id, { quantity: 3, expectedVersion: l.version })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(MATRIX_COPY.amazonManaged)
    expect(await listing(l.id)).toEqual(before)
    expect(await queued(l.id, 'QUANTITY_UPDATE')).toEqual([])
  })

  it('🔴 an Amazon EU market writes the SKU\'s whole EU group, as the matrix does, and says which markets', async () => {
    const [it_, de] = await scoped(() => seed('grid-eu', [{ channel: 'AMAZON', marketplace: 'IT' }, { channel: 'AMAZON', marketplace: 'DE' }]))
    const res = await patch(de.id, { quantity: 4, expectedVersion: de.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().expandedTo).toEqual(expect.arrayContaining(['IT', 'DE']))
    for (const l of [it_, de]) expect(await listing(l.id)).toMatchObject({ followMasterQuantity: false, quantity: 4 })
  })

  it('a stale version is 409; a quantity beside another field is a 400; a negative or fractional quantity is a 400', async () => {
    const [l] = await scoped(() => seed('grid-qty-bad', [{ channel: 'EBAY', marketplace: 'DE' }]))
    expect((await patch(l.id, { quantity: 7, expectedVersion: l.version - 1 })).statusCode).toBe(409)
    // In the operator's words: no field names.
    const beside = await patch(l.id, { quantity: 7, stockBuffer: 1 })
    expect([beside.statusCode, beside.json().error]).toEqual([400, 'Save the quantity or the sale on its own, then save the other changes.'])
    for (const quantity of [-1, 1.5]) {
      const res = await patch(l.id, { quantity })
      expect([res.statusCode, res.json().error]).toEqual([400, 'The quantity must be a whole number, 0 or more.'])
    }
    expect(await listing(l.id)).toMatchObject({ quantity: 5, followMasterQuantity: true })
  })
})

describe('a sale goes through the price door with its window, with the matrix sale cell\'s rules', () => {
  it('🔴 Amazon: a sale with both dates is stored and queued with the price row (it was a bare column, never sent)', async () => {
    const [l] = await scoped(() => seed('sale-amazon', [{ channel: 'AMAZON', marketplace: 'IT' }]))
    const res = await patch(l.id, { salePrice: 8, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-30', expectedVersion: l.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(Number((await listing(l.id)).salePrice)).toBe(8)
    const rows = await queued(l.id, 'PRICE_UPDATE')
    expect(rows.map((row) => [(row.payload as any).salePrice, (row.payload as any).salePriceStart, (row.payload as any).salePriceEnd])).toEqual([[8, '2026-11-01', '2026-11-30']])
  })

  it('a sale without both dates is refused by the door\'s window rule; nothing written', async () => {
    const [l] = await scoped(() => seed('sale-nodates', [{ channel: 'AMAZON', marketplace: 'IT' }]))
    const res = await patch(l.id, { salePrice: 8, expectedVersion: l.version })
    expect(res.statusCode).toBe(400)
    // A sale of 0 is refused before the door, in the operator's words.
    const zero = await patch(l.id, { salePrice: 0, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-30' })
    expect([zero.statusCode, zero.json().error]).toEqual([400, 'The sale price must be above 0.'])
    expect((await listing(l.id)).salePrice).toBeNull()
    expect(await queued(l.id, 'PRICE_UPDATE')).toEqual([])
  })

  it('🔴 eBay and Etsy have no listing sale: refused with the matrix\'s own sentences', async () => {
    const [ebay] = await scoped(() => seed('sale-ebay', [{ channel: 'EBAY', marketplace: 'DE' }]))
    const [etsy] = await scoped(() => seed('sale-etsy', [{ channel: 'ETSY', marketplace: 'GLOBAL' }]))
    const e = await patch(ebay.id, { salePrice: 8, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-30' })
    expect([e.statusCode, e.json().error]).toEqual([400, MATRIX_COPY.absentSaleEbay])
    const t = await patch(etsy.id, { salePrice: 8, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-30' })
    expect([t.statusCode, t.json().error]).toEqual([400, MATRIX_COPY.absentSaleEtsy])
    expect((await listing(etsy.id)).salePrice).toBeNull()
  })

  it('without the price permission a sale is refused, as in the matrix', async () => {
    const [l] = await scoped(() => seed('sale-perm', [{ channel: 'AMAZON', marketplace: 'IT' }]))
    const res = await patch(l.id, { salePrice: 8, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-30' }, { 'x-test-no-price': '1' })
    expect(res.statusCode).toBe(403)
    expect((await listing(l.id)).salePrice).toBeNull()
  })
})

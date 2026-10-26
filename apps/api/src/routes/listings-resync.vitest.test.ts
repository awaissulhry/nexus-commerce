/**
 * "Refresh from Amazon" — `POST /api/listings/:id/resync` on an Amazon listing is a READ (2026-10-26).
 *
 * 🔴 WHAT THIS GUARDS. The route sent the listing's ASIN where Amazon's getListingsItem wants the seller SKU, through the
 * default account instead of the listing's own; it overwrote Nexus's price, quantity and title with Amazon's; and on
 * Amazon's "not found" (or any failed read) it marked the listing's PUSH failed. Now it reads by the listing's own
 * seller SKU (else the product SKU) on the listing's own account, stores only Amazon's own facts (status, an ASIN the row
 * lacks, Amazon's messages, the read time), answers Amazon's values beside them, and puts the push status back when the
 * read did not land.
 *
 * Real PostgreSQL in-process (PGlite), the route through Fastify inject. Amazon is a mock; no network. Every id, SKU and
 * ASIN is invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const MP = 'APJ6JRA9NG5V4'
const m = vi.hoisted(() => ({ db: null as any, read: vi.fn(), clients: vi.fn(), sellerId: vi.fn(), region: vi.fn(), announce: vi.fn() }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  m.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: m.db.client, prisma: m.db.client }
})
vi.mock('../clients/amazon-sp-api.client.js', async (importOriginal) => ({
  ...await importOriginal<any>(),
  AmazonSpApiClient: class { constructor(account: unknown) { m.clients(account) } getListingsItem(options: unknown) { return m.read(options) } },
}))
vi.mock('../lib/amazon-sp-client.js', async (importOriginal) => ({ ...await importOriginal<any>(), getAmazonSellerId: m.sellerId, getAmazonRegion: m.region }))
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn() } }))
vi.mock('../services/listing-values-events.js', () => ({ announceListingValues: m.announce }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { FBA_QUANTITY_NOTE, NO_AMAZON_ACCOUNT, resyncListing } from '../services/listings/resync.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''
let ebayAccount = ''
let app: ReturnType<typeof Fastify>

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: MP } as never })
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'resync-amazon', externalAccountId: 'SELLER-RS', isActive: true, isPrimary: true } as never })).id
    ebayAccount = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'resync-ebay', externalAccountId: 'resync-ebay', isActive: true, isPrimary: true } as never })).id
  })
  const { listingsSyndicationRoutes } = await import('./listings-syndication.routes.js')
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    Object.assign(request, { __rbacResolved: { isOwner: true, permissions: new Set<string>() } })
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await m.db?.close() }, 60_000)

beforeEach(() => {
  m.read.mockReset()
  m.clients.mockReset()
  m.announce.mockReset()
  m.sellerId.mockReset().mockImplementation(async (accountId: string) => `SELLER-OF-${accountId}`)
  m.region.mockReset().mockResolvedValue('eu')
})

let n = 0
/** A product at SKU `TEST-RS-<id>` with one Amazon IT listing: live, ASIN B0STORED01, Nexus price 10, quantity 5. */
async function seed(id: string, listing: Record<string, unknown> = {}) {
  return scoped(async () => {
    const productId = `rs-${id}-${++n}`
    await prisma.product.create({ data: { id: productId, sku: `TEST-RS-${id.toUpperCase()}-${n}`, name: id, basePrice: 10, totalStock: 5, fulfillmentMethod: 'FBM' } as never })
    return prisma.channelListing.create({ data: {
      productId, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0STORED01', fulfillmentMethod: 'FBM',
      title: 'The title in Nexus', price: 10, masterPrice: 10, quantity: 5,
      syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', lastSyncError: null, syncRetryCount: 2,
      ...listing,
    } as never })
  })
}
const row = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id } }))
const attempts = (listingId: string) => scoped(() => prisma.syncAttempt.findMany({ where: { listingId }, orderBy: { attemptedAt: 'asc' } }))
const issues = (listingId: string) => scoped(() => prisma.listingIssue.findMany({ where: { listingId }, orderBy: { code: 'asc' } }))
const refresh = (id: string) => scoped(async () => app.inject({ method: 'POST', url: `/api/listings/${id}/resync` }))

type Found = { asin?: string; status?: string[]; amount?: string; fulfillment?: unknown[]; issues?: unknown[] }
/** Amazon's answer for a SKU it holds, as the client returns it. */
function found(o: Found = {}) {
  const asin = o.asin ?? 'B0STORED01'
  const status = o.status ?? ['BUYABLE', 'DISCOVERABLE']
  const issueList = o.issues ?? []
  return {
    success: true, sku: 'x', asin, status, issues: issueList,
    rawResponse: {
      sku: 'x', summaries: [{ marketplaceId: MP, asin, status, itemName: 'The title on Amazon' }],
      offers: [{ marketplaceId: MP, offerType: 'B2C', price: { currencyCode: 'EUR', amount: o.amount ?? '99.00' } }],
      fulfillmentAvailability: o.fulfillment ?? [{ fulfillmentChannelCode: 'DEFAULT', quantity: 24 }],
      issues: issueList,
    },
  }
}
/** The client's exact answer to Amazon's HTTP 404. */
const absent = { success: true, sku: 'x', asin: null, status: null }

describe('POST /api/listings/:id/resync — Amazon "Refresh from Amazon"', () => {
  it('🔴 reads by the listing\'s own seller SKU (never the ASIN), through the listing\'s own account', async () => {
    const listing = await seed('own', { liveChannelSku: 'OWN-SELLER-SKU' })
    m.read.mockResolvedValue(found())
    const res = await refresh(listing.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(m.sellerId).toHaveBeenCalledWith(account)
    expect(m.region).toHaveBeenCalledWith(account)
    expect(m.clients).toHaveBeenCalledWith({ id: account, region: 'eu' })
    expect(m.read).toHaveBeenCalledWith({ sellerId: `SELLER-OF-${account}`, sku: 'OWN-SELLER-SKU', marketplaceId: MP, includedData: ['summaries', 'offers', 'fulfillmentAvailability', 'issues'] })
  }, 60_000)

  it('reads by the product SKU when the listing has no seller SKU of its own', async () => {
    const listing = await seed('product')
    m.read.mockResolvedValue(found())
    const res = await refresh(listing.id)
    expect(res.statusCode, res.body).toBe(200)
    const product = await scoped(() => prisma.product.findUniqueOrThrow({ where: { id: listing.productId } }))
    expect(m.read.mock.calls[0][0].sku).toBe(product.sku)
  }, 60_000)

  it('🔴 found: stores only Amazon\'s own facts — never price, quantity or title — and answers Amazon\'s values', async () => {
    const listing = await seed('found', { externalListingId: null, syncStatus: 'FAILED', lastSyncStatus: 'FAILED', lastSyncError: 'an older push failed' })
    m.read.mockResolvedValue(found({ asin: 'B0FOUND001', amount: '99.00' }))
    const res = await refresh(listing.id)
    expect(res.statusCode, res.body).toBe(200)
    const after = await row(listing.id)
    expect(Number(after.price)).toBe(10)
    expect(after.quantity).toBe(5)
    expect(after.title).toBe('The title in Nexus')
    expect(after).toMatchObject({ listingStatus: 'BUYABLE', externalListingId: 'B0FOUND001', syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', lastSyncError: null, syncRetryCount: 2, version: listing.version + 1 })
    expect(after.lastSyncedAt).not.toBeNull()
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.listing.id).toBe(listing.id)
    expect(body.amazon).toMatchObject({ market: 'IT', status: 'BUYABLE', asin: 'B0FOUND001', price: 99, currency: 'EUR', quantity: 24, fulfillment: 'FBM', quantityNote: null, issues: [], notes: [] })
    expect((await attempts(listing.id)).map((a) => a.status)).toEqual(['SUCCESS'])
    expect(m.announce).toHaveBeenCalledWith([listing.id], ['syncState', 'externalListingId'], 'amazon-refresh')
  }, 60_000)

  it('keeps a different stored ASIN and says so', async () => {
    const listing = await seed('kept-asin')
    m.read.mockResolvedValue(found({ asin: 'B0OTHER001' }))
    const res = await refresh(listing.id)
    expect(res.statusCode, res.body).toBe(200)
    expect((await row(listing.id)).externalListingId).toBe('B0STORED01')
    expect(res.json().amazon.notes).toEqual(['Nexus links this listing to ASIN B0STORED01; Amazon reports B0OTHER001 for this SKU. The link was not changed.'])
  }, 60_000)

  it('FBA: Amazon reports no quantity, and the answer says so', async () => {
    const listing = await seed('fba', { fulfillmentMethod: 'FBA' })
    m.read.mockResolvedValue(found({ fulfillment: [{ fulfillmentChannelCode: 'AMAZON_EU' }] }))
    const res = await refresh(listing.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().amazon).toMatchObject({ quantity: null, fulfillment: 'FBA', quantityNote: FBA_QUANTITY_NOTE })
    expect((await row(listing.id)).quantity).toBe(5)
  }, 60_000)

  it('records Amazon\'s messages on the listing and resolves the ones Amazon no longer reports', async () => {
    const listing = await seed('issues')
    m.read.mockResolvedValueOnce(found({ issues: [
      { code: '90220', message: 'item_name is required but missing.', severity: 'ERROR', attributeNames: ['item_name'] },
      { code: '18027', message: 'The image is too small.', severity: 'WARNING', attributeNames: ['main_product_image_locator'] },
    ] }))
    const first = await refresh(listing.id)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().amazon.issues).toEqual([
      { code: '90220', message: 'item_name is required but missing.', severity: 'ERROR', attributeNames: ['item_name'] },
      { code: '18027', message: 'The image is too small.', severity: 'WARNING', attributeNames: ['main_product_image_locator'] },
    ])
    expect((await issues(listing.id)).map((i) => [i.code, i.source, i.resolvedAt === null])).toEqual([['18027', 'listings-api', true], ['90220', 'listings-api', true]])

    m.read.mockResolvedValueOnce(found({ issues: [{ code: '18027', message: 'The image is too small.', severity: 'WARNING', attributeNames: ['main_product_image_locator'] }] }))
    expect((await refresh(listing.id)).statusCode).toBe(200)
    expect((await issues(listing.id)).map((i) => [i.code, i.resolvedAt === null])).toEqual([['18027', true], ['90220', false]])
  }, 60_000)

  it('🔴 no account on the listing: 409, nothing is marked, Amazon is not called', async () => {
    const listing = await seed('no-account', { channelConnectionId: null, syncStatus: 'FAILED', lastSyncStatus: 'FAILED', lastSyncError: 'an older push failed' })
    const res = await refresh(listing.id)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: NO_AMAZON_ACCOUNT })
    expect(m.read).not.toHaveBeenCalled()
    expect(await attempts(listing.id)).toEqual([])
    expect(await row(listing.id)).toMatchObject({ syncStatus: 'FAILED', lastSyncStatus: 'FAILED', lastSyncError: 'an older push failed', syncRetryCount: 2, version: listing.version })
  }, 60_000)

  it('🔴 Amazon has no listing for the SKU: 404 in words, the attempt is NOT_FOUND, the listing is not marked failed', async () => {
    const listing = await seed('absent', { liveChannelSku: 'GONE-SKU' })
    m.read.mockResolvedValue(absent)
    const res = await refresh(listing.id)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Amazon has no listing with seller SKU GONE-SKU in Italy.' })
    expect(await row(listing.id)).toMatchObject({ syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', lastSyncError: null, syncRetryCount: 2, listingStatus: 'ACTIVE', externalListingId: 'B0STORED01', version: listing.version })
    const [attempt] = await attempts(listing.id)
    expect(attempt).toMatchObject({ status: 'NOT_FOUND', error: 'Amazon has no listing with seller SKU GONE-SKU in Italy.' })
  }, 60_000)

  it('🔴 a failed read: 502 with the reason, the attempt records it, the listing\'s push status is put back', async () => {
    const listing = await seed('error', { syncStatus: 'PENDING', lastSyncStatus: null })
    m.read.mockResolvedValue({ success: false, sku: 'x', asin: null, status: null, error: 'Amazon listing read failed (500)' })
    const res = await refresh(listing.id)
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'Amazon could not read this listing: Amazon listing read failed (500)' })
    expect(await row(listing.id)).toMatchObject({ syncStatus: 'PENDING', lastSyncStatus: null, lastSyncError: null, syncRetryCount: 2, price: listing.price, quantity: 5 })
    expect((await attempts(listing.id)).map((a) => [a.status, a.error])).toEqual([['FAILED', 'Amazon could not read this listing: Amazon listing read failed (500)']])
  }, 60_000)

  it('a read with no answer in time: 504, the attempt is TIMEOUT, the listing is not marked failed', async () => {
    const listing = await seed('timeout')
    m.read.mockImplementation(() => new Promise(() => {}))
    const answer = await scoped(() => resyncListing(listing.id, { timeoutMs: 50 }))
    expect(answer).toEqual({ ok: false, status: 504, body: { error: 'Amazon did not answer in time (0.05 s). Nothing was changed.' } })
    expect(await row(listing.id)).toMatchObject({ syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', syncRetryCount: 2 })
    expect((await attempts(listing.id)).map((a) => a.status)).toEqual(['TIMEOUT'])
  }, 60_000)

  it('a listing still a Nexus draft is not marked live or linked (its pause would hold Publish)', async () => {
    const listing = await seed('draft', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, syncStatus: 'IDLE', lastSyncStatus: null })
    m.read.mockResolvedValue(found({ asin: 'B0DRAFT001' }))
    const res = await refresh(listing.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(await row(listing.id)).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, syncStatus: 'IN_SYNC' })
    expect(res.json().amazon.notes).toEqual(['Nexus still holds this listing as a draft, so the read did not mark it live or link its ASIN. Publish sends it.'])
  }, 60_000)

  it('an ended listing keeps its status: a read never lifts the lock', async () => {
    const listing = await seed('ended', { listingStatus: 'ENDED' })
    m.read.mockResolvedValue(found())
    expect((await refresh(listing.id)).statusCode).toBe(200)
    expect((await row(listing.id)).listingStatus).toBe('ENDED')
  }, 60_000)

  it('another channel: 501, as before, and the listing is not touched', async () => {
    const listing = await seed('ebay', { channel: 'EBAY', channelMarket: 'EBAY_IT', channelConnectionId: ebayAccount, externalListingId: '110000000001' })
    const res = await refresh(listing.id)
    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({ error: 'NOT_IMPLEMENTED', detail: 'Resync is not yet implemented for channel "EBAY".' })
    expect(m.read).not.toHaveBeenCalled()
    expect(await row(listing.id)).toMatchObject({ syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', version: listing.version })
    expect((await attempts(listing.id)).map((a) => a.status)).toEqual(['NOT_IMPLEMENTED'])
  }, 60_000)
})

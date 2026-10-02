/**
 * S1 (MCP full control, section 08 §1.4 F4 and F5) — a price or a cost is changed only by a person who holds the
 * price or the cost permission, on every write the app offers, not only in the Studio matrix.
 *
 * 🔴 WHAT THIS GUARDS. `products.price.edit` was a route rule that matched no route (no path under /api/products holds
 * a `/price` segment), so a master price (the products grid, the product page, the sheet), a listing price (the
 * listing drawer, the listings bulk bar) and a bulk PRICING_UPDATE job needed only products.edit / listings.edit /
 * products.bulk.run. And the cost permission named `/api/product-costs`, a path no route has. A role without the
 * permission (Operations Manager holds no cost permission) could change both.
 *
 * Each arm sends the request as a person WITHOUT the permission and reads what was STORED (nothing), then sends the
 * same request as a person WITH it (the Owner holds every permission, so nothing changes for him) as the control.
 * Real PostgreSQL in-process (PGlite), the real routes through Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { outboundSyncQueue: queue, redis: { connection: null }, searchIndexQueue: queue, readCacheQueue: queue, bulkJobQueue: queue, channelSyncQueue: queue, addJobSafely: vi.fn(async () => null) }
})
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { applyProductBulkEdits, bulkEditPermissionRefusal } from '../services/products/bulk-edit.service.js'
import { BulkActionPermissionError, BulkActionService, bulkJobChangesPrices } from '../services/bulk-action.service.js'
import { MasterPricePermissionError, MasterPriceService } from '../services/master-price.service.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
const PRICE = 'products.price.edit'
/** What an Operations Manager holds around prices: every edit permission but the cost one. */
const OPS = ['products.view', 'products.edit', 'listings.view', 'listings.edit', 'listings.publish', 'products.bulk.run']
let app: FastifyInstance
let ebay = ''

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'eBay DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
    ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'price-permission', isActive: true } })).id
  })
  app = Fastify()
  // The permissions the RBAC gate would have resolved for this person (`x-test-perms`), in the business.
  app.addHook('onRequest', (request, _reply, done) => {
    const perms = String(request.headers['x-test-perms'] ?? '').split(',').filter(Boolean)
    Object.assign(request, {
      authUser: { id: 'person-price', email: 'price@example.test', roleKeys: [], permissionsVersion: 1 },
      __rbacResolved: { isOwner: perms.includes('OWNER'), permissions: new Set(perms) },
    })
    withWorkspace(BUSINESS, done)
  })
  const { listingsSyndicationRoutes } = await import('./listings-syndication.routes.js')
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
  await app.register((await import('./products-catalog.routes.js')).default, { prefix: '/api' })
  await app.register((await import('./bulk-operations.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

async function seed(id: string) {
  return scoped(async () => {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, costPrice: 4 } as never })
    return prisma.channelListing.create({ data: {
      productId: id, channel: 'EBAY', channelConnectionId: ebay, channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, price: 10, masterPrice: 10, followMasterPrice: true,
    } as never })
  })
}
const as = (perms: string[]) => ({ 'x-test-perms': perms.join(',') })
const product = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, select: { basePrice: true, costPrice: true, minPrice: true, version: true } }))
const listingRow = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id }, select: { price: true, priceOverride: true, followMasterPrice: true, version: true } }))
const queuedPrices = (channelListingId: string) => scoped(() => prisma.outboundSyncQueue.count({ where: { channelListingId, syncType: 'PRICE_UPDATE' } }))

describe('the manifest names the real routes', () => {
  it('the cost grid: reading is a product read, writing needs pricing.costs.edit (it needed products.edit)', () => {
    expect(permissionForRoute('GET', '/api/products/costs')).toBe('products.view')
    expect(permissionForRoute('PATCH', '/api/products/costs')).toBe('pricing.costs.edit')
  })
})

describe('master price (PATCH /api/products/:id)', () => {
  it('🔴 without products.price.edit: 403, and neither the price nor the rest of the edit is stored', async () => {
    const l = await seed('perm-master')
    const before = await product('perm-master')
    const res = await app.inject({ method: 'PATCH', url: '/api/products/perm-master', headers: as(OPS), payload: { basePrice: 12, name: 'renamed' } })
    expect(res.statusCode, res.body).toBe(403)
    expect(res.json()).toMatchObject({ code: 'PRICE_PERMISSION' })
    expect(await product('perm-master')).toEqual(before)
    expect(await scoped(() => prisma.product.findUniqueOrThrow({ where: { id: 'perm-master' }, select: { name: true } }))).toEqual({ name: 'perm-master' })
    expect(await queuedPrices(l.id)).toBe(0)
  }, 60_000)

  it('control: with it, the price is written and cascades as before', async () => {
    const l = await seed('perm-master-ok')
    const res = await app.inject({ method: 'PATCH', url: '/api/products/perm-master-ok', headers: as([...OPS, PRICE]), payload: { basePrice: 12 } })
    expect(res.statusCode, res.body).toBe(200)
    expect(Number((await product('perm-master-ok')).basePrice)).toBe(12)
    expect(await queuedPrices(l.id)).toBe(1)
  }, 60_000)

  it('the service refuses before it reads anything (a job or tool that passes the person\'s permissions)', async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched') } })
    await expect(new MasterPriceService(untouchable as never).update('any', 12, { can: () => false })).rejects.toBeInstanceOf(MasterPricePermissionError)
  })
})

describe('listing price (PATCH /api/listings/:id and the bulk bar)', () => {
  it('🔴 a typed listing price without products.price.edit: 403, nothing stored, nothing queued', async () => {
    const l = await seed('perm-listing')
    const before = await listingRow(l.id)
    const res = await app.inject({ method: 'PATCH', url: `/api/listings/${l.id}`, headers: as(OPS), payload: { priceOverride: 14, expectedVersion: before.version } })
    expect(res.statusCode, res.body).toBe(403)
    expect(res.json()).toMatchObject({ code: 'PRICE_PERMISSION' })
    expect(await listingRow(l.id)).toEqual(before)
    expect(await queuedPrices(l.id)).toBe(0)
  }, 60_000)

  it('control: with it, the price goes through the door and is queued', async () => {
    const l = await seed('perm-listing-ok')
    const res = await app.inject({ method: 'PATCH', url: `/api/listings/${l.id}`, headers: as([...OPS, PRICE]), payload: { priceOverride: 14, expectedVersion: (await listingRow(l.id)).version } })
    expect(res.statusCode, res.body).toBe(200)
    expect(Number((await listingRow(l.id)).price)).toBe(14)
    expect(await queuedPrices(l.id)).toBe(1)
  }, 60_000)

  it('a listing edit that carries no price still needs listings.edit only', async () => {
    const l = await seed('perm-listing-buffer')
    const res = await app.inject({ method: 'PATCH', url: `/api/listings/${l.id}`, headers: as(OPS), payload: { stockBuffer: 2, expectedVersion: (await listingRow(l.id)).version } })
    expect(res.statusCode, res.body).toBe(200)
  }, 60_000)

  it('🔴 the bulk bar\'s Set price without products.price.edit: 403 before a job exists; a resync is not a price', async () => {
    const l = await seed('perm-bulk-bar')
    const jobs = () => scoped(() => prisma.bulkActionJob.count({ where: { jobName: { startsWith: 'Listings: set-price' } } }))
    const before = await jobs()
    const res = await app.inject({ method: 'POST', url: '/api/listings/bulk-action', headers: as(OPS), payload: { action: 'set-price', listingIds: [l.id], payload: { price: 15 } } })
    expect(res.statusCode, res.body).toBe(403)
    expect(await jobs()).toBe(before)
    const resync = await app.inject({ method: 'POST', url: '/api/listings/bulk-action', headers: as(OPS), payload: { action: 'resync', listingIds: [l.id] } })
    expect(resync.statusCode, resync.body).not.toBe(403)
  }, 60_000)
})

describe('bulk price jobs (POST /api/bulk-operations)', () => {
  it('🔴 a PRICING_UPDATE without products.price.edit: 403 and no job', async () => {
    await seed('perm-bulk-job')
    const count = () => scoped(() => prisma.bulkActionJob.count({ where: { actionType: 'PRICING_UPDATE' } }))
    const before = await count()
    const payload = { jobName: 'raise', actionType: 'PRICING_UPDATE', actionPayload: { adjustmentType: 'PERCENT', value: 5 }, targetProductIds: ['perm-bulk-job'] }
    const res = await app.inject({ method: 'POST', url: '/api/bulk-operations', headers: as(OPS), payload })
    expect(res.statusCode, res.body).toBe(403)
    expect(await count()).toBe(before)
    const ok = await app.inject({ method: 'POST', url: '/api/bulk-operations', headers: as([...OPS, PRICE]), payload })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await count()).toBe(before + 1)
  }, 60_000)

  it('which jobs are price changes: PRICING_UPDATE, and an override carrying a price or a rule', async () => {
    expect(bulkJobChangesPrices('PRICING_UPDATE', {})).toBe(true)
    expect(bulkJobChangesPrices('MARKETPLACE_OVERRIDE_UPDATE', { priceOverride: 9 })).toBe(true)
    expect(bulkJobChangesPrices('MARKETPLACE_OVERRIDE_UPDATE', { pricingRule: 'FIXED' })).toBe(true)
    expect(bulkJobChangesPrices('MARKETPLACE_OVERRIDE_UPDATE', { stockBuffer: 2 })).toBe(false)
    expect(bulkJobChangesPrices('STATUS_UPDATE', { status: 'ACTIVE' })).toBe(false)
    await expect(new BulkActionService(prisma as never).createJob({ jobName: 'x', actionType: 'PRICING_UPDATE', actionPayload: {}, can: () => false }))
      .rejects.toBeInstanceOf(BulkActionPermissionError)
  })
})

describe('the sheet and grid (applyProductBulkEdits)', () => {
  it('🔴 a price cell without products.price.edit and a cost cell without pricing.costs.edit: refused, nothing stored', async () => {
    await seed('perm-sheet')
    const before = await product('perm-sheet')
    const save = (field: string, value: number, perms: string[]) => scoped(() => applyProductBulkEdits(
      { changes: [{ id: 'perm-sheet', field, value }] } as never,
      { formulaCascade: false, logger: { warn: () => {}, error: () => {} } as never, can: (p) => perms.includes(p) },
    ))
    await expect(save('basePrice', 13, OPS)).rejects.toMatchObject({ statusCode: 403, details: { code: 'PRICE_PERMISSION' } })
    await expect(save('minPrice', 2, OPS)).rejects.toMatchObject({ statusCode: 403, details: { code: 'PRICE_PERMISSION' } })
    await expect(save('costPrice', 5, [...OPS, PRICE])).rejects.toMatchObject({ statusCode: 403, details: { code: 'COST_PERMISSION' } })
    expect(await product('perm-sheet')).toEqual(before)
    // Control: the Owner's set writes all three.
    await save('costPrice', 5, [...OPS, PRICE, 'pricing.costs.edit'])
    expect(Number((await product('perm-sheet')).costPrice)).toBe(5)
  }, 60_000)

  it('names the fields: prices need the price permission, the cost the cost permission, the rest neither', () => {
    const none = () => false
    expect(bulkEditPermissionRefusal([{ field: 'ebay_price' }], none)?.code).toBe('PRICE_PERMISSION')
    expect(bulkEditPermissionRefusal([{ field: 'maxPrice' }], none)?.code).toBe('PRICE_PERMISSION')
    expect(bulkEditPermissionRefusal([{ field: 'costPrice' }], none)?.code).toBe('COST_PERMISSION')
    expect(bulkEditPermissionRefusal([{ field: 'name' }, { field: 'totalStock' }], none)).toBeNull()
  })
})

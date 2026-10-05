/**
 * S9 (per-channel SKU) — no product create may take a SKU another product's listing holds or sends as its channel SKU
 * in this business (its own SKU, a SKU kept on a listing after a SHARED rename, the SKU the channel confirmed, an old
 * store), case ignored: one SKU names one product. Through every create door, as the Owner and Claude reach them:
 * POST /api/products (the sheet's New product), POST /api/products/create-wizard (and Claude's create-product, the same
 * `assertCreatable`), POST /api/catalog/products, /products/bulk, /products/:parentId/children and
 * /products/:parentId/bulk-variants, POST /api/inventory/bulk-upload and a development project's launch. Real routes in
 * Fastify, real PostgreSQL with the production schema and policies (PGlite). Another business's channel SKU is legal.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

vi.setConfig({ testTimeout: 60_000 })
let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: { connection: null },
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn(async () => []) } }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncForProduct: vi.fn(), enqueueContentSyncIfEnabled: vi.fn() }))
vi.mock('../services/amazon/flat-file.service.js', () => ({ AmazonFlatFileService: class {}, MARKETPLACE_ID_MAP: {}, flatFileExportColumns: vi.fn(), filterHiddenManifestColumns: vi.fn(), normalizeVariationTheme: vi.fn() }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/sync/etsy-sync.service.js', () => ({ EstySyncService: class {} }))
vi.mock('../utils/config.js', () => ({ ConfigManager: { getConfig: () => null } }))

import productsRoutes from './products.routes.js'
import productCreateRoutes from './product-create.routes.js'
import { catalogRoutes } from './catalog.routes.js'
import { inventoryRoutes } from './inventory.js'
import fulfillmentRoutes from './fulfillment.routes.js'
import { assertCreatable, CreateProductError } from '../services/products/create-product.service.js'

const B = 'ws_s9_create_bravo'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inside = as(LEGACY_WORKSPACE_ID)
let app: FastifyInstance
const ids: Record<string, string> = {}
const HELD = 'kept-1 is the SKU of HOLDER-NEW on Amazon · DE. One SKU names one product: choose another SKU.'

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Bravo', 'active', 's9', $1, CURRENT_TIMESTAMP)`, [B])
  const db = database.client
  await inside(async () => {
    const account = await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 's9-create', externalAccountId: 's9-create', isActive: true, isPrimary: true } as never })
    // HOLDER was renamed: its Amazon DE listing keeps KEPT-1 (the channel holds it), its eBay listing sends its own SKU.
    const holder = await db.product.create({ data: { sku: 'HOLDER-NEW', name: 'Holder', basePrice: '10.00' } })
    await db.channelListing.create({ data: { productId: holder.id, channel: 'AMAZON', marketplace: 'DE', region: 'DE', channelMarket: 'AMAZON_DE', channelConnectionId: account.id,
      aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0HOLDER', channelSku: 'KEPT-1', liveChannelSku: 'KEPT-1' } as never })
    ids.parent = (await db.product.create({ data: { sku: 'S9-PARENT', name: 'Parent', basePrice: '10.00', isParent: true, variationAxes: ['Colore'] } as never })).id
    ids.project = (await db.developmentProject.create({ data: { code: 'PD-S9-1', name: 'Launch me' } as never })).id
  })
  // Another business holds CROSS-1 as a channel SKU: legal here.
  await as(B)(async () => {
    const other = await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 's9-b', externalAccountId: 's9-b', isActive: true, isPrimary: true } as never })
    const p = await db.product.create({ data: { sku: 'B-PRODUCT', name: 'Bravo', basePrice: '1.00' } })
    await db.channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: 'DE', region: 'DE', channelMarket: 'AMAZON_DE', channelConnectionId: other.id,
      aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0B', channelSku: 'CROSS-1' } as never })
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => done()))
  await app.register(productsRoutes, { prefix: '/api' })
  await app.register(productCreateRoutes, { prefix: '/api' })
  await app.register(catalogRoutes, { prefix: '/api/catalog' })
  await app.register(inventoryRoutes, { prefix: '/api' })
  await app.register(fulfillmentRoutes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const count = (sku: string) => inside(() => database.client.product.count({ where: { sku: { equals: sku, mode: 'insensitive' } } }))
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never })

describe('S9 — a new product never takes a SKU another product\'s listing holds or sends', () => {
  it('POST /api/products (the sheet\'s New product): 409 on the SKU field, nothing created', async () => {
    const response = await post('/api/products', { sku: 'kept-1', name: 'New jacket', kind: 'single' })
    expect(response.statusCode, response.body).toBe(409)
    expect(JSON.stringify(response.json())).toContain(HELD)
    expect(await count('kept-1')).toBe(0)
  })

  it('POST /api/products/create-wizard and Claude\'s create-product (the same check): 409 for the master or a variation', async () => {
    for (const body of [{ sku: 'kept-1', name: 'New jacket', basePrice: 10 }, { sku: 'S9-WIZ', name: 'New jacket', basePrice: 10, variations: [{ sku: 'kept-1' }] }]) {
      const response = await post('/api/products/create-wizard', body)
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json()).toMatchObject({ code: 'DUPLICATE_SKU', error: HELD })
    }
    await expect(inside(() => assertCreatable({ sku: 'kept-1', name: 'Claude jacket', basePrice: 10 }))).rejects.toMatchObject({ statusCode: 409, message: HELD })
    await expect(inside(() => assertCreatable({ sku: 'kept-1', name: 'Claude jacket', basePrice: 10 }))).rejects.toBeInstanceOf(CreateProductError)
    expect(await count('S9-WIZ')).toBe(0)
  })

  it('POST /api/catalog/products, /products/bulk, /products/:parentId/children and /bulk-variants: 409 with the sentence', async () => {
    const single = await post('/api/catalog/products', { sku: 'kept-1', name: 'New jacket', basePrice: 10, productType: 'JACKET' })
    expect(single.statusCode, single.body).toBe(409)
    expect(single.json()).toMatchObject({ error: { code: 'SKU_ALREADY_EXISTS', message: HELD } })
    const bulk = await post('/api/catalog/products/bulk', { master: { sku: 'S9-BULK', name: 'Bulk', basePrice: 10, productType: 'JACKET' }, children: [{ sku: 'kept-1', name: 'Child', price: 10, quantity: 0, attributes: {} }], channelListings: [] })
    expect(bulk.statusCode, bulk.body).toBe(409)
    expect(bulk.json()).toMatchObject({ error: { code: 'SKU_ALREADY_EXISTS', message: HELD } })
    const child = await post(`/api/catalog/products/${ids.parent}/children`, { sku: 'kept-1', name: 'Child', basePrice: 10, totalStock: 0 })
    expect(child.statusCode, child.body).toBe(409)
    expect(child.json()).toMatchObject({ error: { code: 'DUPLICATE_SKU', message: HELD } })
    const variations = await post(`/api/catalog/products/${ids.parent}/bulk-variants`, { variations: [{ sku: 'kept-1', name: 'Var', optionValues: { Colore: 'Nero' } }], globalPrice: 10, globalStock: 0 })
    expect(variations.statusCode, variations.body).toBe(409)
    expect(variations.json()).toMatchObject({ error: { code: 'SKU_ALREADY_EXISTS', message: HELD } })
    expect([await count('kept-1'), await count('S9-BULK')]).toEqual([0, 0])
  })

  it('POST /api/inventory/bulk-upload: the row fails with the sentence, the others are created', async () => {
    const response = await post('/api/inventory/bulk-upload', { items: [{ sku: 'kept-1', name: 'Held', basePrice: 10 }, { sku: 'S9-UPLOAD-FREE', name: 'Free', basePrice: 10 }] })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ failed: 1, results: expect.arrayContaining([{ sku: 'kept-1', status: 'failed', message: HELD }]) })
    expect([await count('kept-1'), await count('S9-UPLOAD-FREE')]).toEqual([0, 1])
  })

  it('a development project\'s launch: 409 with the sentence, the project stays unlaunched', async () => {
    const response = await post(`/api/fulfillment/development/projects/${ids.project}/launch`, { sku: 'kept-1', basePrice: 10 })
    expect(response.statusCode, response.body).toBe(409)
    // The launch upper-cases the SKU it is given.
    expect(response.json()).toEqual({ error: HELD.replace('kept-1', 'KEPT-1') })
    expect(await count('kept-1')).toBe(0)
  })

  it('control: a free SKU, and a SKU only another business holds as a channel SKU, are created', async () => {
    const free = await post('/api/products', { sku: 'S9-FREE-1', name: 'Free jacket', kind: 'single' })
    expect(free.statusCode, free.body).toBeLessThan(300)
    const cross = await post('/api/catalog/products', { sku: 'CROSS-1', name: 'Cross jacket', basePrice: 10, productType: 'JACKET' })
    expect(cross.statusCode, cross.body).toBeLessThan(300)
    expect([await count('S9-FREE-1'), await count('CROSS-1')]).toEqual([1, 1])
  })
})

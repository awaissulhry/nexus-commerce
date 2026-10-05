/**
 * MCP full control I4 / G4 — the two product create routes refuse a SKU an extra listing already uses as its own
 * (ProductListingAlias.sku): POST /api/products/create-wizard and POST /api/catalog/products. Real routes in Fastify,
 * real PostgreSQL with the production schema and policies (PGlite); the listing-SKU column is added here as the eBay
 * import by SKU's migration adds it.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

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
import { catalogRoutes } from './catalog.routes.js'

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`ALTER TABLE "ProductListingAlias" ADD COLUMN IF NOT EXISTS "sku" TEXT`)
  await inside(async () => {
    const root = await database.client.product.create({ data: { sku: 'G4-ROOT', name: 'Root jacket', basePrice: '10.00' } })
    const alias = await database.client.productListingAlias.create({ data: { productId: root.id, channel: 'EBAY', marketplace: 'IT', label: 'second listing', position: 2 } })
    await database.db.query(`UPDATE "ProductListingAlias" SET sku = 'G4-LISTING-SKU' WHERE id = $1`, [alias.id])
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => done()))
  await app.register(productsRoutes, { prefix: '/api' })
  await app.register(catalogRoutes, { prefix: '/api/catalog' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const productCount = (sku: string) => inside(() => database.client.product.count({ where: { sku } }))

describe('I4 / G4 — a new product may not take an extra listing\'s SKU', () => {
  it('POST /api/products/create-wizard: 409, naming the listing (any case), for the master or a variation; nothing created', async () => {
    for (const body of [
      { sku: 'g4-listing-sku', name: 'New jacket', basePrice: 10 },
      { sku: 'G4-NEW-MASTER', name: 'New jacket', basePrice: 10, variations: [{ sku: 'G4-LISTING-SKU' }] },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/products/create-wizard', payload: body })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'DUPLICATE_SKU', error: expect.stringContaining('already the SKU of an extra listing ("second listing" of G4-ROOT)') })
    }
    expect(await productCount('g4-listing-sku')).toBe(0)
    expect(await productCount('G4-NEW-MASTER')).toBe(0)
  })

  it('POST /api/catalog/products: 409, naming the listing; nothing created', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/catalog/products', payload: { sku: 'G4-LISTING-SKU', name: 'New jacket', basePrice: 10, productType: 'JACKET' } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ success: false, error: { code: 'SKU_ALREADY_EXISTS', message: expect.stringContaining('already the SKU of an extra listing') } })
    expect(await productCount('G4-LISTING-SKU')).toBe(0)
  })

  it('control: a SKU no extra listing uses is not refused by the guard', async () => {
    const wizard = await app.inject({ method: 'POST', url: '/api/products/create-wizard', payload: { sku: 'G4-FREE-1', name: 'Free jacket', basePrice: 10 } })
    expect(wizard.statusCode, wizard.body).not.toBe(409)
    expect(await productCount('G4-FREE-1')).toBe(1)
    const catalog = await app.inject({ method: 'POST', url: '/api/catalog/products', payload: { sku: 'G4-FREE-2', name: 'Free jacket', basePrice: 10, productType: 'JACKET' } })
    expect(catalog.statusCode, catalog.body).not.toBe(409)
    expect(await productCount('G4-FREE-2')).toBe(1)
  })
})

/**
 * Step 2.6b (A-27, R-23) — four writers replaced the whole `categoryAttributes` bag and so deleted
 * `categoryAttributes.variations`, the one store for a variant's size and colour (organize publish also
 * deleted every other attribute). Each is exercised here, on real PostgreSQL, through its own entry point.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  // R-VT-12 has verified this URL. The helper creates its own database, never uses the catalogue.
  process.env.NEXUS_TEST_CONCURRENT_PG_URL = process.env.DATABASE_URL
  const { concurrentDatabase } = await import('../../test-support/concurrent-database.js')
  state.db = await concurrentDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() } }))
// The eBay import's outside calls: one account, one page of inventory items.
const ebayItems = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock('../connection-resolver.service.js', () => ({ tryResolveConnection: vi.fn(async () => ({ id: 'ebay-account', displayName: 'eBay' })) }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'token') } }))
vi.mock('../gateway/ebay.js', () => ({ ebaySend: vi.fn(async () => new Response(JSON.stringify({ inventoryItems: ebayItems.items, total: ebayItems.items.length }))) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { importEbayCatalog } from '../ebay-import.service.js'
import { enrichProductFromAmazon } from '../listing-reconciliation.service.js'
import catalogOrganizeRoutes from '../../routes/catalog-organize.routes.js'
import { catalogRoutes } from '../../routes/catalog.routes.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
/** A route app that gives each request its business the way production's `workspaceHook` does
 * (`lib/workspace-hook.ts`: a preHandler that runs the handler inside `withWorkspace(…, done)`). */
const routeApp = async (plugin: Parameters<ReturnType<typeof Fastify>['register']>[0]) => {
  const app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(BUSINESS, done))
  await app.register(plugin, { prefix: '/api/catalog' })
  return app
}
const STORE = { Size: 'L', Color: 'Nero' }
const seed = (id: string, extra: Record<string, unknown> = {}) => scoped(() => prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10,
  categoryAttributes: { material: 'Mesh', variations: STORE, ...extra } } }))
const bag = (id: string) => scoped(async () => (await prisma.product.findUniqueOrThrow({ where: { id } })).categoryAttributes as Record<string, unknown>)

beforeAll(() => scoped(async () => {
  await prisma.product.create({ data: { id: 'organize-parent', sku: 'organize-parent', name: 'p', basePrice: 10, isParent: true } })
}))

describe('each writer keeps the store', () => {
  it('eBay Inventory import (update path): sets its aspects, keeps variations and every other attribute', async () => {
    await seed('ebay-imported')
    ebayItems.items = [{ sku: 'ebay-imported', product: { title: 'T', aspects: { Colore: ['Blu'], Taglia: ['M'], Materiale: ['Nylon'] } } }]
    const result = await scoped(() => importEbayCatalog())
    expect(result).toMatchObject({ updated: 1 })
    expect(await bag('ebay-imported')).toEqual({ material: 'Nylon', color: 'Blu', apparel_size: 'M', variations: STORE })
  })

  it('Amazon reconciliation enrich: stores Amazon\'s raw attributes, keeps variations and every other attribute', async () => {
    await seed('amazon-enriched', { armorType: 'CE' })
    const amazonService = { fetchProductDetails: vi.fn(async () => ({ bulletPoints: [], keywords: [], images: [],
      rawAttributes: { color: [{ value: 'Nero', language_tag: 'it_IT' }] } })) }
    await scoped(() => enrichProductFromAmazon('amazon-enriched', 'APJ6JRA9NG5V4', amazonService as never,
      new Map([['amazon-enriched', { productId: 'amazon-enriched', variationId: null, isVariation: false }]]), new Map()))
    expect(await bag('amazon-enriched')).toEqual({ material: 'Mesh', armorType: 'CE', color: [{ value: 'Nero', language_tag: 'it_IT' }], variations: STORE })
  })

  it('organize publish: sets the child\'s axis values, keeps every other attribute', async () => {
    await seed('organized')
    const app = await routeApp(catalogOrganizeRoutes)
    const res = await app.inject({ method: 'POST', url: '/api/catalog/organize/publish',
      payload: { changes: [{ productId: 'organized', toParentId: 'organize-parent', attributes: { Taglia: 'S' } }] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await bag('organized')).toEqual({ material: 'Mesh', variations: { Taglia: 'S' } })
  })

  it('PATCH /api/catalog/products/:id: the client\'s bag replaces the rest, but not the store it did not send', async () => {
    await seed('patched', { armorType: 'CE' })
    const app = await routeApp(catalogRoutes)
    const res = await app.inject({ method: 'PATCH', url: '/api/catalog/products/patched', payload: { categoryAttributes: { material: 'Leather' } } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await bag('patched')).toEqual({ material: 'Leather', variations: STORE })
  })

  it('control — PATCH that sends variations itself writes them', async () => {
    await seed('patched-with-store')
    const app = await routeApp(catalogRoutes)
    const res = await app.inject({ method: 'PATCH', url: '/api/catalog/products/patched-with-store', payload: { categoryAttributes: { variations: { Size: 'XL' } } } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await bag('patched-with-store')).toEqual({ variations: { Size: 'XL' } })
  })
})

/**
 * MCP full control L7 — POST /api/products/create-wizard, held exactly as it answers: every refusal (status, body), the
 * created family (every column the wizard writes) and its 201 body. Its transaction moved into
 * services/products/create-product.service.ts; this file ran green on the route before the move and runs green after it,
 * which is the proof the route did not change.
 *
 * The real route in a Fastify app on a real PostgreSQL (PGlite) with the production schema and business-isolation
 * policies. Every SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.database = await formulaDatabase()
  return { ...(await original<object>()), default: state.database.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import productsRoutes from './products.routes.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance
type Json = Record<string, any>

const post = async (payload: Json) => {
  const response = await app.inject({ method: 'POST', url: '/api/products/create-wizard', payload })
  return { status: response.statusCode, body: response.json() as Json }
}

beforeAll(async () => {
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  await app.register(productsRoutes, { prefix: '/api' })
  await app.ready()
  await inside(() => state.database.client.product.create({ data: { sku: 'TEST-WIZ-TAKEN', name: 'Taken', basePrice: 1 } }))
}, 120_000)

afterAll(async () => {
  await app?.close()
  await state.database?.close()
}, 30_000)

describe('POST /api/products/create-wizard', () => {
  it.each([
    [{ name: 'No SKU', basePrice: 1 }, 400, { error: 'sku is required', code: 'INVALID_REQUEST' }],
    [{ sku: ' ', name: 'Blank SKU', basePrice: 1 }, 400, { error: 'sku is required', code: 'INVALID_REQUEST' }],
    [{ sku: 'TEST-WIZ-1', basePrice: 1 }, 400, { error: 'name is required', code: 'INVALID_REQUEST' }],
    [{ sku: 'TEST-WIZ-1', name: 'Price', basePrice: -1 }, 400, { error: 'basePrice must be a non-negative number', code: 'INVALID_REQUEST' }],
    [{ sku: 'TEST-WIZ-1', name: 'Price', basePrice: '10' }, 400, { error: 'basePrice must be a non-negative number', code: 'INVALID_REQUEST' }],
    [{ sku: 'TEST-WIZ-1', name: 'Var', basePrice: 1, variations: [{ sku: ' ' }] }, 400, { error: 'every variation must have a non-empty sku', code: 'INVALID_REQUEST' }],
    [{ sku: 'TEST-WIZ-1', name: 'Dup', basePrice: 1, variations: [{ sku: 'TEST-WIZ-1' }] }, 400, { error: 'duplicate SKUs in this request — master and variations must be unique', code: 'DUPLICATE_SKU' }],
    [{ sku: 'TEST-WIZ-1', name: 'Taken', basePrice: 1, variations: [{ sku: 'TEST-WIZ-TAKEN' }] }, 409, { error: 'SKU "TEST-WIZ-TAKEN" already exists', code: 'DUPLICATE_SKU' }],
  ] as Array<[Json, number, Json]>)('refuses %o with %i', async (payload, status, body) => {
    expect(await post(payload)).toEqual({ status, body })
  })

  it('creates a single product with the fields given, and answers 201', async () => {
    const out = await post({ sku: ' TEST-WIZ-SINGLE ', name: ' Single ', basePrice: 12.5, brand: 'Test brand', productType: 'OUTERWEAR', description: 'Text',
      costPrice: 4, totalStock: 3, lowStockThreshold: 2, ean: '0000000000000', weightValue: 1.5, weightUnit: 'kg', dimLength: 10, dimWidth: 20, dimHeight: 30, dimUnit: 'cm',
      manufacturer: 'Maker', categoryAttributes: { material: 'Leather' } })
    expect(out.status).toBe(201)
    expect(out.body).toEqual({ success: true, product: { id: expect.any(String), sku: 'TEST-WIZ-SINGLE', name: 'Single', isParent: false }, variationCount: 0 })
    const row = await inside(() => state.database.client.product.findUniqueOrThrow({ where: { id: out.body.product.id } }))
    expect(row).toMatchObject({ sku: 'TEST-WIZ-SINGLE', name: 'Single', isParent: false, status: 'ACTIVE', syncChannels: [], validationStatus: 'VALID', validationErrors: [],
      hasChannelOverrides: false, brand: 'Test brand', productType: 'OUTERWEAR', description: 'Text', totalStock: 3, lowStockThreshold: 2, ean: '0000000000000',
      weightUnit: 'kg', dimUnit: 'cm', manufacturer: 'Maker', categoryAttributes: { material: 'Leather' } })
    expect([Number(row.basePrice), Number(row.costPrice), Number(row.weightValue), Number(row.dimLength), Number(row.dimWidth), Number(row.dimHeight)]).toEqual([12.5, 4, 1.5, 10, 20, 30])
  })

  it('creates a family: the parent and each variation in one transaction', async () => {
    const out = await post({ sku: 'TEST-WIZ-FAM', name: 'Family', basePrice: 20, variations: [
      { sku: 'TEST-WIZ-FAM-M', variationAttributes: { Size: 'M' }, price: 22, stock: 4 },
      { sku: 'TEST-WIZ-FAM-L', name: 'Large one', variationAttributes: { Size: 'L' } },
    ] })
    expect(out).toEqual({ status: 201, body: { success: true, product: { id: expect.any(String), sku: 'TEST-WIZ-FAM', name: 'Family', isParent: true }, variationCount: 2 } })
    const children = await inside(() => state.database.client.product.findMany({ where: { parentId: out.body.product.id }, orderBy: { sku: 'asc' } }))
    expect(children.map((c: Json) => ({ sku: c.sku, name: c.name, price: Number(c.basePrice), stock: c.totalStock, isParent: c.isParent, isMasterProduct: c.isMasterProduct,
      status: c.status, categoryAttributes: c.categoryAttributes }))).toEqual([
      { sku: 'TEST-WIZ-FAM-L', name: 'Large one', price: 20, stock: 0, isParent: false, isMasterProduct: false, status: 'ACTIVE', categoryAttributes: { variations: { Size: 'L' } } },
      { sku: 'TEST-WIZ-FAM-M', name: 'Family — TEST-WIZ-FAM-M', price: 22, stock: 4, isParent: false, isMasterProduct: false, status: 'ACTIVE', categoryAttributes: { variations: { Size: 'M' } } },
    ])
  })
})

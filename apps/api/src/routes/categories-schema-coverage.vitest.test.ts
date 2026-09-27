import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * Attribute parity P3 — the sheet's coverage read and "Download rules" action, through the real route and the real
 * service on an in-process PostgreSQL (PGlite) with the real row policy. Only the provider (`CategorySchemaService`)
 * and the sheet's in-memory column caches are stubbed — no network.
 */
const state = vi.hoisted(() => ({ db: null as any }))
const mocks = vi.hoisted(() => ({ getSchema: vi.fn(), refreshSchema: vi.fn(), clearSheet: vi.fn(), clearStudio: vi.fn() }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured() { return true } } }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class { getSchema = mocks.getSchema; refreshSchema = mocks.refreshSchema } }))
vi.mock('../services/listing-wizard/product-types.service.js', () => ({ ProductTypesService: class {} }))
vi.mock('../services/pim/sheet-columns.service.js', () => ({ clearSheetColumnCache: mocks.clearSheet }))
vi.mock('../services/pim/studio-columns.js', () => ({ clearStudioColumnCache: mocks.clearStudio }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import categoriesRoutes from './categories.routes.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { FEATURES } from '@nexus/shared/permissions'

const legacy = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] as string[] }
const HOUR = 3_600_000

beforeAll(() => withWorkspace(legacy, async () => {
  for (const [code, isActive] of [['BE', true], ['US', false]] as const) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency: 'EUR', language: 'en', isActive } })
  }
  const jacket = await prisma.product.create({ data: { sku: 'P3R-1', name: 'Jacket', basePrice: 10, productType: 'OUTERWEAR' } })
  await prisma.channelListing.create({ data: { productId: jacket.id, channel: 'AMAZON', marketplace: 'BE', channelMarket: 'AMAZON_BE', region: 'EU', platformAttributes: { productType: 'COAT' } } })
  await prisma.product.create({ data: { sku: 'P3R-2', name: 'Trousers', basePrice: 10, productType: 'PANTS' } })
  const gloves = await prisma.category.create({ data: { slug: 'gloves' } })
  await prisma.categoryChannelMapping.create({ data: { categoryId: gloves.id, channel: 'AMAZON', marketplace: 'BE', channelCategoryId: 'GLOVES' } })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'BE', productType: 'OUTERWEAR', schemaVersion: 'v1', schemaDefinition: {}, expiresAt: new Date(Date.now() + 12 * HOUR) } })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'BE', productType: 'PANTS', schemaVersion: 'v1', schemaDefinition: {}, expiresAt: new Date(Date.now() - HOUR) } })
}), 60_000)
afterAll(async () => { await state.db?.close() })

let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.getSchema.mockResolvedValue({})
  app = Fastify()
  // As the workspace hook does for a signed-in request.
  app.addHook('onRequest', (_request, _reply, done) => withWorkspace(legacy, done))
  await app.register(categoriesRoutes)
})
afterEach(async () => { await app.close() })

describe('GET /categories/schema/coverage', () => {
  it('returns the in-use pairs with status and stamps for one channel and market, without a provider call', async () => {
    const res = await app.inject('/categories/schema/coverage?channel=amazon&market=be')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ channel: 'AMAZON', market: 'BE', counts: { cached: 1, stale: 1, missing: 2 } })
    expect(body.pairs).toEqual([
      { marketplace: 'BE', productType: 'COAT', status: 'missing', fetchedAt: null, expiresAt: null },
      { marketplace: 'BE', productType: 'GLOVES', status: 'missing', fetchedAt: null, expiresAt: null },
      { marketplace: 'BE', productType: 'OUTERWEAR', status: 'cached', fetchedAt: expect.any(String), expiresAt: expect.any(String) },
      { marketplace: 'BE', productType: 'PANTS', status: 'stale', fetchedAt: expect.any(String), expiresAt: expect.any(String) },
    ])
    expect(mocks.getSchema).not.toHaveBeenCalled(); expect(mocks.refreshSchema).not.toHaveBeenCalled()
  })

  it('market is optional; an unsupported channel is refused', async () => {
    const all = (await app.inject('/categories/schema/coverage?channel=AMAZON')).json()
    expect(all.market).toBeNull()
    expect(all.pairs.every((p: { marketplace: string }) => p.marketplace === 'BE')).toBe(true) // US is inactive
    const res = await app.inject('/categories/schema/coverage?channel=SHOPIFY')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'unsupported channel: SHOPIFY' })
  })
})

describe('POST /categories/schema/download', () => {
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/categories/schema/download', payload: payload as object })

  it('fetches only the MISSING in-use pairs, one at a time, reports each, and clears the sheet column caches', async () => {
    mocks.getSchema.mockImplementation(async (q: { productType: string }) => { if (q.productType === 'GLOVES') throw new Error('Access to requested resource is denied'); return {} })
    const res = await post({ channel: 'AMAZON', market: 'be' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      channel: 'AMAZON', market: 'BE', remaining: 0,
      results: [
        { productType: 'COAT', outcome: 'added' },
        { productType: 'GLOVES', outcome: 'failed', error: 'Access to requested resource is denied' },
        { productType: 'OUTERWEAR', outcome: 'already' },
        { productType: 'PANTS', outcome: 'already' },
      ],
    })
    expect(mocks.getSchema.mock.calls.map(c => c[0])).toEqual([
      { channel: 'AMAZON', marketplace: 'BE', productType: 'COAT' }, { channel: 'AMAZON', marketplace: 'BE', productType: 'GLOVES' },
    ])
    expect(mocks.getSchema.mock.calls.every(c => c.length === 1)).toBe(true) // the caching read, never forced
    expect(mocks.refreshSchema).not.toHaveBeenCalled()
    expect(mocks.clearSheet).toHaveBeenCalledTimes(1); expect(mocks.clearStudio).toHaveBeenCalledTimes(1)
  })

  it('a listed type that is in use is handled alone; nothing added leaves the caches alone', async () => {
    const res = await post({ channel: 'AMAZON', market: 'BE', productTypes: ['outerwear'] })
    expect(res.json().results).toEqual([{ productType: 'OUTERWEAR', outcome: 'already' }])
    expect(mocks.getSchema).not.toHaveBeenCalled(); expect(mocks.clearSheet).not.toHaveBeenCalled()
  })

  it('🔴 refuses a product type that is not in use in that market — nothing is fetched', async () => {
    const res = await post({ channel: 'AMAZON', market: 'BE', productTypes: ['COAT', 'HELMET', 'EBAY_LISTING_SHELL'] })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Only rule sets in use in this market can be downloaded', notInUse: ['HELMET', 'EBAY_LISTING_SHELL'] })
    expect(mocks.getSchema).not.toHaveBeenCalled()
  })

  it('🔴 refuses an unsupported channel, a missing or inactive market, and a malformed list', async () => {
    const cases: Array<[unknown, string]> = [
      [{ channel: 'SHOPIFY', market: 'GLOBAL' }, 'unsupported channel: SHOPIFY'],
      [{ market: 'BE' }, 'unsupported channel: '],
      [{ channel: 'AMAZON' }, 'market is required'],
      [{ channel: 'AMAZON', market: 'BE', productTypes: 'COAT' }, 'productTypes must be a non-empty list of up to 200 category ids'],
      [{ channel: 'AMAZON', market: 'BE', productTypes: ['COAT; DROP'] }, 'productTypes must be a non-empty list of up to 200 category ids'],
      [{ channel: 'AMAZON', market: 'US' }, 'Unknown or inactive marketplace'],
    ]
    for (const [body, error] of cases) {
      const res = await post(body)
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(error)
    }
    expect(mocks.getSchema).not.toHaveBeenCalled()
  })
})

it('both routes sit under the category rule of the permission manifest: read = GET, write = POST', () => {
  // Downloading channel rules is PIM management — the same permission as the forced `/categories/schema?force=1`.
  expect(permissionForRoute('GET', '/api/categories/schema/coverage')).toBe(FEATURES.pimManage)
  expect(permissionForRoute('POST', '/api/categories/schema/download')).toBe(FEATURES.pimManage)
})

/**
 * F2 — the three route callers that picked an Amazon product type as `listing type || Product.productType` now use the
 * ONE rule (#82, `resolveCategoriesForProducts` + `categoryForListing`): this market's listing, else the product's own
 * listings in the region's other markets, else the category mapping, else `Product.productType`.
 *
 * Measured before: a jacket COAT in DE and IT but OUTERWEAR on the product got OUTERWEAR for a first listing in BE made
 * through the product-page schema, the direct publish or its preflight, and a type-less product listed COAT elsewhere
 * showed "blocked" in the grid's listing health. On an in-process PostgreSQL (PGlite) with the REAL resolver and sibling
 * query; only outbound calls and unrelated services are stood in. Every id below is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/routes/amazon-product-type-callers.vitest.test.ts
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  db: null as any,
  requiredFields: vi.fn(),
  aspects: vi.fn(),
  put: vi.fn(),
}))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  s.db = await formulaDatabase()
  return { default: s.db.client }
})
// Outbound calls and services these routes merely construct.
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured = async () => true } }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/listing-wizard/product-types.service.js', () => ({ ProductTypesService: class {} }))
vi.mock('../services/listing-wizard/schema-parser.service.js', () => ({ SchemaParserService: class { getMultiChannelRequiredFields = s.requiredFields } }))
vi.mock('../services/listing-wizard/telemetry.service.js', () => ({ WIZARD_EVENT_TYPES: [], writeStepTransition: vi.fn(), writeWizardEvent: vi.fn() }))
vi.mock('../services/ebay-category.service.js', () => ({ EbayCategoryService: class { getCategoryAspectsRich = s.aspects; getItemConditionPolicies = async () => [] } }))
vi.mock('../services/listing-wizard/channel-publish.service.js', () => ({ ChannelPublishService: class {} }))
vi.mock('../services/listing-images/image-resolution.service.js', () => ({ ImageResolutionService: class {} }))
vi.mock('../services/ai/listing-content.service.js', () => ({ ListingContentService: class {}, BudgetExceededError: class extends Error {} }))
vi.mock('../services/ai/budget.service.js', () => ({ readBudgetLimits: vi.fn() }))
vi.mock('../services/ai/usage-logger.service.js', () => ({ logUsage: vi.fn() }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../services/listing-push-controls.js', () => ({ readPushControls: async () => [{}] }))
vi.mock('../services/listing-activation-sync.service.js', () => ({ syncActivatedListings: vi.fn() }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn(), redis: { connection: null } }))
vi.mock('../services/pim/publish-review-gate.js', () => ({ resolvePublishContent: async () => [], publishContentIssues: () => [], requireReviewedContent: () => false }))
vi.mock('../services/pim/amazon-content-payload.js', () => ({ buildAmazonContentAttributes: async () => ({}) }))
vi.mock('../services/categories/marketplace-ids.js', async importOriginal => ({ ...await importOriginal<object>(), configuredAmazonMarketplaceId: async () => 'FAKE_MARKETPLACE_ID' }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'FAKE-SELLER' }))
vi.mock('../services/amazon/validate-before-send.js', () => ({ amazonContentRefusal: async () => null }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { putListingsItem: s.put } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import listingWizardRoutes from './listing-wizard.routes.js'
import marketplacesRoutes from './marketplaces.routes.js'
import productChannelDataRoutes from './product-channel-data.routes.js'

// Production runs with business profiles on: seeding and every request run inside a business.
const legacy = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(legacy, work)
const ids: Record<string, string> = {}
let app: FastifyInstance

async function product(key: string, productType: string | null) {
  ids[key] = (await prisma.product.create({ data: { sku: `F2-${key}`, name: key, basePrice: 10, productType } })).id
}
async function listing(key: string, marketplace: string, platformAttributes: Record<string, unknown>, channel = 'AMAZON') {
  await prisma.channelListing.create({ data: { productId: ids[key], channel, marketplace, channelMarket: `${channel}_${marketplace}`,
    region: 'EU', title: key, price: 10, platformAttributes: platformAttributes as never } })
}

beforeAll(async () => {
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(legacy, done) })
  await app.register(listingWizardRoutes, { prefix: '/api' })
  await app.register(marketplacesRoutes, { prefix: '/api' })
  await app.register(productChannelDataRoutes, { prefix: '/api' })
  await app.ready()
  await scoped(async () => {
    // GALE-like: COAT in DE and IT, OUTERWEAR on the product, not listed in BE.
    await product('jacket', 'OUTERWEAR')
    await listing('jacket', 'IT', { productType: 'COAT' })
    await listing('jacket', 'DE', { productType: 'COAT' })
    await listing('jacket', 'IT', { productType: '90001' }, 'EBAY') // eBay keeps its category id in the same key
    // A listing in THIS market (BE) names its own type; a sibling market says another.
    await product('pinned', 'OUTERWEAR')
    await listing('pinned', 'BE', { productType: 'PANTS' })
    await listing('pinned', 'DE', { productType: 'COAT' })
    // No type on the product: only the sibling listings carry one. Its BE listing names none.
    await product('typeless', null)
    await listing('typeless', 'IT', { productType: 'COAT' })
    await listing('typeless', 'DE', { productType: 'COAT' })
    await listing('typeless', 'BE', {})
    await listing('typeless', 'IT', {}, 'EBAY')
    // Nothing anywhere: no type resolves.
    await product('bare', null)
    await listing('bare', 'BE', {})
  })
}, 120_000)
afterAll(async () => { await app?.close(); await s.db?.close() }, 30_000)
beforeEach(() => {
  vi.clearAllMocks()
  s.requiredFields.mockResolvedValue({ fields: [] })
  s.aspects.mockResolvedValue([])
  s.put.mockResolvedValue({ success: true, dryRun: true, status: 'ACCEPTED' })
})

const schema = (key: string, channel: string, marketplace: string) => app.inject({ method: 'GET', url: `/api/products/${ids[key]}/listings/${channel}/${marketplace}/schema` })
const schemaType = () => Object.values(s.requiredFields.mock.calls[0][0].productTypeByChannel)[0]

describe('product-page schema (GET /products/:id/listings/:channel/:marketplace/schema)', () => {
  it('Amazon BE, unlisted there, COAT in DE and IT → COAT (was OUTERWEAR)', async () => {
    const response = await schema('jacket', 'AMAZON', 'BE')
    expect(response.statusCode, response.body).toBe(200)
    expect(s.requiredFields.mock.calls[0][0].productTypeByChannel).toEqual({ 'AMAZON:BE': 'COAT' })
  })
  it('a listing in this market names its own type → it still wins', async () => {
    expect((await schema('pinned', 'AMAZON', 'BE')).statusCode).toBe(200)
    expect(schemaType()).toBe('PANTS')
  })
  it('no type resolvable → the same 409 and code as before', async () => {
    const response = await schema('bare', 'AMAZON', 'BE')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'No product type set. Pick one in the Channel Setup above.', code: 'no_product_type' })
    expect(s.requiredFields).not.toHaveBeenCalled()
  })
  it('non-Amazon unchanged: Shopify takes the product’s own type, eBay only its listing’s category', async () => {
    expect((await schema('jacket', 'SHOPIFY', 'BE')).statusCode).toBe(200)
    expect(schemaType()).toBe('OUTERWEAR')
    expect((await schema('jacket', 'EBAY', 'IT')).statusCode).toBe(200)
    expect(s.aspects).toHaveBeenCalledWith('90001', 'IT', expect.anything())
    // eBay never borrows an Amazon type, from the product or another market.
    expect((await schema('typeless', 'EBAY', 'IT')).json()).toMatchObject({ code: 'no_ebay_category' })
  })
})

const preflight = async (key: string, coordinates: Array<{ channel: string; marketplace: string }>) => {
  const response = await app.inject({ method: 'POST', url: `/api/products/${ids[key]}/publish-preflight`, payload: { coordinates } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().coordinates as Array<{ channel: string; status: string; resolved: { productType: string | null }; issues: Array<{ message: string }> }>
}
const publish = (key: string, channel: string, marketplace: string) => app.inject({ method: 'POST', url: `/api/products/${ids[key]}/listings/${channel}/${marketplace}/publish`, payload: {} })

describe('direct publish and its preflight', () => {
  it('Amazon BE, unlisted there, COAT in DE and IT → the preflight predicts COAT and the publish sends COAT', async () => {
    expect((await preflight('jacket', [{ channel: 'AMAZON', marketplace: 'BE' }]))[0].resolved.productType).toBe('COAT')
    const response = await publish('jacket', 'AMAZON', 'BE')
    expect(response.json()).toMatchObject({ ok: true, status: 'DRY_RUN' })
    expect(s.put).toHaveBeenCalledWith(expect.objectContaining({ productType: 'COAT', marketplaceId: 'FAKE_MARKETPLACE_ID' }))
  })
  it('a product with no type of its own publishes with its sibling markets’ type instead of failing', async () => {
    const [row] = await preflight('typeless', [{ channel: 'AMAZON', marketplace: 'BE' }])
    expect(row).toMatchObject({ status: 'ready', resolved: { productType: 'COAT' } })
    expect((await publish('typeless', 'AMAZON', 'BE')).json()).toMatchObject({ ok: true })
    expect(s.put).toHaveBeenCalledWith(expect.objectContaining({ productType: 'COAT' }))
  })
  it('a listing in this market names its own type → it still wins', async () => {
    expect((await preflight('pinned', [{ channel: 'AMAZON', marketplace: 'BE' }]))[0].resolved.productType).toBe('PANTS')
    await publish('pinned', 'AMAZON', 'BE')
    expect(s.put).toHaveBeenCalledWith(expect.objectContaining({ productType: 'PANTS' }))
  })
  it('no type resolvable → the same 422 and message as before, nothing sent', async () => {
    expect((await preflight('bare', [{ channel: 'AMAZON', marketplace: 'BE' }]))[0].issues.map(i => i.message)).toContain('Product type is required')
    const response = await publish('bare', 'AMAZON', 'BE')
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, status: 'INVALID', message: 'Product type is required' })
    expect(s.put).not.toHaveBeenCalled()
  })
  it('non-Amazon unchanged: listing type, else the product’s own — never another market’s Amazon listing', async () => {
    const rows = await preflight('jacket', [{ channel: 'EBAY', marketplace: 'IT' }, { channel: 'SHOPIFY', marketplace: 'BE' }])
    expect(rows.map(r => r.resolved.productType)).toEqual(['90001', 'OUTERWEAR'])
    expect((await preflight('typeless', [{ channel: 'SHOPIFY', marketplace: 'BE' }]))[0].resolved.productType).toBeNull()
    // The direct publish still asks every channel for a type, and eBay still gets none from Amazon's listings.
    const response = await publish('typeless', 'EBAY', 'IT')
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ message: 'Product type is required' })
  })
})

describe('grid listing health (POST /products/listing-health/bulk)', () => {
  const health = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/products/listing-health/bulk', payload: { productIds: ['jacket', 'pinned', 'typeless', 'bare'].map(k => ids[k]) } })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().results as Record<string, { ready: number; total: number; byChannel: Record<string, { ready: number; total: number }> }>
  }
  it('an Amazon listing with no type of its own is ready when the sibling markets give one (was blocked)', async () => {
    const results = await health()
    expect(results[ids.typeless].byChannel.AMAZON).toEqual({ ready: 3, total: 3 })
  })
  it('a listing that names its own type is ready; nothing anywhere is still blocked', async () => {
    const results = await health()
    expect(results[ids.pinned].byChannel.AMAZON).toEqual({ ready: 2, total: 2 })
    expect(results[ids.jacket].byChannel.AMAZON).toEqual({ ready: 2, total: 2 })
    expect(results[ids.bare]).toMatchObject({ ready: 0, total: 1 })
  })
  it('non-Amazon unchanged: eBay needs no product type', async () => {
    const results = await health()
    expect(results[ids.typeless].byChannel.EBAY).toEqual({ ready: 1, total: 1 })
    expect(results[ids.jacket].byChannel.EBAY).toEqual({ ready: 1, total: 1 })
  })
})

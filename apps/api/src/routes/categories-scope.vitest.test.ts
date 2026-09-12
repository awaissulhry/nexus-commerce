import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({ listing: vi.fn(), reconciliation: vi.fn(), detect: vi.fn(), types: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findFirst: mocks.listing }, listingReconciliation: { findFirst: mocks.reconciliation } } }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured() { return true }; detectProductTypeFromAsin = mocks.detect } }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/listing-wizard/product-types.service.js', () => ({ ProductTypesService: class { listProductTypes = mocks.types } }))
import categoriesRoutes from './categories.routes.js'

let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.listing.mockResolvedValue(null); mocks.types.mockResolvedValue([])
  app = Fastify(); await app.register(categoriesRoutes)
})
afterEach(async () => { await app.close() })

describe('category lookup scope isolation', () => {
  it('looks for cached breadcrumbs in the exact market and effective product type', async () => {
    mocks.listing.mockResolvedValueOnce({ platformAttributes: { detectedCategoryPath: 'Clothing › Coats', attributes: { recommended_browse_nodes: [123] } } })
    const result = await app.inject('/categories/browse-path?channel=AMAZON&marketplace=IT&productType=COAT')
    expect(result.json()).toEqual({ categoryPath: 'Clothing › Coats', browseNodes: [123] })
    expect(mocks.listing.mock.calls[0][0].where).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', product: { deletedAt: null }, OR: [
      { platformAttributes: { path: ['productType'], equals: 'COAT' } },
      { AND: [{ platformAttributes: { path: ['productType'] } }, { product: { productType: 'COAT' } }] },
    ] })
    expect(mocks.detect).not.toHaveBeenCalled()
  })
  it('does not borrow an unrelated reconciliation ASIN when no typed listing exists', async () => {
    mocks.reconciliation.mockResolvedValue({ externalListingId: 'UNRELATED' })
    const result = await app.inject('/categories/browse-path?channel=AMAZON&marketplace=IT&productType=COAT')
    expect(result.json()).toEqual({ categoryPath: null, browseNodes: null })
    expect(mocks.reconciliation).not.toHaveBeenCalled(); expect(mocks.detect).not.toHaveBeenCalled()
    expect(mocks.listing.mock.calls[1][0].where.OR[0].platformAttributes.equals).toBe('COAT')
  })
  it.each(['COAT', 'SHOES', null])('only returns a detected breadcrumb when live type %s matches the requested type', async liveType => {
    mocks.listing.mockResolvedValueOnce(null).mockResolvedValueOnce({ externalListingId: 'B012345678' })
    mocks.detect.mockResolvedValue({ productType: liveType, categoryPath: 'Clothing › Coats', browseNodes: [123] })
    const result = await app.inject('/categories/browse-path?channel=AMAZON&marketplace=IT&productType=COAT')
    expect(result.json()).toEqual(liveType === 'COAT' ? { categoryPath: 'Clothing › Coats', browseNodes: [123] } : { categoryPath: null, browseNodes: null })
    expect(mocks.detect).toHaveBeenCalledWith('B012345678', 'APJ6JRA9NG5V4')
  })
  it('suggestions never attach one product’s breadcrumb to a different type', async () => {
    mocks.types.mockResolvedValue([{ productType: 'COAT', displayName: 'Coats' }, { productType: 'SHOES', displayName: 'Shoes' }, { productType: 'SHIRT', displayName: 'Shirts' }])
    mocks.listing.mockImplementation(async ({ where }) => where.OR[0].platformAttributes.equals === 'SHIRT' ? null : { externalListingId: where.OR[0].platformAttributes.equals })
    mocks.detect.mockResolvedValue({ productType: 'COAT', categoryPath: 'Clothing › Coats', browseNodes: [123] })
    const result = await app.inject('/categories/suggestions?channel=AMAZON&marketplace=IT&keyword=clothing')
    expect(result.json().suggestions).toEqual([{ productType: 'COAT', displayName: 'Coats', pathParts: ['Clothing', 'Coats'], browseNodes: [123], count: 2 }])
    expect(mocks.detect).toHaveBeenCalledTimes(2); expect(mocks.reconciliation).not.toHaveBeenCalled()
  })
})

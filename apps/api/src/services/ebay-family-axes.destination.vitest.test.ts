import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ parent: vi.fn(), listing: vi.fn(), rows: vi.fn(), resolve: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  product: { findUnique: mocks.parent, findMany: async () => [] },
  channelListing: { findFirst: mocks.listing, findMany: async () => [] },
  sharedListingMembership: { findMany: async () => [] },
} }))
vi.mock('./ebay-variation-push.service.js', () => ({ buildEbayFamilyRows: mocks.rows, resolveVariationAxes: mocks.resolve }))
vi.mock('./connection-resolver.service.js', () => ({ resolveChannelConnectionId: async (_channel: string, id: string) => id }))
vi.mock('./ebay-image-axis-preference.service.js', () => ({ readImageAxisPreference: async () => undefined }))
vi.mock('./ebay-category.service.js', () => ({ EbayCategoryService: class {} }))
vi.mock('./pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: async () => ({ products: [] }) }))
import { resolveFamilyAxes } from './ebay-family-axes.service'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.parent.mockResolvedValue({ id: 'family', sku: 'parent', variationTheme: 'Colore,Taglia' })
  mocks.rows.mockResolvedValue([{ sku: 'child', _isParent: false }])
  mocks.resolve.mockReturnValue({ validSpecs: [], warnings: [], suppressed: [] })
})
describe('listing-specific family grouping', () => {
  it('uses the selected alias theme ahead of the family default', async () => {
    mocks.listing.mockResolvedValue({ variationTheme: 'Materiale', platformAttributes: {}, externalListingId: null })
    await resolveFamilyAxes('family', 'IT', { channelConnectionId: 'account-b', aliasKey: 'alias-2' })
    expect(mocks.listing).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: 'family', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'alias-2' } }))
    expect(mocks.rows).toHaveBeenCalledWith('family', 'IT', { channelConnectionId: 'account-b', aliasKey: 'alias-2' })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.any(Array), ['Materiale'], expect.any(Object))
  })
  it('inherits the family theme only when the listing has no override', async () => {
    mocks.listing.mockResolvedValue({ variationTheme: null, platformAttributes: {} })
    await resolveFamilyAxes('family', 'DE', { channelConnectionId: 'account-c', aliasKey: '' })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.any(Array), ['Colore', 'Taglia'], expect.any(Object))
  })
})

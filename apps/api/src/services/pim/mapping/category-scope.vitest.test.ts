import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  productCategory: { findMany: vi.fn() },
  categoryChannelMapping: { findMany: vi.fn() },
  category: { findMany: vi.fn() }, categoryClosure: { findMany: vi.fn(async () => []) },
}))
vi.mock('../../../db.js', () => ({ default: db }))
import { categoryForListing, resolveCategoriesForProducts, type ResolvedCategory } from './category-mapping.service.js'

const legacy: ResolvedCategory = {
  channelCategoryId: 'OUTERWEAR', source: 'productType', channelCategoryPath: null,
  browseNodeId: null, categoryId: null, categoryName: null, reviewed: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.product.findMany.mockResolvedValue([{ id: 'jacket', productType: 'OUTERWEAR' }])
  db.productCategory.findMany.mockResolvedValue([])
  db.categoryChannelMapping.findMany.mockResolvedValue([])
  db.category.findMany.mockResolvedValue([])
})

describe('channel category isolation', () => {
  it('keeps the legacy Amazon type as an Amazon fallback', async () => {
    const result = await resolveCategoriesForProducts({ productIds: ['jacket'], channel: 'AMAZON', marketplace: 'IT' })
    expect(result.jacket).toEqual(legacy)
  })

  it.each(['EBAY', 'SHOPIFY'])('does not invent a %s category from an Amazon product type', async (channel) => {
    const result = await resolveCategoriesForProducts({ productIds: ['jacket'], channel, marketplace: 'IT' })
    expect(result.jacket.channelCategoryId).toBeNull()
    expect(result.jacket.source).toBe('none')
  })

  it('uses the existing eBay leaf category, including numeric cached ids', () => {
    expect(categoryForListing(legacy, 'EBAY', { categoryId: 177104 })).toMatchObject({
      channelCategoryId: '177104', source: 'listing',
    })
  })

  it('uses the listing Amazon type before the master default', () => {
    expect(categoryForListing(legacy, 'AMAZON', { productType: 'COAT', categoryId: '177104' })).toMatchObject({
      channelCategoryId: 'COAT', source: 'listing',
    })
  })

  it('preserves a reviewed taxonomy mapping when the listing has no category', () => {
    const mapped: ResolvedCategory = { ...legacy, channelCategoryId: '177104', source: 'categoryExact', reviewed: true }
    expect(categoryForListing(mapped, 'EBAY', { productType: 'OUTERWEAR', categoryId: ' ' })).toEqual(mapped)
    expect(categoryForListing(legacy, 'EBAY', null).channelCategoryId).toBeNull()
  })
})


describe('overlapping shared categories', () => {
  it('reports conflicting secondary categories and resolves only after an explicit primary choice', async () => {
    const memberships = [{ productId: 'jacket', categoryId: 'a', isPrimary: false }, { productId: 'jacket', categoryId: 'b', isPrimary: false }]
    db.productCategory.findMany.mockResolvedValue(memberships)
    const snapshot = [{ categoryId: 'a', marketplace: 'IT', channelCategoryId: '111', channelCategoryPath: null, browseNodeId: null, reviewedAt: null }, { categoryId: 'b', marketplace: 'IT', channelCategoryId: '222', channelCategoryPath: null, browseNodeId: null, reviewedAt: null }]
    const read = () => resolveCategoriesForProducts({ productIds: ['jacket'], channel: 'EBAY', marketplace: 'IT', mappingSnapshot: snapshot })
    expect((await read()).jacket).toMatchObject({ channelCategoryId: null, conflicts: ['a → 111', 'b → 222'] })
    memberships[1].isPrimary = true
    expect((await read()).jacket.channelCategoryId).toBe('222')
    expect(db.categoryChannelMapping.findMany).not.toHaveBeenCalled()
  })
})


it.each(['SHOPIFY', 'ETSY'])('keeps %s category inheritance distinct from an explicit empty draft', channel => {
  const mapped = { channelCategoryId: '123', source: 'mapping' } as ResolvedCategory
  const key = channel === 'SHOPIFY' ? 'category' : 'taxonomy_id'
  expect(categoryForListing(mapped, channel, {}).channelCategoryId).toBe('123')
  expect(categoryForListing(mapped, channel, { [key]: null }).channelCategoryId).toBeNull()
  expect(categoryForListing(mapped, channel, { [key]: channel === 'SHOPIFY' ? 'gid://shopify/TaxonomyCategory/aa-1' : 456, productType: 'OUTERWEAR' }).source).toBe('listing')
})

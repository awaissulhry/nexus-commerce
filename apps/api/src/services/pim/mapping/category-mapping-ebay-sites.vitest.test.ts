import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  productCategory: { findMany: vi.fn() },
  categoryChannelMapping: { findMany: vi.fn(), upsert: vi.fn() },
  categoryClosure: { findMany: vi.fn() },
  category: { findMany: vi.fn() },
}))
vi.mock('../../../db.js', () => ({ default: db }))

import { assertCategoryMappingMarket, categoryMappingMarkets, resolveCategoriesForProducts, upsertCategoryMapping } from './category-mapping.service.js'

const wildcard = { categoryId: 'jackets', marketplace: '*', channelCategoryId: '177104', channelCategoryPath: 'Abbigliamento per moto > Giacche', browseNodeId: null, reviewedAt: new Date() }

beforeEach(() => {
  vi.clearAllMocks()
  db.product.findMany.mockResolvedValue([{ id: 'p1', parentId: null, productType: 'COAT' }])
  db.productCategory.findMany.mockResolvedValue([{ productId: 'p1', categoryId: 'jackets', isPrimary: true }])
  db.categoryClosure.findMany.mockResolvedValue([])
  db.category.findMany.mockResolvedValue([{ id: 'jackets', name: 'Jackets' }])
})

describe('eBay category mappings name their site', () => {
  it('reads the all-market row for every channel except eBay', () => {
    expect(categoryMappingMarkets('EBAY', 'DE')).toEqual(['DE'])
    expect(categoryMappingMarkets('ebay', 'UK')).toEqual(['UK'])
    expect(categoryMappingMarkets('AMAZON', 'DE')).toEqual(['DE', '*'])
    expect(categoryMappingMarkets('ETSY', 'GLOBAL')).toEqual(['GLOBAL', '*'])
  })

  it('never asks the database for an eBay all-market row', async () => {
    db.categoryChannelMapping.findMany.mockResolvedValue([])
    await resolveCategoriesForProducts({ productIds: ['p1'], channel: 'EBAY', marketplace: 'DE' })
    expect(db.categoryChannelMapping.findMany.mock.calls[0][0].where).toEqual({ channel: 'EBAY', marketplace: { in: ['DE'] } })
  })

  it('does not give an eBay all-market leaf to a site, even from a snapshot', async () => {
    const out = await resolveCategoriesForProducts({ productIds: ['p1'], channel: 'EBAY', marketplace: 'DE', mappingSnapshot: [wildcard] })
    expect(out.p1.channelCategoryId).toBeNull()
    expect(db.categoryChannelMapping.findMany).not.toHaveBeenCalled()
  })

  it('keeps the all-market row as a fallback on the other channels', async () => {
    const out = await resolveCategoriesForProducts({ productIds: ['p1'], channel: 'ETSY', marketplace: 'GLOBAL', mappingSnapshot: [wildcard] })
    expect(out.p1).toMatchObject({ channelCategoryId: '177104', source: 'categoryWildcard' })
  })

  it('refuses to save an eBay mapping for all markets', async () => {
    expect(() => assertCategoryMappingMarket('EBAY', '*')).toThrow('per eBay site')
    expect(() => assertCategoryMappingMarket('EBAY', '')).toThrow('per eBay site')
    expect(() => assertCategoryMappingMarket('EBAY', 'DE')).not.toThrow()
    expect(() => assertCategoryMappingMarket('AMAZON', '*')).not.toThrow()
    await expect(upsertCategoryMapping({ categoryId: 'jackets', channel: 'ebay', marketplace: '', channelCategoryId: '177104' })).rejects.toThrow('per eBay site')
    expect(db.categoryChannelMapping.upsert).not.toHaveBeenCalled()
  })
})

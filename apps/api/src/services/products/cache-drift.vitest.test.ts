import { describe, expect, it } from 'vitest'
import { productCacheDrifted } from './cache-drift.js'
const product = { id: 'parent', totalStock: 0, status: 'DRAFT', name: 'Parent', sku: 'P', basePrice: 10, isParent: true, parentId: null, productType: null, version: 3, updatedAt: new Date(100), _count: { children: 2, channelListings: 1 } }
const cache = { ...product, childCount: 2, channelCount: 1, cacheRefreshedAt: new Date(200) }
describe('catalog cache repair detection', () => {
  it('leaves a current projection alone', () => expect(productCacheDrifted(product, cache, new Date(150))).toBe(false))
  it.each([{ version: 2 }, { childCount: 1 }, { channelCount: 0 }, { updatedAt: new Date(0) }])('detects stale relationship and write metadata %j', patch => {
    expect(productCacheDrifted(product, { ...cache, ...patch })).toBe(true)
  })
  it('detects a listing update that never changed the Product row', () => expect(productCacheDrifted(product, cache, new Date(300))).toBe(true))
  it('derives an unmarked root’s Parent role from its children', () => expect(productCacheDrifted({ ...product, isParent: false }, cache)).toBe(false))
})

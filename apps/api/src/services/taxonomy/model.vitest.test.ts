import { describe, expect, it } from 'vitest'
import { flattenAmazonTypes, flattenEbayTree, flattenEtsyTree, flattenShopifyTree, validateTaxonomy, type TaxonomyNodeInput } from './model.js'
import { taxonomyMarket } from './providers.js'

const node = (id: string, parentId: string | null = null): TaxonomyNodeInput => ({ externalId: id, parentId, name: `Category ${id}`, path: `Category ${id}`, assignable: true })
describe('complete taxonomy imports', () => {
  it('rejects empty, truncated, duplicated, cyclic, and orphaned trees', () => {
    for (const nodes of [[], [node('a'), node('a')], [node('a', 'b')], [node('a', 'b'), node('b', 'a')]]) expect(() => validateTaxonomy({ nodes, providerVersion: null })).toThrow()
  })
  it('rejects over-deep trees even when every ancestor was already validated', () => {
    const nodes = Array.from({ length: 102 }, (_, i) => node(String(i), i ? String(i - 1) : null))
    expect(() => validateTaxonomy({ nodes, providerVersion: null })).toThrow('depth')
  })
  it('keeps provider IDs and leaf eligibility separate from display labels', () => {
    const result = flattenEbayTree({ categoryTreeVersion: 'v1', rootCategoryNode: { category: { categoryId: '0', categoryName: 'Root' }, childCategoryTreeNodes: [{ category: { categoryId: '00123', categoryName: 'Racing suits' }, leafCategoryTreeNode: true }] } })
    expect(result.nodes[0].assignable).toBe(false)
    expect(result.nodes[1]).toMatchObject({ externalId: '00123', parentId: '0', path: 'Root › Racing suits', assignable: true })
  })
  it('keeps Etsy seller category identity and ancestry', () => {
    expect(flattenEtsyTree({ results: [{ id: 1, name: 'Clothing', children: [{ id: 2, name: 'Jackets', children: [] }] }] }).nodes[1]).toMatchObject({ externalId: '2', parentId: '1', path: 'Clothing › Jackets' })
    expect(() => flattenEtsyTree({ results: [{ id: 2, name: 'Jackets' }] })).toThrow()
  })
  it('represents Amazon product types without inventing a browse-node hierarchy', () => {
    expect(flattenAmazonTypes({ productTypes: [{ name: 'SUIT', displayName: 'Suit' }] }).nodes).toEqual([{ externalId: 'SUIT', parentId: null, name: 'Suit', path: 'Suit', assignable: true }])
    expect(() => flattenAmazonTypes({ productTypes: [{ name: 4 }] })).toThrow()
  })
  it('preserves Shopify category attribute metadata without treating every attribute as required', () => {
    const result = flattenShopifyTree({ version: '2026-08', verticals: [{ categories: [{ id: 'gid://shopify/TaxonomyCategory/a', parent_id: null, name: 'Clothing', full_name: 'Clothing', attributes: [{ id: 'size', name: 'Size' }] }] }] })
    expect(result.nodes[0].metadata?.attributes).toEqual([{ id: 'size', name: 'Size' }])
    expect(result.providerVersion).toBe('2026-08')
  })
  it('validates 100,000 nodes without a per-node database or provider request', () => {
    const nodes = [node('root'), ...Array.from({ length: 99_999 }, (_, i) => node(String(i), 'root'))]
    expect(validateTaxonomy({ nodes, providerVersion: 'large' }).nodes).toHaveLength(100_000)
  })
  it('normalizes market aliases without mixing market-scoped and global schemas', () => {
    expect(taxonomyMarket('EBAY', 'EBAY_GB')).toBe('UK')
    expect(taxonomyMarket('AMAZON', 'DE')).toBe('DE')
    expect(taxonomyMarket('ETSY', 'IT')).toBe('GLOBAL')
    expect(taxonomyMarket('NEW_CHANNEL', 'DE')).toBe('DE')
  })
})

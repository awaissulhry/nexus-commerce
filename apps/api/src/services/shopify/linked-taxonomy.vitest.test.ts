import { beforeEach, describe, expect, it } from 'vitest'
import { invalidateTaxonomyCache, readTaxonomyAttributeValues, searchLinkedReferences, taxonomyCategoryId, taxonomyHandle } from './linked-products-gateway.js'

/* Lane B slice B2 (docs/shopify-metafields/PLAN-2026-09-28.md §6.2, gap G12): Shopify's taxonomy values for an attribute,
   found through a category, read in pages, cached; the picker searches them by name. Made-up ids. */
let calls: string[]
const code = 'zz-1', category = `gid://shopify/TaxonomyCategory/${code}`, colour = 'gid://shopify/TaxonomyAttribute/91'
const gql: any = async (query: string, variables: any) => {
  const name = query.match(/query (\w+)/)![1]; calls.push(name)
  if (name === 'NexusTaxonomyCategoryAttributes') return variables.id === category
    ? { node: { attributes: { nodes: [{ __typename: 'TaxonomyChoiceListAttribute', id: colour, name: 'Color' }, { __typename: 'TaxonomyChoiceListAttribute', id: 'gid://shopify/TaxonomyAttribute/92', name: 'Target gender' }, { __typename: 'TaxonomyMeasurementAttribute' }] } } }
    : { node: { attributes: { nodes: [] } } }
  if (name === 'NexusTaxonomyAttributeValues') {
    const all = ['Beige', 'Black', 'Blue', 'Navy', 'Red'].map((n, i) => ({ id: `gid://shopify/TaxonomyValue/${9001 + i}`, name: n }))
    const start = variables.after ? 3 : 0
    return { node: { values: { nodes: all.slice(start, start + 3), pageInfo: { hasNextPage: start === 0, endCursor: start === 0 ? 'page-2' : null } } } }
  }
  throw new Error(`Unexpected ${name}`)
}
beforeEach(() => { calls = []; invalidateTaxonomyCache() })

describe('taxonomy values (G12)', () => {
  it('finds the attribute by its handle and reads every page of values', async () => {
    /* A definition's category constraint holds the bare code, as a live store returns it (review finding, 2026-09-28). */
    const { attribute, values } = await readTaxonomyAttributeValues(gql, 'color', [code])
    expect(attribute).toEqual({ id: colour, name: 'Color' })
    expect(values.map(v => v.label)).toEqual(['Beige', 'Black', 'Blue', 'Navy', 'Red'])
    expect(values[0]).toMatchObject({ type: 'TaxonomyValue', available: true, image: null })
  })
  it('takes a category as a bare code or as a full id, and nothing else', () => {
    expect(taxonomyCategoryId('aa-1-13')).toBe('gid://shopify/TaxonomyCategory/aa-1-13')
    expect(taxonomyCategoryId('gid://shopify/TaxonomyCategory/aa-1-13')).toBe('gid://shopify/TaxonomyCategory/aa-1-13')
    expect(taxonomyCategoryId('na')).toBe('gid://shopify/TaxonomyCategory/na')
    for (const bad of ['', 'not a category', 'gid://shopify/TaxonomyCategory/', 'gid://shopify/Product/12', 'aa-1-', 'AA-1']) expect(taxonomyCategoryId(bad)).toBeNull()
  })
  it('matches handles to names the way Shopify writes them', () => {
    expect(taxonomyHandle('Color')).toBe('color')
    expect(taxonomyHandle('Target gender')).toBe('target_gender')
    expect(taxonomyHandle('Age group ')).toBe('age_group')
  })
  it('says there is no attribute when no given category carries it, and reads nothing else', async () => {
    expect(await readTaxonomyAttributeValues(gql, 'color', [])).toEqual({ attribute: null, values: [] })
    expect(await readTaxonomyAttributeValues(gql, 'pattern', [category])).toEqual({ attribute: null, values: [] })
    expect(await readTaxonomyAttributeValues(gql, 'color', ['not a category'])).toEqual({ attribute: null, values: [] })
    expect(calls).not.toContain('NexusTaxonomyAttributeValues')
  })
  it('caches both reads: the second search asks Shopify nothing', async () => {
    await readTaxonomyAttributeValues(gql, 'color', [category]); const first = calls.length
    await readTaxonomyAttributeValues(gql, 'color', [category])
    expect(calls).toHaveLength(first)
  })
  it('the picker searches the attribute’s values by name; without a category it says why', async () => {
    const page = await searchLinkedReferences(gql, { type: 'list.product_taxonomy_value_reference', attribute: 'color', categories: code, query: 'bl' })
    expect(page.items.map(i => i.label)).toEqual(['Black', 'Blue'])
    await expect(searchLinkedReferences(gql, { type: 'product_taxonomy_value_reference', attribute: 'color', categories: '' }))
      .rejects.toThrow('Shopify lists the “color” values only through a product category, and this field has none that carries it. The stored value is kept.')
  })
})

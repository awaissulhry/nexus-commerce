/**
 * Wave 2 item 5 + D3 (Owner decision 11) — the brand, product type and (for a create) theme template Shopify receives are
 * the values the sheet shows: the listing's own, else ONE resolver answer (rules, value maps, the template's default
 * "nexus"). A resolver that fails, or a value Shopify would refuse, holds Publish with its reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const r = vi.hoisted(() => ({ calls: [] as any[], answer: null as any, fail: null as Error | null }))
vi.mock('../pim/mapping/resolve-batch.service.js', () => ({
  resolveBatch: async (input: any) => { r.calls.push(input); if (r.fail) throw r.fail; return r.answer },
}))
import { factWireValue, productFactsFrom, resolveShopifyProductFacts } from './product-facts.js'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { channelValuePatch } from '../pim/channel-value-mutation.js'

const cell = (value: unknown, extra: Record<string, unknown> = {}) => ({ status: 'mapped' as const, value, warnings: [], ...extra })
const answer = (cells: Record<string, unknown>) => ({ products: [{ productId: 'family', cells }] })
const input = (extra: Record<string, unknown> = {}) => ({ familyId: 'family', accountId: 'store-a', marketplace: 'GLOBAL', aliasKey: '', listing: { id: 'listing', platformAttributes: {} },
  newProduct: true, locale: 'en', ...extra })
const spec = (id: string) => shopifyProductSpec().fields.find(field => field.shopifyField?.id === id)!
const stored = (listing: any, id: string, value: unknown, op: 'SET' | 'CLEAR' = 'SET') => ({ ...listing, ...channelValuePatch(listing, spec(id).channelStore, [spec(id).masterKey ?? spec(id).key, spec(id).key], op, value) })

beforeEach(() => { r.calls = []; r.fail = null; r.answer = answer({ vendor: cell('Xavia Racing'), productType: cell('Giacca'), templateSuffix: cell('nexus', { provenance: 'default' }) }) })

describe('what Shopify receives for the product', () => {
  it('a new product: the resolver\'s brand, product type and template, in one call, listed as Shared', async () => {
    const facts = await resolveShopifyProductFacts(input())
    expect(r.calls).toEqual([{ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'store-a', aliasKey: '', productIds: ['family'],
      fieldKeys: [spec('vendor').key, spec('productType').key, spec('templateSuffix').key], includeCatalogue: false }])
    expect(facts).toMatchObject({ vendor: 'Xavia Racing', productType: 'Giacca', templateSuffix: 'nexus', problems: [] })
    expect(facts.review.map(entry => [entry.label, entry.value, entry.shared])).toEqual([['Brand', 'Xavia Racing', true], ['Product type', 'Giacca', true], ['Theme template', 'nexus', undefined]])
  })
  it('a product Shopify holds: brand and product type only — the template is sent only at a create', async () => {
    const facts = await resolveShopifyProductFacts(input({ newProduct: false }))
    expect(r.calls[0].fieldKeys).toEqual([spec('vendor').key, spec('productType').key])
    expect(facts.templateSuffix).toBe('')
    expect(facts.review.map(entry => entry.label)).toEqual(['Brand', 'Product type'])
  })
  it('the listing\'s own value wins (a legacy import key too), and a cleared template is the store\'s default (\'\')', async () => {
    let listing: any = { id: 'listing', platformAttributes: { shopifyVendor: 'Imported brand' } }
    listing = stored(listing, 'productType', 'Own type')
    listing = stored(listing, 'templateSuffix', null, 'CLEAR')
    const facts = await resolveShopifyProductFacts(input({ listing }))
    expect(r.calls).toEqual([])
    expect(facts).toMatchObject({ vendor: 'Imported brand', productType: 'Own type', templateSuffix: '', review: [], problems: [] })
  })
  it('nothing mapped: no brand, no product type (as before); the template unmapped is the store\'s default', async () => {
    r.answer = answer({ vendor: { status: 'unmapped', value: null, warnings: [] }, productType: cell(null), templateSuffix: { status: 'unmapped', value: null, warnings: [] } })
    expect(await resolveShopifyProductFacts(input())).toMatchObject({ vendor: '', productType: '', templateSuffix: '', review: [], problems: [] })
  })
  it('holds Publish when the resolver fails, has no answer, a rule failed, or Shopify would refuse the value', async () => {
    r.fail = new Error('timeout')
    expect((await resolveShopifyProductFacts(input())).problems).toEqual(['Nexus could not read the Shared brand, product type and theme template for Shopify (timeout). Nothing was sent; try again.'])
    r.fail = null; r.answer = { products: [] }
    expect((await resolveShopifyProductFacts(input({ newProduct: false }))).problems).toEqual([
      'Brand: Nexus could not read its Shared value for Shopify. Nothing was sent; reload and try again.',
      'Product type: Nexus could not read its Shared value for Shopify. Nothing was sent; reload and try again.'])
    r.answer = answer({ vendor: cell('X', { warnings: ['expr failed: missing brand'] }), productType: cell('Giacca', { mappingErrors: ['Unknown source path'] }), templateSuffix: cell('not a suffix!') })
    expect((await resolveShopifyProductFacts(input())).problems).toEqual(['Brand: expr failed: missing brand', 'Product type: Unknown source path',
      'Theme template: Enter a template suffix, or leave it empty for the default template.'])
  })
  it('wire text: text as it is, a number as its text, nothing as \'\' (pure)', () => {
    expect([factWireValue('Giacca'), factWireValue(12), factWireValue(null), factWireValue(undefined)]).toEqual(['Giacca', '12', '', ''])
    expect(productFactsFrom({ familyId: 'family', listing: {}, newProduct: false, locale: 'en', resolved: { cells: { vendor: cell('A'), productType: cell('B') } as any } }))
      .toMatchObject({ vendor: 'A', productType: 'B', templateSuffix: '' })
  })
})

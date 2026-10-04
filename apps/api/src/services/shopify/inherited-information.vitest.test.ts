/**
 * S1 item 5 (product sheet consistency, Owner decisions 10 + 11) — what a NEW Shopify variant takes from its Shared product:
 * barcode, cost, country of origin, HS code and weight, only where Shopify holds no variant yet and the listing stores no
 * value. Values come from one resolver call; a value Shopify would refuse, or a resolver that fails, holds Publish.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

const r = vi.hoisted(() => ({ calls: [] as any[], answer: null as any, fail: null as Error | null }))
vi.mock('../pim/mapping/resolve-batch.service.js', () => ({
  resolveBatch: async (input: any) => { r.calls.push(input); if (r.fail) throw r.fail; return r.answer },
}))
import { inheritedCandidates, inheritedInformationFromCells, inheritedWireValue, resolveInheritedInformation } from './inherited-information.js'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { channelValuePatch } from '../pim/channel-value-mutation.js'

const schema: ShopifyStoreSchema = { definitions: [], metaobjectDefinitions: [], types: [], locales: [{ locale: 'en', primary: true, published: true }], revision: '1' }
const cell = (value: unknown, warnings: string[] = []) => ({ status: 'mapped' as const, value, warnings })
const variants = [{ id: 'red-s', sku: 'SYN-RED-S', shopifyVariantId: null }, { id: 'red-m', sku: 'SYN-RED-M', shopifyVariantId: null }]
const listing = (productId: string, platformAttributes: Record<string, unknown> = {}) => ({ id: `listing-${productId}`, productId, platformAttributes })
const input = (extra: Record<string, unknown> = {}) => ({ accountId: 'store-a', marketplace: 'GLOBAL', aliasKey: '', schema, variants, listings: [listing('red-s'), listing('red-m')], ...extra })

beforeEach(() => { r.calls = []; r.answer = { products: [] }; r.fail = null })

describe('which variants and fields inherit', () => {
  it('every new variant, the five native fields, under their mapping keys', () => {
    const candidates = inheritedCandidates(input())
    expect(candidates.map(c => c.productId)).toEqual(['red-s', 'red-m'])
    expect(candidates[0].fields.map(f => [f.id, f.key, f.label])).toEqual([['cost', 'cost', 'Cost'], ['barcode', 'barcode', 'Barcode'], ['weight', 'weight', 'Weight'],
      ['harmonizedSystemCode', 'harmonizedSystemCode', 'HS code'], ['countryCodeOfOrigin', 'countryCodeOfOrigin', 'Country of origin']])
  })
  it('never a variant Shopify holds (a recorded id, or its SKU on the Shopify product)', () => {
    expect(inheritedCandidates(input({ variants: [{ ...variants[0], shopifyVariantId: '11' }, variants[1]] })).map(c => c.productId)).toEqual(['red-m'])
    expect(inheritedCandidates(input({ remoteSkus: ['SYN-RED-M'] })).map(c => c.productId)).toEqual(['red-s'])
  })
  it('never a field the listing stores — a typed value or a deliberate clear keeps its own path', () => {
    const barcode = shopifyProductSpec(schema, 'store-a').fields.find(f => f.shopifyField?.id === 'barcode')!
    const cost = shopifyProductSpec(schema, 'store-a').fields.find(f => f.shopifyField?.id === 'cost')!
    const typed = { ...listing('red-s'), ...channelValuePatch(listing('red-s'), barcode.channelStore, [barcode.key], 'SET', '0009') }
    const cleared = { ...typed, ...channelValuePatch(typed, cost.channelStore, [cost.key], 'CLEAR') }
    const fields = inheritedCandidates(input({ listings: [cleared, listing('red-m')] }))[0].fields.map(f => f.id)
    expect(fields).not.toContain('barcode')
    expect(fields).not.toContain('cost')
    expect(fields).toContain('weight')
  })
  it('never a field this store cannot take (its capability reason shows on the sheet)', () => {
    const limited = { ...schema, native: { scopes: ['write_products'], enums: {}, inputs: { variant: ['barcode'], inventory: ['harmonizedSystemCode', 'countryCodeOfOrigin', 'cost'], measurement: [] } } } as unknown as ShopifyStoreSchema
    expect(inheritedCandidates(input({ schema: limited }))[0].fields.map(f => f.id)).not.toContain('weight')
  })
})

describe('the values sent and the problems that hold Publish', () => {
  it('sends Shopify Information\'s wire form: a weight in Shopify\'s code, a cost as decimal text', () => {
    expect(inheritedWireValue('weight', { value: 1.2, unit: 'kg' })).toBe('{"value":1.2,"unit":"KILOGRAMS"}')
    expect(inheritedWireValue('cost', 12.5)).toBe('12.5')
    expect(inheritedWireValue('barcode', '0012345678905')).toBe('0012345678905')
    for (const empty of [null, undefined, '', '   ']) expect(inheritedWireValue('barcode', empty)).toBeNull()
  })
  it('keeps the valid values, names each refused one with SKU + label + Shopify\'s reason, and skips unmapped cells', () => {
    const candidates = inheritedCandidates(input())
    const out = inheritedInformationFromCells(candidates, [
      { productId: 'red-s', cells: { barcode: cell('0001'), cost: cell(9), weight: cell({ value: 1.2, unit: 'kg' }), countryCodeOfOrigin: cell('Italia'), harmonizedSystemCode: { status: 'unmapped', value: null, warnings: [] } } },
      { productId: 'red-m', cells: { barcode: cell(null), weight: cell(null, ['expr failed: measure() needs a unit']) } },
    ], 'en')
    expect(out.values).toEqual({ 'red-s': { barcode: '0001', cost: '9', weight: '{"value":1.2,"unit":"KILOGRAMS"}' } })
    expect(out.problems).toEqual(['SYN-RED-S: Country of origin: Choose a two-letter country code.', 'SYN-RED-M: Weight: expr failed: measure() needs a unit'])
    expect(out.review).toEqual([
      { productId: 'red-s', label: 'Cost', type: 'money', locale: 'en', value: '9', shared: true },
      { productId: 'red-s', label: 'Barcode', type: 'single_line_text_field', locale: 'en', value: '0001', shared: true },
      { productId: 'red-s', label: 'Weight', type: 'weight', locale: 'en', value: '{"value":1.2,"unit":"KILOGRAMS"}', shared: true },
    ])
  })
  it('a variant the resolver did not answer for is a problem, never a skipped variant', () => {
    const out = inheritedInformationFromCells(inheritedCandidates(input()), [{ productId: 'red-s', cells: {} }], 'en')
    expect(out.problems).toEqual(["SYN-RED-M: Nexus could not read this variant's Shared values for Shopify. Reload and publish again."])
  })
})

describe('one resolver call', () => {
  it('asks for the candidates and fields only, on the exact store and alias', async () => {
    r.answer = { products: [{ productId: 'red-s', cells: { barcode: cell('0001') } }, { productId: 'red-m', cells: {} }] }
    const out = await resolveInheritedInformation(input({ aliasKey: 'alias-2' }))
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatchObject({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'store-a', aliasKey: 'alias-2', productIds: ['red-s', 'red-m'], includeCatalogue: false })
    expect(r.calls[0].fieldKeys.sort()).toEqual(['barcode', 'cost', 'countryCodeOfOrigin', 'harmonizedSystemCode', 'weight'])
    expect(out.values).toEqual({ 'red-s': { barcode: '0001' } })
  })
  it('makes no call when nothing inherits', async () => {
    expect(await resolveInheritedInformation(input({ remoteSkus: ['SYN-RED-S', 'SYN-RED-M'] }))).toEqual({ values: {}, problems: [], review: [] })
    expect(r.calls).toEqual([])
  })
  it('a resolver failure holds Publish with its reason', async () => {
    r.fail = new Error('database unavailable')
    const out = await resolveInheritedInformation(input())
    expect(out.values).toEqual({})
    expect(out.problems).toEqual(['Nexus could not read the Shared barcode, cost, country of origin, HS code and weight for the new Shopify variants (database unavailable). Nothing was sent; try again.'])
  })
})

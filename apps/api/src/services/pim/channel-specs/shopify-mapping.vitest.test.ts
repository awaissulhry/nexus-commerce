import { describe, expect, it } from 'vitest'
import { informationRegistry } from '@nexus/shared/shopify-information'
import type { ShopifyFieldDefinition, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyProductSpec } from './store.js'
import { masterDefaultRule } from '../mapping/master-default-rule.js'
import { sourceOwner } from '../mapping/source-definition-plan.js'
import { buildSheetColumns } from '../sheet-columns.service.js'
import { channelValuePatch } from '../channel-value-mutation.js'
import { validateChannelValue } from '../mapping/validate-channel-value.js'
import type { CatalogueField } from '../mapping/field-catalogue.service.js'
import { nativeListingValue } from '../../shopify/native-listing-value.js'

const def = (extra: Partial<ShopifyFieldDefinition> = {}): ShopifyFieldDefinition => ({ id: 'gid://shopify/MetafieldDefinition/1', name: 'Features',
  namespace: 'custom', key: 'features', ownerType: 'PRODUCT', type: 'list.metaobject_reference', description: null, validations: [], access: { admin: null, storefront: null }, ...extra })
const schema = (definitions: ShopifyFieldDefinition[]): ShopifyStoreSchema => ({ definitions, metaobjectDefinitions: [], types: [], locales: [], revision: 'r1' })
const keys = new Set(['name', 'description', 'brand', 'basePrice', 'costPrice', 'sku', 'countryOfOrigin', 'hsCode', 'weightValue', 'weightUnit', 'shopify_product_type', 'special_feature', 'status', 'inventory', 'barcode'])
const coordinate = { channel: 'SHOPIFY' as const, marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', inMarket: false }

describe('Shopify information mapping contract', () => {
  it('covers the native registry and every live owner/namespace without guessing sources from names', () => {
    const live = schema([def(), def({ ownerType: 'PRODUCTVARIANT' }), def({ namespace: 'shopify', key: 'color-pattern', name: 'Colour' })])
    const spec = shopifyProductSpec(live, 'store-a')
    expect(spec.fields.map(f => f.attribute)).toEqual(informationRegistry(live).flatMap(f => f.id === 'inventory' ? ['availableQuantity', 'onHandQuantity'] : [f.id]))
    expect(new Set(spec.fields.map(f => f.key)).size).toBe(34)
    for (const f of spec.fields.filter(f => f.shopifyField?.definition)) {
      expect(masterDefaultRule(f, keys)).toBeNull()
      expect(sourceOwner(f)).toMatchObject({ kind: 'listing' })
      expect(f.editable).toBe(true)
      expect(f.readOnlyReason).toBeUndefined()
      expect(f.channelStore).toMatchObject({ kind: 'platformAttributes', path: ['metafields', f.shopifyField!.owner, f.shopifyField!.definition!.namespace, f.shopifyField!.definition!.key, f.shopifyField!.type] })
    }
  })
  it('keeps exact identities across renames and isolates stores, owners, namespaces and types', () => {
    const key = (d: ShopifyFieldDefinition, account = 'a') => shopifyProductSpec(schema([d]), account).fields.at(-1)!.key
    expect(key(def({ name: 'New name' }))).toBe(key(def()))
    expect(new Set([key(def()), key(def(), 'b'), key(def({ ownerType: 'PRODUCTVARIANT' })), key(def({ namespace: 'custom.other' })), key(def({ type: 'single_line_text_field' }))]).size).toBe(5)
    expect(() => shopifyProductSpec(schema([def()]))).toThrow('connected store identity')
  })
  it('maps native facts explicitly and keeps Shopify product type separate from category assignments', () => {
    const spec = shopifyProductSpec()
    const rule = (id: string) => masterDefaultRule(spec.fields.find(f => f.shopifyField?.id === id), keys)
    for (const [id, source] of Object.entries({ title: 'title', descriptionHtml: 'description', vendor: 'brand', price: 'basePrice', cost: 'costPrice', sku: 'sku', countryCodeOfOrigin: 'countryOfOrigin', harmonizedSystemCode: 'hsCode', productType: 'shopify_product_type' })) expect(rule(id)?.source).toBe(source)
    for (const id of ['inventory', 'barcode', 'status', 'salesChannels', 'package']) expect(rule(id)).toBeNull()
    expect(sourceOwner(spec.fields.find(f => f.key === 'productType')!)).toBeNull()
    expect(rule('weight')?.transforms?.[0]).toMatchObject({ type: 'expr', expr: expect.stringContaining('$weightUnit') })
  })
  it('projects every mapping destination once, with native labels and protected typed writes', () => {
    const spec = shopifyProductSpec(schema([def(), def({ namespace: 'custom-other' }), def({ namespace: 'custom_other' })]), 'a')
    const sheet = buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    expect(sheet.columns).toHaveLength(spec.fields.length)
    for (const f of spec.fields) {
      const c = sheet.columns.find(c => c.channels?.[coordinate.label]?.key === f.key)!
      expect(c, f.key).toBeDefined()
      expect(c.label).toBe(f.label)
      if (f.readOnlyReason) expect(c.editable).toBe(false)
    }
  })
  it('preserves explicit values, zeros and clears while migrating legacy storage on edit', () => {
    for (const [id, oldKey, value] of [['vendor', 'shopifyVendor', 'Store brand'], ['productType', 'shopifyProductType', 'Jackets'], ['compareAtPrice', 'shopifyCompareAtPrice', 0]] as const) {
      const f = shopifyProductSpec().fields.find(f => f.key === id)!
      const before = { platformAttributes: { [oldKey]: value, unrelated: 'keep' } }
      expect(nativeListingValue(before, id, 'Master')).toBe(value)
      const changed = { ...before, ...channelValuePatch(before, f.channelStore, [f.key], 'SET', value) }
      expect(nativeListingValue(changed, id, 'Master')).toBe(value)
      expect((changed.platformAttributes as any)[oldKey]).toBeUndefined()
      const cleared = { ...before, ...channelValuePatch(before, f.channelStore, [f.key], 'CLEAR') }
      expect(nativeListingValue(cleared, id, 'Master')).toBeNull()
      const inherited = { ...before, ...channelValuePatch(before, f.channelStore, [f.key], 'INHERIT') }
      expect(nativeListingValue(inherited, id, 'Master')).toBe('Master')
      expect((inherited.platformAttributes as any).unrelated).toBe('keep')
    }
  })
  it('applies store definition types and constraints to mapping outputs', () => {
    const field = (d: ShopifyFieldDefinition) => {
      const f = shopifyProductSpec(schema([d]), 'a').fields.at(-1)!
      return { ...f, fieldKey: f.key, priority: 'optional', selectionOnly: false, shopifyField: f.shopifyField } as unknown as CatalogueField
    }
    expect(validateChannelValue(field(def()), ['Waterproof']).errors.join(' ')).toContain('Shopify reference')
    expect(validateChannelValue(field(def()), ['gid://shopify/Product/1']).errors.join(' ')).toContain('Metaobject')
    expect(validateChannelValue(field(def({ type: 'number_integer', validations: [{ name: 'min', value: '0' }] })), -1).errors).not.toEqual([])
    expect(validateChannelValue(field(def({ type: 'color' })), 'Giallo').errors).not.toEqual([])
    expect(validateChannelValue(field(def({ type: 'boolean' })), false).errors).toEqual([])
    expect(validateChannelValue(field(def({ type: 'number_integer' })), 0).errors).toEqual([])
    expect(validateChannelValue(field(def({ type: 'list.single_line_text_field', validations: [{ name: 'list.max', value: '1' }] })), ['a', 'b']).errors).not.toEqual([])
  })
})

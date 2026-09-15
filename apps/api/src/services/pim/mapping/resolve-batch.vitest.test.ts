import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const db = vi.hoisted(() => ({ products: vi.fn(), listings: vi.fn(), catalogue: vi.fn(), mapping: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: {
  marketplace: { findFirst: async ({ where }: any) => ({ languages: [{ IT: 'it', DE: 'de', FR: 'fr', ES: 'es', GLOBAL: 'en' }[where.code as string]] }) },
  product: { findMany: db.products }, channelListing: { findMany: db.listings }, fieldLinkGroup: { findMany: async () => [] }, productCategory: { findMany: async () => [] },
} }))
vi.mock('../../connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map([['EBAY', 'primary']]) }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: db.mapping, getRulesFor: (m: any) => m.fields }))
vi.mock('../value-map.service.js', () => ({ loadValueMapLookup: async () => () => null, loadSizeScaleLookup: async () => () => null }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: db.catalogue }))
vi.mock('./category-mapping.service.js', () => ({
  resolveCategoriesForProducts: async () => ({ p: { channelCategoryId: '177104', source: 'listing' } }),
  categoryForListing: (category: unknown) => category,
}))
import { resolveBatch } from './resolve-batch.service.js'
import { previewPayload } from '../payload-preview.js'
import { validatePublish } from '../publish-validator.js'
import type { CatalogueField } from './field-catalogue.service.js'

const field = (fieldKey: string, extra: Partial<CatalogueField> = {}): CatalogueField => ({
  fieldKey, sheetKey: fieldKey, shape: 'scalar', kind: 'text', label: fieldKey, helpText: null,
  group: 'content', groupOrder: 1, priority: 'optional', prioritySource: 'channelSchema',
  maxLength: null, maxBytes: null, options: null, optionLabels: null, selectionOnly: false,
  editable: true, deprecatedOptions: null, rule: { source: fieldKey }, ruleKind: 'attribute',
  ruleSummary: fieldKey, ruleRef: null, overlay: false, status: 'mapped', ...extra,
})
const input = { channel: 'EBAY', marketplace: 'IT', productIds: ['p'] }
beforeEach(() => {
  vi.clearAllMocks()
  // LX.F R-LX-13 — the Italian title is the PRODUCT COLUMN (`it` is the primary
  // language, so it has no translation row by contract), and the legacy
  // `localizedContent` key stays in the fixture deliberately: it is the arm that
  // must NOT be read. Before LX it supplied the value; the retired slot now
  // carries a decoy, so any reader that reaches for it fails loudly here.
  db.products.mockResolvedValue([{ id: 'p', sku: 'SKU', name: 'Titolo condiviso', brand: 'Master brand', basePrice: 49, totalStock: 0,
    translations: [], localizedContent: { it: { title: 'RETIRED — must not be read' } }, categoryAttributes: { material: 'Leather' }, variantAttributes: {}, parentId: null }])
  db.listings.mockResolvedValue([])
  db.mapping.mockResolvedValue({ fields: {} })
  db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('title', { priority: 'required',
    channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } })] })
})

describe('editor, preview and validation share channel inheritance', () => {
  it.each(['109.99', '0'])('validates an alias Decimal price %s before serialization', async amount => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('price', { kind: 'number', rule: { source: 'basePrice' },
      channelStore: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' } })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', aliasKey: 'alternate',
      followMasterPrice: false, priceOverride: new Prisma.Decimal(amount), price: new Prisma.Decimal('105') }])
    const result = await resolveBatch({ ...input, aliasKey: 'alternate' })
    expect(result.products[0].cells.price).toMatchObject({ value: Number(amount), provenance: 'override', errors: [] })
  })
  it('simulates imported storage patches without changing stored products or independent listing aliases', async () => {
    const stored = [{ productId: 'p', channel: 'EBAY', marketplace: 'IT', title: 'Pinned title', followMasterTitle: false }]
    db.listings.mockResolvedValue(stored)
    const before = await resolveBatch(input)
    // The primary-language shared title is the `name` column (LX.8's routing table),
  // not a `localizedContent` patch — `catalog-transfer-effects.ts:76` excludes content
  // fields from this simulation for exactly that reason.
    const after = await resolveBatch({ ...input, aliasKey: 'summer', channelConnectionId: 'account-a', productChangesByProduct: { p: { name: 'New shared title' } }, listingChangesByProduct: { p: { followMasterTitle: true, title: null } } })
    expect(before.products[0].cells.title.value).toBe('Pinned title')
    expect(after.products[0].cells.title.value).toBe('New shared title')
    expect(stored).toEqual([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', title: 'Pinned title', followMasterTitle: false }])
    expect(db.listings).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ aliasKey: 'summer', channelConnectionId: 'account-a', marketplace: 'IT' }) }))
    expect((await resolveBatch(input)).products[0].cells.title.value).toBe('Pinned title')
  })
  it('defers absent owner-managed values to the completed payload instead of inventing missing data errors', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('price', { priority: 'required', rule: null, sourceOwner: { kind: 'listing', label: 'Pricing', path: 'price' } })] })
    const result = await resolveBatch(input)
    expect(result.products[0].cells.price).toMatchObject({ value: null, required: false, errors: [] })
    expect(result.products[0].readiness).toMatchObject({ listingOwnerFields: 1, channelValidation: 'not-checked' })
  })
  it('simulates Master changes through both flat and localized paths without changing explicit destination overrides', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('item_name', { rule: { source: 'name' } }),
      field('description', { rule: { source: 'localizedContent.{locale}.title' } }), field('brand', { rule: { source: 'title' } })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { brand: 'Pinned destination' } }])
    const result = await resolveBatch({ ...input, masterChangesByProduct: { p: { title: 'Proposed title' } } })
    expect(result.products[0].cells.item_name.value).toBe('Proposed title')
    expect(result.products[0].cells.description.value).toBe('Proposed title')
    expect(result.products[0].cells.brand.value).toBe('Pinned destination')
    expect((await resolveBatch(input)).products[0].cells.item_name.value).not.toBe('Proposed title')
  })
  it('reconciliation removes only mapped overrides while retaining listing-owned settings', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('fabric', { rule: { source: 'material' } }),
      field('policy', { rule: null, sourceOwner: { kind: 'listing', label: 'Policies', path: 'policy' } })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { fabric: 'Pinned suede', policy: 'policy-1' } }])
    const result = await resolveBatch({ ...input, inheritMappedFields: true })
    expect(result.products[0].cells.fabric.value).toBe('Leather')
    expect(result.products[0].cells.policy.value).toBe('policy-1')
  })
  it('filters review candidates by the actual listing category before loading unrelated schemas', async () => {
    const result = await resolveBatch({ ...input, categoryFilter: 'different-category', productType: 'different-category', includeCatalogue: false })
    expect(result.products).toEqual([])
    expect(result.missingProductIds).toEqual([])
    expect(db.catalogue).not.toHaveBeenCalled()
  })
  it('treats declared empty formula dependencies as empty and blocks failed typed transforms', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, masterSourceKeys: ['packageWeightValue', 'packageWeightUnit'], fields: [field('packageWeight', { shape: 'measure', kind: 'number', rule: { source: 'packageWeightValue', transforms: [{ type: 'expr', expr: 'measure($packageWeightValue, $packageWeightUnit)' }] } })] })
    expect((await resolveBatch(input)).products[0].cells.packageWeight).toMatchObject({ value: null, warnings: [], errors: [] })
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('packageWeight', { rule: { source: 'basePrice', transforms: [{ type: 'expr', expr: 'measure($basePrice, null)' }] } })] })
    expect((await resolveBatch(input)).products[0].cells.packageWeight.errors.join(' ')).toContain('measure() needs a unit')
  })
  /**
   * LX.F R-LX-13 — split, because LX.3 changed what "restored" means on the wire.
   *
   * `followMasterTitle: true` with a stale `title` column is a FOLLOWING SNAPSHOT:
   * LX.3 reads the legacy pin for `languages[0]` and marks it `drift`, because that
   * snapshot is what the channel currently shows. A RESET is no longer expressed by
   * the follow flag — it writes the field into the pin row's `follows` list, and
   * the resolver then skips the legacy value entirely (`content-resolver.ts:189`).
   * Both arms are the shipped contract, so both are measured.
   */
  it('reads a following legacy snapshot as the channel value (LX.3 drift)', async () => {
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', followMasterTitle: true, title: 'Old sync', titleOverride: 'Old override' }])
    const result = await resolveBatch(input)
    expect(result.products[0].cells.title.value).toBe('Old sync')
  })
  it('a reset through the pin row returns to Master, ignoring snapshot and override', async () => {
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', followMasterTitle: true, title: 'Old sync', titleOverride: 'Old override',
      translations: [{ language: 'it', follows: ['title'], attributes: {}, source: 'manual' }] }])
    const result = await resolveBatch(input)
    expect(result.products[0].cells.title.value).toBe('Titolo condiviso')
    expect(result.products[0].cells.title.provenance).toBe('catalogRule')
  })
  it('an explicit target override wins even when the mapping reads a different source', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('brand', { rule: { source: 'material', transforms: [{ type: 'upperCase' }] } })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { brand: 'Listing brand' } }])
    expect((await resolveBatch(input)).products[0].cells.brand).toMatchObject({ value: 'Listing brand', provenance: 'override', appliedTransforms: [] })
  })
  it('does not feed one listing override into another field mapping', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('fabric_type', { rule: { source: 'categoryAttributes.material' } })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { material: 'Listing-only material' } }])
    expect((await resolveBatch(input)).products[0].cells.fabric_type).toMatchObject({ value: 'Leather', provenance: 'catalogRule' })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { material: 'Listing-only material', fabric_type: 'Explicit fabric' } }])
    expect((await resolveBatch(input)).products[0].cells.fabric_type).toMatchObject({ value: 'Explicit fabric', provenance: 'override' })
  })
  it('keeps alias listing overrides isolated from the primary listing', async () => {
    db.listings.mockImplementation(async ({ where }: any) => [{ productId: 'p', channel: 'EBAY', marketplace: 'IT', followMasterTitle: false,
      titleOverride: where.aliasKey === 'alternate' ? 'Alias title' : 'Primary title' }])
    const primary = await resolveBatch(input)
    const alias = await resolveBatch({ ...input, aliasKey: 'alternate' })
    expect(primary.products[0].cells.title.value).toBe('Primary title')
    expect(alias.products[0].cells.title.value).toBe('Alias title')
    expect(db.listings).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ aliasKey: 'alternate', channelConnectionId: 'primary' }) }))
  })
  it('a deliberate empty override stays empty and fails required validation', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('material', { priority: 'required' })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { material: null } }])
    const result = await resolveBatch(input)
    expect(result.products[0].cells.material.value).toBeNull()
    expect(result.products[0].counts.requiredMissing).toBe(1)
  })
  it('preview includes direct channel-only settings without a stored mapping', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('returnPolicy', { rule: null, status: 'unmapped',
      channelStore: { kind: 'platformAttributes', path: ['policies', 'return'] } })] })
    db.listings.mockResolvedValue([{ productId: 'p', channel: 'EBAY', marketplace: 'IT', platformAttributes: { policies: { return: 'policy-123' } } }])
    const preview = await previewPayload({ ...input, productId: 'p' })
    expect(preview.payload).toEqual({ returnPolicy: 'policy-123' })
  })
  it('inherits an exact historical Master key and preserves a list-shaped channel value', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('material', { rule: null, status: 'unmapped', shape: 'list' })] })
    expect((await resolveBatch(input)).products[0].cells.material).toMatchObject({ value: ['Leather'], status: 'mapped', errors: [] })
  })
  it('dotted attribute mappings inherit the parent fact when the child bag is empty', async () => {
    const parent = { id: 'parent', sku: 'P', parentId: null, categoryAttributes: { material: 'Parent leather' }, localizedContent: {}, variantAttributes: {} }
    db.products.mockImplementation(async ({ where }: any) => where.id.in.includes('parent') ? [parent]
      : [{ id: 'p', sku: 'C', parentId: 'parent', categoryAttributes: {}, localizedContent: {}, variantAttributes: {} }])
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('fabric_type', { rule: { source: 'categoryAttributes.material' } })] })
    expect((await resolveBatch(input)).products[0].cells.fabric_type.value).toBe('Parent leather')
  })
  it('validation evaluates transformed defaults and counts every required field once', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('title', { priority: 'required' }),
      field('constant', { priority: 'required', rule: { source: '', transforms: [{ type: 'default', value: 'Ready' }] } })] })
    const validation = await validatePublish({ ...input, productId: 'p' })
    expect(validation).toMatchObject({ requiredFields: 2, ok: true, errors: [] })
  })
  it('preview and validation report excessive content after transforms', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('title', { maxLength: 5 })] })
    const preview = await previewPayload({ ...input, productId: 'p' })
    const validation = await validatePublish({ ...input, productId: 'p' })
    expect(preview.payload.title).toBe('Titolo condiviso')
    expect(validation).toMatchObject({ ok: false, errors: [{ code: 'invalid_value' }] })
    expect(preview.fields[0].warnings).toEqual(validation.errors.map(error => error.message))
  })
})

import { validateChannelValue } from './validate-channel-value.js'
describe('channel value constraints', () => {
  it('treats an optional empty list as absent without rewriting its stored value', () => {
    const optional = field('seasons', { priority: 'optional', shape: 'list', cardinality: { min: 1, max: 4 } })
    expect(validateChannelValue(optional, [])).toMatchObject({ value: [], errors: [] })
    expect(validateChannelValue({ ...optional, priority: 'required' }, []).errors).toEqual([expect.stringContaining('needs at least 1')])
  })
  it('checks each enum member and reports corrections without flattening the list', () => {
    const result = validateChannelValue(field('colors', { shape: 'list', options: ['Red', 'Blue'], selectionOnly: true }), [' red ', 'Blue'])
    expect(result.value).toEqual(['Red', 'Blue'])
    expect(result.errors).toEqual([])
    expect(result.autoCorrected).not.toBeNull()
  })
  it('blocks excessive list counts and individual UTF-8 byte limits', () => {
    const result = validateChannelValue(field('bullets', { shape: 'list', cardinality: { min: 1, max: 1 }, maxBytes: 3 }), ['éé', 'other'])
    expect(result.errors).toHaveLength(2)
  })
  it('uses actual schema labels and code spelling for imported sizes without guessing ambiguous labels', () => {
    const sizes = field('size', { options: ['x_l', 'xx_l', '2x_l', '3x_l'], optionLabels: { x_l: 'XL', xx_l: 'XXL', '2x_l': 'XXL', '3x_l': '3XL' }, selectionOnly: true })
    for (const [input, expected] of [['XL', 'x_l'], ['XXL', 'xx_l'], ['3XL', '3x_l'], ['2x_l', '2x_l']]) {
      expect(validateChannelValue(sizes, input)).toMatchObject({ value: expected, errors: [] })
    }
    expect(validateChannelValue({ ...sizes, optionLabels: { x_l: 'Extra large', xx_l: 'Extra large' } }, 'Extra large').errors).toHaveLength(1)
    expect(validateChannelValue(sizes, 'XXXL').errors).toHaveLength(1)
    const french = { ...sizes, options: [...sizes.options!, '3x_l'], optionLabels: { x_l: 'TG', xx_l: 'TTG', '2x_l': 'XXL', '3x_l': '3XL' } }
    expect(validateChannelValue(french, 'XL')).toMatchObject({ value: 'x_l', errors: [] })
    expect(validateChannelValue(french, 'XXL')).toMatchObject({ value: 'xx_l', errors: [] })
    expect(validateChannelValue(french, '3XL')).toMatchObject({ value: '3x_l', errors: [] })
    expect(validateChannelValue({ ...sizes, options: ['x_l', 'x-l'], optionLabels: {} }, 'XL').errors).toHaveLength(1)
  })
  it('preserves false and zero in typed strict fields', () => {
    expect(validateChannelValue(field('flag', { kind: 'boolean', selectionOnly: true, options: ['true', 'false'] }), false).errors).toEqual([])
    expect(validateChannelValue(field('quantity', { kind: 'number' }), 0).errors).toEqual([])
  })
})


describe('Master changes across channels, markets, accounts and aliases', () => {
  it('propagates shared changes while preserving child and exact-listing overrides', async () => {
    let master = 'Leather'
    const parent = () => ({ id: 'parent', sku: 'P', parentId: null, categoryAttributes: { material: master }, localizedContent: {}, variantAttributes: {} })
    const child = { id: 'p', sku: 'C', parentId: 'parent', categoryAttributes: {}, localizedContent: {}, variantAttributes: {} }
    const own = { ...child, id: 'own', sku: 'OWN', categoryAttributes: { material: 'Child cotton' } }
    db.products.mockImplementation(async ({ where }: any) => where.id.in.includes('parent') ? [parent()] : [child, own])
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('fabric_type', { rule: { source: 'categoryAttributes.material' } })] })
    db.listings.mockImplementation(async ({ where }: any) =>
      where.channel === 'AMAZON' && where.marketplace === 'IT' && where.channelConnectionId === 'account-a' && where.aliasKey === 'alternate'
        ? [{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { fabric_type: 'Pinned suede' } }]
        : [])
    const coordinates = ['AMAZON', 'EBAY'].flatMap(channel => ['IT', 'DE', 'FR', 'ES'].flatMap(marketplace =>
      ['account-a', 'account-b'].flatMap(channelConnectionId => ['', 'alternate'].map(aliasKey => ({ channel, marketplace, channelConnectionId, aliasKey })))))
    for (const value of ['Leather', 'Updated leather']) {
      master = value
      for (const coordinate of coordinates) {
        const result = await resolveBatch({ ...coordinate, productIds: ['p', 'own'] })
        const pinned = coordinate.channel === 'AMAZON' && coordinate.marketplace === 'IT' && coordinate.channelConnectionId === 'account-a' && coordinate.aliasKey === 'alternate'
        expect(result.products.find(p => p.productId === 'p')?.cells.fabric_type, JSON.stringify(coordinate)).toMatchObject({
          value: pinned ? 'Pinned suede' : value, provenance: pinned ? 'override' : 'catalogRule',
        })
        expect(result.products.find(p => p.productId === 'own')?.cells.fabric_type.value).toBe('Child cotton')
        expect(db.listings).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining(coordinate) }))
      }
    }
  })
})


describe('presentation defaults use the canonical channel resolver', () => {
  it('returns the supplying versioned account rule, preserves explicit theme overrides, and separates alias destinations', async () => {
    db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [field('descriptionThemeId', { rule: null, channelStore: { kind: 'platformAttributes', path: ['descriptionThemeId'] } })] })
    db.mapping.mockResolvedValue({ fields: {}, presentationRules: [
      { id: 'shared', name: 'Default theme', version: 1, priority: 10, scope: {}, themeId: 'theme-1' },
      { id: 'account-b', name: 'Second account', version: 3, priority: 20, scope: { accountId: 'b' }, themeId: 'theme-b' },
    ] })
    const b = await resolveBatch({ ...input, channelConnectionId: 'b' })
    expect(b.products[0].cells.descriptionThemeId).toMatchObject({ value: 'theme-b', supplyingRule: { id: 'account-b', version: 3 } })
    const a = await resolveBatch({ ...input, channelConnectionId: 'a' })
    expect(a.products[0].cells.descriptionThemeId.value).toBe('theme-1')
    db.listings.mockImplementation(async ({ where }: any) => where.aliasKey === 'alias' ? [{ productId: 'p', channel: 'EBAY', marketplace: 'IT', overrideData: { descriptionThemeId: 'custom-theme' } }] : [])
    expect((await resolveBatch({ ...input, channelConnectionId: 'b', aliasKey: 'alias' })).products[0].cells.descriptionThemeId).toMatchObject({ value: 'custom-theme', provenance: 'override' })
  })
})

it('uses the selected Shopify store and never revives deleted or retyped definition rules', async () => {
  db.mapping.mockResolvedValue({ fields: { removed: { source: 'brand' } } })
  db.catalogue.mockResolvedValue({ schema: { present: true }, fields: [
    field('productType', { sheetKey: 'shopify_product_type', rule: null, schemaKnown: true, sourceOwner: { kind: 'listing', label: 'Shopify', path: 'productType' } }),
    field('removed', { schemaKnown: false, rule: { source: 'brand' } }),
    field('status', { schemaKnown: true, rule: null, sourceOwner: { kind: 'listing', label: 'Shopify', path: 'status' } }),
  ] })
  const result = await resolveBatch({ ...input, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'store-b' })
  expect(db.catalogue).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'store-b', productType: null }))
  expect(result.products[0].cells.productType.value).toBeNull()
  expect(result.products[0].cells.status.value).toBeNull()
  expect(result.products[0].cells.removed).toBeUndefined()
})

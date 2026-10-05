import { describe, expect, it } from 'vitest'
import { informationGroups, informationRegistry, informationSheetValue, SHOPIFY_FIELD_NOT_SWITCHED_ON, SHOPIFY_WEIGHT_UNITS, mediaMoves, mediaOrderEditSchema, moveMedia, nativeFieldError, nativeFieldValueError, nativeValuesEqual,
  normalizeShopifyWeight, shopifyStatusLabel, SHOPIFY_STATUS_LABEL, shopifyWeightGrams, shopifyWeightSymbol, shopifyWeightUnit,
  nativeWriteValue, shopifyTemplateSuffixInput, SHOPIFY_NEXUS_TEMPLATE, SHOPIFY_TEMPLATE_HINT,
  shopifyInventoryPolicyLabel, SHOPIFY_INVENTORY_POLICY_LABEL, shopifyUnitPriceLabel, shopifyUnitPriceSymbol } from './shopify-information.js'
import { emptyShopifyLinkedDraft, linkedDraftSignature, shopifyLinkedDraftSchema, type ShopifyStoreSchema } from './shopify-linked-products.js'
const productId = 'gid://shopify/Product/1', variantId = 'gid://shopify/ProductVariant/11'
const schema: ShopifyStoreSchema = { definitions: [], metaobjectDefinitions: [], types: [], locales: [], revision: '1' }
describe('Shopify Information field identities', () => {
  it('uses Nexus labels for confirmed equivalents without equating distinct attributes', () => {
    const labels = Object.fromEntries(informationRegistry(schema).map(f => [f.id, f.label]))
    expect(labels).toMatchObject({ title: 'Name', descriptionHtml: 'Description', sku: 'SKU', cost: 'Cost',
      'seo.title': 'SEO title', 'seo.description': 'SEO description', handle: 'URL handle', templateSuffix: 'Theme template', vendor: 'Brand', harmonizedSystemCode: 'HS code' })
  })
  // Wave 2 D4 — Shopify's own status is "Shopify status" (the sheet's Status column is another control); its codes read
  // in Title Case while the stored value stays Shopify's code.
  it('names Shopify\'s status "Shopify status", keeps Shopify\'s own name, and reads its codes in Title Case', () => {
    const status = informationRegistry(schema).find(f => f.id === 'status')!
    expect(status).toMatchObject({ label: 'Shopify status', channelLabel: 'Status', type: 'status' })
    expect(SHOPIFY_STATUS_LABEL).toEqual({ ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived', UNLISTED: 'Unlisted' })
    expect(['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'].map(shopifyStatusLabel)).toEqual(['Active', 'Draft', 'Archived', 'Unlisted'])
    expect(shopifyStatusLabel('SCHEDULED')).toBe('SCHEDULED')
    expect(shopifyStatusLabel('constructor')).toBe('constructor')
    // The value Shopify takes is still its code: a word is refused.
    expect(nativeFieldValueError('status', 'ACTIVE')).toBeNull()
    expect(nativeFieldValueError('status', 'Active')).toBe('Choose a Shopify product status.')
  })
  it('declares native attributes without inventing store metafields', () => {
    const fields = informationRegistry(schema)
    expect(fields).toHaveLength(30)
    expect(new Set(fields.map(f => f.id)).size).toBe(fields.length)
    expect(fields.every(f => f.discovery === 'adapter')).toBe(true)
    expect(fields.some(f => f.label === 'Size Chart')).toBe(false)
  })
  it('uses the live name and keeps product and variant definitions separate', () => {
    const def = { id: 'size', namespace: 'custom', key: 'size_chart', name: 'Our renamed chart', ownerType: 'PRODUCT', type: 'page_reference', description: null, validations: [], access: { admin: null, storefront: null } }
    const fields = informationRegistry({ ...schema, definitions: [def, { ...def, id: 'variant', ownerType: 'PRODUCTVARIANT', type: 'file_reference' }] })
    expect(fields.find(f => f.id === 'metafield:PRODUCT:custom.size_chart')).toMatchObject({ label: 'Our renamed chart', owner: 'PRODUCT', type: 'page_reference' })
    expect(fields.find(f => f.id === 'metafield:PRODUCTVARIANT:custom.size_chart')?.type).toBe('file_reference')
  })
  it('adds, renames, updates and removes columns solely from the selected store schema', () => {
    const def = { id: 'one', namespace: 'custom', key: 'material', name: 'Material', ownerType: 'PRODUCT', type: 'single_line_text_field', description: null, validations: [], access: { admin: null, storefront: null } }
    const first = informationRegistry({ ...schema, definitions: [def] }).filter(f => f.definition)
    const changed = informationRegistry({ ...schema, definitions: [{ ...def, id: 'recreated', name: 'Fabric', type: 'list.single_line_text_field' }] }).filter(f => f.definition)
    expect(changed[0]).toMatchObject({ id: first[0].id, label: 'Fabric', cardinality: 'list' })
    expect(informationRegistry(schema).filter(f => f.definition)).toEqual([])
    expect(informationRegistry({ ...schema, definitions: [{ ...def, key: 'store_b' }] }).some(f => f.id === first[0].id)).toBe(false)
  })
  it('never offers Nexus\'s own identity and manifest fields as columns; a custom field of the same key still shows', () => {
    const def = (namespace: string, key: string, type: string) => ({ id: `${namespace}.${key}`, namespace, key, name: key, ownerType: 'PRODUCT', type, description: null, validations: [], access: { admin: null, storefront: null } })
    const fields = informationRegistry({ ...schema, definitions: [def('nexus', 'family_id', 'id'), def('nexus', 'resolved', 'json'), { ...def('nexus', 'resolved', 'json'), ownerType: 'PRODUCTVARIANT' }, def('custom', 'family_id', 'single_line_text_field')] })
    expect(fields.filter(f => f.definition).map(f => f.id)).toEqual(['metafield:PRODUCT:custom.family_id'])
  })
  it('offers a category field the store has not switched on, read-only, under the id it keeps once switched on', () => {
    const template = { id: 'template-age', namespace: 'shopify', key: 'age-group', name: 'Age group', ownerType: 'PRODUCT', type: 'list.metaobject_reference', description: null, validations: [],
      access: { admin: null, storefront: null }, standardTemplateId: 'template-age', constraints: { key: 'category', values: ['aa-1'], complete: false } }
    const offered = informationRegistry({ ...schema, templates: [template, { ...template, id: 't2', key: 'odd', type: 'not_a_shopify_type', standardTemplateId: 't2' }, { ...template, id: 't3', namespace: 'nexus', standardTemplateId: 't3' }] })
    expect(offered.filter(f => f.definition).map(f => [f.id, f.group, f.editor, f.reason])).toEqual([['metafield:PRODUCT:shopify.age-group', 'Category Metafields', 'unavailable', SHOPIFY_FIELD_NOT_SWITCHED_ON]])
    const enabled = { ...template, id: 'definition-age', standardTemplateId: undefined, access: { admin: 'PUBLIC_READ_WRITE', storefront: 'PUBLIC_READ' } }
    const on = informationRegistry({ ...schema, definitions: [enabled], templates: [template] }).filter(f => f.definition)
    expect(on).toHaveLength(1)
    expect(on[0]).toMatchObject({ id: 'metafield:PRODUCT:shopify.age-group', editor: 'typed', reason: undefined, definition: { id: 'definition-age' } })
  })
  it('keeps Shopify category metafields in their own group using store identifiers', () => {
    const def = { id: 'care', namespace: 'shopify', key: 'care', name: 'Care', ownerType: 'PRODUCT', type: 'single_line_text_field', description: null, validations: [], access: { admin: null, storefront: null } }
    expect(informationRegistry({ ...schema, definitions: [def] }).find(f => f.definition)?.group).toBe('Category Metafields')
  })
  it('enables pinned native writers and distinguishes computed or unreadable fields', () => {
    const fields = informationRegistry(schema)
    for (const id of ['barcode', 'inventory', 'salesChannels']) expect(fields.find(f => f.id === id)?.editor).not.toBe('unavailable')
    for (const id of ['publishDate', 'scheduled', 'package']) expect(fields.find(f => f.id === id)?.editor).toBe('unavailable')
  })
})
describe('Information values and draft ownership', () => {
  const edit = { ownerId: variantId, productId, field: 'price' as const, value: '10.00', nextValue: '0.00', ownerLabel: 'MOSS / S' }
  it('allows zero and preserves decimal strings without numeric conversion', () => {
    expect(nativeFieldError(edit)).toBeNull()
    const draft = { ...emptyShopifyLinkedDraft(), members: [{ id: productId, title: 'MOSS', handle: 'moss', image: null }], nativeEdits: [edit] }
    expect(shopifyLinkedDraftSchema.parse(draft).nativeEdits?.[0].nextValue).toBe('0.00')
  })
  it('rejects price on a product parent and prevents a hidden variant rewrite', () => expect(nativeFieldError({ ...edit, ownerId: productId })).toMatch(/belong/))
  it('preserves leading zero SKU and HS codes', () => {
    expect(nativeFieldError({ ...edit, field: 'sku', nextValue: '00012-A' })).toBeNull()
    expect(nativeFieldError({ ...edit, field: 'harmonizedSystemCode', nextValue: '001234' })).toBeNull()
  })
  it('distinguishes false from unset and nullable price from zero', () => {
    expect(nativeFieldError({ ...edit, field: 'taxable', nextValue: 'false' })).toBeNull()
    expect(nativeFieldError({ ...edit, field: 'taxable', nextValue: null })).toBeTruthy()
    expect(nativeFieldError({ ...edit, field: 'compareAtPrice', nextValue: null })).toBeNull()
  })
  it('rejects unreviewed product ownership and duplicate pending commands', () => {
    expect(shopifyLinkedDraftSchema.safeParse({ ...emptyShopifyLinkedDraft(), nativeEdits: [edit] }).success).toBe(false)
    expect(shopifyLinkedDraftSchema.safeParse({ ...emptyShopifyLinkedDraft(), members: [{ id: productId, title: 'MOSS', handle: 'moss', image: null }], nativeEdits: [edit, edit] }).success).toBe(false)
  })
  it('leaves legacy drafts valid without adding false dirty fields', () => expect(shopifyLinkedDraftSchema.parse(emptyShopifyLinkedDraft())).toEqual(emptyShopifyLinkedDraft()))
  it('does not report an untouched draft as dirty after reordered JSON keys or optional empty commands', () => {
    const base = emptyShopifyLinkedDraft()
    const received = { mediaEdits: [], ...Object.fromEntries(Object.entries(base).reverse()), nativeEdits: [] }
    expect(linkedDraftSignature(shopifyLinkedDraftSchema.parse(received))).toBe(linkedDraftSignature(base))
  })
  it('compares decimal formatting without losing precision or collapsing unset into zero', () => {
    expect(nativeValuesEqual('price', '00012.00', '12.0')).toBe(true)
    expect(nativeValuesEqual('price', '9007199254740993.01', '9007199254740993.02')).toBe(false)
    expect(nativeValuesEqual('compareAtPrice', null, '0')).toBe(false)
    expect(nativeValuesEqual('sku', '0012', '12')).toBe(false)
    expect(nativeValuesEqual('tags', '["Racing","Jacket"]', '["Jacket","Racing"]')).toBe(true)
    expect(nativeValuesEqual('other', '["Racing","Jacket"]', '["Jacket","Racing"]')).toBe(false)
  })
})
describe('Stable association ordering', () => {
  const ids = [1, 2, 3, 4].map(n => `gid://shopify/MediaImage/${n}`)
  it('moves third to first preserving the other relative positions', () => expect(moveMedia(ids, ids[2], 0)).toEqual([ids[2], ids[0], ids[1], ids[3]]))
  it('supports beginning, end, and no-op without changing the source list', () => {
    expect(moveMedia(ids, ids[0], 3)).toEqual([ids[1], ids[2], ids[3], ids[0]])
    expect(moveMedia(ids, ids[1], 1)).toEqual(ids)
    expect(ids[0]).toBe('gid://shopify/MediaImage/1')
  })
  it('creates sequential zero-based API moves, never URL swaps', () => {
    const after = [ids[2], ids[0], ids[3], ids[1]]
    expect(mediaMoves(ids, after)).toEqual([{ id: ids[2], newPosition: '0' }, { id: ids[3], newPosition: '2' }])
  })
  it('rejects duplicate, missing and added associations', () => {
    for (const nextValue of [[...ids, ids[0]], ids.slice(1), [ids[0], ids[0], ids[2], ids[3]]]) {
      expect(() => mediaMoves(ids, nextValue)).toThrow()
      expect(mediaOrderEditSchema.safeParse({ productId, ownerLabel: 'MOSS', value: ids, nextValue }).success).toBe(false)
    }
  })
})
describe('Shopify weight units (product sheet consistency, S1 item 6)', () => {
  const weight = informationRegistry(schema).find(f => f.id === 'weight')!
  it('reads every common spelling, in any case, as Shopify\'s code and never guesses another unit', () => {
    expect(SHOPIFY_WEIGHT_UNITS).toEqual(['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS'])
    for (const [spelling, code] of [['g', 'GRAMS'], ['Gram', 'GRAMS'], ['grams', 'GRAMS'], ['GRAMS', 'GRAMS'], ['kg', 'KILOGRAMS'], ['KG', 'KILOGRAMS'], ['kilograms', 'KILOGRAMS'],
      ['KILOGRAM', 'KILOGRAMS'], ['oz', 'OUNCES'], ['Ounces', 'OUNCES'], ['lb', 'POUNDS'], ['lbs', 'POUNDS'], ['POUNDS', 'POUNDS'], [' kg ', 'KILOGRAMS']]) expect(shopifyWeightUnit(spelling), spelling).toBe(code)
    for (const other of ['cm', 'stone', '', null, undefined, 3]) expect(shopifyWeightUnit(other)).toBeNull()
  })
  it('converts the unit only, keeps the number and the form it came in, and leaves anything else for the validator', () => {
    expect(normalizeShopifyWeight({ value: 1.2, unit: 'kg' })).toEqual({ value: 1.2, unit: 'KILOGRAMS' })
    expect(normalizeShopifyWeight('{"value":0,"unit":"g"}')).toBe('{"value":0,"unit":"GRAMS"}')
    const coded = { value: 3, unit: 'POUNDS' }
    expect(normalizeShopifyWeight(coded)).toBe(coded)
    for (const other of [{ value: 1, unit: 'cm' }, { value: 1 }, 'not json', '12', null, ['kg']]) expect(normalizeShopifyWeight(other)).toEqual(other)
  })
  it('shows symbols for the codes and compares weights in grams', () => {
    expect(SHOPIFY_WEIGHT_UNITS.map(shopifyWeightSymbol)).toEqual(['g', 'kg', 'oz', 'lb'])
    expect(shopifyWeightSymbol('furlongs')).toBe('furlongs')
    expect(shopifyWeightGrams({ value: 1.2, unit: 'KILOGRAMS' })).toBe(1200)
    expect(shopifyWeightGrams('{"value":1200,"unit":"GRAMS"}')).toBe(1200)
    expect(shopifyWeightGrams({ value: 1, unit: 'lb' })).toBe(453.592)
    expect(shopifyWeightGrams({ value: 1, unit: 'cm' })).toBeNull()
    expect(shopifyWeightGrams(null)).toBeNull()
  })
  it('the publish rule takes exactly Shopify\'s codes; the sheet value of a Shared weight is Shopify\'s JSON text', () => {
    for (const unit of SHOPIFY_WEIGHT_UNITS) expect(nativeFieldValueError('weight', JSON.stringify({ value: 1.2, unit }))).toBeNull()
    expect(nativeFieldValueError('weight', '{"value":1.2,"unit":"kg"}')).toMatch(/Shopify weight unit/)
    expect(informationSheetValue(weight, { value: 1.2, unit: 'kg' })).toBe('{"value":1.2,"unit":"KILOGRAMS"}')
    expect(informationSheetValue(weight, { value: 1.2, unit: 'KILOGRAMS' })).toBe('{"value":1.2,"unit":"KILOGRAMS"}')
    expect(informationSheetValue(weight, '{"value":1.2,"unit":"kg"}')).toBe('{"value":1.2,"unit":"KILOGRAMS"}')
    const odd = { value: 1, unit: 'cm' }
    expect(informationSheetValue(weight, odd)).toBe(odd)
  })
  it('refuses a handle with capitals with Shopify\'s reason', () => {
    expect(nativeFieldValueError('handle', 'moss-jacket')).toBeNull()
    expect(nativeFieldValueError('handle', 'Moss-Jacket')).toBe('Use lowercase letters, numbers and separating hyphens.')
  })
})

/* Wave 2 D3 (Owner decision 11, A) — the theme template: "nexus" for a product Nexus creates; cleared = the store's default. */
describe('the theme template', () => {
  it('a cleared template is stored as \'\' (Shopify reads the default template as \'\'), and sent as null', () => {
    expect(nativeWriteValue('templateSuffix', null)).toBe('')
    expect(nativeWriteValue('templateSuffix', 'custom')).toBe('custom')
    // Every other field keeps its null (a clear).
    expect(nativeWriteValue('seo.title', null)).toBeNull()
    expect([shopifyTemplateSuffixInput(''), shopifyTemplateSuffixInput(null), shopifyTemplateSuffixInput('nexus')]).toEqual([null, null, 'nexus'])
  })
  it('no value and \'\' are both the default template: valid, and equal', () => {
    expect(nativeFieldValueError('templateSuffix', null)).toBeNull()
    expect(nativeFieldValueError('templateSuffix', '')).toBeNull()
    expect(nativeFieldValueError('templateSuffix', 'not valid!')).toBe('Enter a template suffix, or leave it empty for the default template.')
    expect(nativeValuesEqual('templateSuffix', null, '')).toBe(true)
    expect(nativeValuesEqual('templateSuffix', 'nexus', '')).toBe(false)
    expect(nativeValuesEqual('seo.title', null, '')).toBe(false)
  })
  it('says what a new product uses and how to choose the store\'s default', () => {
    expect(SHOPIFY_NEXUS_TEMPLATE).toBe('nexus')
    expect(SHOPIFY_TEMPLATE_HINT).toBe('New products use the Nexus template (nexus). Clear it to use the store\'s default template.')
  })
})

describe('Shopify values in words (W3-4)', () => {
  it('Continue selling when out of stock reads Yes / No (Owner decision 10); the codes are the ones Publish accepts', () => {
    expect(shopifyInventoryPolicyLabel('CONTINUE')).toBe('Yes')
    expect(shopifyInventoryPolicyLabel('DENY')).toBe('No')
    expect(shopifyInventoryPolicyLabel('SOMETHING')).toBe('SOMETHING')
    for (const code of Object.keys(SHOPIFY_INVENTORY_POLICY_LABEL)) expect(nativeFieldValueError('inventoryPolicy', code)).toBeNull()
  })
  it('a unit price reads "200 ml, priced per 1 L"; a unit Nexus does not know stays as Shopify wrote it', () => {
    expect(shopifyUnitPriceLabel({ quantityValue: 200, quantityUnit: 'ML', referenceValue: 1, referenceUnit: 'L' })).toBe('200 ml, priced per 1 L')
    expect(shopifyUnitPriceLabel({ quantityValue: 6, quantityUnit: 'ITEM', referenceValue: 1, referenceUnit: 'ITEM' })).toBe('6 items, priced per 1 item')
    expect(shopifyUnitPriceSymbol('M2')).toBe('m²')
    expect(shopifyUnitPriceSymbol('UNKNOWN')).toBe('UNKNOWN')
  })
})

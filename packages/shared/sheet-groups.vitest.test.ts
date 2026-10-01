import { describe, it, expect } from 'vitest'
import { groupSheetColumns, isFlatFileGroupKey, sheetGroupTone, type GroupableColumn, type GroupableGroup } from './sheet-groups.js'

const col = (key: string, groupKey: string, group = groupKey): GroupableColumn => ({ key, group, groupKey })

/** The eBay · IT sheet as the server built it before the regrouping (GALE-JACKET, measured on :3650 2026-10-01). */
const EBAY_IT: GroupableColumn[] = [
  col('__productRole', 'master:relationships'), col('__parentSku', 'master:relationships'),
  col('variation_theme', 'master:identity'), col('categoryId', 'EBAY:classification'),
  col('name', 'EBAY:content'), col('description', 'EBAY:content'), col('subtitle', 'EBAY:content'), col('descriptionThemeId', 'EBAY:content'),
  col('brand', 'EBAY:aspects'), col('material', 'EBAY:aspects'), col('color', 'EBAY:aspects'), col('size', 'EBAY:aspects'),
  col('sharedSkuListing', 'EBAY:variations'), col('imageUrls', 'EBAY:images'), col('videoId', 'EBAY:images'),
  col('conditionId', 'EBAY:offer'), col('price', 'EBAY:offer'), col('quantity', 'EBAY:offer'), col('listingFormat', 'EBAY:offer'),
  col('listingDuration', 'EBAY:offer'), col('vatRate', 'EBAY:offer'), col('bestOffer', 'EBAY:offer'), col('bestOfferFloor', 'EBAY:offer'),
  col('bestOfferCeiling', 'EBAY:offer'),
  col('handlingTime', 'EBAY:shipping'), col('packageType', 'EBAY:shipping'), col('packageWeight', 'EBAY:shipping'), col('packageLength', 'EBAY:shipping'),
  col('packageWidth', 'EBAY:shipping'), col('packageHeight', 'EBAY:shipping'), col('dimensionUnit', 'EBAY:shipping'), col('itemLocation', 'EBAY:shipping'),
  col('itemLocationCountry', 'EBAY:shipping'), col('itemPostalCode', 'EBAY:shipping'),
  col('fulfillmentPolicyId', 'EBAY:policies'), col('returnPolicyId', 'EBAY:policies'), col('paymentPolicyId', 'EBAY:policies'),
  col('other_specific_athlete', 'EBAY:other-specifics'), col('other_specific_team_name', 'EBAY:other-specifics'),
]

const keysOf = (columns: GroupableColumn[], group: string) => columns.filter((c) => c.group === group).map((c) => c.key)

describe('groupSheetColumns — eBay, as the old eBay flat file', () => {
  const { columns, groups } = groupSheetColumns(EBAY_IT, [], 'EBAY')

  it('shows the flat file groups in the flat file order, each in its colour; an empty group is not shown', () => {
    expect(groups.map((g) => [g.label, g.tone])).toEqual([
      ['Identifiers', 'slate'], ['Listing', 'blue'], ['Content', 'purple'], ['Pricing', 'emerald'], ['Inventory', 'orange'],
      ['Package & Shipping', 'cyan'], ['Images', 'teal'], ['Policies', 'sky'], ['Item Specifics', 'teal'],
    ])
    expect(groups.every((g) => isFlatFileGroupKey(g.key))).toBe(true)
  })

  it('loses no column and keeps each group together', () => {
    expect(columns).toHaveLength(EBAY_IT.length)
    expect(new Set(columns.map((c) => c.key))).toEqual(new Set(EBAY_IT.map((c) => c.key)))
    const order = columns.map((c) => c.groupKey)
    expect(order).toEqual([...order].sort((a, b) => groups.findIndex((g) => g.key === a) - groups.findIndex((g) => g.key === b)))
  })

  it('puts each field where the flat file had it, in its order', () => {
    expect(keysOf(columns, 'Identifiers')).toEqual(['__productRole', '__parentSku'])
    expect(keysOf(columns, 'Listing')).toEqual(['name', 'conditionId', 'categoryId', 'variation_theme', 'sharedSkuListing', 'subtitle', 'listingFormat', 'listingDuration'])
    expect(keysOf(columns, 'Content')).toEqual(['description', 'descriptionThemeId'])
    expect(keysOf(columns, 'Pricing')).toEqual(['price', 'bestOffer', 'bestOfferFloor', 'bestOfferCeiling', 'vatRate'])
    expect(keysOf(columns, 'Inventory')).toEqual(['quantity', 'handlingTime'])
    expect(keysOf(columns, 'Package & Shipping')).toEqual(['itemLocationCountry', 'itemLocation', 'itemPostalCode', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit'])
    expect(keysOf(columns, 'Images')).toEqual(['imageUrls', 'videoId'])
    expect(keysOf(columns, 'Policies')).toEqual(['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'])
  })

  it('keeps every item specific in its incoming order, the other item specifics at the end', () => {
    expect(keysOf(columns, 'Item Specifics')).toEqual(['brand', 'material', 'color', 'size', 'other_specific_athlete', 'other_specific_team_name'])
    expect(columns.find((c) => c.key === 'brand')?.groupTone).toBe('teal')
  })

  it('puts a listing field it has no rule for in Listing, so nothing is ever lost', () => {
    const out = groupSheetColumns([...EBAY_IT, col('somethingNew', 'EBAY:offer')], [], 'EBAY')
    expect(out.columns.find((c) => c.key === 'somethingNew')?.group).toBe('Listing')
  })

  it('is idempotent: grouping a grouped sheet changes nothing', () => {
    const again = groupSheetColumns(columns, groups, 'EBAY')
    expect(again.columns).toEqual(columns)
    expect(again.groups).toEqual(groups)
  })
})

describe('groupSheetColumns — Amazon, as the old Amazon flat file', () => {
  const sourceGroups: GroupableGroup[] = [
    { key: 'AMAZON:classification', label: 'Classification', channelLabel: null, order: 0 },
    // Workflow order on the wire; the schema's own order is `sourceOrder`.
    { key: 'AMAZON:product_identity', label: 'Product identity', channelLabel: null, order: 1, sourceOrder: 1 },
    { key: 'AMAZON:product_details', label: 'Product details', channelLabel: null, order: 2, sourceOrder: 3 },
    { key: 'AMAZON:offer', label: 'Offer', channelLabel: null, order: 3, sourceOrder: 0 },
    { key: 'AMAZON:safety_and_compliance', label: 'Safety and compliance', channelLabel: null, order: 4, sourceOrder: 4 },
    { key: 'AMAZON:images', label: 'Images', channelLabel: null, order: 5, sourceOrder: 2 },
  ]
  const input = [
    col('__productRole', 'master:relationships'), col('__parentSku', 'master:relationships'), col('variation_theme', 'master:identity'),
    col('productType', 'AMAZON:classification'), col('brand', 'AMAZON:product_identity'), col('item_name', 'AMAZON:product_details'),
    col('parentage_level', 'AMAZON:variations'), col('child_parent_sku_relationship__parent_sku', 'AMAZON:variations'),
    col('main_product_image_locator', 'AMAZON:images'), col('list_price', 'AMAZON:offer'), col('warranty_description', 'AMAZON:safety_and_compliance'),
    col('loose_field', 'AMAZON'),
  ]
  const { columns, groups } = groupSheetColumns(input, sourceGroups, 'AMAZON')

  it('leads with Offer Identity and Variations, then the template groups in the SCHEMA order, then Other Attributes', () => {
    expect(groups.map((g) => g.label)).toEqual(['Offer Identity', 'Variations', 'Offer', 'Product Identity', 'Images', 'Product Details', 'Safety and compliance', 'Other Attributes'])
  })

  it('colours a template group by its schema position, as the flat file did (palette[position + 2])', () => {
    expect(groups.map((g) => g.tone)).toEqual(['blue', 'purple', 'emerald', 'orange', 'teal', 'amber', 'yellow', 'violet'])
  })

  it('puts the relationship, product type, theme and parentage columns in the two fixed groups', () => {
    expect(keysOf(columns, 'Offer Identity')).toEqual(['__productRole', '__parentSku', 'productType'])
    expect(keysOf(columns, 'Variations')).toEqual(['variation_theme', 'parentage_level', 'child_parent_sku_relationship__parent_sku'])
    expect(keysOf(columns, 'Other Attributes')).toEqual(['loose_field'])
    expect(columns).toHaveLength(input.length)
  })
})

describe('groupSheetColumns — Shared, Shopify and Etsy keep their groups', () => {
  it('changes no group and no order, and colours each group by what it holds', () => {
    const input = [col('__productRole', 'master:relationships', 'Product relationships'), col('name', 'master:identity', 'Identity'),
      col('description', 'master:content', 'Content'), col('basePrice', 'master:pricing', 'Pricing'), col('weightValue', 'master:physical', 'Dimensions and weight')]
    const { columns } = groupSheetColumns(input, [], null)
    expect(columns.map((c) => [c.key, c.group, c.groupKey])).toEqual(input.map((c) => [c.key, c.group, c.groupKey]))
    expect(columns.map((c) => c.groupTone)).toEqual(['slate', 'slate', 'purple', 'emerald', 'cyan'])
  })

  it('names a colour for every group a scope can show', () => {
    expect(sheetGroupTone('SHOPIFY:seo', 'SEO')).toBe('purple')
    expect(sheetGroupTone('SHOPIFY:inventory', 'Inventory')).toBe('orange')
    expect(sheetGroupTone('SHOPIFY:product-metafields', 'Product metafields')).toBe('teal')
    expect(sheetGroupTone('master:compliance', 'Compliance and traceability')).toBe('red')
    expect(sheetGroupTone('media', 'Media')).toBe('teal')
    expect(sheetGroupTone('progress', 'Progress')).toBe('slate')
    expect(sheetGroupTone('x', 'Something else')).toBe('violet')
  })
})

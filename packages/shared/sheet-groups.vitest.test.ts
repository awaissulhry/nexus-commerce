import { describe, it, expect } from 'vitest'
import { SHEET_GROUPS, SHEET_TONES, groupSheetColumns, isSheetGroupKey, sheetGroupOf, type GroupableColumn } from './sheet-groups.js'

const col = (key: string, groupKey: string, group = groupKey): GroupableColumn => ({ key, group, groupKey })
const keysOf = (columns: GroupableColumn[], group: string) => columns.filter((c) => c.group === group).map((c) => c.key)

/** The Amazon names, in the order the Amazon sheet showed them (Owner, 2026-10-01: "We follow the names … in the Amazon scope"). */
const AMAZON_ORDER = ['Offer Identity', 'Variations', 'Offer', 'Images', 'Shipping', 'Product Details', 'Product Identity', 'Safety and compliance']

describe('the groups', () => {
  it('are the Amazon names in the Amazon order, then Metafields (Shopify\'s own) and Other Attributes', () => {
    expect(Object.values(SHEET_GROUPS).map((g) => g.label)).toEqual([...AMAZON_ORDER, 'Metafields', 'Other Attributes'])
    expect(Object.values(SHEET_GROUPS).every((g) => isSheetGroupKey(g.key))).toBe(true)
  })

  it('give every group its own colour — no two groups share a hue (Owner: colours "look similar")', () => {
    const tones = Object.values(SHEET_GROUPS).map((g) => g.tone)
    expect(new Set(tones).size).toBe(tones.length)
    expect([...tones].sort()).toEqual([...SHEET_TONES].sort())
  })
})

/** The eBay · IT sheet as the server built it before the regrouping (GALE-JACKET, measured on :3650 2026-10-01). */
const EBAY_IT: GroupableColumn[] = [
  col('__productRole', 'master:relationships'), col('__parentSku', 'master:relationships'),
  col('variation_theme', 'master:identity'), col('categoryId', 'EBAY:classification'),
  col('name', 'EBAY:content'), col('description', 'EBAY:content'), col('subtitle', 'EBAY:content'), col('descriptionThemeId', 'EBAY:content'),
  col('brand', 'EBAY:aspects'), col('material', 'EBAY:aspects'), col('paese_di_origine', 'EBAY:aspects'),
  col('sharedSkuListing', 'EBAY:variations'), col('imageUrls', 'EBAY:images'), col('videoId', 'EBAY:images'),
  col('conditionId', 'EBAY:offer'), col('price', 'EBAY:offer'), col('quantity', 'EBAY:offer'), col('listingFormat', 'EBAY:offer'),
  col('listingDuration', 'EBAY:offer'), col('vatRate', 'EBAY:offer'), col('bestOffer', 'EBAY:offer'), col('bestOfferFloor', 'EBAY:offer'),
  col('bestOfferCeiling', 'EBAY:offer'),
  col('handlingTime', 'EBAY:shipping'), col('packageType', 'EBAY:shipping'), col('packageWeight', 'EBAY:shipping'), col('packageLength', 'EBAY:shipping'),
  col('packageWidth', 'EBAY:shipping'), col('packageHeight', 'EBAY:shipping'), col('dimensionUnit', 'EBAY:shipping'), col('itemLocation', 'EBAY:shipping'),
  col('itemLocationCountry', 'EBAY:shipping'), col('itemPostalCode', 'EBAY:shipping'),
  col('fulfillmentPolicyId', 'EBAY:policies'), col('returnPolicyId', 'EBAY:policies'), col('paymentPolicyId', 'EBAY:policies'),
  col('other_specific_athlete', 'EBAY:other-specifics'),
]

describe('groupSheetColumns — eBay, in the Amazon names', () => {
  const { columns, groups } = groupSheetColumns(EBAY_IT, 'EBAY')

  it('shows the Amazon names in the Amazon order; a group with nothing in it is not shown', () => {
    expect(groups.map((g) => g.label)).toEqual(['Offer Identity', 'Variations', 'Offer', 'Images', 'Shipping', 'Product Details'])
  })

  it('loses no column and keeps each group together', () => {
    expect(columns).toHaveLength(EBAY_IT.length)
    const order = columns.map((c) => c.groupKey)
    expect(order).toEqual([...order].sort((a, b) => groups.findIndex((g) => g.key === a) - groups.findIndex((g) => g.key === b)))
  })

  it('puts eBay\'s fields where Amazon keeps their kind, in the old eBay flat file\'s order inside each group', () => {
    expect(keysOf(columns, 'Offer Identity')).toEqual(['__productRole', '__parentSku', 'categoryId'])
    expect(keysOf(columns, 'Variations')).toEqual(['variation_theme', 'sharedSkuListing'])
    expect(keysOf(columns, 'Offer')).toEqual(['conditionId', 'listingFormat', 'listingDuration', 'price', 'bestOffer', 'bestOfferFloor', 'bestOfferCeiling', 'vatRate', 'quantity', 'handlingTime', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'])
    expect(keysOf(columns, 'Images')).toEqual(['imageUrls', 'videoId'])
    expect(keysOf(columns, 'Shipping')).toEqual(['itemLocationCountry', 'itemLocation', 'itemPostalCode', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit'])
  })

  it('makes the item specifics Product Details, after the title and description, whatever an aspect is called', () => {
    expect(keysOf(columns, 'Product Details')).toEqual(['name', 'subtitle', 'description', 'descriptionThemeId', 'brand', 'material', 'paese_di_origine', 'other_specific_athlete'])
  })

  it('is idempotent', () => {
    const again = groupSheetColumns(columns, 'EBAY')
    expect(again.columns).toEqual(columns)
    expect(again.groups).toEqual(groups)
  })
})

describe('groupSheetColumns — Amazon', () => {
  const input = [
    col('__productRole', 'master:relationships'), col('__parentSku', 'master:relationships'), col('variation_theme', 'master:identity'),
    col('productType', 'AMAZON:classification'), col('brand', 'AMAZON:product_identity'), col('name', 'AMAZON:product_identity'), col('item_type_name', 'AMAZON:product_details'),
    col('parentage_level', 'AMAZON:variations'), col('child_parent_sku_relationship__parent_sku', 'AMAZON:variations'),
    col('main_product_image_locator', 'AMAZON:images'), col('list_price', 'AMAZON:offer'), col('warranty_description', 'AMAZON:safety_and_compliance'),
    col('item_package_weight', 'AMAZON:shipping'), col('purchasable_offer', 'AMAZON:offer_APJ6JRA9NG5V4'), col('loose_field', 'AMAZON'),
  ]
  const { columns, groups } = groupSheetColumns(input, 'AMAZON')

  it('keeps every Amazon group under its own name, in the fixed order, and the loose fields in Other Attributes', () => {
    expect(groups.map((g) => g.label)).toEqual([...AMAZON_ORDER, 'Other Attributes'])
    expect(keysOf(columns, 'Offer Identity')).toEqual(['__productRole', '__parentSku', 'productType'])
    expect(keysOf(columns, 'Variations')).toEqual(['variation_theme', 'parentage_level', 'child_parent_sku_relationship__parent_sku'])
    expect(keysOf(columns, 'Offer')).toEqual(['list_price', 'purchasable_offer'])
    expect(keysOf(columns, 'Other Attributes')).toEqual(['loose_field'])
    // Amazon's own placement wins on its sheet: its item name (the sheet's Title) is a Product Identity field.
    expect(keysOf(columns, 'Product Identity')).toEqual(['brand', 'name'])
    expect(keysOf(columns, 'Product Details')).toEqual(['item_type_name'])
    expect(columns).toHaveLength(input.length)
  })
})

describe('groupSheetColumns — Shared, Shopify and Etsy', () => {
  const shared = [
    col('__productRole', 'master:relationships', 'Product relationships'), col('__parentSku', 'master:relationships', 'Product relationships'),
    col('variation_theme', 'master:identity', 'Identity'), col('name', 'master:identity', 'Identity'), col('brand', 'master:identity', 'Identity'),
    col('productType', 'master:classification', 'Classification'),
    col('description', 'master:content', 'Content'), col('material', 'master:attributes', 'Specifications'),
    col('gtin', 'master:identifiers', 'Identifiers'), col('ean', 'master:identifiers', 'Identifiers'),
    col('weightValue', 'master:physical', 'Dimensions and weight'), col('notifiedBodyName', 'master:compliance', 'Compliance and traceability'),
    col('basePrice', 'master:pricing', 'Pricing'), col('totalStock', 'master:inventory', 'Inventory'),
    col('legacy_note', 'master:legacy', 'Additional saved attributes'), col('fit', 'master:specifications', 'Specifications'),
    col('season', 'master:information_shared', 'Shared specifications'),
  ]
  const { columns, groups } = groupSheetColumns(shared, null)

  it('keeps everything about identity in ONE group, Offer Identity (Owner: keep the fold, Amazon\'s name)', () => {
    expect(keysOf(columns, 'Offer Identity')).toEqual(['variation_theme', '__productRole', '__parentSku', 'productType', 'name', 'brand', 'gtin', 'ean'])
  })

  it('puts the Shared groups under the Amazon names — one Product Details for the content and every specifications group', () => {
    expect(groups.map((g) => g.label)).toEqual(['Offer Identity', 'Offer', 'Shipping', 'Product Details', 'Safety and compliance'])
    expect(keysOf(columns, 'Product Details')).toEqual(['description', 'material', 'legacy_note', 'fit', 'season'])
    expect(keysOf(columns, 'Offer')).toEqual(['basePrice', 'totalStock'])
    expect(keysOf(columns, 'Shipping')).toEqual(['weightValue'])
    expect(keysOf(columns, 'Safety and compliance')).toEqual(['notifiedBodyName'])
  })

  it('keeps Shopify\'s metafields as their own group, product, variant and category together', () => {
    const shopify = groupSheetColumns([
      col('__productRole', 'master:relationships'), col('variation_theme', 'master:identity'), col('name', 'SHOPIFY:general', 'General'),
      col('shopify_metafield:a', 'SHOPIFY:product_metafields', 'Product metafields'), col('shopify_metafield:b', 'SHOPIFY:variant_metafields', 'Variant metafields'),
      col('shopify_metafield:c', 'SHOPIFY:category_metafields', 'Category metafields'), col('seo_title', 'SHOPIFY:seo', 'SEO'), col('price', 'SHOPIFY:pricing', 'Pricing'),
    ], 'SHOPIFY')
    expect(shopify.groups.map((g) => g.label)).toEqual(['Offer Identity', 'Offer', 'Product Details', 'Metafields'])
    expect(keysOf(shopify.columns, 'Metafields')).toEqual(['shopify_metafield:a', 'shopify_metafield:b', 'shopify_metafield:c'])
    expect(keysOf(shopify.columns, 'Offer Identity')).toEqual(['variation_theme', '__productRole'])
  })

  it('puts Etsy\'s groups under the Amazon names too', () => {
    const etsy = (key: string) => sheetGroupOf(col('x', `ETSY:${key}`), 'ETSY').label
    expect(['content', 'classification', 'search', 'offer', 'shipping', 'policies', 'listing_status', 'category_attributes'].map(etsy))
      .toEqual(['Product Details', 'Offer Identity', 'Product Details', 'Offer', 'Shipping', 'Offer', 'Offer', 'Product Details'])
  })
})

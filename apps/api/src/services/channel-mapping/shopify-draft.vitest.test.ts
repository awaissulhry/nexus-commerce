import { describe, expect, it } from 'vitest'
import { activationBlocker, mappingCounts, shopifyMetafieldColumn } from '@nexus/shared/channel-mapping'
import { buildShopifyDraftFields, shopifyChannelKeyOf, shopifyColumnOf } from './shopify-draft.js'
import { formLabel, shopifyFormOf } from './form.js'
import { SHOPIFY_CSV_COLUMNS } from './defaults.js'

/** The Owner's export's header, as measured (study §7): 77 columns, classic names, 25 product metafields. */
const CLASSIC = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published', 'Option1 Name', 'Option1 Value', 'Option1 Linked To',
  'Option2 Name', 'Option2 Value', 'Option2 Linked To', 'Option3 Name', 'Option3 Value', 'Option3 Linked To', 'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker',
  'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable',
  'Unit Price Total Measure', 'Unit Price Total Measure Unit', 'Unit Price Base Measure', 'Unit Price Base Measure Unit', 'Variant Barcodes', 'Image Src', 'Image Position',
  'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description', 'Google Shopping / Google Product Category', 'Google Shopping / Gender', 'Features (product.metafields.custom.features)',
  'Variant Image', 'Variant Weight Unit', 'Variant Tax Code', 'Cost per item', 'Status']

describe('NCF N1 — Shopify product CSV contract', () => {
  it('keys a column by its classic name, whatever generation of header names the file uses', () => {
    expect(shopifyChannelKeyOf('URL handle')).toBe('Handle')
    expect(shopifyChannelKeyOf('Description')).toBe('Body (HTML)')
    expect(shopifyChannelKeyOf('SKU')).toBe('Variant SKU')
    expect(shopifyChannelKeyOf('Compare-at price')).toBe('Variant Compare At Price')
    expect(shopifyChannelKeyOf('Barcode')).toBe('Variant Barcodes')
    // Headers are case-sensitive (Shopify S2): an unknown spelling stays itself and is unmapped.
    expect(shopifyColumnOf('handle')).toEqual({ kind: 'unknown', channelKey: 'handle' })
  })

  it('keys a product metafield by its address, not its label', () => {
    expect(shopifyMetafieldColumn('Features (product.metafields.custom.features)')).toEqual({ label: 'Features', owner: 'product', namespace: 'custom', key: 'features' })
    expect(shopifyChannelKeyOf('Renamed label (product.metafields.custom.features)')).toBe('metafield:product.custom.features')
    expect(shopifyChannelKeyOf('Color (product.metafields.shopify.color-pattern)')).toBe('metafield:product.shopify.color-pattern')
    expect(shopifyMetafieldColumn('Title')).toBeNull()
  })

  it('names one form per store, whatever the header generation (same columns, same order → same fingerprint)', () => {
    const current = CLASSIC.map(h => SHOPIFY_CSV_COLUMNS.columns.find(c => c.header === h)?.aliases[0] ?? h)
    const a = shopifyFormOf({ accountId: 'store-1', channelKeys: CLASSIC.map(shopifyChannelKeyOf) })
    const b = shopifyFormOf({ accountId: 'store-1', channelKeys: current.map(shopifyChannelKeyOf) })
    expect(a).toMatchObject({ channel: 'SHOPIFY', marketplace: 'GLOBAL', formKind: 'SHOPIFY_PRODUCT_CSV', formKey: 'store-1' })
    expect(b.keyFingerprint).toBe(a.keyFingerprint)
    expect(shopifyFormOf({ accountId: 'store-1', channelKeys: CLASSIC.slice(1).map(shopifyChannelKeyOf) }).keyFingerprint).not.toBe(a.keyFingerprint)
    expect(formLabel(a, 2, 'ACTIVE')).toBe('Shopify · product CSV · v2 (active)')
  })

  it('decides every column by the table: identities, price door, stock, lifecycle, media, metafields', () => {
    const rows = buildShopifyDraftFields(CLASSIC)
    const by = new Map(rows.map(r => [r.channelKey, r]))
    expect(rows).toHaveLength(CLASSIC.length)
    expect(by.get('Handle')).toMatchObject({ targetKind: 'identity', targetKey: 'handle', state: 'mapped', requirement: 'required' })
    expect(by.get('Variant SKU')).toMatchObject({ targetKind: 'identity', targetKey: 'sku', state: 'mapped' })
    expect(by.get('Title')).toMatchObject({ targetKind: 'channelField', targetKey: 'title', requirement: 'required' })
    expect(by.get('SEO Title')).toMatchObject({ targetKind: 'channelField', targetKey: 'seo_title' })
    expect(by.get('Variant Barcodes')).toMatchObject({ targetKind: 'channelField', targetKey: 'barcode' })
    expect(by.get('Variant Grams')).toMatchObject({ targetKey: 'weight', transform: [{ op: 'measure', part: 'value' }, { op: 'number' }] })
    expect(by.get('Variant Weight Unit')).toMatchObject({ targetKey: 'weight', transform: [{ op: 'measure', part: 'unit' }] })
    expect(by.get('Variant Price')).toMatchObject({ targetKind: 'price', state: 'mapped' })
    expect(by.get('Variant Compare At Price')).toMatchObject({ targetKind: 'compareAt', targetKey: 'compareAtPrice', state: 'mapped' })
    for (const stock of ['Variant Inventory Qty', 'Variant Inventory Tracker', 'Variant Fulfillment Service']) expect(by.get(stock)).toMatchObject({ targetKind: 'quantity', state: 'managed' })
    for (const life of ['Status', 'Published']) expect(by.get(life)).toMatchObject({ targetKind: 'lifecycle', state: 'managed' })
    for (const media of ['Image Src', 'Image Position', 'Image Alt Text', 'Variant Image']) expect(by.get(media)).toMatchObject({ targetKind: 'image', state: 'managed' })
    expect(by.get('Option1 Value')).toMatchObject({ targetKind: 'relationship', state: 'managed' })
    expect(by.get('Google Shopping / Gender')).toMatchObject({ state: 'ignored' })
    expect(by.get('metafield:product.custom.features')).toMatchObject({ targetKind: 'channelField', targetKey: 'metafield:PRODUCT:custom.features', label: 'Features', columnKey: 'Features (product.metafields.custom.features)' })
    // Nothing is left for the Owner to decide in the measured file, and nothing required is open.
    expect(mappingCounts(rows).unmapped).toBe(0)
    expect(activationBlocker(rows)).toBeNull()
  })

  it('leaves an unknown column unmapped and a variant metafield ignored, with the reason', () => {
    const rows = buildShopifyDraftFields(['Handle', 'Title', 'Lining', 'Fit (variant.metafields.custom.fit)'])
    expect(rows.find(r => r.channelKey === 'Lining')).toMatchObject({ state: 'unmapped', targetKind: 'none' })
    expect(rows.find(r => r.channelKey === 'metafield:variant.custom.fit')).toMatchObject({ state: 'ignored' })
  })
})

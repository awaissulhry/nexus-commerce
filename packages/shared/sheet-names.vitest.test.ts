import { describe, it, expect } from 'vitest'
import { SHEET_NAMES, fieldNameFromKey, formerNamesOf, sentenceCase, sheetName } from './sheet-names.js'

describe('sheetName — one name for one thing (W3-6)', () => {
  it('names the product Title on every scope', () => {
    for (const scope of ['shared', 'AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const) expect(sheetName('name', scope)).toBe('Title')
  })

  it('says Base price on Shared and Price on a channel', () => {
    expect(sheetName('basePrice', 'shared')).toBe('Base price')
    for (const scope of ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const) expect(sheetName('basePrice', scope)).toBe('Price')
    expect(sheetName('price', 'EBAY')).toBe('Price')
  })

  it('says Vendor for the brand on Shopify only', () => {
    expect(sheetName('brand', 'SHOPIFY')).toBe('Vendor')
    expect(sheetName('brand', 'shared')).toBe('Brand')
    expect(sheetName('brand', 'EBAY')).toBe('Brand')
  })

  it('says Stock on Shared, Qty on a channel, and Available / On hand on Shopify', () => {
    expect(sheetName('totalStock', 'shared')).toBe('Stock')
    expect(sheetName('quantity', 'EBAY')).toBe('Qty')
    expect(sheetName('quantity', 'ETSY')).toBe('Qty')
    expect(sheetName('fulfillment_availability__quantity', 'AMAZON')).toBe('Qty')
    expect(sheetName('fulfillment_availability__quantity', 'shared')).toBeUndefined()
    expect(sheetName('availableQuantity', 'SHOPIFY')).toBe('Available')
    expect(sheetName('onHandQuantity', 'SHOPIFY')).toBe('On hand')
  })

  it('names eBay\'s unit-price parts as such, not as stock', () => {
    expect(sheetName('quantita', 'EBAY')).toBe('Unit quantity')
    expect(sheetName('unita_di_misura', 'EBAY')).toBe('Unit type')
  })

  it('drops the "Amazon " prefix inside the Amazon scope and keeps it on Shared', () => {
    expect(sheetName('parentage_level', 'AMAZON')).toBe('Listing role')
    expect(sheetName('child_parent_sku_relationship__parent_sku', 'AMAZON')).toBe('Parent SKU')
    expect(sheetName('child_parent_sku_relationship__child_relationship_type', 'AMAZON')).toBe('Relationship type')
    expect(sheetName('parentage_level', 'shared')).toBe('Saved Amazon parentage level')
    expect(sheetName('child_parent_sku_relationship__parent_sku', 'shared')).toBe('Amazon parent SKU')
    expect(sheetName('productType', 'shared')).toBe('Amazon product type (default)')
    expect(sheetName('productType', 'AMAZON')).toBe('Product type')
  })

  it('names the Amazon DE fields', () => {
    expect(sheetName('uvp_list_price', 'AMAZON')).toBe('List price (UVP)')
    expect(sheetName('epr_eco_fee_eubr', 'AMAZON')).toBe('EPR eco fee (EUBR)')
  })

  it('writes every name in sentence case: only the first word, acronyms and brand names start with a capital', () => {
    const names = Object.values(SHEET_NAMES).flatMap((e) => [e.all, e.shared, e.channel, e.AMAZON, e.EBAY, e.SHOPIFY, e.ETSY]).filter((n): n is string => !!n)
    const allowed = new Set(['Amazon', 'SKU', 'ID', 'UVP', 'EPR', 'EUBR'])
    for (const name of names) {
      const words = name.replace(/[()%]/g, '').split(/\s+/).filter(Boolean).slice(1)
      for (const word of words) if (/^[A-Z]/.test(word)) expect(allowed.has(word), `${name}: ${word}`).toBe(true)
    }
  })

  it('leaves a key it does not name to its source', () => {
    expect(sheetName('material', 'EBAY')).toBeUndefined()
    expect(sheetName('constructor', 'shared')).toBeUndefined()
    expect(formerNamesOf('constructor')).toEqual([])
  })
})

describe('formerNamesOf — the names a typed match still accepts', () => {
  it('keeps the old names of a renamed column', () => {
    expect(formerNamesOf('name')).toContain('Name')
    expect(formerNamesOf('quantita')).toContain('Quantity')
    expect(formerNamesOf('price')).toContain('Listing price')
    expect(formerNamesOf('parentage_level')).toContain('Amazon listing role')
  })
})

describe('fieldNameFromKey — a readable name when only a key is known', () => {
  it('reads the table first', () => {
    expect(fieldNameFromKey('child_parent_sku_relationship__parent_sku', 'AMAZON')).toBe('Parent SKU')
    expect(fieldNameFromKey('attr_uvp_list_price')).toBe('List price (UVP)')
    expect(fieldNameFromKey('name')).toBe('Title')
  })

  it('puts a key in words: sentence case, acronyms and brand names kept', () => {
    expect(fieldNameFromKey('fabric_type')).toBe('Fabric type')
    expect(fieldNameFromKey('ebayItemId')).toBe('eBay item ID')
    expect(fieldNameFromKey('imageUrls')).toBe('Image URLs')
    expect(fieldNameFromKey('gpsr_manufacturer_reference')).toBe('GPSR manufacturer reference')
    expect(fieldNameFromKey('EPR_ECO_FEE')).toBe('EPR eco fee')
  })

  it('reads a compound Amazon key as "Parent · Leaf"', () => {
    expect(fieldNameFromKey('epr_eco_fee_eubr__currency')).toBe('EPR eco fee (EUBR) · Currency')
    expect(fieldNameFromKey('compliance_media__content_language')).toBe('Compliance media · Content language')
  })
})

// W3-2 (Owner decision 12) — Amazon's own English titles read like every other name on the sheet.
describe('sentenceCase — a channel\'s English title in sentence case', () => {
  it.each([
    ['Outer Material Type', 'Outer material type'],
    ['Item Name', 'Item name'],
    ['Supplier Declared DG HZ Regulation', 'Supplier declared DG HZ regulation'],
    ['Country/Region of Origin', 'Country/region of origin'],
    ['UNSPSC Code', 'UNSPSC code'],
    ['Is Expiration Dated Product', 'Is expiration dated product'],
    ['California Proposition 65 Warning Type', 'California proposition 65 warning type'],
    ['Batteries Required?', 'Batteries required?'],
    ['Ebay Item Id', 'eBay item ID'],
    ['iPhone Model', 'iPhone model'],
    ['  Fit Type ', 'Fit type'],
  ])('%s → %s', (title, expected) => {
    expect(sentenceCase(title)).toBe(expected)
  })
})

/** Read live — the Amazon reader on anonymised Listings Items answers (no network). */
import { describe, expect, it } from 'vitest'
import { readAmazonListing, type AmazonListingRead } from './amazon.js'

const MP = 'MKT-IT'
const destination = { productId: 'family', channel: 'AMAZON' as const, marketplace: 'IT', accountId: 'account', aliasKey: '',
  expectedSkus: ['FAM-M', 'FAM-L', 'FAM-XL'], parentSku: 'FAM', marketplaceId: MP, languageTag: 'it_IT' }
const parent = { summaries: [{ marketplaceId: MP, productType: 'COAT' }], attributes: {
  item_name: [{ value: 'Giacca', language_tag: 'it_IT', marketplace_id: MP }, { value: 'Jacket', language_tag: 'en_GB', marketplace_id: MP }],
  bullet_point: [{ value: 'Calda', language_tag: 'it_IT', marketplace_id: MP }, { value: 'Leggera', language_tag: 'it_IT', marketplace_id: MP }],
  brand: [{ value: 'Brand', marketplace_id: MP }], variation_theme: [{ name: 'SIZE_NAME/COLOR', marketplace_id: MP }] } }
const child = (size: string, quantity?: number) => ({ summaries: [{ marketplaceId: MP, productType: 'COAT' }], attributes: {
    apparel_size: [{ size: size, size_system: 'as4', marketplace_id: MP }], color: [{ value: 'Nero', language_tag: 'it_IT', marketplace_id: MP }] },
  offers: [{ marketplaceId: MP, offerType: 'B2C', price: { amount: 49.9, currencyCode: 'EUR' } }],
  fulfillmentAvailability: quantity === undefined ? [{ fulfillmentChannelCode: 'AMAZON_EU' }] : [{ fulfillmentChannelCode: 'DEFAULT', quantity }] })
// Schema: `size_name` does not exist; the segment binds to the structured apparel_size member; `color` exists as is.
const properties = { color: {}, brand: {}, apparel_size: { items: { properties: { size: {}, size_system: {} } } } }
function reads(listings: Record<string, AmazonListingRead>, schema: Record<string, unknown> | null = properties) {
  return { listing: async (sku: string) => listings[sku] ?? { status: 'absent' as const }, schemaProperties: async () => schema }
}
const found = (raw: object): AmazonListingRead => ({ status: 'found', raw })
const now = () => new Date('2026-09-26T21:00:00Z')

describe('readAmazonListing', () => {
  it('parent content by review field ids; child values through the schema binding; price; merchant stock', async () => {
    const read = await readAmazonListing(destination, reads({ FAM: found(parent), 'FAM-M': found(child('m', 4)), 'FAM-L': found(child('l')) }), now)
    expect(read.content).toEqual({
      'item_name:["MKT-IT","it_IT"]': { state: 'value', value: ['Giacca'] },
      'bullet_point:["MKT-IT","it_IT"]': { state: 'value', value: ['Calda', 'Leggera'] },
      brand: { state: 'value', value: [{ value: 'Brand', marketplace_id: MP }] },
      variation_theme: { state: 'value', value: [{ name: 'SIZE_NAME/COLOR', marketplace_id: MP }] } })
    expect(read.variations).toEqual({ axes: ['SIZE_NAME', 'COLOR'], order: { SIZE_NAME: ['m', 'l'], COLOR: ['Nero'] }, variants: [
      { sku: 'FAM-M', values: { SIZE_NAME: 'm', COLOR: 'Nero' }, price: { state: 'value', value: { amount: '49.9', currency: 'EUR' } }, stock: { state: 'value', value: 4 }, state: 'live' },
      { sku: 'FAM-L', values: { SIZE_NAME: 'l', COLOR: 'Nero' }, price: { state: 'value', value: { amount: '49.9', currency: 'EUR' } },
        stock: { state: 'unread', reason: 'Amazon reports no merchant quantity for this SKU (Amazon-fulfilled or not set).' }, state: 'live' },
      { sku: 'FAM-XL', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'missing' }] })
    expect(read.errors).toEqual([])
    expect(read.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('without a cached schema the values are not guessed: an addressed error, no values', async () => {
    const read = await readAmazonListing(destination, reads({ FAM: found(parent), 'FAM-M': found(child('m', 4)) }, null), now)
    expect(read.errors).toEqual([{ scope: 'field', field: 'variation_theme', reason: 'The product-type schema is not cached; the variation values cannot be bound to their attributes.' }])
    expect(read.variations!.variants[0].values).toEqual({})
  })

  it('a failed child read is addressed to that SKU; a failed parent read makes the content "could not read"', async () => {
    const child500 = await readAmazonListing(destination, reads({ FAM: found(parent), 'FAM-M': { status: 'error', reason: 'HTTP 500' } }), now)
    expect(child500.errors).toContainEqual({ scope: 'sku', sku: 'FAM-M', reason: 'HTTP 500' })
    expect(child500.variations!.variants[0]).toMatchObject({ sku: 'FAM-M', stock: { state: 'unread' }, state: 'live' })
    const parent500 = await readAmazonListing(destination, reads({ FAM: { status: 'error', reason: 'HTTP 503' } }), now)
    expect(parent500).toMatchObject({ revision: null, variations: null, errors: [{ scope: 'item', reason: 'HTTP 503' }] })
    expect(parent500.content['item_name:["MKT-IT","it_IT"]']).toEqual({ state: 'unread', reason: 'HTTP 503' })
  })

  it('a parent Amazon does not list is a measured absence, not a read failure', async () => {
    const read = await readAmazonListing(destination, reads({}), now)
    expect(read.content).toEqual({})
    expect(read.errors).toEqual([{ scope: 'item', reason: 'The parent seller SKU is not listed on Amazon in this marketplace.' }])
  })
})

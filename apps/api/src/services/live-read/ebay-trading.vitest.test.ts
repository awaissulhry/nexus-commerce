/** Read live — the eBay Trading reader on an anonymised GetItem document (no network). */
import { describe, expect, it } from 'vitest'
import { readEbayTradingListing } from './ebay-trading.js'
import { ebayLiveContentRevision } from '../pim/studio-publication-ebay.js'

const destination = { productId: 'family', channel: 'EBAY' as const, marketplace: 'IT', accountId: 'account', aliasKey: 'alias-1', expectedSkus: ['FAM-M', 'FAM-L', 'FAM-XL'], itemId: '9000000002' }
const xml = (itemId = '9000000002') => `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item>
<ItemID>${itemId}</ItemID><Title>Jacket</Title><Description>&lt;p&gt;Warm&lt;/p&gt;</Description>
<PictureDetails><PictureURL>https://img.example/1.jpg</PictureURL><PictureURL>https://img.example/2.jpg</PictureURL></PictureDetails>
<ItemSpecifics><NameValueList><Name>Marca</Name><Value>Brand</Value></NameValueList><NameValueList><Name>Materiale</Name><Value>Pelle</Value><Value>Tessuto</Value></NameValueList></ItemSpecifics>
<Variations><VariationSpecificsSet><NameValueList><Name>Taglia</Name><Value>M</Value><Value>L</Value></NameValueList></VariationSpecificsSet>
<Variation><SKU>FAM-M</SKU><StartPrice currencyID="EUR">19.90</StartPrice><Quantity>10</Quantity><SellingStatus><QuantitySold>7</QuantitySold></SellingStatus><VariationSpecifics><NameValueList><Name>Taglia</Name><Value>M</Value></NameValueList></VariationSpecifics></Variation>
<Variation><SKU>FAM-L</SKU><StartPrice currencyID="EUR">21.90</StartPrice><Quantity>2</Quantity><SellingStatus><QuantitySold>0</QuantitySold></SellingStatus><VariationSpecifics><NameValueList><Name>Taglia</Name><Value>L</Value></NameValueList></VariationSpecifics></Variation>
<Variation><SKU>OTHER-S</SKU><StartPrice currencyID="EUR">18.00</StartPrice><VariationSpecifics><NameValueList><Name>Taglia</Name><Value>S</Value></NameValueList></VariationSpecifics></Variation>
</Variations></Item></GetItemResponse>`
const now = () => new Date('2026-09-26T21:00:00Z')

describe('readEbayTradingListing', () => {
  it('reads content, eBay axis names and order, price, and AVAILABLE stock (Quantity − QuantitySold)', async () => {
    const read = await readEbayTradingListing(destination, { getItem: async () => ({ xml: xml() }) }, now)
    expect(read.content).toEqual({ title: { state: 'value', value: 'Jacket' }, description: { state: 'value', value: '<p>Warm</p>' },
      pictures: { state: 'value', value: ['https://img.example/1.jpg', 'https://img.example/2.jpg'] },
      'aspect:marca': { state: 'value', value: ['Brand'] }, 'aspect:materiale': { state: 'value', value: ['Pelle', 'Tessuto'] } })
    expect(read.variations).toEqual({ axes: ['Taglia'], order: { Taglia: ['M', 'L'] }, variants: [
      { sku: 'FAM-M', values: { Taglia: 'M' }, price: { state: 'value', value: { amount: '19.90', currency: 'EUR' } }, stock: { state: 'value', value: 3 }, state: 'live' },
      { sku: 'FAM-L', values: { Taglia: 'L' }, price: { state: 'value', value: { amount: '21.90', currency: 'EUR' } }, stock: { state: 'value', value: 2 }, state: 'live' },
      { sku: 'OTHER-S', values: { Taglia: 'S' }, price: { state: 'value', value: { amount: '18.00', currency: 'EUR' } }, stock: { state: 'unread', reason: "eBay did not report this variation's quantity." }, state: 'extra' },
      { sku: 'FAM-XL', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'missing' }] })
    expect(read).toMatchObject({ source: 'ebay-trading-item', readAt: '2026-09-26T21:00:00.000Z', errors: [], destination: { aliasKey: 'alias-1' } })
  })

  it('uses the very revision the publish review re-checks before a send', async () => {
    const read = await readEbayTradingListing(destination, { getItem: async () => ({ xml: xml() }) }, now)
    expect(read.revision).toBe(ebayLiveContentRevision(xml()))
  })

  it('a failed read or another item is "could not read" with the reason — never empty content', async () => {
    const failed = await readEbayTradingListing(destination, { getItem: async () => ({ xml: null, error: 'GetItem timed out' }) }, now)
    expect(failed).toMatchObject({ revision: null, variations: null, errors: [{ scope: 'item', reason: 'GetItem timed out' }], content: { title: { state: 'unread', reason: 'GetItem timed out' } } })
    const other = await readEbayTradingListing(destination, { getItem: async () => ({ xml: xml('9000000099') }) }, now)
    expect(other.content.title).toEqual({ state: 'unread', reason: 'eBay returned another or an unreadable listing.' })
  })
})

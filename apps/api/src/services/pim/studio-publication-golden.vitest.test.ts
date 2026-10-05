/**
 * Sheet publish, build shape v2 P4 — the GOLDEN test. With no row reviewed as Full update (no `fullProductIds`, or an
 * empty list), what Publish sends to Amazon and eBay is byte for byte what it sent before Full update existed. The
 * snapshots below were recorded from the code before P4 changed a line; a difference here is a change to Partial update.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication, } from './studio-publication-amazon.js'
import type { EbayPublication } from './studio-publication-ebay.js'
const m = vi.hoisted(() => ({ read: vi.fn(), spec: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { getListingsItem = m.read } }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonRegion: async () => 'eu' }))
vi.mock('./channel-specs/index.js', async importOriginal => ({ ...(await importOriginal<object>()), loadAmazonSpec: m.spec }))
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { prepareAmazonChanges } from './studio-publication-amazon-changes.js'
import { prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { compileSelection } from './studio-publication-selection.js'
import { parseEbayItemDocument } from '../channel-drift/ebay-content-compare.js'
import { ebayPublicationXml } from './studio-publication-ebay.js'

// ── Amazon: the fixtures of studio-publication-amazon-changes.vitest.test.ts ──────────────────────────────────────
const entries = (value: string, language_tag?: string) => [{ value, marketplace_id: 'MARKET', ...(language_tag ? { language_tag } : {}) }]
const rootSchema = (language = false) => ({ type: 'array', selectors: ['marketplace_id', ...(language ? ['language_tag'] : [])], items: { type: 'object', properties: {
  marketplace_id: { const: 'MARKET' }, ...(language ? { language_tag: { enum: ['de_DE', 'en_DE', 'en_GB'], default: 'de_DE' } } : {}), value: { type: 'string' },
} } })
const schema = () => amazonSpecFromDefinition({ marketplace: 'DE', productType: 'COAT', schemaDefinition: { properties: {
  item_name: rootSchema(true), product_description: rootSchema(true), brand: rootSchema(), fabric_type: rootSchema(), variation_theme: rootSchema(),
  purchasable_offer: rootSchema(), fulfillment_availability: rootSchema(), list_price: rootSchema(),
} } })
const amazonFacts = (ids = ['parent', 'child'], live = true) => ({ scope: { channel: 'AMAZON', marketplace: 'DE', accountId: 'selected-account' }, destination: { aliasKey: 'alias-a' },
  parent: { id: 'parent', sku: 'LOCAL-PARENT' }, products: ids.map(id => ({ id, sku: `LOCAL-${id}` })), languages: ['de'],
  listings: ids.map(id => ({ id: `listing-${id}`, productId: id, externalListingId: live ? `ASIN-${id}` : null })),
}) as unknown as PublicationFacts
const amazonPublication = (ids = ['parent', 'child'], operationType = 'PARTIAL_UPDATE'): AmazonPublication => ({ kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'MARKET',
  products: ids.map(productId => ({ productId, sku: `SELLER-${productId}` })), feed: { header: { sellerId: 'SELLER', version: '2.0' },
    messages: ids.map((id, index) => ({ messageId: index + 1, sku: `SELLER-${id}`, operationType, productType: 'COAT', attributes: {
      item_name: entries(`${id} title`, 'de_DE'), brand: entries('Brand'), purchasable_offer: entries('29'), fulfillment_availability: entries('5'), list_price: entries('39'),
    } })),
  } })
const amazonBaseline = (pub: AmazonPublication) => new Map<string, StudioPublishValue>(pub.products.flatMap((p, index) => Object.entries(pub.feed.messages[index].attributes ?? {})
  .map(([field, value]) => [publicationChangeId(p.productId, field), { state: 'value', value } as StudioPublishValue])))
const remote = (attributes: unknown, productType = 'COAT') => ({ success: true, rawResponse: { attributes, summaries: [{ marketplaceId: 'MARKET', productType }] } })
const defaults = (plan: { changes: Array<{ id: string; selectedByDefault: boolean }> }) => plan.changes.filter(c => c.selectedByDefault).map(c => c.id)

// ── eBay: the fixtures of studio-publication-ebay-changes.vitest.test.ts ──────────────────────────────────────────
const specificsXml = (material: string | null, brand = 'Nexus brand') => `<ItemSpecifics>${material == null ? '' : `<NameValueList><Name>Material</Name><Value>${material}</Value></NameValueList>`}<NameValueList><Name>Brand</Name><Value>${brand}</Value></NameValueList></ItemSpecifics>`
const variationXml = (sku: string, colour = 'Black', price = 20, quantity = 3) => `<Variation><SKU>${sku}</SKU><StartPrice>${price}</StartPrice><Quantity>${quantity}</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>${colour}</Value></NameValueList></VariationSpecifics><VariationProductListingDetails><EAN>123</EAN></VariationProductListingDetails></Variation>`
const itemXml = (title: string, material: string | null, brand: string, variants = variationXml('CHILD')) => `<Item><ItemID>456</ItemID><SKU>PARENT</SKU><Title>${title}</Title><Description><![CDATA[<p>Same description</p>]]></Description>${specificsXml(material, brand)}<PictureDetails><PictureURL>https://example.test/one.jpg</PictureURL></PictureDetails><PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><SellerProfiles><SellerShippingProfile><ShippingProfileID>policy</ShippingProfileID></SellerShippingProfile></SellerProfiles><Variations>${variants}<VariationSpecificsSet><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecificsSet></Variations></Item>`
const ebayFacts = () => ({
  scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }, destination: { aliasKey: 'alias' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'PARENT' }, { id: 'child', sku: 'CHILD' }],
  listings: ['parent', 'child'].map(productId => ({ id: `${productId}-listing`, productId, externalListingId: '456', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: 'alias' })),
  resolved: [{ products: [{ productId: 'parent', cells: {} }, { productId: 'child', cells: {} }], catalogue: { fields: [] } }],
}) as unknown as PublicationFacts
const ebayPublication = (itemId: string | null = '456'): EbayPublication => ({
  kind: 'ebay', marketplace: 'IT', itemId, liveRevision: itemId ? 'live-revision' : null,
  xml: `<${itemId ? 'Revise' : 'Add'}FixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${itemXml('New title', 'Linen', 'Nexus brand')}</${itemId ? 'Revise' : 'Add'}FixedPriceItemRequest>`,
  products: [{ productId: 'parent', sku: 'PARENT' }, { productId: 'child', sku: 'CHILD' }],
  liveContent: itemId ? parseEbayItemDocument(itemXml('Old title', 'Cotton', 'Channel-only brand', variationXml('CHILD', 'Black', 99, 8))) : null,
})
const ebayBaseline = () => new Map<string, StudioPublishValue>([
  [publicationChangeId('parent', 'title'), { state: 'value', value: 'Old title' }],
  [publicationChangeId('parent', 'aspect:material'), { state: 'value', value: ['Cotton'] }],
])

beforeEach(() => {
  vi.clearAllMocks(); m.spec.mockResolvedValue(schema())
  m.read.mockImplementation(async ({ sku }) => remote(amazonPublication().feed.messages.find(msg => msg.sku === sku)?.attributes ?? {}))
})

// Each case runs with no options, and with an empty Full list: both must equal today's bytes.
const modes = [undefined, { fullProductIds: new Set<string>() }] as const

it.each(modes)('Amazon: a changed existing family sends today\'s PATCH feed and ticks (%o)', async options => {
  const pub = amazonPublication(), accepted = amazonBaseline(pub)
  pub.feed.messages[1].attributes!.brand = entries('Changed brand')
  pub.feed.messages[0].attributes!.item_name = entries('New German title', 'de_DE')
  const plan = await (prepareAmazonChanges as any)(amazonFacts(), pub, accepted, options)
  const { selection, prepared } = compileSelection(JSON.parse(JSON.stringify(plan)), defaults(plan), 'review-golden')
  expect(selection.payload.content).toMatchInlineSnapshot(`
    "{
      "feed": {
        "header": {
          "sellerId": "SELLER",
          "version": "2.0"
        },
        "messages": [
          {
            "messageId": 1,
            "operationType": "PATCH",
            "patches": [
              {
                "op": "replace",
                "path": "/attributes/item_name",
                "value": [
                  {
                    "language_tag": "de_DE",
                    "marketplace_id": "MARKET",
                    "value": "New German title"
                  }
                ]
              }
            ],
            "productType": "COAT",
            "sku": "SELLER-parent"
          },
          {
            "messageId": 2,
            "operationType": "PATCH",
            "patches": [
              {
                "op": "replace",
                "path": "/attributes/brand",
                "value": [
                  {
                    "marketplace_id": "MARKET",
                    "value": "Changed brand"
                  }
                ]
              }
            ],
            "productType": "COAT",
            "sku": "SELLER-child"
          }
        ]
      },
      "feedType": "JSON_LISTINGS_FEED",
      "marketplaceIds": [
        "MARKET"
      ]
    }"
  `)
  expect(JSON.stringify(prepared)).toMatchInlineSnapshot(`"{"kind":"amazon","sellerId":"SELLER","marketplaceId":"MARKET","products":[{"productId":"parent","sku":"SELLER-parent"},{"productId":"child","sku":"SELLER-child"}],"feed":{"header":{"sellerId":"SELLER","version":"2.0"},"messages":[{"messageId":1,"sku":"SELLER-parent","operationType":"PATCH","productType":"COAT","patches":[{"op":"replace","path":"/attributes/item_name","value":[{"value":"New German title","marketplace_id":"MARKET","language_tag":"de_DE"}]}]},{"messageId":2,"sku":"SELLER-child","operationType":"PATCH","productType":"COAT","patches":[{"op":"replace","path":"/attributes/brand","value":[{"value":"Changed brand","marketplace_id":"MARKET"}]}]}]},"fieldWrites":{"parent":[{"field":"item_name:[\\"MARKET\\",\\"de_DE\\"]","value":{"state":"value","value":[{"value":"New German title","marketplace_id":"MARKET","language_tag":"de_DE"}]}}],"child":[{"field":"brand","value":{"state":"value","value":[{"value":"Changed brand","marketplace_id":"MARKET"}]}}]}}"`)
  expect(JSON.stringify(plan.changes)).toMatchInlineSnapshot(`"[{"id":"[\\"parent\\",\\"brand\\"]","productId":"parent","sku":"SELLER-parent","field":"brand","label":"brand","current":{"state":"value","value":[{"value":"Brand","marketplace_id":"MARKET"}]},"lastAccepted":{"state":"value","value":[{"value":"Brand","marketplace_id":"MARKET"}]},"channel":{"state":"value","value":[{"value":"Brand","marketplace_id":"MARKET"}]},"status":"SAME","localChanged":false,"channelChanged":false,"selectable":false,"selectedByDefault":false,"reason":"This value already matches the channel; nothing will be sent.","operation":"replace"},{"id":"[\\"parent\\",\\"item_name:[\\\\\\"MARKET\\\\\\",\\\\\\"de_DE\\\\\\"]\\"]","productId":"parent","sku":"SELLER-parent","field":"item_name:[\\"MARKET\\",\\"de_DE\\"]","label":"item_name · de_DE","current":{"state":"value","value":[{"value":"New German title","marketplace_id":"MARKET","language_tag":"de_DE"}]},"lastAccepted":{"state":"value","value":[{"value":"parent title","marketplace_id":"MARKET","language_tag":"de_DE"}]},"channel":{"state":"value","value":[{"value":"parent title","marketplace_id":"MARKET","language_tag":"de_DE"}]},"status":"SEND","localChanged":true,"channelChanged":false,"selectable":true,"selectedByDefault":true,"reason":"Nexus changed since the last accepted publish; the channel still matches that record.","operation":"replace"},{"id":"[\\"parent\\",\\"list_price\\"]","productId":"parent","sku":"SELLER-parent","field":"list_price","label":"list_price","current":{"state":"value","value":[{"value":"39","marketplace_id":"MARKET"}]},"lastAccepted":{"state":"value","value":[{"value":"39","marketplace_id":"MARKET"}]},"channel":{"state":"value","value":[{"value":"39","marketplace_id":"MARKET"}]},"status":"SAME","localChanged":false,"channelChanged":false,"selectable":false,"selectedByDefault":false,"reason":"This value already matches the channel; nothing will be sent.","operation":"replace"},{"id":"[\\"child\\",\\"brand\\"]","productId":"child","sku":"SELLER-child","field":"brand","label":"brand","current":{"state":"value","value":[{"value":"Changed brand","marketplace_id":"MARKET"}]},"lastAccepted":{"state":"value","value":[{"value":"Brand","marketplace_id":"MARKET"}]},"channel":{"state":"value","value":[{"value":"Brand","marketplace_id":"MARKET"}]},"status":"SEND","localChanged":true,"channelChanged":false,"selectable":true,"selectedByDefault":true,"reason":"Nexus changed since the last accepted publish; the channel still matches that record.","operation":"replace"},{"id":"[\\"child\\",\\"item_name:[\\\\\\"MARKET\\\\\\",\\\\\\"de_DE\\\\\\"]\\"]","productId":"child","sku":"SELLER-child","field":"item_name:[\\"MARKET\\",\\"de_DE\\"]","label":"item_name · de_DE","current":{"state":"value","value":[{"value":"child title","marketplace_id":"MARKET","language_tag":"de_DE"}]},"lastAccepted":{"state":"value","value":[{"value":"child title","marketplace_id":"MARKET","language_tag":"de_DE"}]},"channel":{"state":"value","value":[{"value":"child title","marketplace_id":"MARKET","language_tag":"de_DE"}]},"status":"SAME","localChanged":false,"channelChanged":false,"selectable":false,"selectedByDefault":false,"reason":"This value already matches the channel; nothing will be sent.","operation":"replace"},{"id":"[\\"child\\",\\"list_price\\"]","productId":"child","sku":"SELLER-child","field":"list_price","label":"list_price","current":{"state":"value","value":[{"value":"39","marketplace_id":"MARKET"}]},"lastAccepted":{"state":"value","value":[{"value":"39","marketplace_id":"MARKET"}]},"channel":{"state":"value","value":[{"value":"39","marketplace_id":"MARKET"}]},"status":"SAME","localChanged":false,"channelChanged":false,"selectable":false,"selectedByDefault":false,"reason":"This value already matches the channel; nothing will be sent.","operation":"replace"}]"`)
})

it.each(modes)('Amazon: a new listing sends today\'s complete UPDATE (%o)', async options => {
  const pub = amazonPublication(['parent'], 'UPDATE')
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  const plan = await (prepareAmazonChanges as any)(amazonFacts(['parent'], false), pub, new Map(), options)
  const { selection } = compileSelection(plan, defaults(plan), 'review-golden')
  expect(selection.payload.content).toMatchInlineSnapshot(`
    "{
      "feed": {
        "header": {
          "sellerId": "SELLER",
          "version": "2.0"
        },
        "messages": [
          {
            "attributes": {
              "brand": [
                {
                  "marketplace_id": "MARKET",
                  "value": "Brand"
                }
              ],
              "fulfillment_availability": [
                {
                  "marketplace_id": "MARKET",
                  "value": "5"
                }
              ],
              "item_name": [
                {
                  "language_tag": "de_DE",
                  "marketplace_id": "MARKET",
                  "value": "parent title"
                }
              ],
              "list_price": [
                {
                  "marketplace_id": "MARKET",
                  "value": "39"
                }
              ],
              "purchasable_offer": [
                {
                  "marketplace_id": "MARKET",
                  "value": "29"
                }
              ]
            },
            "messageId": 1,
            "operationType": "UPDATE",
            "productType": "COAT",
            "sku": "SELLER-parent"
          }
        ]
      },
      "feedType": "JSON_LISTINGS_FEED",
      "marketplaceIds": [
        "MARKET"
      ]
    }"
  `)
})

it.each(modes)('eBay: a changed existing item sends today\'s narrow Revise and ticks (%o)', async options => {
  const plan = await (prepareEbayChanges as any)(ebayFacts(), ebayPublication(), ebayBaseline(), options)
  const { selection, prepared } = compileSelection(JSON.parse(JSON.stringify(plan)), defaults(plan), 'review-golden')
  expect(selection.payload.content).toMatchInlineSnapshot(`"<?xml version="1.0" encoding="UTF-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><InvocationID>REVIEWGOLDEN</InvocationID><Item><ItemID>456</ItemID><Title>New title</Title><ItemSpecifics><NameValueList><Name>Brand</Name><Value>Nexus brand</Value></NameValueList><NameValueList><Name>Material</Name><Value>Linen</Value></NameValueList></ItemSpecifics></Item></ReviseFixedPriceItemRequest>"`)
  expect(JSON.stringify((prepared as any).fieldWrites)).toMatchInlineSnapshot(`"{"parent":[{"field":"title","value":{"state":"value","value":"New title"}},{"field":"aspect:material","value":{"state":"value","value":["Linen"]}},{"field":"aspect:brand","value":{"state":"value","value":["Nexus brand"]}}]}"`)
  expect(JSON.stringify(plan.changes)).toMatchInlineSnapshot(`"[{"id":"[\\"parent\\",\\"SKU\\"]","productId":"parent","sku":"PARENT","field":"SKU","label":"Seller SKU","current":{"state":"value","value":"PARENT"},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":"PARENT"},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"Changing the seller SKU is unsupported by change-only Publish.","operation":"replace"},{"id":"[\\"parent\\",\\"title\\"]","productId":"parent","sku":"PARENT","field":"title","label":"Title","current":{"state":"value","value":"New title"},"lastAccepted":{"state":"value","value":"Old title"},"channel":{"state":"value","value":"Old title"},"status":"SEND","localChanged":true,"channelChanged":false,"selectable":true,"selectedByDefault":true,"reason":"Nexus changed since the last accepted publish; the channel still matches that record.","operation":"replace"},{"id":"[\\"parent\\",\\"description\\"]","productId":"parent","sku":"PARENT","field":"description","label":"Description","current":{"state":"value","value":"<p>Same description</p>"},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":"<p>Same description</p>"},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"This value already matches the channel; nothing will be sent.","operation":"replace"},{"id":"[\\"parent\\",\\"pictures\\"]","productId":"parent","sku":"PARENT","field":"pictures","label":"Listing pictures","current":{"state":"value","value":["https://example.test/one.jpg"]},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":["https://example.test/one.jpg"]},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"This value already matches the channel; nothing will be sent.","operation":"replace"},{"id":"[\\"parent\\",\\"aspect:material\\"]","productId":"parent","sku":"PARENT","field":"aspect:material","label":"Material","current":{"state":"value","value":["Linen"]},"lastAccepted":{"state":"value","value":["Cotton"]},"channel":{"state":"value","value":["Cotton"]},"status":"SEND","localChanged":true,"channelChanged":false,"selectable":true,"selectedByDefault":true,"reason":"Nexus changed since the last accepted publish; the channel still matches that record.","operation":"replace"},{"id":"[\\"parent\\",\\"aspect:brand\\"]","productId":"parent","sku":"PARENT","field":"aspect:brand","label":"Brand","current":{"state":"value","value":["Nexus brand"]},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":["Channel-only brand"]},"status":"DIFFERS","localChanged":null,"channelChanged":null,"selectable":true,"selectedByDefault":true,"reason":"No accepted publish record. Publish replaces the channel's different value with Nexus's; untick it to keep the channel's.","operation":"replace","replaces":{"kind":"never_published","channel":"Channel-only brand","nexus":"Nexus brand","sentence":"Not published from Nexus before. eBay has Channel-only brand — Publish sets Nexus brand.","note":null}},{"id":"[\\"parent\\",\\"PrimaryCategory\\"]","productId":"parent","sku":"PARENT","field":"PrimaryCategory","label":"PrimaryCategory","current":{"state":"value","value":{"CategoryID":"123"}},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":{"CategoryID":"123"}},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"PrimaryCategory: this structural or policy update is unsupported by change-only Publish.","operation":"replace"},{"id":"[\\"parent\\",\\"SellerProfiles\\"]","productId":"parent","sku":"PARENT","field":"SellerProfiles","label":"SellerProfiles","current":{"state":"value","value":{"SellerShippingProfile":{"ShippingProfileID":"policy"}}},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":{"SellerShippingProfile":{"ShippingProfileID":"policy"}}},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"SellerProfiles: this structural or policy update is unsupported by change-only Publish.","operation":"replace"},{"id":"[\\"parent\\",\\"VariationSpecificsSet\\"]","productId":"parent","sku":"PARENT","field":"VariationSpecificsSet","label":"Variation theme","current":{"state":"value","value":{"NameValueList":{"Name":"Colour","Value":"Black"}}},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":{"NameValueList":{"Name":"Colour","Value":"Black"}}},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"VariationSpecificsSet: this variation structure update is unsupported by change-only Publish.","operation":"replace"},{"id":"[\\"child\\",\\"variation\\"]","productId":"child","sku":"CHILD","field":"variation","label":"Variation content","current":{"state":"value","value":{"VariationSpecifics":{"NameValueList":{"Name":"Colour","Value":"Black"}},"VariationProductListingDetails":{"EAN":"123"}}},"lastAccepted":{"state":"unknown","reason":"No accepted publish record for this field."},"channel":{"state":"value","value":{"VariationSpecifics":{"NameValueList":{"Name":"Colour","Value":"Black"}},"VariationProductListingDetails":{"EAN":"123"}}},"status":"SAME","localChanged":null,"channelChanged":null,"selectable":false,"selectedByDefault":false,"reason":"Variation content requires price and quantity writes. It is not supported by change-only Publish; this variation will not be sent.","operation":"replace"}]"`)
})

it.each(modes)('eBay: a new item sends today\'s AddFixedPriceItem (%o)', async options => {
  const plan = await (prepareEbayChanges as any)(ebayFacts(), ebayPublication(null), new Map(), options)
  const { selection } = compileSelection(plan, defaults(plan), 'review-golden')
  expect(selection.payload.content).toMatchInlineSnapshot(`"<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><UUID>REVIEWGOLDEN</UUID><ItemID>456</ItemID><SKU>PARENT</SKU><Title>New title</Title><Description><![CDATA[<p>Same description</p>]]></Description><ItemSpecifics><NameValueList><Name>Material</Name><Value>Linen</Value></NameValueList><NameValueList><Name>Brand</Name><Value>Nexus brand</Value></NameValueList></ItemSpecifics><PictureDetails><PictureURL>https://example.test/one.jpg</PictureURL></PictureDetails><PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><SellerProfiles><SellerShippingProfile><ShippingProfileID>policy</ShippingProfileID></SellerShippingProfile></SellerProfiles><Variations><Variation><SKU>CHILD</SKU><StartPrice>20</StartPrice><Quantity>3</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecifics><VariationProductListingDetails><EAN>123</EAN></VariationProductListingDetails></Variation><VariationSpecificsSet><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecificsSet></Variations></Item></AddFixedPriceItemRequest>"`)
})

// Wave 2 (Owner decision 6, 2026-10-05) — the one intended change: a stored handling time sends no <DispatchTimeMax> (eBay
// takes it from the shipping policy). Everything else in these XMLs is unchanged.
it('eBay: the full builder\'s XML for a create and a revise is unchanged', () => {
  const input = { sku: 'PARENT', title: 'Jacket', description: '<p>Text</p>', categoryId: '123', conditionId: '1000', country: 'IT', currency: 'EUR', location: 'Rimini',
    postalCode: '47822', itemSpecifics: { Brand: 'Nexus', Material: ['Linen', 'Cotton'] }, variationSpecificNames: ['Colour'], variationSpecificsSet: { Colour: ['Black', 'Red'] },
    variations: [{ sku: 'CHILD-B', price: 20, quantity: 3, ean: '123', specifics: { Colour: 'Black' } }, { sku: 'CHILD-R', price: 21, quantity: 0, specifics: { Colour: 'Red' } }],
    pictureUrls: ['https://example.test/one.jpg'], policies: { fulfillmentPolicyId: 'ship', paymentPolicyId: 'pay', returnPolicyId: 'ret' } }
  const settings = { subtitle: 'Sub', handlingTime: 2, vatRate: 22, quantityLimitPerBuyer: 3, packageType: 'PACKAGE_THICK_ENVELOPE', packageWeight: { value: 1.2, unit: 'KILOGRAM' } }
  expect(ebayPublicationXml(input as any, null, false, settings)).toMatchInlineSnapshot(`
    "<?xml version="1.0" encoding="UTF-8"?>
    <AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      <ErrorLanguage>en_US</ErrorLanguage>
      <WarningLevel>High</WarningLevel>
      <Item>
        <SKU>PARENT</SKU>
        <Title>Jacket</Title>
        <Description><![CDATA[<p>Text</p>]]></Description>
        <PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory>
        <ConditionID>1000</ConditionID>
        <Country>IT</Country>
        <Currency>EUR</Currency>
        <Location>Rimini</Location>
        <PostalCode>47822</PostalCode>
        <ItemSpecifics><NameValueList><Name>Brand</Name><Value>Nexus</Value></NameValueList><NameValueList><Name>Material</Name><Value>Linen</Value><Value>Cotton</Value></NameValueList></ItemSpecifics>
        <ListingDuration>GTC</ListingDuration>
        <PictureDetails>
          <PictureURL>https://example.test/one.jpg</PictureURL>
        </PictureDetails>
        <SellerProfiles>
          <SellerShippingProfile><ShippingProfileID>ship</ShippingProfileID></SellerShippingProfile>
          <SellerPaymentProfile><PaymentProfileID>pay</PaymentProfileID></SellerPaymentProfile>
          <SellerReturnProfile><ReturnProfileID>ret</ReturnProfileID></SellerReturnProfile>
        </SellerProfiles>
        <Variations>
          <Variation>
            <SKU>CHILD-B</SKU>
            <StartPrice>20</StartPrice>
            <Quantity>3</Quantity>
            <VariationProductListingDetails><EAN>123</EAN></VariationProductListingDetails>
            <VariationSpecifics><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecifics>
          </Variation>
          <Variation>
            <SKU>CHILD-R</SKU>
            <StartPrice>21</StartPrice>
            <Quantity>0</Quantity>
            <VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails>
            <VariationSpecifics><NameValueList><Name>Colour</Name><Value>Red</Value></NameValueList></VariationSpecifics>
          </Variation>
          <VariationSpecificsSet>
            <NameValueList><Name>Colour</Name><Value>Black</Value><Value>Red</Value></NameValueList>
          </VariationSpecificsSet>
        </Variations>
      <SubTitle>Sub</SubTitle><VATDetails><VATPercent>22</VATPercent></VATDetails><QuantityRestrictionPerBuyer><MaximumQuantity>3</MaximumQuantity></QuantityRestrictionPerBuyer><ShippingPackageDetails><MeasurementUnit>Metric</MeasurementUnit><ShippingPackage>PackageThickEnvelope</ShippingPackage><WeightMajor unit="kg">1</WeightMajor><WeightMinor unit="gr">200</WeightMinor></ShippingPackageDetails></Item>
    </AddFixedPriceItemRequest>"
  `)
  expect(ebayPublicationXml(input as any, '456', false, settings)).toMatchInlineSnapshot(`
    "<?xml version="1.0" encoding="UTF-8"?>
    <ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      <ErrorLanguage>en_US</ErrorLanguage>
      <WarningLevel>High</WarningLevel>
      <Item><ItemID>456</ItemID>
        <SKU>PARENT</SKU>
        <Title>Jacket</Title>
        <Description><![CDATA[<p>Text</p>]]></Description>
        <PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory>
        <ConditionID>1000</ConditionID>
        <Country>IT</Country>
        <Currency>EUR</Currency>
        <Location>Rimini</Location>
        <PostalCode>47822</PostalCode>
        <ItemSpecifics><NameValueList><Name>Brand</Name><Value>Nexus</Value></NameValueList><NameValueList><Name>Material</Name><Value>Linen</Value><Value>Cotton</Value></NameValueList></ItemSpecifics>
        <ListingDuration>GTC</ListingDuration>
        <PictureDetails>
          <PictureURL>https://example.test/one.jpg</PictureURL>
        </PictureDetails>
        <SellerProfiles>
          <SellerShippingProfile><ShippingProfileID>ship</ShippingProfileID></SellerShippingProfile>
          <SellerPaymentProfile><PaymentProfileID>pay</PaymentProfileID></SellerPaymentProfile>
          <SellerReturnProfile><ReturnProfileID>ret</ReturnProfileID></SellerReturnProfile>
        </SellerProfiles>
        <Variations>
          <Variation>
            <SKU>CHILD-B</SKU>
            <StartPrice>20</StartPrice>
            <Quantity>3</Quantity>
            <VariationProductListingDetails><EAN>123</EAN></VariationProductListingDetails>
            <VariationSpecifics><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecifics>
          </Variation>
          <Variation>
            <SKU>CHILD-R</SKU>
            <StartPrice>21</StartPrice>
            <Quantity>0</Quantity>
            <VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails>
            <VariationSpecifics><NameValueList><Name>Colour</Name><Value>Red</Value></NameValueList></VariationSpecifics>
          </Variation>
          <VariationSpecificsSet>
            <NameValueList><Name>Colour</Name><Value>Black</Value><Value>Red</Value></NameValueList>
          </VariationSpecificsSet>
        </Variations>
      <SubTitle>Sub</SubTitle><VATDetails><VATPercent>22</VATPercent></VATDetails><QuantityRestrictionPerBuyer><MaximumQuantity>3</MaximumQuantity></QuantityRestrictionPerBuyer></Item>
    </ReviseFixedPriceItemRequest>"
  `)
  expect(ebayPublicationXml({ ...input, variations: [input.variations[0]] } as any, '456', true, { ...settings, bestOffer: true })).toMatchInlineSnapshot(`
    "<?xml version="1.0" encoding="UTF-8"?>
    <ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      <ErrorLanguage>en_US</ErrorLanguage>
      <WarningLevel>High</WarningLevel>
      <Item><ItemID>456</ItemID>
        <SKU>PARENT</SKU>
        <Title>Jacket</Title>
        <Description><![CDATA[<p>Text</p>]]></Description>
        <PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory>
        <ConditionID>1000</ConditionID>
        <Country>IT</Country>
        <Currency>EUR</Currency>
        <Location>Rimini</Location>
        <PostalCode>47822</PostalCode>
        <ItemSpecifics><NameValueList><Name>Brand</Name><Value>Nexus</Value></NameValueList><NameValueList><Name>Material</Name><Value>Linen</Value><Value>Cotton</Value></NameValueList></ItemSpecifics>
        <ListingDuration>GTC</ListingDuration>
        <PictureDetails>
          <PictureURL>https://example.test/one.jpg</PictureURL>
        </PictureDetails>
        <SellerProfiles>
          <SellerShippingProfile><ShippingProfileID>ship</ShippingProfileID></SellerShippingProfile>
          <SellerPaymentProfile><PaymentProfileID>pay</PaymentProfileID></SellerPaymentProfile>
          <SellerReturnProfile><ReturnProfileID>ret</ReturnProfileID></SellerReturnProfile>
        </SellerProfiles>
        <StartPrice>20</StartPrice><Quantity>3</Quantity><ProductListingDetails><EAN>123</EAN></ProductListingDetails>
      <SubTitle>Sub</SubTitle><VATDetails><VATPercent>22</VATPercent></VATDetails><BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails><QuantityRestrictionPerBuyer><MaximumQuantity>3</MaximumQuantity></QuantityRestrictionPerBuyer></Item>
    </ReviseFixedPriceItemRequest>"
  `)
})

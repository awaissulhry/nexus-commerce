import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const m = vi.hoisted(() => ({ validate: vi.fn(), call: vi.fn(), region: vi.fn(), client: vi.fn(), trading: vi.fn(), row: vi.fn(), spec: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { stockLevel: { findMany: async () => [] } } }))
vi.mock('../images/amazon-media-workspace.service.js', () => ({ readAmazonMedia: vi.fn(), desiredAmazonImages: vi.fn() }))
vi.mock('../images/ebay-media-workspace.service.js', () => ({ readEbayMediaGallery: vi.fn() }))
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { object: (v: any) => v && typeof v === 'object' ? v : {}, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex') }
})
vi.mock('../amazon/flat-file.service.js', () => ({ AmazonFlatFileService: class {
  async getFeedSchemaHints() { return {} }
  buildJsonFeedBody(rows: any[]) { m.row(rows[0]); return JSON.stringify({ header: {}, messages: [{ sku: rows[0].item_sku, operationType: rows[0]._isNew || rows[0].record_action === 'full_update' ? 'UPDATE' : 'PARTIAL_UPDATE', attributes: {} }] }) }
} }))
vi.mock('../categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('./channel-specs/index.js', () => ({ loadAmazonSpec: m.spec, loadEbaySpec: vi.fn() }))
vi.mock('./stored-variation-projection.js', () => ({ loadStoredVariationProjection: vi.fn() }))
vi.mock('./amazon-content-payload.js', () => ({ buildAmazonContentAttributes: async () => ({ item_name: [{ value: 'Saved localized title', language_tag: 'it_IT' }] }) }))
vi.mock('../amazon-market-offer.service.js', () => ({ closedMarketSet: async () => new Set() }))
vi.mock('../categories/marketplace-ids.js', () => ({ configuredAmazonMarketplaceId: async () => 'MARKET' }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'SELLER', getAmazonSpClient: m.client, getAmazonRegion: m.region }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { validateListing = m.validate } }))
vi.mock('../ebay-variation-push.service.js', () => ({ buildFlatRow: vi.fn() }))
vi.mock('../ebay-shared-listing-push.service.js', () => ({ buildSharedListingInput: vi.fn() }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: vi.fn() }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'mock-account-token' } }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-trading-api.service.js', async original => ({ ...await original<any>(), callTradingApi: m.trading }))

import { prepareAmazonPublication, sendAmazonPublication, readAmazonPublication, type AmazonPublication } from './studio-publication-amazon.js'
import { ebayPublicationXml, readEbayPublication, sendEbayPublication } from './studio-publication-ebay.js'
import { publicationImages } from './studio-publication-media.js'
import { writeMediaCollection } from '@nexus/shared/product-media'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection } from './variation-rules.service.js'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { TradingApiFailure } from '../ebay-trading-api.service.js'

const amazon: AmazonPublication = { kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'MARKET', feed: { header: {}, messages: [
  { messageId: 1, sku: 'PARENT', operationType: 'UPDATE', requirements: 'LISTING_PRODUCT_ONLY', productType: 'COAT', attributes: { parentage_level: [{ value: 'parent' }] } },
  { messageId: 2, sku: 'CHILD', operationType: 'PARTIAL_UPDATE', productType: 'COAT', attributes: { item_name: [{ value: 'Saved Italian title', language_tag: 'it_IT' }] } },
] } }
beforeEach(() => {
  vi.clearAllMocks(); m.trading.mockReset(); m.region.mockResolvedValue('eu'); m.client.mockResolvedValue({ callAPI: m.call }); m.validate.mockResolvedValue({ ok: true, available: true })
  m.spec.mockResolvedValue({ fields: [], validationSchema: { type: 'object', properties: {} } })
  m.call.mockImplementation(async ({ operation }: any) => operation === 'createFeedDocument' ? { feedDocumentId: 'doc', url: 'https://example.test/feed' } : { feedId: 'feed' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  vi.stubEnv('NEXUS_EBAY_REAL_API', 'true'); vi.stubEnv('EBAY_SANDBOX', 'false')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('validates every family message before one feed, using the exact seller and parent requirements', async () => {
  expect(await sendAmazonPublication(amazon, 'account-b')).toBe('feed')
  expect(m.validate).toHaveBeenNthCalledWith(1, expect.objectContaining({ sellerId: 'SELLER', sku: 'PARENT', requirements: 'LISTING_PRODUCT_ONLY', attributes: amazon.feed.messages[0].attributes }))
  expect(m.validate).toHaveBeenNthCalledWith(2, expect.objectContaining({ sku: 'CHILD', patches: [{ op: 'replace', path: '/attributes/item_name', value: amazon.feed.messages[1].attributes!.item_name }] }))
  expect(m.client.mock.calls.every(([id]) => id === 'account-b')).toBe(true)
  expect(m.validate.mock.invocationCallOrder.at(-1)).toBeLessThan(m.call.mock.invocationCallOrder[0])
  expect(m.call.mock.calls.filter(([r]) => r.operation === 'createFeed')).toHaveLength(1)
  expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body)).toEqual(amazon.feed)
})

it('does not upload or submit any family member when one Amazon preview fails', async () => {
  m.validate.mockResolvedValueOnce({ ok: true, available: true }).mockResolvedValueOnce({ ok: false, available: true, errors: 'Missing size' })
  await expect(sendAmazonPublication(amazon, 'account-b')).rejects.toMatchObject({ notSent: true, message: 'CHILD: Missing size' })
  expect(m.call).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
})

it('distinguishes feed upload failure from an interrupted createFeed request', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }))
  await expect(sendAmazonPublication(amazon, 'account-b')).rejects.toMatchObject({ notSent: true })
  m.call.mockImplementation(async ({ operation }: any) => { if (operation === 'createFeed') throw new Error('Connection interrupted'); return { feedDocumentId: 'doc', url: 'https://example.test/feed' } })
  await expect(sendAmazonPublication(amazon, 'account-b')).rejects.not.toHaveProperty('notSent')
})

it('keeps terminal Amazon feeds unresolved without a conclusive processing report', async () => {
  m.call.mockResolvedValueOnce({ processingStatus: 'DONE' })
  expect(await readAmazonPublication('feed', 'account-b', ['SKU'])).toBeNull()
  m.call.mockResolvedValueOnce({ processingStatus: 'FATAL' })
  expect(await readAmazonPublication('feed', 'account-b', ['SKU'])).toBeNull()
})

it('uses a complete FATAL processing report instead of declaring every Amazon message failed', async () => {
  m.call.mockResolvedValueOnce({ processingStatus: 'FATAL', resultFeedDocumentId: 'report' })
    .mockResolvedValueOnce({ url: 'https://example.test/report' })
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    issues: [{ sku: 'CHILD', code: '90220', severity: 'ERROR', message: 'Invalid size' }],
    summary: { messagesProcessed: 2, messagesAccepted: 1, messagesInvalid: 1, errors: 1, warnings: 0 },
  }), { status: 200 }))
  expect(await readAmazonPublication('feed', 'account-b', ['PARENT', 'CHILD'])).toMatchObject({ results: [
    { sku: 'PARENT', failed: false },
    { sku: 'CHILD', failed: true, message: 'Invalid size' },
  ] })

  m.call.mockResolvedValueOnce({ processingStatus: 'FATAL', resultFeedDocumentId: 'partial-report' })
    .mockResolvedValueOnce({ url: 'https://example.test/partial-report' })
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    issues: [{ sku: 'CHILD', code: '90220', severity: 'ERROR', message: 'Invalid size' }],
    summary: { messagesProcessed: 1, messagesAccepted: 0, messagesInvalid: 1, errors: 1, warnings: 0 },
  }), { status: 200 }))
  expect(await readAmazonPublication('feed', 'account-b', ['PARENT', 'CHILD'])).toBeNull()
})

it.each(['DONE', 'FATAL'])('maps mixed %s Amazon results by messageId when an issue omits its SKU', async processingStatus => {
  m.call.mockResolvedValueOnce({ processingStatus, resultFeedDocumentId: 'report' })
    .mockResolvedValueOnce({ url: 'https://example.test/report' })
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    issues: [{ messageId: 2, code: '90220', severity: 'ERROR', message: 'Invalid size' }],
    summary: { messagesProcessed: 2, messagesAccepted: 1, messagesInvalid: 1, errors: 1, warnings: 0 },
  }), { status: 200 }))

  expect(await readAmazonPublication('feed', 'account-b', ['PARENT', 'CHILD'])).toMatchObject({ results: [
    { sku: 'PARENT', failed: false },
    { sku: 'CHILD', failed: true, message: 'Invalid size' },
  ] })
})

it.each(['DONE', 'FATAL'])('keeps mixed %s Amazon results unresolved when an error cannot be mapped to a submitted message', async processingStatus => {
  m.call.mockResolvedValueOnce({ processingStatus, resultFeedDocumentId: 'report' })
    .mockResolvedValueOnce({ url: 'https://example.test/report' })
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    issues: [{ code: 'BAD_REQUEST', severity: 'ERROR', message: 'Unscoped feed error' }],
    summary: { messagesProcessed: 2, messagesAccepted: 1, messagesInvalid: 1, errors: 1, warnings: 0 },
  }), { status: 200 }))

  expect(await readAmazonPublication('feed', 'account-b', ['PARENT', 'CHILD'])).toBeNull()
})

const ebay = { sku: 'PARENT', title: 'Saved & title', description: '<p>Saved description</p>', categoryId: '123', conditionId: '1000', country: 'IT', currency: 'EUR',
  variationSpecificNames: ['Size'], variations: [{ sku: 'SKU', price: 25, quantity: 3, specifics: { Size: 'Small' }, ean: '1234567890123' }] }
const ebayLiveRevision = (raw: string) => {
  const stable = raw.replace(/<QuantitySold>[^<]*<\/QuantitySold>/g, '')
  const fields = ['SKU', 'Title', 'SubTitle', 'Description', 'PrimaryCategory', 'ConditionID', 'Country', 'Currency', 'Location', 'PostalCode',
    'ListingDuration', 'ItemSpecifics', 'StartPrice', 'Quantity', 'ProductListingDetails', 'Variations', 'PictureDetails', 'SellerProfiles',
    'DispatchTimeMax', 'VATDetails', 'BestOfferDetails', 'QuantityRestrictionPerBuyer']
  return createHash('sha256').update(JSON.stringify(fields.map(key => stable.match(new RegExp(`<${key}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${key}>`))?.[0] ?? ''))).digest('hex')
}
const ebaySingleItem = (price = 25, quantity = 3) => `<Ack>Success</Ack><Item><SKU>PARENT</SKU><Title>Saved &amp; title</Title><Description>Saved description</Description><PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><ConditionID>1000</ConditionID><Country>IT</Country><Currency>EUR</Currency><Location>Rimini</Location><ListingDuration>GTC</ListingDuration><StartPrice currencyID="EUR">${price}</StartPrice><Quantity>${quantity}</Quantity><ProductListingDetails><EAN>1234567890123</EAN></ProductListingDetails><SellingStatus><ListingStatus>Active</ListingStatus><QuantitySold>1</QuantitySold></SellingStatus></Item>`
it('creates standalone eBay XML with its saved price, quantity and EAN, and preserves saved listing controls', () => {
  const xml = ebayPublicationXml(ebay, null, true, { subtitle: 'Subtitle & detail', handlingTime: 2, vatRate: 22, bestOffer: false })
  expect(xml).not.toContain('<Variations>'); expect(xml).toContain('<StartPrice>25</StartPrice><Quantity>3</Quantity>')
  expect(xml).toContain('<ProductListingDetails><EAN>1234567890123</EAN></ProductListingDetails>')
  expect(xml).toContain('<SubTitle>Subtitle &amp; detail</SubTitle>'); expect(xml).toContain('<DispatchTimeMax>2</DispatchTimeMax>')
  expect(xml).toContain('<BestOfferEnabled>false</BestOfferEnabled>')
})
it('revises an existing eBay item instead of creating a duplicate or inventing its shipping origin', () => {
  const xml = ebayPublicationXml({ ...ebay, country: '' }, '456', false)
  expect(xml).toContain('<ReviseFixedPriceItemRequest'); expect(xml).toContain('<ItemID>456</ItemID>')
  expect(xml).toContain('<Variations>'); expect(xml).not.toContain('<Country>'); expect(xml).not.toContain('AddFixedPriceItemRequest')
})
it('returns the acknowledged eBay reference before read-back, with a stable deduplication identity', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' }).mockResolvedValueOnce({ ack: 'Success', errors: [], itemId: '456', raw: '<ItemID>456</ItemID>' })
  expect(await sendEbayPublication({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')).toEqual({ reference: '456', warnings: [] })
  expect(m.trading.mock.calls.map(([call]) => call)).toEqual(['VerifyAddFixedPriceItem', 'AddFixedPriceItem'])
  expect(m.trading.mock.calls[1][1]).toContain('<UUID>ABCD1234</UUID>')
})
it('retains the prior item reference from a conclusive duplicate eBay acknowledgement', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })
    .mockRejectedValueOnce(new TradingApiFailure('Duplicate UUID used.', true, '123'))
  await expect(sendEbayPublication({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234'))
    .resolves.toEqual({ reference: '123', warnings: ['Duplicate UUID used.'] })
})
it('keeps a duplicate eBay acknowledgement uncertain when it has no validated prior reference', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })
    .mockRejectedValueOnce(new TradingApiFailure('Duplicate invocation is still in progress.', true))
  const error = await sendEbayPublication({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')
    .catch(cause => cause)
  expect(error).toMatchObject({ duplicateSubmission: true, message: 'Duplicate invocation is still in progress.' })
  expect(error).not.toHaveProperty('notSent')
})
it('allows an unchanged single-item revision and blocks stale remote price or quantity', async () => {
  const baseline = ebaySingleItem()
  const plan = { kind: 'ebay' as const, marketplace: 'IT', itemId: '456', liveRevision: ebayLiveRevision(baseline), xml: ebayPublicationXml(ebay, '456', true) }
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: baseline })
    .mockResolvedValueOnce({ ack: 'Success', errors: [], itemId: '456', raw: '<Ack>Success</Ack><ItemID>456</ItemID>' })
  await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234')).resolves.toEqual({ reference: '456', warnings: [] })

  for (const changed of [ebaySingleItem(26, 3), ebaySingleItem(25, 4)]) {
    m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: changed })
    await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234')).rejects.toMatchObject({ notSent: true, message: expect.stringContaining('eBay changed') })
  }
  expect(m.trading.mock.calls.filter(([call]) => call === 'ReviseFixedPriceItem')).toHaveLength(1)
})
it('preserves eBay acknowledgement warnings and the item reference independently of later read-back', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })
    .mockResolvedValueOnce({ ack: 'Warning', errors: ['eBay shortened the submitted title'], itemId: '456', raw: '<Ack>Warning</Ack><ItemID>456</ItemID>' })
  const acknowledged = await sendEbayPublication({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')
  expect(acknowledged).toEqual({ reference: '456', warnings: ['eBay shortened the submitted title'] })
  m.trading.mockRejectedValueOnce(new Error('GetItem connection interrupted'))
  await expect(readEbayPublication(acknowledged.reference, 'account-b', 'IT')).resolves.toBeNull()
  expect(acknowledged).toEqual({ reference: '456', warnings: ['eBay shortened the submitted title'] })
})
it('reads the acknowledged eBay item without resubmitting and distinguishes verified, incompatible and unknown results', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Warning', errors: ['Policy warning'], raw: '<Ack>Warning</Ack><ListingStatus>Active</ListingStatus>' })
  await expect(readEbayPublication('456', 'account-b', 'IT')).resolves.toEqual({ reference: '456', warnings: ['Policy warning'], verified: true })
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack><ListingStatus>Completed</ListingStatus>' })
  await expect(readEbayPublication('456', 'account-b', 'IT')).resolves.toEqual({ reference: '456', warnings: ['This eBay listing is not active.'], verified: false })
  m.trading.mockRejectedValueOnce(new Error('Connection interrupted'))
  await expect(readEbayPublication('456', 'account-b', 'IT')).resolves.toBeNull()
  expect(m.trading.mock.calls.slice(-3).map(([call]) => call)).toEqual(['GetItem', 'GetItem', 'GetItem'])
})
it('never creates an eBay listing after a refused preview', async () => {
  m.trading.mockRejectedValue(new Error('Missing return policy'))
  await expect(sendEbayPublication({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'id')).rejects.toMatchObject({ notSent: true })
  expect(m.trading).toHaveBeenCalledTimes(1)
})

it('publishes the saved gallery order and respects an explicitly empty gallery', () => {
  const product = { id: 'p', sku: 'SKU', localizedContent: {}, images: [{ id: 'one', url: 'https://example.test/one' }, { id: 'two', url: 'https://example.test/two' }] }
  const listing = { productId: 'p', platformAttributes: { _productMediaLocales: writeMediaCollection({}, 'it', { version: 1, items: [{ assetId: 'two' }, { assetId: 'one' }] }) } }
  const facts: any = { parent: product, products: [product], listings: [listing], languages: ['it'] }
  expect(publicationImages(facts, product as any)).toEqual(['https://example.test/two', 'https://example.test/one'])
  listing.platformAttributes._productMediaLocales = writeMediaCollection({}, 'it', { version: 1, items: [] })
  expect(publicationImages(facts, product as any)).toEqual([])
})

it('updates an existing Amazon alias by seller SKU without a destructive full replacement', async () => {
  const product = { id: 'p', sku: 'MASTER-SKU', name: 'Master title', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { aliasKey: 'alias-b' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', offers: [{ isActive: true, sku: 'ALIAS-SKU', fulfillmentMethod: 'FBM' }], followMasterPrice: false, priceOverride: 35, stockBuffer: 2 }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: {} }], catalogue: { schema: { present: true }, fields: [] } }] }
  const prepared = await prepareAmazonPublication(facts)
  expect(m.row).toHaveBeenCalledWith(expect.objectContaining({ item_sku: 'ALIAS-SKU', _isNew: false, record_action: 'partial_update', purchasable_offer__our_price: '35.00', fulfillment_availability__quantity: 3 }))
  expect(m.row.mock.calls[0][0]).not.toHaveProperty('main_product_image_locator')
  expect(m.row.mock.calls[0][0]).not.toHaveProperty('purchasable_offer__condition_type')
  expect(prepared.feed.messages[0]).toMatchObject({ sku: 'ALIAS-SKU', operationType: 'PARTIAL_UPDATE', attributes: { item_name: [{ value: 'Saved localized title', language_tag: 'it_IT' }] } })
  // A content update keeps the existing Amazon gallery, even when the shared
  // library contains more images than a single product gallery permits.
  product.images = Array.from({ length: 24 }, (_, i) => ({ id: String(i), url: `https://example.test/${i}` }))
  await expect(prepareAmazonPublication(facts)).resolves.toBeDefined()
  facts.listings[0].platformAttributes = { _productMediaLocales: writeMediaCollection({}, 'it', { version: 1, items: [{ assetId: '4' }] }) }
  await prepareAmazonPublication(facts)
  expect(m.row.mock.calls.at(-1)![0].main_product_image_locator).toBe('https://example.test/4')
  facts.listings[0].platformAttributes = { _productMediaLocales: writeMediaCollection({}, 'it', { version: 1, items: [] }) }
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('add a product image')
  facts.listings[0].offers = []
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('own Amazon seller SKU')
})

it('checks Amazon variation collisions against saved channel sizes instead of stale shared sizes', async () => {
  m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    list_price: { type: 'array', selectors: ['marketplace_id', 'currency'], items: { properties: { value_with_tax: { type: 'number' }, currency: { const: 'EUR' }, marketplace_id: { const: 'MARKET' } } } },
    child_parent_sku_relationship: { type: 'array', items: { properties: { parent_sku: { type: 'string' }, child_relationship_type: { type: 'string' }, marketplace_id: { const: 'MARKET' } } } },
  } } }))
  const theme = 'SIZE/COLOR'
  const input: any = {
    coordinate: { channel: 'AMAZON', market: 'IT', accountId: 'account-b', aliasKey: '', label: 'Amazon IT' },
    family: { familyAxes: ['Color', 'Size'], productVersion: 1, childIds: ['xs', 'xxs'], variants: ['xs', 'xxs'].map(id => ({ id, sku: id, included: true, axisValues: { Color: 'Black', Size: 'XS' } })) },
    listing: { version: 1, variationTheme: theme, variationMapping: null, platformAttributes: {}, externalListingId: 'ASIN', listingStatus: 'ACTIVE' }, rule: null,
    schema: { amazon: { facts: { themes: [theme], deprecated: [], properties: { color: { title: 'Color' }, apparel_size: { items: { properties: { size: { type: 'string' } } } } } }, fetchedAt: null } },
    limits: limitsFor('AMAZON', [theme]), vocabulary: vocabularyFor('AMAZON'),
  }
  const original = structuredClone(input)
  vi.mocked(loadStoredVariationProjection).mockImplementation(async () => ({ input: structuredClone(original), cell: resolveVariationProjection(original) }))
  const parent = { id: 'p', sku: 'PARENT', isParent: true, images: [], basePrice: 99, totalStock: 0 }
  const children = ['xs', 'xxs'].map(id => ({ ...parent, id, sku: id, parentId: 'p', isParent: false, fulfillmentMethod: 'FBA' }))
  const products = [parent, ...children]
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent, products, languages: ['it'], destination: {},
    listings: products.map(p => ({ productId: p.id, externalListingId: `ASIN-${p.id}`, offers: [] })),
    resolved: [{ products: products.map(p => ({ productId: p.id, category: { channelCategoryId: 'COAT' }, cells: {
      color: { value: 'Black', errors: [] }, apparel_size__size: { value: p.id === 'xxs' ? 'xx_s' : 'x_s', errors: [] },
      list_price: { value: 128.1, errors: [] }, child_parent_sku_relationship__parent_sku: { value: 'WRONG-PARENT', errors: [] }, child_parent_sku_relationship__child_relationship_type: { value: 'variation', errors: [] },
    } })), catalogue: { schema: { present: true }, fields: [{ fieldKey: 'color', sheetKey: 'color' }, { fieldKey: 'apparel_size__size', sheetKey: 'size' }, { fieldKey: 'list_price', sourceOwner: { label: 'Pricing' } }, ...['parent_sku', 'child_relationship_type'].map(key => ({ fieldKey: `child_parent_sku_relationship__${key}`, sourceOwner: { label: 'Family' } }))] } }],
  }
  const prepared = await prepareAmazonPublication(facts)
  expect(prepared.feed.messages[1].attributes).toMatchObject({ list_price: [{ value_with_tax: 128.1, currency: 'EUR', marketplace_id: 'MARKET' }], child_parent_sku_relationship: [{ parent_sku: 'PARENT', child_relationship_type: 'variation', marketplace_id: 'MARKET' }] })
  facts.resolved[0].products[2].cells.apparel_size__size.value = 'x_s'
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('2 variants cannot be told apart')
})

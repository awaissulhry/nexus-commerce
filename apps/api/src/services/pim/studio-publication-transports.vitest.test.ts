import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ validate: vi.fn(), call: vi.fn(), region: vi.fn(), client: vi.fn(), trading: vi.fn(), row: vi.fn() }))
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
vi.mock('./channel-specs/index.js', () => ({ loadAmazonSpec: async () => ({ fields: [], validationSchema: { type: 'object', properties: {} } }), loadEbaySpec: vi.fn() }))
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
import { ebayPublicationXml, sendEbayPublication } from './studio-publication-ebay.js'
import { publicationImages } from './studio-publication-media.js'
import { writeMediaCollection } from '@nexus/shared/product-media'

const amazon: AmazonPublication = { kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'MARKET', feed: { header: {}, messages: [
  { messageId: 1, sku: 'PARENT', operationType: 'UPDATE', requirements: 'LISTING_PRODUCT_ONLY', productType: 'COAT', attributes: { parentage_level: [{ value: 'parent' }] } },
  { messageId: 2, sku: 'CHILD', operationType: 'PARTIAL_UPDATE', productType: 'COAT', attributes: { item_name: [{ value: 'Saved Italian title', language_tag: 'it_IT' }] } },
] } }
beforeEach(() => {
  vi.clearAllMocks(); m.region.mockResolvedValue('eu'); m.client.mockResolvedValue({ callAPI: m.call }); m.validate.mockResolvedValue({ ok: true, available: true })
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

it('keeps DONE without a processing report pending, and reports fatal feeds without inventing success', async () => {
  m.call.mockResolvedValueOnce({ processingStatus: 'DONE' })
  expect(await readAmazonPublication('feed', 'account-b', ['SKU'])).toBeNull()
  m.call.mockResolvedValueOnce({ processingStatus: 'FATAL' })
  expect(await readAmazonPublication('feed', 'account-b', ['SKU'])).toMatchObject({ failed: true, results: [expect.objectContaining({ sku: 'SKU', failed: true })] })
})

const ebay = { sku: 'PARENT', title: 'Saved & title', description: '<p>Saved description</p>', categoryId: '123', conditionId: '1000', country: 'IT', currency: 'EUR',
  variationSpecificNames: ['Size'], variations: [{ sku: 'SKU', price: 25, quantity: 3, specifics: { Size: 'Small' }, ean: '1234567890123' }] }
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
it('sends eBay validation before creation with a stable deduplication identity and verifies active presence', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', raw: '<Ack>Success</Ack>' }).mockResolvedValueOnce({ ack: 'Success', itemId: '456', raw: '<ItemID>456</ItemID>' }).mockResolvedValueOnce({ ack: 'Success', raw: '<ListingStatus>Active</ListingStatus>' })
  expect(await sendEbayPublication({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')).toBe('456')
  expect(m.trading.mock.calls.map(([call]) => call)).toEqual(['VerifyAddFixedPriceItem', 'AddFixedPriceItem', 'GetItem'])
  expect(m.trading.mock.calls[1][1]).toContain('<UUID>ABCD1234</UUID>')
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
  expect(m.row).toHaveBeenCalledWith(expect.objectContaining({ item_sku: 'ALIAS-SKU', _isNew: false, record_action: 'partial_update', purchasable_offer__our_price: '35.00', fulfillment_availability__quantity: 3, main_product_image_locator: 'https://example.test/image' }))
  expect(prepared.feed.messages[0]).toMatchObject({ sku: 'ALIAS-SKU', operationType: 'PARTIAL_UPDATE', attributes: { item_name: [{ value: 'Saved localized title', language_tag: 'it_IT' }] } })
  facts.listings[0].offers = []
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('own Amazon seller SKU')
})

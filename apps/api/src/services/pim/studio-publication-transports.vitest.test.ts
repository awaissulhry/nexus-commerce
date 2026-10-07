import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ validate: vi.fn(), call: vi.fn(), region: vi.fn(), client: vi.fn(), trading: vi.fn(), row: vi.fn(), spec: vi.fn(), sets: vi.fn(async (): Promise<unknown[]> => []), mapFields: vi.fn(async (): Promise<unknown[]> => []), hints: vi.fn(), mainRows: [] as unknown[] }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
// Shared stock — publication reads the product's ledger (loadSyncLedgers): nothing is pooled here.
// CHMAP M4: the builders read the ACTIVE mapping version; none here, so the push is exactly today's.
// Images rebuild P2 — not on the media plan: the publishers keep their older photo paths here.
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false, mediaPlanRevision: async () => null, mediaPlanProducts: async () => new Set() }))
vi.mock('../../db.js', () => ({ default: { stockLevel: { findMany: async () => [] }, stockPoolLink: { findMany: async () => [] }, syncChannelPolicy: { findMany: async () => [] }, channelListing: { findMany: async () => m.mainRows }, channelMappingSet: { findMany: (...a: unknown[]) => m.sets(...a) }, channelMappingField: { findMany: (...a: unknown[]) => m.mapFields(...a) }, $queryRaw: async () => [] } }))
vi.mock('../images/amazon-media-workspace.service.js', () => ({ readAmazonMedia: vi.fn(), desiredAmazonImages: vi.fn() }))
vi.mock('../images/ebay-media-workspace.service.js', () => ({ readEbayMediaGallery: vi.fn() }))
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { object: (v: any) => v && typeof v === 'object' ? v : {}, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex') }
})
vi.mock('../amazon/flat-file.service.js', () => ({ AmazonFlatFileService: class {
  async getFeedSchemaHints() { return {} }
  buildJsonFeedBody(rows: any[], _mp?: string, _seller?: string, _expanded?: unknown, hints?: unknown) { m.row(rows[0]); m.hints(hints); return JSON.stringify({ header: {}, messages: [{ sku: rows[0].item_sku, operationType: rows[0]._isNew || rows[0].record_action === 'full_update' ? 'UPDATE' : 'PARTIAL_UPDATE', attributes: {} }] }) }
}, normalizeVariationTheme: (theme: string) => theme }))
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
import { ebayPublicationXml, readEbayPublication, sendEbayPublication, ebayLiveContentRevision, ebayLiveStock, ebayStockRevision } from './studio-publication-ebay.js'
import { parseEbayItemDocument, parseEbayPublicationItem } from '../channel-drift/ebay-content-compare.js'
import { publicationImages } from './studio-publication-media.js'
import { writeMediaCollection } from '@nexus/shared/product-media'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection } from './variation-rules.service.js'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { TradingApiFailure } from '../ebay-trading-api.service.js'

const amazon: AmazonPublication = { kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'MARKET', products: [{ productId: 'parent-id', sku: 'PARENT' }, { productId: 'child-id', sku: 'CHILD' }], feed: { header: {}, messages: [
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
  const beforeSend = vi.fn()
  m.validate.mockResolvedValueOnce({ ok: true, available: true }).mockResolvedValueOnce({ ok: false, available: true, errors: 'Missing size' })
  await expect(sendAmazonPublication(amazon, 'account-b', beforeSend)).rejects.toMatchObject({ notSent: true, message: 'CHILD: Missing size' })
  expect(beforeSend).not.toHaveBeenCalled()
  expect(m.call).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
})

it('awaits the Amazon journal after every validation and captures the exact outgoing feed and metadata', async () => {
  const events: string[] = []
  m.validate.mockImplementation(async ({ sku }) => { events.push(`validate:${sku}`); return { ok: true, available: true } })
  m.call.mockImplementation(async ({ operation }) => {
    events.push(operation)
    return operation === 'createFeedDocument' ? { feedDocumentId: 'doc', url: 'https://example.test/feed' } : { feedId: 'feed' }
  })
  const beforeSend = vi.fn(async (_request: { feedType: string; marketplaceIds: string[]; feed: AmazonPublication['feed'] }) => {
    events.push('capture-start'); await Promise.resolve(); events.push('capture-finished')
  })
  expect(await sendAmazonPublication(amazon, 'account-b', beforeSend)).toBe('feed')
  expect(events).toEqual(['validate:PARENT', 'validate:CHILD', 'capture-start', 'capture-finished', 'createFeedDocument', 'createFeed'])
  expect(beforeSend).toHaveBeenCalledOnce()
  expect(beforeSend).toHaveBeenCalledWith({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['MARKET'], feed: amazon.feed })
  expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body)).toEqual(beforeSend.mock.calls[0][0].feed)
  expect(m.call.mock.calls[1][0].body).toEqual({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['MARKET'], inputFeedDocumentId: 'doc' })
})

it.each([new Error('Journal unavailable'), 'Journal unavailable'])('does not create an Amazon feed document when the journal rejects (%s)', async error => {
  const beforeSend = vi.fn().mockRejectedValue(error)
  await expect(sendAmazonPublication(amazon, 'account-b', beforeSend)).rejects.toMatchObject({ message: 'Journal unavailable', notSent: true })
  expect(beforeSend).toHaveBeenCalledOnce()
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
const ebayLiveRevision = ebayLiveContentRevision
const ebaySingleItem = (price = 25, quantity = 3) => `<GetItemResponse><Ack>Success</Ack><Item><ItemID>456</ItemID><SKU>PARENT</SKU><Title>Saved &amp; title</Title><Description>Saved description</Description><PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><ConditionID>1000</ConditionID><Country>IT</Country><Currency>EUR</Currency><Location>Rimini</Location><ListingDuration>GTC</ListingDuration><StartPrice currencyID="EUR">${price}</StartPrice><Quantity>${quantity}</Quantity><ProductListingDetails><EAN>1234567890123</EAN></ProductListingDetails><SellingStatus><ListingStatus>Active</ListingStatus><QuantitySold>1</QuantitySold></SellingStatus></Item></GetItemResponse>`
it('creates standalone eBay XML with its saved price, quantity and EAN, and preserves saved listing controls', () => {
  const xml = ebayPublicationXml(ebay, null, true, { subtitle: 'Subtitle & detail', handlingTime: 2, vatRate: 22, bestOffer: false })
  expect(xml).not.toContain('<Variations>'); expect(xml).toContain('<StartPrice>25</StartPrice><Quantity>3</Quantity>')
  expect(xml).toContain('<ProductListingDetails><EAN>1234567890123</EAN></ProductListingDetails>')
  expect(xml).toContain('<SubTitle>Subtitle &amp; detail</SubTitle>')
  // Wave 2 (Owner decision 6) — a stored handling time is not sent: eBay takes it from the shipping policy.
  expect(xml).not.toContain('<DispatchTimeMax>')
  expect(xml).toContain('<VATDetails><VATPercent>22</VATPercent></VATDetails>')
  expect(xml).toContain('<BestOfferEnabled>false</BestOfferEnabled>')
})
it('revises an existing eBay item instead of creating a duplicate or inventing its shipping origin', () => {
  const xml = ebayPublicationXml({ ...ebay, country: '' }, '456', false)
  expect(xml).toContain('<ReviseFixedPriceItemRequest'); expect(xml).toContain('<ItemID>456</ItemID>')
  expect(xml).toContain('<Variations>'); expect(xml).not.toContain('<Country>'); expect(xml).not.toContain('AddFixedPriceItemRequest')
})
it('returns the acknowledged eBay reference before read-back, with a stable deduplication identity', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' }).mockResolvedValueOnce({ ack: 'Success', errors: [], itemId: '456', raw: '<ItemID>456</ItemID>' })
  expect(await sendEbayPublication({ kind: 'ebay', products: [], marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')).toEqual({ reference: '456', warnings: [] })
  expect(m.trading.mock.calls.map(([call]) => call)).toEqual(['VerifyAddFixedPriceItem', 'AddFixedPriceItem'])
  expect(m.trading.mock.calls[1][1]).toContain('<UUID>ABCD1234</UUID>')
})
it.each([null, '456'])('awaits the eBay journal with final request identity before sending item %s', async itemId => {
  const baseline = ebaySingleItem()
  const plan = { kind: 'ebay' as const, products: [], marketplace: 'IT', itemId, liveRevision: itemId ? ebayLiveRevision(baseline) : null, xml: ebayPublicationXml(ebay, itemId, true) }
  const events: string[] = []
  m.trading.mockImplementation(async operation => {
    events.push(operation)
    return { ack: 'Success', errors: [], itemId: '456', raw: operation === 'GetItem' ? baseline : '<Ack>Success</Ack><ItemID>456</ItemID>' }
  })
  const beforeSend = vi.fn(async () => { events.push('capture-start'); await Promise.resolve(); events.push('capture-finished') })
  expect(await sendEbayPublication(plan, 'account-b', 'abcd-1234', beforeSend)).toEqual({ reference: '456', warnings: [] })
  const operation = itemId ? 'ReviseFixedPriceItem' : 'AddFixedPriceItem'
  const identity = itemId ? 'InvocationID' : 'UUID'
  expect(events).toEqual([itemId ? 'GetItem' : 'VerifyAddFixedPriceItem', 'capture-start', 'capture-finished', operation])
  const finalXml = m.trading.mock.calls[1][1]
  expect(beforeSend).toHaveBeenCalledOnce()
  expect(beforeSend).toHaveBeenCalledWith({ operation, xml: finalXml })
  expect(finalXml).toContain(`<${identity}>ABCD1234</${identity}>`)
  expect(plan.xml).not.toContain(`<${identity}>`)
})
it.each([new Error('Journal unavailable'), 'Journal unavailable'])('does not send an eBay listing when the journal rejects (%s)', async error => {
  m.trading.mockResolvedValue({ ack: 'Success', errors: [], itemId: '456', raw: '<Ack>Success</Ack><ItemID>456</ItemID>' })
  const beforeSend = vi.fn().mockRejectedValue(error)
  await expect(sendEbayPublication({ kind: 'ebay', products: [], marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234', beforeSend))
    .rejects.toMatchObject({ message: 'Journal unavailable', notSent: true })
  expect(beforeSend).toHaveBeenCalledOnce()
  expect(m.trading.mock.calls.map(([operation]) => operation)).toEqual(['VerifyAddFixedPriceItem'])
})
it('retains the prior item reference from a conclusive duplicate eBay acknowledgement', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })
    .mockRejectedValueOnce(new TradingApiFailure('Duplicate UUID used.', true, '123'))
  await expect(sendEbayPublication({ kind: 'ebay', products: [], marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234'))
    .resolves.toEqual({ reference: '123', warnings: ['Duplicate UUID used.'] })
})
it('keeps a duplicate eBay acknowledgement uncertain when it has no validated prior reference', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })
    .mockRejectedValueOnce(new TradingApiFailure('Duplicate invocation is still in progress.', true))
  const error = await sendEbayPublication({ kind: 'ebay', products: [], marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')
    .catch(cause => cause)
  expect(error).toMatchObject({ duplicateSubmission: true, message: 'Duplicate invocation is still in progress.' })
  expect(error).not.toHaveProperty('notSent')
})
it('allows an unchanged single-item revision and blocks stale remote price or quantity', async () => {
  const baseline = ebaySingleItem()
  const plan = { kind: 'ebay' as const, products: [], marketplace: 'IT', itemId: '456', liveRevision: ebayLiveRevision(baseline), xml: ebayPublicationXml(ebay, '456', true) }
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: baseline })
    .mockResolvedValueOnce({ ack: 'Success', errors: [], itemId: '456', raw: '<Ack>Success</Ack><ItemID>456</ItemID>' })
  await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234')).resolves.toEqual({ reference: '456', warnings: [] })

  const beforeSend = vi.fn()
  for (const changed of [ebaySingleItem(26, 3), ebaySingleItem(25, 4)]) {
    m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: changed })
    await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234', beforeSend)).rejects.toMatchObject({ notSent: true, message: expect.stringContaining('eBay changed') })
  }
  expect(beforeSend).not.toHaveBeenCalled()
  expect(m.trading.mock.calls.filter(([call]) => call === 'ReviseFixedPriceItem')).toHaveLength(1)
})
// Build shape v2 P4 — a Full update re-sends eBay's own quantities, so a sale between the review and the send refuses it
// (the content revision alone does not see a sale: QuantitySold is not part of it).
it('a Full update is refused, nothing sent, when eBay\'s stock moved after the review', async () => {
  const baseline = ebaySingleItem()
  const full = { xml: ebayPublicationXml(ebay, '456', true), stockRevision: ebayStockRevision(ebayLiveStock(parseEbayItemDocument(baseline))), extras: [], added: [], deletedFields: [], keptRoots: [], blockers: [] }
  const plan = { kind: 'ebay' as const, products: [], marketplace: 'IT', itemId: '456', liveRevision: ebayLiveRevision(baseline), xml: full.xml, full }
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: baseline })
    .mockResolvedValueOnce({ ack: 'Success', errors: [], itemId: '456', raw: '<Ack>Success</Ack><ItemID>456</ItemID>' })
  await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234')).resolves.toEqual({ reference: '456', warnings: [] })
  const sold = baseline.replace('<QuantitySold>1</QuantitySold>', '<QuantitySold>2</QuantitySold>')
  expect(ebayLiveRevision(sold)).toBe(ebayLiveRevision(baseline))
  const beforeSend = vi.fn()
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: sold })
  await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234', beforeSend)).rejects.toMatchObject({ notSent: true, message: expect.stringContaining('stock changed after the review') })
  expect(beforeSend).not.toHaveBeenCalled()
  expect(m.trading.mock.calls.filter(([call]) => call === 'ReviseFixedPriceItem')).toHaveLength(1)
})
// E1b (decision 9) — a Full update that renames a live variation value (black → Nero) and that eBay refuses for it
// (code 21916664, the answer proven for a renamed variation name) is said in plain words, with eBay's own text after it;
// any other refusal keeps eBay's text alone. Nothing is sent either way (eBay's Revise is all or nothing).
it('a Full update eBay refuses for a renamed variation value says how to keep the old word, keeping eBay\'s own text', async () => {
  const raw = `<GetItemResponse><Ack>Success</Ack><Item><ItemID>456</ItemID><SKU>PARENT</SKU><Title>T</Title><Variations><Variation><SKU>CHILD-M</SKU><StartPrice>20</StartPrice><Quantity>3</Quantity><VariationSpecifics><NameValueList><Name>Colore</Name><Value>black</Value></NameValueList></VariationSpecifics><SellingStatus><QuantitySold>1</QuantitySold></SellingStatus></Variation></Variations><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item></GetItemResponse>`
  const xml = '<?xml version="1.0" encoding="UTF-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>456</ItemID><Variations><Variation><SKU>CHILD-M</SKU><StartPrice>20</StartPrice><Quantity>2</Quantity><VariationSpecifics><NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList></VariationSpecifics></Variation></Variations></Item></ReviseFixedPriceItemRequest>'
  const full = { xml, stockRevision: ebayStockRevision(ebayLiveStock(parseEbayItemDocument(raw))), extras: [], added: [], deletedFields: [], keptRoots: [], blockers: [] }
  const plan = { kind: 'ebay' as const, products: [], marketplace: 'IT', itemId: '456', liveRevision: ebayLiveRevision(raw), liveContent: parseEbayPublicationItem(raw), xml, full }
  const refused = (code: string) => new TradingApiFailure(`eBay ReviseFixedPriceItem Failure: Variation specifics provided does not match. (code ${code})`, false, undefined, [{ code, message: 'Variation specifics provided does not match.' }])
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw }).mockRejectedValueOnce(refused('21916664'))
  const error = await sendEbayPublication(plan, 'account-b', 'abcd-1234').catch(e => e)
  expect(error).toMatchObject({ notSent: true })
  expect(error.message).toContain('eBay refused to rename a variation value (CHILD-M Colore black → Nero)')
  expect(error.message).toContain('type "black" in CHILD-M\'s Colore cell on the eBay sheet')
  expect(error.message).toContain('eBay said: eBay ReviseFixedPriceItem Failure: Variation specifics provided does not match. (code 21916664)')
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw }).mockRejectedValueOnce(refused('21919301'))
  await expect(sendEbayPublication(plan, 'account-b', 'abcd-1234')).rejects.toMatchObject({ notSent: true, message: 'eBay ReviseFixedPriceItem Failure: Variation specifics provided does not match. (code 21919301)' })
})
it('preserves eBay acknowledgement warnings and the item reference independently of later read-back', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<Ack>Success</Ack>' })
    .mockResolvedValueOnce({ ack: 'Warning', errors: ['eBay shortened the submitted title'], itemId: '456', raw: '<Ack>Warning</Ack><ItemID>456</ItemID>' })
  const acknowledged = await sendEbayPublication({ kind: 'ebay', products: [], marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'abcd-1234')
  expect(acknowledged).toEqual({ reference: '456', warnings: ['eBay shortened the submitted title'] })
  m.trading.mockRejectedValueOnce(new Error('GetItem connection interrupted'))
  await expect(readEbayPublication(acknowledged.reference, 'account-b', 'IT')).resolves.toBeNull()
  expect(acknowledged).toEqual({ reference: '456', warnings: ['eBay shortened the submitted title'] })
})
it('reads the acknowledged eBay item without resubmitting and distinguishes verified, incompatible and unknown results', async () => {
  m.trading.mockResolvedValueOnce({ ack: 'Warning', errors: ['Policy warning'], raw: '<GetItemResponse><Ack>Warning</Ack><Item><ItemID>456</ItemID><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item></GetItemResponse>' })
  await expect(readEbayPublication('456', 'account-b', 'IT')).resolves.toEqual({ reference: '456', warnings: ['Policy warning'], verified: true })
  m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw: '<GetItemResponse><Ack>Success</Ack><Item><ItemID>456</ItemID><SellingStatus><ListingStatus>Completed</ListingStatus></SellingStatus></Item></GetItemResponse>' })
  await expect(readEbayPublication('456', 'account-b', 'IT')).resolves.toEqual({ reference: '456', warnings: ['This eBay listing is not active.'], verified: false })
  m.trading.mockRejectedValueOnce(new Error('Connection interrupted'))
  await expect(readEbayPublication('456', 'account-b', 'IT')).resolves.toBeNull()
  expect(m.trading.mock.calls.slice(-3).map(([call]) => call)).toEqual(['GetItem', 'GetItem', 'GetItem'])
})
it('never creates an eBay listing after a refused preview', async () => {
  const beforeSend = vi.fn()
  m.trading.mockRejectedValue(new Error('Missing return policy'))
  await expect(sendEbayPublication({ kind: 'ebay', products: [], marketplace: 'IT', itemId: null, liveRevision: null, xml: ebayPublicationXml(ebay, null, true) }, 'account-b', 'id', beforeSend)).rejects.toMatchObject({ notSent: true })
  expect(beforeSend).not.toHaveBeenCalled()
  expect(m.trading).toHaveBeenCalledTimes(1)
})
it('does not accept another eBay item or status markup embedded inside its description', async () => {
  for (const raw of [
    '<GetItemResponse><Item><ItemID>999</ItemID><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item></GetItemResponse>',
    '<GetItemResponse><Item><ItemID>456</ItemID><Description><![CDATA[<ListingStatus>Active</ListingStatus>]]></Description><SellingStatus><ListingStatus>Completed</ListingStatus></SellingStatus></Item></GetItemResponse>',
  ]) {
    m.trading.mockResolvedValueOnce({ ack: 'Success', errors: [], raw })
    expect((await readEbayPublication('456', 'account-b', 'IT'))?.verified ?? false).toBe(false)
  }
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
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { aliasKey: 'alias-b', currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', offers: [{ isActive: true, sku: 'ALIAS-SKU', fulfillmentMethod: 'FBM' }], followMasterPrice: false, priceOverride: 35, stockBuffer: 2 }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: {} }], catalogue: { schema: { present: true }, fields: [] } }] }
  const prepared = await prepareAmazonPublication(facts)
  expect(prepared.products).toEqual([{ productId: 'p', sku: 'ALIAS-SKU' }])
  expect(m.row).toHaveBeenCalledWith(expect.objectContaining({ item_sku: 'ALIAS-SKU', _isNew: false, record_action: 'partial_update', purchasable_offer__our_price: '35.00' }))
  // Amazon sheet gaps: the row carries no quantity; the stock job's quantity is injected at send (`withSendQuantities`).
  expect(m.row.mock.calls[0][0]).not.toHaveProperty('fulfillment_availability__quantity')
  expect(m.row.mock.calls[0][0]).not.toHaveProperty('main_product_image_locator')
  expect(m.row.mock.calls[0][0]).not.toHaveProperty('purchasable_offer__condition_type')
  expect(prepared.feed.messages[0]).toMatchObject({ sku: 'ALIAS-SKU', operationType: 'PARTIAL_UPDATE', attributes: { item_name: [{ value: 'Saved localized title', language_tag: 'it_IT' }] } })
  // A content update keeps the existing Amazon gallery, even when the shared
  // library contains more images than a single product gallery permits.
  product.images = Array.from({ length: 24 }, (_, i) => ({ id: String(i), url: `https://example.test/${i}` }))
  await expect(prepareAmazonPublication(facts)).resolves.toBeDefined()
  // No Main listing row is known on this ASIN: the alias is its own product page and keeps its own photos (as before).
  facts.listings[0].platformAttributes = { _productMediaLocales: writeMediaCollection({}, 'it', { version: 1, items: [{ assetId: '4' }] }) }
  await prepareAmazonPublication(facts)
  expect(m.row.mock.calls.at(-1)![0].main_product_image_locator).toBe('https://example.test/4')
  facts.listings[0].platformAttributes = { _productMediaLocales: writeMediaCollection({}, 'it', { version: 1, items: [] }) }
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('add a product image')
  // Owner 2026-10-05 — on the live Main listing's ASIN the alias sends no photo of its own (Amazon keeps one set per product).
  m.mainRows = [{ id: 'main', productId: 'p', version: 1, externalListingId: 'ASIN', isPublished: true, platformAttributes: {} }]
  facts.listings[0].platformAttributes = { _productMediaLocales: writeMediaCollection({}, 'it', { version: 1, items: [{ assetId: '4' }] }) }
  await prepareAmazonPublication(facts)
  expect(m.row.mock.calls.at(-1)![0]).not.toHaveProperty('main_product_image_locator')
  m.mainRows = []
  facts.listings[0].offers = []
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('own Amazon seller SKU')
})

// Build shape v2 P4 — which roots a Full update may remove: a root a sheet column resolves (a mapped cell, blank or not),
// in this product type, and never price/offer/stock, photos, content languages (handled per language) or the family shape.
it('names the roots Nexus manages for a Full row only — never price, stock, photos, content or structure', async () => {
  const product = { id: 'p', sku: 'SKU-1', name: 'Giacca', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const roots = ['fabric_type', 'color', 'merchant_shipping_group', 'purchasable_offer', 'item_name', 'main_product_image_locator', 'variation_theme', 'brand']
  m.spec.mockResolvedValue({ fields: [], validationSchema: { type: 'object', properties: Object.fromEntries(roots.map(root => [root, { type: 'array' }])) } })
  const field = (fieldKey: string, owner?: string) => ({ fieldKey, label: fieldKey, ...(owner ? { sourceOwner: { label: owner } } : {}) })
  const cell = (status: string, value: unknown = null) => ({ status, value, errors: [] })
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { aliasKey: '', currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', offers: [{ isActive: true, sku: 'SKU-1', fulfillmentMethod: 'FBM' }] }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: {
      fabric_type: cell('mapped'), color__value: cell('unmapped'), merchant_shipping_group: cell('mapped'), purchasable_offer__our_price: cell('mapped', 29),
      item_name: cell('mapped', 'Giacca'), main_product_image_locator: cell('mapped'), variation_theme: cell('mapped'), not_in_schema: cell('mapped'), brand__value: cell('mapped', 'Xavia'),
    } }], catalogue: { schema: { present: true }, fields: [field('fabric_type'), field('color__value'), field('merchant_shipping_group', 'Inventory'), field('purchasable_offer__our_price'),
      field('item_name'), field('main_product_image_locator'), field('variation_theme'), field('not_in_schema'), field('brand__value', 'Listing')] } }] }
  expect((await prepareAmazonPublication(facts, { fullProductIds: new Set(['p']) })).full).toEqual({ p: { managedRoots: ['brand', 'fabric_type'] } })
  // Partial update (and a row not asked for): nothing changes in what the builder returns.
  expect(await prepareAmazonPublication(facts)).not.toHaveProperty('full')
  expect(await prepareAmazonPublication(facts, { fullProductIds: new Set(['other']) })).not.toHaveProperty('full')
})

it('an existing (live) Amazon listing is never sent a fulfilment code by Publish, whatever the flags say (design §B)', async () => {
  const product = { id: 'p', sku: 'SKU-1', name: 'Giacca', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { aliasKey: '', currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', fulfillmentMethod: null, platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] },
      offers: [{ isActive: true, sku: 'SKU-1', fulfillmentMethod: null }] }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: {} }], catalogue: { schema: { present: true }, fields: [] } }] }
  m.region.mockResolvedValue('eu')
  await prepareAmazonPublication(facts)
  // 2026-09-27 the old rule (`offer ?? typed ?? product`) sent DEFAULT here. Amazon sheet gaps: a live listing's
  // fulfilment is the fulfilment door's and the stock job's, so Publish sends no code at all — FBA can never be
  // re-coded by a publish, and a Remote Fulfilment code is never rebuilt.
  expect(m.row.mock.calls.at(-1)![0]).not.toHaveProperty('fulfillment_availability__fulfillment_channel_code')
  // Same with no report and no mirror (the product flag says FBM): still no code on a live listing.
  facts.listings[0].platformAttributes = {}
  await prepareAmazonPublication(facts)
  expect(m.row.mock.calls.at(-1)![0]).not.toHaveProperty('fulfillment_availability__fulfillment_channel_code')
})

it('F2: the Amazon product type is the resolver’s answer for this listing (no second read), never the product’s own', async () => {
  // The product says OUTERWEAR; the resolver found COAT on its Amazon listings in the region's other markets.
  const product = { id: 'p', sku: 'SKU-1', name: 'Giacca', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', productType: 'OUTERWEAR', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', platformAttributes: {}, offers: [{ isActive: true, sku: 'SKU-1', fulfillmentMethod: 'FBM' }] }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT', source: 'listingOtherMarket' }, cells: {} }], catalogue: { schema: { present: true }, fields: [] } }] }
  await prepareAmazonPublication(facts)
  expect(m.row.mock.calls.at(-1)![0].product_type).toBe('COAT')
  expect(m.spec).toHaveBeenLastCalledWith('IT', 'COAT', 'account-b')
  // Conflicting shared categories resolve to no type (and block the review); the product's own type never settles it.
  facts.resolved[0].products[0].category = { channelCategoryId: null, source: 'none', conflicts: ['a → COAT', 'b → PANTS'] }
  await prepareAmazonPublication(facts).catch(() => undefined)
  expect(m.row.mock.calls.at(-1)![0].product_type).toBe('')
})

const mappingRow = (channelKey: string, targetKind: string, targetKey: string, extra: Record<string, unknown> = {}) => ({ id: channelKey, setId: 'set-1', channelKey, columnKey: channelKey, label: null, aliases: [], productTypes: [],
  requirement: 'optional', templateRequirement: null, targetKind, targetKey, transform: [], direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0, ...extra })

it('CHMAP M4: a field the Owner ignored in the ACTIVE mapping version is left out of the Amazon payload, never cleared', async () => {
  m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    team_name: { type: 'array', items: { properties: { value: { type: 'string' } } } }, color: { type: 'array', items: { properties: { value: { type: 'string' } } } },
  } } }))
  const product = { id: 'p', sku: 'SKU-1', name: 'Giacca', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', offers: [{ isActive: true, sku: 'SKU-1', fulfillmentMethod: 'FBM' }] }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: { team_name: { value: 'Giacca', errors: [] }, color: { value: 'Nero', errors: [] } } }],
      catalogue: { schema: { present: true }, fields: [{ fieldKey: 'team_name' }, { fieldKey: 'color' }] } }] }
  // Control: no ACTIVE version — both are sent, as today.
  const today = JSON.stringify((await prepareAmazonPublication(facts)).feed.messages[0])
  expect(today).toContain('team_name'); expect(today).toContain('Nero')
  // The Owner ignored the team_name column: the field is not sent, and no delete is prepared for it.
  m.sets.mockResolvedValue([{ id: 'set-1', version: 2, formKey: 'COAT+PANTS', marketplace: 'IT' }])
  m.mapFields.mockResolvedValue([mappingRow('team_name#1.value', 'channelField', 'team_name', { state: 'ignored', decidedBy: 'owner', reason: 'Amazon workaround' }), mappingRow('color#1.value', 'channelField', 'color')])
  const message = (await prepareAmazonPublication(facts)).feed.messages[0]
  expect(JSON.stringify(message)).not.toContain('team_name')
  expect(JSON.stringify(message)).toContain('Nero')
  expect((message as any).patches?.some((p: any) => p.op === 'delete') ?? false).toBe(false)
  // A saved listing fact the price builder serializes (RRP) follows the same decision.
  m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    team_name: { type: 'array', items: { properties: { value: { type: 'string' } } } }, color: { type: 'array', items: { properties: { value: { type: 'string' } } } },
    list_price: { type: 'array', selectors: ['marketplace_id', 'currency'], items: { properties: { value_with_tax: { type: 'number' }, currency: { const: 'EUR' }, marketplace_id: { const: 'MARKET' } } } },
  } } }))
  facts.resolved[0].products[0].cells.list_price = { value: 128.1, errors: [] }
  facts.resolved[0].catalogue.fields.push({ fieldKey: 'list_price', sourceOwner: { label: 'Pricing' } })
  m.mapFields.mockResolvedValue([mappingRow('list_price#1.value_with_tax', 'channelField', 'list_price', { state: 'managed', decidedBy: 'owner', reason: 'prices are managed elsewhere' })])
  expect(JSON.stringify((await prepareAmazonPublication(facts)).feed.messages[0])).not.toContain('128.1')
  m.mapFields.mockResolvedValue([])
  expect(JSON.stringify((await prepareAmazonPublication(facts)).feed.messages[0])).toContain('128.1')
  // A version on another market or product type changes nothing here.
  m.sets.mockResolvedValue([{ id: 'set-1', version: 2, formKey: 'PANTS', marketplace: 'IT' }])
  expect(JSON.stringify((await prepareAmazonPublication(facts)).feed.messages[0])).toContain('team_name')
  m.sets.mockResolvedValue([]); m.mapFields.mockResolvedValue([])
})

it('CHMAP M4: Amazon takes an attribute whole — one ignored part keeps the whole attribute; every ignored column of it leaves it out', async () => {
  const text = { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } } } }
  m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    sleeve: { type: 'array', selectors: ['marketplace_id'], items: { type: 'object', properties: { marketplace_id: { const: 'MARKET' }, type: text, length_description: text } } },
    team_name: text,
  } } }))
  const product = { id: 'p', sku: 'SKU-1', name: 'Giacca', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent: product, products: [product], languages: ['it'], destination: { currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', offers: [{ isActive: true, sku: 'SKU-1', fulfillmentMethod: 'FBM' }] }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: { sleeve__type: { value: 'Raglan', errors: [] }, sleeve__length_description: { value: 'Manica lunga', errors: [] }, team_name: { value: 'Giacca', errors: [] } } }],
      catalogue: { schema: { present: true }, fields: [{ fieldKey: 'sleeve__type' }, { fieldKey: 'sleeve__length_description' }, { fieldKey: 'team_name' }] } }] }
  const send = async () => (await prepareAmazonPublication(facts)).feed.messages[0] as any
  const today = await send()
  expect(JSON.stringify(today.attributes.sleeve)).toContain('Raglan'); expect(JSON.stringify(today.attributes.sleeve)).toContain('Manica lunga')
  m.sets.mockResolvedValue([{ id: 'set-1', version: 2, formKey: 'COAT', marketplace: 'IT' }])
  // One part ignored, the other still sent: a replace of `sleeve` without that part would clear it on Amazon, so the payload is today's.
  m.mapFields.mockResolvedValue([mappingRow('sleeve#1.type#1.value', 'channelField', 'sleeve__type'),
    mappingRow('sleeve#1.length_description#1.value', 'channelField', 'sleeve__length_description', { state: 'ignored', decidedBy: 'owner', reason: 'not ours' })])
  expect(await send()).toEqual(today)
  // Every column of the version that carries `sleeve` ignored (it has no column for the other part): no `sleeve`, no delete.
  m.mapFields.mockResolvedValue([mappingRow('sleeve#1.type#1.value', 'channelField', 'sleeve__type', { state: 'ignored', decidedBy: 'owner', reason: 'not ours' })])
  const without = await send()
  expect(JSON.stringify(without)).not.toContain('sleeve'); expect(JSON.stringify(without)).toContain('Giacca')
  // The content resolver's own attributes follow the same decision.
  m.mapFields.mockResolvedValue([mappingRow('item_name#1.value', 'channelField', 'item_name', { state: 'ignored', decidedBy: 'owner', reason: 'titles are written on Amazon' })])
  expect(JSON.stringify(await send())).not.toContain('Saved localized title')
  // A cleared field makes the message a PATCH, and the content goes as patches: the ignored title is not among them.
  const cells = facts.resolved[0].products[0].cells
  const kept = { ...cells }
  Object.assign(cells, { sleeve__type: { value: null, provenance: 'override', errors: [] }, sleeve__length_description: { value: null, provenance: 'override', errors: [] } })
  const patch = await send()
  expect(patch.operationType).toBe('PATCH'); expect(patch.patches).toContainEqual(expect.objectContaining({ op: 'delete', path: '/attributes/sleeve' }))
  expect(JSON.stringify(patch)).toContain('Giacca'); expect(JSON.stringify(patch)).not.toContain('Saved localized title')
  Object.assign(cells, kept)
  m.mapFields.mockResolvedValue([mappingRow('sleeve#1.type#1.value', 'channelField', 'sleeve__type', { state: 'ignored', decidedBy: 'owner', reason: 'not ours' })])
  // A field the push leaves out cannot stop the publish with its own errors.
  facts.resolved[0].products[0].cells.sleeve__type = { value: 'Raglan', errors: ['Not an Amazon value'] }
  await expect(send()).resolves.toEqual(without)
  m.sets.mockResolvedValue([]); m.mapFields.mockResolvedValue([])
  await expect(send()).rejects.toThrow('Mapping validation failed')
})

it('CHMAP M7 (B2): a market outside the row builder\'s five gets its own marketplace id and language tag, not Italy\'s', async () => {
  const text = { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } } } }
  m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'NL', productType: 'COAT', schemaDefinition: { properties: { color: text } } }))
  const product = { id: 'p', sku: 'SKU-1', name: 'Jas', basePrice: 29, totalStock: 5, fulfillmentMethod: 'FBM', images: [{ id: 'image', url: 'https://example.test/image' }] }
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'NL', accountId: 'account-b' }, parent: product, products: [product], languages: ['nl'], destination: { currency: 'EUR' },
    listings: [{ productId: 'p', externalListingId: 'ASIN', offers: [{ isActive: true, sku: 'SKU-1', fulfillmentMethod: 'FBM' }] }],
    resolved: [{ products: [{ productId: 'p', category: { channelCategoryId: 'COAT' }, cells: { color: { value: 'Zwart', errors: [] } } }], catalogue: { schema: { present: true }, fields: [{ fieldKey: 'color' }] } }] }
  await prepareAmazonPublication(facts)
  // The configured NL marketplace id (the test's resolver answers 'MARKET') and the NL language, never IT's.
  expect(m.hints).toHaveBeenLastCalledWith(expect.objectContaining({ market: { marketplaceId: 'MARKET', languageTag: 'nl_NL' } }))
})

it('checks Amazon variation collisions against saved channel sizes instead of stale shared sizes', async () => {
  m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    list_price: { type: 'array', selectors: ['marketplace_id', 'currency'], items: { properties: { value_with_tax: { type: 'number' }, currency: { const: 'EUR' }, marketplace_id: { const: 'MARKET' } } } },
    child_parent_sku_relationship: { type: 'array', items: { properties: { parent_sku: { type: 'string' }, child_relationship_type: { type: 'string' }, marketplace_id: { const: 'MARKET' } } } },
    variation_theme: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } },
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
  const facts: any = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, parent, products, languages: ['it'], destination: { currency: 'EUR' },
    listings: products.map(p => ({ productId: p.id, externalListingId: `ASIN-${p.id}`, offers: [] })),
    resolved: [{ products: products.map(p => ({ productId: p.id, category: { channelCategoryId: 'COAT' }, cells: {
      color: { value: 'Black', errors: [] }, apparel_size__size: { value: p.id === 'xxs' ? 'xx_s' : 'x_s', errors: [] },
      list_price: { value: 128.1, errors: [] }, child_parent_sku_relationship__parent_sku: { value: 'WRONG-PARENT', errors: [] }, child_parent_sku_relationship__child_relationship_type: { value: 'variation', errors: [] },
    } })), catalogue: { schema: { present: true }, fields: [{ fieldKey: 'color', sheetKey: 'color' }, { fieldKey: 'apparel_size__size', sheetKey: 'size' }, { fieldKey: 'list_price', sourceOwner: { label: 'Pricing' } }, ...['parent_sku', 'child_relationship_type'].map(key => ({ fieldKey: `child_parent_sku_relationship__${key}`, sourceOwner: { label: 'Family' } }))] } }],
  }
  const prepared = await prepareAmazonPublication(facts)
  expect(prepared.feed.messages[1].attributes).toMatchObject({ list_price: [{ value_with_tax: 128.1, currency: 'EUR', marketplace_id: 'MARKET' }], child_parent_sku_relationship: [{ parent_sku: 'PARENT', child_relationship_type: 'variation', marketplace_id: 'MARKET' }] })
  // 2026-10-03 — every family row carries the relationship (the parent without a parent SKU) and the theme, with no marketplace_id.
  expect(prepared.feed.messages[0].attributes?.child_parent_sku_relationship).toEqual([{ child_relationship_type: 'variation', marketplace_id: 'MARKET' }])
  for (const message of prepared.feed.messages) expect(message.attributes?.variation_theme, message.sku).toEqual([{ name: theme }])
  facts.listings = facts.listings.reverse().map((listing: any) => ({ ...listing, offers: [{ isActive: true, sku: `SELLER-${listing.productId}` }] }))
  const sellerMapped = await prepareAmazonPublication(facts)
  expect(sellerMapped.products).toEqual([{ productId: 'p', sku: 'SELLER-p' }, { productId: 'xs', sku: 'SELLER-xs' }, { productId: 'xxs', sku: 'SELLER-xxs' }])
  expect(sellerMapped.feed.messages.map(message => message.sku)).toEqual(['SELLER-p', 'SELLER-xs', 'SELLER-xxs'])
  const openChild = await prepareAmazonPublication({ ...facts, products: [children[0]] })
  expect(openChild.products).toEqual([{ productId: 'xs', sku: 'SELLER-xs' }])
  expect(openChild.feed.messages).toHaveLength(1)
  expect(openChild.feed.messages[0].attributes?.child_parent_sku_relationship).toEqual([{ parent_sku: 'SELLER-p', child_relationship_type: 'variation', marketplace_id: 'MARKET' }])
  const allClosed = await prepareAmazonPublication({ ...facts, products: [] })
  expect(allClosed.products).toEqual([]); expect(allClosed.feed.messages).toEqual([])
  facts.resolved[0].products[2].cells.apparel_size__size.value = 'x_s'
  await expect(prepareAmazonPublication(facts)).rejects.toThrow('2 variants cannot be told apart')
})

it('keeps each Amazon issue apart with its code, severity and attributes, and the feed completion time (sheet publish parity, step 2)', async () => {
  m.call.mockResolvedValueOnce({ processingStatus: 'DONE', resultFeedDocumentId: 'report', processingEndTime: '2026-10-02T09:05:00Z' })
    .mockResolvedValueOnce({ url: 'https://example.test/report' })
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    issues: [
      { messageId: 2, code: '90220', severity: 'ERROR', message: 'outer is required', attributeNames: ['outer'] },
      { messageId: 2, code: '99022', severity: 'ERROR', message: 'size needs a value', attributeNames: ['bottoms_size'] },
      { messageId: 1, code: '18', severity: 'WARNING', message: 'closure was normalised', attributeNames: ['closure'] },
    ],
    summary: { messagesProcessed: 2, messagesAccepted: 1, messagesInvalid: 1, errors: 2, warnings: 1 },
  }), { status: 200 }))
  const report = await readAmazonPublication('feed', 'account-b', ['PARENT', 'CHILD'])
  expect(report?.completedAt).toEqual(new Date('2026-10-02T09:05:00Z'))
  expect(report?.results).toEqual([
    { sku: 'PARENT', failed: false, message: 'closure was normalised',
      issues: [{ code: '18', severity: 'warning', message: 'closure was normalised', attributeNames: ['closure'] }] },
    { sku: 'CHILD', failed: true, message: 'outer is required; size needs a value', issues: [
      { code: '90220', severity: 'error', message: 'outer is required', attributeNames: ['outer'] },
      { code: '99022', severity: 'error', message: 'size needs a value', attributeNames: ['bottoms_size'] }] },
  ])
})

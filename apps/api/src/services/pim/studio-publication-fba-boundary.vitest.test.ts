/**
 * D8 — Studio Publish's Amazon feed passes the FBA boundary before anything leaves Nexus: a merchant quantity for an FBA
 * SKU is refused with `notSent` (the publication is marked FAILED), so no preview, journal, feed document or upload
 * happens. Control: the same feed for a genuine FBM SKU is sent.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ validate: vi.fn(), call: vi.fn(), client: vi.fn(), products: vi.fn(), stock: vi.fn() }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { product: { findMany: m.products }, stockLevel: { findMany: m.stock } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../amazon/flat-file.service.js', () => ({ AmazonFlatFileService: class {} }))
vi.mock('../categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'SELLER', getAmazonSpClient: m.client, getAmazonRegion: async () => 'eu' }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { validateListing = m.validate } }))

import { sendAmazonPublication, type AmazonPublication } from './studio-publication-amazon.js'

const plan: AmazonPublication = { kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'APJ6JRA9NG5V4', products: [{ productId: 'p-1', sku: 'JKT-M' }], feed: { header: { sellerId: 'SELLER', version: '2.0' }, messages: [
  { messageId: 1, sku: 'JKT-M', operationType: 'UPDATE', productType: 'COAT', attributes: {
    item_name: [{ value: 'Giacca', language_tag: 'it_IT' }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 5 }],
  } },
] } }
const listing = { fulfillmentMethod: 'FBM', platformAttributes: {}, flatFileSnapshot: {}, offers: [] }

beforeEach(() => {
  vi.clearAllMocks()
  m.client.mockResolvedValue({ callAPI: m.call })
  m.validate.mockResolvedValue({ ok: true, available: true })
  m.call.mockImplementation(async ({ operation }: any) => operation === 'createFeedDocument' ? { feedDocumentId: 'doc', url: 'https://example.test/feed' } : { feedId: 'feed' })
  m.stock.mockResolvedValue([])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
})
afterEach(() => { vi.unstubAllGlobals() })

it('refuses a merchant quantity for an FBA-stocked SKU typed FBM: nothing is validated, journaled or uploaded', async () => {
  m.products.mockResolvedValue([{ id: 'p-1', sku: 'JKT-M', fulfillmentMethod: 'FBM', channelListings: [listing] }])
  m.stock.mockResolvedValue([{ productId: 'p-1', quantity: 12 }])
  const beforeSend = vi.fn()
  await expect(sendAmazonPublication(plan, 'acct-1', beforeSend)).rejects.toMatchObject({ notSent: true,
    message: 'JKT-M is fulfilled by Amazon (FBA) — a merchant quantity would switch it to FBM.' })
  expect(m.call.mock.calls.some(([request]) => request.operation === 'createFeedDocument')).toBe(false)
  expect(m.call).not.toHaveBeenCalled()
  expect(m.validate).not.toHaveBeenCalled()
  expect(beforeSend).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('fails closed: an evidence lookup error refuses the feed the same way', async () => {
  m.products.mockRejectedValue(new Error('connection reset'))
  await expect(sendAmazonPublication(plan, 'acct-1')).rejects.toMatchObject({ notSent: true, message: expect.stringContaining('JKT-M is fulfilled by Amazon (FBA)') })
  expect(m.call).not.toHaveBeenCalled()
})

it('control: the same feed for a genuine FBM SKU is validated and sent', async () => {
  m.products.mockResolvedValue([{ id: 'p-1', sku: 'JKT-M', fulfillmentMethod: 'FBM', channelListings: [listing] }])
  expect(await sendAmazonPublication(plan, 'acct-1')).toBe('feed')
  expect(m.validate).toHaveBeenCalledOnce()
  expect(m.call.mock.calls.map(([request]) => request.operation)).toEqual(['createFeedDocument', 'createFeed'])
  expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body)).toEqual(plan.feed)
})

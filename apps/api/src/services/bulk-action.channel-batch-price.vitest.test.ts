/**
 * Round 7 (2026-10-01) — the bulk channel batch (CHANNEL_BATCH, operation `price`) sends each listing THE send price
 * (`listingSendPrice`: the price door's and the publishers' answer), in its market's own currency, held to the
 * product's floor and ceiling — or skips it with the reason.
 *
 * 🔴 WHAT THIS GUARDS. Amazon, eBay and Shopify (linked) price pushes sent `listing.price ?? product.basePrice` with a
 * hard-coded `currency = 'EUR'`: a pinned listing's own price could be ignored for a stale `price`, a "master +10%"
 * follower could get the master, a follower in GBP got the EUR number, and the eBay batch said EUR on eBay UK.
 *
 * The batch senders, the accounts and the database are stand-ins; the handler and the shared rule are real. Every id is
 * invented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  listings: [] as any[],
  markets: [{ channel: 'AMAZON', code: 'IT', currency: 'EUR' }, { channel: 'AMAZON', code: 'UK', currency: 'GBP' }, { channel: 'EBAY', code: 'IT', currency: 'EUR' },
    { channel: 'EBAY', code: 'UK', currency: 'GBP' }, { channel: 'SHOPIFY', code: 'GLOBAL', currency: 'EUR' }] as any[],
  bounds: { minPrice: null, maxPrice: null } as any,
  amazon: [] as any[],
  ebay: [] as any[],
  shopify: [] as any[],
}))
vi.mock('./channel-batch/amazon-batch-feed.service.js', () => ({ submitAmazonListingsBatch: vi.fn(async (input: any) => { h.amazon.push(input); return {} }) }))
vi.mock('./channel-batch/ebay-parallel-batch.service.js', () => ({ submitEbayParallelBatch: vi.fn(async (input: any) => { h.ebay.push(input); return { results: [] } }) }))
vi.mock('./shopify/listing-write.service.js', () => ({ syncShopifyLinkedListing: vi.fn(async (_row: any, _account: string, work: any) => { h.shopify.push(work); return 'ok' }) }))
vi.mock('./shopify/offer-sync.service.js', () => ({ syncNativeShopifyOffer: vi.fn(async () => 'ok') }))
vi.mock('./write-account-guard.js', () => ({ assertWriteAccount: vi.fn(async () => undefined) }))
vi.mock('../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: vi.fn(async () => 'TEST-SELLER'), amazonAccount: vi.fn(async () => null) }))
vi.mock('./connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  tryResolveConnection: vi.fn(async () => ({ id: 'ebay-account' })),
  listActiveConnections: vi.fn(async () => [{ id: 'shop-account' }]),
}))

import { BulkActionService } from './bulk-action.service.js'

const db = {
  channelListing: { findFirst: vi.fn(async () => h.listings[0] ?? null), findMany: vi.fn(async () => h.listings) },
  marketplace: { findMany: vi.fn(async ({ where }: any) => h.markets.filter((m) => m.channel === where.channel)) },
  product: { findUnique: vi.fn(async () => h.bounds) },
}
const service = new BulkActionService(db as any) as unknown as { processChannelBatch: (item: any, payload: any, channel: string | null) => Promise<{ status: string; reason?: string }> }
/** A product at master 10. */
const product = { id: 'p1', sku: 'TEST-SKU-1', basePrice: 10, totalStock: 4 }
const listing = (channel: string, marketplace: string, extra: Record<string, unknown> = {}) => ({
  id: 'L1', productId: 'p1', channel, marketplace, channelConnectionId: channel === 'SHOPIFY' ? 'shop-account' : 'acct', externalListingId: 'TEST-OFFER-1',
  followMasterPrice: true, pricingRule: 'FIXED', priceAdjustmentPercent: null, priceOverride: null, price: 10, quantity: 3, syncPaused: false,
  platformAttributes: { variantId: '11', inventoryItemId: '22', shopifyProductId: '33', inventoryLocationId: 'gid://shopify/Location/9' }, ...extra,
})
const run = (channel: string, marketplace: string) => service.processChannelBatch(product, { channel, operation: 'price', marketplace }, null)

beforeEach(() => { h.amazon = []; h.ebay = []; h.shopify = []; h.bounds = { minPrice: null, maxPrice: null } })

describe('🔴 the bulk channel batch sends the listing\'s send price, in its market\'s currency', () => {
  it('Amazon: a pinned listing sends its pin (15.00), not the stale stored price', async () => {
    h.listings = [listing('AMAZON', 'IT', { followMasterPrice: false, priceOverride: 15, price: 12.5 })]
    expect(await run('AMAZON', 'IT')).toEqual({ status: 'processed' })
    expect(h.amazon[0].operations).toEqual([{ type: 'price', sku: 'TEST-SKU-1', currency: 'EUR', value: 15 }])
  })

  it('Amazon: a "master +10%" follower sends the rule\'s 11.00 from the current master, not the master or a stale price', async () => {
    h.listings = [listing('AMAZON', 'IT', { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 10 })]
    expect(await run('AMAZON', 'IT')).toEqual({ status: 'processed' })
    expect(h.amazon[0].operations[0]).toMatchObject({ currency: 'EUR', value: 11 })
  })

  it('🔴 Amazon UK: a follower holding no price is skipped with the reason — the EUR number is never sent as pounds', async () => {
    h.listings = [listing('AMAZON', 'UK', { price: null })]
    expect(await run('AMAZON', 'UK')).toEqual({ status: 'skipped',
      reason: 'TEST-SKU-1: Amazon UK sells in GBP, and this listing follows the master price in EUR. Nexus does not convert it. Set this listing\'s own GBP price. Nothing was sent.' })
    expect(h.amazon).toEqual([])
  })

  it('Amazon UK: a follower holding its own 9.00 sends 9.00 in GBP', async () => {
    h.listings = [listing('AMAZON', 'UK', { price: 9 })]
    await run('AMAZON', 'UK')
    expect(h.amazon[0].operations[0]).toMatchObject({ currency: 'GBP', value: 9 })
  })

  it('🔴 eBay UK: the batch carries the market\'s GBP (it said EUR), with the pinned price', async () => {
    h.listings = [listing('EBAY', 'UK', { followMasterPrice: false, priceOverride: 24, price: 24 })]
    expect(await run('EBAY', 'UK')).toEqual({ status: 'processed' })
    expect(h.ebay[0].operations).toEqual([{ type: 'price', sku: 'TEST-SKU-1', listingId: 'L1', offerId: 'TEST-OFFER-1', currency: 'GBP', value: '24.00' }])
  })

  it('eBay IT: a "master +10%" follower sends 11.00 EUR', async () => {
    h.listings = [listing('EBAY', 'IT', { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })]
    await run('EBAY', 'IT')
    expect(h.ebay[0].operations[0]).toMatchObject({ currency: 'EUR', value: '11.00' })
  })

  it('Shopify (linked): a "master +10%" follower sends 11.00', async () => {
    h.listings = [listing('SHOPIFY', 'GLOBAL', { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })]
    expect(await run('SHOPIFY', 'GLOBAL')).toEqual({ status: 'processed' })
    expect(h.shopify).toEqual([{ price: 11 }])
  })

  it('a price outside the product\'s own ceiling (master currency) is skipped with the door\'s sentence, nothing sent', async () => {
    h.bounds = { minPrice: null, maxPrice: 10.5 }
    h.listings = [listing('AMAZON', 'IT', { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })]
    expect(await run('AMAZON', 'IT')).toEqual({ status: 'skipped', reason: 'Nothing was sent to Amazon for TEST-SKU-1: 11 is above the pricing ceiling of 10.5 set on this product. Change the price, or change the ceiling.' })
    expect(h.amazon).toEqual([])
  })

  it('a market with no currency configured is skipped by name, nothing sent', async () => {
    h.listings = [listing('EBAY', 'DE', { followMasterPrice: false, priceOverride: 20, price: 20 })]
    expect(await run('EBAY', 'DE')).toEqual({ status: 'skipped', reason: 'TEST-SKU-1: no currency is configured for eBay DE. Set the market\'s currency. Nothing was sent.' })
    expect(h.ebay).toEqual([])
  })
})

/**
 * S3 (per-channel SKU) — the Amazon batch names the seller SKU Amazon holds for the listing (the product SKU for a
 * listing with none of its own, as above), and tells the feed's push-lock read which product it belongs to.
 */
describe('S3 — the Amazon batch names the listing\'s own seller SKU', () => {
  const LIVE = { listingStatus: 'ACTIVE', isPublished: true }
  const stockRun = (marketplace: string) => service.processChannelBatch(product, { channel: 'AMAZON', operation: 'stock', marketplace }, null)
  // The stock op reads the product's FBA stock: none here.
  Object.assign(db, { stockLevel: { aggregate: vi.fn(async () => ({ _sum: { quantity: null } })) } })

  it('parity: no SKU of its own → the product SKU, with the product named for the push lock', async () => {
    h.listings = [listing('AMAZON', 'IT', { ...LIVE, followMasterPrice: false, priceOverride: 15 })]
    await run('AMAZON', 'IT')
    expect(h.amazon[0]).toMatchObject({ operations: [{ type: 'price', sku: 'TEST-SKU-1' }], productIds: ['p1'] })
  })

  it('price and stock under the listing\'s own SKU', async () => {
    h.listings = [listing('AMAZON', 'DE', { ...LIVE, followMasterPrice: false, priceOverride: 15, liveChannelSku: 'TEST-SKU-1-DE' })]
    h.markets.push({ channel: 'AMAZON', code: 'DE', currency: 'EUR' })
    await run('AMAZON', 'DE')
    await stockRun('DE')
    expect(h.amazon.map((s: any) => s.operations[0])).toEqual([
      { type: 'price', sku: 'TEST-SKU-1-DE', currency: 'EUR', value: 15 },
      { type: 'stock', sku: 'TEST-SKU-1-DE', quantity: 3 },
    ])
  })

  it('a still-draft listing keeps the product SKU', async () => {
    h.listings = [listing('AMAZON', 'IT', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'WANT-IT', followMasterPrice: false, priceOverride: 15 })]
    await run('AMAZON', 'IT')
    expect(h.amazon[0].operations[0].sku).toBe('TEST-SKU-1')
  })

  it('two seller SKUs on record → skipped with the reason, nothing sent', async () => {
    h.listings = [listing('AMAZON', 'IT', { ...LIVE, followMasterPrice: false, priceOverride: 15, platformAttributes: { sellerSku: 'A-1' }, flatFileSnapshot: { item_sku: 'A-2' } })]
    expect(await run('AMAZON', 'IT')).toEqual({ status: 'skipped', reason: 'TEST-SKU-1: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.' })
    expect(h.amazon).toEqual([])
  })

  it('FBA: a listing with its own SKU still gets no merchant quantity', async () => {
    h.listings = [listing('AMAZON', 'IT', { ...LIVE, fulfillmentMethod: 'FBA', liveChannelSku: 'TEST-SKU-1-FBA' })]
    expect(await stockRun('IT')).toEqual({ status: 'skipped' })
    expect(h.amazon).toEqual([])
  })

  it('the read asks Amazon listings for their offers (the seller-SKU store); other channels\' reads are unchanged', async () => {
    h.listings = [listing('AMAZON', 'IT', { ...LIVE, followMasterPrice: false, priceOverride: 15 })]
    db.channelListing.findFirst.mockClear()
    await run('AMAZON', 'IT')
    expect((db.channelListing.findFirst.mock.calls[0] as any[])[0]).toMatchObject({ include: { offers: expect.any(Object) } })
    h.listings = [listing('EBAY', 'IT', { followMasterPrice: false, priceOverride: 15 })]
    db.channelListing.findFirst.mockClear()
    await run('EBAY', 'IT')
    expect((db.channelListing.findFirst.mock.calls[0] as any[])[0]).not.toHaveProperty('include')
  })
})

/**
 * S4 (per-channel SKU) — the eBay batch names the SKU eBay holds for THIS listing, and the listing its push controls are
 * read by: the product SKU unless the listing has its own confirmed SKU. An extra listing's alias SKU (never sent to eBay)
 * and a still-draft row's wanted SKU are not named.
 */
describe('S4 — the eBay batch names the SKU eBay holds for the listing', () => {
  const LIVE_EBAY = { listingStatus: 'ACTIVE', isPublished: true }
  const stockRun = (marketplace: string) => service.processChannelBatch(product, { channel: 'EBAY', operation: 'stock', marketplace }, null)

  it('parity: no SKU of its own → the product SKU (price and stock)', async () => {
    h.listings = [listing('EBAY', 'IT', { ...LIVE_EBAY, followMasterPrice: false, priceOverride: 15 })]
    await run('EBAY', 'IT')
    await stockRun('IT')
    expect(h.ebay.map((s: any) => s.operations[0])).toEqual([
      { type: 'price', sku: 'TEST-SKU-1', listingId: 'L1', offerId: 'TEST-OFFER-1', currency: 'EUR', value: '15.00' },
      { type: 'stock', sku: 'TEST-SKU-1', listingId: 'L1', quantity: 3 },
    ])
  })

  it('the listing\'s own confirmed SKU', async () => {
    h.listings = [listing('EBAY', 'IT', { ...LIVE_EBAY, followMasterPrice: false, priceOverride: 15, liveChannelSku: 'TEST-SKU-1-EB', channelSku: 'TEST-SKU-1-EB' })]
    await run('EBAY', 'IT')
    expect(h.ebay[0].operations[0]).toMatchObject({ sku: 'TEST-SKU-1-EB', listingId: 'L1' })
  })

  it('a wanted SKU eBay has not confirmed, and a still-draft row, keep the product SKU', async () => {
    h.listings = [listing('EBAY', 'IT', { ...LIVE_EBAY, followMasterPrice: false, priceOverride: 15, channelSku: 'WANT-IT' })]
    await run('EBAY', 'IT')
    h.listings = [listing('EBAY', 'IT', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'WANT-IT' })]
    await stockRun('IT')
    expect(h.ebay.map((s: any) => s.operations[0].sku)).toEqual(['TEST-SKU-1', 'TEST-SKU-1'])
  })
})

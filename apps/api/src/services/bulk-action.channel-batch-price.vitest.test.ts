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
    expect(h.ebay[0].operations).toEqual([{ type: 'price', sku: 'TEST-SKU-1', offerId: 'TEST-OFFER-1', currency: 'GBP', value: '24.00' }])
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

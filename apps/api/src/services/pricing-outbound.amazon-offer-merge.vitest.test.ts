/**
 * The pricing-engine push (`POST /pricing/push` → `pushPriceUpdate`) changes ONLY our_price in the live Amazon offer
 * (2026-09-30).
 *
 * `amazonSpApiClient.patchListingPrice` replaces `/attributes/purchasable_offer` with an instance that holds only
 * `our_price` — the same defect as the queue's push. Behind the same switch (`NEXUS_AMAZON_OFFER_MERGE=1`, OFF by
 * default), the same reader and the same plan (`amazon/purchasable-offer.ts`) now turn it into ONE merge on the priced
 * instance. OFF is pinned to exactly what `main` sent. The harness is `pricing-outbound.push-lock.vitest.test.ts`'s: a
 * fake database and a fake client; nothing reaches Amazon. SKUs and ASINs are fake; marketplace ids are public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IT, applyToOffer, liveOffer, liveRead, sellerCentralSale } from '../test-support/amazon-offer-model.js'

const s = vi.hoisted(() => ({ listings: [] as any[], price: vi.fn(), offer: vi.fn(), get: vi.fn(), update: vi.fn(), override: vi.fn(), find: vi.fn() }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { patchListingPrice: s.price, patchPurchasableOffer: s.offer, getListingsItem: s.get } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => new Set() }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceKey: (key: any) => key }))
import { pushPriceUpdate } from './pricing-outbound.service.js'

const SKU = 'TEST-SKU-1'
const db = {
  pricingSnapshot: { findFirst: async () => ({ computedPrice: 115, currency: 'EUR', source: 'fixture' }) },
  marketplace: { findUnique: async () => ({ marketplaceId: IT, taxInclusive: true }) },
  channelListing: { findMany: s.find, update: s.update }, channelListingOverride: { create: s.override },
} as any
const args = { sku: SKU, channel: 'AMAZON', marketplace: 'IT' }
/** What `main` sent, and still sends with the switch OFF. */
const mainCall = { sellerId: 'seller', sku: SKU, marketplaceId: IT, productType: 'OUTERWEAR', price: 115, currencyCode: 'EUR', taxInclusive: true }
const merged = () => {
  expect(s.offer).toHaveBeenCalledOnce()
  const call = s.offer.mock.calls[0][0]
  return { call, patch: { op: call.op, value: call.value } }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
  vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1') // the switch ON; the OFF arms unset it
  s.listings = [{ id: 'listing', productId: 'product', syncPaused: false, offerClosedAt: null, platformAttributes: { productType: 'OUTERWEAR' } }]
  s.find.mockImplementation(async () => s.listings)
  s.price.mockResolvedValue({ success: true })
  s.offer.mockResolvedValue({ success: true })
  s.get.mockResolvedValue(liveRead(liveOffer()))
})
afterEach(() => { vi.unstubAllEnvs() })

describe('the switch (NEXUS_AMAZON_OFFER_MERGE)', () => {
  it.each([['unset', undefined], ['0', '0'], ['true', 'true']])('%s → OFF: exactly main\'s patchListingPrice, no live read, no merge', async (_label, value) => {
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', value as string)
    expect((await pushPriceUpdate(db, args)).ok).toBe(true)
    expect(s.price).toHaveBeenCalledExactlyOnceWith(mainCall)
    expect(s.get).not.toHaveBeenCalled()
    expect(s.offer).not.toHaveBeenCalled()
  })
  it.each([['gated', undefined, undefined], ['dry-run', 'true', 'dry-run'], ['sandbox', 'true', 'sandbox']])('ON in %s mode: no live read — patchListingPrice answers without HTTP, as before', async (_mode, flag, mode) => {
    vi.unstubAllEnvs()
    vi.stubEnv('NEXUS_AMAZON_OFFER_MERGE', '1')
    if (flag) vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', flag)
    if (mode) vi.stubEnv('AMAZON_PUBLISH_MODE', mode)
    await pushPriceUpdate(db, args)
    expect(s.get).not.toHaveBeenCalled()
    expect(s.price).toHaveBeenCalledExactlyOnceWith(mainCall)
  })
})

describe('ON: the price is merged into the priced instance and nothing else moves', () => {
  it('Seller Central sale, map_price, min/max, dates, B2B and DE instances all stay; the push reports IN_SYNC', async () => {
    const result = await pushPriceUpdate(db, args)
    expect(result).toMatchObject({ ok: true, pushedPrice: 115 })
    expect(s.get).toHaveBeenCalledExactlyOnceWith({ sellerId: 'seller', sku: SKU, marketplaceId: IT, includedData: ['attributes', 'summaries'] })
    expect(s.price).not.toHaveBeenCalled()
    const { call, patch } = merged()
    expect(call).toEqual({
      sellerId: 'seller', sku: SKU, marketplaceId: IT, productType: 'OUTERWEAR', op: 'merge',
      value: [{ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 115 }] }] }],
    })
    const before = liveOffer()
    const after = applyToOffer(before, patch)
    expect(after[0]).toEqual({ ...before[0], our_price: [{ schedule: [{ value_with_tax: 115 }] }] })
    expect(after[0].discounted_price).toEqual(sellerCentralSale)
    expect(JSON.stringify(after[1])).toBe(JSON.stringify(before[1]))
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(before[2]))
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'IN_SYNC' }) }))
    expect(s.override).toHaveBeenCalledOnce()
  })

  it('never a sale and never a quantity: no discounted_price, no fulfillment_availability, no quantity', async () => {
    await pushPriceUpdate(db, args)
    const body = JSON.stringify(merged().call)
    expect(body).not.toContain('discounted_price')
    expect(body).not.toContain('fulfillment_availability')
    expect(body).not.toMatch(/"quantity"/)
  })

  it('a net-price market (tax-exclusive) merges the same our_price shape patchListingPrice sends', async () => {
    db.marketplace.findUnique = async () => ({ marketplaceId: IT, taxInclusive: false })
    try {
      await pushPriceUpdate(db, args)
      expect(merged().call.value[0].our_price).toEqual([{ schedule: [{ value: 115, currency: 'EUR' }] }])
    } finally { db.marketplace.findUnique = async () => ({ marketplaceId: IT, taxInclusive: true }) }
  })
})

describe('ON: a failed live read sends nothing and fails the push the way this service fails one', () => {
  it.each([
    ['answers success:false', () => s.get.mockResolvedValue({ success: false, sku: SKU, asin: null, status: null, error: 'Amazon listing read failed (500)' }), 'Amazon listing read failed (500)'],
    ['throws', () => s.get.mockRejectedValue(new Error('socket hang up')), 'socket hang up'],
  ])('the read %s', async (_label, arrange, cause) => {
    arrange()
    const result = await pushPriceUpdate(db, args)
    expect(s.price).not.toHaveBeenCalled()
    expect(s.offer).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error).toContain(cause)
    expect(result.error).toMatch(/could not be read.*so the price was not sent.*Push the price again to retry/)
    // Reported like any failed push here: the listing reads FAILED with the reason, nothing reads as synced.
    expect(s.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'listing' }, data: { lastSyncStatus: 'FAILED', syncStatus: 'FAILED', lastSyncError: result.error } })
    expect(s.override).not.toHaveBeenCalled()
  })
})

describe('ON: the other live states', () => {
  it.each([
    ['the listing read answers 404', { success: true, sku: SKU, asin: null, status: null }],
    ['the only instance is another market\'s', liveRead([liveOffer()[2]])],
  ])('no live instance in this market (%s): main\'s patchListingPrice, as before', async (_label, answer) => {
    s.get.mockResolvedValue(answer)
    await pushPriceUpdate(db, args)
    expect(s.price).toHaveBeenCalledExactlyOnceWith(mainCall)
    expect(s.offer).not.toHaveBeenCalled()
  })
  it('an offer it cannot name (only B2B in this market): refused, nothing sent', async () => {
    s.get.mockResolvedValue(liveRead([liveOffer()[1]]))
    const result = await pushPriceUpdate(db, args)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/so the price was not sent/)
    expect(s.price).not.toHaveBeenCalled()
    expect(s.offer).not.toHaveBeenCalled()
  })
  it('a dry-run answer from the merge writes no override and no IN_SYNC (PD.3), as for the replace', async () => {
    s.offer.mockResolvedValue({ success: true, dryRun: true })
    await pushPriceUpdate(db, args)
    expect(s.override).not.toHaveBeenCalled()
    expect(s.update).toHaveBeenCalledWith({ where: { id: 'listing' }, data: { lastSyncStatus: 'DRY_RUN', lastSyncError: null } })
  })
})

/**
 * The pricing-engine merge prices the SAME instance `patchListingPrice` sends (2026-09-30).
 *
 * With NEXUS_AMAZON_OFFER_MERGE on, `pricing-outbound.service.ts` builds its merge from `amazonListingPriceOffer`
 * (`services/amazon/purchasable-offer.ts`) while `patchListingPrice` — the switch-OFF path, left byte-for-byte as it
 * was — builds its own. This pins the two to the same bytes, and pins the body `patchPurchasableOffer` sends for a
 * merge. Network stubbed as in `amazon-sp-api.validate.vitest.test.ts` (getAccessToken + fetchWithRetry); nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmazonSpApiClient } from './amazon-sp-api.client.js'
import { amazonListingPriceOffer } from '../services/amazon/purchasable-offer.js'
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonRegion: async () => 'eu' }))

const IT = 'APJ6JRA9NG5V4'
function stub(client: AmazonSpApiClient) {
  const captured: { url?: string; init?: any } = {}
  ;(client as any).getAccessToken = async () => 'tok-123'
  ;(client as any).fetchWithRetry = async (url: string, init: any) => {
    captured.url = url
    captured.init = init
    return { ok: true, status: 200, json: async () => ({ sku: 'TEST-SKU-1', status: 'ACCEPTED', submissionId: 'sub-1', issues: [] }) }
  }
  return captured
}

beforeEach(() => { vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live') })
afterEach(() => { vi.unstubAllEnvs() })

describe('amazonListingPriceOffer = the instance patchListingPrice sends', () => {
  it.each([true, false])('taxInclusive = %s', async (taxInclusive) => {
    const client = new AmazonSpApiClient()
    const cap = stub(client)
    await client.patchListingPrice({ sellerId: 'S1', sku: 'TEST-SKU-1', marketplaceId: IT, productType: 'OUTERWEAR', price: 115, currencyCode: 'EUR', taxInclusive })
    const body = JSON.parse(cap.init.body)
    expect(body.patches).toHaveLength(1)
    expect(body.patches[0]).toMatchObject({ op: 'replace', path: '/attributes/purchasable_offer' })
    expect(body.patches[0].value).toEqual([amazonListingPriceOffer({ marketplaceId: IT, currencyCode: 'EUR', price: 115, taxInclusive })])
  })
})

describe('patchPurchasableOffer sends a merge as given', () => {
  it('one merge patch on purchasable_offer, scoped to the market, in the productType envelope', async () => {
    const client = new AmazonSpApiClient()
    const cap = stub(client)
    const value = [{ currency: 'EUR', audience: 'ALL', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 115 }] }] }]
    const res = await client.patchPurchasableOffer({ sellerId: 'S1', sku: 'TEST-SKU-1', marketplaceId: IT, productType: 'OUTERWEAR', op: 'merge', value })
    expect(res).toMatchObject({ success: true, submissionId: 'sub-1' })
    expect(cap.init.method).toBe('PATCH')
    expect(new URL(cap.url!).searchParams.get('marketplaceIds')).toBe(IT)
    expect(new URL(cap.url!).searchParams.get('mode')).toBeNull()
    expect(JSON.parse(cap.init.body)).toEqual({ productType: 'OUTERWEAR', patches: [{ op: 'merge', path: '/attributes/purchasable_offer', value }] })
  })
})

/**
 * Amazon sheet gaps (D3) — the FBA restore re-asserts AMAZON_EU with a whole-root replace, so it skips a listing that
 * carries an Amazon-only FBA code (Remote Fulfilment, VCS) in either place: that code would be overwritten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ listings: [] as any[], submit: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  channelListing: { findMany: async () => s.listings },
  stockLevel: { aggregate: async () => ({ _sum: { quantity: 5 } }) },
} }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { submitListingPayload: s.submit } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => new Set() }))
vi.mock('../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }))

import { restoreFbaListings } from './fba-restore.service.js'

const listing = (id: string, platformAttributes: unknown) => ({
  id, productId: `p-${id}`, marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '', platformAttributes,
  product: { id: `p-${id}`, sku: `SKU-${id}`, productType: 'OUTERWEAR' },
})

beforeEach(() => { s.submit.mockReset(); s.submit.mockResolvedValue({ success: true, status: 'ACCEPTED' }) })

describe('restoreFbaListings', () => {
  it('skips Remote Fulfilment / VCS rows (either place) and restores the rest', async () => {
    s.listings = [
      listing('rafn', { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] }),
      listing('vcs', { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_VCS' }] } }),
      listing('flipped', { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3 }] } }),
      listing('fba', { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }),
    ]
    const r = await restoreFbaListings({ dryRun: false })
    expect(r).toMatchObject({ processed: 2, sent: 2, skippedKeptCode: 2 })
    expect(s.submit.mock.calls.map(([a]) => a.sku)).toEqual(['SKU-flipped', 'SKU-fba'])
    for (const [a] of s.submit.mock.calls) expect(a.payload.patches[0].value[0].fulfillment_channel_code).toBe('AMAZON_EU')
  })
})

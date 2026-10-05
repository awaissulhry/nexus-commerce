/**
 * S3 (per-channel SKU) — the FBA restore re-asserts AMAZON_EU under the seller SKU Amazon holds for each listing (the
 * product SKU for a listing with none of its own, as before). A caller that names SKUs restores those SKUs only; a
 * listing under its own SKU is restored only on its own FBA evidence (the product's FBA stock may belong to another
 * SKU); and it never sends a quantity. The database and Amazon are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ listings: [] as any[], findMany: vi.fn(), submit: vi.fn(), fbaStock: 5 }))
vi.mock('../db.js', () => ({ default: {
  channelListing: { findMany: async (args: unknown) => { s.findMany(args); return s.listings } },
  stockLevel: { aggregate: async () => ({ _sum: { quantity: s.fbaStock } }) },
} }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { submitListingPayload: s.submit } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => new Set() }))
vi.mock('../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }))

import { restoreFbaListings } from './fba-restore.service.js'

const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0FBA' }
const listing = (id: string, over: Record<string, unknown> = {}) => ({
  id, productId: `p-${id}`, marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '', fulfillmentMethod: 'FBA', platformAttributes: {},
  flatFileSnapshot: null, channelSku: null, liveChannelSku: null, offers: [], syncPaused: false, offerClosedAt: null, ...LIVE,
  product: { id: `p-${id}`, sku: `SKU-${id}`, productType: 'OUTERWEAR' }, ...over,
})
const sent = () => s.submit.mock.calls.map(([a]) => a.sku)

beforeEach(() => { s.submit.mockReset(); s.submit.mockResolvedValue({ success: true, status: 'ACCEPTED' }); s.findMany.mockReset(); s.fbaStock = 5 })

describe('S3 — the restore names each listing\'s seller SKU', () => {
  it('parity: a listing with no SKU of its own is restored under the product SKU', async () => {
    s.listings = [listing('a')]
    expect(await restoreFbaListings({ dryRun: false })).toMatchObject({ processed: 1, sent: 1 })
    expect(sent()).toEqual(['SKU-a'])
  })

  it('a listing with its own SKU and its own FBA evidence is restored under that SKU, with no quantity', async () => {
    s.listings = [listing('b', { liveChannelSku: 'OWN-B-IT' }), listing('c', { fulfillmentMethod: 'FBM', offers: [{ sku: 'OWN-C-IT', isActive: true, fulfillmentMethod: 'FBA' }] })]
    expect(await restoreFbaListings({ dryRun: false })).toMatchObject({ processed: 2, sent: 2 })
    expect(sent()).toEqual(['OWN-B-IT', 'OWN-C-IT'])
    for (const [a] of s.submit.mock.calls) {
      expect(a.payload.patches).toEqual([{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'AMAZON_EU', marketplace_id: 'APJ6JRA9NG5V4' }] }])
      expect(JSON.stringify(a.payload)).not.toMatch(/quantity/)
    }
  })

  it('a listing under its own SKU with no FBA evidence of its own is never flipped to FBA on the product\'s stock', async () => {
    s.listings = [listing('d', { fulfillmentMethod: 'FBM', liveChannelSku: 'OWN-D-DE', marketplace: 'DE' })]
    expect(await restoreFbaListings({ dryRun: false })).toMatchObject({ processed: 0, sent: 0, skippedNoFba: 1 })
    expect(s.submit).not.toHaveBeenCalled()
  })

  it('parity: a listing under the product SKU keeps today\'s rule (the product\'s FBA stock is enough)', async () => {
    s.listings = [listing('e', { fulfillmentMethod: 'FBM' })]
    expect(await restoreFbaListings({ dryRun: false })).toMatchObject({ processed: 1, sent: 1 })
    expect(sent()).toEqual(['SKU-e'])
  })

  it('named SKUs: the read finds a listing by its product SKU or its own SKU; only the named seller SKUs are restored', async () => {
    s.listings = [listing('f'), listing('g', { liveChannelSku: 'OWN-G-IT' }), listing('h', { liveChannelSku: 'OWN-H-IT' })]
    await restoreFbaListings({ skus: ['SKU-f', 'SKU-g', 'OWN-H-IT'], dryRun: false })
    expect(s.findMany.mock.calls[0][0].where).toMatchObject({ channel: 'AMAZON', OR: [
      { product: { sku: { in: ['SKU-f', 'SKU-g', 'OWN-H-IT'] } } }, { liveChannelSku: { in: ['SKU-f', 'SKU-g', 'OWN-H-IT'] } }, { channelSku: { in: ['SKU-f', 'SKU-g', 'OWN-H-IT'] } },
    ] })
    // g was found by its product SKU, but Amazon holds OWN-G-IT for it: not the SKU named.
    expect(sent()).toEqual(['SKU-f', 'OWN-H-IT'])
  })

  it('two seller SKUs on record: reported, nothing sent', async () => {
    s.listings = [listing('i', { platformAttributes: { sellerSku: 'I-1' }, flatFileSnapshot: { item_sku: 'I-2' } })]
    const r = await restoreFbaListings({ dryRun: false })
    expect(s.submit).not.toHaveBeenCalled()
    expect(r.results).toEqual([expect.objectContaining({ sku: 'SKU-i', ok: false, error: 'CONFLICTING_SKUS: SKU-i: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.' })])
  })
})

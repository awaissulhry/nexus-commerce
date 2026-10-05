/**
 * S3 (per-channel SKU) — SCT.6's per-market offer close / reopen (the sheet's Pause / Resume offer, Claude's close-listing)
 * names the seller SKU Amazon holds for THIS listing: the product SKU for a listing with none of its own (as before),
 * its own SKU otherwise. The reopen's EU shared-quantity check reads only the rows under that seller SKU. The harness is
 * the presence test's: the database and Amazon are stand-ins; nothing reaches Amazon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({
  findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), queue: vi.fn(), patch: vi.fn(), get: vi.fn(), grants: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: { channelListing: { findFirst: s.findFirst, findMany: s.findMany, update: s.update }, channelAccountGrant: { findMany: s.grants }, outboundSyncQueue: { updateMany: s.queue, create: s.queue } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { patchPurchasableOffer: s.patch, getListingsItem: s.get } }))
vi.mock('./amazon/flat-file.service.js', () => ({ MARKETPLACE_ID_MAP: { IT: 'it', DE: 'de' } }))
import { closeMarketOffers, reopenMarketOffers } from './amazon-market-offer.service.js'

const c = { productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' }
const offer = [{ marketplace_id: 'it', currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }] }]
const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0TEST' }
const row = (over: Record<string, unknown> = {}) => ({
  ...c, id: 'listing', fulfillmentMethod: 'FBM', product: { sku: 'SKU', fulfillmentMethod: 'FBM', productType: 'AUTO_ACCESSORY' }, price: 10,
  offerClosedAt: null, offerCloseSnapshot: { purchasableOffer: offer, productType: 'AUTO_ACCESSORY' }, followMasterQuantity: true, quantityOverride: null,
  quantity: 5, syncPaused: false, platformAttributes: {}, flatFileSnapshot: null, channelSku: null, liveChannelSku: null, offers: [], ...LIVE, ...over,
})
const closed = (over: Record<string, unknown> = {}) => row({ offerClosedAt: new Date(), ...over })
const patchedSkus = () => s.patch.mock.calls.map(([call]) => call.sku)

beforeEach(() => {
  vi.clearAllMocks(); s.findFirst.mockResolvedValue(row()); s.findMany.mockResolvedValue([row()]); s.grants.mockResolvedValue([])
  s.get.mockResolvedValue({ rawResponse: { attributes: { purchasable_offer: offer } } })
  s.patch.mockResolvedValue({ success: true, dryRun: false })
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NO CHANNEL') }))
})

describe('close (Pause offer)', () => {
  it('parity: a listing with no SKU of its own is closed under the product SKU', async () => {
    const r = await closeMarketOffers({ targets: [c], actor: 'user' })
    expect(r.results[0]).toMatchObject({ action: 'CLOSED', sku: 'SKU' })
    expect(patchedSkus()).toEqual(['SKU'])
    expect(s.get).toHaveBeenCalledWith(expect.objectContaining({ sku: 'SKU' }))
  })

  it('a listing with its own seller SKU: the live read and the close name that SKU', async () => {
    s.findFirst.mockResolvedValue(row({ liveChannelSku: 'OWN-IT', channelSku: 'OWN-IT' }))
    const r = await closeMarketOffers({ targets: [c], actor: 'user' })
    expect(r.results[0]).toMatchObject({ action: 'CLOSED', sku: 'OWN-IT' })
    expect(patchedSkus()).toEqual(['OWN-IT'])
    expect(s.get).toHaveBeenCalledWith(expect.objectContaining({ sku: 'OWN-IT' }))
  })

  it('a still-draft listing keeps the product SKU (nothing new is sent for a draft)', async () => {
    s.findFirst.mockResolvedValue(row({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'WANT-IT' }))
    await closeMarketOffers({ targets: [c], actor: 'user' })
    expect(patchedSkus()).toEqual(['SKU'])
  })

  it('two seller SKUs on record: FAILED with the reason, nothing sent, nothing written', async () => {
    s.findFirst.mockResolvedValue(row({ platformAttributes: { sellerSku: 'A-1' }, flatFileSnapshot: { item_sku: 'A-2' } }))
    const r = await closeMarketOffers({ targets: [c], actor: 'user' })
    expect(r).toMatchObject({ failed: 1, updated: 0, results: [{ action: 'FAILED', detail: 'SKU: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.' }] })
    expect(s.patch).not.toHaveBeenCalled(); expect(s.get).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
  })

  it('the skips still come first: an already closed listing reads SKIPPED_ALREADY even with two SKUs on record', async () => {
    s.findFirst.mockResolvedValue(closed({ platformAttributes: { sellerSku: 'A-1' }, flatFileSnapshot: { item_sku: 'A-2' } }))
    expect((await closeMarketOffers({ targets: [c], actor: 'user' })).results[0]).toMatchObject({ action: 'SKIPPED_ALREADY' })
  })
})

describe('reopen (Resume offer)', () => {
  it('parity: replayed under the product SKU', async () => {
    s.findFirst.mockResolvedValue(closed())
    expect((await reopenMarketOffers({ targets: [c], actor: 'user' })).updated).toBe(1)
    expect(patchedSkus()).toEqual(['SKU'])
  })

  it('a listing with its own seller SKU is replayed under that SKU', async () => {
    s.findFirst.mockResolvedValue(closed({ liveChannelSku: 'OWN-IT' }))
    s.findMany.mockResolvedValue([closed({ liveChannelSku: 'OWN-IT' })])
    expect((await reopenMarketOffers({ targets: [c], actor: 'user' })).results[0]).toMatchObject({ action: 'REOPENED', sku: 'OWN-IT' })
    expect(patchedSkus()).toEqual(['OWN-IT'])
  })

  it('EU check per seller SKU: DE pinned at 0 under the PRODUCT SKU does not stop IT reopening under its own SKU', async () => {
    s.findFirst.mockResolvedValue(closed({ liveChannelSku: 'OWN-IT' }))
    s.findMany.mockResolvedValue([closed({ liveChannelSku: 'OWN-IT' }), row({ id: 'de', marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0 })])
    expect((await reopenMarketOffers({ targets: [c], actor: 'user' })).updated).toBe(1)
  })

  it('EU check per seller SKU: DE pinned at 0 under the SAME own SKU is refused before anything is sent', async () => {
    s.findFirst.mockResolvedValue(closed({ liveChannelSku: 'OWN-IT' }))
    s.findMany.mockResolvedValue([closed({ liveChannelSku: 'OWN-IT' }), row({ id: 'de', marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0, liveChannelSku: 'OWN-IT' })])
    await expect(reopenMarketOffers({ targets: [c], actor: 'user' })).rejects.toThrow('AMAZON_EU_QUANTITY_CONFLICT')
    expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled(); expect(s.queue).not.toHaveBeenCalled()
  })

  it('control (as before): with no own SKUs anywhere, DE pinned at 0 fights IT', async () => {
    s.findFirst.mockResolvedValue(closed())
    s.findMany.mockResolvedValue([closed(), row({ id: 'de', marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0 })])
    await expect(reopenMarketOffers({ targets: [c], actor: 'user' })).rejects.toThrow('AMAZON_EU_QUANTITY_CONFLICT')
  })

  it('the sibling read takes the seller-SKU facts (offers and product SKU)', async () => {
    s.findFirst.mockResolvedValue(closed())
    await reopenMarketOffers({ targets: [c], actor: 'user' })
    expect(s.findMany.mock.calls[0][0]).toMatchObject({
      where: { productId: 'p', channel: 'AMAZON', channelConnectionId: 'account', aliasKey: '' },
      include: { product: { select: { fulfillmentMethod: true, sku: true } }, offers: expect.any(Object) },
    })
  })
})

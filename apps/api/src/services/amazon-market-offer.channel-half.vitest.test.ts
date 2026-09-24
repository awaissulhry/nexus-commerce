/**
 * PLAN Step 1.3 (R-39) — SCT.6's CHANNEL half is one function (`closeAmazonOfferOnChannel`) with two
 * callers: `closeMarketOffers` (SCT.6, which then records the closure on its row) and the hard-delete
 * unpublish (which runs after the row is gone). These arms pin what the extraction must not change
 * for SCT.6 — the selector, the live snapshot, the DB-price fallback — and what the no-fallback mode
 * must never send.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), queue: vi.fn(), patch: vi.fn(), get: vi.fn(), grants: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: { channelListing: { findFirst: s.findFirst, findMany: s.findMany, update: s.update }, channelAccountGrant: { findMany: s.grants }, outboundSyncQueue: { updateMany: s.queue, create: s.queue } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { patchPurchasableOffer: s.patch, getListingsItem: s.get } }))
vi.mock('./amazon/flat-file.service.js', () => ({ MARKETPLACE_ID_MAP: { IT: 'it', DE: 'de' } }))
import { closeAmazonOfferOnChannel, closeMarketOffers } from './amazon-market-offer.service.js'

const c = { productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' }
// Two instances in this market (a B2C and a B2B audience) — the selector must name each one.
const offer = [
  { marketplace_id: 'it', currency: 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 10 }] }], discounted_price: [{ schedule: [{ value_with_tax: 8 }] }] },
  { marketplace_id: 'it', currency: 'EUR', audience: 'B2B', our_price: [{ schedule: [{ value_with_tax: 9 }] }] },
]
const row = () => ({ ...c, id: 'listing', fulfillmentMethod: 'FBM', product: { sku: 'SKU', fulfillmentMethod: 'FBM', productType: 'AUTO_ACCESSORY' }, price: 12.5, offerClosedAt: null, offerCloseSnapshot: null, followMasterQuantity: true, quantityOverride: null, quantity: 5, syncPaused: false })
const read = (over: Record<string, unknown> = {}) => ({ success: true, rawResponse: { summaries: [{ productType: 'COAT' }], attributes: { purchasable_offer: offer, fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }] } }, ...over })

beforeEach(() => {
  vi.clearAllMocks(); s.findFirst.mockResolvedValue(row()); s.findMany.mockResolvedValue([row()]); s.grants.mockResolvedValue([])
  s.get.mockResolvedValue(read())
  s.patch.mockResolvedValue({ success: true, dryRun: false })
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NO CHANNEL') }))
})

describe('SCT.6 through the shared channel half — behaviour unchanged', () => {
  it('closes by the SCT.6 selector ({marketplace_id, currency, audience} per instance) with the LIVE product type', async () => {
    expect((await closeMarketOffers({ targets: [c], actor: 'user' })).updated).toBe(1)
    expect(s.patch).toHaveBeenCalledExactlyOnceWith({
      sellerId: 'seller', sku: 'SKU', marketplaceId: 'it', productType: 'COAT', op: 'delete',
      value: [{ marketplace_id: 'it', currency: 'EUR', audience: 'ALL' }, { marketplace_id: 'it', currency: 'EUR', audience: 'B2B' }],
    })
  })
  it('snapshots the VERBATIM live offer (sale price included) for the reopen', async () => {
    await closeMarketOffers({ targets: [c], actor: 'user' })
    expect(s.update.mock.calls[0][0].data.offerCloseSnapshot).toMatchObject({ purchasableOffer: offer, productType: 'COAT', snapshotSource: 'live' })
  })
  it.each(['throws', 'no offer'] as const)('a live read that %s still closes on the DB price (SCT.6\'s fallback), snapshotSource db', async (how) => {
    if (how === 'throws') s.get.mockRejectedValue(new Error('read failed'))
    else s.get.mockResolvedValue(read({ rawResponse: { summaries: [], attributes: {} } }))
    expect((await closeMarketOffers({ targets: [c], actor: 'user' })).updated).toBe(1)
    expect(s.patch.mock.calls[0][0]).toMatchObject({ op: 'delete', productType: 'AUTO_ACCESSORY', value: [{ marketplace_id: 'it', currency: 'EUR' }] })
    expect(s.update.mock.calls[0][0].data.offerCloseSnapshot).toMatchObject({ snapshotSource: 'db', purchasableOffer: [{ our_price: [{ schedule: [{ value_with_tax: 12.5 }] }] }] })
  })
  it('no product type anywhere → FAILED, nothing sent, nothing written', async () => {
    s.findFirst.mockResolvedValue({ ...row(), product: { sku: 'SKU', fulfillmentMethod: 'FBM', productType: null } })
    s.get.mockResolvedValue(read({ rawResponse: { summaries: [], attributes: { purchasable_offer: offer } } }))
    const r = await closeMarketOffers({ targets: [c], actor: 'user' })
    expect(r.failed).toBe(1); expect(r.results[0].detail).toContain('no productType')
    expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
  })
})

describe('the no-fallback mode (the hard-delete unpublish) never sends blind', () => {
  const base = { sellerId: 'seller', sku: 'SKU', marketplaceId: 'it', productType: '' }
  it('sends the same selector and returns the verbatim snapshot', async () => {
    const attempt = await closeAmazonOfferOnChannel(base)
    expect(attempt).toMatchObject({ sent: true, snapshot: offer, snapshotSource: 'live', productType: 'COAT', live: { read: 'ok', fulfillmentChannels: ['DEFAULT'] } })
    expect(s.patch.mock.calls[0][0].value).toEqual([{ marketplace_id: 'it', currency: 'EUR', audience: 'ALL' }, { marketplace_id: 'it', currency: 'EUR', audience: 'B2B' }])
  })
  it.each([
    ['a thrown read', () => s.get.mockRejectedValue(new Error('read failed')), 'LIVE_READ_FAILED'],
    ['a success:false read', () => s.get.mockResolvedValue({ success: false, error: 'Amazon listing read failed (500)' }), 'LIVE_READ_FAILED'],
    ['no offer in the market', () => s.get.mockResolvedValue(read({ rawResponse: { summaries: [{ productType: 'COAT' }], attributes: {} } })), 'NO_LIVE_OFFER'],
    ['no product type', () => s.get.mockResolvedValue(read({ rawResponse: { summaries: [], attributes: { purchasable_offer: offer } } })), 'NO_PRODUCT_TYPE'],
  ] as const)('%s → nothing sent (%s)', async (_label, arrange, reason) => {
    arrange()
    expect(await closeAmazonOfferOnChannel(base)).toMatchObject({ sent: false, notSent: reason })
    expect(s.patch).not.toHaveBeenCalled()
  })
  it('the caller\'s refusal sees the live fulfilment channels and stops the send', async () => {
    s.get.mockResolvedValue(read({ rawResponse: { summaries: [{ productType: 'COAT' }], attributes: { purchasable_offer: offer, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }, { fulfillment_channel_code: 'DEFAULT' }] } } }))
    const refuse = vi.fn((live: { fulfillmentChannels: string[] }) => live.fulfillmentChannels.includes('AMAZON_EU') ? 'FBA stock' : null)
    expect(await closeAmazonOfferOnChannel({ ...base, refuse })).toMatchObject({ sent: false, notSent: 'REFUSED', detail: 'FBA stock' })
    expect(refuse).toHaveBeenCalledWith(expect.objectContaining({ fulfillmentChannels: ['AMAZON_EU', 'DEFAULT'] }))
    expect(s.patch).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({
  findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), queue: vi.fn(), patch: vi.fn(), get: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: { channelListing: { findFirst: s.findFirst, findMany: s.findMany, update: s.update }, outboundSyncQueue: { updateMany: s.queue, create: s.queue } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { patchPurchasableOffer: s.patch, getListingsItem: s.get } }))
vi.mock('./amazon/flat-file.service.js', () => ({ MARKETPLACE_ID_MAP: { IT: 'it', DE: 'de' } }))
import { closeMarketOffers, reopenMarketOffers, isFbaCoordinate } from './amazon-market-offer.service.js'
const c = { productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' }
const offer = [{ marketplace_id: 'it', currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }] }]
const row = () => ({ ...c, id: 'listing', fulfillmentMethod: 'FBM', product: { sku: 'SKU', fulfillmentMethod: 'FBM', productType: 'AUTO_ACCESSORY' }, price: 10, offerClosedAt: null, offerCloseSnapshot: { purchasableOffer: offer, productType: 'AUTO_ACCESSORY' }, followMasterQuantity: true, quantityOverride: null, quantity: 5, syncPaused: false })
beforeEach(() => {
  vi.clearAllMocks(); s.findFirst.mockResolvedValue(row()); s.findMany.mockResolvedValue([row()])
  s.get.mockResolvedValue({ rawResponse: { attributes: { purchasable_offer: offer } } })
  s.patch.mockResolvedValue({ success: true, dryRun: false })
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NO CHANNEL') }))
})
describe('acknowledged offer lifecycle and ONE fail-closed FBA predicate', () => {
  for (const reopen of [false, true]) it(`${reopen ? 'reopen' : 'close'} dry-run makes zero DB writes or queue changes`, async () => {
    if (reopen) s.findFirst.mockResolvedValue({ ...row(), offerClosedAt: new Date() })
    s.patch.mockResolvedValue({ success: true, dryRun: true })
    const r = await (reopen ? reopenMarketOffers : closeMarketOffers)({ targets: [c], actor: 'user' })
    expect(r.updated).toBe(0); expect(r.results[0].action).toBe('DRY_RUN')
    expect(s.update).not.toHaveBeenCalled(); expect(s.queue).not.toHaveBeenCalled()
  })
  it('ack close writes closure and skip_offer source with the exact pre-read predicate', async () => {
    expect((await closeMarketOffers({ targets: [c], actor: 'user' })).updated).toBe(1)
    expect(s.findFirst.mock.calls[0][0].where).toEqual(c)
    expect(s.update.mock.calls[0][0]).toMatchObject({ where: { ...c, id: 'listing' }, data: { offerClosedAt: expect.any(Date), offerClosedBy: 'user', offerActive: false } })
  })
  it('reopen checks EU FOLLOW conflict before patch, write and immediate quantity enqueue', async () => {
    s.findFirst.mockResolvedValue({ ...row(), offerClosedAt: new Date() })
    s.findMany.mockResolvedValue([row(), { ...row(), id: 'de', marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0 }])
    await expect(reopenMarketOffers({ targets: [c], actor: 'user' })).rejects.toThrow('AMAZON_EU_QUANTITY_CONFLICT')
    expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled(); expect(s.queue).not.toHaveBeenCalled()
  })
  it('aligned ack reopen restores offerActive and FOLLOW then queues quantity once', async () => {
    s.findFirst.mockResolvedValue({ ...row(), offerClosedAt: new Date() })
    expect((await reopenMarketOffers({ targets: [c], actor: 'user' })).updated).toBe(1)
    expect(s.update.mock.calls[0][0].data).toMatchObject({ offerClosedAt: null, offerActive: true, followMasterQuantity: true, quantityOverride: null })
    expect(s.queue).toHaveBeenCalledTimes(1)
    expect(s.queue.mock.calls[0][0].data.syncType).toBe('QUANTITY_UPDATE')
  })
  for (const signal of ['listing', 'product', 'attributes'] as const) {
    for (const reopen of [false, true]) it(`${signal} FBA refuses ${reopen ? 'reopen' : 'close'} before transport`, async () => {
      const r: any = row()
      if (signal === 'listing') r.fulfillmentMethod = 'FBA'
      if (signal === 'product') r.product.fulfillmentMethod = 'FBA'
      if (signal === 'attributes') r.platformAttributes = { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] }
      s.findFirst.mockResolvedValue(r)
      expect((await (reopen ? reopenMarketOffers : closeMarketOffers)({ targets: [c], actor: 'user' })).skippedFba).toBe(1)
      expect(s.patch).not.toHaveBeenCalled(); expect(s.update).not.toHaveBeenCalled()
    })
  }
  it('canonical push predicate retains stock/offer evidence and FBM positive control', () => {
    expect(isFbaCoordinate(row())).toBe(false)
    expect(isFbaCoordinate(row(), row().product, { fbaStockQty: 1 })).toBe(true)
    expect(isFbaCoordinate(row(), row().product, { hasActiveFbaOffer: true })).toBe(true)
  })
})

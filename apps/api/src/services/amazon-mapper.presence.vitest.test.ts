import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../db.js', () => ({ default: { product: { findUnique: s.load } } }))
vi.mock('./pim/stored-variation-projection.js', () => ({ loadStoredVariationProjection: async () => ({ cell: { theme: { code: 'Size' }, axes: [] } }) }))
import { AmazonMapperService, requireAmazonFulfillment } from './amazon-mapper.service.js'
beforeEach(() => vi.clearAllMocks())
it.each([null, undefined, '', ' '])('D24 refuses unset fulfilment %s with a named reason', value => {
  expect(() => requireAmazonFulfillment(value)).toThrow('AMAZON_FULFILLMENT_UNSET')
})
it('actual variation builder refuses a cleared product default', async () => {
  s.load.mockResolvedValue({ id: 'p', sku: 'P', isParent: true, fulfillmentChannel: null, channelListings: [{ marketplace: 'IT' }], masterVariations: [] })
  await expect(new AmazonMapperService().buildVariationPayload('cl', 'p')).rejects.toThrow('AMAZON_FULFILLMENT_UNSET')
})
it('actual builder preserves explicit FBM default and explicit child FBA', async () => {
  s.load.mockResolvedValue({ id: 'p', sku: 'P', isParent: true, fulfillmentChannel: 'FBM', basePrice: 10, channelListings: [{ marketplace: 'IT' }], masterVariations: [
    { sku: 'C1', fulfillmentChannel: null, basePrice: 10, categoryAttributes: {}, channelListings: [] },
    { sku: 'C2', fulfillmentChannel: 'FBA', basePrice: 10, categoryAttributes: {}, channelListings: [] },
  ] })
  const payload = await new AmazonMapperService().buildVariationPayload('cl', 'p')
  expect(payload.items.map(r => r.fulfillmentChannel)).toEqual(['FBM', 'FBM', 'FBA'])
})

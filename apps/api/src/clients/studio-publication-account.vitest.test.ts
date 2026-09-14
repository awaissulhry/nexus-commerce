import { expect, it, vi } from 'vitest'
const region = vi.hoisted(() => vi.fn(async () => 'na'))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonRegion: region }))
import { AmazonSpApiClient } from './amazon-sp-api.client.js'
it('validates in the bound account region, retaining the exact seller SKU and parent requirements', async () => {
  const client = new AmazonSpApiClient({ id: 'north-america-account', region: 'na' })
  vi.spyOn(client, 'getAccessToken').mockResolvedValue('mock-token')
  const transport = vi.spyOn(client as any, 'fetchWithRetry').mockResolvedValue(new Response(JSON.stringify({ sku: 'SKU / 1', status: 'VALID' }), { status: 200 }))
  expect(await client.validateListing({ sellerId: 'SELLER', sku: 'SKU / 1', marketplaceId: 'USA', productType: 'COAT', requirements: 'LISTING_PRODUCT_ONLY', attributes: {} })).toMatchObject({ ok: true })
  expect(region).toHaveBeenCalledWith('north-america-account')
  expect(transport.mock.calls[0][0]).toContain('sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SELLER/SKU%20%2F%201')
  expect(JSON.parse((transport.mock.calls[0][1] as any).body).requirements).toBe('LISTING_PRODUCT_ONLY')
})

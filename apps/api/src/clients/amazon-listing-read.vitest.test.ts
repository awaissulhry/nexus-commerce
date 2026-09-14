import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonAccessToken: vi.fn().mockResolvedValue('test-token'), getAmazonRegion: vi.fn().mockResolvedValue('eu') }))
import { getAmazonRegion } from '../lib/amazon-sp-client.js'
import { AmazonSpApiClient } from './amazon-sp-api.client.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('requests all listing sections together and uses the selected account region', async () => {
  const issues = [{ code: '100230', severity: 'ERROR', message: 'Safety image suppressed' }]
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sku: 'GALE/XXS', summaries: [{ asin: 'B0H7W8PH1F' }], attributes: { brand: [{ value: 'Xavia' }] }, issues })))
  vi.stubGlobal('fetch', fetch)
  const result = await new AmazonSpApiClient({ id: 'seller-it', region: 'eu' }).getListingsItem({ sellerId: 'seller', sku: 'GALE/XXS', marketplaceId: 'IT', includedData: ['summaries', 'attributes', 'issues'] })
  const url = new URL(fetch.mock.calls[0][0])
  expect(url.searchParams.getAll('includedData')).toEqual(['summaries,attributes,issues'])
  expect(url.pathname).toContain('GALE%2FXXS')
  expect(getAmazonRegion).toHaveBeenCalledWith('seller-it')
  expect(result.rawResponse).toMatchObject({ attributes: { brand: [{ value: 'Xavia' }] } })
  expect(result).toMatchObject({ success: true, asin: 'B0H7W8PH1F', issues })
})

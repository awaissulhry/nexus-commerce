import { afterEach, describe, expect, it, vi } from 'vitest'
import { AmazonSpApiClient } from './amazon-sp-api.client.js'
// P0.1 positive controls: a fixed region, so the live PATCH path reaches its mocked transport.
vi.mock('../lib/amazon-sp-client.js', async original => ({ ...await original<object>(), getAmazonRegion: async () => 'eu' }))

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
describe('permanent delete honours the same Amazon master gate as every write', () => {
  it.each(['', '0', 'false'])('master flag %j and live mode make no request', async flag => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', flag)
    vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
    const client = new AmazonSpApiClient()
    const request = vi.spyOn(client, 'request').mockResolvedValue({ status: 'ACCEPTED', submissionId: 'stub' })
    const result = await client.deleteListingsItem({ sellerId: 'fixture-seller', sku: 'fixture-sku', marketplaceId: 'fixture-market' })
    expect(result).toMatchObject({ success: true, dryRun: true })
    expect(request).not.toHaveBeenCalled()
  })
  it('positive control: enabled + live reaches the mocked DELETE transport', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1')
    vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
    const client = new AmazonSpApiClient()
    const request = vi.spyOn(client, 'request').mockResolvedValue({ status: 'ACCEPTED', submissionId: 'stub' })
    expect(await client.deleteListingsItem({ sellerId: 'fixture-seller', sku: 'fixture-sku', marketplaceId: 'fixture-market' })).toMatchObject({ success: true, submissionId: 'stub' })
    expect(request).toHaveBeenCalledExactlyOnceWith('DELETE', '/listings/2021-08-01/items/fixture-seller/fixture-sku', {
      query: { marketplaceIds: 'fixture-market' }, label: 'deleteListingsItem(fixture-sku)',
    })
  })
  it.each(['dry-run', '', 'typo'])('enabled + %j remains a dry run', async mode => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1'); vi.stubEnv('AMAZON_PUBLISH_MODE', mode)
    const client = new AmazonSpApiClient()
    const request = vi.spyOn(client, 'request').mockResolvedValue({ status: 'ACCEPTED' })
    expect((await client.deleteListingsItem({ sellerId: 's', sku: 'x', marketplaceId: 'm' })).dryRun).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
})

// P0.1 — these three writers have no sandbox host, so `sandbox` used to send
// to PRODUCTION. Sandbox now behaves as a dry run: no token, no HTTP.
describe('P0.1 — sandbox mode sends nothing on the three production-only writers', () => {
  const writers = [
    ['patchListingPrice', (c: AmazonSpApiClient) => c.patchListingPrice({ sellerId: 's', sku: 'x', marketplaceId: 'm', productType: 'COAT', price: 10, currencyCode: 'EUR', taxInclusive: true })],
    ['patchPurchasableOffer', (c: AmazonSpApiClient) => c.patchPurchasableOffer({ sellerId: 's', sku: 'x', marketplaceId: 'm', productType: 'COAT', op: 'delete', value: [{ marketplace_id: 'm', currency: 'EUR' }] })],
    ['deleteListingsItem', (c: AmazonSpApiClient) => c.deleteListingsItem({ sellerId: 's', sku: 'x', marketplaceId: 'm' })],
  ] as const
  function spies(client: AmazonSpApiClient) {
    return {
      token: vi.spyOn(client, 'getAccessToken').mockResolvedValue('token'),
      transport: vi.spyOn(client as any, 'fetchWithRetry').mockResolvedValue(new Response(JSON.stringify({ status: 'ACCEPTED', submissionId: 'stub' }))),
      request: vi.spyOn(client, 'request').mockResolvedValue({ status: 'ACCEPTED', submissionId: 'stub' }),
    }
  }
  it.each(writers)('%s in sandbox mode is a dry run with no token and no HTTP', async (_name, run) => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'sandbox')
    const client = new AmazonSpApiClient(); const s = spies(client)
    expect(await run(client)).toMatchObject({ success: true, dryRun: true })
    expect(s.token).not.toHaveBeenCalled(); expect(s.transport).not.toHaveBeenCalled(); expect(s.request).not.toHaveBeenCalled()
  })
  it.each(writers)('positive control: %s in live mode reaches the mocked transport', async (_name, run) => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
    const client = new AmazonSpApiClient(); const s = spies(client)
    const result = await run(client)
    expect(result.dryRun).toBeFalsy()
    expect(s.transport.mock.calls.length + s.request.mock.calls.length).toBe(1)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AmazonSpApiClient } from './amazon-sp-api.client.js'

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

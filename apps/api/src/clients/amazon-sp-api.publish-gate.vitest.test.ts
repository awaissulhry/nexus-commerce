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

// P0.1 — these writers have no sandbox host, so `sandbox` used to send
// to PRODUCTION. Sandbox now behaves as a dry run: no token, no HTTP.
describe('P0.1 — sandbox mode sends nothing on the production-only writers', () => {
  const writers = [
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

// Amazon Business step 4 review (2026-10-12): the offer writer read only `issues`, so a 4xx/5xx answer (`errors[]`)
// counted as a success. Now an HTTP failure is a failure, and only this item's own data is item-level.
describe('patchPurchasableOffer — an HTTP failure is a failure', () => {
  const answer = (status: number, body: unknown) => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', '1'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live')
    const client = new AmazonSpApiClient()
    vi.spyOn(client, 'getAccessToken').mockResolvedValue('token')
    vi.spyOn(client as any, 'fetchWithRetry').mockResolvedValue(new Response(JSON.stringify(body), { status }))
    return client.patchPurchasableOffer({ sellerId: 's', sku: 'x', marketplaceId: 'm', productType: 'COAT', op: 'merge', value: [{ marketplace_id: 'm', currency: 'EUR', audience: 'B2B' }] })
  }
  it('429 with errors[] → not a success, not item-level (it may pass later)', async () => {
    const r = await answer(429, { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] })
    expect(r).toMatchObject({ success: false, httpStatus: 429 })
    expect(r.itemLevel).toBeUndefined()
    expect(r.error).toContain('QuotaExceeded')
  })
  it('404 → this SKU only (item-level)', async () => {
    expect(await answer(404, { errors: [{ code: 'NOT_FOUND', message: 'no such SKU' }] })).toMatchObject({ success: false, itemLevel: true })
  })
  it('200 with an ERROR issue → Amazon refused this item\'s data (item-level)', async () => {
    expect(await answer(200, { status: 'INVALID', issues: [{ code: '90244', severity: 'ERROR', message: 'invalid value' }] })).toMatchObject({ success: false, itemLevel: true })
  })
  it('200 ACCEPTED → success', async () => {
    expect(await answer(200, { status: 'ACCEPTED', submissionId: 'sub-1' })).toMatchObject({ success: true, status: 'ACCEPTED', httpStatus: 200 })
  })
})

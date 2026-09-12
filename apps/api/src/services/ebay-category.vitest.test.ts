import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ token: vi.fn(), connection: vi.fn(), fetch: vi.fn() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: mocks.connection }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: mocks.token } }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordApiCall: (_meta: unknown, run: () => Promise<unknown>) => run() }))
import { EbayCategoryService } from './ebay-category.service.js'

const tree = (name: string) => ({ rootCategoryNode: { category: { categoryId: 'root', categoryName: 'Root' }, childCategoryTreeNodes: [
  { category: { categoryId: '10', categoryName: name }, childCategoryTreeNodes: [{ category: { categoryId: '177104', categoryName: 'Jackets' } }] },
] } })

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_API_BASE', 'EBAY_AUTH_URL']) vi.stubEnv(key, '')
  vi.stubEnv('EBAY_API_BASE', 'https://api.ebay.test')
  vi.stubEnv('EBAY_AUTH_URL', 'https://api.ebay.test/identity/v1/oauth2/token')
  mocks.connection.mockResolvedValue({ id: 'account', authStatus: 'connected' })
  mocks.token.mockRejectedValue(new Error('Credential blob failed authentication'))
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/oauth2/token')
    ? { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 7200 }) }
    : { ok: true, json: async () => tree(url.endsWith('/101') ? 'Italy' : 'UK') })
  vi.stubGlobal('fetch', mocks.fetch)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('category name lookup', () => {
  it('uses the GB metadata market for UK condition names and shares its cached result', async () => {
    mocks.token.mockResolvedValue('seller-token')
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ itemConditionPolicies: [{ categoryId: '177104', itemConditions: [{ conditionId: '1000', conditionDescription: 'New' }] }] }) })
    const service = new EbayCategoryService()
    expect(await service.getItemConditionPolicies('177104', 'UK', { throwOnError: true })).toEqual([{ conditionId: '1000', conditionDescription: 'New' }])
    await service.getItemConditionPolicies('177104', 'GB')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch.mock.calls[0][0]).toContain('/marketplace/EBAY_GB/get_item_condition_policies')
  })
  it.each([
    ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'],
    ['EBAY_APP_ID', 'EBAY_CERT_ID'],
  ])('resolves names with %s when the saved seller token cannot decrypt', async (idKey, secretKey) => {
    vi.stubEnv(idKey, 'configured-app'); vi.stubEnv(secretKey, 'configured-secret')
    const service = new EbayCategoryService()
    expect(await service.getCategoryBreadcrumbs(['177104', '177104', 'missing'], 'IT')).toEqual({
      '177104': { local: 'Italy › Jackets' },
    })
    const requests = mocks.fetch.mock.calls.length
    await service.getCategoryBreadcrumbs(['177104'], 'IT')
    expect(mocks.fetch).toHaveBeenCalledTimes(requests)
  })

  it('never combines an incomplete current credential pair with a legacy secret', async () => {
    vi.stubEnv('EBAY_CLIENT_ID', 'different-app')
    vi.stubEnv('EBAY_APP_ID', 'legacy-app'); vi.stubEnv('EBAY_CERT_ID', 'legacy-secret')
    await new EbayCategoryService().getCategoryBreadcrumbs(['177104'], 'IT')
    const tokenRequests = mocks.fetch.mock.calls.filter(([url]) => url.includes('/oauth2/token'))
    expect(tokenRequests.length).toBeGreaterThan(0)
    for (const [, init] of tokenRequests) expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('legacy-app:legacy-secret').toString('base64')}`)
  })

  it('shares simultaneous tree and application-token requests, retaining market identity', async () => {
    vi.stubEnv('EBAY_CLIENT_ID', 'configured-app'); vi.stubEnv('EBAY_CLIENT_SECRET', 'configured-secret')
    const service = new EbayCategoryService()
    const [italian, repeat, english] = await Promise.all([
      service.getCategoryBreadcrumbs(['177104'], 'IT'),
      service.getCategoryBreadcrumbs(['177104'], 'IT'),
      service.getCategoryBreadcrumbs(['177104'], 'UK'),
    ])
    expect(italian).toEqual(repeat)
    expect(italian['177104']).toEqual({ local: 'Italy › Jackets' })
    expect(english['177104']).toEqual({ local: 'UK › Jackets', en: 'UK › Jackets' })
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes('/oauth2/token'))).toHaveLength(1)
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/101'))).toHaveLength(1)
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/3'))).toHaveLength(1)
    expect(await service.getCategoryBreadcrumbs(['177104'], 'GB')).toEqual(english)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not substitute UK names for an unsupported marketplace', async () => {
    const service = new EbayCategoryService()
    expect(await service.getCategoryBreadcrumbs(['177104'], 'UNKNOWN')).toEqual({})
    await expect(service.getCategoryBreadcrumbs(['177104'], 'UNKNOWN', { throwOnError: true })).rejects.toThrow('this marketplace')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('distinguishes outages from unknown IDs and retries a failed tree instead of caching it', async () => {
    mocks.token.mockResolvedValue('seller-token')
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503 })
    const service = new EbayCategoryService()
    await expect(service.getCategoryBreadcrumbs(['177104'], 'IT', { throwOnError: true })).rejects.toThrow('Check the eBay connection')
    expect(await service.getCategoryBreadcrumbs(['177104'], 'IT', { throwOnError: true })).toEqual({ '177104': { local: 'Italy › Jackets' } })
    expect(await service.getCategoryBreadcrumbs(['unknown-id'], 'IT', { throwOnError: true })).toEqual({})
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects placeholder application credentials without sending them to eBay', async () => {
    vi.stubEnv('EBAY_CLIENT_ID', 'your_client_id'); vi.stubEnv('EBAY_CLIENT_SECRET', 'your_client_secret')
    await expect(new EbayCategoryService().getCategoryBreadcrumbs(['177104'], 'IT', { throwOnError: true })).rejects.toThrow('Check the eBay connection')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

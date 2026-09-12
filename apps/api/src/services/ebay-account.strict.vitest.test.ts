import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'fixture-token' } }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordApiCall: async (_meta: unknown, request: () => Promise<unknown>) => request() }))
import { EbayAccountService } from './ebay-account.service.js'
const fetcher = vi.fn()
const responseFor = (url: string) => {
  const kind = url.includes('fulfillment_policy') ? 'fulfillment' : url.includes('payment_policy') ? 'payment' : url.includes('return_policy') ? 'return' : null
  return new Response(JSON.stringify(kind ? { [`${kind}Policies`]: [{ [`${kind}PolicyId`]: kind, name: `${kind} policy`, marketplaceId: 'EBAY_IT' }] } : { locations: [{ merchantLocationKey: 'warehouse', name: 'Warehouse' }] }))
}
beforeEach(() => { fetcher.mockReset().mockImplementation(async (url: string) => responseFor(url)); vi.stubGlobal('fetch', fetcher) })
afterEach(() => vi.unstubAllGlobals())

describe('strict policy reads for assignment', () => {
  it('fetches policies freshly, with deadlines, without fetching unrelated locations', async () => {
    const service = new EbayAccountService()
    const full = await service.getSnapshot('account', 'EBAY_IT')
    expect(full.locations).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(4)
    fetcher.mockClear()
    const strict = await service.getSnapshot('account', 'EBAY_IT', { requireComplete: true })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(call => call[1].signal instanceof AbortSignal)).toBe(true)
    expect(strict.fulfillmentPolicies[0].id).toBe('fulfillment')
    expect((await service.getSnapshot('account', 'EBAY_IT')).locations).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it.each(['http', 'missing-list', 'missing-name'])('rejects %s instead of accepting a partial policy snapshot', async failure => {
    fetcher.mockImplementation(async (url: string) => url.includes('payment_policy')
      ? failure === 'http' ? new Response('Provider error', { status: 503 })
        : new Response(JSON.stringify(failure === 'missing-list' ? {} : { paymentPolicies: [{ paymentPolicyId: 'p', marketplaceId: 'EBAY_IT' }] }))
      : responseFor(url))
    await expect(new EbayAccountService().getSnapshot('account', 'EBAY_IT', { requireComplete: true })).rejects.toThrow()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEbayPolicies } from './ebayPolicies'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))
afterEach(() => vi.unstubAllGlobals())

describe('seller policy names', () => {
  it('shares requests for one account but never shares names between accounts or markets', async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ paymentPolicies: [{ id: 'same-id', name: new URL(url).searchParams.get('connectionId') }], fulfillmentPolicies: [], returnPolicies: [] }) }))
    vi.stubGlobal('fetch', fetcher)
    const first = loadEbayPolicies('IT', false, 'a')
    expect(loadEbayPolicies('IT', false, 'a')).toBe(first)
    const [a, b] = await Promise.all([first, loadEbayPolicies('IT', false, 'b')])
    expect(a.paymentPolicies[0].name).toBe('a')
    expect(b.paymentPolicies[0].name).toBe('b')
    await loadEbayPolicies('DE', false, 'a')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('uses eBay’s GB policy market for the UK scope and permits retry after failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Unavailable' }) })
      .mockResolvedValue({ ok: true, json: async () => ({ paymentPolicies: [], fulfillmentPolicies: [], returnPolicies: [] }) })
    vi.stubGlobal('fetch', fetcher)
    await expect(loadEbayPolicies('UK', false, 'uk')).rejects.toThrow('Seller policies are temporarily unavailable')
    await loadEbayPolicies('UK', false, 'uk')
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('marketplaceId')).toBe('EBAY_GB')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('turns credential failures into safe account recovery guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Credential blob failed authentication' }) }))
    await expect(loadEbayPolicies('IT', true, 'expired')).rejects.toThrow('Check the eBay connection in Connections')
  })

  it('distinguishes malformed and network failures from an empty policy list and allows retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) }).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, json: async () => ({ paymentPolicies: [], fulfillmentPolicies: [], returnPolicies: [] }) })
    vi.stubGlobal('fetch', fetcher)
    await expect(loadEbayPolicies('IT', false, 'retry')).rejects.toThrow('incomplete response')
    await expect(loadEbayPolicies('IT', false, 'retry')).rejects.toThrow('Check your connection')
    expect(await loadEbayPolicies('IT', false, 'retry')).toEqual({ paymentPolicies: [], fulfillmentPolicies: [], returnPolicies: [] })
  })
})

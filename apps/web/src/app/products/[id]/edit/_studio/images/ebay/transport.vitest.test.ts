import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'https://api.example' }))
import { mediaRequest, requestWorkspace } from './transport'
afterEach(() => vi.unstubAllGlobals())
describe('honest media transport', () => {
  it('does not claim that a disconnected write made no changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(mediaRequest('/gallery', 'PUT', {})).rejects.toThrow('server may have saved')
  })
  it('does not report a malformed success as a verified gallery save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))))
    await expect(requestWorkspace('/gallery', {})).rejects.toThrow('could not be verified')
  })
  it('requires reconciliation after an unreadable successful write response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON', { status: 200 })))
    await expect(mediaRequest('/gallery', 'PUT', {})).rejects.toMatchObject({ status: 0, message: expect.stringContaining('result is unknown') })
  })
  it.each([
    ['accountId', 'other-account'], ['market', 'DE'], ['listingId', 'other-alias'],
  ])('rejects a successful response for a different %s', async (key, value) => {
    const destination = { accountId: 'b', marketplace: 'IT', listingId: 'alias-1', aliasKey: 'alt', label: 'Alias 1', inherited: false, listings: [] }
    const data = { productId: 'p', revision: 'a'.repeat(64), draft: { axis: null, galleries: [] }, assets: [], axes: [], axisLabels: {}, destination, warnings: [], otherImageCount: 0, publication: { available: false, reason: 'Draft only' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    const query = new URLSearchParams({ accountId: 'b', market: 'IT', listingId: 'alias-1', [key]: value })
    await expect(requestWorkspace(`/api/products/p/images-workspace/ebay?${query}`)).rejects.toThrow('different listing destination')
  })
  it('preserves the server’s useful conflict message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'CONFLICT', message: 'Another editor changed the cover.' }), { status: 409 })))
    await expect(requestWorkspace('/gallery', {})).rejects.toMatchObject({ status: 409, message: 'Another editor changed the cover.' })
  })
})

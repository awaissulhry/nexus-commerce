import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCategoryOptions } from './categoryOptions'

afterEach(() => vi.unstubAllGlobals())

describe('category editor options', () => {
  it('loads locally persisted Etsy seller categories while keeping their IDs', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ externalId: '101', path: 'Clothing › Jackets' }] }) })
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await loadCategoryOptions('ETSY', 'GLOBAL', ' jackets ', signal, false, 'shop-A')).toEqual([{ value: '101', label: 'Clothing › Jackets', title: 'Clothing › Jackets\nID: 101', searchText: 'Clothing › Jackets 101' }])
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/pim/taxonomies/ETSY/GLOBAL/nodes?q=jackets&assignable=1'), { credentials: 'include', signal })
  })
  it('keeps named choices tied to their original IDs and sends the exact marketplace', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ externalId: '00123', path: 'Clothing › Jackets' }] }) })
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await loadCategoryOptions('EBAY', 'IT', ' jacket ', signal)).toEqual([{ value: '00123', label: 'Clothing › Jackets', title: 'Clothing › Jackets\nID: 00123', searchText: 'Clothing › Jackets 00123' }])
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/pim/taxonomies/EBAY/IT/nodes?q=jacket&assignable=1'), { credentials: 'include', signal })
  })
  it('does not call a remote taxonomy for an incomplete search', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect(await loadCategoryOptions('EBAY', 'IT', 'j', new AbortController().signal)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['auth', 'auth_missing', 'auth_failed'])('gives connection recovery guidance for %s without exposing credential errors', async code => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ code, error: 'Credential blob failed authentication' }) }))
    await expect(loadCategoryOptions('EBAY', 'IT', 'jacket', new AbortController().signal)).rejects.toThrow('Check the eBay connection in Connections')
  })
  it('refuses malformed responses instead of calling them no matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    await expect(loadCategoryOptions('AMAZON', 'DE', '', new AbortController().signal)).rejects.toThrow('incomplete response')
  })
  it('preserves cancellation and offers retry after a network error', async () => {
    const abort = new AbortController(); const failure = new DOMException('Aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure)); abort.abort()
    await expect(loadCategoryOptions('AMAZON', 'IT', '', abort.signal)).rejects.toBe(failure)
    await expect(loadCategoryOptions('AMAZON', 'IT', '', new AbortController().signal)).rejects.toThrow('Check your connection and try again')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const themes = [
  { id: 'active', name: 'Classic', active: true, isDefault: true },
  { id: 'inactive', name: 'Archived', active: false, isDefault: false },
]
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('reference choice loading', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('separates default, explicit no theme and active IDs; retains inactive names only for display', async () => {
    const { descriptionThemeChoices } = await import('./referenceOptions')
    const choices = descriptionThemeChoices({ themes })
    expect(choices.options.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: '', label: 'Default theme · Classic' }, { value: 'none', label: 'No theme' }, { value: 'active', label: 'Classic' },
    ])
    expect(choices.labels.inactive).toBe('Archived')
    expect(choices.options[2].title).toBe('Classic\nID: active')
    // Searching the explicit theme name must not select the default-following mode.
    expect(choices.options.filter(option => (option.searchText ?? option.label).toLowerCase().includes('classic')).map(option => option.value)).toEqual(['active'])
    expect(descriptionThemeChoices({ themes: [] }).options).toHaveLength(2)
    expect(() => descriptionThemeChoices({ themes: [{ id: 'a', name: 'Incomplete' }] })).toThrow('incomplete response')
  })

  it('shares lightweight name requests and refreshes active/default metadata on demand', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ themes }))
    vi.stubGlobal('fetch', fetcher)
    const { loadReferenceChoices } = await import('./referenceOptions')
    await Promise.all([loadReferenceChoices('descriptionThemeId'), loadReferenceChoices('descriptionThemeId')])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toContain('/ebay/description-themes?view=options')
    fetcher.mockResolvedValue(response({ themes: [] }))
    expect((await loadReferenceChoices('descriptionThemeId', {}, true)).options).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps shipping names isolated by seller, marketplace and product type', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => response({ labels: { merchant_shipping_group: { id: new URL(url).searchParams.get('accountId') ?? 'Primary' } } }))
    vi.stubGlobal('fetch', fetcher)
    const { loadReferenceChoices } = await import('./referenceOptions')
    const scope = { market: 'IT', productType: 'COAT', connectionId: 'seller-a' }
    const choices = await loadReferenceChoices('merchant_shipping_group', scope)
    expect(choices.options.map(o => o.value)).toEqual(['', 'id'])
    expect(choices.labels.id).toBe('seller-a')
    await loadReferenceChoices('shippingTemplate', scope)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await loadReferenceChoices('shippingTemplate', { ...scope, connectionId: 'seller-b' })).labels.id).toBe('seller-b')
    await loadReferenceChoices('shippingTemplate', { ...scope, market: 'DE' })
    await loadReferenceChoices('shippingTemplate', { ...scope, productType: 'SHIRT' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    await expect(loadReferenceChoices('shippingTemplate', { market: 'IT' })).rejects.toThrow('Choose a product type')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('shares a pending request even when two editors request fresh choices', async () => {
    let resolve!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done }))
    vi.stubGlobal('fetch', fetcher)
    const { loadReferenceChoices } = await import('./referenceOptions')
    const first = loadReferenceChoices('descriptionThemeId', {}, true)
    const second = loadReferenceChoices('descriptionThemeId', {}, true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolve(response({ themes }))
    expect(await first).toEqual(await second)
  })

  it('rejects unavailable and malformed choices and permits recovery after a failed request', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ labels: {}, unavailable: ['shippingTemplate'] }))
      .mockResolvedValueOnce(response({ labels: { merchant_shipping_group: { id: '   ' } } }))
      .mockResolvedValueOnce(response({ unavailable: {}, labels: { merchant_shipping_group: { id: 'Standard delivery' } } }))
      .mockResolvedValueOnce(response({ labels: { merchant_shipping_group: { id: 'Standard delivery' } } }))
    vi.stubGlobal('fetch', fetcher)
    const { loadReferenceChoices } = await import('./referenceOptions')
    const scope = { market: 'IT', productType: 'COAT' }
    await expect(loadReferenceChoices('shippingTemplate', scope)).rejects.toThrow('Amazon connection')
    await expect(loadReferenceChoices('shippingTemplate', scope)).rejects.toThrow('incomplete response')
    await expect(loadReferenceChoices('shippingTemplate', scope)).rejects.toThrow('incomplete response')
    expect((await loadReferenceChoices('shippingTemplate', scope)).labels.id).toBe('Standard delivery')
  })

  it('does not expose provider response bodies or raw network errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ error: 'private provider detail' }, 500)).mockRejectedValueOnce(new Error('Failed to fetch private detail'))
    vi.stubGlobal('fetch', fetcher)
    const { loadReferenceChoices } = await import('./referenceOptions')
    await expect(loadReferenceChoices('descriptionThemeId')).rejects.toThrow('Description theme names are unavailable. Try again.')
    await expect(loadReferenceChoices('descriptionThemeId')).rejects.toThrow('Check your connection and try again.')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialSavedViewRead } from './initialSavedViewRead'

const surfaces = ['product-edit:views:EBAY', 'product-edit:layout:EBAY', 'product-edit:layout:EBAY:IT']
afterEach(() => vi.unstubAllGlobals())

describe('one sheet initial saved-view read', () => {
  it('reads the three distinct namespaces once while each consumer keeps its own response', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ results: surfaces.map((surface, i) => ({ surface, items: [{ id: `view-${i}` }] })) })))
    vi.stubGlobal('fetch', fetcher)
    const initial = createInitialSavedViewRead('/backend', 'workspace-a:user-a', surfaces)
    expect(await Promise.all(surfaces.map(surface => initial.read(surface))))
      .toEqual([{ items: [{ id: 'view-0' }] }, { items: [{ id: 'view-1' }] }, { items: [{ id: 'view-2' }] }])
    expect(fetcher).toHaveBeenCalledOnce()
    const url = new URL(String(fetcher.mock.calls[0][0]), 'http://localhost')
    expect(url.searchParams.getAll('surfaces')).toEqual(surfaces)
  })

  it('keeps a failed namespace separate from successful named views', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [
      { surface: surfaces[0], items: [{ id: 'named' }] },
      { surface: surfaces[1], error: 'Layout storage unavailable', status: 503 },
      { surface: surfaces[2], items: [] },
    ] }))))
    const initial = createInitialSavedViewRead('/backend', 'workspace-a:user-a', surfaces)
    await expect(initial.read(surfaces[0])).resolves.toEqual({ items: [{ id: 'named' }] })
    await expect(initial.read(surfaces[1])).rejects.toMatchObject({ message: 'Layout storage unavailable', status: 503 })
    await expect(initial.read(surfaces[2])).resolves.toEqual({ items: [] })
  })

  it('does not share replies across loads, users or businesses', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: surfaces.map(surface => ({ surface, items: [{ id: 'user-a-view' }] })) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: surfaces.map(surface => ({ surface, items: [{ id: 'user-b-view' }] })) })))
    vi.stubGlobal('fetch', fetcher)
    const a = createInitialSavedViewRead('/backend', 'workspace-a:user-a', surfaces)
    const b = createInitialSavedViewRead('/backend', 'workspace-b:user-b', surfaces)
    expect((await a.read(surfaces[0])).items).toEqual([{ id: 'user-a-view' }])
    expect((await b.read(surfaces[0])).items).toEqual([{ id: 'user-b-view' }])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    {}, { results: [] }, { results: [{ surface: surfaces[0], items: null }] },
    { results: [{ surface: 'another-namespace', items: [] }] },
  ])('refuses an incomplete or malformed reply: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
    const initial = createInitialSavedViewRead('/backend', 'workspace-a:user-a', surfaces)
    await expect(initial.read(surfaces[0])).rejects.toThrow()
  })

  it('never sends a read for a namespace outside its declared initial load', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const initial = createInitialSavedViewRead('/backend', 'workspace-a:user-a', surfaces)
    await expect(initial.read('another-namespace')).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('falls back to exact single-surface reads on an older API instead of applying its default products view', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'unrelated-products-view' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'named-sheet-view' }] })))
    vi.stubGlobal('fetch', fetcher)
    const initial = createInitialSavedViewRead('/backend', 'workspace-a:user-a', surfaces)
    expect(await initial.read(surfaces[0])).toEqual({ items: [{ id: 'named-sheet-view' }] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new URL(fetcher.mock.calls[1][0], 'http://localhost').searchParams.get('surface')).toBe(surfaces[0])
  })
})

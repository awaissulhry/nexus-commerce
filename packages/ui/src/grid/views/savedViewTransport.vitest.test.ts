import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { loadWorkingLayout, saveWorkingLayout, type StoredSheetLayout } from './savedViewTransport'
import { isColumnsViewPayload, sheetLayoutPayload } from './viewPayload'

const payload = sheetLayoutPayload({ columns: ['title'], columnOrder: ['title', 'price'], lockedColumns: [], groupOrder: ['content'], groupOverrides: { title: 'content' } })
const record = { id: 'layout-1', name: 'Current layout', updatedAt: '2026-09-05T04:00:00.001Z', filters: payload }
afterEach(() => vi.unstubAllGlobals())

describe('saved sheet layout transport', () => {
  it('sends credentials, the exact layout and the prior revision on update', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(record)))
    vi.stubGlobal('fetch', fetcher)
    expect(await saveWorkingLayout('/backend', 'product-edit:layout:AMAZON:IT', payload, record)).toEqual(record)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/backend/api/saved-views/layout-1')
    expect(init).toMatchObject({ method: 'PATCH', credentials: 'include', cache: 'no-store' })
    expect(JSON.parse(init.body)).toEqual({ name: 'Current layout', surface: 'product-edit:layout:AMAZON:IT', filters: payload, expectedUpdatedAt: record.updatedAt })
  })

  it('first save uses create-only semantics', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(record)))
    vi.stubGlobal('fetch', fetcher)
    await saveWorkingLayout('', 'product-edit:layout:master:IT', payload, null)
    expect(fetcher.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetcher.mock.calls[0][1].body).expectedUpdatedAt).toBeNull()
  })

  it('rejects stale and failed saves instead of treating them as acknowledgements', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'This view changed in another session.' }), { status: 409 })))
    await expect(saveWorkingLayout('', 'product-edit:layout:master:IT', payload, record)).rejects.toMatchObject({ status: 409, message: 'This view changed in another session.' })
  })

  it('distinguishes an empty saved layout from a failed load and rejects unsupported data', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...record, filters: { v: 99 } }] })))
    vi.stubGlobal('fetch', fetcher)
    expect(await loadWorkingLayout('', 'product-edit:layout:master:IT')).toBeNull()
    await expect(loadWorkingLayout('', 'product-edit:layout:master:IT')).rejects.toMatchObject({ status: 503 })
    await expect(loadWorkingLayout('', 'product-edit:layout:master:IT')).rejects.toThrow('unsupported format')
  })

  it.each([null, {}, { items: null }, { items: {} }, { items: [null] }, { items: [{ ...record, id: '' }] }, { items: [{ ...record, updatedAt: null }] }])('rejects a malformed layout list instead of treating it as no saved layout: %j', async (body) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadWorkingLayout('', 'products-next:layout')).rejects.toThrow('saved layout list could not be read')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses ambiguous current layouts rather than silently choosing a revision to overwrite', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [record, { ...record, id: 'layout-2' }] }))))
    await expect(loadWorkingLayout('', 'products-next:layout')).rejects.toThrow('More than one current layout')
  })

  it('does not acknowledge a successful HTTP response without saved revision metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))))
    await expect(saveWorkingLayout('', 'products-next:layout', payload, null)).rejects.toThrow('saved layout acknowledgement')
  })

  it('round-trips a validated schema-1 product grid with its complete page and nested column layout', async () => {
    type ProductWorking = { v: 1; gridState: { version: string }; page: { search: string; columnLayout: typeof payload } }
    const products: ProductWorking = { v: 1, gridState: { version: '35.3.0' }, page: { search: 'boots', columnLayout: payload } }
    const productRecord: StoredSheetLayout<ProductWorking> = { ...record, filters: products }
    const validate = (value: unknown): value is ProductWorking => {
      if (!value || typeof value !== 'object') return false
      const item = value as ProductWorking
      return item.v === 1 && typeof item.gridState?.version === 'string' && typeof item.page?.search === 'string' &&
        isColumnsViewPayload(item.page.columnLayout) && item.page.columnLayout.v === 3
    }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [productRecord] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(productRecord)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [productRecord] })))
    vi.stubGlobal('fetch', fetcher)
    const loaded = await loadWorkingLayout('', 'products-next:layout', validate)
    expectTypeOf(loaded?.filters).toEqualTypeOf<ProductWorking | undefined>()
    expect(loaded).toEqual(productRecord)
    const saved = await saveWorkingLayout('', 'products-next:layout', products, loaded)
    expectTypeOf(saved.filters).toEqualTypeOf<ProductWorking>()
    expect(saved).toEqual(productRecord)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ filters: products, expectedUpdatedAt: productRecord.updatedAt })
    await expect(loadWorkingLayout('', 'products-next:layout')).rejects.toThrow('unsupported format')
  })

  it('uses the caller validator to reject unsupported payload versions', async () => {
    const checked = vi.fn()
    const validate = (value: unknown): value is { v: 1 } => {
      checked(value)
      return !!value && typeof value === 'object' && (value as { v?: unknown }).v === 1
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ ...record, filters: { v: 99 } }] }))))
    await expect(loadWorkingLayout('', 'products-next:layout', validate)).rejects.toThrow('unsupported format')
    expect(checked).toHaveBeenCalledWith({ v: 99 })
  })
})

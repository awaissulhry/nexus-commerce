import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllRowsForExport } from './productsExport'
import { createProductsDatasource } from './productsDatasource'
import { EMPTY_CONTEXT_FILTERS } from './productsServerContract'
import type { IServerSideGetRowsParams } from '@/design-system/grid'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))
const context = { tile: null, familyId: null, salesDays: 7, filters: EMPTY_CONTEXT_FILTERS }
const options = { context, sortModel: [], filterModel: {} }
const response = (rows: Array<{ id: string }>, rowCount = rows.length) => new Response(JSON.stringify({ rows, rowCount, unsupported: [] }))
afterEach(() => vi.unstubAllGlobals())

describe('complete product exports', () => {
  it('fetches every page and preserves the grid scope', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(Array.from({ length: 500 }, (_, i) => ({ id: String(i) })), 501))
      .mockResolvedValueOnce(response([{ id: 'last' }], 501))
    vi.stubGlobal('fetch', fetcher)
    const result = await fetchAllRowsForExport(options)
    expect(result).toMatchObject({ total: 501, truncated: false })
    expect(result.rows).toHaveLength(501)
    expect(JSON.parse(fetcher.mock.calls[1][1].body).request.startRow).toBe(500)
  })
  it('refuses a short response that contradicts the advertised total', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([{ id: 'one' }], 20)))
    await expect(fetchAllRowsForExport(options)).rejects.toThrow('incomplete')
  })
  it.each(['count', 'duplicate'])('rejects catalog changes across export pages: %s', async change => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: String(i) }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(first, 501))
      .mockResolvedValueOnce(response([{ id: change === 'duplicate' ? '0' : 'last' }], change === 'count' ? 502 : 501)))
    await expect(fetchAllRowsForExport(options)).rejects.toThrow('catalog changed')
  })
})

describe('product response ordering', () => {
  it('an older request cannot overwrite the totals from a newer filter', async () => {
    let finishOld!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce(response([{ id: 'new' }], 1)))
    const onTopLevel = vi.fn()
    const source = createProductsDatasource({ getContext: () => context, onTopLevel })
    const params = () => ({ request: { startRow: 0, endRow: 100, groupKeys: [], rowGroupCols: [], valueCols: [], sortModel: [], filterModel: {} }, success: vi.fn(), fail: vi.fn() }) as unknown as IServerSideGetRowsParams
    const old = source.getRows(params())
    await source.getRows(params())
    finishOld(response([{ id: 'old' }], 99))
    await old
    expect(onTopLevel).toHaveBeenCalledTimes(1)
    expect(onTopLevel.mock.calls[0][0].total).toBe(1)
  })
})

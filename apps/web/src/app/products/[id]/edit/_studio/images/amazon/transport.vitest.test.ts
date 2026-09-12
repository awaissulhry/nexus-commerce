import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../ebay/transport', () => ({ mediaRequest: f.request, MediaRequestError: class extends Error {} }))
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => '' }))
import { amazonMediaPath, requestAmazonRun, requestAmazonWorkspace, requestAmazonSafetyArchive } from './transport'
const path = '/api/products/p/images-workspace/amazon?market=IT&accountId=a&listingId=l'
const workspace = () => ({ productId: 'p', revision: 'r', draft: { common: {}, items: {} }, assets: [], items: [], destination: { accountId: 'a', marketplace: 'IT', listingId: 'l', aliasKey: '', label: 'Primary', listings: [] }, languages: ['it'], markets: [], warnings: [], observations: {}, activeRunId: null })
beforeEach(() => { vi.clearAllMocks(); f.request.mockResolvedValue(workspace()) })
afterEach(() => vi.unstubAllGlobals())
describe('Amazon media transport', () => {
  it('retains the exact selected account, market and listing for all action routes', () => {
    expect(amazonMediaPath(path, '/review')).toBe('/api/products/p/images-workspace/amazon/review?market=IT&accountId=a&listingId=l')
  })
  it.each([{ productId: 'foreign' }, { destination: { ...workspace().destination, accountId: 'other' } }, { destination: { ...workspace().destination, marketplace: 'DE' } }, { destination: { ...workspace().destination, listingId: 'alias' } }])('rejects another destination even on a successful HTTP response', async patch => {
    f.request.mockResolvedValue({ ...workspace(), ...patch }); await expect(requestAmazonWorkspace(path)).rejects.toThrow('different listing')
  })
  it('rejects incomplete schemas and propagates uncertain writes', async () => {
    f.request.mockResolvedValue({ productId: 'p' }); await expect(requestAmazonWorkspace(path)).rejects.toThrow('incomplete')
    f.request.mockRejectedValue(new Error('Outcome unknown')); await expect(requestAmazonWorkspace(path, 'PUT', {})).rejects.toThrow('Outcome unknown')
  })
  it('rejects a receipt for a different run', async () => {
    f.request.mockResolvedValue({ id: 'different', status: 'COMPLETE', createdAt: '2026-09-08', revision: 'r', items: [], receipts: [] })
    await expect(requestAmazonRun(path, '/runs/expected')).rejects.toThrow('different publication receipt')
  })
  it('preserves per-SKU unknown outcomes', async () => {
    const run = { id: 'run', status: 'UNKNOWN', createdAt: '2026-09-08', revision: 'r', items: [], receipts: [{ listingId: 'l', status: 'UNKNOWN', message: 'Response interrupted' }] }
    f.request.mockResolvedValue(run); expect(await requestAmazonRun(path, '/runs/run')).toEqual(run)
  })
})
describe('PS archive transport', () => {
  it('posts the exact saved destination, revision and selected SKUs and returns ZIP bytes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([0x50, 0x4b, 3, 4, 0]), { headers: { 'content-type': 'application/zip' } }))
    vi.stubGlobal('fetch', fetcher)
    expect((await requestAmazonSafetyArchive(path, 'revision', ['blue'])).size).toBe(5)
    expect(fetcher).toHaveBeenCalledWith(amazonMediaPath(path, '/safety-export'), expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ expectedRevision: 'revision', listingIds: ['blue'] }) }))
  })
  it('keeps export errors distinct from uncertain publication outcomes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Language review required' }), { status: 422 })))
    await expect(requestAmazonSafetyArchive(path, 'r', ['blue'])).rejects.toThrow('Language review required')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Timeout')))
    await expect(requestAmazonSafetyArchive(path, 'r', ['blue'])).rejects.toThrow('saved images are unchanged')
  })
  it('rejects login HTML, fake ZIP data and empty archives', async () => {
    for (const [body, type] of [['<html>Login</html>', 'text/html'], ['<html>Login</html>', 'application/zip'], ['', 'application/zip']]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': type } })))
      await expect(requestAmazonSafetyArchive(path, 'r', ['blue'])).rejects.toThrow(/archive/)
    }
  })
})

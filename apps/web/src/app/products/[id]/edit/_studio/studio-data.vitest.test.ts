import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStudioData } from './studio-data'
import { deriveScopeOptions } from './scopes'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://127.0.0.1:1' }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const market = { id: 'm', code: 'IT', channel: 'AMAZON', name: 'Italy', language: 'it', languages: ['it'] }
const product = { id: 'p', sku: 'XAVIA', status: 'ACTIVE', deletedAt: null }
function setup(connections: unknown, connectionStatus = 200, deletedAt: string | null = null) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('/connections') ? connections : url.includes('/marketplaces') ? { _meta: { primaryLanguage: 'it' }, AMAZON: [market] } : { ...product, deletedAt },
  ), { status: url.includes('/connections') ? connectionStatus : 200 })))
}
describe('studio frame discovery preserves absence and held connections', () => {
  it.each([500, 403])('a failed %s connection read remains a failure, not sells nowhere', async status => {
    setup({ error: 'failed' }, status)
    const result = await loadStudioData('p'); expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Product failed')
    expect(result.data.marketplacesFailed).toBe(true)
    expect(result.data.marketplaces[0].connected).toBeUndefined()
    expect(deriveScopeOptions(result.data.marketplaces, 'it').channels.map(c => c.id)).toEqual(['AMAZON'])
  })
  it('rejects missing connection arrays rather than defaulting to []', async () => {
    setup({ success: true }); const result = await loadStudioData('p')
    expect(result.kind === 'ok' && result.data.marketplacesFailed).toBe(true)
  })
  it('a successful empty inventory is distinct from a failure', async () => {
    setup({ connections: [] }); const result = await loadStudioData('p')
    if (result.kind !== 'ok') throw new Error('Product failed')
    expect(result.data.marketplacesFailed).toBe(false)
    expect(deriveScopeOptions(result.data.marketplaces, 'it').channels).toEqual([])
  })
  it('a revoked account stays visible with its reported state', async () => {
    setup({ connections: [{ id: 'account', channel: 'AMAZON', isActive: false, isManagedBy: 'oauth', authStatus: 'revoked', accountLabel: 'Seller' }] })
    const result = await loadStudioData('p'); if (result.kind !== 'ok') throw new Error('Product failed')
    expect(result.data.marketplaces[0].accounts?.[0]).toMatchObject({ id: 'account', health: { state: 'not-connected' } })
    expect(deriveScopeOptions(result.data.marketplaces, 'it').channels[0]).toMatchObject({ label: 'Amazon', health: { authStatus: 'revoked' } })
  })
  it('a bin timestamp survives a legacy Active status', async () => {
    setup({ connections: [] }, 200, '2026-09-13T12:00:00Z')
    const result = await loadStudioData('p')
    expect(result.kind === 'ok' && result.data.product.deletedAt).toBe('2026-09-13T12:00:00Z')
  })
})

/** Read live route: validation, the web copy without raw documents, scope errors and read failures (service stubbed). */
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../services/live-read/index.js', () => ({
  readLiveListing: s.read,
  publicLiveRead: ({ raw: _raw, ...rest }: any) => rest,
}))
import liveReadRoutes from './live-read.routes.js'
import { WorkspaceScopeError } from '../services/pim/workspace-destination.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

async function app() { const f = Fastify(); await f.register(liveReadRoutes, { prefix: '/api' }); return f }
beforeEach(() => { vi.clearAllMocks(); s.read.mockResolvedValue({ readAt: 'now', source: 'ebay-trading-item', revision: 'r', content: {}, variations: null, errors: [], raw: { xml: '<secret/>' }, cached: false }) })

describe('GET /api/products/:productId/live-read', () => {
  it('needs a channel, market and account', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/products/p1/live-read?channel=EBAY&marketplace=IT' })
    expect(res.statusCode).toBe(400)
    expect(s.read).not.toHaveBeenCalled()
  })

  it('reads the named destination and never returns the raw provider documents', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/products/p1/live-read?channel=ebay&marketplace=it&accountId=a1&aliasKey=alias-1' })
    expect(res.statusCode).toBe(200)
    expect(s.read).toHaveBeenCalledWith('p1', { channel: 'EBAY', marketplace: 'IT', accountId: 'a1', aliasKey: 'alias-1' })
    expect(res.json()).not.toHaveProperty('raw')
    expect(res.body).not.toContain('secret')
  })

  it('a scope error keeps its status; any other failure is a 502 that says nothing was changed', async () => {
    s.read.mockRejectedValueOnce(new WorkspaceScopeError('This product is unavailable.', 404))
    expect((await (await app()).inject({ method: 'GET', url: '/api/products/p1/live-read?channel=EBAY&marketplace=IT&accountId=a1' })).statusCode).toBe(404)
    s.read.mockRejectedValueOnce(new Error('socket hang up'))
    const res = await (await app()).inject({ method: 'GET', url: '/api/products/p1/live-read?channel=EBAY&marketplace=IT&accountId=a1' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'The channel could not be read. Nothing was changed.' })
  })

  it('is a read: it needs only the product-view permission', () => {
    const view = permissionForRoute('GET', '/api/products/p1')
    expect(view).toBeTruthy()
    expect(permissionForRoute('GET', '/api/products/p1/live-read')).toBe(view)
    expect(permissionForRoute('GET', '/api/products/p1/live-read')).not.toBe(permissionForRoute('POST', '/api/products/p1'))
  })
})

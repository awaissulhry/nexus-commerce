/**
 * AE.2 — the assortment routes: which permission each needs, and how refusals reach the caller.
 * The rules themselves are proven against the database in services/assortment/assortment-share.vitest.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { WorkspaceError } from '../lib/workspace-context.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

const calls: Array<{ fn: string; args: unknown[] }> = []
const record = (fn: string, result: unknown) => vi.fn(async (...args: unknown[]) => { calls.push({ fn, args }); return result })

vi.mock('../services/assortment/assortment.service.js', () => ({
  listAssortments: record('listAssortments', []),
  createAssortment: record('createAssortment', { id: 'a1' }),
  updateAssortment: record('updateAssortment', { id: 'a1' }),
  archiveAssortment: record('archiveAssortment', { id: 'a1' }),
  listMembers: record('listMembers', { members: [], nextCursor: null }),
  addMembers: vi.fn(async () => {
    throw Object.assign(new WorkspaceError('products_refused', '1 of 1 products cannot be added.', 400), { refused: [{ productId: 'p1', reason: 'deleted' }] })
  }),
  removeMembers: record('removeMembers', { removed: 1, version: 3 }),
}))
vi.mock('../services/assortment/copy-preview.service.js', () => ({
  previewCopy: vi.fn(async (input: { shareId: string; market: string }) => {
    calls.push({ fn: 'previewCopy', args: [input] })
    if (!input.market) throw new WorkspaceError('invalid_market', 'Choose the marketplace whose attribute dictionary the copy uses.', 400)
    return { preview: { shareId: input.shareId, counts: { new: 1 } }, catalog: { rows: ['must not be sent'] } }
  }),
}))
vi.mock('../services/assortment/assortment-share.service.js', () => ({
  listShares: record('listShares', { outgoing: [], incoming: [] }),
  offerShare: record('offerShare', { id: 's1', status: 'pending' }),
  ownerAction: vi.fn(async (id: string, action: string) => {
    calls.push({ fn: 'ownerAction', args: [id, action] })
    if (id === 'not-mine') throw new WorkspaceError('share_owner_only', 'Only the business that offered this share can pause, resume or revoke it.', 403)
    return { id, status: action === 'pause' ? 'paused' : 'active' }
  }),
  followerDecision: record('followerDecision', { id: 's1', status: 'active' }),
}))

describe('AE.2 routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    const { default: routes } = await import('./assortments.routes.js')
    await app.register(routes, { prefix: '/api' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  it('every route maps to the intended permission (first match wins in the manifest)', () => {
    const expected: Array<[string, string, string]> = [
      ['GET', '/api/assortments', 'products.view'],
      ['POST', '/api/assortments', 'products.edit'],
      ['POST', '/api/assortments/:id/update', 'products.edit'],
      ['POST', '/api/assortments/:id/archive', 'products.edit'],
      ['GET', '/api/assortments/:id/members', 'products.view'],
      ['POST', '/api/assortments/:id/members/add', 'products.edit'],
      ['POST', '/api/assortments/:id/members/remove', 'products.edit'],
      ['GET', '/api/assortment-shares', 'settings.workspace.edit'],
      ['POST', '/api/assortment-shares', 'settings.workspace.edit'],
      ['POST', '/api/assortment-shares/:id/:action', 'settings.workspace.edit'],
      ['GET', '/api/assortment-shares/:id/copy/preview', 'settings.workspace.edit'],
      ['POST', '/api/assortment-shares/:id/copy', 'settings.workspace.edit'],
      ['GET', '/api/assortment-shares/:id/copy-runs', 'settings.workspace.edit'],
      ['GET', '/api/assortment-copy-runs/:id', 'settings.workspace.edit'],
      ['POST', '/api/assortment-copy-runs/:id/advance', 'settings.workspace.edit'],
    ]
    for (const [method, pattern, permission] of expected) expect(permissionForRoute(method, pattern), `${method} ${pattern}`).toBe(permission)
    // Positive control: each of these patterns is really registered by the plugin, so the mapping
    // above is about routes that exist rather than strings that merely look right.
    for (const [method, pattern] of expected) expect(app.hasRoute({ method: method as 'GET' | 'POST', url: pattern }), `${method} ${pattern} registered`).toBe(true)
    expect(app.hasRoute({ method: 'DELETE', url: '/api/assortment-shares/:id' })).toBe(false)
  })

  it('create and offer answer 201', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/assortments', payload: { name: 'X' } })).statusCode).toBe(201)
    const offered = await app.inject({ method: 'POST', url: '/api/assortment-shares', payload: { assortmentId: 'a1', destinationWorkspaceId: 'ws_b' } })
    expect(offered.statusCode).toBe(201)
    expect(offered.json()).toEqual({ success: true, share: { id: 's1', status: 'pending' } })
  })

  it('a refusal keeps its status, code and sentence, and a refused-products list', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/assortments/a1/members/add', payload: { productIds: ['p1'], expectedVersion: 1 } })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ success: false, code: 'products_refused', error: '1 of 1 products cannot be added.', refused: [{ productId: 'p1', reason: 'deleted' }] })
    const notMine = await app.inject({ method: 'POST', url: '/api/assortment-shares/not-mine/pause', payload: { expectedVersion: 1 } })
    expect(notMine.statusCode).toBe(403)
    expect(notMine.json().code).toBe('share_owner_only')
  })

  it('the copy preview returns only the review, never the source rows, and needs a market', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/assortment-shares/s1/copy/preview?market=IT' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ success: true, preview: { shareId: 's1', counts: { new: 1 } } })
    const missing = await app.inject({ method: 'GET', url: '/api/assortment-shares/s1/copy/preview' })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().code).toBe('invalid_market')
  })

  it('actions route to the right side; an unknown action — including a prototype name — is a 404 that calls nothing', async () => {
    calls.length = 0
    expect((await app.inject({ method: 'POST', url: '/api/assortment-shares/s1/pause', payload: { expectedVersion: 2 } })).json().share.status).toBe('paused')
    expect((await app.inject({ method: 'POST', url: '/api/assortment-shares/s1/accept', payload: { expectedVersion: 1 } })).statusCode).toBe(200)
    expect(calls.map((c) => c.fn)).toEqual(['ownerAction', 'followerDecision'])
    for (const action of ['delete', 'toString', 'constructor', '__proto__']) {
      calls.length = 0
      const response = await app.inject({ method: 'POST', url: `/api/assortment-shares/s1/${action}`, payload: { expectedVersion: 1 } })
      expect(response.statusCode, action).toBe(404)
      expect(calls, action).toEqual([])
    }
  })
})

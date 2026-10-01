import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { requireWorkspace, withWorkspace } from '@nexus/database/workspace-context'

type Row = { id: string; workspaceId: string; userId: string; surface: string; name: string; shared: boolean; filters: object; isDefault: boolean; updatedAt: string }
const db = vi.hoisted(() => ({ rows: [] as Row[], failedSurface: '' }))
const owned = (row: Row, filter: unknown) => typeof filter === 'string' ? row.userId === filter
  : !!filter && typeof filter === 'object' && 'in' in filter && (filter.in as string[]).includes(row.userId)
const matches = (row: Row, where: Record<string, unknown>): boolean =>
  row.workspaceId === requireWorkspace().workspaceId && row.surface === where.surface && (Array.isArray(where.OR)
    ? where.OR.some(branch => 'userId' in branch ? owned(row, branch.userId) : branch.shared === row.shared)
    : owned(row, where.userId))
const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
  if (where.surface === db.failedSurface) throw new Error('Private storage failure')
  return structuredClone(db.rows.filter(row => matches(row, where)))
})
vi.mock('../db.js', () => ({ default: {
  savedView: { findMany: (...args: Parameters<typeof findMany>) => findMany(...args) },
  userProfile: { findMany: async () => [{ id: 'bob', displayName: 'Bob' }] },
  savedViewAlert: { findMany: async () => [] },
} }))
import routes from './saved-view-persistence.routes.js'

const named = 'product-edit:views:EBAY', layout = 'product-edit:layout:EBAY', legacy = 'product-edit:layout:EBAY:IT'
const query = (surfaces: string[]) => { const q = new URLSearchParams(); surfaces.forEach(s => q.append('surfaces', s)); return `/saved-views?${q}` }
const row = (id: string, surface: string, overrides: Partial<Row> = {}): Row => ({ id, workspaceId: 'business-a', userId: 'alice', surface, name: id, shared: false, filters: {}, isDefault: false, updatedAt: '2026-09-30T10:00:00Z', ...overrides })
let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  // Inject resolved test identities; production uses its normal auth/workspace hooks.
  app.addHook('onRequest', (request, _reply, done) => {
    const user = request.headers['x-test-user'] as string | undefined
    if (user) (request as { authUser?: { id: string } }).authUser = { id: user }
    withWorkspace({ workspaceId: String(request.headers['x-test-workspace'] ?? 'business-a'), actorUserId: user ?? null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(routes)
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => { db.rows = []; db.failedSurface = ''; findMany.mockClear(); vi.stubEnv('NEXUS_RBAC_MODE', 'enforce'); vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1') })
const get = (url: string, workspace = 'business-a', user = 'alice') => app.inject({ method: 'GET', url, headers: { 'x-test-workspace': workspace, ...(user ? { 'x-test-user': user } : {}) } })

describe('bounded saved-view read groups', () => {
  it('keeps owner, sharing, workspace and namespace access for each read', async () => {
    db.rows = [row('own', named), row('private', named, { userId: 'bob' }), row('team', named, { userId: 'bob', shared: true }),
      row('working', layout), row('other-working', layout, { userId: 'bob', shared: true }), row('legacy', legacy),
      row('other-business', named, { workspaceId: 'business-b' })]
    const response = await get(query([named, layout, legacy]))
    expect(response.statusCode).toBe(200)
    expect(response.json().results.map((r: { surface: string; items: Row[] }) => [r.surface, r.items.map(v => v.id)]))
      .toEqual([[named, ['own', 'team']], [layout, ['working']], [legacy, ['legacy']]])
  })

  it.each([[], [named, named], [named, layout, legacy, 'fourth'], [''], ['x'.repeat(251)]].map(surfaces => ({ surfaces })))('rejects an invalid group before any query: $surfaces', async ({ surfaces }) => {
    const response = await get(surfaces.length ? query(surfaces) : '/saved-views?surfaces=')
    expect(response.statusCode).toBe(400)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('requires the existing authenticated owner and rejects ambiguous query modes', async () => {
    expect((await get(query([named]), 'business-a', '')).statusCode).toBe(401)
    expect((await get(`${query([named])}&surface=products`)).statusCode).toBe(400)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('keeps a failed namespace explicit without discarding successful reads', async () => {
    db.rows = [row('named', named), row('old', legacy)]
    db.failedSurface = layout
    const response = await get(query([named, layout, legacy]))
    expect(response.statusCode).toBe(200)
    const results = response.json().results
    expect(results[0].items.map((v: Row) => v.id)).toEqual(['named'])
    expect(results[1]).toEqual({ surface: layout, status: 500, error: 'Saved views could not be read.' })
    expect(results[2].items.map((v: Row) => v.id)).toEqual(['old'])
  })

  it('never reuses another user or business response', async () => {
    db.rows = [row('a-alice', named), row('a-bob', named, { userId: 'bob' }), row('b-alice', named, { workspaceId: 'business-b' })]
    const replies = await Promise.all([get(query([named])), get(query([named]), 'business-a', 'bob'), get(query([named]), 'business-b')])
    expect(replies.map(r => r.json().results[0].items.map((v: Row) => v.id))).toEqual([['a-alice'], ['a-bob'], ['b-alice']])
  })

  it('keeps the original single-surface response shape', async () => {
    db.rows = [row('named', named)]
    const response = await get(`/saved-views?surface=${encodeURIComponent(named)}`)
    expect(Object.keys(response.json())).toEqual(['items'])
    expect(response.json().items.map((v: Row) => v.id)).toEqual(['named'])
  })
})

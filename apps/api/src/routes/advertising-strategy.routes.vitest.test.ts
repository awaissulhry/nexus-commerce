/**
 * ADS AUTONOMY W1-2 — the strategy GET routes on a real PostgreSQL (PGlite), business profiles ON: the three views
 * answer as the read tool does, a refusal is a 400 or a 404 in words, and a person without ad-spend money gets the
 * answer minus exactly the strategy's money keys (some of which the shared money registry does not name).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'w1_routes_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }
let productId = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await withWorkspace(business(A), async () => {
    productId = (await database.client.product.create({ data: { sku: 'TEST-W1-ROUTE', name: 'Route jacket', basePrice: '10.00' } })).id
    await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Route market (IT)', maxBidCents: 4321, targetKind: 'ACOS', targetPct: 27, maxChangePct: 20, updatedBy: 'user:test' } })
    await database.client.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: productId, label: 'TEST-W1-ROUTE (IT)', minBidCents: 1234, updatedBy: 'user:test' } })
  })
  const { default: routes } = await import('./advertising-strategy.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.__rbacResolved = permissions
    withWorkspace(business(A), done)
  })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const get = (url: string) => app.inject({ method: 'GET', url })

describe('GET /api/advertising/automation/strategy…', () => {
  it('rows, effective and history answer as the read tool does', async () => {
    const rows = await get('/api/advertising/automation/strategy?market=IT')
    expect(rows.statusCode).toBe(200)
    expect(rows.json()).toMatchObject({ view: 'rows', markets: [{ market: 'IT', rows: [{ level: 'MARKET', maxBidCents: 4321 }, { level: 'PRODUCT', minBidCents: 1234 }] }] })
    const effective = await get(`/api/advertising/automation/strategy/effective?market=IT&productId=${productId}`)
    expect(effective.statusCode).toBe(200)
    const fields = effective.json().markets[0].fields as Array<Record<string, unknown>>
    expect(fields.find((f) => f.field === 'minBidCents')).toMatchObject({ minBidCents: 1234, source: { level: 'product' }, readBy: [] })
    expect(fields.find((f) => f.field === 'targetAcosPct')).toMatchObject({ targetAcosPct: 27, source: { level: 'market' } })
    const history = await get('/api/advertising/automation/strategy/history?market=IT&sku=TEST-W1-ROUTE&limit=5')
    expect(history.statusCode).toBe(200)
    expect(history.json()).toMatchObject({ view: 'history', markets: [{ versions: [], note: 'No change recorded yet.' }] })
  })

  it('a refusal is a 400 or a 404 in words', async () => {
    expect((await get('/api/advertising/automation/strategy/effective?market=IT&productId=no-such&campaignId=no-such')).statusCode).toBe(400)
    expect((await get('/api/advertising/automation/strategy/effective?productId=no-such')).json()).toEqual({ error: 'Product not found' })
    expect((await get('/api/advertising/automation/strategy/effective?campaignId=no-such')).statusCode).toBe(404)
    expect((await get('/api/advertising/automation/strategy/history?market=IT&limit=0')).json()).toEqual({ error: 'limit must be a whole number from 1 to 100' })
    expect((await get('/api/advertising/automation/strategy?market=IT&channel=EBAY')).statusCode).toBe(400)
  })

  it('a person without ad-spend money gets the answer minus exactly the money; with it, everything', async () => {
    permissions = { isOwner: false, permissions: new Set([FEATURES.adsView]) }
    try {
      const hidden = await get(`/api/advertising/automation/strategy/effective?market=IT&productId=${productId}`)
      expect(hidden.statusCode).toBe(200)
      const text = hidden.body
      for (const amount of ['4321', '1234']) expect(text).not.toContain(amount)
      const fields = hidden.json().markets[0].fields as Array<Record<string, unknown>>
      expect(fields.find((f) => f.field === 'minBidCents')).toEqual(expect.objectContaining({ source: expect.objectContaining({ level: 'product' }) }))
      expect(fields.find((f) => f.field === 'minBidCents')).not.toHaveProperty('minBidCents')
      // Not money: the largest bid change stays.
      expect(fields.find((f) => f.field === 'maxChangePct')).toMatchObject({ maxChangePct: 20 })
      expect((await get('/api/advertising/automation/strategy?market=IT')).body).not.toContain('4321')
      permissions = { isOwner: false, permissions: new Set([FEATURES.adsView, FIELDS.financialsAdspendView]) }
      expect((await get(`/api/advertising/automation/strategy/effective?market=IT&productId=${productId}`)).body).toContain('1234')
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

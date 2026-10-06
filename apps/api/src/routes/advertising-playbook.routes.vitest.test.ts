/**
 * ADS PLAYBOOK PB-2 — the playbook GET routes on a real PostgreSQL (PGlite), business profiles ON: the views answer as
 * the read tool does, a refusal is a 400 or a 404 in words, and a person without ad-spend money gets the answer minus
 * exactly the playbook's money keys. Values are made up.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { templateDoc } from '../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'pb2_routes_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }
let productId = ''
let templateId = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await withWorkspace(business(A), async () => {
    const c = database.client
    productId = (await c.product.create({ data: { sku: 'TEST-PB2-ROUTE', name: 'Route jacket', basePrice: '10.00' } })).id
    templateId = (await c.adsPlaybookTemplate.create({ data: { name: 'Route funnel', doc: templateDoc() as never, updatedBy: 'user:test' } })).id
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Route market (IT)', templateId, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: productId, label: 'TEST-PB2-ROUTE (IT)', enrolled: true, dailyBudgetCents: 717171, baseBidCents: 4343, updatedBy: 'user:test' } })
    const campaign = await c.campaign.create({ data: { name: 'ROUTETOKEN | IT | Exact | Category', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date() } as never })
    const group = await c.adGroup.create({ data: { campaignId: campaign.id, name: 'Route ad group', defaultBidCents: 30 } })
    await c.adTarget.create({ data: { adGroupId: group.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'route jacket', bidCents: 55 } })
  })
  const { default: routes } = await import('./advertising-playbook.routes.js')
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

describe('GET /api/advertising/automation/playbook…', () => {
  it('rows, effective, templates, history and capture answer as the read tool does', async () => {
    const rows = await get('/api/advertising/automation/playbook?market=IT')
    expect(rows.statusCode).toBe(200)
    expect(rows.json()).toMatchObject({ view: 'rows', rows: [{ market: 'IT', level: 'MARKET', template: 'Route funnel' }, { level: 'PRODUCT', enrolled: true, dailyBudgetCents: 717171 }] })
    const effective = await get(`/api/advertising/automation/playbook/effective?market=IT&productId=${productId}`)
    expect(effective.statusCode).toBe(200)
    expect(effective.json().markets[0]).toMatchObject({ enrolled: true, compiles: true, template: { templateId, name: 'Route funnel' } })
    expect((await get(`/api/advertising/automation/playbook/templates?templateId=${templateId}`)).json().templates[0].doc).toBeTruthy()
    expect((await get('/api/advertising/automation/playbook/history?market=IT&sku=TEST-PB2-ROUTE&limit=5')).json()).toMatchObject({ view: 'history', versions: [], note: 'No change recorded yet.' })
    const capture = await get('/api/advertising/automation/playbook/capture?market=IT&productToken=ROUTETOKEN&namePrefix=ROUTETOKEN')
    expect(capture.statusCode).toBe(200)
    expect(capture.json()).toMatchObject({ view: 'capture', slots: [{ slotKey: 'exact-category' }] })
  })

  it('a list query takes its items comma-separated', async () => {
    const capture = await get('/api/advertising/automation/playbook/capture?market=IT&productToken=ROUTETOKEN&campaignIds=no-such,also-none')
    expect(capture.statusCode).toBe(404)
  })

  it('a refusal is a 400 or a 404 in words', async () => {
    expect((await get(`/api/advertising/automation/playbook/effective?market=IT&productId=${productId}&categoryId=x`)).statusCode).toBe(400)
    expect((await get('/api/advertising/automation/playbook/effective?productId=no-such')).json()).toEqual({ error: 'Product not found' })
    expect((await get('/api/advertising/automation/playbook/templates?templateId=no-such')).statusCode).toBe(404)
    expect((await get('/api/advertising/automation/playbook/history?market=IT&limit=0')).json()).toEqual({ error: 'limit must be a whole number from 1 to 100' })
    expect((await get('/api/advertising/automation/playbook/capture?market=IT&namePrefix=X')).statusCode).toBe(400)
    expect((await get('/api/advertising/automation/playbook?market=IT&channel=EBAY')).statusCode).toBe(400)
  })

  it('a person without ad-spend money gets the answer minus exactly the money; with it, everything', async () => {
    permissions = { isOwner: false, permissions: new Set([FEATURES.adsView]) }
    try {
      const hidden = await get(`/api/advertising/automation/playbook/effective?market=IT&productId=${productId}`)
      expect(hidden.statusCode).toBe(200)
      for (const amount of ['717171', '4343']) expect(hidden.body).not.toContain(amount)
      const field = (hidden.json().markets[0].product as Array<Record<string, unknown>>).find((f) => f.field === 'dailyBudgetCents')
      expect(field).toEqual(expect.objectContaining({ source: expect.objectContaining({ level: 'product' }) }))
      expect(field).not.toHaveProperty('dailyBudgetCents')
      // Not money: a budget share stays.
      expect(hidden.json().markets[0].slots[0]).toHaveProperty('budgetSharePct')
      expect((await get('/api/advertising/automation/playbook?market=IT')).body).not.toContain('717171')
      permissions = { isOwner: false, permissions: new Set([FEATURES.adsView, FIELDS.financialsAdspendView]) }
      expect((await get(`/api/advertising/automation/playbook/effective?market=IT&productId=${productId}`)).body).toContain('717171')
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

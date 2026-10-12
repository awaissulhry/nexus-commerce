/**
 * ADS PLAYBOOK PB-3 — the playbook's write routes on a real PostgreSQL (PGlite), business profiles ON: the preview saves
 * nothing and says whether this person may raise; PUT needs the version read (409 when it moved), saves a change that
 * adds no spend at once and a raise only with settings.security.manage (403 naming the raises) — no authenticator code
 * since 2026-10-12 (Owner, "B"); the answer carries the undo; a person who may not see ad-spend money sets nothing.
 * Values are made up (public repo).
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateSecret } from 'otplib'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { templateDoc } from '../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'pb3_routes_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const WRITE = [FEATURES.adsView, FEATURES.adsAutomationManage, FIELDS.financialsAdspendView]
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: false, permissions: new Set([...WRITE, FEATURES.settingsSecurityManage]) }
let userId = ''
let secret = ''
let productId = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  secret = generateSecret()
  userId = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rita Route', twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })).id
  await inA(async () => {
    const c = database.client
    productId = (await c.product.create({ data: { sku: 'TEST-PB3-ROUTE', name: 'Route jacket', basePrice: '10.00' } })).id
    const template = await c.adsPlaybookTemplate.create({ data: { name: 'Route funnel', doc: templateDoc() as never, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Amazon IT', templateId: template.id, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: productId, label: 'TEST-PB3-ROUTE (IT)', enrolled: true, state: 'DRAFT', dailyBudgetCents: 1500, baseBidCents: 30, updatedBy: 'user:test' } })
  })
  const { default: routes } = await import('./advertising-playbook.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    const r = request as unknown as Record<string, unknown>
    r.__sessionLoaded = true
    r.authUser = { id: userId, email: 'rita@example.test', displayName: 'Rita Route' }
    r.__rbacResolved = permissions
    r.workspace = business(A)
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

const send = (method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>) => app.inject({ method, url, payload })
const change = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ channel: 'AMAZON', kind: 'playbook', market: 'IT', level: 'product', productId, values, ...extra })
const row = () => inA(() => database.client.adsPlaybook.findFirstOrThrow({ where: { market: 'IT', level: 'PRODUCT', scopeId: productId } }))
const as = async <T>(next: ResolvedPermissions, work: () => Promise<T>) => {
  const was = permissions
  permissions = next
  try { return await work() } finally { permissions = was }
}

describe('POST /api/advertising/automation/playbook/preview', () => {
  it('plans the change and saves nothing; says whether this person may raise', async () => {
    const out = await send('POST', '/api/advertising/automation/playbook/preview', change({ dailyBudgetCents: 1200 }))
    expect(out.statusCode, out.body).toBe(200)
    expect(out.json()).toMatchObject({ direction: 'lower', version: { from: 1, to: 2 }, stepUp: null, mayRaise: true, changes: [{ field: 'dailyBudgetCents', from: 1500, to: 1200, direction: 'lower' }] })
    expect((await row()).dailyBudgetCents).toBe(1500)
    const forManager = await as({ isOwner: false, permissions: new Set(WRITE) }, () => send('POST', '/api/advertising/automation/playbook/preview', change({ dailyBudgetCents: 1800 })))
    expect(forManager.json()).toMatchObject({ direction: 'raise', mayRaise: false, stepUp: null, raises: ['Daily budget'] })
  })

  it('a refusal is a 400 or a 404 in words; a person without ad-spend money is refused', async () => {
    expect((await send('POST', '/api/advertising/automation/playbook/preview', { ...change({ dailyBudgetCents: 1 }), level: 'market', productId: undefined })).json())
      .toEqual({ error: 'dailyBudgetCents: only a product row holds it.' })
    expect((await send('POST', '/api/advertising/automation/playbook/preview', change({ nameToken: 'X' }, { productId: 'no-such' }))).statusCode).toBe(404)
    const noMoney = await as({ isOwner: false, permissions: new Set([FEATURES.adsView, FEATURES.adsAutomationManage]) }, () => send('POST', '/api/advertising/automation/playbook/preview', change({ nameToken: 'X' })))
    expect(noMoney.statusCode).toBe(403)
    expect(noMoney.json().error).toContain('financials.adspend.view')
  })
})

describe('PUT /api/advertising/automation/playbook', () => {
  it('needs the version read: missing 400, stale 409; a change that adds no spend saves at once, from the screen', async () => {
    expect((await send('PUT', '/api/advertising/automation/playbook', change({ dailyBudgetCents: 1200 }))).statusCode).toBe(400)
    const stale = await send('PUT', '/api/advertising/automation/playbook', change({ dailyBudgetCents: 1200 }, { expectVersion: 7 }))
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'version_moved' })
    const saved = await send('PUT', '/api/advertising/automation/playbook', change({ dailyBudgetCents: 1200 }, { expectVersion: 1 }))
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ ok: true, version: 2, direction: 'lower', liveEffect: expect.stringContaining('nothing at Amazon moves') })
    expect(await row()).toMatchObject({ dailyBudgetCents: 1200, version: 2, updatedBy: `user:${userId}` })
    const version = await inA(() => database.client.adsPlaybookVersion.findFirstOrThrow({ where: { kind: 'playbook', version: 2 } }))
    expect(version).toMatchObject({ via: 'screen', actor: 'Rita Route', actorUserId: userId, approvalId: null, stepUpAt: null, direction: 'lower' })
  })

  it('a raise: no permission 403 naming the raises — with settings.security.manage it saves, no code (Owner "B")', async () => {
    const raise = change({ dailyBudgetCents: 1600 }, { expectVersion: 2 })
    const noPermission = await as({ isOwner: false, permissions: new Set(WRITE) }, () => send('PUT', '/api/advertising/automation/playbook', raise))
    expect(noPermission.statusCode).toBe(403)
    expect(noPermission.json()).toEqual({ ok: false, code: 'forbidden', error: 'Raising what an ads playbook may spend needs the settings.security.manage permission in this business. A change that adds no spend does not.', raises: ['Daily budget'] })
    expect((await row()).dailyBudgetCents).toBe(1200)
    const saved = await send('PUT', '/api/advertising/automation/playbook', raise)
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ version: 3, direction: 'raise' })
    const version = await inA(() => database.client.adsPlaybookVersion.findFirstOrThrow({ where: { kind: 'playbook', version: 3 } }))
    expect(version).toMatchObject({ stepUpAt: null, reason: expect.stringContaining('without the authenticator code') })
  })

  it('the answer carries the undo: sent back, it puts the previous version back (a raise like any other)', async () => {
    const saved = await send('PUT', '/api/advertising/automation/playbook', change({ dailyBudgetCents: 1400 }, { expectVersion: 3 }))
    expect(saved.statusCode, saved.body).toBe(200)
    const { undo } = saved.json() as { undo: Record<string, unknown> }
    expect(undo).toMatchObject({ kind: 'playbook', market: 'IT', level: 'product', productId, op: 'set', expectVersion: 4, values: { dailyBudgetCents: 1600 } })
    expect((await as({ isOwner: false, permissions: new Set(WRITE) }, () => send('PUT', '/api/advertising/automation/playbook', undo))).json()).toMatchObject({ code: 'forbidden', raises: ['Daily budget'] })
    const undone = await send('PUT', '/api/advertising/automation/playbook', undo)
    expect(undone.statusCode, undone.body).toBe(200)
    expect(await row()).toMatchObject({ dailyBudgetCents: 1600, version: 5 })
  })
})

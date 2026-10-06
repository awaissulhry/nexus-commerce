/**
 * ADS AUTONOMY W1-3 — the strategy's write routes on a real PostgreSQL (PGlite), business profiles ON: the preview
 * saves nothing and says whether this person may raise; PUT needs the version read (409 when the row moved), saves a
 * lowering at once and a raise only with settings.security.manage and the person's fresh authenticator code (403
 * mfa_required naming the raises, 400 a wrong code); a person who may not see ad-spend money sets nothing. Values are
 * made up (public repo).
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import { __stepUpTest } from '../lib/auth/step-up.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'w13_routes_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const WRITE = [FEATURES.adsView, FEATURES.adsAutomationManage, FIELDS.financialsAdspendView]
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: false, permissions: new Set([...WRITE, FEATURES.settingsSecurityManage]) }
let userId = ''
let secret = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  secret = generateSecret()
  userId = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rita Route', twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })).id
  await inA(async () => {
    await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'IT market', maxBidCents: 150, updatedBy: 'user:test' } })
  })
  const { default: routes } = await import('./advertising-strategy.routes.js')
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

beforeEach(() => __stepUpTest.reset())

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const send = (method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>) => app.inject({ method, url, payload })
const change = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ channel: 'AMAZON', market: 'IT', level: 'market', values, ...extra })
const row = () => inA(() => database.client.adsStrategy.findFirstOrThrow({ where: { market: 'IT', level: 'MARKET' } }))
const as = async <T>(next: ResolvedPermissions, work: () => Promise<T>) => {
  const was = permissions
  permissions = next
  try { return await work() } finally { permissions = was }
}

describe('POST /api/advertising/automation/strategy/preview', () => {
  it('plans the change and saves nothing; says whether this person may raise', async () => {
    const out = await send('POST', '/api/advertising/automation/strategy/preview', change({ maxBidCents: 120 }))
    expect(out.statusCode, out.body).toBe(200)
    expect(out.json()).toMatchObject({ direction: 'lower', version: { from: 1, to: 2 }, stepUp: null, mayRaise: true, changes: [{ field: 'maxBidCents', from: 150, to: 120 }] })
    expect((await row()).maxBidCents).toBe(150)
    const forManager = await as({ isOwner: false, permissions: new Set(WRITE) }, () => send('POST', '/api/advertising/automation/strategy/preview', change({ maxBidCents: 180 })))
    expect(forManager.json()).toMatchObject({ direction: 'raise', mayRaise: false, stepUp: { raises: ['Highest bid (cents)'] } })
  })

  it('a refusal is a 400 or a 404 in words; a person without ad-spend money is refused', async () => {
    expect((await send('POST', '/api/advertising/automation/strategy/preview', change({ protect: true }))).json()).toEqual({ error: 'protect cannot be set on a market row (only on a category or product row).' })
    expect((await send('POST', '/api/advertising/automation/strategy/preview', { ...change({ maxBidCents: 1 }), level: 'category', categoryId: 'no-such' })).statusCode).toBe(404)
    const noMoney = await as({ isOwner: false, permissions: new Set([FEATURES.adsView, FEATURES.adsAutomationManage]) }, () => send('POST', '/api/advertising/automation/strategy/preview', change({ maxBidCents: 120 })))
    expect(noMoney.statusCode).toBe(403)
    expect(noMoney.json().error).toContain('financials.adspend.view')
  })
})

describe('PUT /api/advertising/automation/strategy', () => {
  it('needs the version read: missing 400, stale 409; a lowering saves at once, from the screen', async () => {
    expect((await send('PUT', '/api/advertising/automation/strategy', change({ maxBidCents: 120 }))).statusCode).toBe(400)
    const stale = await send('PUT', '/api/advertising/automation/strategy', change({ maxBidCents: 120 }, { expectVersion: 7 }))
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'version_moved' })
    const saved = await send('PUT', '/api/advertising/automation/strategy', change({ maxBidCents: 120 }, { expectVersion: 1 }))
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ ok: true, version: 2, direction: 'lower', liveEffect: expect.stringContaining('no engine') })
    expect(await row()).toMatchObject({ maxBidCents: 120, version: 2, updatedBy: `user:${userId}` })
    const version = await inA(() => database.client.adsStrategyVersion.findFirstOrThrow({ where: { version: 2, level: 'MARKET' } }))
    expect(version).toMatchObject({ via: 'screen', actor: 'Rita Route', actorUserId: userId, approvalId: null, stepUpAt: null, direction: 'lower' })
  })

  it('a raise: no code 403 naming the raises, no permission 403, a wrong code 400 — with the code it saves', async () => {
    const raise = change({ maxBidCents: 160 }, { expectVersion: 2 })
    const noCode = await send('PUT', '/api/advertising/automation/strategy', raise)
    expect(noCode.statusCode).toBe(403)
    expect(noCode.json()).toEqual({ ok: false, code: 'mfa_required', error: 'Raising the ads strategy needs the 6-digit code from your authenticator app.', raises: ['Highest bid (cents)'] })
    const noPermission = await as({ isOwner: false, permissions: new Set(WRITE) }, () => send('PUT', '/api/advertising/automation/strategy', { ...raise, code: generateSync({ secret }) }))
    expect(noPermission.statusCode).toBe(403)
    expect(noPermission.json().error).toBe('Raising the ads strategy needs the settings.security.manage permission in this business. Lowering it does not.')
    const wrong = await send('PUT', '/api/advertising/automation/strategy', { ...raise, code: '000000' })
    expect(wrong.statusCode).toBe(400)
    expect((await row()).maxBidCents).toBe(120)
    const saved = await send('PUT', '/api/advertising/automation/strategy', { ...raise, code: generateSync({ secret }) })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ version: 3, direction: 'raise' })
    expect((await row()).maxBidCents).toBe(160)
    const version = await inA(() => database.client.adsStrategyVersion.findFirstOrThrow({ where: { version: 3, level: 'MARKET' } }))
    expect(version).toMatchObject({ via: 'screen', direction: 'raise' })
    expect(version.stepUpAt).toBeInstanceOf(Date)
  })
})

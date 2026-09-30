/**
 * P0 item 9 (2026-09-30) — a formula previews and saves for a user in two or more businesses.
 *
 * A formula writes through the ordinary cell writer by an internal `PATCH /api/products/bulk` (`cell-formula.routes.ts`).
 * That request carried the session (cookie, csrf) but not the business, so its workspace hook found a user with two
 * profiles and no choice, and every preview and save answered "Select a business profile." (the local test owner and
 * the Owner are both in two). The internal request now names the business the hook VERIFIED for the original request.
 *
 * The real workspace hook (only its membership store and session lookup are stand-ins), the real product, formula and
 * PIM routes, on an in-process PostgreSQL (PGlite). Profiles are ON inside this file, since the hook is the subject.
 * Run: npx vitest run src/services/pim/mapping/formula-workspace-header.vitest.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

vi.setConfig({ testTimeout: 60_000 })
const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
// External queues are outside this disposable database. The product writer and events stay real.
vi.mock('../../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {} }))

import prisma from '../../../db.js'
import { createWorkspaceHook } from '../../../lib/workspace-hook.js'
import { rbacHook } from '../../../lib/auth/rbac-hook.js'
import { csrfCookieName, sessionCookieName } from '../../../lib/auth/cookies.js'
import { LEGACY_WORKSPACE_ID, WorkspaceError, withWorkspace } from '../../../lib/workspace-context.js'
import productRoutes from '../../../routes/products.routes.js'
import formulaRoutes from '../../../routes/cell-formula.routes.js'
import globalRoutes from '../../../routes/pim-global.routes.js'

let OWNER = ''
const SECOND = 'formula_header_second_business'
/** The Owner's shape: a member of two businesses. `membership` is the hook's access check, recorded per call. */
const memberships = vi.fn(async (userId: string, workspaceId: string) => {
  if (!OWNER || userId !== OWNER || ![LEGACY_WORKSPACE_ID, SECOND].includes(workspaceId)) throw new WorkspaceError('workspace_unavailable', 'This business profile is unavailable or you no longer have access.')
  return { roleKeys: ['OWNER'], isOwner: true, permissions: new Set<string>(),
    context: { workspaceId, actorUserId: userId, membershipId: `membership-${workspaceId}`, roleKeys: ['OWNER'] } }
})
const service = { list: vi.fn(async () => [{ id: LEGACY_WORKSPACE_ID }, { id: SECOND }]), membership: memberships }
const session = async (token?: string) => token === 'owner-session' ? { user: { id: OWNER, email: 'owner@example.test' }, sessionId: 'session-1', mfaSatisfied: true } : null

const app = Fastify()
const CSRF = 'csrf-token-for-this-test'
const asOwner = (business: string | null) => ({
  cookie: `${sessionCookieName()}=owner-session; ${csrfCookieName()}=${CSRF}`, 'x-nexus-csrf': CSRF,
  ...(business ? { 'x-nexus-workspace-id': business } : {}),
})
const coordinate = { scope: 'master', market: 'IT', locale: 'it', fieldKey: 'manufacturer' }

beforeAll(async () => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  // Real rows too: the row policies admit a signed-in user only to a business they are an active member of.
  OWNER = (await prisma.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })).id
  await prisma.workspace.create({ data: { id: SECOND, name: 'Second business', createdByUserId: OWNER, creationKey: randomUUID() } })
  await prisma.workspaceMembership.createMany({ data: [LEGACY_WORKSPACE_ID, SECOND].map(workspaceId => ({ workspaceId, userId: OWNER, status: 'active' })) })
  await app.register(cookie)
  app.addHook('preHandler', createWorkspaceHook(service as never, session as never))
  app.addHook('preHandler', rbacHook)
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    prisma.marketplace.create({ data: { id: 'fixture-market', channel: 'AMAZON', code: 'IT', name: 'Fixture Italy', region: 'EU', currency: 'EUR', language: 'it' } }))
  await app.register(productRoutes, { prefix: '/api' }); await app.register(globalRoutes, { prefix: '/api' }); await app.register(formulaRoutes, { prefix: '/api' })
  await app.ready()
}, 60_000)
beforeEach(() => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
  memberships.mockClear()
  await prisma.auditLog.deleteMany(); await prisma.cellFormula.deleteMany(); await prisma.bulkOperation.deleteMany()
  await prisma.productTranslation.deleteMany(); await prisma.productEvent.deleteMany(); await prisma.product.deleteMany()
  await prisma.product.create({ data: { id: 'one', sku: 'fixture-one', name: 'one jacket', basePrice: 10, brand: 'Nexus', manufacturer: 'Original' } })
}))
afterAll(async () => { vi.unstubAllEnvs(); await app.close(); await fixture.database.close() }, 30_000)

describe('a formula for a user in two businesses', () => {
  it('previews: the internal write names the business the hook verified', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pim/formulas/preview', headers: asOwner(LEGACY_WORKSPACE_ID), payload: { ...coordinate, productId: 'one', expr: '=$brand' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json(), res.body).toMatchObject({ ok: true, value: 'Nexus' })
    // The outer request and the internal write were each checked against the SAME business.
    expect(memberships.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(new Set(memberships.mock.calls.map(([, business]) => business))).toEqual(new Set([LEGACY_WORKSPACE_ID]))
  })

  it('saves: the value lands and the formula is stored', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', headers: asOwner(LEGACY_WORKSPACE_ID), payload: { ...coordinate, expr: 'upper($brand)' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().ok, res.body).toBe(true)
    await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('NEXUS')
      expect(await prisma.cellFormula.count()).toBe(1)
    })
  })

  it('a request with no business chosen is still refused, as before (nothing to forward)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pim/formulas/preview', headers: asOwner(null), payload: { ...coordinate, productId: 'one', expr: '=$brand' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'workspace_required' })
  })
})

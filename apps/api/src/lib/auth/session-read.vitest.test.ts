/**
 * P2 (2026-09-30) — what every signed-in request reads before its handler runs, on a real PostgreSQL (PGlite): the
 * session with its user and global roles, then the membership with its business and roles. Each is ONE statement now
 * (they were four and five, each paying the workspace scope round trips), and each answers exactly what it answered
 * before: the same fields, the same refusals.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
// The cache is an accelerator (session-cache.ts); these tests read the database every time.
vi.mock('./session-cache.js', () => ({ getCachedSession: async () => null, setCachedSession: async () => undefined, dropCachedSessions: async () => undefined }))
import prisma from '../../db.js'
import { validateSession } from './session.js'
import { hashToken } from './tokens.js'
import { sessionCookieName } from './cookies.js'
import { createWorkspaceHook } from '../workspace-hook.js'
import { createWorkspaceService } from '../../services/workspace.service.js'

/** One pg `Client.query` call is one round trip to the database. */
async function roundTrips<T>(work: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const original = pg.Client.prototype.query
  let calls = 0
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) { calls++; return (original as (...a: unknown[]) => unknown).apply(this, args) } as typeof original
  try { return { value: await work(), calls } } finally { pg.Client.prototype.query = original }
}

const HOUR = 3_600_000
let userId = ''
let lonelyId = ''
const roleIds: Record<string, string> = {}
const session = async (raw: string, user: string, data: Record<string, unknown> = {}) =>
  (prisma as any).userSession.create({ data: { userId: user, sessionTokenHash: hashToken(raw), tokenPrefix: raw.slice(0, 8), lastSeenAt: new Date(), idleExpiry: new Date(Date.now() + HOUR), absoluteExpiry: new Date(Date.now() + 24 * HOUR), ...data } })

beforeAll(async () => {
  for (const [key, permissions] of [['VIEWER', ['products.view']], ['EDITOR', ['products.view', 'products.edit']], ['OWNER', []]] as const) {
    roleIds[key] = (await (prisma as any).role.create({ data: { key, name: key[0] + key.slice(1).toLowerCase(), isSystem: true, permissions: [...permissions] } })).id
  }
  const user = await (prisma as any).userProfile.create({ data: { email: 'reader@example.test', displayName: 'Reader', status: 'active', mfaRequired: true, permissionsVersion: 7, twoFactorEnabledAt: new Date('2026-09-01T10:00:00.000Z') } })
  userId = user.id
  // Global roles, created in the reverse of their key order: the read answers them in key order.
  await (prisma as any).userRole.create({ data: { userId, roleId: roleIds.VIEWER } })
  await (prisma as any).userRole.create({ data: { userId, roleId: roleIds.EDITOR } })
  lonelyId = (await (prisma as any).userProfile.create({ data: { email: 'lonely@example.test', status: 'active' } })).id
  await session('live-session-token', userId, { mfaSatisfied: true })
  await session('lonely-session-token', lonelyId)
  await session('revoked-session-token', userId, { revokedAt: new Date() })
  await session('idle-session-token', userId, { idleExpiry: new Date(Date.now() - 1_000) })
  await session('absolute-session-token', userId, { absoluteExpiry: new Date(Date.now() - 1_000) })
  const gone = await (prisma as any).userProfile.create({ data: { email: 'gone@example.test', status: 'deactivated' } })
  await session('deactivated-session-token', gone.id)
}, 120_000)
afterAll(async () => { await state.db?.close() })

describe('validateSession', () => {
  it('reads the session, its user and the user\'s global roles in ONE round trip', async () => {
    const { value, calls } = await roundTrips(() => validateSession('live-session-token'))
    expect(value).toEqual({
      sessionId: expect.any(String),
      mfaSatisfied: true,
      user: { id: userId, email: 'reader@example.test', displayName: 'Reader', status: 'active', mfaRequired: true,
        twoFactorEnabledAt: new Date('2026-09-01T10:00:00.000Z'), permissionsVersion: 7, roleKeys: ['EDITOR', 'VIEWER'] },
    })
    expect(value!.user.twoFactorEnabledAt).toBeInstanceOf(Date)
    // Before P2: four statements (UserSession, UserProfile, UserRole, Role), five round trips each.
    expect(calls).toBe(1)
  })

  it('answers a user without global roles with no role keys', async () => {
    expect((await validateSession('lonely-session-token'))?.user).toMatchObject({ id: lonelyId, roleKeys: [], mfaRequired: false, twoFactorEnabledAt: null, permissionsVersion: 0 })
  })

  it('refuses an unknown, revoked, idle-expired, absolute-expired or deactivated session', async () => {
    for (const raw of ['no-such-session-token', 'revoked-session-token', 'idle-session-token', 'absolute-session-token', 'deactivated-session-token', '']) {
      expect(await validateSession(raw), raw).toBeNull()
    }
  })

  it('still slides an idle window that was last touched over a minute ago', async () => {
    const row = await session('stale-session-token', userId, { lastSeenAt: new Date(Date.now() - 5 * 60_000) })
    expect(await validateSession('stale-session-token')).not.toBeNull()
    await vi.waitFor(async () => {
      const after = await (prisma as any).userSession.findUnique({ where: { id: row.id }, select: { lastSeenAt: true } })
      expect(after.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    })
  })
})

describe('the business-profile hook', () => {
  it('resolves a signed-in request\'s business and roles in TWO round trips, with the same facts', async () => {
    const service = createWorkspaceService(prisma as never)
    const owner = await (prisma as any).userProfile.create({ data: { email: 'owner@example.test', status: 'active' } })
    const created = await service.create(owner.id, { name: 'Read Test', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: 'session-read-test-key-0001' })
    const membership = await (prisma as any).workspaceMembership.create({ data: { workspaceId: created.id, userId, status: 'active' } })
    for (const key of ['VIEWER', 'EDITOR']) await (prisma as any).workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: roleIds[key] } })

    const app = Fastify()
    await app.register(cookie)
    app.addHook('preHandler', createWorkspaceHook(service))
    app.get('/api/saved-views', async request => ({ workspace: request.workspace, roleKeys: request.authUser?.roleKeys, rbac: { ...request.__rbacResolved, permissions: [...(request.__rbacResolved?.permissions ?? [])].sort() } }))
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const headers = { cookie: `${sessionCookieName()}=live-session-token`, 'x-nexus-workspace-id': created.id }
      const { value: response, calls } = await roundTrips(() => app.inject({ url: '/api/saved-views', headers }))
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        workspace: { workspaceId: created.id, actorUserId: userId, membershipId: membership.id, membershipVersion: 1, roleKeys: ['EDITOR', 'VIEWER'], sessionId: expect.any(String) },
        roleKeys: ['EDITOR', 'VIEWER'],
        rbac: { isOwner: false, permissions: ['products.edit', 'products.view'] },
      })
      // Before P2: nine statements (four for the session, five for the membership), 45 round trips.
      expect(calls).toBe(2)

      // The same refusals: a revoked membership, and a business the user does not belong to.
      await (prisma as any).workspaceMembership.update({ where: { id: membership.id }, data: { status: 'revoked' } })
      expect((await app.inject({ url: '/api/saved-views', headers })).statusCode).toBe(403)
      const foreign = await service.create(owner.id, { name: 'Other Test', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: 'session-read-test-key-0002' })
      expect((await app.inject({ url: '/api/saved-views', headers: { ...headers, 'x-nexus-workspace-id': foreign.id } })).statusCode).toBe(403)
    } finally {
      vi.unstubAllEnvs()
      await app.close()
    }
  })
})

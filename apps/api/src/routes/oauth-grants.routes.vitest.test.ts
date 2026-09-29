/**
 * MCP.6 — the Connected apps routes as the API serves them: the real manifest, the real workspace
 * hook and the real RBAC gate in front, the service stood in (its PGlite suite proves the rows).
 *
 * The promises: the person's own list needs a signed-in person with 2FA done and no business;
 * the business list needs sessions.manage in the business the hook verified, even in RBAC shadow
 * mode; an API key reaches neither; the manifest names exactly these paths, so a neighbour is not
 * opened and an unmapped route is still refused.
 */
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  mine: vi.fn(),
  business: vi.fn(),
  revokeMine: vi.fn(),
  revokeBusiness: vi.fn(),
  authAudit: vi.fn(),
  legacyPermissions: {} as Record<string, string[]>,
}))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/oauth/oauth-grants.js', () => {
  class ConnectedAppError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode: number) {
      super(message)
    }
  }
  return {
    ConnectedAppError,
    listMyConnectedApps: m.mine,
    listBusinessConnectedApps: m.business,
    revokeMyConnectedApp: m.revokeMine,
    revokeBusinessConnectedApp: m.revokeBusiness,
  }
})
vi.mock('../lib/auth/session.js', () => ({ validateSession: async (token?: string) => sessions[token ?? ''] ?? null, truncateIp: () => 'fixture' }))
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: m.authAudit }))
vi.mock('../lib/auth/rbac.js', () => ({
  // Business profiles off: the legacy login roles.
  resolvePermissions: async (user: { id: string }) => ({ isOwner: false, permissions: new Set(m.legacyPermissions[user.id] ?? []) }),
  hasPermission: (resolved: { isOwner: boolean; permissions: Set<string> }, permission: string) => resolved.isOwner || resolved.permissions.has(permission),
}))
vi.mock('../lib/api-key-auth.js', () => ({ verifyApiKey: async () => ({ ok: true, keyId: 'key-1', label: 'Admin key', scopes: ['admin'] }) }))

import { FEATURES as F, PAGES as PG } from '@nexus/shared/permissions'
import { csrfCookieName, sessionCookieName } from '../lib/auth/cookies.js'
import { personalSettingsRoute } from '../lib/auth/identity-context.js'
import { permissionForRoute, PUBLIC } from '../lib/auth/permissions-manifest.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { createWorkspaceHook } from '../lib/workspace-hook.js'
import { LEGACY_WORKSPACE_ID, WorkspaceError } from '../lib/workspace-context.js'
import { ConnectedAppError } from '../services/oauth/oauth-grants.js'
import routes from './oauth-grants.routes.js'

const BUSINESS_A = 'business_aaaa'
const BUSINESS_B = 'business_bbbb'

const person = (id: string, mfaPending = false) => ({
  sessionId: `session-${id}`,
  mfaSatisfied: !mfaPending,
  user: { id, email: `${id}@example.test`, displayName: id, status: 'active', mfaRequired: false, twoFactorEnabledAt: new Date(), permissionsVersion: 1, roleKeys: [] },
})
const sessions: Record<string, ReturnType<typeof person>> = {
  'token-person': person('u-person'),
  'token-admin': person('u-admin'),
  'token-pending': person('u-pending', true),
}
/** Live memberships: who is in which business, with which permissions. */
const MEMBERS: Record<string, Record<string, string[]>> = {
  'u-person': { [BUSINESS_A]: ['ai.run'], [BUSINESS_B]: ['ai.run'] },
  'u-admin': { [BUSINESS_A]: ['ai.run', F.sessionsManage], [BUSINESS_B]: ['ai.run'] },
  'u-pending': { [BUSINESS_A]: [F.sessionsManage] },
}
const workspaces = {
  list: async (userId: string) => Object.keys(MEMBERS[userId] ?? {}).map((id) => ({ id })),
  membership: async (userId: string, workspaceId: string) => {
    const permissions = MEMBERS[userId]?.[workspaceId]
    if (!permissions) throw new WorkspaceError('workspace_unavailable', 'This business profile is unavailable or you no longer have access.')
    return {
      roleKeys: [], isOwner: false, permissions: new Set(permissions),
      context: { workspaceId, actorUserId: userId, membershipId: `m-${userId}`, roleKeys: [] },
    }
  },
}

const ROUTES = [
  ['GET', '/api/settings/connected-apps'],
  ['POST', '/api/settings/connected-apps/:grantId/revoke'],
  ['GET', '/api/connected-apps'],
  ['POST', '/api/connected-apps/:grantId/revoke'],
] as const

let app: FastifyInstance
const registered: string[] = []
beforeAll(async () => {
  app = Fastify()
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') registered.push(`${method} ${route.url}`)
  })
  await app.register(cookie)
  app.addHook('preHandler', createWorkspaceHook(workspaces as never, async (token) => sessions[token ?? ''] ?? null))
  app.addHook('preHandler', rbacHook)
  await app.register(routes, { prefix: '/api' })
  // The control for "unmapped means denied": a path beside ours that no manifest rule names.
  app.get('/api/connected-apps-unmapped', async () => ({ reached: true }))
  await app.ready()
})
afterAll(async () => {
  await app.close()
  vi.unstubAllEnvs()
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_MCP_ENABLED', '')
  m.mine.mockResolvedValue([{ id: 'g-1', appName: 'Claude' }])
  m.business.mockResolvedValue([{ id: 'g-2', appName: 'Claude', person: { name: 'Ada', email: 'ada@example.test', active: true } }])
  m.revokeMine.mockResolvedValue(undefined)
  m.revokeBusiness.mockResolvedValue(undefined)
  m.legacyPermissions = {}
})

interface Call { session?: string; business?: string; csrf?: boolean; bearer?: string }
function call(method: string, url: string, { session, business, csrf = true, bearer }: Call = {}) {
  const cookies = [session && `${sessionCookieName()}=${session}`, csrf && `${csrfCookieName()}=csrf-1`].filter(Boolean).join('; ')
  return app.inject({
    method: method as 'GET' | 'POST',
    url: url.replace(':grantId', 'g-1'),
    headers: {
      ...(cookies ? { cookie: cookies } : {}),
      ...(csrf && method !== 'GET' ? { 'x-nexus-csrf': 'csrf-1' } : {}),
      ...(business ? { 'x-nexus-workspace-id': business } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: method === 'GET' ? undefined : {},
  })
}
const serviceCalls = () => m.mine.mock.calls.length + m.business.mock.calls.length + m.revokeMine.mock.calls.length + m.revokeBusiness.mock.calls.length

describe('MCP.6 — the manifest names exactly these routes', () => {
  it('registers the four routes, each mapped, none public', () => {
    expect(registered.filter((route) => route.includes('connected-apps/') || route.endsWith('connected-apps')).sort())
      .toEqual(ROUTES.map(([method, url]) => `${method} ${url}`).sort())
    for (const [method, url] of ROUTES) {
      expect(permissionForRoute(method, url), `${method} ${url}`).not.toBeNull()
      expect(permissionForRoute(method, url), `${method} ${url}`).not.toBe(PUBLIC)
    }
  })

  it('the person’s own are a signed-in identity route; the business’s need sessions.manage', () => {
    expect(permissionForRoute('GET', '/api/settings/connected-apps')).toBe(PG.dashboard)
    expect(permissionForRoute('POST', '/api/settings/connected-apps/:grantId/revoke')).toBe(PG.dashboard)
    expect(personalSettingsRoute('/api/settings/connected-apps/:grantId/revoke')).toBe(true)
    expect(permissionForRoute('GET', '/api/connected-apps')).toBe(F.sessionsManage)
    expect(permissionForRoute('POST', '/api/connected-apps/:grantId/revoke')).toBe(F.sessionsManage)
    expect(personalSettingsRoute('/api/connected-apps')).toBe(false)
  })

  it('opens no neighbour: the paths beside ours keep their own rule, or none', () => {
    expect(permissionForRoute('GET', '/api/settings/connected-apps-extra')).toBe(F.settingsView)
    expect(permissionForRoute('GET', '/api/settings/sessions')).toBe(F.settingsSecurityManage)
    expect(personalSettingsRoute('/api/settings/connected-apps-extra')).toBe(false)
    expect(permissionForRoute('GET', '/api/connected-apps-unmapped')).toBeNull()
  })

  it('an unmapped route beside them is still refused', async () => {
    const response = await call('GET', '/api/connected-apps-unmapped', { session: 'token-admin', business: BUSINESS_A })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'route_unmapped' })
  })
})

describe('MCP.6 — business profiles on (production)', () => {
  it('anonymous callers get 401 on every route, before the service', async () => {
    for (const [method, url] of ROUTES) {
      expect((await call(method, url)).statusCode, `${method} ${url}`).toBe(401)
    }
    expect(serviceCalls()).toBe(0)
  })

  it('my own list needs no business, says whether MCP is on, and is never cached', async () => {
    const off = await call('GET', '/api/settings/connected-apps', { session: 'token-person' })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toEqual({ enabled: false, grants: [{ id: 'g-1', appName: 'Claude' }] })
    expect(off.headers['cache-control']).toBe('private, no-store')
    expect(m.mine).toHaveBeenCalledWith('u-person')
    vi.stubEnv('NEXUS_MCP_ENABLED', '1')
    // A business in the URL changes nothing, even one the person is not in: this is their identity.
    const on = await call('GET', '/api/settings/connected-apps', { session: 'token-person', business: 'business_not_mine' })
    expect(on.json()).toMatchObject({ enabled: true })
  })

  it('my own revoke needs the CSRF token and passes the grant with my id', async () => {
    expect((await call('POST', '/api/settings/connected-apps/:grantId/revoke', { session: 'token-person', csrf: false })).statusCode).toBe(403)
    expect(m.revokeMine).not.toHaveBeenCalled()
    const ok = await call('POST', '/api/settings/connected-apps/:grantId/revoke', { session: 'token-person' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })
    expect(m.revokeMine).toHaveBeenCalledWith('u-person', 'g-1')
  })

  it('a connection the service cannot show answers 404 with its sentence', async () => {
    m.revokeMine.mockRejectedValue(new ConnectedAppError('not_found', 'This connection does not exist or has already ended.', 404))
    const response = await call('POST', '/api/settings/connected-apps/:grantId/revoke', { session: 'token-person' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ code: 'not_found', error: 'This connection does not exist or has already ended.' })
  })

  it('a session still waiting for its 2FA code reaches neither list', async () => {
    const own = await call('GET', '/api/settings/connected-apps', { session: 'token-pending' })
    expect(own.statusCode).toBe(403)
    expect(own.json()).toMatchObject({ code: 'mfa_required' })
    expect((await call('GET', '/api/connected-apps', { session: 'token-pending', business: BUSINESS_A })).statusCode).toBe(403)
    expect(serviceCalls()).toBe(0)
  })

  it('the business list needs sessions.manage in the business the hook verified', async () => {
    const member = await call('GET', '/api/connected-apps', { session: 'token-person', business: BUSINESS_A })
    expect(member.statusCode).toBe(403)
    expect(member.json()).toMatchObject({ code: 'forbidden', required: F.sessionsManage })
    // The admin of A is a plain member of B.
    expect((await call('GET', '/api/connected-apps', { session: 'token-admin', business: BUSINESS_B })).statusCode).toBe(403)
    expect((await call('POST', '/api/connected-apps/:grantId/revoke', { session: 'token-admin', business: BUSINESS_B })).statusCode).toBe(403)
    expect((await call('GET', '/api/connected-apps', { session: 'token-person', business: 'business_not_mine' })).statusCode).toBe(403)
    expect(serviceCalls()).toBe(0)

    const admin = await call('GET', '/api/connected-apps', { session: 'token-admin', business: BUSINESS_A })
    expect(admin.statusCode).toBe(200)
    expect(admin.json()).toMatchObject({ enabled: false, grants: [{ id: 'g-2', person: { email: 'ada@example.test' } }] })
    expect(m.business).toHaveBeenCalledWith({ userId: 'u-admin', workspaceId: BUSINESS_A, permissions: expect.objectContaining({ isOwner: false }) })
    expect(m.business.mock.calls[0]![0].permissions.permissions.has(F.sessionsManage)).toBe(true)
  })

  it('the admin revoke is bound to the verified business and needs the CSRF token', async () => {
    expect((await call('POST', '/api/connected-apps/:grantId/revoke', { session: 'token-admin', business: BUSINESS_A, csrf: false })).statusCode).toBe(403)
    const ok = await call('POST', '/api/connected-apps/:grantId/revoke', { session: 'token-admin', business: BUSINESS_A })
    expect(ok.statusCode).toBe(200)
    expect(m.revokeBusiness).toHaveBeenCalledTimes(1)
    expect(m.revokeBusiness.mock.calls[0]![0]).toMatchObject({ userId: 'u-admin', workspaceId: BUSINESS_A })
    expect(m.revokeBusiness.mock.calls[0]![1]).toBe('g-1')
  })

  it('an API key reaches neither, even one scoped admin: there is no person behind it', async () => {
    for (const [method, url] of ROUTES) {
      const response = await call(method, url, { bearer: 'nxk_admin', business: BUSINESS_A, csrf: false })
      // The hook refuses a key on an identity route; on a business route the key passes the gate
      // and the route's own sign-in check refuses it.
      const expected = url.startsWith('/api/settings/') ? [403, 'session_required'] : [401, 'unauthenticated']
      expect([response.statusCode, response.json().code], `${method} ${url}`).toEqual(expected)
    }
    expect(serviceCalls()).toBe(0)
  })
})

describe('MCP.6 — business profiles off (RBAC in shadow mode)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    vi.stubEnv('NEXUS_RBAC_MODE', '')
  })

  it('the routes guard themselves: anonymous is 401, a pending 2FA is 403', async () => {
    for (const [method, url] of ROUTES) {
      expect((await call(method, url)).statusCode, `${method} ${url}`).toBe(401)
    }
    expect((await call('GET', '/api/settings/connected-apps', { session: 'token-pending' })).json()).toMatchObject({ code: 'mfa_required' })
    expect(serviceCalls()).toBe(0)
  })

  it('the business list still needs sessions.manage, and reads the original business', async () => {
    expect((await call('GET', '/api/connected-apps', { session: 'token-person' })).statusCode).toBe(403)
    expect(m.business).not.toHaveBeenCalled()
    m.legacyPermissions = { 'u-admin': [F.sessionsManage] }
    const ok = await call('GET', '/api/connected-apps', { session: 'token-admin' })
    expect(ok.statusCode).toBe(200)
    expect(m.business.mock.calls[0]![0]).toMatchObject({ userId: 'u-admin', workspaceId: LEGACY_WORKSPACE_ID })
  })

  it('my own list is mine alone', async () => {
    expect((await call('GET', '/api/settings/connected-apps', { session: 'token-person' })).statusCode).toBe(200)
    expect(m.mine).toHaveBeenCalledWith('u-person')
  })
})

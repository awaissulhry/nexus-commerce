/**
 * MCP full control C5 — the routes a business sets Claude's levels, limits and brakes through, as the API serves them
 * (and C8: the activity list, "what did Claude do"):
 * the real manifest, workspace hook and RBAC gate in front; the service stood in (claude-trust.vitest.test.ts proves
 * the rows, the 2FA code and the brakes).
 *
 * The promises: reading the rules needs ai.view in the business; every change needs settings.security.manage there
 * (Claude has no tool for any of it: "never for Claude" — raising its own levels and limits); a refusal keeps the
 * service's status; the actor is the signed-in person; the routes are exactly these.
 */
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  list: vi.fn(),
  setRule: vi.fn(),
  setCap: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  activity: vi.fn(),
  undo: vi.fn(),
  simulate: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/agents/claude-trust.service.js', () => ({
  listClaudeRules: m.list,
  setClaudeRule: m.setRule,
  setDailyAutoCap: m.setCap,
  pauseAutoRuns: m.pause,
  resumeAutoRuns: m.resume,
}))
vi.mock('../services/agents/claude-activity.service.js', async (original) => ({
  ...(await original<typeof import('../services/agents/claude-activity.service.js')>()),
  claudeActivity: m.activity,
}))
vi.mock('../services/agents/change-undo.service.js', () => ({ undoChangeByClick: m.undo }))
vi.mock('../services/agents/claude-rule-simulate.service.js', () => ({ simulateClaudeRule: m.simulate }))
vi.mock('../lib/auth/session.js', () => ({ validateSession: async (token?: string) => sessions[token ?? ''] ?? null, truncateIp: () => 'fixture' }))

import { FEATURES as F } from '@nexus/shared/permissions'
import { csrfCookieName, sessionCookieName } from '../lib/auth/cookies.js'
import { permissionForRoute, PUBLIC } from '../lib/auth/permissions-manifest.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { createWorkspaceHook } from '../lib/workspace-hook.js'
import { WorkspaceError } from '../lib/workspace-context.js'
import { COMMAND_SCOPE_ROUTES } from '../lib/command-idempotency.js'
import { ActivityQueryError } from '../services/agents/claude-activity.service.js'
import routes from './claude-control.routes.js'

const BUSINESS = 'business_trust_a'
const person = (id: string) => ({
  sessionId: `session-${id}`,
  mfaSatisfied: true,
  user: { id, email: `${id}@example.test`, displayName: `Name ${id}`, status: 'active', mfaRequired: false, twoFactorEnabledAt: new Date(), permissionsVersion: 1, roleKeys: [] },
})
const sessions: Record<string, ReturnType<typeof person>> = {
  'token-admin': person('u-admin'),
  'token-viewer': person('u-viewer'),
  'token-none': person('u-none'),
}
const MEMBERS: Record<string, Record<string, string[]>> = {
  'u-admin': { [BUSINESS]: ['ai.view', 'ai.run', F.settingsSecurityManage] },
  'u-viewer': { [BUSINESS]: ['ai.view', 'ai.run'] },
  'u-none': { [BUSINESS]: ['products.view'] },
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
  ['GET', '/api/claude/trust'],
  ['GET', '/api/claude/trust/:tool/simulate'],
  ['PUT', '/api/claude/trust/:tool'],
  ['PUT', '/api/claude/autonomy'],
  ['POST', '/api/claude/pause'],
  ['POST', '/api/claude/resume'],
  ['GET', '/api/claude/activity'],
  ['POST', '/api/claude/changes/:id/undo'],
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
  await app.ready()
})
afterAll(async () => {
  await app.close()
  vi.unstubAllEnvs()
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  m.list.mockResolvedValue({ autonomy: { paused: false, dailyAutoCap: 200 }, tools: [] })
  m.setRule.mockResolvedValue({ ok: true, rule: { tool: 'set-price', level: 'auto' } })
  m.setCap.mockResolvedValue({ ok: true, dailyAutoCap: 50 })
  m.pause.mockResolvedValue({ ok: true, handedBack: 2 })
  m.resume.mockResolvedValue({ ok: true })
  m.activity.mockResolvedValue({ rows: [], nextCursor: null })
  m.undo.mockResolvedValue({ ok: true, approvalId: 'apr-undo', tool: 'set-price', undoes: 'chg-1', executeAfter: '2026-10-01T12:00:20.000Z' })
  m.simulate.mockResolvedValue({ ok: true, simulation: { toolName: 'set-price', days: 30, considered: 40, wouldRun: 34, rejectedAmongWouldRun: 2, examples: [] } })
})

function call(method: string, url: string, session?: string, payload?: unknown) {
  const cookies = [session && `${sessionCookieName()}=${session}`, `${csrfCookieName()}=csrf-1`].filter(Boolean).join('; ')
  return app.inject({
    method: method as 'GET' | 'POST' | 'PUT',
    url,
    headers: {
      cookie: cookies,
      'x-nexus-csrf': 'csrf-1',
      'x-nexus-workspace-id': BUSINESS,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  })
}
const serviceCalls = () => Object.values(m).reduce((n, fn) => n + fn.mock.calls.length, 0)

describe('C5 — the manifest names exactly these routes', () => {
  it('registers them, each mapped and none public: reading needs ai.view; a brake (Pause, lowering) ai.run; Resume settings.security.manage', () => {
    expect(registered.filter((route) => route.includes('/api/claude/')).sort()).toEqual(ROUTES.map(([method, url]) => `${method} ${url}`).sort())
    for (const [method, url] of ROUTES) {
      expect(permissionForRoute(method, url), `${method} ${url}`).not.toBe(PUBLIC)
      const needs = method === 'GET' ? F.aiView : url === '/api/claude/resume' ? F.settingsSecurityManage : F.aiRun
      expect(permissionForRoute(method, url), `${method} ${url}`).toBe(needs)
    }
  })

  it('a double-click on Pause or Resume runs once (durable Idempotency-Key receipts)', () => {
    expect(COMMAND_SCOPE_ROUTES).toEqual(expect.arrayContaining(['/api/claude/pause', '/api/claude/resume', '/api/claude/changes/:id/undo']))
  })
})

describe('C5 — who may read and change Claude’s rules', () => {
  it('nobody signed in: 401 everywhere, before the service', async () => {
    for (const [method, url] of ROUTES) expect((await call(method, url.replace(':tool', 'set-price'))).statusCode, `${method} ${url}`).toBe(401)
    expect(serviceCalls()).toBe(0)
  })

  it('reading needs ai.view', async () => {
    expect((await call('GET', '/api/claude/trust', 'token-none')).statusCode).toBe(403)
    const read = await call('GET', '/api/claude/trust', 'token-viewer')
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ autonomy: { paused: false, dailyAutoCap: 200 }, tools: [] })
    expect(read.headers['cache-control']).toBe('private, no-store')
  })

  it('a brake needs only ai.run, and the service hears who may raise; Resume needs settings.security.manage', async () => {
    for (const [method, url] of ROUTES.filter(([method]) => method !== 'GET')) {
      expect((await call(method, url.replace(':tool', 'set-price'), 'token-none', {})).statusCode, `${method} ${url}`).toBe(403)
    }
    expect(serviceCalls()).toBe(0)
    expect((await call('POST', '/api/claude/pause', 'token-viewer', {})).statusCode).toBe(200)
    expect(m.pause).toHaveBeenCalledWith({ userId: 'u-viewer', label: 'Name u-viewer', canManage: false }, undefined)
    expect((await call('PUT', '/api/claude/trust/set-price', 'token-viewer', { level: 'ask' })).statusCode).toBe(200)
    expect(m.setRule).toHaveBeenCalledWith({ userId: 'u-viewer', label: 'Name u-viewer', canManage: false }, 'set-price', { level: 'ask', limits: undefined, code: undefined })
    expect((await call('POST', '/api/claude/resume', 'token-viewer', { code: '123456' })).statusCode).toBe(403)
    expect(m.resume).not.toHaveBeenCalled()
  })
})

describe('C5 — what the routes hand the service, and what they answer', () => {
  const ADMIN = { userId: 'u-admin', label: 'Name u-admin', canManage: true }

  it('PUT a level: the tool, the level, the limits and the code, as the signed-in person', async () => {
    const saved = await call('PUT', '/api/claude/trust/set-price', 'token-admin', { level: 'auto', limits: { maxChangePercent: 5 }, code: '123456' })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ ok: true, rule: { tool: 'set-price', level: 'auto' } })
    expect(m.setRule).toHaveBeenCalledWith(ADMIN, 'set-price', { level: 'auto', limits: { maxChangePercent: 5 }, code: '123456' })
  })

  it('a refusal keeps the service’s status and words', async () => {
    m.setRule.mockResolvedValue({ ok: false, status: 403, code: 'mfa_required', error: 'Type the code.' })
    const refused = await call('PUT', '/api/claude/trust/set-price', 'token-admin', { level: 'auto' })
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toEqual({ ok: false, code: 'mfa_required', error: 'Type the code.' })
  })

  it('PUT the daily cap, Pause with a reason, Resume with the code', async () => {
    expect((await call('PUT', '/api/claude/autonomy', 'token-admin', { dailyAutoCap: 50, code: '123456' })).json()).toEqual({ ok: true, dailyAutoCap: 50 })
    expect(m.setCap).toHaveBeenCalledWith(ADMIN, { dailyAutoCap: 50, code: '123456' })
    expect((await call('POST', '/api/claude/pause', 'token-admin', { reason: 'checking' })).json()).toEqual({ ok: true, handedBack: 2 })
    expect(m.pause).toHaveBeenCalledWith(ADMIN, 'checking')
    expect((await call('POST', '/api/claude/resume', 'token-admin', { code: '123456' })).json()).toEqual({ ok: true })
    expect(m.resume).toHaveBeenCalledWith(ADMIN, '123456')
  })
})

describe('C8 — the activity list: what Claude did in this business', () => {
  it('needs ai.view; hands the filters as asked, and a money filter of the reader’s own', async () => {
    expect((await call('GET', '/api/claude/activity', 'token-none')).statusCode).toBe(403)
    const read = await call('GET', '/api/claude/activity?outcome=auto&tool=set-price&limit=5', 'token-viewer')
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ rows: [], nextCursor: null })
    const [filters, storedOutput] = m.activity.mock.calls[0]
    expect(filters).toEqual({ outcome: 'auto', tool: 'set-price', limit: '5' })
    // The viewer holds ai.view and ai.run, not products.price.edit: a set-price preview is not theirs to see.
    expect(storedOutput('set-price', { action: 'set-price' })).toBeNull()
    expect(storedOutput('approval-status', { status: 'pending' })).toEqual({ status: 'pending' })
  })

  it('a filter it cannot read is a 400 that says which', async () => {
    m.activity.mockRejectedValue(new ActivityQueryError('cursor: not one this list gave out'))
    const bad = await call('GET', '/api/claude/activity?cursor=nope', 'token-viewer')
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'cursor: not one this list gave out' })
  })
})

describe('C8 — Undo on the activity page', () => {
  it('needs ai.run; the person and the change go to the service; a refusal keeps its status', async () => {
    expect((await call('POST', '/api/claude/changes/chg-1/undo', 'token-none', {})).statusCode).toBe(403)
    expect(m.undo).not.toHaveBeenCalled()
    const done = await call('POST', '/api/claude/changes/chg-1/undo', 'token-viewer', {})
    expect(done.statusCode).toBe(200)
    expect(done.json()).toEqual({ ok: true, approvalId: 'apr-undo', tool: 'set-price', undoes: 'chg-1', executeAfter: '2026-10-01T12:00:20.000Z' })
    expect(m.undo).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user', userId: 'u-viewer', via: 'app' }), 'chg-1')
    m.undo.mockResolvedValue({ ok: false, status: 409, error: 'Not undone: it has changed since.' })
    const refused = await call('POST', '/api/claude/changes/chg-1/undo', 'token-viewer', {})
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ ok: false, error: 'Not undone: it has changed since.' })
  })
})

describe('Approvals grid — what a rule would have done (the Automate modal)', () => {
  it('needs ai.view, like reading the rules; hands the tool, days, level and limits as asked, and the reader’s money filter', async () => {
    expect((await call('GET', '/api/claude/trust/set-price/simulate', 'token-none')).statusCode).toBe(403)
    expect(m.simulate).not.toHaveBeenCalled()
    const limits = encodeURIComponent(JSON.stringify({ maxChangePercent: 10 }))
    const read = await call('GET', `/api/claude/trust/set-price/simulate?days=30&level=auto&limits=${limits}`, 'token-viewer')
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ toolName: 'set-price', days: 30, considered: 40, wouldRun: 34, rejectedAmongWouldRun: 2, examples: [] })
    expect(read.headers['cache-control']).toBe('private, no-store')
    const [tool, query, storedOutput] = m.simulate.mock.calls[0]
    expect(tool).toBe('set-price')
    expect(query).toEqual({ days: '30', level: 'auto', limits: '{"maxChangePercent":10}' })
    // The viewer holds ai.view and ai.run, not products.price.edit: a set-price preview is not theirs to describe.
    expect(storedOutput('set-price', { summary: 'Price 10 → 11' })).toBeNull()
  })

  it('a refusal (bad limits, a level above the ceiling) is a 400 in the service’s words', async () => {
    m.simulate.mockResolvedValue({ ok: false, status: 400, error: 'publish-listing can be set to ask at most: a person always approves it.' })
    const refused = await call('GET', '/api/claude/trust/publish-listing/simulate?level=auto', 'token-viewer')
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toEqual({ error: 'publish-listing can be set to ask at most: a person always approves it.' })
  })
})

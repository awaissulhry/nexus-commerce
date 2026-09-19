/**
 * P0.2 (docs/channel-connections/FINAL-PLAN.md) — close the public monitoring
 * surface, make the internal token compare constant-time, and verify the
 * Cloudinary webhook on the raw bytes.
 *
 * The monitoring route list is DERIVED from the real plugins (onRoute), not
 * typed here, so a route added later is covered without editing this file.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ permissions: new Set<string>(), updateMany: vi.fn(), audit: vi.fn(), authAudit: vi.fn() }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, channelSyncQueue: null, getQueueStats: async () => ({}) }))
vi.mock('../services/monitoring/index.js', () => ({ MonitoringService: class {} }))
vi.mock('../lib/auth/session.js', () => ({ validateSession: async () => null, truncateIp: () => 'fixture' }))
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: s.authAudit }))
vi.mock('../lib/auth/rbac.js', () => ({
  resolvePermissions: async () => ({ permissions: s.permissions }),
  hasPermission: (resolved: { permissions: Set<string> }, permission: string) => resolved.permissions.has(permission),
}))
vi.mock('../db.js', () => ({ default: { digitalAsset: { updateMany: s.updateMany }, auditLog: { create: s.audit } } }))

import { FEATURES as F } from '@nexus/shared/permissions'
import { permissionForRoute, PUBLIC } from '../lib/auth/permissions-manifest.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { internalTokenMatches } from '../lib/auth/internal-token.js'
import { monitoringRoutes } from './monitoring.js'
import { jobMonitorRoutes } from './job-monitor.routes.js'
import cloudinaryWebhookRoutes from './cloudinary-webhook.routes.js'

describe('P0.2 — the monitoring routes need a signed-in user', () => {
  let app: FastifyInstance
  const routes: Array<{ method: string; url: string }> = []
  beforeAll(async () => {
    vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
    app = Fastify()
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push({ method, url: route.url })
    })
    app.addHook('onRequest', async (request) => {
      request.__sessionLoaded = true
      const user = request.headers['x-test-user']
      if (typeof user === 'string') request.authUser = { id: user, permissionsVersion: 1, roleKeys: [] } as never
    })
    app.addHook('preHandler', rbacHook)
    await app.register(monitoringRoutes)
    await app.register(jobMonitorRoutes)
    app.get('/api/health', async () => ({ ok: true })) // positive control: a PUBLIC route
    await app.ready()
  })
  afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
  beforeEach(() => { s.permissions = new Set() })

  const inject = (method: string, url: string, user?: string) => app.inject({
    method: method as never, url: url.replace(':jobId', 'job-1').replace(':type', 'LOW_STOCK'),
    headers: user ? { 'x-test-user': user } : {}, payload: method === 'GET' ? undefined : {},
  })

  it('found all 14 routes in the two plugins (the set the plan names)', () => {
    expect(routes.filter(r => r.url !== '/api/health')).toHaveLength(14)
  })
  it('every one is mapped: GET needs admin view, a change needs jobs manage', () => {
    for (const { method, url } of routes.filter(r => r.url !== '/api/health')) {
      expect(permissionForRoute(method, url), `${method} ${url}`).toBe(method === 'GET' ? F.adminView : F.jobsManage)
    }
  })
  it('anonymous callers get 401 on every one, and the refusal is audited', async () => {
    for (const { method, url } of routes.filter(r => r.url !== '/api/health')) {
      const response = await inject(method, url)
      expect(response.statusCode, `${method} ${url}`).toBe(401)
      expect(response.json()).toMatchObject({ code: 'unauthenticated' })
    }
    expect(s.authAudit).toHaveBeenCalledTimes(14)
  })
  it('a signed-in user without the permission gets 403', async () => {
    const response = await inject('POST', '/api/monitoring/queue/pause', 'viewer')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'forbidden', required: F.jobsManage })
  })
  it('positive control: a PUBLIC route still answers an anonymous caller', async () => {
    expect(permissionForRoute('GET', '/api/health')).toBe(PUBLIC)
    expect((await inject('GET', '/api/health')).statusCode).toBe(200)
  })
  it('positive control: a user with the permission passes the gate', async () => {
    s.permissions = new Set([F.adminView])
    const response = await inject('GET', '/api/monitoring/queue-stats', 'admin')
    expect([401, 403]).not.toContain(response.statusCode)
  })
})

describe('P0.2 — the internal service token is compared in constant time', () => {
  it.each([
    ['the right token', 'secret-token-123', 'secret-token-123', true],
    ['a wrong token of the same length', 'secret-token-124', 'secret-token-123', false],
    ['a shorter token (no length error)', 'secret', 'secret-token-123', false],
    ['an empty header', '', 'secret-token-123', false],
    ['a repeated header (array)', ['secret-token-123'], 'secret-token-123', false],
    ['no header', undefined, 'secret-token-123', false],
    ['an unset secret (fails closed)', 'anything', undefined, false],
    ['an empty secret (fails closed)', '', '', false],
  ] as const)('%s', (_label, header, secret, expected) => {
    expect(internalTokenMatches(header, secret)).toBe(expected)
  })
})

describe('P0.2 — the Cloudinary webhook verifies the exact bytes Cloudinary signed', () => {
  let app: FastifyInstance
  const secret = 'cloudinary-fixture-secret'
  const timestamp = '1789800000'
  // Not canonical JSON: spaces and `1.50`. JSON.stringify(JSON.parse(raw)) differs from raw.
  const raw = '{"notification_type": "upload", "public_id": "folder/a", "bytes": 1.50}'
  const sign = (body: string) => createHash('sha1').update(body + timestamp + secret).digest('hex')
  const post = (body: string, signature?: string) => app.inject({
    method: 'POST', url: '/api/assets/_webhooks/cloudinary', payload: body,
    headers: { 'content-type': 'application/json', 'x-cld-timestamp': timestamp, ...(signature ? { 'x-cld-signature': signature } : {}) },
  })
  beforeAll(async () => {
    app = Fastify()
    await app.register(cloudinaryWebhookRoutes, { prefix: '/api' })
    app.post('/api/elsewhere', async (request) => ({ keys: Object.keys(request.body as object), hasRaw: (request as { rawBody?: unknown }).rawBody !== undefined })) // outside the plugin
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { vi.stubEnv('CLOUDINARY_API_SECRET', secret); s.audit.mockResolvedValue({}); s.updateMany.mockResolvedValue({ count: 0 }) })
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

  it('the fixture really is non-canonical (otherwise this test proves nothing)', () => {
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw)
  })
  it('a signature over the raw bytes is accepted', async () => {
    const response = await post(raw, sign(raw))
    expect(response.statusCode).toBe(200)
    expect(s.audit).toHaveBeenCalledOnce()
  })
  it('a signature over the re-serialised body is refused (the old, wrong check)', async () => {
    const response = await post(raw, sign(JSON.stringify(JSON.parse(raw))))
    expect(response.statusCode).toBe(401)
    expect(s.audit).not.toHaveBeenCalled()
  })
  it('a missing signature is refused', async () => {
    expect((await post(raw)).statusCode).toBe(401)
  })
  it('no secret configured refuses everything', async () => {
    vi.stubEnv('CLOUDINARY_API_SECRET', '')
    expect((await post(raw, sign(raw))).statusCode).toBe(503)
  })
  it('the raw parser stays inside this plugin; other routes keep normal JSON parsing', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/elsewhere', payload: raw, headers: { 'content-type': 'application/json' } })
    expect(response.json()).toEqual({ keys: ['notification_type', 'public_id', 'bytes'], hasRaw: false })
  })
})

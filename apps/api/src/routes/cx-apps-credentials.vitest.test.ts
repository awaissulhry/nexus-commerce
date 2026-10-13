/**
 * Google's app credentials (client id + secret), set by an Owner in Settings → Channels → Diagnostics:
 * Owner only, Google only, write-only (the secret is sealed and never echoed), and the redirect URI pinned
 * to Nexus's own callback.
 */
import { randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

const h = vi.hoisted(() => {
  const apps: Array<Record<string, any>> = []
  const events: Array<Record<string, any>> = []
  const find = (where: any) => apps.find((a) => a.channelKey === where.channelKey_environment.channelKey && a.environment === where.channelKey_environment.environment) ?? null
  return {
    apps,
    events,
    who: { authUser: { id: 'owner-1', roleKeys: ['OWNER'] } as Record<string, unknown> | null, isOwner: true },
    prisma: {
      channelApp: {
        findUnique: vi.fn(async ({ where }: any) => find(where)),
        findMany: vi.fn(async () => apps),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const row = find(where)
          if (row) { Object.assign(row, update, { updatedAt: new Date('2026-10-13T10:00:00Z') }); return row }
          const created = { id: `app-${apps.length + 1}`, ...create, updatedAt: new Date('2026-10-13T09:00:00Z') }
          apps.push(created)
          return created
        }),
      },
      connectionEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data }) },
    },
  }
})
vi.mock('../db.js', () => ({ default: h.prisma }))
vi.mock('../jobs/cx-heartbeat.job.js', () => ({ runHeartbeatFor: vi.fn() }))
vi.mock('../services/cx/token.service.js', () => ({
  refreshNow: vi.fn(), revoke: vi.fn(), RefreshFailed: class extends Error {}, RefreshContended: class extends Error {},
  handleOf: vi.fn(), storeGrant: vi.fn(), withEbayGrantTransaction: vi.fn(),
}))

import { FEATURES as F } from '@nexus/shared/permissions'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { decryptCredentials } from '../lib/crypto.js'
import { __appsTest } from '../services/cx/apps.service.js'
import cxConnectionsRoutes from './cx-connections.routes.js'

const SECRET = 'GOCSPX-fixture-secret-value'
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', async (request) => {
    const r = request as any
    r.__sessionLoaded = true
    if (h.who.authUser) {
      r.authUser = h.who.authUser
      r.__rbacResolved = { isOwner: h.who.isOwner, permissions: new Set([F.settingsIntegrationsManage]) }
    }
  })
  await app.register(cxConnectionsRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  h.apps.length = 0
  h.events.length = 0
  h.who.authUser = { id: 'owner-1', roleKeys: ['OWNER'] }
  h.who.isOwner = true
  h.prisma.channelApp.upsert.mockClear()
  __appsTest()
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.example.test')
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '')
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '')
})

const put = (payload: unknown, channel = 'GOOGLE') => app.inject({ method: 'PUT', url: `/api/cx/apps/${channel}/credentials`, payload: payload as Record<string, unknown> })

describe('Google app credentials — the routes', () => {
  it('sit under the Channels page permission (and the Owner check on top)', () => {
    expect(permissionForRoute('PUT', '/api/cx/apps/GOOGLE/credentials')).toBe(F.settingsIntegrationsManage)
    expect(permissionForRoute('GET', '/api/cx/apps/credentials')).toBe(F.settingsIntegrationsManage)
  })

  it('a non-Owner is refused (403) and nothing is written', async () => {
    h.who.isOwner = false
    const res = await put({ clientId: CLIENT_ID, clientSecret: SECRET })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'owner_required' })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
  })

  it('an API key (no person behind it) is refused', async () => {
    h.who.authUser = null
    expect((await put({ clientId: CLIENT_ID, clientSecret: SECRET })).statusCode).toBe(403)
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
  })

  it('a channel other than Google is refused (400)', async () => {
    const res = await put({ clientId: CLIENT_ID, clientSecret: SECRET }, 'AMAZON_SP')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'unsupported_channel' })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
  })

  it.each([
    [{ clientId: 'not-a-google-client', clientSecret: SECRET }, 'invalid_client_id'],
    [{ clientId: CLIENT_ID, clientSecret: '' }, 'invalid_client_secret'],
    [{ clientId: CLIENT_ID, clientSecret: 'has a space' }, 'invalid_client_secret'],
    [{ clientId: CLIENT_ID }, 'invalid_client_secret'],
  ])('refuses %j (%s)', async (payload, code) => {
    const res = await put(payload)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code })
  })

  it('an Owner saves: the secret is sealed, never echoed; the redirect URI is pinned; the ledger names who', async () => {
    const res = await put({ clientId: ` ${CLIENT_ID} `, clientSecret: SECRET })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(SECRET)
    expect(res.json().app).toMatchObject({
      channelKey: 'GOOGLE', label: 'Google', clientId: CLIENT_ID, secretSet: true, source: 'saved',
      redirectUri: 'https://api.example.test/api/cx/callback/google', redirectUriProblem: null,
    })
    const [row] = h.apps
    expect(row).toMatchObject({ channelKey: 'GOOGLE', environment: 'production', clientId: CLIENT_ID, redirectUris: ['https://api.example.test/api/cx/callback/google'] })
    expect(String(row.clientSecretEnc)).not.toContain(SECRET)
    expect(await decryptCredentials(row.clientSecretEnc)).toEqual({ clientSecret: SECRET })
    expect(h.events).toEqual([expect.objectContaining({ channelKey: 'GOOGLE', type: 'app_credentials_set', actorUserId: 'owner-1' })])
    expect(JSON.stringify(h.events)).not.toContain(SECRET)
    expect(h.events[0].detail).toMatchObject({ first: true, clientIdChanged: true })

    // A second save (a new secret, same client): replaces the secret, the ledger says the client did not change.
    const again = await put({ clientId: CLIENT_ID, clientSecret: `${SECRET}-2` })
    expect(again.statusCode).toBe(200)
    expect(h.apps).toHaveLength(1)
    expect(await decryptCredentials(h.apps[0].clientSecretEnc)).toEqual({ clientSecret: `${SECRET}-2` })
    expect(h.events[1].detail).toMatchObject({ first: false, clientIdChanged: false })
  })

  it('GET lists Google with the redirect URI to register and never a secret', async () => {
    const empty = await app.inject('/api/cx/apps/credentials')
    expect(empty.json().apps).toEqual([expect.objectContaining({ channelKey: 'GOOGLE', clientId: null, secretSet: false, source: 'none', redirectUri: 'https://api.example.test/api/cx/callback/google' })])

    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID)
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', SECRET)
    __appsTest()
    const fromEnv = await app.inject('/api/cx/apps/credentials')
    expect(fromEnv.json().apps[0]).toMatchObject({ clientId: CLIENT_ID, secretSet: true, source: 'environment' })
    expect(fromEnv.body).not.toContain(SECRET)

    await put({ clientId: CLIENT_ID, clientSecret: SECRET })
    const saved = await app.inject('/api/cx/apps/credentials')
    expect(saved.json().apps[0]).toMatchObject({ clientId: CLIENT_ID, secretSet: true, source: 'saved' })
    expect(saved.body).not.toContain(SECRET)
  })

  it('says so when the server does not know its public address', async () => {
    vi.stubEnv('NEXUS_PUBLIC_API_URL', '')
    vi.stubEnv('PUBLIC_API_URL', '')
    vi.stubEnv('RAILWAY_PUBLIC_DOMAIN', '')
    const res = await app.inject('/api/cx/apps/credentials')
    expect(res.json().apps[0]).toMatchObject({ redirectUri: null, redirectUriProblem: expect.stringMatching(/NEXUS_PUBLIC_API_URL/) })
  })
})

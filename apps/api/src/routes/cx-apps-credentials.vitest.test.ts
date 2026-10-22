/**
 * Google's app credentials (client id + secret), set by an Owner in Settings → Channels → Diagnostics:
 * Owner only — and, as the app serves every business, only an Owner of EVERY business profile with Google
 * connected — Google only, write-only (the secret is sealed and never echoed), and the redirect URI pinned
 * to Nexus's own callback.
 *
 * Amazon Ads (2026-10-22): the same card takes a new secret for the client Nexus uses now. A different client is
 * refused, the redirect URIs stay as they are, and the Owner check is per channel (businesses with Ads connected).
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
  /** Other businesses: which have a Google (or Amazon Ads) connection, and which the caller is an Owner of. */
  const businesses = { ids: [] as string[], google: new Set<string>(), ads: new Set<string>(), ownedBy: new Map<string, Set<string>>() }
  return {
    apps,
    events,
    businesses,
    who: { authUser: { id: 'owner-1', roleKeys: ['OWNER'] } as Record<string, unknown> | null, isOwner: true },
    prisma: {
      workspace: { findMany: vi.fn(async (_args: unknown) => businesses.ids.map((id) => ({ id }))) },
      workspaceMembership: {
        findMany: vi.fn(async ({ where }: any) => [...(businesses.ownedBy.get(where.userId) ?? [])].map((workspaceId) => ({ workspaceId }))),
      },
      channelConnection: {
        // The business the count runs in is the one in context (row-level security does this for real).
        count: vi.fn(async ({ where }: any) => {
          const { workspaceContext } = await import('@nexus/database/workspace-context')
          const id = workspaceContext()?.workspaceId ?? ''
          if (where.channelType === 'GOOGLE') return businesses.google.has(id) ? 1 : 0
          return where.channelType === 'AMAZON_ADS' && businesses.ads.has(id) ? 1 : 0
        }),
      },
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
import { decryptCredentials, encryptCredentials } from '../lib/crypto.js'
import { __appsTest } from '../services/cx/apps.service.js'
import cxConnectionsRoutes from './cx-connections.routes.js'

const SECRET = 'GOCSPX-fixture-secret-value'
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
// Made-up Login with Amazon values in the real shapes.
const ADS_CLIENT_ID = `amzn1.application-oa2-client.${'a1'.repeat(16)}`
const ADS_OTHER_CLIENT_ID = `amzn1.application-oa2-client.${'b2'.repeat(16)}`
const ADS_SECRET = `amzn1.oa2-cs.v1.${'f0'.repeat(32)}`
const ADS_REDIRECT_URIS = ['https://app.example.test/api/advertising/amazon/callback']
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
  h.businesses.ids = []
  h.businesses.google.clear()
  h.businesses.ads.clear()
  h.businesses.ownedBy.clear()
  h.prisma.workspace.findMany.mockClear()
  h.prisma.channelConnection.count.mockClear()
  h.who.authUser = { id: 'owner-1', roleKeys: ['OWNER'] }
  h.who.isOwner = true
  h.prisma.channelApp.upsert.mockClear()
  __appsTest()
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.example.test')
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '')
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '')
  vi.stubEnv('AMAZON_ADS_CLIENT_ID', '')
  vi.stubEnv('AMAZON_ADS_CLIENT_SECRET', '')
  vi.stubEnv('AMAZON_ADS_REDIRECT_URI', '')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '')
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
    expect(res.json()).toMatchObject({ code: 'owner_required', error: expect.stringMatching(/Owner of every business profile with Google connected/) })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
  })

  describe('business profiles on: the app serves every business', () => {
    beforeEach(() => {
      vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
      h.businesses.ids = ['biz-here', 'biz-other', 'biz-third']
      h.businesses.ownedBy.set('owner-1', new Set(['biz-here']))
    })

    it('an Owner here who is not an Owner of another business with Google connected is refused (403); nothing is written', async () => {
      h.businesses.google.add('biz-here').add('biz-other')
      const res = await put({ clientId: CLIENT_ID, clientSecret: SECRET })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({
        code: 'owner_of_every_business_required',
        error: 'Google\'s app credentials serve the Google sign-in of every business profile in Nexus, so only a person who is an Owner of every business profile with Google connected can change them. You are not an Owner of all of them.',
      })
      expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
      expect(h.events).toEqual([])
      // Only the caller's own Owner memberships are asked for.
      expect(h.prisma.workspaceMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ userId: 'owner-1', status: 'active', roles: { some: { role: { key: 'OWNER' } } } }),
      }))
    })

    it('an Owner of every business with Google connected saves; businesses without Google do not hold it back', async () => {
      h.businesses.google.add('biz-here').add('biz-other')
      h.businesses.ownedBy.set('owner-1', new Set(['biz-here', 'biz-other'])) // not an Owner of biz-third, which has no Google
      const res = await put({ clientId: CLIENT_ID, clientSecret: SECRET })
      expect(res.statusCode).toBe(200)
      expect(res.json().app).toMatchObject({ clientId: CLIENT_ID, secretSet: true, source: 'saved' })
      // Each business the caller does not own is asked, in its own business context.
      expect(h.prisma.channelConnection.count).toHaveBeenCalledTimes(1)
    })

    it('no other business has Google connected: an Owner here saves', async () => {
      h.businesses.google.add('biz-here')
      expect((await put({ clientId: CLIENT_ID, clientSecret: SECRET })).statusCode).toBe(200)
    })

    it('a connection waiting for a new sign-in counts (it signs in again through this app)', async () => {
      h.businesses.google.add('biz-other')
      await put({ clientId: CLIENT_ID, clientSecret: SECRET })
      expect(h.prisma.channelConnection.count).toHaveBeenCalledWith({ where: { channelType: 'GOOGLE', OR: [{ isActive: true }, { authStatus: { in: ['needs_reauth'] } }] } })
    })
  })

  it('business profiles off: one business, its Owner saves without a sweep of businesses', async () => {
    h.businesses.ids = ['biz-other']
    h.businesses.google.add('biz-other')
    expect((await put({ clientId: CLIENT_ID, clientSecret: SECRET })).statusCode).toBe(200)
    expect(h.prisma.workspace.findMany).not.toHaveBeenCalled()
  })

  it('an API key (no person behind it) is refused', async () => {
    h.who.authUser = null
    expect((await put({ clientId: CLIENT_ID, clientSecret: SECRET })).statusCode).toBe(403)
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
  })

  it('a channel other than Google and Amazon Ads is refused (400)', async () => {
    const res = await put({ clientId: CLIENT_ID, clientSecret: SECRET }, 'AMAZON_SP')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      code: 'unsupported_channel',
      error: 'App credentials can be set here for Google and Amazon Ads only. Other channels keep theirs in the server environment.',
    })
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
    expect(empty.json().apps).toEqual([
      expect.objectContaining({ channelKey: 'GOOGLE', clientId: null, secretSet: false, source: 'none', redirectUri: 'https://api.example.test/api/cx/callback/google' }),
      expect.objectContaining({ channelKey: 'AMAZON_ADS', clientId: null, secretSet: false, source: 'none' }),
    ])

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

describe('Amazon Ads app credentials — a new secret for the same client', () => {
  /** The Ads app as production has it: a saved row with its redirect URIs and the old secret. */
  const savedAdsApp = async () => {
    h.apps.push({
      id: 'app-ads', channelKey: 'AMAZON_ADS', environment: 'production', clientId: ADS_CLIENT_ID,
      clientSecretEnc: (await encryptCredentials({ clientSecret: `amzn1.oa2-cs.v1.${'0e'.repeat(32)}` })).blob,
      redirectUris: [...ADS_REDIRECT_URIS], updatedAt: new Date('2026-09-01T00:00:00Z'),
    })
  }

  it('an Owner saves: the secret is sealed and never echoed; the client and the redirect URIs stay; the ledger says the client did not change', async () => {
    await savedAdsApp()
    const res = await put({ clientId: ADS_CLIENT_ID, clientSecret: ` ${ADS_SECRET} ` }, 'AMAZON_ADS')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(ADS_SECRET)
    expect(res.json().app).toMatchObject({
      channelKey: 'AMAZON_ADS', label: 'Amazon Ads', clientId: ADS_CLIENT_ID, secretSet: true, source: 'saved',
      redirectUri: null, redirectUriProblem: null,
    })
    expect(h.apps).toHaveLength(1)
    const [row] = h.apps
    expect(row).toMatchObject({ channelKey: 'AMAZON_ADS', environment: 'production', clientId: ADS_CLIENT_ID, redirectUris: ADS_REDIRECT_URIS })
    expect(String(row.clientSecretEnc)).not.toContain(ADS_SECRET)
    expect(await decryptCredentials(row.clientSecretEnc)).toEqual({ clientSecret: ADS_SECRET })
    // The update writes the secret alone.
    expect(h.prisma.channelApp.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { clientSecretEnc: expect.any(String) } }))
    expect(h.events).toEqual([expect.objectContaining({ channelKey: 'AMAZON_ADS', type: 'app_credentials_set', actorUserId: 'owner-1' })])
    expect(JSON.stringify(h.events)).not.toContain(ADS_SECRET)
    expect(h.events[0].detail).toMatchObject({ first: false, clientIdChanged: false })
  })

  it('the environment seed only (no row yet): the row is created with the seed\'s client and redirect URIs', async () => {
    vi.stubEnv('AMAZON_ADS_CLIENT_ID', ADS_CLIENT_ID)
    vi.stubEnv('AMAZON_ADS_CLIENT_SECRET', `amzn1.oa2-cs.v1.${'0e'.repeat(32)}`)
    vi.stubEnv('AMAZON_ADS_REDIRECT_URI', ADS_REDIRECT_URIS[0])
    const res = await put({ clientId: ADS_CLIENT_ID, clientSecret: ADS_SECRET }, 'AMAZON_ADS')
    expect(res.statusCode).toBe(200)
    expect(h.apps).toEqual([expect.objectContaining({ channelKey: 'AMAZON_ADS', environment: 'production', clientId: ADS_CLIENT_ID, redirectUris: ADS_REDIRECT_URIS })])
    expect(await decryptCredentials(h.apps[0].clientSecretEnc)).toEqual({ clientSecret: ADS_SECRET })
    expect(h.events[0].detail).toMatchObject({ first: true, clientIdChanged: false })
  })

  it.each([
    [''],
    ['GOCSPX-fixture-secret-value'],
    [`amzn1.oa2-cs.v1.${'f0'.repeat(31)}`],
    [`amzn1.oa2-cs.v1.${'F0'.repeat(32)}`],
    [`${ADS_SECRET} x`],
  ])('a secret of the wrong shape (%j) is refused; nothing is written', async (clientSecret) => {
    await savedAdsApp()
    const res = await put({ clientId: ADS_CLIENT_ID, clientSecret }, 'AMAZON_ADS')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'invalid_client_secret', error: 'This is not an Amazon client secret. It starts with amzn1.oa2-cs.v1. Paste it again.' })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
  })

  it.each([[ADS_OTHER_CLIENT_ID], [CLIENT_ID], ['']])('a different client (%j) is refused: it would sign every Ads account out; nothing is written', async (clientId) => {
    await savedAdsApp()
    const res = await put({ clientId, clientSecret: ADS_SECRET }, 'AMAZON_ADS')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      code: 'invalid_client_id',
      error: `Nexus's Amazon Ads accounts are signed in through client ${ADS_CLIENT_ID}. A different client would sign every Ads account out, so Nexus keeps this one. Paste only the new secret.`,
    })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
  })

  it('no Ads app at all: refused, and Nexus does not set one up here', async () => {
    const res = await put({ clientId: ADS_CLIENT_ID, clientSecret: ADS_SECRET }, 'AMAZON_ADS')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'no_app', error: expect.stringMatching(/^Nexus has no Amazon Ads app yet/) })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
    expect(h.apps).toEqual([])
  })

  it('a non-Owner is refused (403) in Amazon Ads\' words; nothing is written', async () => {
    await savedAdsApp()
    h.who.isOwner = false
    const res = await put({ clientId: ADS_CLIENT_ID, clientSecret: ADS_SECRET }, 'AMAZON_ADS')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({
      code: 'owner_required',
      error: 'Only an Owner can set app credentials. Amazon Ads\'s app credentials serve every business profile, so only an Owner of every business profile with Amazon Ads connected can change them.',
    })
    expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
  })

  it('the non-Owner sentence for Google is unchanged', async () => {
    h.who.isOwner = false
    expect((await put({ clientId: CLIENT_ID, clientSecret: SECRET })).json().error).toBe(
      'Only an Owner can set app credentials. Google\'s app credentials serve every business profile, so only an Owner of every business profile with Google connected can change them.',
    )
  })

  describe('business profiles on: the Ads app serves every business with Ads connected', () => {
    beforeEach(async () => {
      vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
      h.businesses.ids = ['biz-here', 'biz-other']
      h.businesses.ownedBy.set('owner-1', new Set(['biz-here']))
      await savedAdsApp()
    })

    it('an Owner here who is not an Owner of another business with Amazon Ads connected is refused (403); nothing is written', async () => {
      h.businesses.ads.add('biz-other')
      const res = await put({ clientId: ADS_CLIENT_ID, clientSecret: ADS_SECRET }, 'AMAZON_ADS')
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({
        code: 'owner_of_every_business_required',
        error: 'Amazon Ads\'s app credentials serve the Amazon Ads sign-in of every business profile in Nexus, so only a person who is an Owner of every business profile with Amazon Ads connected can change them. You are not an Owner of all of them.',
      })
      expect(h.prisma.channelConnection.count).toHaveBeenCalledWith({ where: { channelType: 'AMAZON_ADS', OR: [{ isActive: true }, { authStatus: { in: ['needs_reauth'] } }] } })
      expect(h.prisma.channelApp.upsert).not.toHaveBeenCalled()
      expect(h.events).toEqual([])
    })

    it('per channel: another business with only Google connected does not hold back an Ads save', async () => {
      h.businesses.google.add('biz-other')
      expect((await put({ clientId: ADS_CLIENT_ID, clientSecret: ADS_SECRET }, 'AMAZON_ADS')).statusCode).toBe(200)
    })
  })

  it('GET lists Amazon Ads with its client, no redirect URI to register, and never a secret', async () => {
    await savedAdsApp()
    const res = await app.inject('/api/cx/apps/credentials')
    expect(res.json().apps[1]).toEqual(expect.objectContaining({
      channelKey: 'AMAZON_ADS', label: 'Amazon Ads', clientId: ADS_CLIENT_ID, secretSet: true, source: 'saved', redirectUri: null, redirectUriProblem: null,
    }))
    expect(res.body).not.toContain('oa2-cs')
  })
})

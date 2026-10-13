/**
 * Google on the shared connect flow (start → Google's consent → callback): the exact consent URL, the grant
 * stored in the business that started it with the identity from the id_token, refusals that change nothing
 * (no refresh token, an id_token for another app), and a permission left unticked recorded as scope drift.
 * The real oauth.service and the real Google entry; prisma is in memory, Google's token endpoint is stubbed,
 * discovery is stubbed (spec.vitest.test.ts covers it).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { withWorkspace } from '@nexus/database/workspace-context'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID
process.env.NEXUS_PUBLIC_API_URL = 'https://api.example.test/'
delete process.env.NEXUS_OAUTH_COOKIE_ENFORCE

const h = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string }
  const sessions = new Map<string, Row>()
  const connections = new Map<string, Row>()
  const events: Array<Record<string, unknown>> = []
  const scopeUpserts: Array<Record<string, any>> = []
  const apply = (row: Row, data: Record<string, unknown>) => { for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v }
  const matches = (row: Row, where: Record<string, unknown>) => {
    for (const k of ['channelType', 'isActive', 'externalAccountId']) if (where[k] !== undefined && row[k] !== where[k]) return false
    const not = where.NOT as { id?: string } | undefined
    return !(not?.id && row.id === not.id)
  }
  let seq = 0
  const prisma: Record<string, any> = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('FROM "public"."WorkspaceMembership" m')) {
        const row = await prisma.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: values[0], userId: values[1] } } })
        return row ? [row] : []
      }
      throw new Error('unsupported query')
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    workspaceMembership: { findUnique: async () => null as unknown },
    oAuthSession: {
      create: async ({ data }: { data: Row }) => { const row = { consumedAt: null, error: null, resultConnectionId: null, ...data }; sessions.set(data.id, row); return { ...row } },
      findUnique: async ({ where }: { where: { id: string } }) => (sessions.has(where.id) ? { ...sessions.get(where.id)! } : null),
      updateMany: async ({ where, data }: { where: { id: string; channelKey: string }; data: Record<string, unknown> }) => {
        const s = sessions.get(where.id)
        if (!s || s.channelKey !== where.channelKey || s.consumedAt !== null) return { count: 0 }
        apply(s, data)
        return { count: 1 }
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const s = sessions.get(where.id)!; apply(s, data); return { ...s } },
    },
    channelConnection: {
      findUnique: async ({ where }: { where: { id: string } }) => (connections.has(where.id) ? { ...connections.get(where.id)! } : null),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => [...connections.values()].find((c) => matches(c, where)) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) => [...connections.values()].filter((c) => matches(c, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `google-conn-${++seq}`
        // The database fills workspaceId from the transaction's business; so does this fake.
        const { workspaceIdForQuery } = await import('../../../../lib/workspace-context.js')
        connections.set(id, {
          id, workspaceId: workspaceIdForQuery(), displayName: null, grantedScopes: [], identity: null, consecutiveFailures: 0,
          credentialsEnc: null, accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null,
          tokenExpiresAt: null, ebayTokenExpiresAt: null, refreshTokenExpiresAt: null, connectionMetadata: null, externalAccountId: null, ...data,
        })
        return { id }
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const r = connections.get(where.id)!; apply(r, data); return { ...r } },
    },
    connectionEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data } },
    connectionScope: { upsert: async (args: Record<string, any>) => { scopeUpserts.push(args); return args } },
  }
  return { sessions, connections, events, scopeUpserts, prisma, reset: () => { sessions.clear(); connections.clear(); events.length = 0; scopeUpserts.length = 0; seq = 0 } }
})

vi.mock('../../../../db.js', () => ({ default: h.prisma }))
vi.mock('../../../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn(async () => ({})) }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
vi.mock('../../../../utils/logger.js', async (importOriginal) => ({ ...(await importOriginal<object>()), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const CLIENT_ID = '123456789012-fixture.apps.googleusercontent.com'
vi.mock('../../apps.service.js', () => ({
  getChannelApp: vi.fn(async (key: string) => ({ channelKey: key, environment: 'production', clientId: '123456789012-fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', redirectUris: [], extra: {}, signingKey: null })),
}))
const discoverGoogleScopes = vi.fn(async () => [
  { kind: 'google_ads_customer' as const, externalId: '1111111111', label: 'Main ads', metadata: { currency: 'EUR', direct: true, managers: [] } },
  { kind: 'google_ga4_property' as const, externalId: '777', label: 'Shop GA4', metadata: { accountName: 'Web' } },
])
vi.mock('./discovery.js', () => ({ discoverGoogleScopes }))

const { start, complete, OAuthFlowError } = await import('../../oauth.service.js')
const { decryptCredentials, encryptCredentials } = await import('../../../../lib/crypto.js')
const { GOOGLE_TOKEN_URL } = await import('./spec.js')

const NOW_SEC = Math.floor(Date.now() / 1000)
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const idToken = (over: Record<string, unknown> = {}) => `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-sub-1', email: 'owner@example.test', email_verified: true, exp: NOW_SEC + 3600, iat: NOW_SEC, ...over })}.sig`
const ALL = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/content https://www.googleapis.com/auth/analytics.readonly'
let tokenAnswer: () => Response
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fetchMock = vi.fn(async (url: string | URL | Request) => {
  if (String(url) === GOOGLE_TOKEN_URL) return tokenAnswer()
  throw new Error(`unexpected fetch ${String(url)}`)
})

const ACTOR = { kind: 'operator' as const, userId: 'user-1' }
const business = { workspaceId: 'business-a', actorUserId: 'user-1', membershipId: 'member-a', roleKeys: ['OWNER'] }
const membership = () => ({ id: 'member-a', status: 'active', version: 1, userId: 'user-1', user: { status: 'active' },
  workspace: { id: 'business-a', name: 'Business A', status: 'active', version: 1 }, roles: [{ role: { id: 'owner', key: 'OWNER', name: 'Owner', permissions: [] } }] })
const cookiesOf = (s: { cookie: { name: string; value: string } }) => ({ [s.cookie.name]: s.cookie.value })
const finish = (s: Awaited<ReturnType<typeof start>>, query: Record<string, string> = {}) =>
  complete({ channelKey: 'GOOGLE', query: { state: s.state, code: 'google-code', ...query }, cookies: cookiesOf(s), actorUserId: 'user-1' })
// Production runs with business profiles ON: a connect starts and finishes in the business the person works in.
const startInBusiness = () => withWorkspace(business, () => start({ channelKey: 'GOOGLE', intent: 'connect', actor: ACTOR }))
const finishInBusiness = (s: Awaited<ReturnType<typeof start>>) => withWorkspace(business, () => finish(s))
async function flowError(p: Promise<unknown>) {
  try { await p } catch (err) { if (err instanceof OAuthFlowError) return err; throw err }
  throw new Error('expected an OAuthFlowError')
}

beforeAll(async () => { vi.stubGlobal('fetch', fetchMock); await encryptCredentials({ warm: true }) })
afterAll(() => { vi.unstubAllGlobals() })
beforeEach(() => {
  h.reset()
  h.prisma.workspaceMembership.findUnique = async () => membership()
  fetchMock.mockClear()
  discoverGoogleScopes.mockClear()
  tokenAnswer = () => json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3599, scope: ALL, token_type: 'Bearer', id_token: idToken() })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('Google connect: start', () => {
  it('sends the person to Google\'s consent page with offline access, a fresh consent, PKCE and the five permissions', async () => {
    const s = await startInBusiness()
    const url = new URL(s.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'https://api.example.test/api/cx/callback/google',
      scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/content https://www.googleapis.com/auth/analytics.readonly openid https://www.googleapis.com/auth/userinfo.email',
      state: s.state,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    })
  })

  it('refuses a plain-HTTP return address (Google would refuse it too)', async () => {
    vi.stubEnv('NEXUS_PUBLIC_API_URL', 'http://api.example.test')
    await expect(startInBusiness()).rejects.toMatchObject({ code: 'channel_unavailable' })
  })
})

describe('Google connect: callback', () => {
  it('stores the grant in the business that started it, named from the id_token, and discovers its accounts', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    const s = await startInBusiness()
    const result = await withWorkspace({ ...business, workspaceId: 'business-b' }, () => finish(s))
    expect(result).toMatchObject({ workspaceId: 'business-a', placement: 'new', channelKey: 'GOOGLE', scopeDrift: [], identity: { userId: 'google-sub-1', username: 'owner@example.test' } })
    const row = h.connections.get(result.connectionId)!
    expect(row).toMatchObject({ channelType: 'GOOGLE', workspaceId: 'business-a', isActive: true, authStatus: 'connected', externalAccountId: 'google-sub-1', displayName: 'owner@example.test' })
    const creds = await decryptCredentials(String(row.credentialsEnc))
    expect(creds).toMatchObject({ accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' })
    // The token exchange: body auth, the PKCE verifier, Google's token endpoint.
    const body = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe('fixture-secret')
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(body.get('redirect_uri')).toBe('https://api.example.test/api/cx/callback/google')
    expect(discoverGoogleScopes).toHaveBeenCalledOnce()
    expect(h.scopeUpserts.map((u) => [u.create.kind, u.create.externalId])).toEqual([['google_ads_customer', '1111111111'], ['google_ga4_property', '777']])
  })

  it('no refresh token → refused, nothing stored', async () => {
    tokenAnswer = () => json({ access_token: 'fixture-access-token', expires_in: 3599, scope: ALL, id_token: idToken() })
    const s = await startInBusiness()
    const err = await flowError(finishInBusiness(s))
    expect(err.code).toBe('exchange_failed')
    expect(err.message).toMatch(/returned no refresh token/)
    expect(h.connections.size).toBe(0)
  })

  it.each([
    ['for another app', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['expired', { exp: NOW_SEC - 3600 }],
    ['not from Google', { iss: 'https://evil.example.test' }],
  ])('an id_token %s → identity refused, nothing stored', async (_name, over) => {
    tokenAnswer = () => json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3599, scope: ALL, id_token: idToken(over) })
    const s = await startInBusiness()
    const err = await flowError(finishInBusiness(s))
    expect(err.code).toBe('identity_refused')
    expect(h.connections.size).toBe(0)
  })

  it('Analytics left unticked: the grant is stored and the missing permission is recorded as scope drift', async () => {
    tokenAnswer = () => json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3599, scope: ALL.replace(' https://www.googleapis.com/auth/analytics.readonly', ''), id_token: idToken() })
    const s = await startInBusiness()
    const result = await finishInBusiness(s)
    expect(result.scopeDrift).toEqual(['https://www.googleapis.com/auth/analytics.readonly'])
    expect(h.events.filter((e) => e.type === 'scope_drift')).toEqual([expect.objectContaining({ channelKey: 'GOOGLE', connectionId: result.connectionId, detail: expect.objectContaining({ missing: ['https://www.googleapis.com/auth/analytics.readonly'] }) })])
    expect(h.connections.get(result.connectionId)!.grantedScopes).not.toContain('https://www.googleapis.com/auth/analytics.readonly')
  })

  it('a reconnect of the same Google login folds into the same connection', async () => {
    const first = await finishInBusiness(await startInBusiness())
    const again = await finishInBusiness(await startInBusiness())
    expect(again).toMatchObject({ connectionId: first.connectionId, placement: 'reconsent' })
    expect(h.connections.size).toBe(1)
  })
})

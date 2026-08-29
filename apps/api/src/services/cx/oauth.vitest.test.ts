/**
 * CX.1 — the OAuth service: `start()` mints a single-use, cookie-bound session
 * and the consent URL; `complete()` consumes it once, enforces the cookie,
 * exchanges the code, asks the channel who consented, places the grant and
 * records scope drift.
 *
 * The real eBay catalogue entry drives the eBay cases (22 scopes, prompt=login,
 * RuName redirect, Basic auth, no PKCE); a fake PKCE channel registered under
 * ETSY covers code_challenge / code_verifier / body auth / scope discovery.
 * prisma is an in-memory fake, fetch is stubbed and routed by URL, crypto runs
 * in env mode. Token values are fixtures and are never printed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID
process.env.NEXUS_PUBLIC_API_URL = 'https://api.example.test/'
delete process.env.NEXUS_OAUTH_COOKIE_ENFORCE
delete process.env.EBAY_IDENTITY_BASE

// ── in-memory prisma ─────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string }
const sessions = new Map<string, Row>()
const connections = new Map<string, Row>()
const events: Array<Record<string, unknown>> = []
const scopeUpserts: Array<Record<string, unknown>> = []
let connSeq = 0

function apply(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v
}
function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row }
  const out: Row = { id: row.id }
  for (const k of Object.keys(select)) out[k] = row[k]
  return out
}
function connMatches(row: Row, where: Record<string, unknown>): boolean {
  for (const k of ['channelType', 'isActive', 'externalAccountId']) if (where[k] !== undefined && row[k] !== where[k]) return false
  const not = where.NOT as { id?: string } | undefined
  return !(not?.id && row.id === not.id)
}

const prismaMock = {
  oAuthSession: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { consumedAt: null, error: null, resultConnectionId: null, ...data }
      sessions.set(data.id, row)
      return { ...row }
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (sessions.has(where.id) ? { ...sessions.get(where.id)! } : null)),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; channelKey: string; consumedAt: null }; data: Record<string, unknown> }) => {
      const s = sessions.get(where.id)
      if (!s || s.channelKey !== where.channelKey || s.consumedAt !== null) return { count: 0 }
      apply(s, data)
      return { count: 1 }
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const s = sessions.get(where.id)
      if (!s) throw new Error('fake prisma: no session')
      apply(s, data)
      return { ...s }
    }),
    deleteMany: vi.fn(async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
      let count = 0
      for (const [id, s] of sessions) {
        if ((s.expiresAt as Date).getTime() < where.expiresAt.lt.getTime()) {
          sessions.delete(id)
          count++
        }
      }
      return { count }
    }),
  },
  channelConnection: {
    findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const r = connections.get(where.id)
      return r ? pick(r, select) : null
    }),
    findFirst: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const r = [...connections.values()].find((c) => connMatches(c, where))
      return r ? pick(r, select) : null
    }),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...connections.values()].filter((c) => connMatches(c, where)).length),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = `conn-${++connSeq}`
      connections.set(id, {
        id,
        displayName: null,
        grantedScopes: [],
        identity: null,
        consecutiveFailures: 0,
        credentialsEnc: null,
        accessToken: null,
        refreshToken: null,
        ebayAccessToken: null,
        ebayRefreshToken: null,
        tokenExpiresAt: null,
        ebayTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        connectionMetadata: null,
        externalAccountId: null,
        ...data,
      })
      return { id }
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = connections.get(where.id)
      if (!r) throw new Error(`fake prisma: no connection ${where.id}`)
      apply(r, data)
      return { ...r }
    }),
  },
  connectionEvent: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      events.push(data)
      return data
    }),
  },
  connectionScope: {
    upsert: vi.fn(async (args: Record<string, unknown>) => {
      scopeUpserts.push(args)
      return args
    }),
  },
}

vi.mock('../../db.js', () => ({ default: prismaMock }))
vi.mock('../monitoring/alert.service.js', () => ({
  alertService: { createAlert: vi.fn(async () => ({})) },
  AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' },
}))
vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>()
  return { ...actual, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})
const getChannelApp = vi.fn(async (key: string) => ({
  channelKey: key,
  environment: 'production' as const,
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUris: key === 'EBAY' ? ['Nexus-Test-RuName'] : [],
  extra: {},
  signingKey: null,
}))
vi.mock('./apps.service.js', () => ({ getChannelApp }))

// ── modules under test ───────────────────────────────────────────────────────

const { registerChannel, getChannelSpec, scopeDriftOf } = await import('./catalog.js')
const { ebaySpec, EBAY_REQUIRED_SCOPES } = await import('./connectors/ebay/spec.js')
const { decryptCredentials, encryptCredentials } = await import('../../lib/crypto.js')
const { start, complete, sweepSessions, callbackUrlFor, OAuthFlowError, SESSION_TTL_MS, COOKIE_PREFIX } = await import('./oauth.service.js')

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const EBAY_IDENTITY_URL = 'https://apiz.ebay.com/commerce/identity/v1/user/'
const FAKE_TOKEN_URL = 'https://token.fake.test/oauth/token'
const FAKE_AUTHORIZE_URL = 'https://auth.fake.test/oauth/authorize'

// A PKCE + body-auth channel with scope discovery, registered under ETSY.
registerChannel({
  key: 'ETSY',
  channelType: 'ETSY',
  displayName: 'Fake PKCE',
  available: true,
  auth: {
    mode: 'oauth2_pkce',
    authorizeUrl: () => FAKE_AUTHORIZE_URL,
    tokenUrl: () => FAKE_TOKEN_URL,
    authorizationParams: { response_type: 'code' },
    tokenParams: { extra_param: 'yes' },
    tokenRequestAuth: 'body',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    callbackMetadata: ['sellerId'],
    tokenResponseMetadata: ['token_type'],
    pkce: true,
    requiredScopes: ['read_a', 'write_b'],
    accessTokenLifetimeSec: 3600,
    refreshTokenLifetimeSec: 90 * 86_400,
    rotatesRefreshToken: true,
  },
  identity: async () => ({ userId: 'F1', username: 'fake-seller' }),
  heartbeat: async () => ({ ok: true, latencyMs: 1 }),
  discoverScopes: async () => [{ kind: 'shop', externalId: 'shop-1', label: 'Shop One', region: 'EU' }],
  rateLimit: { parse: () => null, model: 'token_bucket' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: 'fake-v1',
  sandbox: { available: false },
})
// A declared-but-unavailable channel.
registerChannel({
  key: 'SHOPIFY',
  channelType: 'SHOPIFY',
  displayName: 'Not Yet',
  available: false,
  auth: { mode: 'oauth2_code', authorizeUrl: () => 'https://x.test', tokenUrl: () => 'https://x.test', tokenRequestAuth: 'body', scopeSeparator: ',', codeParamInCallback: 'code', pkce: false, requiredScopes: [], rotatesRefreshToken: false },
  identity: async () => null,
  heartbeat: async () => ({ ok: true, latencyMs: 1 }),
  rateLimit: { parse: () => null, model: 'token_bucket' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: 'x',
  sandbox: { available: false },
})
// A channel with no browser consent flow at all.
registerChannel({
  key: 'AMAZON_ADS',
  channelType: 'AMAZON_ADS',
  displayName: 'Keyed',
  available: true,
  auth: { mode: 'api_key', tokenUrl: () => 'https://x.test', tokenRequestAuth: 'body', scopeSeparator: ',', codeParamInCallback: 'code', pkce: false, requiredScopes: [], rotatesRefreshToken: false },
  identity: async () => null,
  heartbeat: async () => ({ ok: true, latencyMs: 1 }),
  rateLimit: { parse: () => null, model: 'token_bucket' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: 'x',
  sandbox: { available: false },
})

// ── fetch routing ────────────────────────────────────────────────────────────

let tokenResponse: () => Response = () => json({ access_token: 'granted-access', refresh_token: 'granted-refresh', expires_in: 7200, refresh_token_expires_in: 47_304_000, token_type: 'User Access Token' })
let identityResponse: () => Response = () => json({ userId: 'U1', username: 'seller1' })
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  const u = String(url)
  if (u === EBAY_TOKEN_URL || u === FAKE_TOKEN_URL) return tokenResponse()
  if (u === EBAY_IDENTITY_URL) return identityResponse()
  throw new Error(`unexpected fetch ${u}`)
})
const exchangeCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === EBAY_TOKEN_URL || String(c[0]) === FAKE_TOKEN_URL)
const exchangeBody = () => new URLSearchParams(String(exchangeCalls()[0][1]?.body ?? ''))

// ── helpers ──────────────────────────────────────────────────────────────────

const ACTOR = { kind: 'operator' as const, userId: 'user-1' }
const eventsOf = (type: string) => events.filter((e) => e.type === type)

async function startEbay(extra: Partial<Parameters<typeof start>[0]> = {}) {
  return start({ channelKey: 'EBAY', intent: 'connect', actor: ACTOR, ...extra })
}
function cookiesFor(s: { cookie: { name: string; value: string } }) {
  return { [s.cookie.name]: s.cookie.value }
}
async function completeEbay(s: Awaited<ReturnType<typeof start>>, opts: { query?: Record<string, string | undefined>; cookies?: Record<string, string | undefined>; actorUserId?: string } = {}) {
  return complete({
    channelKey: 'EBAY',
    query: { state: s.state, code: 'the-auth-code', ...(opts.query ?? {}) },
    cookies: opts.cookies ?? cookiesFor(s),
    actorUserId: opts.actorUserId,
  })
}
async function flowError(p: Promise<unknown>): Promise<InstanceType<typeof OAuthFlowError>> {
  try {
    await p
  } catch (err) {
    if (err instanceof OAuthFlowError) return err
    throw err
  }
  throw new Error('expected an OAuthFlowError')
}
function seedConnection(row: Record<string, unknown>): string {
  const id = String(row.id ?? `seed-${++connSeq}`)
  connections.set(id, {
    id,
    channelType: 'EBAY',
    managedBy: 'oauth',
    isActive: true,
    authStatus: 'connected',
    displayName: 'Existing',
    grantedScopes: [],
    identity: null,
    consecutiveFailures: 0,
    region: 'GLOBAL',
    connectionMetadata: null,
    externalAccountId: null,
    credentialsEnc: null,
    accessToken: null,
    refreshToken: null,
    ebayAccessToken: null,
    ebayRefreshToken: null,
    tokenExpiresAt: null,
    ebayTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    ...row,
  })
  return id
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  await encryptCredentials({ warm: true }) // burn the once-per-process KMS-fallback notice
})
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  sessions.clear()
  connections.clear()
  connSeq = 0
  events.length = 0
  scopeUpserts.length = 0
  fetchMock.mockClear()
  prismaMock.channelConnection.create.mockClear()
  tokenResponse = () => json({ access_token: 'granted-access', refresh_token: 'granted-refresh', expires_in: 7200, refresh_token_expires_in: 47_304_000, token_type: 'User Access Token' })
  identityResponse = () => json({ userId: 'U1', username: 'seller1' })
})
afterEach(() => {
  delete process.env.NEXUS_OAUTH_COOKIE_ENFORCE
})

// ── start ────────────────────────────────────────────────────────────────────

describe('start', () => {
  it('mints an OAuthSession whose id is the state, with a 10-minute expiry and a cookie nonce', async () => {
    const before = Date.now()
    const s = await startEbay()
    expect(SESSION_TTL_MS).toBe(600_000)
    expect(s.expiresInSec).toBe(600)
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url
    const row = sessions.get(s.state)!
    expect(row).toBeTruthy()
    expect(row).toMatchObject({ channelKey: 'EBAY', intent: 'connect', targetConnectionId: null, startedByUserId: 'user-1', codeVerifier: null, redirectUri: 'Nexus-Test-RuName', region: 'GLOBAL' })
    expect(row.cookieNonce).toBe(s.cookie.value)
    const exp = (row.expiresAt as Date).getTime()
    expect(exp).toBeGreaterThanOrEqual(before + SESSION_TTL_MS)
    expect(exp).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS)
  })

  it('the cookie is named nexus_oauth_<state> and lives as long as the session', async () => {
    const s = await startEbay()
    expect(COOKIE_PREFIX).toBe('nexus_oauth_')
    expect(s.cookie.name).toBe(`nexus_oauth_${s.state}`)
    expect(s.cookie.maxAgeSec).toBe(600)
    expect(s.cookie.value).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('the eBay authorize URL carries client_id, the RuName, all 22 scopes, state, response_type and prompt=login — no PKCE', async () => {
    const s = await startEbay()
    const url = new URL(s.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.ebay.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('Nexus-Test-RuName')
    expect(url.searchParams.get('state')).toBe(s.state)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('prompt')).toBe('login')
    expect(EBAY_REQUIRED_SCOPES).toHaveLength(22)
    expect(url.searchParams.get('scope')).toBe(EBAY_REQUIRED_SCOPES.join(' '))
    expect(url.searchParams.get('scope')!.split(' ')).toHaveLength(22)
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
    expect(ebaySpec.auth.promptParam).toEqual({ prompt: 'login' })
  })

  it('every start gets a fresh state and nonce', async () => {
    const a = await startEbay()
    const b = await startEbay()
    expect(a.state).not.toBe(b.state)
    expect(a.cookie.value).not.toBe(b.cookie.value)
    expect(sessions.size).toBe(2)
  })

  it('a PKCE channel gets code_challenge = S256(verifier) and the verifier is kept server-side only', async () => {
    const s = await start({ channelKey: 'ETSY', intent: 'connect', actor: ACTOR })
    const url = new URL(s.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe(FAKE_AUTHORIZE_URL)
    const verifier = sessions.get(s.state)!.codeVerifier as string
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/) // 48 random bytes
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(s.authorizeUrl).not.toContain(verifier)
    expect(url.searchParams.get('scope')).toBe('read_a write_b')
    expect(url.searchParams.has('prompt')).toBe(false)
  })

  it('a channel without a RuName gets the API callback URL as redirect_uri', async () => {
    const s = await start({ channelKey: 'ETSY', intent: 'connect', actor: ACTOR })
    const url = new URL(s.authorizeUrl)
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/cx/callback/etsy')
    expect(sessions.get(s.state)!.redirectUri).toBe('https://api.example.test/api/cx/callback/etsy')
  })

  it('sandbox environment points at auth.sandbox.ebay.com', async () => {
    const s = await startEbay({ environment: 'sandbox' })
    expect(s.authorizeUrl.startsWith('https://auth.sandbox.ebay.com/oauth2/authorize?')).toBe(true)
    expect(getChannelApp).toHaveBeenLastCalledWith('EBAY', 'sandbox')
  })

  it('reconnect/adopt need a target; the target must belong to the channel', async () => {
    expect((await flowError(startEbay({ intent: 'reconnect' }))).code).toBe('invalid_intent')
    expect((await flowError(startEbay({ intent: 'adopt' }))).code).toBe('invalid_intent')
    seedConnection({ id: 'amz', channelType: 'AMAZON' })
    expect((await flowError(startEbay({ intent: 'adopt', targetConnectionId: 'amz' }))).code).toBe('invalid_intent')
    expect((await flowError(startEbay({ intent: 'reconnect', targetConnectionId: 'ghost' }))).code).toBe('invalid_intent')
    seedConnection({ id: 'e1' })
    const s = await startEbay({ intent: 'reconnect', targetConnectionId: 'e1' })
    expect(sessions.get(s.state)).toMatchObject({ intent: 'reconnect', targetConnectionId: 'e1' })
  })

  it('refuses an unavailable channel and a channel without a consent URL', async () => {
    expect((await flowError(start({ channelKey: 'SHOPIFY', intent: 'connect', actor: ACTOR }))).code).toBe('channel_unavailable')
    expect((await flowError(start({ channelKey: 'AMAZON_ADS', intent: 'connect', actor: ACTOR }))).code).toBe('invalid_intent')
    expect(sessions.size).toBe(0)
  })

  it('an unregistered channel key throws from the catalogue', async () => {
    await expect(start({ channelKey: 'AMAZON_SP', intent: 'connect', actor: ACTOR })).rejects.toThrow(/No ChannelSpec registered/)
  })
})

// ── complete ─────────────────────────────────────────────────────────────────

describe('complete — session checks', () => {
  it('rejects a callback without state', async () => {
    const err = await flowError(complete({ channelKey: 'EBAY', query: { code: 'x' }, cookies: {} }))
    expect(err.code).toBe('state_missing')
    expect(err.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a state this server never minted, before any exchange', async () => {
    const err = await flowError(complete({ channelKey: 'EBAY', query: { state: 'not-ours', code: 'x' }, cookies: {} }))
    expect(err.code).toBe('state_unknown')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a state minted for another channel', async () => {
    const s = await start({ channelKey: 'ETSY', intent: 'connect', actor: ACTOR })
    const err = await flowError(complete({ channelKey: 'EBAY', query: { state: s.state, code: 'x' }, cookies: cookiesFor(s) }))
    expect(err.code).toBe('state_unknown')
    expect(sessions.get(s.state)!.consumedAt).toBeNull() // the wrong-channel UPDATE matched nothing
  })

  it('a state is single-use: the second completion is state_consumed and exchanges nothing', async () => {
    const s = await startEbay()
    await completeEbay(s)
    expect(exchangeCalls()).toHaveLength(1)
    const err = await flowError(completeEbay(s))
    expect(err.code).toBe('state_consumed')
    expect(exchangeCalls()).toHaveLength(1)
  })

  it('a failed completion also consumes the state', async () => {
    const s = await startEbay()
    expect((await flowError(completeEbay(s, { query: { error: 'access_denied' } }))).code).toBe('provider_error')
    expect((await flowError(completeEbay(s))).code).toBe('state_consumed')
  })

  it('rejects an expired session and marks the error on it', async () => {
    const s = await startEbay()
    sessions.get(s.state)!.expiresAt = new Date(Date.now() - 1000)
    const err = await flowError(completeEbay(s))
    expect(err.code).toBe('state_expired')
    expect(String(sessions.get(s.state)!.error)).toMatch(/^state_expired:/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a missing cookie when enforcement is on (the default) and writes a ledger row', async () => {
    const s = await startEbay()
    const err = await flowError(completeEbay(s, { cookies: {} }))
    expect(err.code).toBe('state_cookie_missing')
    expect(fetchMock).not.toHaveBeenCalled()
    const note = eventsOf('status_change').find((e) => (e.detail as Record<string, unknown>).oauth === 'state_cookie_missing')
    expect(note?.detail).toMatchObject({ enforced: true })
  })

  it('accepts a missing cookie when NEXUS_OAUTH_COOKIE_ENFORCE=0, still noting it in the ledger', async () => {
    process.env.NEXUS_OAUTH_COOKIE_ENFORCE = '0'
    const s = await startEbay()
    const r = await completeEbay(s, { cookies: {} })
    expect(r.placement).toBe('new')
    const note = eventsOf('status_change').find((e) => (e.detail as Record<string, unknown>).oauth === 'state_cookie_missing')
    expect(note?.detail).toMatchObject({ enforced: false })
  })

  it('a cookie with the wrong nonce is rejected even with enforcement off', async () => {
    process.env.NEXUS_OAUTH_COOKIE_ENFORCE = '0'
    const s = await startEbay()
    const err = await flowError(completeEbay(s, { cookies: { [s.cookie.name]: 'someone-elses-nonce' } }))
    expect(err.code).toBe('state_cookie_mismatch')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('error=access_denied from the channel is a clear provider_error without any exchange', async () => {
    const s = await startEbay()
    const err = await flowError(completeEbay(s, { query: { error: 'access_denied', error_description: 'The user declined', code: undefined } }))
    expect(err.code).toBe('provider_error')
    expect(err.status).toBe(400)
    expect(err.message).toContain('eBay declined the authorisation: The user declined')
    expect(err.detail).toEqual({ providerError: 'access_denied', providerDescription: 'The user declined' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(String(sessions.get(s.state)!.error)).toMatch(/^provider_error:/)
  })

  it('a callback without a code is code_missing', async () => {
    const s = await startEbay()
    const err = await flowError(completeEbay(s, { query: { code: undefined } }))
    expect(err.code).toBe('code_missing')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('complete — exchange', () => {
  it('exchanges the code with Basic app auth, the session redirect_uri and no code_verifier for eBay', async () => {
    const s = await startEbay()
    await completeEbay(s)
    const [url, init] = exchangeCalls()[0]
    expect(String(url)).toBe(EBAY_TOKEN_URL)
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`)
    const body = exchangeBody()
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-auth-code')
    expect(body.get('redirect_uri')).toBe('Nexus-Test-RuName')
    expect(body.has('code_verifier')).toBe(false)
    expect(body.has('client_secret')).toBe(false)
  })

  it('sends the stored code_verifier (and body auth + tokenParams) for a PKCE channel', async () => {
    const s = await start({ channelKey: 'ETSY', intent: 'connect', actor: ACTOR })
    const verifier = sessions.get(s.state)!.codeVerifier as string
    const r = await complete({ channelKey: 'ETSY', query: { state: s.state, code: 'c', sellerId: 'S-77' }, cookies: cookiesFor(s) })
    const [, init] = exchangeCalls()[0]
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
    const body = exchangeBody()
    expect(body.get('code_verifier')).toBe(verifier)
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('client_secret')).toBe('test-client-secret')
    expect(body.get('extra_param')).toBe('yes')
    expect(body.get('redirect_uri')).toBe('https://api.example.test/api/cx/callback/etsy')
    // tokenResponseMetadata + callbackMetadata land in the envelope's `extra`.
    const creds = await decryptCredentials(connections.get(r.connectionId)!.credentialsEnc as string)
    expect(creds.extra).toEqual({ token_type: 'User Access Token', sellerId: 'S-77' })
    // discoverScopes → ConnectionScope upsert.
    expect(scopeUpserts).toHaveLength(1)
    expect(scopeUpserts[0]).toMatchObject({
      where: { connectionId_kind_externalId: { connectionId: r.connectionId, kind: 'shop', externalId: 'shop-1' } },
      create: { connectionId: r.connectionId, kind: 'shop', externalId: 'shop-1', label: 'Shop One', region: 'EU', isActive: true },
    })
    expect(r.identity).toEqual({ userId: 'F1', username: 'fake-seller' })
  })

  it('a rejected code is exchange_failed with a 502 and the status in the detail', async () => {
    tokenResponse = () => json({ error: 'invalid_grant' }, 400)
    const s = await startEbay()
    const err = await flowError(completeEbay(s))
    expect(err.code).toBe('exchange_failed')
    expect(err.status).toBe(502)
    expect(err.detail).toMatchObject({ status: 400 })
    expect(connections.size).toBe(0)
  })

  it('an unreachable token endpoint is exchange_failed 502', async () => {
    tokenResponse = () => { throw new Error('ECONNREFUSED') }
    const s = await startEbay()
    const err = await flowError(completeEbay(s))
    expect(err.code).toBe('exchange_failed')
    expect(err.status).toBe(502)
    expect(err.message).toContain("Could not reach eBay's token endpoint")
  })

  it('a 200 with no access_token is exchange_failed', async () => {
    tokenResponse = () => json({ token_type: 'bearer' })
    const s = await startEbay()
    expect((await flowError(completeEbay(s))).code).toBe('exchange_failed')
  })
})

describe('complete — placement and storage', () => {
  it('new account: creates the row, stores the grant, records grant + status_change, returns the result shape', async () => {
    const s = await startEbay()
    const r = await completeEbay(s)
    expect(r).toEqual({
      connectionId: 'conn-1',
      placement: 'new',
      identity: { userId: 'U1', username: 'seller1' },
      grantedScopes: EBAY_REQUIRED_SCOPES,
      scopeDrift: [],
      channelKey: 'EBAY',
    })
    expect(prismaMock.channelConnection.create).toHaveBeenCalledWith({
      data: { channelType: 'EBAY', managedBy: 'oauth', isActive: false, authStatus: 'unknown', region: 'GLOBAL' },
      select: { id: true },
    })
    const row = connections.get('conn-1')!
    expect(row).toMatchObject({ isActive: true, managedBy: 'oauth', authStatus: 'connected', externalAccountId: 'U1', displayName: 'seller1', ebaySignInName: 'seller1', region: 'GLOBAL', apiVersion: ebaySpec.apiVersion })
    expect(row.grantedScopes).toEqual(EBAY_REQUIRED_SCOPES)
    expect(row.identity).toEqual({ userId: 'U1', username: 'seller1' })
    expect([row.accessToken, row.refreshToken, row.ebayAccessToken, row.ebayRefreshToken]).toEqual([null, null, null, null])
    const creds = await decryptCredentials(row.credentialsEnc as string)
    expect(creds.accessToken).toBe('granted-access')
    expect(creds.refreshToken).toBe('granted-refresh')
    // eBay reports refresh_token_expires_in → refreshTokenExpiresAt ≈ now + 18 months.
    const rtExp = Date.parse(String(creds.refreshTokenExpiresAt))
    expect(rtExp).toBeGreaterThan(Date.now() + 47_000_000 * 1000)
    expect(eventsOf('grant')).toHaveLength(1)
    expect(eventsOf('grant')[0]).toMatchObject({ connectionId: 'conn-1', channelKey: 'EBAY', actorUserId: 'user-1' })
    expect(eventsOf('grant')[0].detail).toMatchObject({ scopes: 22, identity: 'seller1', actorKind: 'operator' })
    expect(eventsOf('status_change').find((e) => e.connectionId === 'conn-1')?.detail).toMatchObject({ from: 'unknown', to: 'connected', reason: 'grant' })
    expect(eventsOf('scope_drift')).toHaveLength(0)
    expect(sessions.get(s.state)).toMatchObject({ resultConnectionId: 'conn-1' })
    expect(sessions.get(s.state)!.consumedAt).toBeInstanceOf(Date)
  })

  it('the identity probe used the fresh access token before any row existed', async () => {
    const s = await startEbay()
    await completeEbay(s)
    const idCall = fetchMock.mock.calls.find((c) => String(c[0]) === EBAY_IDENTITY_URL)!
    expect((idCall[1]?.headers as Record<string, string>).Authorization).toBe('Bearer granted-access')
  })

  it('re-consent: an active row already carrying the identity absorbs the grant', async () => {
    seedConnection({ id: 'existing', externalAccountId: 'U1', authStatus: 'needs_reauth', consecutiveFailures: 7 })
    const s = await startEbay()
    const r = await completeEbay(s)
    expect(r.placement).toBe('reconsent')
    expect(r.connectionId).toBe('existing')
    expect(prismaMock.channelConnection.create).not.toHaveBeenCalled()
    expect(connections.get('existing')).toMatchObject({ authStatus: 'connected', consecutiveFailures: 0 })
    expect(eventsOf('reconsent')).toHaveLength(1)
    expect(eventsOf('status_change').find((e) => e.connectionId === 'existing')?.detail).toMatchObject({ from: 'needs_reauth', to: 'connected', reason: 'reconsent' })
  })

  it('adopt: the operator named the unidentified row that owns the data', async () => {
    seedConnection({ id: 'legacy', externalAccountId: null })
    const s = await startEbay({ intent: 'adopt', targetConnectionId: 'legacy' })
    identityResponse = () => json({ userId: 'U9', username: 'seller9' })
    const r = await completeEbay(s)
    expect(r).toMatchObject({ placement: 'adopt', connectionId: 'legacy' })
    expect(connections.get('legacy')).toMatchObject({ externalAccountId: 'U9', displayName: 'seller9' })
    expect(eventsOf('adopt')).toHaveLength(1)
  })

  it('an identity refusal surfaces as identity_refused 409 with the MAP code, and no row is created', async () => {
    seedConnection({ id: 'legacy', externalAccountId: null })
    const s = await startEbay()
    const err = await flowError(completeEbay(s))
    expect(err.code).toBe('identity_refused')
    expect(err.status).toBe(409)
    expect(err.detail).toEqual({ code: 'IDENTITY_UNMATCHED', identity: 'seller1' })
    expect(prismaMock.channelConnection.create).not.toHaveBeenCalled()
    expect(String(sessions.get(s.state)!.error)).toMatch(/^identity_refused:/)
  })

  it('an identity lookup failure is tolerated: the grant still lands (as a new row when nothing is ambiguous)', async () => {
    identityResponse = () => new Response('boom', { status: 500 })
    const s = await startEbay()
    const r = await completeEbay(s)
    expect(r.placement).toBe('new')
    expect(r.identity).toBeNull()
    expect(connections.get(r.connectionId)!.externalAccountId).toBeNull()
  })

  it('the actor on the ledger falls back to whoever started the session', async () => {
    const s = await startEbay()
    await completeEbay(s, { actorUserId: undefined })
    expect(eventsOf('grant')[0].actorUserId).toBe('user-1')
    identityResponse = () => json({ userId: 'U2', username: 'seller2' }) // a different seller, so this is a second grant, not a re-consent
    const s2 = await startEbay()
    await completeEbay(s2, { actorUserId: 'user-2' })
    expect(eventsOf('grant')).toHaveLength(2)
    expect(eventsOf('grant')[1].actorUserId).toBe('user-2')
  })

  it('records scope_drift when the channel echoes fewer scopes than we asked for', async () => {
    const S = 'https://api.ebay.com/oauth/api_scope'
    const granted = [S, `${S}/sell.inventory`]
    tokenResponse = () => json({ access_token: 'granted-access', refresh_token: 'granted-refresh', expires_in: 7200, scope: granted.join(' ') })
    const s = await startEbay()
    const r = await completeEbay(s)
    const expected = scopeDriftOf(ebaySpec, granted)
    expect(expected).toHaveLength(19) // 22 − 2 granted − the implied sell.inventory.readonly
    expect(r.grantedScopes).toEqual(granted)
    expect(r.scopeDrift).toEqual(expected)
    expect(eventsOf('scope_drift')).toHaveLength(1)
    expect(eventsOf('scope_drift')[0]).toMatchObject({ connectionId: r.connectionId, channelKey: 'EBAY' })
    expect(eventsOf('scope_drift')[0].detail).toMatchObject({ missing: expected })
    expect(connections.get(r.connectionId)!.grantedScopes).toEqual(granted)
  })

  it('no ledger row carries the token material', async () => {
    const s = await startEbay()
    await completeEbay(s)
    const all = JSON.stringify(events)
    expect(all).not.toContain('granted-access')
    expect(all).not.toContain('granted-refresh')
    expect(all).not.toContain('the-auth-code')
  })
})

describe('sweepSessions / callbackUrlFor', () => {
  it('deletes sessions that expired more than 24 h ago and keeps the rest', async () => {
    const a = await startEbay()
    const b = await startEbay()
    const c = await startEbay()
    sessions.get(a.state)!.expiresAt = new Date(Date.now() - 25 * 3_600_000)
    sessions.get(b.state)!.expiresAt = new Date(Date.now() - 23 * 3_600_000)
    await expect(sweepSessions()).resolves.toBe(1)
    expect(sessions.has(a.state)).toBe(false)
    expect(sessions.has(b.state)).toBe(true)
    expect(sessions.has(c.state)).toBe(true)
  })

  it('callbackUrlFor is the API host (trailing slash stripped) + a lower-cased channel key', () => {
    expect(callbackUrlFor('EBAY')).toBe('https://api.example.test/api/cx/callback/ebay')
    expect(callbackUrlFor('AMAZON_SP')).toBe('https://api.example.test/api/cx/callback/amazon_sp')
  })

  it('getChannelSpec(EBAY) is the real catalogue entry the flow ran against', () => {
    expect(getChannelSpec('EBAY')).toBe(ebaySpec)
  })
})

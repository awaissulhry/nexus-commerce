/**
 * CX.1 — the token service: refresh thresholds, the authStatus state machine,
 * the lease + in-flight collapse, the rotation rule and envelope-first reads.
 *
 * No network, no DB: prisma is an in-memory fake exposing only what the service
 * calls; `fetch` is stubbed; crypto runs in env mode (v1 envelope) under a
 * throwaway NEXUS_CREDENTIAL_ENC_KEY so the blobs written are real and can be
 * decrypted back by the test. Token values are test fixtures, never printed.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

// ── in-memory prisma ─────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string }
const rows = new Map<string, Row>()
const updates: Array<{ id: string; data: Record<string, unknown> }> = []
const events: Array<Record<string, unknown>> = []
/** Queue of results for the lease-acquire UPDATE; empty queue = 1 (acquired). */
const acquireResults: number[] = []
let acquireCalls = 0
let releaseCalls = 0

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row }
  const out: Row = { id: row.id }
  for (const k of Object.keys(select)) out[k] = row[k]
  return out
}

const prismaMock = {
  channelConnection: {
    findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const r = rows.get(where.id)
      return r ? pick(r, select) : null
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.get(where.id)
      if (!r) throw new Error(`fake prisma: no row ${where.id}`)
      for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v
      updates.push({ id: where.id, data })
      return { ...r }
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; credentialsEnc?: null }; data: Record<string, unknown> }) => {
      const r = rows.get(where.id)
      if (!r || ('credentialsEnc' in where && r.credentialsEnc !== null)) return { count: 0 }
      for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v
      updates.push({ id: where.id, data })
      return { count: 1 }
    }),
  },
  connectionEvent: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      events.push(data)
      return data
    }),
  },
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    if (sql.includes('make_interval')) {
      acquireCalls++
      return acquireResults.length ? acquireResults.shift()! : 1
    }
    releaseCalls++
    return 1
  }),
}

vi.mock('../../db.js', () => ({ default: prismaMock }))

const createAlert = vi.fn(async () => ({}))
vi.mock('../monitoring/alert.service.js', () => ({
  alertService: { createAlert },
  AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' },
}))

vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>()
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

const getChannelApp = vi.fn(async () => ({
  channelKey: 'EBAY' as const,
  environment: 'production' as const,
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUris: ['Nexus-Test-RuName'],
  extra: {},
  signingKey: null,
}))
vi.mock('./apps.service.js', () => ({ getChannelApp }))

// ── modules under test (imported after the mocks are wired) ─────────────────

const { registerChannel } = await import('./catalog.js')
const { encryptCredentials, decryptCredentials, isCredentialsBlob } = await import('../../lib/crypto.js')
const tokenService = await import('./token.service.js')
const {
  getAccessToken,
  refreshNow,
  transition,
  storeGrant,
  revoke,
  assertWritable,
  handleOf,
  encryptLegacyRow,
  RefreshFailed,
  ConnectionNeedsReauth,
  __tokenTest,
} = tokenService

const TOKEN_URL = 'https://token.test/identity/v1/oauth2/token'
const REVOKE_URL = 'https://token.test/identity/v1/oauth2/token/revoke'
const REFRESH_LIFE_SEC = 47_304_000

registerChannel({
  key: 'EBAY',
  channelType: 'EBAY',
  displayName: 'eBay (test)',
  available: true,
  auth: {
    mode: 'oauth2_code',
    authorizeUrl: () => 'https://auth.test/oauth2/authorize',
    tokenUrl: () => TOKEN_URL,
    revokeUrl: () => REVOKE_URL,
    tokenRequestAuth: 'basic',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: false,
    requiredScopes: ['s1', 's2'],
    accessTokenLifetimeSec: 7200,
    refreshTokenLifetimeSec: REFRESH_LIFE_SEC,
    rotatesRefreshToken: false,
  },
  defaultRegion: 'GLOBAL',
  identity: async () => null,
  heartbeat: async () => ({ ok: true, latencyMs: 1 }),
  rateLimit: { parse: () => null, model: 'daily_quota' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: 'test-v1',
  sandbox: { available: false },
  tokenExpirationBufferSec: 600,
})

// ── fixtures ─────────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const past = () => new Date(Date.now() - HOUR)
const future = (h = 2) => new Date(Date.now() + h * HOUR)

type Creds = { accessToken: string; refreshToken?: string | null; accessTokenExpiresAt?: string | null; refreshTokenExpiresAt?: string | null }

let seq = 0
async function seedRow(opts: { creds?: Creds | null; plaintext?: Record<string, unknown>; row?: Record<string, unknown> } = {}): Promise<string> {
  const id = `conn-${++seq}`
  const creds = opts.creds === undefined
    ? { accessToken: 'old-access', refreshToken: 'old-refresh', accessTokenExpiresAt: past().toISOString(), refreshTokenExpiresAt: future(24 * 300).toISOString() }
    : opts.creds
  const blob = creds ? (await encryptCredentials(creds as Record<string, unknown>)).blob : null
  rows.set(id, {
    id,
    channelType: 'EBAY',
    managedBy: 'oauth',
    authStatus: 'connected',
    displayName: 'Test Shop',
    consecutiveFailures: 0,
    region: 'GLOBAL',
    connectionMetadata: null,
    grantedScopes: ['s1', 's2'],
    identity: null,
    credentialsEnc: blob,
    credentialsKeyId: blob ? 'env' : null,
    accessToken: null,
    refreshToken: null,
    ebayAccessToken: null,
    ebayRefreshToken: null,
    tokenExpiresAt: null,
    ebayTokenExpiresAt: null,
    accessTokenExpiresAt: creds?.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
    refreshTokenExpiresAt: creds?.refreshTokenExpiresAt ? new Date(creds.refreshTokenExpiresAt) : null,
    refreshLeaseUntil: null,
    refreshLeaseOwner: null,
    lastRefreshAt: null,
    lastError: null,
    lastErrorAt: null,
    isActive: true,
    isPrimary: false,
    ...(opts.plaintext ?? {}),
    ...(opts.row ?? {}),
  })
  return id
}

async function credsOf(id: string): Promise<Creds> {
  const blob = rows.get(id)!.credentialsEnc as string
  expect(isCredentialsBlob(blob)).toBe(true)
  return (await decryptCredentials(blob)) as Creds
}

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>()
function lastExchange(): URLSearchParams {
  const call = fetchMock.mock.calls.at(-1)!
  return new URLSearchParams(String(call[1]?.body ?? ''))
}
const eventsOf = (type: string, id?: string) => events.filter((e) => e.type === type && (id === undefined || e.connectionId === id))
const alertTitles = () => createAlert.mock.calls.map((c) => String((c as unknown[])[1]))
const statusUpdates = (id: string) => updates.filter((u) => u.id === id && 'authStatus' in u.data).map((u) => u.data.authStatus)

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  // The first env-mode encrypt fires the once-per-process KMS-fallback notice
  // (a SYSTEM ledger row + an alert). Burn it here so per-test counts are clean.
  await encryptCredentials({ warm: true })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  rows.clear()
  updates.length = 0
  events.length = 0
  acquireResults.length = 0
  acquireCalls = 0
  releaseCalls = 0
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => tokenResponse({ access_token: 'new-access', expires_in: 7200, token_type: 'User Access Token' }))
  createAlert.mockClear()
  __tokenTest.clearInflight()
})

// ── (a) failure thresholds ───────────────────────────────────────────────────

describe('failRefresh thresholds', () => {
  async function failOnce(id: string, status = 500, body = 'boom'): Promise<InstanceType<typeof RefreshFailed>> {
    fetchMock.mockImplementationOnce(async () => new Response(body, { status }))
    try {
      await getAccessToken(id)
    } catch (err) {
      if (err instanceof RefreshFailed) return err
      throw err
    }
    throw new Error('expected the refresh to fail')
  }

  it('failure 1 keeps the status, increments consecutiveFailures, writes refresh_failed', async () => {
    const id = await seedRow()
    const err = await failOnce(id)
    expect(err.errorClass).toBe('transient')
    expect(rows.get(id)!.consecutiveFailures).toBe(1)
    expect(rows.get(id)!.authStatus).toBe('connected')
    expect(String(rows.get(id)!.lastError)).toMatch(/^transient: Token endpoint 500/)
    expect(statusUpdates(id)).toEqual([])
    expect(eventsOf('refresh_failed', id)).toHaveLength(1)
    expect((eventsOf('refresh_failed', id)[0].detail as Record<string, unknown>).failures).toBe(1)
    expect(eventsOf('status_change', id)).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('failure 2 still keeps the status', async () => {
    const id = await seedRow({ row: { consecutiveFailures: 1 } })
    await failOnce(id)
    expect(rows.get(id)!.consecutiveFailures).toBe(2)
    expect(rows.get(id)!.authStatus).toBe('connected')
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('failure 3 → degraded, with a status_change row and one alert', async () => {
    const id = await seedRow({ row: { consecutiveFailures: 2 } })
    await failOnce(id)
    expect(rows.get(id)!.consecutiveFailures).toBe(3)
    expect(rows.get(id)!.authStatus).toBe('degraded')
    const sc = eventsOf('status_change', id)
    expect(sc).toHaveLength(1)
    expect(sc[0].detail).toMatchObject({ from: 'connected', to: 'degraded' })
    expect(alertTitles()).toEqual([expect.stringContaining('is degraded')])
  })

  it('failures 4–9 stay degraded without re-alerting', async () => {
    const id = await seedRow({ row: { consecutiveFailures: 5, authStatus: 'degraded' } })
    await failOnce(id)
    expect(rows.get(id)!.consecutiveFailures).toBe(6)
    expect(rows.get(id)!.authStatus).toBe('degraded')
    expect(eventsOf('status_change', id)).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('failure 10 → needs_reauth with a "needs reconnecting" alert', async () => {
    const id = await seedRow({ row: { consecutiveFailures: 9, authStatus: 'degraded' } })
    await failOnce(id)
    expect(rows.get(id)!.consecutiveFailures).toBe(10)
    expect(rows.get(id)!.authStatus).toBe('needs_reauth')
    expect(eventsOf('status_change', id)[0].detail).toMatchObject({ from: 'degraded', to: 'needs_reauth' })
    expect(alertTitles()).toEqual([expect.stringContaining('needs reconnecting')])
    await expect(assertWritable(id)).rejects.toBeInstanceOf(ConnectionNeedsReauth)
  })

  it('auth_revoked (401 invalid_grant) → needs_reauth on the very first failure', async () => {
    const id = await seedRow()
    const err = await failOnce(id, 401, '{"error":"invalid_grant"}')
    expect(err.errorClass).toBe('auth_revoked')
    expect(rows.get(id)!.consecutiveFailures).toBe(1)
    expect(rows.get(id)!.authStatus).toBe('needs_reauth')
    expect(alertTitles()).toEqual([expect.stringContaining('needs reconnecting')])
  })

  it('auth_expired (body says expired) → needs_reauth immediately too', async () => {
    const id = await seedRow()
    const err = await failOnce(id, 400, '{"error":"invalid_token","error_description":"refresh token expired"}')
    expect(err.errorClass).toBe('auth_expired')
    expect(rows.get(id)!.authStatus).toBe('needs_reauth')
  })

  it('an expired refresh token is refused locally — no token-endpoint call — and → needs_reauth', async () => {
    const id = await seedRow({
      creds: { accessToken: 'old-access', refreshToken: 'old-refresh', accessTokenExpiresAt: past().toISOString(), refreshTokenExpiresAt: past().toISOString() },
    })
    await expect(getAccessToken(id)).rejects.toMatchObject({ code: 'REFRESH_FAILED', errorClass: 'auth_expired' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rows.get(id)!.authStatus).toBe('needs_reauth')
  })

  it('no refresh token stored → auth_expired without a network call', async () => {
    const id = await seedRow({ creds: { accessToken: 'old-access', refreshToken: null, accessTokenExpiresAt: past().toISOString() } })
    await expect(getAccessToken(id)).rejects.toMatchObject({ errorClass: 'auth_expired' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rows.get(id)!.authStatus).toBe('needs_reauth')
  })

  it('a network error is classed network and does not flip the status on its own', async () => {
    const id = await seedRow()
    fetchMock.mockImplementationOnce(async () => { throw new Error('ECONNRESET') })
    await expect(getAccessToken(id)).rejects.toMatchObject({ errorClass: 'network' })
    expect(rows.get(id)!.consecutiveFailures).toBe(1)
    expect(rows.get(id)!.authStatus).toBe('connected')
  })

  it('after a failure the connection cools down: the next call is refused without a fetch', async () => {
    const id = await seedRow()
    await failOnce(id)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(getAccessToken(id)).rejects.toThrow(/cooling down/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // forceRefresh bypasses the cooldown.
    await expect(getAccessToken(id, { forceRefresh: true })).resolves.toBe('new-access')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the lease is released even when the refresh fails', async () => {
    const id = await seedRow()
    await failOnce(id)
    expect(acquireCalls).toBe(1)
    expect(releaseCalls).toBe(1)
  })
})

// ── (b) transition ───────────────────────────────────────────────────────────

describe('transition', () => {
  const row = (authStatus: string, id = 'row-t') => {
    rows.set(id, { id, channelType: 'EBAY', authStatus, displayName: 'Shop T' })
    return { id, channelType: 'EBAY', authStatus, displayName: 'Shop T' }
  }

  it('same status → no update, no event, no alert', async () => {
    await transition(row('connected'), 'connected', 'noop')
    expect(updates).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('connected → degraded: update + status_change event + "degraded" alert', async () => {
    await transition(row('connected'), 'degraded', 'three failures')
    expect(rows.get('row-t')!.authStatus).toBe('degraded')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ connectionId: 'row-t', channelKey: 'EBAY', type: 'status_change' })
    expect(events[0].detail).toMatchObject({ from: 'connected', to: 'degraded', reason: 'three failures', actorKind: 'system' })
    expect(createAlert).toHaveBeenCalledTimes(1)
    expect(alertTitles()[0]).toBe('EBAY account "Shop T" is degraded')
  })

  it('→ needs_reauth alerts that writes are paused, scoped to the connection id', async () => {
    await transition(row('degraded'), 'needs_reauth', 'ten failures')
    expect(createAlert).toHaveBeenCalledTimes(1)
    const [type, title, body, , ids] = createAlert.mock.calls[0] as unknown as [string, string, string, number, string[]]
    expect(type).toBe('CONNECTION_HEALTH')
    expect(title).toBe('EBAY account "Shop T" needs reconnecting')
    expect(body).toMatch(/Writes to this account are paused/)
    expect(ids).toEqual(['row-t'])
  })

  it('degraded → connected raises a "recovered" alert', async () => {
    await transition(row('degraded'), 'connected', 'heartbeat ok')
    expect(alertTitles()).toEqual(['EBAY account "Shop T" recovered'])
  })

  it('needs_reauth → connected raises a "recovered" alert', async () => {
    await transition(row('needs_reauth'), 'connected', 'new grant')
    expect(alertTitles()).toEqual(['EBAY account "Shop T" recovered'])
  })

  it('unknown → connected writes the event but no alert (nothing to recover from)', async () => {
    await transition(row('unknown'), 'connected', 'first heartbeat')
    expect(rows.get('row-t')!.authStatus).toBe('connected')
    expect(events).toHaveLength(1)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('terminal states (revoked / disconnected) ignore degraded and needs_reauth', async () => {
    await transition(row('revoked'), 'degraded', 'x')
    await transition(row('revoked'), 'needs_reauth', 'x')
    await transition(row('disconnected'), 'degraded', 'x')
    expect(updates).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('terminal states can still be left by a new grant (→ connected) or flipped between each other', async () => {
    await transition(row('revoked'), 'connected', 'grant')
    expect(rows.get('row-t')!.authStatus).toBe('connected')
    await transition(row('disconnected', 'row-u'), 'revoked', 'channel said so')
    expect(rows.get('row-u')!.authStatus).toBe('revoked')
    expect(events).toHaveLength(2)
  })

  it('records the actor on the event', async () => {
    await transition(row('connected'), 'degraded', 'x', { kind: 'operator', userId: 'user-9' })
    expect(events[0]).toMatchObject({ actorUserId: 'user-9' })
    expect(events[0].detail).toMatchObject({ actorKind: 'operator' })
  })

  it('falls back to the id as the label when displayName is null', async () => {
    rows.set('row-n', { id: 'row-n', channelType: 'EBAY', authStatus: 'connected', displayName: null })
    await transition({ id: 'row-n', channelType: 'EBAY', authStatus: 'connected', displayName: null }, 'degraded', 'x')
    expect(alertTitles()[0]).toBe('EBAY account "row-n" is degraded')
  })
})

// ── (c) lease concurrency ────────────────────────────────────────────────────

describe('refresh under the lease', () => {
  it('a valid token is returned without touching the lease or the network', async () => {
    const id = await seedRow({ creds: { accessToken: 'live-access', refreshToken: 'r', accessTokenExpiresAt: future().toISOString() } })
    await expect(getAccessToken(id)).resolves.toBe('live-access')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(acquireCalls).toBe(0)
  })

  it('a token inside the buffer window (10 min) is refreshed even though it has not expired', async () => {
    const id = await seedRow({ creds: { accessToken: 'nearly', refreshToken: 'r', accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } })
    await expect(getAccessToken(id)).resolves.toBe('new-access')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('two concurrent callers on an expired token → ONE refresh, both get the new token', async () => {
    const id = await seedRow()
    acquireResults.push(1, 0, 0)
    const [a, b] = await Promise.all([getAccessToken(id), getAccessToken(id)])
    expect(a).toBe('new-access')
    expect(b).toBe('new-access')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(acquireCalls).toBe(1) // the in-flight map collapsed the second caller before the lease
    expect(releaseCalls).toBe(1)
    expect(eventsOf('refresh', id)).toHaveLength(1)
    expect((await credsOf(id)).accessToken).toBe('new-access')
  })

  it('five concurrent callers still cost one refresh', async () => {
    const id = await seedRow()
    const all = await Promise.all(Array.from({ length: 5 }, () => getAccessToken(id)))
    expect(new Set(all)).toEqual(new Set(['new-access']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the refresh request carries the stored refresh token and Basic app credentials', async () => {
    const id = await seedRow()
    await getAccessToken(id)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(TOKEN_URL)
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`)
    const body = lastExchange()
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(body.has('client_secret')).toBe(false)
  })

  it('when a peer holds the lease, the caller waits and adopts the peer\'s token without fetching', async () => {
    const id = await seedRow()
    acquireResults.push(0, 0, 0, 0, 0, 0)
    // The "peer" (another process) lands its refresh 50 ms in.
    setTimeout(() => {
      void (async () => {
        const fresh = { accessToken: 'peer-access', refreshToken: 'old-refresh', accessTokenExpiresAt: future().toISOString() }
        const r = rows.get(id)!
        r.credentialsEnc = (await encryptCredentials(fresh)).blob
        r.accessTokenExpiresAt = new Date(fresh.accessTokenExpiresAt)
        r.refreshLeaseUntil = null
      })()
    }, 50)
    await expect(getAccessToken(id)).resolves.toBe('peer-access')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('double-check: a peer that refreshed between our read and our lease means no fetch', async () => {
    const id = await seedRow()
    // First read sees the stale row; the read inside refreshOwned (after the lease) sees a fresh one.
    let reads = 0
    prismaMock.channelConnection.findUnique.mockImplementationOnce(async ({ where }: { where: { id: string } }) => {
      reads++
      return pick(rows.get(where.id)!)
    })
    const fresh = { accessToken: 'peer-access', refreshToken: 'old-refresh', accessTokenExpiresAt: future().toISOString() }
    const blob = (await encryptCredentials(fresh)).blob
    prismaMock.$executeRaw.mockImplementationOnce(async () => {
      // Lease acquired — and the peer's write is already in the row.
      const r = rows.get(id)!
      r.credentialsEnc = blob
      r.accessTokenExpiresAt = new Date(fresh.accessTokenExpiresAt)
      return 1
    })
    await expect(getAccessToken(id)).resolves.toBe('peer-access')
    expect(reads).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a peer that never finishes → RefreshContended after the wait window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    try {
      const id = await seedRow()
      acquireResults.push(0)
      prismaMock.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => (strings.join('?').includes('make_interval') ? 0 : 1))
      const p = getAccessToken(id)
      const settled = p.then(() => 'resolved', (e: Error) => e)
      await vi.advanceTimersByTimeAsync(13_000)
      const outcome = await settled
      expect(outcome).toMatchObject({ code: 'REFRESH_CONTENDED', connectionId: id })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      prismaMock.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?')
        if (sql.includes('make_interval')) {
          acquireCalls++
          return acquireResults.length ? acquireResults.shift()! : 1
        }
        releaseCalls++
        return 1
      })
    }
  })
})

// ── (d) rotation rule ────────────────────────────────────────────────────────

describe('refresh-token rotation', () => {
  it('a refresh_token in the response replaces the stored one and re-dates its expiry', async () => {
    const id = await seedRow()
    const before = Date.now()
    fetchMock.mockImplementationOnce(async () => tokenResponse({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }))
    await getAccessToken(id)
    const c = await credsOf(id)
    expect(c.accessToken).toBe('new-access')
    expect(c.refreshToken).toBe('rotated-refresh')
    const rtExp = Date.parse(c.refreshTokenExpiresAt!)
    expect(rtExp).toBeGreaterThanOrEqual(before + REFRESH_LIFE_SEC * 1000)
    expect(rtExp).toBeLessThanOrEqual(Date.now() + REFRESH_LIFE_SEC * 1000)
    expect(eventsOf('refresh', id)[0].detail).toMatchObject({ rotated: true, expiresInSec: 3600 })
  })

  it('no refresh_token in the response keeps the old one and its expiry', async () => {
    const id = await seedRow()
    const seededRtExp = (rows.get(id)!.refreshTokenExpiresAt as Date).toISOString()
    fetchMock.mockImplementationOnce(async () => tokenResponse({ access_token: 'new-access', expires_in: 7200 }))
    await getAccessToken(id)
    const c = await credsOf(id)
    expect(c.accessToken).toBe('new-access')
    expect(c.refreshToken).toBe('old-refresh')
    expect(c.refreshTokenExpiresAt).toBe(seededRtExp)
    expect(eventsOf('refresh', id)[0].detail).toMatchObject({ rotated: false })
  })

  it('an empty-string refresh_token counts as "not rotated"', async () => {
    const id = await seedRow()
    fetchMock.mockImplementationOnce(async () => tokenResponse({ access_token: 'new-access', refresh_token: '', expires_in: 7200 }))
    await getAccessToken(id)
    expect((await credsOf(id)).refreshToken).toBe('old-refresh')
  })

  it('a successful refresh writes lastRefreshAt and resets failures — and never touches lastSyncAt', async () => {
    const id = await seedRow({ row: { consecutiveFailures: 2, lastError: 'unknown: earlier', authStatus: 'degraded' } })
    const before = Date.now()
    await getAccessToken(id)
    const u = updates.find((x) => x.id === id && 'credentialsEnc' in x.data)!
    expect(u.data).toMatchObject({ consecutiveFailures: 0, lastError: null, lastErrorAt: null })
    expect((u.data.lastRefreshAt as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect('lastSyncAt' in u.data).toBe(false)
    const exp = (u.data.accessTokenExpiresAt as Date).getTime()
    expect(exp).toBeGreaterThanOrEqual(before + 7200_000)
    expect(exp).toBeLessThanOrEqual(Date.now() + 7200_000)
    // degraded → connected on success, with the recovery alert.
    expect(rows.get(id)!.authStatus).toBe('connected')
    expect(alertTitles()).toEqual([expect.stringContaining('recovered')])
  })

  it('a 200 with no access_token is a failure, not a silent blank token', async () => {
    const id = await seedRow()
    fetchMock.mockImplementationOnce(async () => tokenResponse({ token_type: 'bearer' }))
    await expect(getAccessToken(id)).rejects.toMatchObject({ errorClass: 'unknown' })
    expect((await credsOf(id)).accessToken).toBe('old-access')
  })
})

// ── (e) readCredentials / writeCredentials ───────────────────────────────────

describe('readCredentials (via getAccessToken)', () => {
  it('reads the envelope first', async () => {
    const id = await seedRow({
      creds: { accessToken: 'envelope-access', refreshToken: 'r', accessTokenExpiresAt: future().toISOString() },
      plaintext: { accessToken: 'stale-plain', tokenExpiresAt: future() },
    })
    await expect(getAccessToken(id)).resolves.toBe('envelope-access')
  })

  it('falls back to the generic plaintext columns when there is no envelope', async () => {
    const id = await seedRow({ creds: null, plaintext: { accessToken: 'plain-access', refreshToken: 'plain-refresh', tokenExpiresAt: future() } })
    await expect(getAccessToken(id)).resolves.toBe('plain-access')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the eBay plaintext columns too', async () => {
    const id = await seedRow({ creds: null, plaintext: { ebayAccessToken: 'ebay-plain', ebayRefreshToken: 'ebay-r', ebayTokenExpiresAt: future() } })
    await expect(getAccessToken(id)).resolves.toBe('ebay-plain')
  })

  it('a legacy plaintext row that needs a refresh uses the plaintext refresh token', async () => {
    const id = await seedRow({ creds: null, plaintext: { ebayAccessToken: 'ebay-plain', ebayRefreshToken: 'ebay-r', ebayTokenExpiresAt: past() } })
    await expect(getAccessToken(id)).resolves.toBe('new-access')
    expect(lastExchange().get('refresh_token')).toBe('ebay-r')
  })

  it('an envelope with an empty accessToken is "no credentials"', async () => {
    const id = await seedRow({ creds: { accessToken: '', refreshToken: 'r' } })
    await expect(getAccessToken(id)).rejects.toThrow(/has no credentials/)
  })

  it('no envelope and no plaintext is "no credentials"', async () => {
    const id = await seedRow({ creds: null })
    await expect(getAccessToken(id)).rejects.toThrow(/has no credentials/)
  })

  it('an env-managed row is refused', async () => {
    const id = await seedRow({ row: { managedBy: 'env' } })
    await expect(getAccessToken(id)).rejects.toThrow(/env-managed/)
  })

  it('a missing row and a non-string id are refused', async () => {
    await expect(getAccessToken('nope')).rejects.toThrow(/not found/)
    await expect(getAccessToken(undefined as unknown as string)).rejects.toThrow(/expects a connection id string/)
  })
})

describe('writeCredentials (via refresh / storeGrant)', () => {
  it('a refresh writes an envelope and nulls the four plaintext token columns in the same UPDATE', async () => {
    const id = await seedRow({ creds: null, plaintext: { accessToken: 'plain-access', refreshToken: 'plain-refresh', ebayAccessToken: 'e-a', ebayRefreshToken: 'e-r', tokenExpiresAt: past() } })
    await getAccessToken(id)
    const u = updates.find((x) => x.id === id && 'credentialsEnc' in x.data)!
    expect(isCredentialsBlob(u.data.credentialsEnc)).toBe(true)
    expect(u.data.credentialsKeyId).toBe('env')
    expect(u.data).toMatchObject({ accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null })
    // Legacy expiry columns keep a date so pre-CX.2 readers still render.
    expect(u.data.tokenExpiresAt).toBeInstanceOf(Date)
    expect(u.data.ebayTokenExpiresAt).toBeInstanceOf(Date)
    expect((u.data.tokenExpiresAt as Date).getTime()).toBe((u.data.accessTokenExpiresAt as Date).getTime())
    const r = rows.get(id)!
    expect([r.accessToken, r.refreshToken, r.ebayAccessToken, r.ebayRefreshToken]).toEqual([null, null, null, null])
    expect((await credsOf(id)).refreshToken).toBe('plain-refresh')
  })

  it('storeGrant persists the grant, identity columns, scopes and the ledger rows', async () => {
    const id = await seedRow({ creds: null, row: { authStatus: 'unknown', isActive: false, managedBy: 'oauth', region: null } })
    const before = Date.now()
    await storeGrant(
      id,
      {
        accessToken: 'granted-access',
        refreshToken: 'granted-refresh',
        expiresInSec: 7200,
        refreshExpiresInSec: 1000,
        grantedScopes: ['s1'],
        identity: { userId: 'U1', username: 'seller1', storeName: 'Store One', storeUrl: 'https://store.test' },
        region: null,
        tokenResponseMetadata: { token_type: 'User Access Token' },
      },
      { kind: 'operator', userId: 'user-1' },
      'grant',
    )
    const c = await credsOf(id)
    expect(c.accessToken).toBe('granted-access')
    expect(c.refreshToken).toBe('granted-refresh')
    expect(Date.parse(c.refreshTokenExpiresAt!)).toBeGreaterThanOrEqual(before + 1000_000)
    const u = updates.find((x) => x.id === id)!
    expect(u.data).toMatchObject({
      isActive: true,
      managedBy: 'oauth',
      authStatus: 'connected',
      grantedScopes: ['s1'],
      region: 'GLOBAL', // spec.defaultRegion
      externalAccountId: 'U1',
      displayName: 'seller1',
      ebaySignInName: 'seller1',
      ebayStoreName: 'Store One',
      ebayStoreFrontUrl: 'https://store.test',
      apiVersion: 'test-v1',
      consecutiveFailures: 0,
      refreshLeaseUntil: null,
      refreshLeaseOwner: null,
      accessToken: null,
      refreshToken: null,
      ebayAccessToken: null,
      ebayRefreshToken: null,
    })
    expect(u.data.identity).toMatchObject({ userId: 'U1' })
    const grant = eventsOf('grant', id)
    expect(grant).toHaveLength(1)
    expect(grant[0]).toMatchObject({ actorUserId: 'user-1', channelKey: 'EBAY' })
    expect(grant[0].detail).toMatchObject({ scopes: 1, identity: 'seller1', actorKind: 'operator' })
    expect(eventsOf('status_change', id)[0].detail).toMatchObject({ from: 'unknown', to: 'connected', reason: 'grant' })
  })

  it('storeGrant on an already-connected row writes no status_change', async () => {
    const id = await seedRow()
    await storeGrant(id, { accessToken: 'a', refreshToken: 'r', expiresInSec: 10, grantedScopes: [], identity: null }, { kind: 'operator' }, 'reconsent')
    expect(eventsOf('reconsent', id)).toHaveLength(1)
    expect(eventsOf('status_change', id)).toHaveLength(0)
  })

  it('the ledger detail never carries the token material', async () => {
    const id = await seedRow()
    await getAccessToken(id)
    for (const e of events) {
      const s = JSON.stringify(e)
      expect(s).not.toContain('new-access')
      expect(s).not.toContain('old-refresh')
    }
  })
})

// ── the rest of the public surface ───────────────────────────────────────────

describe('assertWritable', () => {
  it.each(['needs_reauth', 'revoked', 'disconnected'])('throws ConnectionNeedsReauth for %s', async (status) => {
    const id = await seedRow({ row: { authStatus: status } })
    await expect(assertWritable(id)).rejects.toMatchObject({ code: 'CONNECTION_NEEDS_REAUTH', connectionId: id, authStatus: status })
  })

  it.each(['connected', 'degraded', 'unknown'])('passes for %s', async (status) => {
    const id = await seedRow({ row: { authStatus: status } })
    await expect(assertWritable(id)).resolves.toBeUndefined()
  })
})

describe('handleOf', () => {
  it('carries identity and scopes but no credential field, and token() goes through getAccessToken', async () => {
    const id = await seedRow({ creds: { accessToken: 'live-access', refreshToken: 'r', accessTokenExpiresAt: future().toISOString() } })
    const h = handleOf({ id, channelType: 'EBAY', region: 'GLOBAL', grantedScopes: ['s1'], identity: { userId: 'U1' } })
    expect(h.channelKey).toBe('EBAY')
    expect(h.identity).toEqual({ userId: 'U1' })
    expect(h.grantedScopes).toEqual(['s1'])
    expect(Object.keys(h)).not.toEqual(expect.arrayContaining(['accessToken', 'refreshToken', 'credentialsEnc']))
    await expect(h.token()).resolves.toBe('live-access')
  })
})

describe('refreshNow', () => {
  it('reports refreshed=true and writes a manual refresh event for an operator', async () => {
    const id = await seedRow()
    const r = await refreshNow(id, { kind: 'operator', userId: 'u' })
    expect(r).toMatchObject({ refreshed: true, reason: 'refreshed' })
    expect(r.accessTokenExpiresAt).toBeInstanceOf(Date)
    expect(eventsOf('refresh', id).some((e) => (e.detail as Record<string, unknown>).manual === true)).toBe(true)
  })

  it('reports still_valid without a fetch when the token is not due', async () => {
    const id = await seedRow({ creds: { accessToken: 'live', refreshToken: 'r', accessTokenExpiresAt: future().toISOString() } })
    const r = await refreshNow(id)
    expect(r).toMatchObject({ refreshed: false, reason: 'still_valid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('force=true refreshes a token that is still valid', async () => {
    const id = await seedRow({ creds: { accessToken: 'live', refreshToken: 'r', accessTokenExpiresAt: future(1).toISOString() } })
    const r = await refreshNow(id, { kind: 'cron' }, true)
    expect(r.refreshed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(eventsOf('refresh', id).some((e) => (e.detail as Record<string, unknown>).manual === true)).toBe(false)
  })
})

describe('revoke', () => {
  it('operator disconnect: revokes at the channel with the refresh token, nulls everything, → disconnected', async () => {
    const id = await seedRow()
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 200 }))
    const r = await revoke(id, { kind: 'operator', userId: 'u' }, 'operator')
    expect(r.revokedAtChannel).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(REVOKE_URL)
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('token_type_hint')).toBe('refresh_token')
    expect(body.get('token')).toBe('old-refresh')
    const row = rows.get(id)!
    expect(row).toMatchObject({ credentialsEnc: null, credentialsKeyId: null, accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null, isActive: false, isPrimary: false, authStatus: 'disconnected', refreshLeaseUntil: null })
    expect(eventsOf('disconnect', id)).toHaveLength(1)
    expect(eventsOf('status_change', id)[0].detail).toMatchObject({ from: 'connected', to: 'disconnected', reason: 'operator' })
  })

  it('channel-side revocation → revoked, and a failing remote revoke still nulls locally', async () => {
    const id = await seedRow()
    fetchMock.mockImplementationOnce(async () => { throw new Error('eBay down') })
    const r = await revoke(id, { kind: 'channel' }, 'channel')
    expect(r.revokedAtChannel).toBe(false)
    expect(rows.get(id)!.authStatus).toBe('revoked')
    expect(rows.get(id)!.credentialsEnc).toBeNull()
    expect(eventsOf('revoke', id)).toHaveLength(1)
  })
})

describe('encryptLegacyRow', () => {
  it('encrypts a plaintext row, verifies the round-trip, nulls the plaintext', async () => {
    const id = await seedRow({ creds: null, plaintext: { ebayAccessToken: 'e-a', ebayRefreshToken: 'e-r', ebayTokenExpiresAt: future() } })
    await expect(encryptLegacyRow(id)).resolves.toBe('encrypted')
    const r = rows.get(id)!
    expect(isCredentialsBlob(r.credentialsEnc)).toBe(true)
    expect([r.accessToken, r.refreshToken, r.ebayAccessToken, r.ebayRefreshToken]).toEqual([null, null, null, null])
    const c = await credsOf(id)
    expect(c.accessToken).toBe('e-a')
    expect(c.refreshToken).toBe('e-r')
  })

  it('skips a row that already has an envelope and reports no_tokens for an empty one', async () => {
    const enveloped = await seedRow()
    await expect(encryptLegacyRow(enveloped)).resolves.toBe('skipped')
    const empty = await seedRow({ creds: null })
    await expect(encryptLegacyRow(empty)).resolves.toBe('no_tokens')
    await expect(encryptLegacyRow('ghost')).resolves.toBe('skipped')
  })
})

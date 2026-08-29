/**
 * CX.1 — the connection heartbeat: `runHeartbeatFor` feeds the authStatus
 * state machine from a catalogue heartbeat result. A fake spec registered over
 * EBAY drives the state-machine cases; the real eBay entry (fetch stubbed)
 * proves the connector's own error mapping reaches needs_reauth.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID
delete process.env.EBAY_IDENTITY_BASE

// ── in-memory prisma ─────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string }
const rows = new Map<string, Row>()
const updates: Array<{ id: string; data: Record<string, unknown> }> = []
const events: Array<Record<string, unknown>> = []
const scopeUpserts: Array<Record<string, unknown>> = []
let scopeRows: Array<{ kind: string; externalId: string; metadata: Record<string, unknown> | null }> = []
let apps: Array<Record<string, unknown>> = []

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
    findMany: vi.fn(async () => [...rows.values()].map((r) => ({ ...r }))),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.get(where.id)
      if (!r) throw new Error(`fake prisma: no row ${where.id}`)
      for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v
      updates.push({ id: where.id, data })
      return { ...r }
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  connectionEvent: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      events.push(data)
      return data
    }),
    findFirst: vi.fn(async () => null),
  },
  connectionScope: {
    // Discovery reads the existing rows so it can MERGE metadata rather than replace
    // it — the operator's own facts about a scope must survive a heartbeat.
    findMany: vi.fn(async () => scopeRows),
    upsert: vi.fn(async (args: Record<string, unknown>) => {
      scopeUpserts.push(args)
      return args
    }),
  },
  channelApp: {
    findMany: vi.fn(async () => apps),
  },
  oAuthSession: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  $executeRaw: vi.fn(async () => 1),
}

vi.mock('../db.js', () => ({ default: prismaMock }))
const createAlert = vi.fn(async () => ({}))
vi.mock('../services/monitoring/alert.service.js', () => ({
  alertService: { createAlert },
  AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' },
}))
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>()
  return { ...actual, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (_name: string, fn: () => Promise<string>) => fn()),
}))
vi.mock('../services/cx/apps.service.js', () => ({
  getChannelApp: vi.fn(async () => ({ clientId: 'id', clientSecret: 'secret', redirectUris: [], extra: {}, signingKey: null })),
}))

// ── modules under test ───────────────────────────────────────────────────────

const { registerChannel, getChannelSpec } = await import('../services/cx/catalog.js')
type Spec = import('../services/cx/catalog.js').ChannelSpec
type HeartbeatResult = import('../services/cx/catalog.js').HeartbeatResult
type ErrorClass = import('../services/cx/catalog.js').ErrorClass
type ConnectionRow = import('../services/connection-resolver.service.js').ConnectionRow
const { encryptCredentials } = await import('../lib/crypto.js')
const { runHeartbeatFor, runHeartbeatSweep } = await import('./cx-heartbeat.job.js')

// The job's import of connectors/index registered the real eBay entry; keep it for the real-path tests.
const realEbay = getChannelSpec('EBAY')

const heartbeat = vi.fn<(h: unknown) => Promise<HeartbeatResult>>()
const discoverScopes = vi.fn<(h: unknown) => Promise<Array<{ kind: 'shop' | 'marketplace' | 'profile' | 'storefront'; externalId: string; label?: string }>>>()
const fakeSpec: Spec = {
  key: 'EBAY',
  channelType: 'EBAY',
  displayName: 'eBay (fake)',
  available: true,
  auth: {
    mode: 'oauth2_code',
    tokenUrl: () => 'https://token.test',
    tokenRequestAuth: 'basic',
    scopeSeparator: ' ',
    codeParamInCallback: 'code',
    pkce: false,
    requiredScopes: ['s1', 's2', 's3'],
    rotatesRefreshToken: false,
  },
  identity: async () => null,
  heartbeat,
  rateLimit: { parse: () => null, model: 'daily_quota' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
  apiVersion: 'fake',
  sandbox: { available: false },
}

let seq = 0
function seedRow(over: Record<string, unknown> = {}): ConnectionRow {
  const id = String(over.id ?? `hb-${++seq}`)
  const row: Row = {
    id,
    channelType: 'EBAY',
    managedBy: 'oauth',
    isActive: true,
    authStatus: 'connected',
    displayName: 'HB Shop',
    grantedScopes: ['s1', 's2', 's3'],
    identity: null,
    region: 'GLOBAL',
    consecutiveFailures: 0,
    refreshTokenExpiresAt: null,
    accessTokenExpiresAt: null,
    connectionMetadata: null,
    credentialsEnc: null,
    accessToken: null,
    refreshToken: null,
    ebayAccessToken: null,
    ebayRefreshToken: null,
    tokenExpiresAt: null,
    ebayTokenExpiresAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    lastErrorAt: null,
    refreshLeaseUntil: null,
    refreshLeaseOwner: null,
    ...over,
  }
  rows.set(id, row)
  return { ...row } as unknown as ConnectionRow
}

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>()
const eventsOf = (type: string, id?: string) => events.filter((e) => e.type === type && (id === undefined || e.connectionId === id))
const alertTitles = () => createAlert.mock.calls.map((c) => String((c as unknown[])[1]))
const lastUpdate = (id: string) => updates.filter((u) => u.id === id).at(-1)!.data

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  await encryptCredentials({ warm: true }) // burn the once-per-process KMS-fallback notice
})
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  rows.clear()
  updates.length = 0
  events.length = 0
  scopeUpserts.length = 0
  apps = []
  createAlert.mockClear()
  fetchMock.mockReset()
  heartbeat.mockReset()
  discoverScopes.mockReset()
  delete fakeSpec.discoverScopes
  registerChannel(fakeSpec)
})

// ── ok path ──────────────────────────────────────────────────────────────────

describe('runHeartbeatFor — ok', () => {
  it('writes lastHeartbeatAt + zeroes failures, transitions to connected, records heartbeat_ok', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 42 })
    const row = seedRow({ authStatus: 'unknown', consecutiveFailures: 2, lastError: 'network: earlier' })
    const before = Date.now()
    const report = await runHeartbeatFor(row)
    expect(report).toEqual({ ok: true, connectionId: row.id, channelType: 'EBAY', latencyMs: 42, authStatus: 'connected', scopeDrift: [] })
    const data = updates.find((u) => u.id === row.id && 'lastHeartbeatAt' in u.data)!.data
    expect((data.lastHeartbeatAt as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect(data).toMatchObject({ consecutiveFailures: 0, lastError: null, lastErrorAt: null })
    expect('identity' in data).toBe(false)
    expect('grantedScopes' in data).toBe(false)
    expect(rows.get(row.id)!.authStatus).toBe('connected')
    const sc = eventsOf('status_change', row.id)
    expect(sc).toHaveLength(1)
    expect(sc[0].detail).toMatchObject({ from: 'unknown', to: 'connected', reason: 'heartbeat ok', actorKind: 'cron' })
    const ok = eventsOf('heartbeat_ok', row.id)
    expect(ok).toHaveLength(1)
    expect(ok[0].detail).toMatchObject({ latencyMs: 42, actorKind: 'cron' })
    expect(createAlert).not.toHaveBeenCalled() // unknown → connected is not a recovery
  })

  it('the handle it passes carries the row identity/scopes and no credentials', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1 })
    const row = seedRow({ identity: { userId: 'U1' }, grantedScopes: ['s1', 's2', 's3'] })
    await runHeartbeatFor(row)
    const handle = heartbeat.mock.calls[0][0] as Record<string, unknown>
    expect(handle).toMatchObject({ id: row.id, channelKey: 'EBAY', channelType: 'EBAY', region: 'GLOBAL', identity: { userId: 'U1' } })
    expect(Object.keys(handle).sort()).toEqual(['channelKey', 'channelType', 'grantedScopes', 'id', 'identity', 'region', 'token'])
  })

  it('a connected row stays connected with no status_change and no alert', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1 })
    const row = seedRow()
    await runHeartbeatFor(row)
    expect(eventsOf('status_change', row.id)).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('degraded → connected raises the "recovered" alert', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1 })
    const row = seedRow({ authStatus: 'degraded', consecutiveFailures: 4 })
    const report = await runHeartbeatFor(row)
    expect(report.authStatus).toBe('connected')
    expect(alertTitles()).toEqual(['EBAY account "HB Shop" recovered'])
  })

  it('fills in identity only when the row has none, and adopts reported scopes', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1, identity: { userId: 'U-new', username: 'n' }, scopes: ['s1', 's2'] })
    const bare = seedRow()
    await runHeartbeatFor(bare)
    expect(lastUpdate(bare.id)).toMatchObject({ identity: { userId: 'U-new', username: 'n' }, grantedScopes: ['s1', 's2'] })

    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1, identity: { userId: 'U-other' }, scopes: [] })
    const known = seedRow({ identity: { userId: 'U-kept' } })
    await runHeartbeatFor(known)
    const data = updates.filter((u) => u.id === known.id).find((u) => 'lastHeartbeatAt' in u.data)!.data
    expect('identity' in data).toBe(false)
    expect('grantedScopes' in data).toBe(false) // an empty scopes list is not a report
  })

  it('reports scope drift from the row\'s granted scopes', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1 })
    const row = seedRow({ grantedScopes: ['s1'] })
    const report = await runHeartbeatFor(row)
    expect(report.scopeDrift).toEqual(['s2', 's3'])
  })

  it('MERGES scope metadata — discovery must not delete what discovery cannot see', async () => {
    // The operator's own facts about a scope (an Amazon Ads profile's mode, whether
    // writes are enabled, when it was last written to) are not things /v2/profiles
    // reports. A replacing upsert erased them on the first heartbeat, measured on
    // prod during CX.3a.
    scopeRows = [{ kind: 'marketplace', externalId: 'IT', metadata: { mode: 'production', writesEnabledAt: '2026-01-01T00:00:00Z' } }]
    fakeSpec.discoverScopes = discoverScopes
    registerChannel(fakeSpec)
    heartbeat.mockResolvedValue({ ok: true, latencyMs: 5 })
    discoverScopes.mockResolvedValueOnce([
      { kind: 'marketplace', externalId: 'IT', label: 'Italy', metadata: { currencyCode: 'EUR' } },
    ])

    await runHeartbeatFor(seedRow())

    const written = scopeUpserts.at(-1) as { update: { metadata: Record<string, unknown> } }
    expect(written.update.metadata).toEqual({
      mode: 'production',
      writesEnabledAt: '2026-01-01T00:00:00Z',
      currencyCode: 'EUR',
    })
  })

  it('runs discoverScopes and upserts every ConnectionScope; a discovery failure does not fail the heartbeat', async () => {
    fakeSpec.discoverScopes = discoverScopes
    registerChannel(fakeSpec)
    heartbeat.mockResolvedValue({ ok: true, latencyMs: 1 })
    discoverScopes.mockResolvedValueOnce([
      { kind: 'marketplace', externalId: 'A1F83G8C2ARO7P', label: 'UK' },
      { kind: 'marketplace', externalId: 'A1PA6795UKMFR9', label: 'DE' },
    ])
    const row = seedRow()
    const r1 = await runHeartbeatFor(row)
    expect(r1.ok).toBe(true)
    expect(scopeUpserts).toHaveLength(2)
    expect(scopeUpserts[0]).toMatchObject({
      where: { connectionId_kind_externalId: { connectionId: row.id, kind: 'marketplace', externalId: 'A1F83G8C2ARO7P' } },
      create: { connectionId: row.id, kind: 'marketplace', externalId: 'A1F83G8C2ARO7P', label: 'UK', region: null, isActive: true },
      update: { label: 'UK', region: null, isActive: true },
    })

    discoverScopes.mockRejectedValueOnce(new Error('participations 500'))
    const r2 = await runHeartbeatFor(seedRow())
    expect(r2.ok).toBe(true)
    expect(scopeUpserts).toHaveLength(2)
  })
})

// ── failure path ─────────────────────────────────────────────────────────────

describe('runHeartbeatFor — failures', () => {
  const fail = (errorClass: ErrorClass, status?: number): HeartbeatResult => ({ ok: false, latencyMs: 7, errorClass, status, message: `identity ${status ?? 'n/a'}: nope` })

  it('failure 1: increments consecutiveFailures, records heartbeat_failed, keeps the status', async () => {
    heartbeat.mockResolvedValueOnce(fail('network'))
    const row = seedRow()
    const before = Date.now()
    const report = await runHeartbeatFor(row)
    expect(report).toMatchObject({ ok: false, authStatus: 'connected', errorClass: 'network', message: 'identity n/a: nope', latencyMs: 7 })
    const data = lastUpdate(row.id)
    expect(data).toMatchObject({ consecutiveFailures: 1, lastError: 'network: identity n/a: nope' })
    expect((data.lastHeartbeatAt as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect((data.lastErrorAt as Date).getTime()).toBeGreaterThanOrEqual(before)
    const hf = eventsOf('heartbeat_failed', row.id)
    expect(hf).toHaveLength(1)
    expect(hf[0].detail).toMatchObject({ errorClass: 'network', status: null, failures: 1, actorKind: 'cron' })
    expect(eventsOf('status_change', row.id)).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('failure 2 still keeps the status', async () => {
    heartbeat.mockResolvedValueOnce(fail('unknown', 500))
    const row = seedRow({ consecutiveFailures: 1 })
    const report = await runHeartbeatFor(row)
    expect(report.authStatus).toBe('connected')
    expect(rows.get(row.id)!.consecutiveFailures).toBe(2)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('failure 3 → degraded, one alert', async () => {
    heartbeat.mockResolvedValueOnce(fail('unknown', 500))
    const row = seedRow({ consecutiveFailures: 2 })
    const report = await runHeartbeatFor(row)
    expect(report.authStatus).toBe('degraded')
    expect(rows.get(row.id)!).toMatchObject({ consecutiveFailures: 3, authStatus: 'degraded' })
    expect(eventsOf('status_change', row.id)[0].detail).toMatchObject({ from: 'connected', to: 'degraded', reason: 'identity 500: nope' })
    expect(alertTitles()).toEqual(['EBAY account "HB Shop" is degraded'])
  })

  it('failures 4–9 stay degraded silently', async () => {
    heartbeat.mockResolvedValueOnce(fail('rate_limited', 429))
    const row = seedRow({ consecutiveFailures: 6, authStatus: 'degraded' })
    const report = await runHeartbeatFor(row)
    expect(report.authStatus).toBe('degraded')
    expect(eventsOf('status_change', row.id)).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('failure 10 → needs_reauth with the "needs reconnecting" alert', async () => {
    heartbeat.mockResolvedValueOnce(fail('unknown', 500))
    const row = seedRow({ consecutiveFailures: 9, authStatus: 'degraded' })
    const report = await runHeartbeatFor(row)
    expect(report.authStatus).toBe('needs_reauth')
    expect(rows.get(row.id)!.consecutiveFailures).toBe(10)
    expect(eventsOf('status_change', row.id)[0].detail).toMatchObject({ from: 'degraded', to: 'needs_reauth' })
    expect(alertTitles()).toEqual(['EBAY account "HB Shop" needs reconnecting'])
  })

  it('auth_revoked → needs_reauth on the first failure', async () => {
    heartbeat.mockResolvedValueOnce(fail('auth_revoked', 401))
    const row = seedRow()
    const report = await runHeartbeatFor(row)
    expect(report).toMatchObject({ ok: false, authStatus: 'needs_reauth', errorClass: 'auth_revoked' })
    expect(rows.get(row.id)!).toMatchObject({ consecutiveFailures: 1, authStatus: 'needs_reauth' })
    expect(eventsOf('heartbeat_failed', row.id)[0].detail).toMatchObject({ status: 401, failures: 1 })
    expect(alertTitles()).toEqual(['EBAY account "HB Shop" needs reconnecting'])
  })

  it('auth_expired → needs_reauth on the first failure', async () => {
    heartbeat.mockResolvedValueOnce(fail('auth_expired'))
    const row = seedRow()
    expect((await runHeartbeatFor(row)).authStatus).toBe('needs_reauth')
  })

  it('a needs_reauth row that fails again does not re-alert', async () => {
    heartbeat.mockResolvedValueOnce(fail('auth_revoked', 401))
    const row = seedRow({ authStatus: 'needs_reauth', consecutiveFailures: 3 })
    await runHeartbeatFor(row)
    expect(eventsOf('status_change', row.id)).toHaveLength(0)
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('a row with no catalogue entry is reported, not updated', async () => {
    const row = seedRow({ channelType: 'WALMART', authStatus: 'degraded' })
    const report = await runHeartbeatFor(row)
    expect(report).toEqual({ ok: false, connectionId: row.id, channelType: 'WALMART', latencyMs: 0, authStatus: 'degraded', scopeDrift: [], message: 'no catalogue entry' })
    expect(heartbeat).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})

// ── the real eBay entry ──────────────────────────────────────────────────────

describe('runHeartbeatFor — real eBay spec', () => {
  beforeEach(() => {
    registerChannel(realEbay)
  })

  it('a row with no credentials cannot even mint a token → auth_expired → needs_reauth, no network call', async () => {
    const row = seedRow()
    const report = await runHeartbeatFor(row)
    expect(report).toMatchObject({ ok: false, errorClass: 'auth_expired', authStatus: 'needs_reauth' })
    expect(report.message).toMatch(/no credentials/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rows.get(row.id)!.authStatus).toBe('needs_reauth')
  })

  it('a live token that eBay answers 401 to → auth_revoked → needs_reauth', async () => {
    const exp = new Date(Date.now() + 3_600_000)
    const { blob } = await encryptCredentials({ accessToken: 'live-access', refreshToken: 'r', accessTokenExpiresAt: exp.toISOString() })
    const row = seedRow({ credentialsEnc: blob, credentialsKeyId: 'env', accessTokenExpiresAt: exp })
    fetchMock.mockResolvedValueOnce(new Response('{"errors":[{"errorId":1001}]}', { status: 401 }))
    const report = await runHeartbeatFor(row)
    expect(report).toMatchObject({ ok: false, errorClass: 'auth_revoked', authStatus: 'needs_reauth' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://apiz.ebay.com/commerce/identity/v1/user/')
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer live-access')
  })

  it('a 200 from the identity endpoint is ok and back-fills the identity', async () => {
    const exp = new Date(Date.now() + 3_600_000)
    const { blob } = await encryptCredentials({ accessToken: 'live-access', refreshToken: 'r', accessTokenExpiresAt: exp.toISOString() })
    const row = seedRow({ credentialsEnc: blob, credentialsKeyId: 'env', accessTokenExpiresAt: exp, authStatus: 'degraded', consecutiveFailures: 3, grantedScopes: realEbay.auth.requiredScopes })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'U1', username: 'seller1' }), { status: 200 }))
    const report = await runHeartbeatFor(row)
    expect(report).toMatchObject({ ok: true, authStatus: 'connected', scopeDrift: [] })
    const hb = updates.find((u) => u.id === row.id && 'lastHeartbeatAt' in u.data)!.data
    expect(hb).toMatchObject({ identity: { userId: 'U1', username: 'seller1' }, consecutiveFailures: 0 })
    expect(alertTitles()).toEqual(['EBAY account "HB Shop" recovered'])
  })
})

// ── the sweep ────────────────────────────────────────────────────────────────

describe('runHeartbeatSweep', () => {
  it('heartbeats every live row, warns on an app secret expiring in 7 days, sweeps sessions and stale leases', async () => {
    heartbeat.mockResolvedValueOnce({ ok: true, latencyMs: 1 }).mockResolvedValueOnce({ ok: false, latencyMs: 1, errorClass: 'network', message: 'down' })
    seedRow({ accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000) })
    seedRow({ accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000) })
    apps = [{ channelKey: 'AMAZON_SP', secretExpiresAt: new Date(Date.now() + 7 * 86_400_000 + 60_000) }]
    const summary = await runHeartbeatSweep()
    expect(summary).toBe('connections=2 ok=1 failed=1 refreshed=0 sessionsSwept=0')
    expect(heartbeat).toHaveBeenCalledTimes(2)
    expect(alertTitles()).toEqual(['AMAZON_SP app secret expires in 7 day(s)'])
    expect(prismaMock.oAuthSession.deleteMany).toHaveBeenCalled()
    expect(prismaMock.channelConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refreshLeaseUntil: null, refreshLeaseOwner: null } }),
    )
    expect(fetchMock).not.toHaveBeenCalled() // nothing was inside the proactive-refresh window
  })

  it('warns 30 / 7 / 1 days before a refresh token expires, once per day', async () => {
    heartbeat.mockResolvedValue({ ok: true, latencyMs: 1 })
    seedRow({ accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000), refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000 + 3_600_000) })
    await runHeartbeatSweep()
    expect(alertTitles()).toEqual(['EBAY account "HB Shop" must be reconnected within 30 days'])
    const warn = events.find((e) => e.type === 'status_change' && (e.detail as Record<string, unknown>).expiryWarnDays === 30)
    expect(warn).toBeTruthy()

    // The same threshold within 20 h is not repeated.
    createAlert.mockClear()
    prismaMock.connectionEvent.findFirst.mockResolvedValueOnce({ id: 'seen' } as never)
    await runHeartbeatSweep()
    expect(createAlert).not.toHaveBeenCalled()
  })
})

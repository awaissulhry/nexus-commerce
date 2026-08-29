/**
 * CX.3a — which store the Amazon Ads credential comes from.
 *
 * `resolveCredentials` is the chokepoint every live Ads call funnels through,
 * and it is the only thing on the money path this unit changes: ask the
 * connection core first, fall back to the legacy `AmazonAdsConnection` row,
 * revert with `NEXUS_CX_ADS_CREDENTIALS=0`. Both paths are proven here, not
 * assumed — including that the core failing is a log line and not an outage.
 *
 * No network and no DB: prisma, the token service and the apps service are
 * in-memory fakes; the row blob is encrypted with the REAL crypto under a
 * throwaway key so the decrypt is a genuine round-trip. Every credential value
 * below is a test fixture, and the last test asserts none of them reaches a log.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

// ── fixtures ─────────────────────────────────────────────────────────────────

const CORE_REFRESH = 'fixture-core-refresh-token'
const APP_CLIENT_ID = 'fixture-app-client-id'
const APP_CLIENT_SECRET = 'fixture-app-client-secret'
const ROW_CLIENT_ID = 'fixture-row-client-id'
const ROW_CLIENT_SECRET = 'fixture-row-client-secret'
const ROW_REFRESH = 'fixture-row-refresh-token'
/** Everything that must never appear in a log line. */
const SECRETS = [CORE_REFRESH, APP_CLIENT_SECRET, ROW_CLIENT_SECRET, ROW_REFRESH, 'fixture-core-envelope']

const PROFILE_ID = '3806012345678901'

// ── in-memory prisma ─────────────────────────────────────────────────────────

interface CoreRow { id: string; credentialsEnc: string | null }
interface LegacyRow { profileId: string; credentialsEncrypted: string | null; isActive: boolean }

let coreRow: CoreRow | null = null
let coreLookupError: Error | null = null
let legacyRows: LegacyRow[] = []

const channelConnectionFindFirst = vi.fn(async () => {
  if (coreLookupError) throw coreLookupError
  return coreRow
})

const prismaMock = {
  channelConnection: { findFirst: channelConnectionFindFirst },
  amazonAdsConnection: {
    findFirst: vi.fn(async ({ where }: { where: { isActive: boolean } }) =>
      legacyRows.find((r) => r.isActive === where.isActive) ?? null),
    findUnique: vi.fn(async ({ where }: { where: { profileId: string } }) =>
      legacyRows.find((r) => r.profileId === where.profileId) ?? null),
  },
}
vi.mock('../../db.js', () => ({ default: prismaMock }))

// ── the two cx services the core path reaches for ────────────────────────────

let coreRefreshToken: string | null = CORE_REFRESH
const readRefreshToken = vi.fn(async (_connectionId: string) => coreRefreshToken)
vi.mock('../cx/token.service.js', () => ({ readRefreshToken }))

let appCreds: { clientId: string; clientSecret: string } = { clientId: APP_CLIENT_ID, clientSecret: APP_CLIENT_SECRET }
const getChannelApp = vi.fn(async () => ({
  channelKey: 'AMAZON_ADS' as const,
  environment: 'production' as const,
  ...appCreds,
  redirectUris: [],
  extra: {},
  signingKey: null,
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp }))

// ── logger capture ───────────────────────────────────────────────────────────

const logged: Array<{ level: string; args: unknown[] }> = []
const capture = (level: string) => (...args: unknown[]) => { logged.push({ level, args }) }
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') },
}))

// ── module under test (after the mocks are wired) ────────────────────────────

const { encryptSecret } = await import('../../lib/crypto.js')
const { __adsCredentialsTest } = await import('./ads-api-client.js')
const { resolveCredentials, resetSourceLog } = __adsCredentialsTest

const ROW_ENVELOPE = encryptSecret(
  JSON.stringify({ clientId: ROW_CLIENT_ID, clientSecret: ROW_CLIENT_SECRET, refreshToken: ROW_REFRESH }),
)

function everythingLogged(): string {
  return logged.map((l) => JSON.stringify(l.args)).join('\n')
}

beforeEach(() => {
  delete process.env.NEXUS_CX_ADS_CREDENTIALS
  coreRow = { id: 'conn_ads_1', credentialsEnc: 'fixture-core-envelope' }
  coreLookupError = null
  coreRefreshToken = CORE_REFRESH
  appCreds = { clientId: APP_CLIENT_ID, clientSecret: APP_CLIENT_SECRET }
  legacyRows = [{ profileId: PROFILE_ID, credentialsEncrypted: ROW_ENVELOPE, isActive: true }]
  logged.length = 0
  resetSourceLog()
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.NEXUS_CX_ADS_CREDENTIALS
})

// ── (a) the core answers ─────────────────────────────────────────────────────

describe('resolveCredentials — the connection core', () => {
  it('returns the core refresh token with the ChannelApp client id and secret', async () => {
    const creds = await resolveCredentials(PROFILE_ID)

    expect(creds).toEqual({
      clientId: APP_CLIENT_ID,
      clientSecret: APP_CLIENT_SECRET,
      refreshToken: CORE_REFRESH,
    })
    // The single AMAZON_ADS connection, and only the two columns needed.
    expect(channelConnectionFindFirst).toHaveBeenCalledWith({
      where: { channelType: 'AMAZON_ADS', isActive: true },
      select: { id: true, credentialsEnc: true },
    })
    expect(readRefreshToken).toHaveBeenCalledWith('conn_ads_1')
    expect(getChannelApp).toHaveBeenCalledWith('AMAZON_ADS', 'production')
    // The legacy row is not even read when the core can answer.
    expect(prismaMock.amazonAdsConnection.findUnique).not.toHaveBeenCalled()
  })

  it('serves a profile-agnostic call (profileId="n/a") from the same core grant', async () => {
    const creds = await resolveCredentials('n/a')
    expect(creds.refreshToken).toBe(CORE_REFRESH)
    expect(prismaMock.amazonAdsConnection.findFirst).not.toHaveBeenCalled()
  })

  it('logs the source once per process, not once per call', async () => {
    await resolveCredentials(PROFILE_ID)
    await resolveCredentials(PROFILE_ID)
    await resolveCredentials('n/a')

    const sourceLines = logged.filter((l) => String(l.args[0]).includes('credential source'))
    expect(sourceLines).toHaveLength(1)
    expect(sourceLines[0].level).toBe('info')
    expect(sourceLines[0].args[1]).toEqual({ source: 'core' })
  })
})

// ── (b) the rollback flag ────────────────────────────────────────────────────

describe('resolveCredentials — NEXUS_CX_ADS_CREDENTIALS=0', () => {
  it('returns the row blob and never touches the core', async () => {
    process.env.NEXUS_CX_ADS_CREDENTIALS = '0'

    const creds = await resolveCredentials(PROFILE_ID)

    expect(creds).toEqual({
      clientId: ROW_CLIENT_ID,
      clientSecret: ROW_CLIENT_SECRET,
      refreshToken: ROW_REFRESH,
    })
    expect(channelConnectionFindFirst).not.toHaveBeenCalled()
    expect(readRefreshToken).not.toHaveBeenCalled()
    expect(getChannelApp).not.toHaveBeenCalled()
  })

  it('is the flag, not the absence of the flag — any other value keeps the core', async () => {
    process.env.NEXUS_CX_ADS_CREDENTIALS = '1'
    expect((await resolveCredentials(PROFILE_ID)).refreshToken).toBe(CORE_REFRESH)
  })

  it('reads the first active row for a profile-agnostic call', async () => {
    process.env.NEXUS_CX_ADS_CREDENTIALS = '0'
    const creds = await resolveCredentials('n/a')
    expect(creds.refreshToken).toBe(ROW_REFRESH)
    expect(prismaMock.amazonAdsConnection.findFirst).toHaveBeenCalledWith({ where: { isActive: true } })
  })
})

// ── (c) + the other half-answers the core can give ───────────────────────────

describe('resolveCredentials — falls back on an incomplete core', () => {
  it('falls back when the connection row exists but credentialsEnc is null', async () => {
    coreRow = { id: 'conn_ads_1', credentialsEnc: null }

    const creds = await resolveCredentials(PROFILE_ID)

    expect(creds.refreshToken).toBe(ROW_REFRESH)
    expect(readRefreshToken).not.toHaveBeenCalled()
  })

  it('falls back when there is no AMAZON_ADS connection at all', async () => {
    coreRow = null
    expect((await resolveCredentials(PROFILE_ID)).refreshToken).toBe(ROW_REFRESH)
  })

  it('falls back when the envelope carries no refresh token', async () => {
    coreRefreshToken = null
    expect((await resolveCredentials(PROFILE_ID)).refreshToken).toBe(ROW_REFRESH)
  })

  it('falls back when the ChannelApp has no client secret — never a half credential', async () => {
    appCreds = { clientId: APP_CLIENT_ID, clientSecret: '' }
    const creds = await resolveCredentials(PROFILE_ID)
    expect(creds).toEqual({ clientId: ROW_CLIENT_ID, clientSecret: ROW_CLIENT_SECRET, refreshToken: ROW_REFRESH })
  })

  it('logs the row source once it is the one in use', async () => {
    coreRow = null
    await resolveCredentials(PROFILE_ID)
    const sourceLines = logged.filter((l) => String(l.args[0]).includes('credential source'))
    expect(sourceLines).toHaveLength(1)
    expect(sourceLines[0].args[1]).toMatchObject({ source: 'row' })
  })
})

// ── (d) the core failing must never take the money path down ─────────────────

describe('resolveCredentials — a broken core', () => {
  it('does not throw when the core lookup fails; it warns and uses the row', async () => {
    coreLookupError = new Error('connection refused')

    const creds = await resolveCredentials(PROFILE_ID)

    expect(creds.refreshToken).toBe(ROW_REFRESH)
    expect(logged.some((l) => l.level === 'warn' && String(l.args[0]).includes('connection-core credential lookup failed'))).toBe(true)
  })

  it('does not throw when the token service throws', async () => {
    readRefreshToken.mockRejectedValueOnce(new Error('decrypt failed'))
    expect((await resolveCredentials(PROFILE_ID)).refreshToken).toBe(ROW_REFRESH)
  })

  it('still throws when NEITHER store has credentials — an absence is not a fallback', async () => {
    coreRow = null
    legacyRows = []
    await expect(resolveCredentials(PROFILE_ID)).rejects.toThrow(/no credentials for profileId=/)
  })
})

// ── (e) nothing secret is ever logged ────────────────────────────────────────

describe('resolveCredentials — logs carry no credential material', () => {
  it('never logs a token, a secret or an envelope on any path', async () => {
    // Walk every branch, then read everything that was logged.
    await resolveCredentials(PROFILE_ID)
    resetSourceLog()
    coreRow = null
    await resolveCredentials(PROFILE_ID)
    resetSourceLog()
    coreLookupError = new Error('connection refused')
    await resolveCredentials(PROFILE_ID)
    resetSourceLog()
    process.env.NEXUS_CX_ADS_CREDENTIALS = '0'
    await resolveCredentials(PROFILE_ID)

    const all = everythingLogged()
    expect(all.length).toBeGreaterThan(0) // the sweep must actually have logged something
    for (const secret of SECRETS) expect(all).not.toContain(secret)
    expect(all).not.toContain(ROW_ENVELOPE)
  })
})

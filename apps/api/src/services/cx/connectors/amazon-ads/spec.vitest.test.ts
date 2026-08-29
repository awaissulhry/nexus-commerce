/**
 * CX.3a — the Amazon Ads connector spec.
 *
 * What matters here is the reach: the live callback discovers profiles on the EU host
 * ONLY (`amazon-ads-auth.routes.ts:42`), so an NA or FE profile has never been visible
 * to this system. `discoverScopes` sweeps all three, and these tests pin that — a
 * regression to one host would silently under-report the account's reach, which is the
 * failure this whole phase exists to stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { amazonAdsSpec, ADS_REGION_HOSTS } from './spec.js'
import type { ConnectionHandle } from '../../catalog.js'

vi.mock('../../apps.service.js', () => ({
  getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.app.test', clientSecret: 's', redirectUris: [], extra: null, signingKey: null })),
}))
vi.mock('../../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const handle = (region: string | null = 'EU'): ConnectionHandle => ({
  id: 'conn-ads',
  channelKey: 'AMAZON_ADS',
  channelType: 'AMAZON_ADS',
  region,
  grantedScopes: [],
  identity: null,
  token: async () => 'access-token-value',
})

const profile = (id: string, country: string, name = 'XAVIA', accountId = 'ENTITY1') => ({
  profileId: id,
  countryCode: country,
  currencyCode: 'EUR',
  timezone: 'Europe/Rome',
  accountInfo: { id: accountId, name, type: 'seller', marketplaceStringId: `MP_${country}` },
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Answer per host so a test can give each region a different population. */
function routeByHost(map: Record<string, { status: number; body?: unknown }>) {
  fetchMock.mockImplementation(async (url: string) => {
    const entry = Object.entries(map).find(([region]) => String(url).startsWith(ADS_REGION_HOSTS[region]))
    const hit = entry ? entry[1] : { status: 404, body: [] }
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body ?? [],
    } as unknown as Response
  })
}

describe('the catalogue entry', () => {
  it('is available, and asks for exactly the scopes the live flow requests', () => {
    expect(amazonAdsSpec.available).toBe(true)
    // Asking for more than the flow requests would render a COMPLETE grant as
    // permanent drift on the Channels page.
    expect(amazonAdsSpec.auth.requiredScopes).toEqual(['profile', 'advertising::campaign_management'])
    expect(amazonAdsSpec.auth.reviewGatedScopes?.map((s) => s.scope)).toContain('advertising::audiences')
  })

  it('uses the hosts the working flow uses, not regional guesses', () => {
    expect(amazonAdsSpec.auth.authorizeUrl?.({ region: 'EU', environment: 'production' })).toBe('https://www.amazon.com/ap/oa')
    expect(amazonAdsSpec.auth.tokenUrl({ region: 'EU', environment: 'production' })).toBe('https://api.amazon.com/auth/o2/token')
  })

  it('does not rotate its refresh token and declares the 365-day life', () => {
    expect(amazonAdsSpec.auth.rotatesRefreshToken).toBe(false)
    expect(amazonAdsSpec.auth.refreshTokenLifetimeSec).toBe(365 * 86_400)
  })
})

describe('heartbeat', () => {
  it('is ok when /v2/profiles answers, and reports the latency it measured', async () => {
    routeByHost({ EU: { status: 200, body: [profile('1', 'IT')] } })
    const r = await amazonAdsSpec.heartbeat(handle())
    expect(r.ok).toBe(true)
    expect(typeof r.latencyMs).toBe('number')
    // The Ads API needs the APP's client id in its own header, never the grant's.
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>)['Amazon-Advertising-API-ClientId']).toBe('amzn1.app.test')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-value')
  })

  it('maps a 401 to a dead grant and a 429 to rate limiting, not to one vague failure', async () => {
    routeByHost({ EU: { status: 401 } })
    const unauth = await amazonAdsSpec.heartbeat(handle())
    expect(unauth.ok).toBe(false)
    if (!unauth.ok) expect(unauth.errorClass).toBe('auth_revoked')

    routeByHost({ EU: { status: 429 } })
    const limited = await amazonAdsSpec.heartbeat(handle())
    if (!limited.ok) expect(limited.errorClass).toBe('rate_limited')
  })

  it('a network failure is network, not a revoked grant — the operator must not be sent to reconnect', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const r = await amazonAdsSpec.heartbeat(handle())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorClass).toBe('network')
  })

  it('says so plainly when the token itself cannot be resolved', async () => {
    const broken = { ...handle(), token: async () => { throw new Error('needs_reauth') } }
    const r = await amazonAdsSpec.heartbeat(broken)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errorClass).toBe('auth_expired')
      expect(r.message).toContain('needs_reauth')
    }
  })
})

describe('discoverScopes — the account\'s real reach', () => {
  it('sweeps ALL three regional hosts, not EU only', async () => {
    routeByHost({
      EU: { status: 200, body: [profile('1', 'IT'), profile('2', 'DE')] },
      NA: { status: 200, body: [profile('3', 'US', 'XAVIA US', 'ENTITY2')] },
      FE: { status: 200, body: [profile('4', 'JP', 'XAVIA JP', 'ENTITY3')] },
    })
    const scopes = await amazonAdsSpec.discoverScopes!(handle())
    expect(scopes).toHaveLength(4)
    expect(scopes.map((s) => s.region).sort()).toEqual(['EU', 'EU', 'FE', 'NA'])
    expect(scopes.every((s) => s.kind === 'profile')).toBe(true)
    expect(scopes.map((s) => s.externalId).sort()).toEqual(['1', '2', '3', '4'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a region with no profiles contributes none and never fails the sweep', async () => {
    routeByHost({ EU: { status: 200, body: [profile('1', 'IT')] }, NA: { status: 403 }, FE: { status: 200, body: [] } })
    const scopes = await amazonAdsSpec.discoverScopes!(handle())
    expect(scopes).toHaveLength(1)
    expect(scopes[0].externalId).toBe('1')
  })

  it('carries the marketplace, account and currency so the scope can be read without another call', async () => {
    routeByHost({ EU: { status: 200, body: [profile('77', 'IT')] } })
    const [scope] = await amazonAdsSpec.discoverScopes!(handle())
    expect(scope.label).toBe('XAVIA · IT')
    expect(scope.metadata).toMatchObject({ marketplace: 'IT', marketplaceStringId: 'MP_IT', accountId: 'ENTITY1', currencyCode: 'EUR' })
    // Discovery measures PRESENCE at the channel. Whether we write to a profile is the
    // operator's mode/writes decision and lives in the write gate — never inferred here.
    expect(scope.isActive).toBe(true)
  })

  it('returns nothing rather than throwing when every region refuses', async () => {
    routeByHost({ EU: { status: 500 }, NA: { status: 500 }, FE: { status: 500 } })
    await expect(amazonAdsSpec.discoverScopes!(handle())).resolves.toEqual([])
  })
})

describe('identity', () => {
  it('is the advertising ACCOUNT, not a profile — a profile is a market within it', async () => {
    routeByHost({ EU: { status: 200, body: [profile('1', 'IT'), profile('2', 'DE')] } })
    const id = await amazonAdsSpec.identity(handle())
    expect(id?.userId).toBe('ENTITY1')
    expect(id?.username).toBe('XAVIA')
    expect(id?.extra).toMatchObject({ profileCount: 2 })
  })

  it('is null when the account cannot be read, rather than a guess', async () => {
    routeByHost({ EU: { status: 200, body: [] } })
    await expect(amazonAdsSpec.identity(handle())).resolves.toBeNull()
  })

  it('follows the connection\'s own region', async () => {
    routeByHost({ NA: { status: 200, body: [profile('9', 'US', 'XAVIA US', 'ENTITY9')] } })
    const id = await amazonAdsSpec.identity(handle('NA'))
    expect(id?.userId).toBe('ENTITY9')
    expect(String(fetchMock.mock.calls[0][0]).startsWith(ADS_REGION_HOSTS.NA)).toBe(true)
  })
})

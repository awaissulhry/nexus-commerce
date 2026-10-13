/**
 * Google — the catalogue entry, its heartbeat (userinfo through the gateway) and its discovery: Google Ads
 * accounts (direct + under managers, capped), Merchant Center accounts and Analytics properties, each
 * product failing on its own in words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  routes: new Map<string, (init: RequestInit, url: string) => Response>(),
  connection: null as Record<string, any> | null,
  updates: [] as Array<Record<string, any>>,
}))
vi.mock('../../../gateway/account.js', () => import('../../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../../gateway/ledger.js', () => import('../../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../../../../db.js', () => ({
  default: {
    channelConnection: {
      findUnique: vi.fn(async ({ where }: any) => (h.connection && h.connection.id === where.id ? { ...h.connection } : null)),
      update: vi.fn(async ({ where, data }: any) => { h.updates.push({ id: where.id, ...data }); Object.assign(h.connection!, data); return h.connection }),
    },
  },
}))

import { withWorkspace } from '@nexus/database/workspace-context'
import { gatewayLedger } from '../../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../../gateway/rate.js'
import { GOOGLE_ADS_API_BASE } from '../../../google/api-version.js'
import { markQuotaExhausted, opsUsedLast24h, reserveOps, setOpsBudgetRedisForTests, type OpsRedis } from '../../../marketing/google-ads/ops-budget.js'
import { scopeDriftOf } from '../../catalog.js'
import { RefreshFailed } from '../../token.service.js'
import { googleSpec, GOOGLE_USERINFO_URL } from './spec.js'
import { DISCOVERY_ADS_OPS, discoverGoogleChoices, discoverGoogleScopes, GoogleConnectionNotFound, MAX_DIRECT_DETAILS } from './discovery.js'
import { GOOGLE_REQUIRED_SCOPES } from './scopes.js'

const ALL_SCOPES = [...GOOGLE_REQUIRED_SCOPES]
const LIST = `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`
const MERCHANT = 'https://merchantapi.googleapis.com/accounts/v1/accounts'
const GA4 = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200'
const searchUrl = (id: string) => `${GOOGLE_ADS_API_BASE}/customers/${id}/googleAds:search`
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
/** A 429 that asks for no wait (the gateway's own retry of a 429 then does not sleep). */
const NO_WAIT = { 'retry-after': '0' }
const customer = (id: string, over: Record<string, unknown> = {}) => json({ results: [{ customer: { resourceName: `customers/${id}`, id, descriptiveName: `Account ${id.slice(-2)}`, currencyCode: 'EUR', timeZone: 'Europe/Rome', manager: false, testAccount: false, status: 'ENABLED', ...over } }] })
const headerOf = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name]
const handle = () => ({ id: 'g-1', channelKey: 'GOOGLE' as const, channelType: 'GOOGLE', region: null, grantedScopes: ALL_SCOPES, identity: { userId: 'sub-1' }, token: async () => 'google-access-token' })
// Production runs with business profiles ON: every call runs inside the business that owns the connection ('ws'),
// as a request, the connect callback and the heartbeat sweep do. With profiles OFF the context changes nothing.
const BUSINESS = { workspaceId: 'ws', actorUserId: null, membershipId: null, roleKeys: [] as string[] }
const inBusiness = <T>(work: () => Promise<T>): Promise<T> => withWorkspace(BUSINESS, work)

/** The daily Google Ads allowance's Redis, in memory (the commands ops-budget uses). */
class FakeOpsRedis implements OpsRedis {
  status = 'ready'
  readonly values = new Map<string, string>()
  async incrby(key: string, n: number) { const v = Number(this.values.get(key) ?? 0) + n; this.values.set(key, String(v)); return v }
  async decrby(key: string, n: number) { const v = Number(this.values.get(key) ?? 0) - n; this.values.set(key, String(v)); return v }
  async expire() { return 1 }
  async mget(...keys: string[]) { return keys.map((k) => this.values.get(k) ?? null) }
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value); return 'OK' }
}
let opsRedis: FakeOpsRedis
const adsCalls = () => h.calls.filter((c) => c.url.startsWith(GOOGLE_ADS_API_BASE))

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.routes.clear(); h.updates = []; gatewayLedger.length = 0
  opsRedis = new FakeOpsRedis()
  setOpsBudgetRedisForTests(opsRedis)
  // The REAL token service reads this row: a live, unexpired access token (no refresh, no network).
  // (A mocked token service is not used: vitest hands concurrent lazy imports of a mocked module the real one.)
  h.connection = {
    id: 'g-1', workspaceId: 'ws', channelType: 'GOOGLE', managedBy: 'oauth', isActive: true, authStatus: 'connected',
    grantedScopes: ALL_SCOPES, connectionMetadata: { environment: 'production' },
    credentialsEnc: null, accessToken: 'google-access-token', refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null,
    tokenExpiresAt: new Date(Date.now() + 3_600_000), ebayTokenExpiresAt: null, refreshTokenExpiresAt: null,
  }
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const route = h.routes.get(String(url))
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return route(init, String(url))
  }))
  // Defaults: one direct live account, one Merchant account, one GA4 property.
  h.routes.set(LIST, () => json({ resourceNames: ['customers/1111111111'] }))
  h.routes.set(searchUrl('1111111111'), () => customer('1111111111'))
  h.routes.set(MERCHANT, () => json({ accounts: [{ name: 'accounts/555', accountId: '555', accountName: 'Shop feed' }] }))
  h.routes.set(GA4, () => json({ accountSummaries: [{ name: 'accountSummaries/9', account: 'accounts/9', displayName: 'Web', propertySummaries: [{ property: 'properties/777', displayName: 'Shop GA4', propertyType: 'PROPERTY_TYPE_ORDINARY', parent: 'accounts/9' }] }] }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); setOpsBudgetRedisForTests(undefined) })

describe('the Google catalogue entry', () => {
  it('asks for the five permissions in Google\'s long form, offline + consent, PKCE, body auth', () => {
    expect(googleSpec.auth.requiredScopes).toEqual([
      'https://www.googleapis.com/auth/adwords',
      'https://www.googleapis.com/auth/content',
      'https://www.googleapis.com/auth/analytics.readonly',
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
    ])
    expect(googleSpec.auth.authorizationParams).toEqual({ response_type: 'code', access_type: 'offline', prompt: 'consent' })
    expect(googleSpec.auth).toMatchObject({ pkce: true, tokenRequestAuth: 'body', scopeSeparator: ' ', refreshTokenRequired: true, identityRequired: true, rotatesRefreshToken: false, accessTokenLifetimeSec: 3600, refreshTokenLifetimeSec: null })
    expect(googleSpec.auth.authorizeUrl!({ region: null, environment: 'production' })).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(googleSpec.auth.tokenUrl({ region: null, environment: 'production' })).toBe('https://oauth2.googleapis.com/token')
    // One Google login may be connected in many businesses: Disconnect never revokes at Google (it would stop them all).
    expect(googleSpec.auth.revokeUrl).toBeUndefined()
    expect(googleSpec.auth.revokeHint).toMatchObject({ url: 'https://myaccount.google.com/connections' })
    expect(googleSpec.auth.revokeHint!.detail).toContain('other businesses')
    expect(googleSpec).toMatchObject({ key: 'GOOGLE', channelType: 'GOOGLE', available: true, discoverOnHeartbeat: false, sandbox: { available: false } })
  })

  it('a grant that left Analytics unticked shows as scope drift (Google echoes the long form)', () => {
    const granted = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/content'.split(' ')
    expect(scopeDriftOf(googleSpec, granted)).toEqual(['https://www.googleapis.com/auth/analytics.readonly'])
    expect(scopeDriftOf(googleSpec, ALL_SCOPES)).toEqual([])
  })
})

describe('the Google heartbeat: userinfo through the gateway', () => {
  it('ok → the Google account id and email; one GOOGLE ledger row; no discovery', async () => {
    h.routes.set(GOOGLE_USERINFO_URL, () => json({ sub: 'sub-1', email: 'owner@example.test', email_verified: true }))
    const result = await inBusiness(() => googleSpec.heartbeat(handle()))
    expect(result).toMatchObject({ ok: true, identity: { userId: 'sub-1', username: 'owner@example.test' } })
    expect(h.calls.map((c) => c.url)).toEqual([GOOGLE_USERINFO_URL])
    expect(headerOf(h.calls[0].init, 'Authorization')).toBe('Bearer google-access-token')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'identity.userinfo', success: true })])
  })
  it('a 401 from Google → a dead grant (needs a reconnect)', async () => {
    h.routes.set(GOOGLE_USERINFO_URL, () => json({ error: 'invalid_request', error_description: 'Invalid Credentials' }, 401))
    expect(await inBusiness(() => googleSpec.heartbeat(handle()))).toMatchObject({ ok: false, errorClass: 'auth_revoked', status: 401 })
  })
  it('a refresh Google refused keeps its class, and nothing is sent', async () => {
    const result = await inBusiness(() => googleSpec.heartbeat({ ...handle(), token: async () => { throw new (RefreshFailed as any)('g-1', 'auth_revoked', 'Token refresh failed with 400') } }))
    expect(result).toMatchObject({ ok: false, errorClass: 'auth_revoked' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('discoverGoogleChoices', () => {
  it('reads the three products: direct Ads accounts with their details, Merchant accounts, GA4 properties', async () => {
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(choices).toEqual({
      missingProducts: [],
      ads: { customers: [{ customerId: '1111111111', name: 'Account 11', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false, direct: true, managers: [] }], error: null },
      merchantCenter: { accounts: [{ id: '555', name: 'Shop feed' }], error: null },
      analytics: { properties: [{ propertyId: '777', name: 'Shop GA4', accountName: 'Web' }], error: null },
    })
    const search = h.calls.find((c) => c.url === searchUrl('1111111111'))!
    expect(search.init.method).toBe('POST')
    expect(JSON.parse(String(search.init.body)).query).toMatch(/FROM customer\b/)
    expect(headerOf(search.init, 'login-customer-id')).toBeUndefined()
    expect(gatewayLedger.every((r) => r.channel === 'GOOGLE' && r.outcome === 'sent')).toBe(true)
    // What was found is recorded on the connection, counts and errors only.
    expect(h.connection!.connectionMetadata).toMatchObject({ environment: 'production', googleDiscovery: { ads: { count: 1, error: null }, merchantCenter: { count: 1, error: null }, analytics: { count: 1, error: null } } })
  })

  it('managers: never offered as the Ads account; the accounts under them come with the manager path', async () => {
    h.routes.set(LIST, () => json({ resourceNames: ['customers/1111111111', 'customers/9999999999'] }))
    h.routes.set(searchUrl('9999999999'), (init) => JSON.parse(String(init.body)).query.includes('customer_client')
      ? json({ results: [
        { customerClient: { id: '9999999999', descriptiveName: 'Agency MCC', manager: true, level: '0', status: 'ENABLED' } },
        { customerClient: { id: '2222222222', descriptiveName: 'Client B', currencyCode: 'GBP', timeZone: 'Europe/London', manager: false, testAccount: false, level: '1', status: 'ENABLED' } },
        { customerClient: { id: '1111111111', descriptiveName: 'Account 11', currencyCode: 'EUR', timeZone: 'Europe/Rome', manager: false, level: '1', status: 'ENABLED' } },
        { customerClient: { id: '3333333333', descriptiveName: 'Closed', manager: false, level: '1', status: 'CANCELED' } },
        { customerClient: { id: '4444444444', descriptiveName: 'Sub MCC', manager: true, level: '1', status: 'ENABLED' } },
      ] })
      : customer('9999999999', { descriptiveName: 'Agency MCC', manager: true }))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    const mcc = { customerId: '9999999999', name: 'Agency MCC' }
    expect(choices.ads.customers).toEqual([
      { customerId: '1111111111', name: 'Account 11', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false, direct: true, managers: [mcc] },
      { customerId: '2222222222', name: 'Client B', currency: 'GBP', timeZone: 'Europe/London', isTest: false, direct: false, managers: [mcc] },
    ])
    const clientRead = h.calls.filter((c) => c.url === searchUrl('9999999999')).find((c) => String(c.init.body).includes('customer_client'))!
    expect(headerOf(clientRead.init, 'login-customer-id')).toBe('9999999999')
    expect(JSON.parse(String(clientRead.init.body)).query).toMatch(/customer_client\.level <= 1/)
  })

  it(`reads the details of at most ${MAX_DIRECT_DETAILS} direct accounts; the rest are listed by id`, async () => {
    const ids = Array.from({ length: 23 }, (_, i) => String(1000000000 + i))
    h.routes.set(LIST, () => json({ resourceNames: ids.map((id) => `customers/${id}`) }))
    for (const id of ids) h.routes.set(searchUrl(id), () => customer(id))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(h.calls.filter((c) => c.url.endsWith('googleAds:search'))).toHaveLength(MAX_DIRECT_DETAILS)
    expect(choices.ads.customers).toHaveLength(23)
    expect(choices.ads.customers.filter((c) => c.name === null).map((c) => c.customerId)).toEqual(ids.slice(MAX_DIRECT_DETAILS))
  })

  it('Merchant Center "project not registered" (401) is said in words; Ads and Analytics are untouched', async () => {
    h.routes.set(MERCHANT, () => json({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'GCP project with id nexus and number 1 is not registered with the merchant account.' } }, 401))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(choices.merchantCenter).toEqual({ accounts: [], error: { code: 'not_registered', message: expect.stringMatching(/not registered the Nexus Google Cloud project/) } })
    expect(choices.ads.customers).toHaveLength(1)
    expect(choices.ads.error).toBeNull()
    expect(choices.analytics.properties).toHaveLength(1)
  })

  it('a Cloud project with test access only: the live account is refused → app_not_approved, test accounts still listed', async () => {
    h.routes.set(LIST, () => json({ resourceNames: ['customers/1111111111', 'customers/5555555555'] }))
    h.routes.set(searchUrl('1111111111'), () => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'outer', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'not approved' }] }] } }, 403))
    h.routes.set(searchUrl('5555555555'), () => customer('5555555555', { testAccount: true }))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(choices.ads.customers.map((c) => [c.customerId, c.isTest])).toEqual([['5555555555', true]])
    expect(choices.ads.error).toMatchObject({ code: 'app_not_approved' })
  })

  it('a product whose permission was not ticked is not asked at all', async () => {
    h.connection!.grantedScopes = ALL_SCOPES.filter((s) => !s.endsWith('analytics.readonly'))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(choices.missingProducts).toEqual(['analytics'])
    expect(choices.analytics).toEqual({ properties: [], error: { code: 'permission_missing', message: expect.stringMatching(/tick the Google Analytics box/) } })
    expect(h.calls.some((c) => c.url.startsWith('https://analyticsadmin'))).toBe(false)
    expect(choices.ads.customers).toHaveLength(1)
  })

  it('the API switched off in the Cloud project, a login without Ads, and Google down — each in words', async () => {
    h.routes.set(GA4, () => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Analytics Admin API has not been used', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }, 403))
    h.routes.set(LIST, () => json({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'outer', details: [{ errors: [{ errorCode: { authenticationError: 'NOT_ADS_USER' }, message: 'not an ads user' }] }] } }, 401))
    h.routes.set(MERCHANT, () => json({ error: { code: 503, status: 'UNAVAILABLE', message: 'later' } }, 503))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(choices.analytics.error).toMatchObject({ code: 'app_not_approved', message: expect.stringMatching(/Google Analytics Admin API is not switched on/) })
    expect(choices.ads).toEqual({ customers: [], error: { code: 'no_access', message: 'This Google login has no Google Ads account.' } })
    expect(choices.merchantCenter.error).toMatchObject({ code: 'google_unavailable' })
  })

  it('only Google connections of this business', async () => {
    await expect(inBusiness(() => discoverGoogleChoices('other'))).rejects.toBeInstanceOf(GoogleConnectionNotFound)
    h.connection!.channelType = 'EBAY'
    await expect(inBusiness(() => discoverGoogleChoices('g-1'))).rejects.toBeInstanceOf(GoogleConnectionNotFound)
  })

  it('as ConnectionScope rows: one per Ads account, Merchant account and GA4 property', async () => {
    const scopes = await inBusiness(() => discoverGoogleScopes(handle()))
    expect(scopes.map((s) => [s.kind, s.externalId, s.label])).toEqual([
      ['google_ads_customer', '1111111111', 'Account 11'],
      ['google_merchant_account', '555', 'Shop feed'],
      ['google_ga4_property', '777', 'Shop GA4'],
    ])
  })
})

describe('the daily Google Ads allowance (shared with the daily reads)', () => {
  /** Operations counted in the global hourly buckets right now. */
  const counted = () => [...opsRedis.values.entries()]
    .filter(([key]) => /^nexus:gads:ops:\d{10}$/.test(key))
    .reduce((total, [, value]) => total + Number(value), 0)

  it('reserves the most a discovery can spend before the first Google Ads call, and gives back what it did not spend', async () => {
    let countedAtFirstCall: number | null = null
    h.routes.set(LIST, () => { countedAtFirstCall = counted(); return json({ resourceNames: ['customers/1111111111'] }) })
    await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(countedAtFirstCall).toBe(DISCOVERY_ADS_OPS)
    expect(adsCalls()).toHaveLength(2) // the list and one account's details
    expect(counted()).toBe(2)
    expect(await opsUsedLast24h(null)).toEqual({ global: 2, account: null })
  })

  it(`the most: the list, ${MAX_DIRECT_DETAILS} account details — every one counted`, async () => {
    const ids = Array.from({ length: 23 }, (_, i) => String(1000000000 + i))
    h.routes.set(LIST, () => json({ resourceNames: ids.map((id) => `customers/${id}`) }))
    for (const id of ids) h.routes.set(searchUrl(id), () => customer(id))
    await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(counted()).toBe(1 + MAX_DIRECT_DETAILS)
  })

  it('used up: no Google Ads call; the Ads section says so and when to try again; Merchant Center and Analytics still answer', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_DAILY_OPS', '30')
    opsRedis.values.set(`nexus:gads:ops:${new Date().toISOString().slice(0, 13).replace(/[-T]/g, '')}`, '10')
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(adsCalls()).toHaveLength(0)
    expect(choices.ads).toEqual({ customers: [], error: { code: 'google_unavailable', message: expect.stringMatching(/^Nexus did not ask Google Ads: its daily Google allowance is used up \(10 of 30 Google Ads operations in the last 24 hours; this can take up to 26\)\. Try again after \d\d:00 UTC on \d{1,2} [A-Z][a-z]+\.$/) } })
    expect(choices.merchantCenter.accounts).toHaveLength(1)
    expect(choices.analytics.properties).toHaveLength(1)
    expect(counted()).toBe(10)
  })

  it('Google said the allowance is used up: no Google Ads call until the hold ends, and the hold\'s end is said', async () => {
    const now = new Date()
    await markQuotaExhausted(now, 30 * 60_000)
    const until = new Date(now.getTime() + 30 * 60_000).toISOString().slice(11, 16)
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(adsCalls()).toHaveLength(0)
    expect(choices.ads.error).toEqual({ code: 'google_unavailable', message: expect.stringContaining(`Google said Nexus has used up its daily Google allowance. Try again after ${until} UTC on`) })
  })

  it('an allowance nobody can count is not spent: Redis down → no Google Ads call, said in words', async () => {
    setOpsBudgetRedisForTests(null)
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(adsCalls()).toHaveLength(0)
    expect(choices.ads.error).toEqual({ code: 'google_unavailable', message: 'Nexus did not ask Google Ads: it cannot count its daily Google Ads allowance right now. Try again in a few minutes.' })
    expect(choices.merchantCenter.error).toBeNull()
  })

  it('no Google Ads permission: nothing reserved', async () => {
    h.connection!.grantedScopes = ALL_SCOPES.filter((scope) => !scope.endsWith('/adwords'))
    await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(counted()).toBe(0)
  })

  /** The gateway's own rate bucket, always open: a 429 drains it for 30 s, and these tests are about the allowance. */
  const openBucket = () => __rateTest.useRedis({ status: 'ready', eval: async () => [1, '30', 0], hset: async () => 1, hgetall: async () => ({}), pexpire: async () => 1 })

  it('Google answers RESOURCE_EXHAUSTED: every reservation is held (as the daily read does) and this discovery asks Google Ads nothing more', async () => {
    openBucket()
    // Google's own 429 for a used-up day (the test-support fixture's shape): a GoogleAdsFailure with quotaError RESOURCE_EXHAUSTED.
    const exhausted = () => json({ error: { code: 429, message: 'Too many requests.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, message: 'Number of operations exceeded.' }], requestId: 'test-request-1' }] } }, 429, NO_WAIT)
    const ids = Array.from({ length: 6 }, (_, i) => String(1000000000 + i))
    h.routes.set(LIST, () => json({ resourceNames: ids.map((id) => `customers/${id}`) }))
    for (const id of ids) h.routes.set(searchUrl(id), exhausted)
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    // The first wave (4 at a time) was already on its way; the accounts after it are never asked.
    const asked = adsCalls().map((c) => c.url)
    expect(asked).toHaveLength(5) // the list + the first 4 accounts, each once (no gateway retry of the 429)
    expect(asked).not.toContain(searchUrl(ids[4]))
    expect(asked).not.toContain(searchUrl(ids[5]))
    expect(choices.ads).toEqual({ customers: [], error: { code: 'google_unavailable', message: expect.stringMatching(/^Google said Nexus has used up its daily Google Ads allowance\. Try again after \d\d:\d\d UTC on \d{1,2} [A-Z][a-z]+\.$/) } })
    expect(choices.merchantCenter.accounts).toHaveLength(1)
    // markQuotaExhausted: the next reservation is refused for Google's reason, and the next discovery sends nothing.
    expect(await reserveOps(null, 1)).toMatchObject({ ok: false, reason: 'quota_exhausted' })
    h.calls = []
    const again = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(adsCalls()).toHaveLength(0)
    expect(again.ads.error?.message).toMatch(/^Nexus did not ask Google Ads: Google said Nexus has used up its daily Google allowance/)
  })

  it('a short-term slow-down (RESOURCE_TEMPORARILY_EXHAUSTED) is not a used-up day: nothing is held', async () => {
    openBucket()
    h.routes.set(LIST, () => json({ error: { code: 429, message: 'Too many requests.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' }, message: 'Too many requests in a short amount of time.' }] }] } }, 429, NO_WAIT))
    const choices = await inBusiness(() => discoverGoogleChoices('g-1'))
    expect(choices.ads.error?.code).toBe('google_unavailable')
    expect(choices.ads.error?.message).not.toMatch(/used up/)
    expect(adsCalls()).toHaveLength(1) // a 429 of Google Ads is not retried by the gateway: each ask spends an operation
    expect(await reserveOps(null, 1)).toMatchObject({ ok: true })
  })
})

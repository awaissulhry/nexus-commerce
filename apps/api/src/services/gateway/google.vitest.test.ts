/**
 * Google on the gateway: reads, and one kind of change (a Google Ads mutate, 2026-10-15), the account's Bearer token, the
 * optional headers only when they apply, one ledger row per call (refusals included), a rate bucket per
 * Google API, and Google's error envelope classified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest, defaultsFor, GOOGLE_BUCKETS, bucketKey } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { googleCall, googleKind } from './google.js'
import { apiVersionOf, bucketGroupOf, publishModeOf } from './channels.js'
import { classifyChannelAnswer } from './vocabulary.js'
import { ledgerSafeBody } from './redact.js'
import { googleRateReading } from '../cx/rate-readings.js'
import { GOOGLE_ADS_API_BASE, GOOGLE_ADS_API_VERSION } from '../google/api-version.js'

const SEARCH = `${GOOGLE_ADS_API_BASE}/customers/1234567890/googleAds:search`
const MUTATE = `${GOOGLE_ADS_API_BASE}/customers/1234567890/campaigns:mutate`
const headersOf = (i = 0) => h.calls[i].init.headers as Record<string, string>

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ results: [] }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('Google: reads, and Google Ads mutates only', () => {
  it('a GAQL search (POST …:search) is a read: sent once, Bearer token, JSON body, one GOOGLE ledger row', async () => {
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: { query: 'SELECT customer.id FROM customer' } })
    expect(res.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('POST')
    expect(headersOf()).toMatchObject({ Authorization: 'Bearer google-access-token', 'Content-Type': 'application/json' })
    expect(h.calls[0].init.body).toBe('{"query":"SELECT customer.id FROM customer"}')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', connectionId: 'g-1', operation: 'ads.search', outcome: 'sent', success: true, apiVersion: GOOGLE_ADS_API_VERSION })])
  })

  it('a Google Ads mutate is a write: sent once (never retried), its ledger row, under the publish mode', async () => {
    h.answers.push(() => new Response('{}', { status: 503 }))
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { operations: [] } })
    expect(res.status).toBe(503)
    expect(h.calls).toHaveLength(1)
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.mutate', outcome: 'sent', success: false })])
    expect(publishModeOf('GOOGLE')).toBe('live')
  })

  it('NEXUS_GOOGLE_ADS_WRITES=off: a real mutate is refused before anything is sent; a validate-only check still goes', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    expect(publishModeOf('GOOGLE')).toBe('gated')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { operations: [] } }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { operations: [], validateOnly: true } })
    expect(check.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['gated', 'sent'])
  })

  it('every other Google change is refused before anything is sent, with its one ledger row', async () => {
    const register = await googleCall({ connectionId: 'g-1', operation: 'merchant.registerGcp', method: 'POST', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts/1/developerRegistration:registerGcp', body: {} }).catch((e) => e)
    expect(register).toBeInstanceOf(GatewayRefusal)
    expect(register).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY', statusCode: 403 })
    expect(register.message).toMatch(/^Nothing was sent to Google/)
    const merchantMutate = await googleCall({ connectionId: 'g-1', operation: 'merchant.x', method: 'POST', url: 'https://merchantapi.googleapis.com/v1/customers/1/products:mutate', body: {} }).catch((e) => e)
    expect(merchantMutate).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const withQuery = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: `${MUTATE}?x=1`, body: {} }).catch((e) => e)
    expect(withQuery).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toEqual([0, 1, 2].map(() => expect.objectContaining({ channel: 'GOOGLE', outcome: 'refused', errorCode: 'GOOGLE_READ_ONLY', success: false, statusCode: null })))
  })

  it('a change declared as a read is still refused (the gateway checks the method, path and body too)', async () => {
    const err = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: MUTATE, method: 'POST', body: '{}' }).catch((e) => e)
    expect(err).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const notReallyCheck = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: MUTATE, method: 'POST', body: '{"validateOnly":"true"}' }).catch((e) => e)
    expect(notReallyCheck).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const put = await gatewayCall({ channel: 'GOOGLE', operation: 'merchant.put', kind: 'read', connectionId: 'g-1', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts/1', method: 'PATCH', body: '{}' }).catch((e) => e)
    expect(put).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const writeSearch = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.search', kind: 'write', connectionId: 'g-1', url: SEARCH, method: 'POST', body: '{}' }).catch((e) => e)
    expect(writeSearch).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger.map((r) => r.errorCode)).toEqual(['GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY'])
  })

  it('googleKind: GET, …:search / …:searchStream and a validate-only Ads mutate read; a real Ads mutate writes; the rest is refused', () => {
    expect(googleKind('GET', `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`)).toBe('read')
    expect(googleKind('POST', SEARCH)).toBe('read')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/1/googleAds:searchStream`)).toBe('read')
    expect(googleKind('POST', 'https://merchantapi.googleapis.com/reports/v1/accounts/1/reports:search')).toBe('read')
    expect(googleKind('POST', MUTATE, { operations: [] })).toBe('write')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/1/googleAds:mutate`, { mutateOperations: [], validateOnly: true })).toBe('read')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/1/googleAds:mutate`, { mutateOperations: [], validateOnly: false })).toBe('write')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/abc/googleAds:mutate`)).toBe('action')
    expect(googleKind('POST', `${SEARCH}x`)).toBe('action')
    expect(googleKind('DELETE', SEARCH)).toBe('action')
  })

  it('an account that needs sign-in is held, not called', async () => {
    gatewayAccounts['g-2'] = { authStatus: 'needs_reauth', isActive: true, displayName: 'Google' }
    const err = await googleCall({ connectionId: 'g-2', operation: 'ads.search', method: 'POST', url: SEARCH, body: {} }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'held', code: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('Google headers', () => {
  it('no developer-token and no login-customer-id unless they apply', async () => {
    await googleCall({ connectionId: 'g-1', operation: 'ads.listAccessibleCustomers', method: 'GET', url: `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers` })
    const names = Object.keys(headersOf()).map((k) => k.toLowerCase())
    expect(names).not.toContain('developer-token')
    expect(names).not.toContain('login-customer-id')
    expect(names).not.toContain('content-type')
  })

  it('developer-token only when GOOGLE_ADS_DEVELOPER_TOKEN is set, and only to the Google Ads host', async () => {
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'dev-token-fixture')
    await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {} })
    await googleCall({ connectionId: 'g-1', operation: 'merchant.accounts.list', method: 'GET', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts' })
    expect(headersOf(0)['developer-token']).toBe('dev-token-fixture')
    expect(headersOf(1)['developer-token']).toBeUndefined()
  })

  it('login-customer-id when given: digits only (dashes dropped); a malformed id is refused before sending', async () => {
    await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {}, loginCustomerId: '111-222-3333' })
    expect(headersOf()['login-customer-id']).toBe('1112223333')
    await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {}, loginCustomerId: null })
    expect(headersOf(1)['login-customer-id']).toBeUndefined()
    await expect(googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {}, loginCustomerId: '12; drop' })).rejects.toThrow(/digits only/)
    expect(h.calls).toHaveLength(2)
  })

  it('the ledger keeps the host and path, never the query string', async () => {
    await googleCall({ connectionId: 'g-1', operation: 'analytics.accountSummaries.list', method: 'GET', url: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200&pageToken=secret-ish' })
    expect(gatewayLedger[0]).toMatchObject({ endpoint: 'analyticsadmin.googleapis.com/v1beta/accountSummaries', apiVersion: 'v1beta' })
    expect(JSON.stringify(gatewayLedger[0])).not.toMatch(/pageToken/)
  })
})

describe('Google rate buckets: one per API (host)', () => {
  it('groups by host and starts each with its own defaults', () => {
    expect(bucketGroupOf('GOOGLE', 'POST', SEARCH)).toBe('ads')
    expect(bucketGroupOf('GOOGLE', 'GET', 'https://merchantapi.googleapis.com/accounts/v1/accounts')).toBe('merchant')
    expect(bucketGroupOf('GOOGLE', 'GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries')).toBe('analytics')
    expect(bucketGroupOf('GOOGLE', 'GET', 'https://openidconnect.googleapis.com/v1/userinfo')).toBe('identity')
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'ads'))).toEqual(GOOGLE_BUCKETS.ads)
    expect(GOOGLE_BUCKETS.ads).toEqual({ capacity: 60, refillPerSec: 1 / 30 })
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'merchant'))).toEqual({ capacity: 10, refillPerSec: 2 })
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'analytics'))).toEqual({ capacity: 10, refillPerSec: 1 })
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'identity'))).toEqual({ capacity: 5, refillPerSec: 1 })
  })

  it('a 429 is retried once by default (not twice), and reads its Retry-After', async () => {
    h.answers.push(
      () => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }),
      () => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }),
      () => new Response('{}', { status: 200 }),
    )
    const res = await googleCall({ connectionId: 'g-1', operation: 'merchant.accounts.list', method: 'GET', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts' })
    expect(res.status).toBe(429)
    expect(h.calls).toHaveLength(2)
    expect(gatewayLedger[0]).toMatchObject({ success: false, errorClass: 'rate_limited', errorCode: 'RESOURCE_EXHAUSTED', attempts: 2 })
    expect(googleRateReading(new Headers({ 'retry-after': '7' }), 429)).toEqual({ model: 'token_bucket', retryAfterSec: 7 })
    expect(googleRateReading(new Headers(), 200)).toBeNull()
  })
})

describe('Google error classes', () => {
  const adsFailure = (status: number, googleStatus: string, errorCode: Record<string, string>, message = 'm') => JSON.stringify({
    error: { code: status, status: googleStatus, message: 'outer', details: [{ '@type': `type.googleapis.com/google.ads.googleads.${GOOGLE_ADS_API_VERSION}.errors.GoogleAdsFailure`, errors: [{ errorCode, message }] }] },
  })
  it.each([
    [403, adsFailure(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' }, 'no access'), 'forbidden', 'USER_PERMISSION_DENIED'],
    [403, adsFailure(403, 'PERMISSION_DENIED', { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }), 'configuration', 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'],
    [401, adsFailure(401, 'UNAUTHENTICATED', { authenticationError: 'NOT_ADS_USER' }), 'auth_expired', 'NOT_ADS_USER'],
    [400, adsFailure(400, 'INVALID_ARGUMENT', { queryError: 'UNRECOGNIZED_FIELD' }), 'validation', 'UNRECOGNIZED_FIELD'],
    [429, adsFailure(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_EXHAUSTED' }), 'rate_limited', 'RESOURCE_EXHAUSTED'],
    [401, JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'GCP project with id p and number 1 is not registered with the merchant account.' } }), 'configuration', 'UNAUTHENTICATED'],
    [403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API not used', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }), 'configuration', 'SERVICE_DISABLED'],
    [403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'scopes', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), 'forbidden', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    [400, JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), 'auth_revoked', 'invalid_grant'],
    [503, JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'try later' } }), 'transient', 'UNAVAILABLE'],
  ])('%i → %s (%s)', (status, body, cls, code) => {
    const v = classifyChannelAnswer('GOOGLE', status, body)
    expect(v).toMatchObject({ errorClass: cls, channelCode: code })
  })
  it('keeps the Google Ads error sentence, not the outer wrapper', () => {
    expect(classifyChannelAnswer('GOOGLE', 403, adsFailure(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' }, "User doesn't have permission")).channelMessage).toBe("User doesn't have permission")
  })
})

describe('ledger redaction of form-encoded credentials', () => {
  it('masks token, secret and code values; keeps the rest', () => {
    const safe = ledgerSafeBody('grant_type=refresh_token&refresh_token=fixture-refresh-value&client_id=abc.apps.googleusercontent.com&client_secret=fixture-client-secret&code=fixture-code&code_verifier=verif&postal_code=20100')
    expect(safe).toBe('grant_type=refresh_token&refresh_token=[redacted]&client_id=abc.apps.googleusercontent.com&client_secret=[redacted]&code=[redacted]&code_verifier=[redacted]&postal_code=20100')
    expect(ledgerSafeBody('access_token=fixture.x&id_token=eyJ.y&token_type=Bearer')).toBe('access_token=[redacted]&id_token=[redacted]&token_type=Bearer')
  })
  it('api version: v25 for Google Ads, v1 for Merchant, v1beta for Analytics Admin', () => {
    expect(apiVersionOf('GOOGLE', SEARCH)).toBe('v25')
    expect(apiVersionOf('GOOGLE', 'https://merchantapi.googleapis.com/accounts/v1/accounts')).toBe('v1')
    expect(apiVersionOf('GOOGLE', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries')).toBe('v1beta')
  })
})

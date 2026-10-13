/**
 * Google Ads step 1a — the read client, through the REAL channel gateway and googleCall (only the account state,
 * the ledger, the token and `fetch` are stand-ins): the v25 search URL, `{ query, pageToken }`, login-customer-id
 * only with a manager, no developer-token unless the env sets one, pages in order, one operation per query, every
 * call a read on the ledger; the retry rules (transient 5 / 10 / 20 s, slow down once after ≥ 30 s, the day's
 * allowance never retried, an expired page token restarts once).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import { googleKind } from '../../gateway/google.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { GoogleAdsReadError } from './errors.js'
import { CAMPAIGNS_QUERY, CUSTOMER_QUERY } from './gaql.js'
import { setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { listAccessibleCustomers, searchAll, searchRows } from './read-client.js'
import type { GoogleAdsCampaignRow, GoogleAdsTarget } from './types.js'

const raw = (name: string) => readFileSync(new URL(`../../../test-support/google-ads/${name}`, import.meta.url), 'utf8')
const errors = JSON.parse(raw('errors.json')) as Record<string, { httpStatus: number; body: unknown }>
const ok = (name: string) => () => new Response(raw(name), { status: 200, headers: { 'request-id': 'test-ok' } })
const fail = (name: string) => () => new Response(JSON.stringify(errors[name].body), { status: errors[name].httpStatus })

const DIRECT: GoogleAdsTarget = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }
const VIA_MANAGER: GoogleAdsTarget = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: '987-654-3210' }
const SEARCH_URL = `${GOOGLE_ADS_API_BASE}/customers/1234567890/googleAds:search`
const headersOf = (i: number) => h.calls[i].init.headers as Record<string, string>
const bodyOf = (i: number) => JSON.parse(String(h.calls[i].init.body))

/** Records the waits instead of waiting. */
const waits: number[] = []
const sleep = async (ms: number) => { waits.push(ms) }
/**
 * The same, and the time it stands for passes for the gateway's rate bucket too: a 429 holds the account's Google
 * Ads bucket empty, and it refills one call per 30 s — which a real 30 s+ wait gives back.
 */
const sleepAndRefill = async (ms: number) => { waits.push(ms); __rateTest.useMemory() }
const noJitter = () => 0

const exhausted = new Map<string, string>()
const fakeRedis = {
  status: 'ready',
  async set(key: string, value: string) { exhausted.set(key, value); return 'OK' },
} as unknown as OpsRedis

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0; waits.length = 0; exhausted.clear()
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  setOpsBudgetRedisForTests(fakeRedis)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const next = h.answers.shift()
    if (!next) throw new Error('test: no answer queued')
    return next()
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); setOpsBudgetRedisForTests(undefined); vi.useRealTimers() })

describe('searchAll', () => {
  it('v25 search URL, { query } then { query, pageToken }, pages in order, ONE operation, every call a read', async () => {
    h.answers.push(ok('search-campaigns-page-1.json'), ok('search-campaigns-page-2.json'))
    const pages: Array<[number, string[]]> = []
    const result = await searchAll<GoogleAdsCampaignRow>(DIRECT, CAMPAIGNS_QUERY, (rows, page) => { pages.push([page, rows.map((r) => r.campaign?.id ?? '')]) })
    expect(result).toEqual({ pages: 2, rows: 3, ops: 1, restarted: false })
    expect(pages).toEqual([[1, ['11111111111', '22222222222']], [2, ['33333333333']]])
    expect(h.calls.map((c) => [c.init.method, c.url])).toEqual([['POST', SEARCH_URL], ['POST', SEARCH_URL]])
    expect(SEARCH_URL).toBe('https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search')
    expect(bodyOf(0)).toEqual({ query: CAMPAIGNS_QUERY })
    expect(bodyOf(1)).toEqual({ query: CAMPAIGNS_QUERY, pageToken: 'fake-page-token-2' })
    expect(headersOf(0)).toMatchObject({ Authorization: 'Bearer google-access-token', 'Content-Type': 'application/json' })
    // Reads only: the gateway let both through (a change would be refused, GOOGLE_READ_ONLY) and wrote one row each.
    expect(googleKind('POST', SEARCH_URL)).toBe('read')
    expect(gatewayLedger).toHaveLength(2)
    for (const row of gatewayLedger) expect(row).toMatchObject({ channel: 'GOOGLE', connectionId: 'g-1', operation: 'ads.search', outcome: 'sent', success: true })
  })

  it('login-customer-id only through a manager (digits only); no developer-token unless the env sets one', async () => {
    h.answers.push(ok('search-customer.json'), ok('search-customer.json'), ok('search-customer.json'))
    await searchRows(DIRECT, CUSTOMER_QUERY)
    await searchRows(VIA_MANAGER, CUSTOMER_QUERY, { operation: 'ads.search.customer' })
    expect(Object.keys(headersOf(0)).map((k) => k.toLowerCase())).not.toContain('login-customer-id')
    expect(headersOf(1)['login-customer-id']).toBe('9876543210')
    for (const i of [0, 1]) expect(Object.keys(headersOf(i)).map((k) => k.toLowerCase())).not.toContain('developer-token')
    expect(gatewayLedger[1].operation).toBe('ads.search.customer')
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'test-developer-token')
    await searchRows(DIRECT, CUSTOMER_QUERY)
    expect(headersOf(2)['developer-token']).toBe('test-developer-token')
  })

  it('never a page size; a bad customer id sends nothing', async () => {
    h.answers.push(ok('search-campaigns-page-1.json'), ok('search-campaigns-page-2.json'))
    await searchAll(DIRECT, CAMPAIGNS_QUERY, () => {})
    for (let i = 0; i < h.calls.length; i++) expect(Object.keys(bodyOf(i)).sort()).toEqual(i === 0 ? ['query'] : ['pageToken', 'query'])
    await expect(searchAll({ ...DIRECT, customerId: '12x' }, CUSTOMER_QUERY, () => {})).rejects.toMatchObject({ failure: { code: 'INVALID_CUSTOMER_ID' } })
    await expect(searchAll({ ...DIRECT, loginCustomerId: 'manager' }, CUSTOMER_QUERY, () => {})).rejects.toBeInstanceOf(GoogleAdsReadError)
    expect(h.calls).toHaveLength(2)
  })

  it('RESOURCE_EXHAUSTED: no retry, one operation spent, every reservation stopped for an hour', async () => {
    h.answers.push(fail('quotaExhausted'))
    const error = await searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep, random: noJitter }).catch((e) => e)
    expect(error).toBeInstanceOf(GoogleAdsReadError)
    expect(error.failure).toMatchObject({ quotaExhausted: true, requestId: 'test-request-0005' })
    expect(error.opsSpent).toBe(1)
    expect(h.calls).toHaveLength(1)
    expect(waits).toEqual([])
    expect(exhausted.has('nexus:gads:quota-exhausted')).toBe(true)
    expect(gatewayLedger).toEqual([expect.objectContaining({ outcome: 'sent', success: false })])
  })

  it('a transient failure is retried after 5 s and 10 s; each first-page attempt is an operation', async () => {
    h.answers.push(fail('internal'), fail('transient'), ok('search-customer.json'))
    const result = await searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep, random: noJitter })
    expect(result).toMatchObject({ pages: 1, rows: 1, ops: 3 })
    expect(waits).toEqual([5_000, 10_000])
    expect(h.calls).toHaveLength(3)
  })

  it('a transient failure gives up after 3 retries (5 s, 10 s, 20 s, plus jitter)', async () => {
    h.answers.push(fail('internal'), fail('internal'), fail('internal'), fail('internal'))
    const error = await searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep, random: () => 0.5 }).catch((e) => e)
    expect(error.failure).toMatchObject({ retryKind: 'transient', code: 'INTERNAL_ERROR' })
    expect(error.opsSpent).toBe(4)
    expect(waits).toEqual([5_500, 10_500, 20_500])
    expect(h.calls).toHaveLength(4)
  })

  it('the waits are real timers by default (fake timers: nothing is sent again before 5 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    h.answers.push(fail('transient'), ok('search-customer.json'))
    const pending = searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { random: noJitter })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ rows: 1, ops: 2 })
    expect(h.calls).toHaveLength(2)
  })

  it('RESOURCE_TEMPORARILY_EXHAUSTED: one retry after Google\'s delay (at least 30 s), then it gives up', async () => {
    h.answers.push(fail('temporarilyExhausted'), ok('search-customer.json'))
    await expect(searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep: sleepAndRefill, random: noJitter })).resolves.toMatchObject({ ops: 2 })
    expect(waits).toEqual([45_000])
    waits.length = 0
    __rateTest.useMemory()
    h.answers.push(fail('temporarilyExhausted'), fail('temporarilyExhausted'))
    const error = await searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep: sleepAndRefill, random: noJitter }).catch((e) => e)
    expect(error.failure).toMatchObject({ retryKind: 'slow_down' })
    expect(waits).toEqual([45_000])
  })

  it('an expired page token starts the query again from page 1, once; the caller drops what it had', async () => {
    h.answers.push(ok('search-campaigns-page-1.json'), fail('expiredPageToken'), ok('search-campaigns-page-1.json'), ok('search-campaigns-page-2.json'))
    let kept: string[] = []
    const onRestart = vi.fn(() => { kept = [] })
    const result = await searchAll<GoogleAdsCampaignRow>(DIRECT, CAMPAIGNS_QUERY, (rows) => { kept.push(...rows.map((r) => r.campaign?.id ?? '')) }, { onRestart, sleep })
    expect(result).toEqual({ pages: 2, rows: 3, ops: 2, restarted: true })
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(kept).toEqual(['11111111111', '22222222222', '33333333333'])
    expect(bodyOf(2)).toEqual({ query: CAMPAIGNS_QUERY })
    // A second expiry fails.
    h.calls = []
    h.answers.push(ok('search-campaigns-page-1.json'), fail('expiredPageToken'), ok('search-campaigns-page-1.json'), fail('expiredPageToken'))
    await expect(searchAll(DIRECT, CAMPAIGNS_QUERY, () => {}, { sleep })).rejects.toMatchObject({ failure: { pageTokenExpired: true }, opsSpent: 2 })
  })

  it('a revoked sign-in fails at once; an account that needs sign-in sends nothing at all', async () => {
    h.answers.push(fail('authRevoked'))
    await expect(searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep })).rejects.toMatchObject({ failure: { authLost: true }, opsSpent: 1 })
    expect(h.calls).toHaveLength(1)
    gatewayAccounts['g-2'] = { authStatus: 'needs_reauth', isActive: true, displayName: 'Test Google login' }
    const error = await searchAll({ ...DIRECT, connectionId: 'g-2' }, CUSTOMER_QUERY, () => {}, { sleep }).catch((e) => e)
    expect(error).toBeInstanceOf(GoogleAdsReadError)
    expect(error.failure).toMatchObject({ origin: 'gateway', authLost: true, code: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(error.opsSpent).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('a query Google refuses is not retried, and says why in Google\'s words', async () => {
    h.answers.push(fail('queryError'))
    const error = await searchAll(DIRECT, CUSTOMER_QUERY, () => {}, { sleep }).catch((e) => e)
    expect(error.message).toBe("Google Ads refused the request: Unrecognized field in the query: 'campaign.start_date'.")
    expect(h.calls).toHaveLength(1)
  })

  it('a runaway answer (the same page token again) stops', async () => {
    const loop = () => new Response(JSON.stringify({ results: [], nextPageToken: 'same-token' }), { status: 200 })
    h.answers.push(loop, loop, loop)
    await expect(searchAll(DIRECT, CUSTOMER_QUERY, () => {})).rejects.toMatchObject({ failure: { code: 'TOO_MANY_PAGES' } })
    expect(h.calls).toHaveLength(2)
  })
})

describe('listAccessibleCustomers', () => {
  it('GET customers:listAccessibleCustomers, no manager header, no body: the ids, digits only', async () => {
    h.answers.push(ok('list-accessible-customers.json'))
    expect(await listAccessibleCustomers('g-1')).toEqual(['1234567890', '9876543210'])
    expect(h.calls[0].url).toBe('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers')
    expect(h.calls[0].init.method).toBe('GET')
    expect(h.calls[0].init.body ?? null).toBeNull()
    expect(Object.keys(headersOf(0)).map((k) => k.toLowerCase())).not.toContain('login-customer-id')
    expect(googleKind('GET', h.calls[0].url)).toBe('read')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.listAccessibleCustomers', outcome: 'sent' })])
  })
})

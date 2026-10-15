/**
 * Google Ads programme 2, G8a (2026-10-15) — sales sent to Google (the Data Manager API's events:ingest) and their
 * adjustments (UploadConversionAdjustments) through the REAL channel gateway and googleCall (only the account state, the
 * ledger, the token and `fetch` are stand-ins): one request each, Google's check first (validateOnly), never retried by
 * the gateway; an adjustment's partial failure says per row what Google took; the Data Manager API spends none of the
 * Google Ads allowance. Ids and values are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { opsUsedLast24h, setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { googleDateTime, ingestSales, uploadAdjustments } from './conversion-upload-client.js'
import { GoogleAdsWriteError, UNKNOWN_OUTCOME } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

class MemoryRedis implements OpsRedis {
  status = 'ready'
  readonly values = new Map<string, string>()
  async incrby(key: string, n: number) { const v = Number(this.values.get(key) ?? 0) + n; this.values.set(key, String(v)); return v }
  async decrby(key: string, n: number) { const v = Number(this.values.get(key) ?? 0) - n; this.values.set(key, String(v)); return v }
  async expire() { return 1 }
  async mget(...keys: string[]) { return keys.map((k) => this.values.get(k) ?? null) }
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value); return 'OK' }
}

const TARGET: GoogleAdsTarget = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }
const INGEST = 'https://datamanager.googleapis.com/v1/events:ingest'
const EVENTS = [{ transactionId: '5001', eventTimestamp: '2026-10-10T09:00:00.000Z', eventSource: 'WEB', conversionValue: 49.9, currency: 'EUR', adIdentifiers: { gclid: 'Cj0KCQjw-test' } }]
const ACTION = 'customers/1234567890/conversionActions/72'
const ADJUSTMENTS = [
  { conversionAction: ACTION, adjustmentType: 'RETRACTION', orderId: '5001' },
  { conversionAction: ACTION, adjustmentType: 'RESTATEMENT', orderId: '5002', restatementValue: { adjustedValue: 29.9, currencyCode: 'EUR' } },
]
const noSleep = async () => undefined

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', '')
  setOpsBudgetRedisForTests(new MemoryRedis())
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const next = h.answers.shift()
    if (!next) throw new Error('no answer queued')
    return next()
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); setOpsBudgetRedisForTests(undefined); __rateTest.reset() })

describe('ingestSales (Data Manager API)', () => {
  it('Google\'s check, then the send: ONE request each to one conversion action of one account; the request id comes back', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }))
    await ingestSales(TARGET, '72', EVENTS, { validateOnly: true })
    h.answers.push(() => new Response(JSON.stringify({ requestId: 'req-1', fieldWarnings: [{ field: 'events[0].currency', description: 'currency differs from the account' }] }), { status: 200 }))
    const out = await ingestSales(TARGET, '72', EVENTS, { validateOnly: false })
    expect(out).toEqual({ requestId: 'req-1', warnings: ['currency differs from the account (at events[0].currency)'] })
    expect(h.calls.map((c) => c.url)).toEqual([INGEST, INGEST])
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' }, productDestinationId: '72' }],
      events: EVENTS, encoding: 'HEX', validateOnly: true,
    })
    expect(JSON.parse(String(h.calls[1].init.body)).validateOnly).toBe(false)
    expect(gatewayLedger.map((r) => r.operation)).toEqual(['datamanager.events.ingest.check', 'datamanager.events.ingest'])
    // Not a Google Ads API call: none of its allowance is spent.
    expect((await opsUsedLast24h('1234567890'))?.global).toBe(0)
  })

  it('a manager login names the login account', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }))
    await ingestSales({ ...TARGET, loginCustomerId: '111-222-3333' }, '72', EVENTS, { validateOnly: true })
    expect(JSON.parse(String(h.calls[0].init.body)).destinations[0].loginAccount).toEqual({ accountType: 'GOOGLE_ADS', accountId: '1112223333' })
  })

  it('a sign-in without the Data Manager permission, or a field Google refuses: refused, said plainly, nothing sent', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), { status: 403 }))
    const scope = await ingestSales(TARGET, '72', EVENTS, { validateOnly: true }).catch((e) => e)
    expect(scope).toBeInstanceOf(GoogleAdsWriteError)
    expect(scope).toMatchObject({ outcome: 'refused' })
    expect(scope.message).toMatch(/lacks the Data Manager permission .*sign in to Google again in Nexus once to allow sending sales/)
    expect(scope.message).toMatch(/Nothing was sent\.$/)
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'events[0].adIdentifiers.gclid', description: 'The click id is not valid.', reason: 'INVALID_GCLID' }] }] } }), { status: 400 }))
    const field = await ingestSales(TARGET, '72', EVENTS, { validateOnly: true }).catch((e) => e)
    expect(field.message).toBe('Google\'s Data Manager API refused it: The click id is not valid. (at events[0].adIdentifiers.gclid). Nothing was sent.')
  })

  it('a send Google does not answer is an UNKNOWN outcome, never sent twice by Nexus', async () => {
    h.answers.push(() => new Response('{}', { status: 503 }))
    const err = await ingestSales(TARGET, '72', EVENTS, { validateOnly: false, sleep: noSleep }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'unknown' })
    expect(err.message).toBe(UNKNOWN_OUTCOME)
    expect(h.calls).toHaveLength(1)
  })

  it('refuses before sending: no events, more than 2000, an id that is not Google\'s', async () => {
    for (const [action, events] of [['72', []], ['72', Array.from({ length: 2001 }, () => EVENTS[0])], ['7a', EVENTS]] as const) {
      expect(await ingestSales(TARGET, action, events as never, { validateOnly: true }).catch((e) => e)).toMatchObject({ outcome: 'not_sent' })
    }
    expect(h.calls).toHaveLength(0)
  })
})

describe('uploadAdjustments (ConversionAdjustmentUploadService)', () => {
  it('partial failure: Google takes or refuses each adjustment, and the answer says which; one operation of the allowance', async () => {
    h.answers.push(() => new Response(JSON.stringify({
      partialFailureError: { code: 3, message: 'partial', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{
        errorCode: { conversionAdjustmentUploadError: 'CONVERSION_NOT_FOUND' }, message: 'The conversion was not found.',
        location: { fieldPathElements: [{ fieldName: 'conversion_adjustments', index: 1 }] },
      }] }] },
      results: [{ orderId: '5001' }, {}],
    }), { status: 200 }))
    const now = new Date('2026-10-15T10:00:00Z')
    const out = await uploadAdjustments(TARGET, ADJUSTMENTS, { validateOnly: false, now })
    expect(out.results).toEqual([{ ok: true }, { ok: false, why: 'The conversion was not found. (CONVERSION_NOT_FOUND)' }])
    expect(h.calls[0].url).toBe(`${GOOGLE_ADS_API_BASE}/customers/1234567890:uploadConversionAdjustments`)
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      conversionAdjustments: ADJUSTMENTS.map((a) => ({ ...a, adjustmentDateTime: '2026-10-15 10:00:00+00:00' })), partialFailure: true, validateOnly: false,
    })
    expect(googleDateTime(now)).toBe('2026-10-15 10:00:00+00:00')
    expect((await opsUsedLast24h('1234567890'))?.global).toBe(1)
  })

  it('a check that Google answers without errors takes every one', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }))
    expect((await uploadAdjustments(TARGET, ADJUSTMENTS, { validateOnly: true })).results).toEqual([{ ok: true }, { ok: true }])
    expect(gatewayLedger.map((r) => r.operation)).toEqual(['ads.conversionAdjustments.check'])
  })
})

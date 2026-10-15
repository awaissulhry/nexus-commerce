/**
 * Google Ads changes, G5 (2026-10-15) — applying and dismissing Google's recommendations through the REAL channel gateway
 * and googleCall (only the account state, the ledger, the token and `fetch` are stand-ins): one request per change, all
 * or nothing, always a write (Google has no check for it), never retried by the gateway, operations reserved on the
 * change allowance, and the outcomes of a change Google did not make (not sent, refused, unknown).
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
import { RECOMMENDATION_RESULT, sendRecommendations } from './recommendation-client.js'
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
const REC = 'customers/1234567890/recommendations/r-1'
const OPS = [{ resourceName: REC, campaignBudget: { newBudgetAmountMicros: '15000000' } }]

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

describe('sendRecommendations', () => {
  it('applies in ONE request (all or nothing) and answers one result per operation; the operations are counted', async () => {
    h.answers.push(() => new Response(JSON.stringify({ results: [{ resourceName: REC }] }), { status: 200 }))
    const out = await sendRecommendations(TARGET, 'apply', OPS)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe(`${GOOGLE_ADS_API_BASE}/customers/1234567890/recommendations:apply`)
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ operations: OPS, partialFailure: false })
    expect(out.responses).toEqual([{ [RECOMMENDATION_RESULT]: { resourceName: REC } }])
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.recommendations.apply', outcome: 'sent', success: true })])
    expect((await opsUsedLast24h('1234567890'))?.global).toBe(1)
  })

  it('dismisses through its own path', async () => {
    h.answers.push(() => new Response(JSON.stringify({ results: [{ resourceName: REC }] }), { status: 200 }))
    await sendRecommendations(TARGET, 'dismiss', [{ resourceName: REC }])
    expect(h.calls[0].url).toBe(`${GOOGLE_ADS_API_BASE}/customers/1234567890/recommendations:dismiss`)
  })

  it('Google refused it: "refused" (nothing changed), with Google\'s sentence', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'x', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { recommendationError: 'RECOMMENDATION_INVALIDATED' }, message: 'The recommendation requested to apply has been invalidated.' }] }] } }), { status: 400 }))
    const err = await sendRecommendations(TARGET, 'apply', OPS).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAdsWriteError)
    expect(err).toMatchObject({ outcome: 'refused', operation: 'ads.recommendations.apply' })
    expect(h.calls).toHaveLength(1)
  })

  it('Google failed on its side: "unknown", never sent again', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'later' } }), { status: 503 }))
    const err = await sendRecommendations(TARGET, 'apply', OPS).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'unknown', message: UNKNOWN_OUTCOME })
    expect(h.calls).toHaveLength(1)
  })

  it('writes switched off: not sent, and the reservation is given back', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const err = await sendRecommendations(TARGET, 'apply', OPS).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'not_sent' })
    expect(h.calls).toHaveLength(0)
    expect((await opsUsedLast24h('1234567890'))?.global).toBe(0)
  })

  it('more than Google takes in one request is refused before anything is sent', async () => {
    const err = await sendRecommendations(TARGET, 'apply', Array.from({ length: 101 }, (_, i) => ({ resourceName: `${REC}${i}` }))).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'not_sent' })
    expect(h.calls).toHaveLength(0)
  })
})

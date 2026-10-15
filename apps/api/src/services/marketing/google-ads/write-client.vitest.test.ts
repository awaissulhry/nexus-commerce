/**
 * Google Ads changes (2026-10-15) — the write client, through the REAL channel gateway and googleCall (only the account
 * state, the ledger, the token and `fetch` are stand-ins): one GoogleAdsService.Mutate per change, all or nothing,
 * Google's check (validateOnly) as a read, the change as a write never retried by the gateway, operations reserved on
 * the change allowance, and the three outcomes of a change Google did not make (not sent, refused, unknown).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response | Promise<Response>> }))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { opsUsedLast24h, setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { GoogleAdsWriteError, liveRows, MAX_MUTATE_OPERATIONS, mutateGoogleAds, writeErrorSentence } from './write-client.js'
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
const MUTATE_URL = `${GOOGLE_ADS_API_BASE}/customers/1234567890/googleAds:mutate`
const OPS = [
  { campaignBudgetOperation: { create: { resourceName: 'customers/1234567890/campaignBudgets/-1', name: 'Shared', amountMicros: '10000000', explicitlyShared: true } } },
  { campaignOperation: { update: { resourceName: 'customers/1234567890/campaigns/22', campaignBudget: 'customers/1234567890/campaignBudgets/-1' }, updateMask: 'campaign_budget' } },
]
const bodyOf = (i: number) => JSON.parse(String(h.calls[i].init.body))
const waits: number[] = []
const sleep = async (ms: number) => { waits.push(ms); __rateTest.useMemory() }
const googleFailure = (status: number, rpc: string, errors: Array<Record<string, unknown>>) => () => new Response(JSON.stringify({
  error: { code: status, status: rpc, message: 'Request contains an invalid argument.', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors, requestId: 'req-1' }] },
}), { status })
let redis: MemoryRedis

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0; waits.length = 0
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', '')
  redis = new MemoryRedis()
  setOpsBudgetRedisForTests(redis)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const next = h.answers.shift()
    if (!next) throw new Error('no answer queued')
    return next()
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); setOpsBudgetRedisForTests(undefined) })

describe('mutateGoogleAds — one atomic request', () => {
  it('a check: validateOnly true, partialFailure false, the v25 GoogleAdsService.Mutate URL; a read on the ledger; ops counted on the change allowance', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }))
    const out = await mutateGoogleAds(TARGET, OPS, { validateOnly: true })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe(MUTATE_URL)
    expect(bodyOf(0)).toEqual({ mutateOperations: OPS, partialFailure: false, validateOnly: true, responseContentType: 'RESOURCE_NAME_ONLY' })
    expect(out).toEqual({ responses: [], ops: 2, requestId: null })
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.mutate.check', outcome: 'sent', success: true })])
    expect(await opsUsedLast24h('1234567890')).toEqual({ global: 2, account: 0 })
    expect([...redis.values.keys()].some((k) => k.includes(':acctw:1234567890:'))).toBe(true)
  })

  it('a change: validateOnly false; Google\'s results in order', async () => {
    h.answers.push(() => new Response(JSON.stringify({ mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/77' } },
      { campaignResult: { resourceName: 'customers/1234567890/campaigns/22' } },
    ] }), { status: 200, headers: { 'request-id': 'req-9' } }))
    const out = await mutateGoogleAds(TARGET, OPS, { validateOnly: false })
    expect(bodyOf(0).validateOnly).toBe(false)
    expect(out.responses[0].campaignBudgetResult?.resourceName).toBe('customers/1234567890/campaignBudgets/77')
    expect(out).toMatchObject({ ops: 2, requestId: 'req-9' })
    expect(gatewayLedger).toEqual([expect.objectContaining({ operation: 'ads.mutate', outcome: 'sent', success: true })])
  })

  it('Google refuses: nothing changed (all or nothing), the sentence names the place Google named', async () => {
    h.answers.push(googleFailure(400, 'INVALID_ARGUMENT', [{
      errorCode: { stringLengthError: 'TOO_LONG' },
      message: 'Too long.',
      trigger: { stringValue: 'A headline that is far too long' },
      location: { fieldPathElements: [{ fieldName: 'mutate_operations', index: 3 }, { fieldName: 'ad_group_ad_operation' }, { fieldName: 'create' }, { fieldName: 'ad' }, { fieldName: 'responsive_search_ad' }, { fieldName: 'headlines', index: 2 }, { fieldName: 'text' }] },
    }]))
    const err = await mutateGoogleAds(TARGET, OPS, { validateOnly: false }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAdsWriteError)
    expect(err).toMatchObject({ outcome: 'refused', opsSpent: 2 })
    expect(err.failure.errors[0]).toMatchObject({ code: 'TOO_LONG', operationIndex: 3, path: 'mutate_operations[3].ad_group_ad_operation.create.ad.responsive_search_ad.headlines[2].text' })
    expect(writeErrorSentence(err)).toBe('Google Ads refused it: Too long. (at mutate_operations[3].ad_group_ad_operation.create.ad.responsive_search_ad.headlines[2].text, value "A headline that is far too long"). Nothing was changed.')
    expect(h.calls).toHaveLength(1)
  })

  it('a change Google did not answer: never sent again; the outcome is unknown and says to read the account first', async () => {
    h.answers.push(() => { throw new TypeError('fetch failed') })
    const err = await mutateGoogleAds(TARGET, OPS, { validateOnly: false, sleep }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'unknown' })
    expect(err.message).toMatch(/did not confirm whether it made the change/)
    expect(h.calls).toHaveLength(1)
  })

  it('a check Google did not answer is tried again (it changes nothing)', async () => {
    h.answers.push(() => { throw new TypeError('fetch failed') }, () => new Response('{}', { status: 200 }))
    await mutateGoogleAds(TARGET, OPS, { validateOnly: true, sleep, random: () => 0 })
    expect(h.calls).toHaveLength(2)
    expect(waits).toEqual([5_000])
  })

  it('"slow down": Google applied nothing, so the change is sent once more after the wait; both attempts counted', async () => {
    h.answers.push(
      googleFailure(429, 'RESOURCE_EXHAUSTED', [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' }, message: 'Too many requests.' }]),
      () => new Response(JSON.stringify({ mutateOperationResponses: [{}, {}] }), { status: 200 }),
    )
    const out = await mutateGoogleAds(TARGET, OPS, { validateOnly: false, sleep, random: () => 0 })
    expect(h.calls).toHaveLength(2)
    expect(waits[0]).toBeGreaterThanOrEqual(30_000)
    expect(out.ops).toBe(4)
  })

  it('a 5xx answer to a change: Google may have made it — unknown, never sent again', async () => {
    h.answers.push(googleFailure(500, 'INTERNAL', [{ errorCode: { internalError: 'TRANSIENT_ERROR' }, message: 'Try again.' }]))
    const err = await mutateGoogleAds(TARGET, OPS, { validateOnly: false, sleep }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'unknown' })
    expect(err.message).toMatch(/did not confirm whether it made the change/)
    expect(h.calls).toHaveLength(1)
  })

  it('nothing is sent: no operation, too many, writes switched off (the check still runs), the allowance used up', async () => {
    await expect(mutateGoogleAds(TARGET, [], { validateOnly: true })).rejects.toMatchObject({ outcome: 'not_sent' })
    await expect(mutateGoogleAds(TARGET, Array.from({ length: MAX_MUTATE_OPERATIONS + 1 }, () => OPS[0]), { validateOnly: true })).rejects.toMatchObject({ outcome: 'not_sent' })
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const off = await mutateGoogleAds(TARGET, OPS, { validateOnly: false }).catch((e) => e)
    expect(off).toMatchObject({ outcome: 'not_sent' })
    expect(off.failure.code).toBe('PUBLISH_GATED')
    h.answers.push(() => new Response('{}', { status: 200 }))
    await mutateGoogleAds(TARGET, OPS, { validateOnly: true })
    expect(h.calls).toHaveLength(1)
    // Nothing sent = nothing spent: only the check's 2 operations count.
    expect((await opsUsedLast24h(null))?.global).toBe(2)
    await expect(mutateGoogleAds(TARGET, Array.from({ length: 2001 }, () => OPS[0]), { validateOnly: true })).rejects.toMatchObject({ outcome: 'not_sent' })
  })
})

describe('liveRows — a read a change stands on', () => {
  it('one operation on the change allowance; Google\'s rows', async () => {
    h.answers.push(() => new Response(JSON.stringify({ results: [{ campaign: { id: '22' } }] }), { status: 200 }))
    expect(await liveRows(TARGET, 'SELECT campaign.id FROM campaign')).toEqual([{ campaign: { id: '22' } }])
    expect(h.calls[0].url).toBe(`${GOOGLE_ADS_API_BASE}/customers/1234567890/googleAds:search`)
    expect(gatewayLedger).toEqual([expect.objectContaining({ operation: 'ads.search.live', outcome: 'sent' })])
    expect(await opsUsedLast24h('1234567890')).toEqual({ global: 1, account: 0 })
  })
})

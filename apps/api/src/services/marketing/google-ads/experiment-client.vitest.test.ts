/**
 * Google Ads changes, G9 (2026-10-15) — an experiment's or a campaign draft's action through the REAL channel gateway and
 * googleCall (only the account state, the ledger, the token and `fetch` are stand-ins): ONE request on the action's
 * exact path, Google's check (validateOnly: a read) or the change (a write, never retried by the gateway), one operation
 * reserved on the change allowance, Google's long-running operation named in the answer (never "done"), and the
 * outcomes of a change Google did not make (not sent, refused, unknown). The GET reads of a long-running operation and of
 * the async errors. Ids are made up.
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
import { EXPERIMENT_ACTION_RESULT, experimentActionOf, LONG_RUNNING_OPERATION, readAsyncErrors, readLongRunningOperation, sendExperimentAction } from './experiment-client.js'
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
const EXP = 'customers/1234567890/experiments/31'
const OP = 'customers/1234567890/operations/op-1'
const MAPPING = { experimentCampaign: 'customers/1234567890/campaigns/23', campaignBudget: 'customers/1234567890/campaignBudgets/14' }

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

describe('sendExperimentAction', () => {
  it('schedule: ONE POST on its path; Google\'s long-running operation is named in the answer, not taken as done', async () => {
    h.answers.push(() => new Response(JSON.stringify({ name: OP }), { status: 200 }))
    const out = await sendExperimentAction(TARGET, [{ scheduleExperiment: { resourceName: EXP } }], { validateOnly: false })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe(`${GOOGLE_ADS_API_BASE}/${EXP}:scheduleExperiment`)
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ validateOnly: false })
    expect(out.responses).toEqual([{ [EXPERIMENT_ACTION_RESULT]: { resourceName: EXP }, [LONG_RUNNING_OPERATION]: { resourceName: OP } }])
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.experiments.scheduleExperiment', outcome: 'sent', success: true })])
    expect((await opsUsedLast24h('1234567890'))?.global).toBe(1)
  })

  it('Google\'s check: validateOnly true on the same path (a read); end answers Empty; a draft\'s promote is ":promote"', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }), () => new Response('{}', { status: 200 }))
    await sendExperimentAction(TARGET, [{ endExperiment: { resourceName: EXP } }], { validateOnly: true })
    const out = await sendExperimentAction(TARGET, [{ promoteCampaignDraft: { resourceName: 'customers/1234567890/campaignDrafts/21~3' } }], { validateOnly: true })
    expect(h.calls.map((c) => [c.url, JSON.parse(String(c.init.body))])).toEqual([
      [`${GOOGLE_ADS_API_BASE}/${EXP}:endExperiment`, { validateOnly: true }],
      [`${GOOGLE_ADS_API_BASE}/customers/1234567890/campaignDrafts/21~3:promote`, { validateOnly: true }],
    ])
    expect(out.responses).toEqual([{ [EXPERIMENT_ACTION_RESULT]: { resourceName: 'customers/1234567890/campaignDrafts/21~3' } }])
    expect(gatewayLedger.map((r) => r.operation)).toEqual(['ads.experiments.endExperiment.check', 'ads.experiments.promoteCampaignDraft.check'])
  })

  it('graduate sends its one campaign budget mapping', async () => {
    h.answers.push(() => new Response('{}', { status: 200 }))
    await sendExperimentAction(TARGET, [{ graduateExperiment: { resourceName: EXP, campaignBudgetMappings: [MAPPING] } }], { validateOnly: false })
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ campaignBudgetMappings: [MAPPING], validateOnly: false })
  })

  it('Google refused it: "refused" (nothing changed), with Google\'s sentence', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'x', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { experimentError: 'CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_SHARED_BUDGET' }, message: 'Cannot use shared budget on base campaign when scheduling an experiment.' }] }] } }), { status: 400 }))
    const err = await sendExperimentAction(TARGET, [{ scheduleExperiment: { resourceName: EXP } }], { validateOnly: true }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAdsWriteError)
    expect(err).toMatchObject({ outcome: 'refused', operation: 'ads.experiments.scheduleExperiment.check' })
    expect(h.calls).toHaveLength(1)
  })

  it('a real change Google failed on its side: "unknown", never sent again; a check is tried again', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'later' } }), { status: 503 }))
    const err = await sendExperimentAction(TARGET, [{ promoteExperiment: { resourceName: EXP } }], { validateOnly: false }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'unknown', message: UNKNOWN_OUTCOME })
    expect(h.calls).toHaveLength(1)
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'later' } }), { status: 503 }), () => new Response('{}', { status: 200 }))
    await sendExperimentAction(TARGET, [{ promoteExperiment: { resourceName: EXP } }], { validateOnly: true, sleep: async () => undefined })
    expect(h.calls).toHaveLength(3)
  })

  it('writes switched off: not sent, the reservation given back; a check still goes', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const err = await sendExperimentAction(TARGET, [{ endExperiment: { resourceName: EXP } }], { validateOnly: false }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'not_sent' })
    expect(h.calls).toHaveLength(0)
    expect((await opsUsedLast24h('1234567890'))?.global).toBe(0)
    h.answers.push(() => new Response('{}', { status: 200 }))
    await sendExperimentAction(TARGET, [{ endExperiment: { resourceName: EXP } }], { validateOnly: true })
    expect(h.calls).toHaveLength(1)
  })

  it('anything but ONE action on THIS account is refused before anything is sent', async () => {
    const tries: unknown[][] = [
      [],
      [{ endExperiment: { resourceName: EXP } }, { endExperiment: { resourceName: EXP } }],
      [{ endExperiment: { resourceName: 'customers/999/experiments/31' } }],
      [{ endExperiment: { resourceName: `${EXP}/x` } }],
      [{ promoteCampaignDraft: { resourceName: EXP } }],
      [{ experimentOperation: { remove: EXP } }],
      [{ endExperiment: { resourceName: EXP }, promoteExperiment: { resourceName: EXP } }],
    ]
    for (const ops of tries) {
      expect(await sendExperimentAction(TARGET, ops as never, { validateOnly: true }).catch((e) => e)).toMatchObject({ outcome: 'not_sent' })
    }
    expect(h.calls).toHaveLength(0)
    expect(experimentActionOf('customers/1234567890', { graduateExperiment: { resourceName: EXP, campaignBudgetMappings: [MAPPING] } })).toEqual({ action: 'graduateExperiment', resourceName: EXP, body: { campaignBudgetMappings: [MAPPING] } })
  })
})

describe('the reads of Google\'s long-running work', () => {
  it('a long-running operation: done or not, and whether it failed (a GET, a read)', async () => {
    h.answers.push(() => new Response(JSON.stringify({ name: OP, done: false }), { status: 200 }), () => new Response(JSON.stringify({ name: OP, done: true, error: { code: 3, message: 'in-design campaign has no change' } }), { status: 200 }))
    expect(await readLongRunningOperation(TARGET, OP)).toEqual({ name: OP, done: false, error: null })
    expect(await readLongRunningOperation(TARGET, OP)).toEqual({ name: OP, done: true, error: 'in-design campaign has no change' })
    expect(h.calls.map((c) => [c.init.method, c.url])).toEqual([['GET', `${GOOGLE_ADS_API_BASE}/${OP}`], ['GET', `${GOOGLE_ADS_API_BASE}/${OP}`]])
  })

  it('the async errors of an experiment and of a draft, on their own paths; another account\'s path is not read', async () => {
    h.answers.push(() => new Response(JSON.stringify({ errors: [{ code: 3, message: 'Budget is shared.' }, {}] }), { status: 200 }), () => new Response('{}', { status: 200 }))
    expect(await readAsyncErrors(TARGET, EXP, 'experiment')).toEqual(['Budget is shared.', 'Google reported an error without a message.'])
    expect(await readAsyncErrors(TARGET, 'customers/1234567890/campaignDrafts/21~3', 'draft')).toEqual([])
    expect(h.calls.map((c) => c.url)).toEqual([`${GOOGLE_ADS_API_BASE}/${EXP}:listExperimentAsyncErrors`, `${GOOGLE_ADS_API_BASE}/customers/1234567890/campaignDrafts/21~3:listAsyncErrors`])
    await expect(readLongRunningOperation(TARGET, 'customers/999/operations/op-1')).rejects.toThrow(/not of this account/)
    await expect(readLongRunningOperation(TARGET, `${OP}?x=1`)).rejects.toThrow(/not of this account/)
    expect(h.calls).toHaveLength(2)
  })
})

/**
 * Google Ads programme 2, G8b — the account calls (users, links, billing) through the REAL channel gateway and googleCall
 * (only the account state, the ledger, the token and `fetch` are stand-ins): ONE call per change, its own path, a check
 * only where the method has validate_only, Google's multi-party approval said, Google's refusal at the Explorer access
 * level said plainly (never a success), and the outcomes of a change Google did not make.
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
import { setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { ACCOUNT_RESULT, ACCOUNT_REVIEW, checkAccountOperations, sendAccountCall, sendAccountOperations } from './account-client.js'
import { GoogleAdsWriteError, UNKNOWN_OUTCOME, writeErrorSentence } from './write-client.js'
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
const C = 'customers/1234567890'
const INVITE = { path: 'customerUserAccessInvitations:mutate' as const, body: { operation: { create: { emailAddress: 'person@example.com', accessRole: 'STANDARD' } } } }
const UNLINK = { path: 'productLinks:remove' as const, body: { resourceName: `${C}/productLinks/41` } }
const denied = (code: string) => () => new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'outer', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: code }, message: 'The developer token is not allowed to use this service.' }] }] } }), { status: 403 })

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

describe('sendAccountCall', () => {
  it('ONE call on its own path; the result\'s resource name, or the review Google holds it for', async () => {
    h.answers.push(() => new Response(JSON.stringify({ result: { resourceName: `${C}/customerUserAccessInvitations/73` } }), { status: 200 }))
    const out = await sendAccountOperations(TARGET, [{ accountCall: INVITE }])
    expect(h.calls[0].url).toBe(`${GOOGLE_ADS_API_BASE}/${C}/customerUserAccessInvitations:mutate`)
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual(INVITE.body)
    expect(out.responses).toEqual([{ [ACCOUNT_RESULT]: { resourceName: `${C}/customerUserAccessInvitations/73` } }])
    h.answers.push(() => new Response(JSON.stringify({ result: { multiPartyAuthReview: `${C}/multiPartyAuthReviews/5` } }), { status: 200 }))
    expect((await sendAccountOperations(TARGET, [{ accountCall: INVITE }])).responses).toEqual([{ [ACCOUNT_RESULT]: { resourceName: undefined }, [ACCOUNT_REVIEW]: { resourceName: `${C}/multiPartyAuthReviews/5` } }])
    expect(gatewayLedger.map((r) => [r.operation, r.outcome])).toEqual([['ads.account.customerUserAccessInvitations.mutate', 'sent'], ['ads.account.customerUserAccessInvitations.mutate', 'sent']])
  })

  it('a check only where the method has validate_only; it goes even with writes switched off', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    h.answers.push(() => new Response('{}', { status: 200 }))
    await checkAccountOperations(TARGET, [{ accountCall: UNLINK }])
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ ...UNLINK.body, validateOnly: true })
    const noCheck = await checkAccountOperations(TARGET, [{ accountCall: INVITE }]).catch((e) => e)
    expect(noCheck).toMatchObject({ outcome: 'not_sent', failure: { code: 'NO_CHECK' } })
    const gated = await sendAccountCall(TARGET, UNLINK).catch((e) => e)
    expect(gated).toMatchObject({ outcome: 'not_sent' })
    expect(h.calls).toHaveLength(1)
  })

  it('refused at the Explorer access level: said plainly, with Google\'s own code and words, never a success', async () => {
    h.answers.push(denied('SERVICE_ACCESS_DENIED'))
    const err = await sendAccountCall(TARGET, INVITE).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAdsWriteError)
    expect(err).toMatchObject({ outcome: 'refused' })
    expect(writeErrorSentence(err)).toMatch(/^Google refused it \(SERVICE_ACCESS_DENIED: The developer token is not allowed to use this service\.\)\. .*Explorer access level, at which Google does not allow user management through the API .*Google Ads › Admin › Access and security\. Nothing was changed\.$/)
    // A link has no access-level limit: Google's own sentence stays.
    h.answers.push(denied('USER_PERMISSION_DENIED'))
    const link = await sendAccountCall(TARGET, UNLINK).catch((e) => e)
    expect(writeErrorSentence(link)).not.toMatch(/Explorer/)
  })

  it('Google failed on its side: "unknown", never sent again; a change that is not ONE call is not sent', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'later' } }), { status: 503 }))
    const err = await sendAccountCall(TARGET, INVITE).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'unknown', message: UNKNOWN_OUTCOME })
    expect(h.calls).toHaveLength(1)
    const two = await sendAccountOperations(TARGET, [{ accountCall: INVITE }, { accountCall: INVITE }]).catch((e) => e)
    expect(two).toMatchObject({ outcome: 'not_sent', failure: { code: 'NOT_ONE_ACCOUNT_CALL' } })
    expect(h.calls).toHaveLength(1)
  })
})

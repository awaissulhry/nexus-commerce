/**
 * W4-11 — what an update to an EXISTING Sponsored Brands or Display campaign sends, driven through the REAL liveCall and
 * the REAL channel gateway with `fetch` stubbed (the pattern of ads-sbsd-wire.vitest.test.ts). Nothing leaves the process.
 *
 * Each shape is Amazon's published OpenAPI document (read 2026-10-07; cited at each builder in ads-api-client.ts):
 *   SB 4.0  PUT /sb/v4/campaigns                     vnd.sbcampaignresource.v4+json, { campaigns: [{ campaignId, state, budget }] }
 *   SD 3.0  PUT /sd/campaigns                        application/json, [{ campaignId (int64), state, budget }]
 *   SB 3.0  PUT /sb/keywords                         application/json, [{ keywordId, adGroupId, campaignId (int64), state, bid }]
 *   SB 3.0  PUT /sb/targets                          application/json, { targets: [{ targetId, adGroupId, campaignId, state, bid }] }
 *   SD 3.0  PUT /sd/targets                          application/json, [{ targetId (int64), state, bid }]
 *   SB 3.0  DELETE /sb/negativeKeywords/{id}         archive (final)
 *   SD 3.0  DELETE /sd/negativeTargets/{id}          archive (final)
 *   SB 3.0  POST /sb/negativeKeywords                [{ campaignId, adGroupId, keywordText, matchType: negativeExact|negativePhrase }]
 *   SD 3.0  POST /sd/negativeTargets                 [{ adGroupId, expressionType: manual, expression: [{ type: asinSameAs, value }], state }]
 * and Amazon's answer is read per item: anything but SUCCESS is a refusal in Amazon's own words. Ids and ASINs are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  answers: [] as Array<() => Response>,
  protectedTerms: [] as Array<{ term: string; matchType: string; mode: string }>,
}))
vi.mock('../../db.js', () => ({
  default: {
    adKeywordProtection: { findMany: async () => h.protectedTerms },
    adsStrategy: { findMany: async () => [] },
    campaign: { findFirst: async () => ({ id: 'c-1', marketplace: 'IT' }) },
    adGroup: { findFirst: async () => ({ campaign: { id: 'c-1', marketplace: 'IT' } }) },
    adTarget: { findFirst: async () => null },
  },
}))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from '../gateway/rate.js'
import {
  amazonIntId, createSbNegativeKeyword, createSdNegativeTarget, sbCampaignUpdateRequest, sbKeywordUpdateRequest, sbSdItemsResult,
  sbSdNegativeArchiveRequest, sbTargetsResult, sbTargetUpdateRequest, sbV4CampaignsResult, sdCampaignUpdateRequest, sdTargetUpdateRequest,
  sendSbSdUpdate, SBSD_ANSWER_NOT_UNDERSTOOD,
} from './ads-api-client.js'

const ctx = { profileId: '123', region: 'EU' as const }
const IDS = { externalTargetId: '300000000001', externalAdGroupId: '200000000001', externalCampaignId: '100000000001' }

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; h.protectedTerms = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response('[]', { status: 207 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

const sent = (i = 0) => ({
  method: h.calls[i].init.method,
  path: new URL(h.calls[i].url).pathname,
  body: h.calls[i].init.body == null ? undefined : JSON.parse(String(h.calls[i].init.body)),
  headers: h.calls[i].init.headers as Record<string, string>,
})
const answer = (status: number, body: unknown) => h.answers.push(() => new Response(JSON.stringify(body), { status }))

describe('the request builders (pure)', () => {
  it('SB 4.0 campaign: string id, UPPERCASE state, budget; no archive through an update', () => {
    expect(sbCampaignUpdateRequest('100000000001', { state: 'paused', dailyBudget: 12.5 })).toEqual({
      method: 'PUT', path: '/sb/v4/campaigns', body: { campaigns: [{ campaignId: '100000000001', state: 'PAUSED', budget: 12.5 }] },
      contentType: 'application/vnd.sbcampaignresource.v4+json', acceptHeader: 'application/vnd.sbcampaignresource.v4+json', answer: 'v4',
    })
    expect(() => sbCampaignUpdateRequest('100000000001', { state: 'archived' })).toThrow(/archived by its own delete operation/)
  })

  it('SD 3.0 campaign, SB 3.0 keyword and target, SD 3.0 target: int64 ids, lowercase state, the bid in units', () => {
    expect(sdCampaignUpdateRequest('100000000001', { dailyBudget: 9 })).toMatchObject({ method: 'PUT', path: '/sd/campaigns', body: [{ campaignId: 100000000001, budget: 9 }], contentType: 'application/json' })
    expect(sbKeywordUpdateRequest(IDS, { bid: 0.45, state: 'enabled' })).toMatchObject({
      method: 'PUT', path: '/sb/keywords', contentType: 'application/json', acceptHeader: 'application/vnd.sbkeywordresponse.v3+json',
      body: [{ keywordId: 300000000001, adGroupId: 200000000001, campaignId: 100000000001, state: 'enabled', bid: 0.45 }],
    })
    expect(sbTargetUpdateRequest(IDS, { bid: 0.6 })).toMatchObject({
      method: 'PUT', path: '/sb/targets', acceptHeader: 'application/vnd.updatetargetsresponse.v3+json',
      body: { targets: [{ targetId: 300000000001, adGroupId: 200000000001, campaignId: 100000000001, bid: 0.6 }] },
    })
    expect(sdTargetUpdateRequest('300000000001', { state: 'paused' })).toMatchObject({ method: 'PUT', path: '/sd/targets', body: [{ targetId: 300000000001, state: 'paused' }] })
  })

  it('retiring a negative is its archive operation, never a PUT', () => {
    expect(sbSdNegativeArchiveRequest('SPONSORED_BRANDS', '400000000001')).toEqual({ method: 'DELETE', path: '/sb/negativeKeywords/400000000001', acceptHeader: 'application/vnd.sbkeywordresponse.v3+json', answer: 'items' })
    expect(sbSdNegativeArchiveRequest('SPONSORED_DISPLAY', '400000000002')).toEqual({ method: 'DELETE', path: '/sd/negativeTargets/400000000002', acceptHeader: 'application/json', answer: 'items' })
  })

  it('an id a JSON number would change (past 2^53) or one that is not digits is refused, never sent rounded', () => {
    expect(amazonIntId('9007199254740991')).toBe(9_007_199_254_740_991)
    expect(() => amazonIntId('9007199254740993')).toThrow(/cannot be sent as a number without changing it/)
    expect(() => amazonIntId('EXT-1')).toThrow(/cannot be sent as a number/)
  })

  it('reads Amazon\'s per-item answer: SUCCESS is ok, any other code is its refusal in its own words', () => {
    expect(sbSdItemsResult([{ code: 'SUCCESS', campaignId: 1 }])).toEqual({ ok: true, error: null })
    expect(sbSdItemsResult({ code: 'SUCCESS', keywordId: 1 })).toEqual({ ok: true, error: null })
    expect(sbSdItemsResult([{ code: 'INVALID_ARGUMENT', description: 'Bid is below the minimum' }])).toEqual({ ok: false, error: 'amazon_rejected: INVALID_ARGUMENT — Bid is below the minimum' })
  })

  it('🔴 fails closed: an answer it cannot read is never counted as done', () => {
    for (const answer of [{ unexpected: true }, [], [{ campaignId: 1 }], null, 'ok']) {
      expect(sbSdItemsResult(answer)).toEqual({ ok: false, error: SBSD_ANSWER_NOT_UNDERSTOOD })
    }
    expect(SBSD_ANSWER_NOT_UNDERSTOOD).toMatch(/^Amazon's answer was not understood/)
    expect(sbV4CampaignsResult({ campaigns: { success: [{ index: 0, campaignId: '1' }], error: [] } })).toEqual({ ok: true, error: null })
    expect(sbV4CampaignsResult({ campaigns: { success: [], error: [] } })).toEqual({ ok: false, error: SBSD_ANSWER_NOT_UNDERSTOOD })
    expect(sbV4CampaignsResult({})).toEqual({ ok: false, error: SBSD_ANSWER_NOT_UNDERSTOOD })
    expect(sbTargetsResult({ updateTargetSuccessResults: [{ targetId: 1, targetRequestIndex: 0 }] })).toEqual({ ok: true, error: null })
    expect(sbTargetsResult({})).toEqual({ ok: false, error: SBSD_ANSWER_NOT_UNDERSTOOD })
  })
})

describe('on the wire, through the gateway', () => {
  it('SB campaign budget: PUT /sb/v4/campaigns with the v4 mime both ways; a per-item error is a failure', async () => {
    answer(207, { campaigns: { success: [{ index: 0, campaignId: '100000000001' }], error: [] } })
    const ok = await sendSbSdUpdate(ctx, sbCampaignUpdateRequest('100000000001', { dailyBudget: 15 }), 'test')
    expect(sent()).toMatchObject({ method: 'PUT', path: '/sb/v4/campaigns', body: { campaigns: [{ campaignId: '100000000001', budget: 15 }] } })
    expect(sent().headers).toMatchObject({ 'Content-Type': 'application/vnd.sbcampaignresource.v4+json', Accept: 'application/vnd.sbcampaignresource.v4+json', 'Amazon-Advertising-API-Scope': '123' })
    expect(ok).toMatchObject({ ok: true, mode: 'live', error: null })
    answer(207, { campaigns: { success: [], error: [{ index: 0, errors: [{ errorType: 'rangeError', message: 'budget too low' }] }] } })
    expect((await sendSbSdUpdate(ctx, sbCampaignUpdateRequest('100000000001', { dailyBudget: 0.5 }), 'test')).ok).toBe(false)
    expect(gatewayLedger.length).toBe(2)
  })

  it('SB keyword bid: PUT /sb/keywords as JSON, the SB keyword response mime accepted; SD target refusal read from the array', async () => {
    answer(207, [{ keywordId: 300000000001, code: 'SUCCESS' }])
    expect((await sendSbSdUpdate(ctx, sbKeywordUpdateRequest(IDS, { bid: 0.5 }), 'test')).ok).toBe(true)
    expect(sent().headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/vnd.sbkeywordresponse.v3+json' })
    answer(207, [{ targetId: 300000000001, code: 'INVALID_ARGUMENT', description: 'bid out of range' }])
    const refused = await sendSbSdUpdate(ctx, sdTargetUpdateRequest('300000000001', { bid: 2000 }), 'test')
    expect(refused).toMatchObject({ ok: false, error: 'amazon_rejected: INVALID_ARGUMENT — bid out of range' })
  })

  it('SB target bid: a 200 answer with updateTargetErrorResults is a refusal', async () => {
    answer(200, { updateTargetSuccessResults: [], updateTargetErrorResults: [{ code: 'INVALID_ARGUMENT', details: 'target archived', targetRequestIndex: 0 }] })
    expect(await sendSbSdUpdate(ctx, sbTargetUpdateRequest(IDS, { bid: 0.5 }), 'test')).toMatchObject({ ok: false, error: 'amazon_rejected: INVALID_ARGUMENT — target archived' })
    expect(sent()).toMatchObject({ method: 'PUT', path: '/sb/targets' })
  })

  it('a negative\'s archive: DELETE with no body', async () => {
    answer(200, { code: 'SUCCESS', targetId: 400000000002 })
    expect((await sendSbSdUpdate(ctx, sbSdNegativeArchiveRequest('SPONSORED_DISPLAY', '400000000002'), 'test')).ok).toBe(true)
    expect(sent()).toMatchObject({ method: 'DELETE', path: '/sd/negativeTargets/400000000002', body: undefined })
    expect(sent().headers['Content-Type']).toBeUndefined()
  })

  it('sandbox sends nothing', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    expect(await sendSbSdUpdate(ctx, sdCampaignUpdateRequest('100000000001', { state: 'paused' }), 'test')).toMatchObject({ ok: true, mode: 'sandbox' })
    expect(h.calls).toEqual([])
  })
})

describe('adding an SB / SD negative (the write service calls these; the wire check binds them like the SP ones)', () => {
  it('SB negative keyword: POST /sb/negativeKeywords, numeric ids, negativeExact; the id read from the answer', async () => {
    answer(207, [{ keywordId: 400000000001, code: 'SUCCESS' }])
    const r = await createSbNegativeKeyword(ctx, { externalCampaignId: '100000000001', externalAdGroupId: '200000000001', keywordText: 'free jacket', matchType: 'EXACT' })
    expect(sent()).toMatchObject({ method: 'POST', path: '/sb/negativeKeywords', body: [{ campaignId: 100000000001, adGroupId: 200000000001, keywordText: 'free jacket', matchType: 'negativeExact' }] })
    expect(sent().headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/vnd.sbkeywordresponse.v3+json' })
    expect(r).toMatchObject({ ok: true, mode: 'live', externalId: '400000000001', error: null })
  })

  it('SD negative product target: POST /sd/negativeTargets with asinSameAs; a refusal carries Amazon\'s words', async () => {
    answer(207, [{ code: 'INVALID_ARGUMENT', description: 'ad group archived' }])
    const r = await createSdNegativeTarget(ctx, { externalCampaignId: '100000000001', externalAdGroupId: '200000000001', asin: 'B0TESTNEG1' })
    expect(sent()).toMatchObject({ method: 'POST', path: '/sd/negativeTargets', body: [{ adGroupId: 200000000001, expressionType: 'manual', expression: [{ type: 'asinSameAs', value: 'B0TESTNEG1' }], state: 'enabled' }] })
    expect(r).toMatchObject({ ok: false, externalId: null, error: expect.stringMatching(/ad group archived/) })
  })

  it('🔴 a protected term is refused at the wire for the SB endpoint too: nothing is sent', async () => {
    h.protectedTerms = [{ term: 'brandname', matchType: 'EXACT', mode: 'WHITELIST' }]
    await expect(createSbNegativeKeyword(ctx, { externalCampaignId: '100000000001', externalAdGroupId: '200000000001', keywordText: 'brandname', matchType: 'EXACT' })).rejects.toThrow(/brandname/i)
    expect(h.calls).toEqual([])
  })
})

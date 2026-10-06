/**
 * CC-25 — a create Amazon may have made before answering 5xx (or not answering at all) is never sent blindly a second
 * time. Driven through the REAL liveCall and the REAL channel gateway with `fetch` stubbed (the pattern of
 * ads-api-client.vitest.test.ts): every call, the read-backs included, goes through the gateway.
 *
 * Before the fix, fetchWithRetry sent `POST /sp/keywords` up to three times on a 502: Amazon had made the keyword on the
 * first, refused the second as a duplicate, and Nexus stored no id while the keyword served.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response | Promise<Response>> }))
vi.mock('../../db.js', () => ({
  default: {
    adKeywordProtection: { findMany: async () => [] },
    campaign: { findFirst: async () => null },
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

import { __rateTest } from '../gateway/rate.js'
import { createAdGroup, createCampaign, createKeyword, createProductAd, createTarget, setCreateRetrySleepForTests } from './ads-api-client.js'

const ctx = { profileId: '123', region: 'EU' as const }
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status })
const sent = () => h.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const next = h.answers.shift()
    if (!next) throw new Error('unexpected call ' + String(url))
    return next()
  }))
  setCreateRetrySleepForTests(async () => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); setCreateRetrySleepForTests(null) })

const keyword = { externalCampaignId: 'c-1', externalAdGroupId: 'ag-1', keywordText: 'giacca pelle', matchType: 'EXACT' as const, bid: 0.5 }

describe('CC-25 a create answered 5xx is read back before it is ever sent again', () => {
  it('🔴 502, and Amazon holds the keyword: it is linked and the create is NOT sent a second time', async () => {
    h.answers.push(json(502, { message: 'Bad Gateway' }))
    h.answers.push(json(200, { keywords: [{ keywordId: 'kw-9', campaignId: 'c-1', adGroupId: 'ag-1', keywordText: 'Giacca Pelle', matchType: 'EXACT', state: 'ENABLED' }] }))
    const r = await createKeyword(ctx, keyword)
    expect(sent()).toEqual(['POST /sp/keywords', 'POST /sp/keywords/list'])
    expect(r).toMatchObject({ ok: true, mode: 'live', externalId: 'kw-9', error: null })
    // The read-back asks only for this campaign's live keywords.
    expect(JSON.parse(String(h.calls[1].init.body))).toMatchObject({ campaignIdFilter: { include: ['c-1'] }, stateFilter: { include: ['ENABLED', 'PAUSED'] } })
  })

  it('502, and Amazon does not hold it: the create is sent again and its id kept', async () => {
    h.answers.push(json(502, {}))
    h.answers.push(json(200, { keywords: [{ keywordId: 'other', adGroupId: 'ag-2', keywordText: 'giacca pelle', matchType: 'EXACT' }] }))
    h.answers.push(json(207, { keywords: { success: [{ index: 0, keywordId: 'kw-10' }], error: [] } }))
    const r = await createKeyword(ctx, keyword)
    expect(sent()).toEqual(['POST /sp/keywords', 'POST /sp/keywords/list', 'POST /sp/keywords'])
    expect(r.externalId).toBe('kw-10')
  })

  it('the second attempt refused as a duplicate (the list lagged): read once more and link what Amazon made', async () => {
    h.answers.push(json(504, {}))
    h.answers.push(json(200, { keywords: [] }))
    h.answers.push(json(207, { keywords: { success: [], error: [{ index: 0, errors: [{ errorType: 'duplicateValueError', message: 'duplicate' }] }] } }))
    h.answers.push(json(200, { keywords: [{ keywordId: 'kw-11', adGroupId: 'ag-1', keywordText: 'giacca pelle', matchType: 'EXACT' }] }))
    const r = await createKeyword(ctx, keyword)
    expect(sent()).toEqual(['POST /sp/keywords', 'POST /sp/keywords/list', 'POST /sp/keywords', 'POST /sp/keywords/list'])
    expect(r).toMatchObject({ ok: true, externalId: 'kw-11' })
  })

  it('🔴 the read-back fails: nothing is sent again, and the reason says to check Amazon first', async () => {
    h.answers.push(json(502, {}))
    h.answers.push(json(400, { message: 'bad filter' }))
    await expect(createKeyword(ctx, keyword)).rejects.toThrow(/not sent again, so it cannot exist twice/)
    expect(sent()).toEqual(['POST /sp/keywords', 'POST /sp/keywords/list'])
  })

  it('no answer at all (network error): read back too, and linked when Amazon holds it', async () => {
    h.answers.push(() => { throw new TypeError('fetch failed') })
    h.answers.push(json(200, { productAds: [{ adId: 'ad-5', campaignId: 'c-1', adGroupId: 'ag-1', sku: 'SKU-1', state: 'ENABLED' }] }))
    const r = await createProductAd(ctx, { externalCampaignId: 'c-1', externalAdGroupId: 'ag-1', sku: 'SKU-1' })
    expect(sent()).toEqual(['POST /sp/productAds', 'POST /sp/productAds/list'])
    expect(r.externalId).toBe('ad-5')
  })

  it('three unconfirmed answers and nothing on Amazon: the 5xx is reported, three creates at most', async () => {
    for (let i = 0; i < 3; i++) { h.answers.push(json(503, {})); h.answers.push(json(200, { adGroups: [] })) }
    await expect(createAdGroup(ctx, { externalCampaignId: 'c-1', name: 'Exact Ad Group', defaultBid: 0.5 })).rejects.toThrow(/503/)
    expect(sent().filter((c) => c === 'POST /sp/adGroups')).toHaveLength(3)
  })

  it('a campaign is found by its name and targeting type; one of another type with the same name is not ours', async () => {
    h.answers.push(json(500, {}))
    h.answers.push(json(200, { campaigns: [
      { campaignId: 'manual-1', name: 'Gale - SP - Auto', targetingType: 'MANUAL', state: 'ENABLED' },
      { campaignId: 'auto-1', name: 'Gale - SP - Auto', targetingType: 'AUTO', state: 'ENABLED' },
    ] }))
    const r = await createCampaign(ctx, { name: 'Gale - SP - Auto', targetingType: 'AUTO', dailyBudget: 10 })
    expect(r.externalId).toBe('auto-1')
    expect(sent()).toEqual(['POST /sp/campaigns', 'POST /sp/campaigns/list'])
  })

  it('a product target is found by its expression in its ad group', async () => {
    h.answers.push(json(502, {}))
    h.answers.push(json(200, { targetingClauses: [{ targetId: 't-7', adGroupId: 'ag-1', expression: [{ type: 'ASIN_SAME_AS', value: 'B0TEST0001' }] }] }))
    const r = await createTarget(ctx, { externalCampaignId: 'c-1', externalAdGroupId: 'ag-1', expression: [{ type: 'ASIN_SAME_AS', value: 'b0test0001' }], expressionType: 'MANUAL', bid: 0.4 })
    expect(r.externalId).toBe('t-7')
  })

  it('429 is still retried as before (Amazon refused it before doing anything); a 400 is not', async () => {
    h.answers.push(() => new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
    h.answers.push(json(207, { keywords: { success: [{ index: 0, keywordId: 'kw-12' }], error: [] } }))
    expect((await createKeyword(ctx, keyword)).externalId).toBe('kw-12')
    expect(sent()).toEqual(['POST /sp/keywords', 'POST /sp/keywords'])
    h.calls = []
    h.answers.push(json(400, { message: 'bad request' }))
    await expect(createKeyword(ctx, keyword)).rejects.toThrow(/400/)
    expect(sent()).toEqual(['POST /sp/keywords'])
  })
})

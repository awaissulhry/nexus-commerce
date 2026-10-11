/**
 * KAPI-S — Amazon's suggested bid (POST /sp/targets/bid/recommendations), read to Amazon's documented v5 shape and sent
 * through the REAL Ads client (`liveCall`, profiles ON) and the channel gateway, with `fetch` stubbed. No call leaves
 * this machine.
 *
 *   mapping   which stored target is asked as which Amazon expression type (keywords, PAT_ASIN, the four auto groups;
 *             categories, audiences and expanded ASINs are not asked)
 *   parser    the documented answers: the quick-start guide's scenario 2 (three bidValues per keyword) and the v5
 *             contract's own example (two themes, amounts written as strings); missing and odd values; no list = an error
 *   sending   v5 media type both ways, no bidding block, auto groups without a value, at most 100 expressions per call,
 *             each through the gateway; a failed call is said in words and the others still count; sandbox asks nothing
 *   gateway   the POST counts as a read
 *
 * The payloads are Amazon's own documentation examples; the keywords and ids are made up (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<(body: any) => Response> }))
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
import { ADS_READ_POSTS, adsKind } from '../gateway/ads.js'
import {
  ADS_READ_ONLY_POSTS, isMutatingCall, fetchThemeBidRecommendations, getThemeBidRecommendations, parseThemeBidRecommendations, suggestedRange, themeBidFailureReason,
  themeExpressionKey, themeExpressionOf, THEME_BID_MEDIA_TYPE, type ThemeExpression,
} from './ads-api-client.js'

/** The quick-start guide, scenario 2 / 4 response ("Theme-based bid suggestions — Quick-start guide"). */
const GUIDE_SCENARIO_2 = {
  bidRecommendations: [{
    theme: 'CONVERSION_OPPORTUNITIES',
    bidRecommendationsForTargetingExpressions: [
      { targetingExpression: { type: 'KEYWORD_BROAD_MATCH', value: 'sandals' }, bidValues: [{ suggestedBid: 0.15 }, { suggestedBid: 0.45 }, { suggestedBid: 0.77 }] },
      { targetingExpression: { type: 'KEYWORD_BROAD_MATCH', value: 'shoe' }, bidValues: [{ suggestedBid: 0.14 }, { suggestedBid: 0.44 }, { suggestedBid: 0.78 }] },
      { targetingExpression: { type: 'KEYWORD_EXACT_MATCH', value: 'basketball' }, bidValues: [{ suggestedBid: 0.33 }, { suggestedBid: 0.61 }, { suggestedBid: 0.96 }] },
      { targetingExpression: { type: 'KEYWORD_PHRASE_MATCH', value: 'net' }, bidValues: [{ suggestedBid: 0.28 }, { suggestedBid: 0.55 }, { suggestedBid: 0.87 }] },
      { targetingExpression: { type: 'KEYWORD_PHRASE_MATCH', value: 'phone' }, bidValues: [{ suggestedBid: 0.13 }, { suggestedBid: 0.14 }, { suggestedBid: 0.54 }] },
    ],
    impactMetrics: { clicks: { values: [{ lower: 30, upper: 70 }, { lower: 80, upper: 90 }, { lower: 95, upper: 120 }] } },
  }],
}

/** The v5 contract's own example (ThemeBasedBidRecommendationResponseV5): two themes, amounts as strings. */
const CONTRACT_V5_EXAMPLE = {
  bidRecommendations: [
    {
      theme: 'CONVERSION_OPPORTUNITIES',
      bidRecommendationsForTargetingExpressions: [
        { bidValues: [{ suggestedBid: '1' }, { suggestedBid: '1.5' }, { suggestedBid: '2' }], suggestedBidImpactMetrics: { estimatedImpressionLower: '600', estimatedImpressionUpper: '1200' }, targetingExpression: { type: 'CLOSE_MATCH' } },
        { bidValues: [{ suggestedBid: '1.1' }, { suggestedBid: '1.4' }, { suggestedBid: '2.2' }], suggestedBidImpactMetrics: { estimatedImpressionLower: '500', estimatedImpressionUpper: '1000' }, targetingExpression: { type: 'LOOSE_MATCH' } },
      ],
      bidAnalysesForTargetingExpressions: [{ targetingExpression: { type: 'CLOSE_MATCH' }, bidAnalyses: { ALL: [{ bid: '1', type: 'SUGGESTED_LOWER' }, { bid: '1.5', type: 'SUGGESTED' }, { bid: '2', type: 'SUGGESTED_UPPER' }] } }],
    },
    {
      theme: 'PRIME_DAY',
      bidRecommendationsForTargetingExpressions: [
        { bidValues: [{ suggestedBid: '1.2' }, { suggestedBid: '1.7' }, { suggestedBid: '2.2' }], targetingExpression: { type: 'CLOSE_MATCH' } },
        { bidValues: [{ suggestedBid: '1.3' }, { suggestedBid: '1.5' }, { suggestedBid: '2.4' }], targetingExpression: { type: 'LOOSE_MATCH' } },
      ],
    },
  ],
}

const suggestionsOf = (res: unknown) => {
  const parsed = parseThemeBidRecommendations(res)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.suggestions
}

describe('which stored target is asked as which Amazon expression', () => {
  it.each([
    [{ kind: 'KEYWORD', matchType: 'EXACT', expression: 'rain jacket' }, { type: 'KEYWORD_EXACT_MATCH', value: 'rain jacket' }],
    [{ kind: 'KEYWORD', matchType: 'PHRASE', expression: 'rain jacket' }, { type: 'KEYWORD_PHRASE_MATCH', value: 'rain jacket' }],
    [{ kind: 'KEYWORD', matchType: 'BROAD', expression: ' boots ' }, { type: 'KEYWORD_BROAD_MATCH', value: 'boots' }],
    [{ matchType: 'exact', expression: 'gloves' }, { type: 'KEYWORD_EXACT_MATCH', value: 'gloves' }],
    [{ kind: 'PRODUCT', matchType: 'ASIN', expression: 'B0TESTASN1' }, { type: 'PAT_ASIN', value: 'B0TESTASN1' }],
    [{ kind: 'PRODUCT', matchType: 'PRODUCT_EXACT', expression: 'asin="b0testasn1"' }, { type: 'PAT_ASIN', value: 'B0TESTASN1' }],
    // PRODUCT_EXACT is an ASIN target, never an exact keyword.
    [{ matchType: 'PRODUCT_EXACT', expression: 'B0TESTASN1' }, { type: 'PAT_ASIN', value: 'B0TESTASN1' }],
    [{ kind: 'AUTO', matchType: 'SEARCH_CLOSE_MATCH', expression: '' }, { type: 'CLOSE_MATCH' }],
    [{ kind: 'AUTO', matchType: 'QUERY_BROAD_REL_MATCHES', expression: '' }, { type: 'LOOSE_MATCH' }],
    [{ kind: 'AUTO', matchType: 'PRODUCT_SUBSTITUTES', expression: '' }, { type: 'SUBSTITUTES' }],
    [{ kind: 'AUTO', matchType: 'AUTO', expression: 'complements' }, { type: 'COMPLEMENTS' }],
  ])('%o → %o', (target, expected) => {
    expect(themeExpressionOf(target)).toEqual(expected)
  })

  it.each([
    [{ kind: 'PRODUCT', matchType: 'PRODUCT_SIMILAR', expression: 'B0TESTASN1' }],
    [{ kind: 'PRODUCT', matchType: 'ASIN', expression: 'not an asin' }],
    [{ kind: 'CATEGORY', matchType: 'CATEGORY', expression: '1234567' }],
    [{ kind: 'PRODUCT_CATEGORY', matchType: 'UNKNOWN', expression: '' }],
    [{ kind: 'AUDIENCE', matchType: 'UNKNOWN', expression: '' }],
    [{ kind: 'AUTO', matchType: 'SEARCH_RELATED_TO_YOUR_BRAND', expression: '' }],
    [{ kind: 'KEYWORD', matchType: 'EXACT', expression: '  ' }],
    [{ kind: 'KEYWORD', matchType: 'UNKNOWN', expression: 'jacket' }],
  ])('%o is not asked', (target) => {
    expect(themeExpressionOf(target)).toBeNull()
  })

  it('the join key ignores case and spacing of the value; an auto group has none', () => {
    expect(themeExpressionKey({ type: 'KEYWORD_EXACT_MATCH', value: 'Rain  Jacket ' })).toBe(themeExpressionKey({ type: 'keyword_exact_match', value: 'rain jacket' }))
    expect(themeExpressionKey({ type: 'CLOSE_MATCH', value: null })).toBe('CLOSE_MATCH|')
    expect(themeExpressionKey({ type: 'CLOSE_MATCH' })).toBe('CLOSE_MATCH|')
  })
})

describe('the documented answer', () => {
  it('the guide\'s scenario 2: three bids per keyword are its low, middle and high, in cents', () => {
    const s = suggestionsOf(GUIDE_SCENARIO_2)
    expect(s.size).toBe(5)
    expect(s.get(themeExpressionKey({ type: 'KEYWORD_BROAD_MATCH', value: 'sandals' }))).toEqual({ type: 'KEYWORD_BROAD_MATCH', value: 'sandals', theme: 'CONVERSION_OPPORTUNITIES', lowCents: 15, midCents: 45, highCents: 77 })
    expect(s.get(themeExpressionKey({ type: 'KEYWORD_PHRASE_MATCH', value: 'phone' }))).toMatchObject({ lowCents: 13, midCents: 14, highCents: 54 })
    expect(s.get(themeExpressionKey({ type: 'KEYWORD_EXACT_MATCH', value: 'basketball' }))).toMatchObject({ lowCents: 33, midCents: 61, highCents: 96 })
  })

  it('the v5 contract\'s example: amounts as strings, two themes — the standing CONVERSION_OPPORTUNITIES wins over the event', () => {
    const s = suggestionsOf(CONTRACT_V5_EXAMPLE)
    expect(s.get('CLOSE_MATCH|')).toEqual({ type: 'CLOSE_MATCH', value: null, theme: 'CONVERSION_OPPORTUNITIES', lowCents: 100, midCents: 150, highCents: 200 })
    expect(s.get('LOOSE_MATCH|')).toEqual({ type: 'LOOSE_MATCH', value: null, theme: 'CONVERSION_OPPORTUNITIES', lowCents: 110, midCents: 140, highCents: 220 })
  })

  it('an event\'s theme counts where it is the only one with an answer', () => {
    const s = suggestionsOf({
      bidRecommendations: [
        { theme: 'CONVERSION_OPPORTUNITIES', bidRecommendationsForTargetingExpressions: [{ targetingExpression: { type: 'PAT_ASIN', value: 'B0TESTASN1' }, bidValues: [] }] },
        { theme: 'BFCM_HOLIDAY', bidRecommendationsForTargetingExpressions: [{ targetingExpression: { type: 'PAT_ASIN', value: 'B0TESTASN1' }, bidValues: [{ suggestedBid: 0.9 }, { suggestedBid: 1.2 }, { suggestedBid: 1.6 }] }] },
      ],
    })
    expect(s.get(themeExpressionKey({ type: 'PAT_ASIN', value: 'B0TESTASN1' }))).toMatchObject({ theme: 'BFCM_HOLIDAY', lowCents: 90, midCents: 120, highCents: 160 })
  })

  it('missing values stay null, never made up: none, two (no middle one), one, zero or not a number', () => {
    const row = (value: string, bidValues: unknown) => ({ targetingExpression: { type: 'KEYWORD_EXACT_MATCH', value }, bidValues })
    const s = suggestionsOf({
      bidRecommendations: [{
        theme: 'CONVERSION_OPPORTUNITIES',
        bidRecommendationsForTargetingExpressions: [
          row('none', []),
          row('absent', undefined),
          row('two', [{ suggestedBid: 0.8 }, { suggestedBid: 0.4 }]),
          row('one', [{ suggestedBid: 0.5 }]),
          row('odd', [{ suggestedBid: 0 }, { suggestedBid: 'x' }, { suggestedBid: null }, { suggestedBid: -1 }, {}, { suggestedBid: '0.62' }]),
          { targetingExpression: {}, bidValues: [{ suggestedBid: 1 }] },
        ],
      }],
    })
    const get = (v: string) => s.get(themeExpressionKey({ type: 'KEYWORD_EXACT_MATCH', value: v }))
    expect(get('none')).toMatchObject({ lowCents: null, midCents: null, highCents: null })
    expect(get('absent')).toMatchObject({ lowCents: null, midCents: null, highCents: null })
    expect(get('two')).toMatchObject({ lowCents: 40, midCents: null, highCents: 80 })
    expect(get('one')).toMatchObject({ lowCents: 50, midCents: 50, highCents: 50 })
    expect(get('odd')).toMatchObject({ lowCents: 62, midCents: 62, highCents: 62 })
    expect(s.size).toBe(5) // the expression without a type is skipped
  })

  it('low / middle / high read from the sorted amounts', () => {
    expect(suggestedRange([77, 15, 45])).toEqual({ lowCents: 15, midCents: 45, highCents: 77 })
    expect(suggestedRange([])).toEqual({ lowCents: null, midCents: null, highCents: null })
  })

  it('an answer without a bidRecommendations list is not understood — an error, never an empty success', () => {
    expect(parseThemeBidRecommendations({ recommendations: [] })).toEqual({ error: expect.stringContaining('bidRecommendations') })
    expect(parseThemeBidRecommendations([])).toEqual({ error: expect.any(String) })
    expect(parseThemeBidRecommendations(null)).toEqual({ error: expect.any(String) })
    expect(suggestionsOf({ bidRecommendations: [] }).size).toBe(0)
  })
})

const CTX = { profileId: '123', region: 'EU' as const }
const keywords = (n: number): ThemeExpression[] => Array.from({ length: n }, (_, i) => ({ type: 'KEYWORD_EXACT_MATCH' as const, value: `keyword ${i}` }))
/** Amazon's answer for one request body: every expression echoed back (in upper case, to prove the join), one theme. */
const echo = (body: any, cents = (i: number) => i + 10) => new Response(JSON.stringify({
  bidRecommendations: [{
    theme: 'CONVERSION_OPPORTUNITIES',
    bidRecommendationsForTargetingExpressions: body.targetingExpressions.map((e: any, i: number) => ({
      targetingExpression: { type: e.type, ...(e.value !== undefined ? { value: String(e.value).toUpperCase() } : {}) },
      bidValues: [{ suggestedBid: cents(i) / 100 }, { suggestedBid: (cents(i) + 5) / 100 }, { suggestedBid: (cents(i) + 9) / 100 }],
    })),
  }],
}), { status: 200 })

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off'); vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const body = JSON.parse(String(init.body))
    return h.answers.shift()?.(body) ?? echo(body)
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('asking Amazon, through the gateway', () => {
  it('v5 both ways, no bidding block, auto groups without a value, the ad group\'s ids; one ledger row per call', async () => {
    const got = await fetchThemeBidRecommendations(CTX, {
      externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP',
      expressions: [{ type: 'KEYWORD_EXACT_MATCH', value: 'rain jacket' }, { type: 'PAT_ASIN', value: 'B0TESTASN1' }, { type: 'CLOSE_MATCH' }],
    })
    expect(h.calls).toHaveLength(1)
    const [call] = h.calls
    expect(call.url).toBe('https://advertising-api-eu.amazon.com/sp/targets/bid/recommendations')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers).toMatchObject({ 'Content-Type': THEME_BID_MEDIA_TYPE, Accept: THEME_BID_MEDIA_TYPE, 'Amazon-Advertising-API-Scope': '123' })
    expect(THEME_BID_MEDIA_TYPE).toBe('application/vnd.spthemebasedbidrecommendation.v5+json')
    const body = JSON.parse(String(call.init.body))
    expect(body).toEqual({
      campaignId: 'EXT-CAMP', adGroupId: 'EXT-GROUP', recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP',
      targetingExpressions: [{ type: 'KEYWORD_EXACT_MATCH', value: 'rain jacket' }, { type: 'PAT_ASIN', value: 'B0TESTASN1' }, { type: 'CLOSE_MATCH' }],
    })
    expect(body).not.toHaveProperty('bidding')
    expect(body.targetingExpressions[2]).not.toHaveProperty('value')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS', operation: 'POST /sp/targets/bid/recommendations', outcome: 'sent', success: true })])
    expect(got).toMatchObject({ sandbox: false, asked: 3, failures: [] })
    expect(got.suggestions.get(themeExpressionKey({ type: 'KEYWORD_EXACT_MATCH', value: 'rain jacket' }))).toMatchObject({ lowCents: 10, midCents: 15, highCents: 19 })
    expect(got.suggestions.get('CLOSE_MATCH|')).toMatchObject({ lowCents: 12, midCents: 17, highCents: 21 })
  })

  it('at most 100 expressions per call: 230 asked (each once) are three calls of 100, 100 and 30', async () => {
    const asked = [...keywords(230), ...keywords(20)] // 20 repeats
    const got = await fetchThemeBidRecommendations(CTX, { externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', expressions: asked })
    expect(h.calls.map((c) => JSON.parse(String(c.init.body)).targetingExpressions.length)).toEqual([100, 100, 30])
    expect(gatewayLedger).toHaveLength(3)
    expect(got.asked).toBe(230)
    expect(got.suggestions.size).toBe(230)
  })

  it('a call Amazon refuses is said in words; the other calls still count', async () => {
    h.answers.push(
      (body) => echo(body),
      () => new Response(JSON.stringify({ code: 'UNPROCESSABLE_ENTITY', details: 'Invalid advertiser and ASIN combination' }), { status: 422 }),
      (body) => echo(body),
    )
    const got = await fetchThemeBidRecommendations(CTX, { externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', expressions: keywords(250) })
    expect(h.calls).toHaveLength(3)
    expect(got.failures).toEqual([{ expressions: 100, reason: 'Amazon gives no suggested bid for this ad group (HTTP 422: Invalid advertiser and ASIN combination).' }])
    expect(got.suggestions.size).toBe(150)
    expect(got.suggestions.has(themeExpressionKey({ type: 'KEYWORD_EXACT_MATCH', value: 'keyword 150' }))).toBe(false)
  })

  it('an answer not in the documented form is a failure in words, not an empty success', async () => {
    h.answers.push(() => new Response(JSON.stringify({ suggestions: [] }), { status: 200 }))
    const got = await fetchThemeBidRecommendations(CTX, { externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', expressions: keywords(2) })
    expect(got.failures).toEqual([{ expressions: 2, reason: expect.stringContaining('not in the form Nexus reads') }])
    expect(got.suggestions.size).toBe(0)
  })

  it('sandbox mode asks nothing and answers nothing', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    const got = await fetchThemeBidRecommendations(CTX, { externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', expressions: keywords(3) })
    expect(h.calls).toHaveLength(0)
    expect(got).toMatchObject({ sandbox: true, asked: 0, failures: [] })
    expect(got.suggestions.size).toBe(0)
  })

  it('the AX2.10 blend keeps its contract: the caller\'s words with Amazon\'s middle and range; [] when Amazon fails', async () => {
    const recs = await getThemeBidRecommendations(CTX, {
      externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', biddingStrategy: 'AUTO_FOR_SALES',
      targets: [{ expression: 'rain jacket', matchType: 'EXACT' }, { expression: 'boots', matchType: 'BROAD' }],
    })
    expect(JSON.parse(String(h.calls[0].init.body))).not.toHaveProperty('bidding')
    expect(recs).toEqual([
      { expression: 'rain jacket', matchType: 'EXACT', theme: 'CONVERSION_OPPORTUNITIES', suggestedBidCents: 15, rangeLowCents: 10, rangeHighCents: 19 },
      { expression: 'boots', matchType: 'BROAD', theme: 'CONVERSION_OPPORTUNITIES', suggestedBidCents: 16, rangeLowCents: 11, rangeHighCents: 20 },
    ])
    h.answers.push(() => new Response('{"code":"BAD_REQUEST","details":"nope"}', { status: 400 }))
    expect(await getThemeBidRecommendations(CTX, { externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', targets: [{ expression: 'x', matchType: 'EXACT' }] })).toEqual([])
  })
})

describe('why Amazon gave no suggestion, in words', () => {
  const failed = (statusCode: number, body = '') => Object.assign(new Error('x'), { statusCode, body })
  it.each([
    [failed(401), 'Amazon refused the Ads sign-in (HTTP 401). Reconnect Amazon Ads for this market.'],
    [failed(429), 'Amazon is busy (too many requests). Try again in a few minutes.'],
    [failed(415), 'Amazon did not take the request\'s format (HTTP 415).'],
    [failed(503), 'Amazon had an error (HTTP 503). Try again later.'],
    [failed(400, '{"code":"BAD_REQUEST","details":"targetingExpressions too long"}'), 'Amazon refused the request (HTTP 400: targetingExpressions too long).'],
    [new Error('socket hang up'), 'Amazon could not be reached: socket hang up'],
  ])('%s', (err, words) => {
    expect(themeBidFailureReason(err)).toBe(words)
  })
})

describe('the Ads quota ledger counts it as a read (not blocked when the quota store is down)', () => {
  it('POST /sp/targets/bid/recommendations is not a mutating call; a POST that creates still is', () => {
    expect(isMutatingCall('POST', '/sp/targets/bid/recommendations')).toBe(false)
    expect(isMutatingCall('POST', '/sp/targets/bid/recommendations?x=1')).toBe(false)
    expect(isMutatingCall('POST', '/sp/targets')).toBe(true)
    expect(isMutatingCall('POST', '/sp/targets/bid')).toBe(true)
    expect(isMutatingCall('PUT', '/sp/targets/bid/recommendations')).toBe(true)
  })

  it('the quota ledger and the gateway read the same list of read-only POSTs', () => {
    expect([...ADS_READ_ONLY_POSTS].sort()).toEqual([...ADS_READ_POSTS].sort())
    for (const path of ADS_READ_POSTS) {
      expect(isMutatingCall('POST', path)).toBe(false)
      expect(adsKind('POST', `https://advertising-api-eu.amazon.com${path}`)).toBe('read')
    }
  })

  it('with the quota store down, the suggested-bid read is still sent (a read fails open)', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', '')
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1')
    const got = await fetchThemeBidRecommendations(CTX, { externalCampaignId: 'EXT-CAMP', externalAdGroupId: 'EXT-GROUP', expressions: keywords(2) })
    expect(got.failures).toEqual([])
    expect(h.calls).toHaveLength(1)
  })
})

describe('the gateway counts it as a read', () => {
  it('POST /sp/targets/bid/recommendations is a read; a POST that creates stays an action', () => {
    expect(adsKind('POST', 'https://advertising-api-eu.amazon.com/sp/targets/bid/recommendations')).toBe('read')
    expect(adsKind('POST', 'https://advertising-api-eu.amazon.com/sp/targets')).toBe('action')
    expect(adsKind('PUT', 'https://advertising-api-eu.amazon.com/sp/targets/bid/recommendations')).toBe('action')
    expect(adsKind('POST', 'https://advertising-api-eu.amazon.com/sp/campaigns/list')).toBe('read')
  })
})

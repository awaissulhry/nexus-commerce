/**
 * SD-AUD — Claude's Sponsored Display reads, run for real through the door (PGlite, production schema and policies),
 * with Amazon stood in by the response shapes of its own references (Audiences "Discovery", TargetableEntities, the SP
 * refinements, SD 3.0 targeting and bid recommendations). Nothing leaves this machine: liveCall is a stub that records
 * each request. Fake ids, names and amounts only.
 *
 * Proven: sd-audiences, sd-categories, sd-targeting-recommendations and sd-bid-recommendations send the request each
 * reference asks for (path, media type, body) for the market's profile, answer with the ids and the expression a target
 * takes, page with a cursor bound to the call, refuse before asking Amazon (no account, sandbox, a wrong combination),
 * carry Amazon's refusal in its own words (status, code, description) and a per-clause 207 failure with its code and
 * details, and strip bid money for a person without the ad-spend permission. ad-campaigns, ad-groups and ad-targets show
 * a Sponsored Display campaign's settings and its target expressions in words; a Sponsored Products row has no sd block.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
type Call = { profileId: string; method: string; path: string; body?: unknown; contentType?: string; acceptHeader?: string }
const amazon = vi.hoisted(() => ({ mode: 'live' as 'live' | 'sandbox', calls: [] as Call[], answer: (_c: Call): unknown => ({}) }))
vi.mock('../../advertising/ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsMode: () => amazon.mode,
  liveCall: async (opts: Call) => {
    amazon.calls.push({ profileId: opts.profileId, method: opts.method, path: opts.path, body: opts.body, contentType: opts.contentType, acceptHeader: opts.acceptHeader })
    return amazon.answer(opts)
  },
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { ADS_READ_POSTS, adsKind } from '../../gateway/ads.js'
import { isMutatingCall } from '../../advertising/ads-api-client.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const principal = (permissions: string[]): UserPrincipal => ({
  kind: 'user', userId: 'u-sd', label: 'SD test', via: 'claude', workspace: business, permissions: { isOwner: false, permissions: new Set(permissions) },
})
const cleared = principal([...Object.values(FEATURES), ...Object.values(FIELDS)])
const operator = principal([FEATURES.aiRun, FEATURES.adsView])

type Row = Record<string, any>
const call = async (tool: string, args: Record<string, unknown>, who: UserPrincipal = cleared) => (await inside(() => callTool(who, tool, args))).visible as Row
const amazonRefuses = (status: number, body: unknown) => () => { throw Object.assign(new Error(`[ADS-LIVE] → ${status}`), { statusCode: status, body: JSON.stringify(body) }) }

const VIEWS = [{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }]
const CATEGORY = [{ type: 'asinCategorySameAs', value: '123' }, { type: 'asinBrandSameAs', value: '9' }]
const CATEGORY_NAMED = [{ type: 'asinCategorySameAs', value: 'Helmets' }, { type: 'asinBrandSameAs', value: 'Acme' }]

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db) // c-it (SP, IT) with t-it; the IT profile P-IT-TEST
    const campaign = (id: string, ext: string, extra: Record<string, unknown>) => db.campaign.create({
      data: { id, name: `Test ${id}`, type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: ext, dailyBudget: '20.00', startDate: new Date('2026-10-01T00:00:00Z'), costType: 'cpc', ...extra } as never,
    })
    await campaign('c-sd', '100000000001', { tactic: 'T00030', servingStatus: 'ADVERTISER_STATUS_ENABLED', endDate: new Date('2026-12-31T00:00:00Z') })
    await campaign('c-sd-ctx', '100000000002', { tactic: 'T00020', costType: 'vcpm' })
    await db.adGroup.create({ data: { id: 'g-sd', campaignId: 'c-sd', name: 'SD group', externalAdGroupId: '200000000001', defaultBidCents: 85, bidOptimization: 'conversions', creativeType: 'IMAGE', servingStatus: 'AD_GROUP_STATUS_ENABLED' } })
    await db.adGroup.create({ data: { id: 'g-sd-ctx', campaignId: 'c-sd-ctx', name: 'SD contextual group', externalAdGroupId: '200000000002', bidOptimization: 'reach' } })
    await db.adProductAd.create({ data: { id: 'pa-sd', adGroupId: 'g-sd', sku: 'SKU-TEST-1', asin: 'B0FX000001', externalAdId: '300000000001', servingStatus: 'AD_STATUS_LIVE' } })
    await db.adProductAd.create({ data: { id: 'pa-store', adGroupId: 'g-sd', externalAdId: '300000000002', landingPageType: 'STORE', landingPageUrl: 'https://www.amazon.it/stores/test', adName: 'Test store ad' } })
    const target = (id: string, adGroupId: string, kind: string, extra: Record<string, unknown>) => db.adTarget.create({
      data: { id, adGroupId, kind, expressionType: 'UNKNOWN', expressionValue: '', bidCents: 0, ...extra },
    })
    await target('t-views', 'g-sd', 'AUDIENCE', { externalTargetId: '400000000001', bidCents: 110, expressionJson: VIEWS, servingStatus: 'TARGET_STATUS_LIVE' })
    await target('t-cat', 'g-sd', 'CATEGORY', { externalTargetId: '400000000002', bidCents: 90, expressionValue: '123', expressionJson: CATEGORY, resolvedExpressionJson: CATEGORY_NAMED })
    await target('t-unread', 'g-sd-ctx', 'PRODUCT', { externalTargetId: '400000000003', bidCents: 40, expressionValue: 'B0FX000003' })
    await target('n-brand', 'g-sd', 'PRODUCT', { externalTargetId: '500000000001', isNegative: true, negativeLevel: 'AD_GROUP', expressionJson: [{ type: 'asinBrandSameAs', value: '9' }] })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(() => { amazon.mode = 'live'; amazon.calls = []; amazon.answer = () => ({}) })

describe('the tools keep the read contract', () => {
  it('each is a read that reaches Amazon (openWorld), asks only ads.view, and bid money is restricted', () => {
    for (const name of ['sd-audiences', 'sd-categories', 'sd-targeting-recommendations', 'sd-bid-recommendations']) {
      expect(getTool(name), name).toMatchObject({ readOnly: true, openWorld: true, requires: ['ads.view'], category: 'insights' })
    }
    expect(getTool('sd-bid-recommendations')!.restrictedFields).toEqual({
      recommendedBidCents: 'financials.adspend.view', bidRangeLowCents: 'financials.adspend.view', bidRangeHighCents: 'financials.adspend.view', currentBidCents: 'financials.adspend.view',
    })
  })

  it('SD targeting and bid recommendations are reads for the gateway and the quota (POSTs that change nothing)', () => {
    for (const path of ['/sd/targets/recommendations', '/sd/targets/bid/recommendations']) {
      expect(ADS_READ_POSTS.has(path)).toBe(true)
      expect(isMutatingCall('POST', path)).toBe(false)
      expect(adsKind('POST', `https://advertising-api-eu.amazon.com${path}`)).toBe('read')
    }
    for (const path of ['/audiences/list', '/audiences/taxonomy/list', '/targetableEntities/list']) expect(isMutatingCall('POST', path)).toBe(false)
  })
})

describe('sd-audiences', () => {
  const AUDIENCE = {
    audienceId: '365000000000000001', audienceName: 'IM - Test Helmets', description: 'People likely to buy test helmets', category: 'In-market',
    status: 'Active', forecasts: { inventoryForecasts: { all: { dailyReach: { lowerBoundInclusive: 1000, upperBoundExclusive: 2000 } } } },
  }

  it('searches by words for the market\'s profile and gives each audience with the target expression it takes', async () => {
    amazon.answer = () => ({ audiences: [AUDIENCE], matchCount: 1 })
    const r = await call('sd-audiences', { market: 'it', words: 'helmet, biker', category: 'In-market' })
    expect(r.ok, r.error).toBe(true)
    expect(amazon.calls).toEqual([{
      profileId: 'P-IT-TEST', method: 'POST', path: '/audiences/list?maxResults=25&canTarget=true',
      body: { adType: 'SD', countries: ['IT'], filters: [{ field: 'audienceName', values: ['helmet', 'biker'] }, { field: 'category', values: ['In-market'] }] },
      contentType: 'application/json', acceptHeader: 'application/json',
    }])
    expect(r.data).toMatchObject({ market: 'IT', matchCount: 1, nextCursor: null })
    expect(r.data!.items).toEqual([{
      audienceId: '365000000000000001', name: 'IM - Test Helmets', description: 'People likely to buy test helmets', category: 'In-market', subCategory: null, status: 'Active',
      dailyReach: { from: 1000, to: 2000 },
      target: { expression: [{ type: 'audience', value: [{ type: 'audienceSameAs', value: '365000000000000001' }] }], inWords: 'Amazon audience "IM - Test Helmets" (365000000000000001)' },
    }])
  })

  it('pages with a cursor bound to the call: the next page carries Amazon\'s token; another call\'s cursor is refused', async () => {
    amazon.answer = () => ({ audiences: [AUDIENCE], nextToken: 'TOKEN-2' })
    const first = await call('sd-audiences', { market: 'IT', words: 'helmet', limit: 1 })
    expect(first.data!.nextCursor).toMatch(/^.{22}\.TOKEN-2$/)
    await call('sd-audiences', { market: 'IT', words: 'helmet', limit: 1, cursor: first.data!.nextCursor })
    expect(amazon.calls[1].path).toBe('/audiences/list?maxResults=1&nextToken=TOKEN-2&canTarget=true')
    const other = await call('sd-audiences', { market: 'IT', words: 'gloves', limit: 1, cursor: first.data!.nextCursor })
    expect(other).toMatchObject({ ok: false, error: expect.stringMatching(/^sd-audiences was called wrongly — cursor: /) })
    expect(amazon.calls).toHaveLength(2)
  })

  it('browse walks the taxonomy one level at a time', async () => {
    amazon.answer = () => ({ categoryPath: ['In-market'], categories: [{ category: 'Sporting Goods', audienceCount: 120 }] })
    const r = await call('sd-audiences', { market: 'IT', browse: true, categoryPath: ['In-market'] })
    expect(amazon.calls[0]).toMatchObject({ method: 'POST', path: '/audiences/taxonomy/list?maxResults=25', body: { adType: 'SD', countries: ['IT'], categoryPath: ['In-market'] } })
    expect(r.data!.items).toEqual([{ category: 'Sporting Goods', path: ['In-market', 'Sporting Goods'], audienceCount: 120 }])
  })

  it('refuses before asking Amazon: nothing to search, a market with no Ads account, a sandbox server', async () => {
    expect(await call('sd-audiences', { market: 'IT' })).toMatchObject({ ok: false, error: expect.stringContaining('Give words, a category') })
    expect(await call('sd-audiences', { market: 'DE', words: 'helmet' })).toMatchObject({ ok: false, error: 'No Amazon Ads account serves market DE in this business (business-overview lists the markets and accounts).' })
    amazon.mode = 'sandbox'
    expect(await call('sd-audiences', { market: 'IT', words: 'helmet' })).toMatchObject({ ok: false, error: expect.stringContaining('sandbox mode: Amazon was not asked') })
    expect(amazon.calls).toEqual([])
  })

  it("Amazon's refusal reaches the person in Amazon's own words", async () => {
    amazon.answer = amazonRefuses(400, { message: 'Invalid filter', errors: [{ errorType: 'INVALID_ARGUMENT', fieldName: 'filters', message: 'unknown field' }] })
    expect(await call('sd-audiences', { market: 'IT', words: 'helmet' })).toEqual({
      ok: false, error: 'Amazon refused the read (HTTP 400: Invalid filter — INVALID_ARGUMENT filters unknown field).',
    })
  })
})

describe('sd-categories', () => {
  it('finds contextual category ids by words, in the market\'s language, with the target expression', async () => {
    amazon.answer = () => ({
      targetableEntities: [
        { targetType: 'PRODUCT_CATEGORY', productCategoryId: '15718271', productCategoryResolved: 'Test Care', path: ['Product Category', 'Automotive', 'Test Care'], childCount: 4 },
        // The guide's sample shape (id / resolved) reads the same.
        { targetType: 'PRODUCT_CATEGORY', id: '2687787011', resolved: 'Test Wheel Care', path: ['Product Category', 'Automotive', 'Test Wheel Care'] },
        { targetType: 'AUDIENCE', audienceId: '403000000000000001', audienceResolved: 'not asked for' },
      ],
      nextToken: 'NEXT', totalResults: 5,
    })
    const r = await call('sd-categories', { market: 'IT', words: 'car care' })
    expect(amazon.calls).toEqual([{
      profileId: 'P-IT-TEST', method: 'POST', path: '/targetableEntities/list',
      body: { adProduct: 'SPONSORED_DISPLAY', searchQueryFilter: 'car care', targetTypeFilter: ['PRODUCT_CATEGORY'], maxResults: 25, locale: 'it_IT' },
      contentType: 'application/vnd.Mindreader.TargetableEntitiesResource.v1+json', acceptHeader: 'application/vnd.Mindreader.TargetableEntitiesResource.v1+json',
    }])
    expect(r.data).toMatchObject({ total: 5, nextCursor: expect.stringMatching(/\.NEXT$/) })
    expect(r.data!.items).toEqual([
      { categoryId: '15718271', name: 'Test Care', path: ['Product Category', 'Automotive', 'Test Care'], kind: 'contextual', childCount: 4, target: { expression: [{ type: 'asinCategorySameAs', value: '15718271' }], inWords: 'products in category "Test Care" (15718271)' } },
      { categoryId: '2687787011', name: 'Test Wheel Care', path: ['Product Category', 'Automotive', 'Test Wheel Care'], kind: 'contextual', childCount: null, target: { expression: [{ type: 'asinCategorySameAs', value: '2687787011' }], inWords: 'products in category "Test Wheel Care" (2687787011)' } },
    ])
  })

  it('remarketing categories come as a views audience to adjust', async () => {
    amazon.answer = () => ({ targetableEntities: [{ targetType: 'PRODUCT_CATEGORY_AUDIENCE', productCategoryId: '10981681', productCategoryResolved: 'Test Audio', path: ['Product Category Audience', 'Test Audio'] }] })
    const r = await call('sd-categories', { market: 'IT', words: 'audio', kind: 'remarketing' })
    expect((amazon.calls[0].body as Row).targetTypeFilter).toEqual(['PRODUCT_CATEGORY_AUDIENCE'])
    expect(r.data!.items[0]).toMatchObject({ kind: 'remarketing', target: { expression: [{ type: 'views', value: [{ type: 'asinCategorySameAs', value: '10981681' }, { type: 'lookback', value: '30' }] }], inWords: 'people who viewed products in category 10981681 in the last 30 days' } })
  })

  it("a category's refinements: its brands (asinBrandSameAs ids), age ranges and genres", async () => {
    amazon.answer = () => ({ brands: [{ id: '9', name: 'Acme' }, { id: '10', name: 'Other Test Brand' }], ageRanges: [{ id: '77', name: '3-5 years', translatedName: '3-5 anni' }], genres: [] })
    const r = await call('sd-categories', { market: 'IT', categoryId: '123', limit: 1 })
    expect(amazon.calls).toEqual([{ profileId: 'P-IT-TEST', method: 'GET', path: '/sp/targets/category/123/refinements?locale=it_IT', acceptHeader: 'application/vnd.spproducttargetingresponse.v3+json' }])
    expect(r.data).toMatchObject({
      categoryId: '123',
      refinements: { brands: [{ id: '9', name: 'Acme', refinement: { type: 'asinBrandSameAs', value: '9' } }], ageRanges: [{ id: '77', name: '3-5 anni', refinement: { type: 'asinAgeRangeSameAs', value: '77' } }], genres: [] },
      totals: { brands: 2, ageRanges: 1, genres: 0 },
    })
  })

  it('refuses with nothing to look up', async () => {
    expect(await call('sd-categories', { market: 'IT' })).toMatchObject({ ok: false, error: expect.stringContaining('Give words') })
    expect(amazon.calls).toEqual([])
  })
})

describe('sd-targeting-recommendations', () => {
  it("for an SD ad group: its campaign's tactic and its ASINs, categories and audiences with their expressions", async () => {
    amazon.answer = () => ({
      recommendations: {
        categories: [{ category: 123, name: 'Helmets', translatedName: 'Caschi', path: ['Sports', 'Helmets'], translatedPath: ['Sport', 'Caschi'], targetableAsinCountRange: { rangeLower: 100, rangeUpper: 500 }, rank: 1 }],
        audiences: [{ category: 'In-market', audiences: [{ audience: '365000000000000001', name: 'IM - Test Helmets', rank: 2 }] }],
      },
    })
    const r = await call('sd-targeting-recommendations', { adGroupId: 'g-sd' })
    expect(r.ok, r.error).toBe(true)
    expect(amazon.calls).toEqual([{
      profileId: 'P-IT-TEST', method: 'POST', path: '/sd/targets/recommendations?locale=it_IT',
      body: { tactic: 'T00030', products: [{ asin: 'B0FX000001' }], typeFilter: ['CATEGORY', 'AUDIENCE'] },
      contentType: 'application/vnd.sdtargetingrecommendations.v3.4+json', acceptHeader: 'application/vnd.sdtargetingrecommendations.v3.4+json',
    }])
    expect(r.data).toMatchObject({
      market: 'IT', tactic: 'T00030', asins: ['B0FX000001'], adGroup: { adGroupId: 'g-sd', name: 'SD group' },
      categories: [{ categoryId: '123', name: 'Caschi', path: ['Sport', 'Caschi'], asinCount: { from: 100, to: 500 }, rank: 1, target: { expression: [{ type: 'asinCategorySameAs', value: '123' }], inWords: 'products in category "Caschi" (123)' } }],
      audiences: [{ audienceId: '365000000000000001', name: 'IM - Test Helmets', category: 'In-market', rank: 2 }],
      totals: { products: 0, categories: 1, audiences: 1 },
    })
  })

  it('for ASINs with contextual themes: products, flat or nested as the reference has them, and per theme', async () => {
    amazon.answer = () => ({
      recommendations: {
        products: [{ products: [{ asin: 'B0FX000010', rank: 1, advertisedAsins: ['B0FX000001'] }] }, { asin: 'B0FX000011', rank: 2 }],
        themes: { themes: { products: [{ code: '200', name: 'pricier', expression: [{ type: 'asinPriceGreaterThan' }], recommendations: [{ asin: 'B0FX000012', rank: 1 }] }] } },
      },
    })
    const r = await call('sd-targeting-recommendations', { market: 'IT', asins: ['b0fx000001'], types: ['PRODUCT'], themes: [{ name: 'pricier', type: 'asinPriceGreaterThan' }] })
    expect(amazon.calls[0].body).toEqual({ tactic: 'T00020', products: [{ asin: 'B0FX000001' }], typeFilter: ['PRODUCT'], themes: { product: [{ name: 'pricier', expression: [{ type: 'asinPriceGreaterThan' }] }] } })
    expect(r.data!.products.map((p: Row) => [p.asin, p.target.inWords])).toEqual([['B0FX000010', 'product B0FX000010'], ['B0FX000011', 'product B0FX000011']])
    expect(r.data!.themes).toEqual([{ name: 'pricier', code: '200', expression: [{ type: 'asinPriceGreaterThan' }], products: [{ asin: 'B0FX000012', rank: 1, advertisedAsins: [], target: { expression: [{ type: 'asinSameAs', value: 'B0FX000012' }], inWords: 'product B0FX000012' } }] }])
  })

  it('refuses what Amazon would refuse, before asking it', async () => {
    expect(await call('sd-targeting-recommendations', { market: 'IT', asins: ['B0FX000001'], tactic: 'T00030', types: ['PRODUCT'] }))
      .toMatchObject({ ok: false, error: 'Amazon gives PRODUCT recommendations only for tactic T00020; tactic T00030 takes CATEGORY and AUDIENCE.' })
    expect(await call('sd-targeting-recommendations', { market: 'IT', asins: ['B0FX000001'], types: ['CATEGORY'], themes: [{ name: 'x', type: 'asinBrandSameAs' }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('Themes refine PRODUCT recommendations') })
    expect(await call('sd-targeting-recommendations', { adGroupId: 'g-c-it' })).toMatchObject({ ok: false, error: expect.stringContaining('is not a Sponsored Display ad group') })
    expect(await call('sd-targeting-recommendations', { market: 'IT' })).toMatchObject({ ok: false, error: expect.stringContaining('Give the advertised ASINs') })
    expect(amazon.calls).toEqual([])
  })
})

describe('sd-bid-recommendations', () => {
  const BIDS = {
    costType: 'cpc', bidOptimization: 'conversions',
    bidRecommendations: [
      { code: '200', rangeLower: 0.5, rangeUpper: 1.5, recommended: 0.95 },
      { code: '400', details: 'No recommendation for this category' },
    ],
  }

  it("for an SD ad group's own targets: its ASINs, cost type, bid optimization and creative type; per clause the bid or Amazon's reason", async () => {
    amazon.answer = () => BIDS
    const r = await call('sd-bid-recommendations', { adGroupId: 'g-sd' })
    expect(r.ok, r.error).toBe(true)
    expect(amazon.calls).toEqual([{
      profileId: 'P-IT-TEST', method: 'POST', path: '/sd/targets/bid/recommendations',
      body: {
        products: [{ asin: 'B0FX000001' }], costType: 'cpc', bidOptimization: 'conversions', creativeType: 'IMAGE',
        targetingClauses: [{ targetingClause: { expressionType: 'manual', expression: CATEGORY } }, { targetingClause: { expressionType: 'manual', expression: VIEWS } }],
      },
      contentType: 'application/vnd.sdtargetingrecommendations.v3.3+json', acceptHeader: 'application/vnd.sdtargetingrecommendations.v3.3+json',
    }])
    expect(r.data).toMatchObject({ market: 'IT', currency: 'EUR', costType: 'cpc', bidOptimization: 'conversions', creativeType: 'IMAGE' })
    expect(r.data!.items).toEqual([
      { targetId: 't-cat', currentBidCents: 90, inWords: 'products in category "Helmets" (123), brand "Acme" (9)', expression: CATEGORY, recommendedBidCents: 95, bidRangeLowCents: 50, bidRangeHighCents: 150 },
      { targetId: 't-views', currentBidCents: 110, inWords: 'people who viewed the advertised products in the last 30 days', expression: VIEWS, noBid: 'Amazon gave no bid: 400 — No recommendation for this category' },
    ])
  })

  it('a person without the ad-spend permission gets the same answer without the bids', async () => {
    amazon.answer = () => BIDS
    const r = await call('sd-bid-recommendations', { adGroupId: 'g-sd' }, operator)
    expect(r.data!.items[0]).toEqual({ targetId: 't-cat', inWords: 'products in category "Helmets" (123), brand "Acme" (9)', expression: CATEGORY })
  })

  it('expressions as given (numbers sent as text), for a market and ASINs; the vcpm default is reach', async () => {
    amazon.answer = () => ({ bidRecommendations: [{ code: '200', rangeLower: 2, rangeUpper: 4, recommended: 3 }] })
    const r = await call('sd-bid-recommendations', { market: 'IT', asins: ['B0FX000001'], costType: 'vcpm', expressions: [[{ type: 'audience', value: [{ type: 'audienceSameAs', value: 365000000000001 }] }]] })
    expect(amazon.calls[0].body).toMatchObject({ costType: 'vcpm', bidOptimization: 'reach', creativeType: 'IMAGE', targetingClauses: [{ targetingClause: { expressionType: 'manual', expression: [{ type: 'audience', value: [{ type: 'audienceSameAs', value: '365000000000001' }] }] } }] })
    expect(r.data!.items).toEqual([{ inWords: 'Amazon audience 365000000000001', expression: [{ type: 'audience', value: [{ type: 'audienceSameAs', value: '365000000000001' }] }], recommendedBidCents: 300, bidRangeLowCents: 200, bidRangeHighCents: 400 }])
  })

  it('refuses before asking Amazon: a wrong bid optimization, a Sponsored Products target, an expression Nexus has not read, a sandbox server', async () => {
    expect(await call('sd-bid-recommendations', { market: 'IT', asins: ['B0FX000001'], costType: 'cpc', bidOptimization: 'reach', expressions: [VIEWS] }))
      .toMatchObject({ ok: false, error: 'Bid optimization reach does not go with cost type cpc: cpc takes clicks or conversions.' })
    expect(await call('sd-bid-recommendations', { targetIds: ['t-it'], asins: ['B0FX000001'] })).toMatchObject({ ok: false, error: expect.stringContaining('Not Sponsored Display targets of this business: t-it') })
    expect(await call('sd-bid-recommendations', { adGroupId: 'g-sd-ctx', asins: ['B0FX000001'] })).toMatchObject({ ok: false, error: expect.stringContaining("Nexus has not read these targets' expressions from Amazon yet (1)") })
    amazon.mode = 'sandbox'
    expect(await call('sd-bid-recommendations', { adGroupId: 'g-sd' })).toMatchObject({ ok: false, error: expect.stringContaining('sandbox mode') })
    expect(amazon.calls).toEqual([])
  })

  it("Amazon's refusal of the whole request names its status, code and description", async () => {
    amazon.answer = amazonRefuses(422, { code: 'INVALID_ARGUMENT', description: 'products must not be empty' })
    expect(await call('sd-bid-recommendations', { adGroupId: 'g-sd' })).toEqual({ ok: false, error: 'Amazon refused the read (HTTP 422: INVALID_ARGUMENT — products must not be empty).' })
  })
})

describe('ad-campaigns, ad-groups and ad-targets show Sponsored Display settings', () => {
  it("ad-campaigns: an SD campaign's tactic in words, serving status and dates; a Sponsored Products one has no sd block", async () => {
    const r = await call('ad-campaigns', { market: 'IT', limit: 100 })
    const byId = Object.fromEntries(r.data!.items.map((c: Row) => [c.campaignId, c]))
    expect(byId['c-sd']).toMatchObject({ adProduct: 'SPONSORED_DISPLAY', costType: 'cpc', sd: { tactic: 'T00030', tacticWords: expect.stringMatching(/^audiences/), servingStatus: 'ADVERTISER_STATUS_ENABLED', startDate: '2026-10-01', endDate: '2026-12-31' } })
    expect(byId['c-it']).not.toHaveProperty('sd')
  })

  it("ad-groups: the campaign's SD settings, each ad group's bid optimization, its ads' landing pages, its negatives in words", async () => {
    const r = await call('ad-groups', { campaignId: 'c-sd' })
    expect(r.ok, r.error).toBe(true)
    expect(r.data!.campaign.sd).toEqual({ tactic: 'T00030', tacticWords: expect.any(String), costType: 'cpc', servingStatus: 'ADVERTISER_STATUS_ENABLED', startDate: '2026-10-01', endDate: '2026-12-31', portfolioId: null })
    const g = r.data!.items[0]
    expect(g.sd).toEqual({
      bidOptimization: 'conversions', creativeType: 'IMAGE', servingStatus: 'AD_GROUP_STATUS_ENABLED', audienceTargets: 1,
      negativeTargets: [{ targetId: 'n-brand', status: 'ENABLED', inWords: 'brand 9', servingStatus: null }],
    })
    const ads = Object.fromEntries(g.productAds.map((a: Row) => [a.productAdId, a.sd]))
    expect(ads['pa-sd']).toEqual({ servingStatus: 'AD_STATUS_LIVE', landingPage: null, adName: null })
    expect(ads['pa-store']).toEqual({ servingStatus: null, landingPage: { type: 'STORE', url: 'https://www.amazon.it/stores/test' }, adName: 'Test store ad' })
    const sp = await call('ad-groups', { campaignId: 'c-it' })
    expect(sp.data!.campaign).not.toHaveProperty('sd')
    expect(sp.data!.items[0]).not.toHaveProperty('sd')
  })

  it('ad-targets: an SD target in words with its expressions and serving status', async () => {
    const r = await call('ad-targets', { campaignId: 'c-sd' })
    const byId = Object.fromEntries(r.data!.items.map((t: Row) => [t.targetId, t]))
    expect(byId['t-views'].sd).toEqual({ inWords: 'people who viewed the advertised products in the last 30 days', expression: VIEWS, resolvedExpression: null, servingStatus: 'TARGET_STATUS_LIVE' })
    expect(byId['t-cat'].sd.inWords).toBe('products in category "Helmets" (123), brand "Acme" (9)')
    const sp = await call('ad-targets', { campaignId: 'c-it' })
    expect(sp.data!.items[0]).not.toHaveProperty('sd')
  })
})

/**
 * Sponsored Display extras (P3c) — the clients of the SD optimization rules, budget rules, budget recommendations and
 * usage, forecasts and the brand-safety deny list, driven through the REAL Ads client and the REAL channel gateway with
 * `fetch` stubbed (the pattern of ads-api-client.budget-rules.vitest.test.ts): each request's method, path, media type
 * and body as Amazon's SD 3.0 spec writes them, the answers in the spec's shapes (207 items, HTTP errors), one ledger row
 * per send, the read-only POSTs counted as reads, and nothing sent in sandbox mode. Values are made up (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import { adsKind } from '../../gateway/ads.js'
import { isMutatingCall } from '../ads-api-client.js'
import {
  adGroupSdOptimizationRules, attachSdBudgetRule, attachSdOptimizationRule, createSdBudgetRule, createSdOptimizationRule, detachSdBudgetRule,
  detachSdOptimizationRule, getSdBudgetRule, getSdOptimizationRule, listSdBudgetRules, listSdOptimizationRules, SD_BUDGET_RECOMMENDATIONS_PATH,
  SD_BUDGET_USAGE_PATH, sdBudgetRecommendations, sdBudgetRuleCampaigns, sdBudgetUsage, sdCampaignBudgetRules, updateSdBudgetRule, updateSdOptimizationRule,
} from './sd-rules.client.js'
import { parseSdForecast, sdForecast, SD_FORECAST_PATH } from './sd-forecasts.client.js'
import { addSdDenyDomains, clearSdDenyList, listSdDenyList, sdBrandSafetyRequest, sdBrandSafetyRequests, sdBrandSafetyResults } from './sd-brand-safety.client.js'
import { SdAmazonError } from './sd-answer.js'

const ctx = { profileId: '123', region: 'EU' as const }
const HOST = 'https://advertising-api-eu.amazon.com'
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const last = () => h.calls[h.calls.length - 1]
const bodyOf = (i = h.calls.length - 1) => JSON.parse(String(h.calls[i].init.body))
const headers = (i = h.calls.length - 1) => h.calls[i].init.headers as Record<string, string>

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response('{}', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('optimization rules', () => {
  const held = { ruleId: 'OR-1', ruleName: 'Test cap', state: 'enabled', ruleConditions: [{ metricName: 'COST_PER_ORDER', comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: 12.5 }] }

  it('create: one POST, a bare array of one rule, application/json, the profile scope; the 207 item gives the id', async () => {
    h.answers.push(json([{ code: 'SUCCESS', description: 'ok', ruleId: 'OR-9' }], 207))
    expect(await createSdOptimizationRule(ctx, { name: 'Test cap', metric: 'COST_PER_CLICK', threshold: 0.75 })).toEqual({ ok: true, id: 'OR-9', error: null })
    expect(last().url).toBe(`${HOST}/sd/optimizationRules`)
    expect(last().init.method).toBe('POST')
    expect(bodyOf()).toEqual([{ state: 'enabled', ruleName: 'Test cap', ruleConditions: [{ metricName: 'COST_PER_CLICK', comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: 0.75 }] }])
    expect(headers()).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json', 'Amazon-Advertising-API-Scope': '123' })
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS', method: 'POST', outcome: 'sent', success: true, operation: 'POST /sd/optimizationRules' })])
  })

  it("a refused item is Amazon's code and description; a 5xx on a create is not sent again", async () => {
    h.answers.push(json([{ code: 'INVALID_ARGUMENT', description: 'Threshold below minimum' }], 207))
    expect(await createSdOptimizationRule(ctx, { name: 'x', metric: 'COST_PER_ORDER', threshold: 1 })).toEqual({ ok: false, id: null, error: 'Amazon refused it: INVALID_ARGUMENT — Threshold below minimum.' })
    h.calls = []
    h.answers.push(json({ code: 'INTERNAL_ERROR', description: 'Try later' }, 502))
    await expect(createSdOptimizationRule(ctx, { name: 'x', metric: 'COST_PER_ORDER', threshold: 6 })).rejects.toThrow('Amazon answered 502: INTERNAL_ERROR — Try later.')
    expect(h.calls).toHaveLength(1)
  })

  it('update is a PUT of the whole rule; attach and detach name the ad group in the path and one rule id in the body', async () => {
    h.answers.push(json([{ code: 'SUCCESS', ruleId: 'OR-1' }], 207))
    expect((await updateSdOptimizationRule(ctx, 'OR-1', { name: 'Test cap', metric: 'COST_PER_ORDER', threshold: 15 })).ok).toBe(true)
    expect(last().init.method).toBe('PUT')
    expect(bodyOf()).toEqual([{ ruleId: 'OR-1', state: 'enabled', ruleName: 'Test cap', ruleConditions: [{ metricName: 'COST_PER_ORDER', comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: 15 }] }])
    h.answers.push(json([{ code: 'SUCCESS', ruleId: 'OR-1' }], 207))
    expect((await attachSdOptimizationRule(ctx, '200000000001', 'OR-1')).ok).toBe(true)
    expect(last().url).toBe(`${HOST}/sd/adGroups/200000000001/optimizationRules`)
    expect(bodyOf()).toEqual({ optimizationRuleIds: ['OR-1'] })
    h.answers.push(json({ code: '207', responses: [{ code: 'INVALID_ARGUMENT', details: 'Rule is not associated', optimizationRuleId: 'OR-1' }] }, 207))
    expect(await detachSdOptimizationRule(ctx, '200000000001', 'OR-1')).toEqual({ ok: false, id: 'OR-1', error: 'Amazon refused it: INVALID_ARGUMENT — Rule is not associated.' })
    expect(last().url).toBe(`${HOST}/sd/adGroups/200000000001/optimizationRules/disassociate`)
  })

  it('reads: the filters as Amazon takes them (comma lists, ≤ 50), one rule (404 is none), an ad group\'s rule', async () => {
    h.answers.push(json([held]))
    expect(await listSdOptimizationRules(ctx, { adGroupIds: ['1', '2'], name: 'Test cap', count: 100 })).toEqual([{ ruleId: 'OR-1', name: 'Test cap', state: 'enabled', metric: 'COST_PER_ORDER', comparison: 'LESS_THAN_OR_EQUAL_TO', threshold: 12.5 }])
    expect(last().url).toBe(`${HOST}/sd/optimizationRules?count=100&name=Test%20cap&adGroupIdFilter=1%2C2`)
    h.answers.push(json({ code: 'NOT_FOUND', description: 'not found' }, 404))
    expect(await getSdOptimizationRule(ctx, 'OR/../x')).toBeNull()
    expect(last().url).toBe(`${HOST}/sd/optimizationRules/OR%2F..%2Fx`)
    h.answers.push(json([held]))
    expect((await adGroupSdOptimizationRules(ctx, '200000000001')).map((r) => r.ruleId)).toEqual(['OR-1'])
    h.answers.push(json({ rules: [] }))
    await expect(listSdOptimizationRules(ctx)).rejects.toThrow(/was not understood/)
  })
})

describe('budget rules', () => {
  const sdRule = {
    ruleId: 'BR-1', ruleState: 'ACTIVE', ruleStatus: 'ACTIVE',
    ruleDetails: {
      name: 'Test weekend', ruleType: 'SCHEDULE', budgetIncreaseBy: { type: 'PERCENT', value: 20 },
      duration: { dateRangeTypeRuleDuration: { startDate: '20991101', endDate: '20991130' } },
      recurrence: { type: 'WEEKLY', daysOfWeek: ['SATURDAY'], intraDaySchedule: [{ startTime: '18:00:00', endTime: '22:00:00' }] },
    },
  }

  it('the list is paged by pageSize 30 and nextToken; a rule reads as the Sponsored Products read does, with its hours', async () => {
    h.answers.push(json({ budgetRulesForAdvertiserResponse: [sdRule], nextToken: 'next-1' }))
    const page = await listSdBudgetRules(ctx, null)
    expect(last().url).toBe(`${HOST}/sd/budgetRules?pageSize=30`)
    expect(page.nextToken).toBe('next-1')
    expect(page.rules[0]).toMatchObject({ ruleId: 'BR-1', name: 'Test weekend', ruleType: 'SCHEDULE', ruleState: 'ACTIVE', increasePct: 20, startDate: '20991101', endDate: '20991130', recurrence: 'WEEKLY', daysOfWeek: ['SATURDAY'], window: { startTime: '18:00:00', endTime: '22:00:00' } })
    h.answers.push(json({ budgetRulesForAdvertiserResponse: [], nextToken: null }))
    await listSdBudgetRules(ctx, 'next-1')
    expect(last().url).toBe(`${HOST}/sd/budgetRules?pageSize=30&nextToken=next-1`)
    h.answers.push(json({ budgetRule: sdRule }))
    expect((await getSdBudgetRule(ctx, 'BR-1'))?.details).toEqual(sdRule.ruleDetails)
    h.answers.push(json({ code: 'NOT_FOUND', details: 'no rule' }, 404))
    expect(await getSdBudgetRule(ctx, 'BR-2')).toBeNull()
  })

  it('a campaign\'s rules and a rule\'s campaigns', async () => {
    h.answers.push(json({ associatedRules: [sdRule] }))
    expect((await sdCampaignBudgetRules(ctx, '100000000001')).map((r) => r.ruleId)).toEqual(['BR-1'])
    expect(last().url).toBe(`${HOST}/sd/campaigns/100000000001/budgetRules`)
    h.answers.push(json({ associatedCampaigns: [{ campaignId: '100000000001', campaignName: 'Test display', ruleStatus: 'ACTIVE' }], nextToken: '' }))
    expect(await sdBudgetRuleCampaigns(ctx, 'BR-1')).toEqual({ campaigns: [{ campaignId: '100000000001', name: 'Test display', ruleStatus: 'ACTIVE' }], nextToken: null })
    expect(last().url).toBe(`${HOST}/sd/budgetRules/BR-1/campaigns?pageSize=30`)
  })

  it('create, update, attach and detach send Amazon\'s bodies; a refusal is Amazon\'s code and details', async () => {
    h.answers.push(json({ responses: [{ code: 'SUCCESS', ruleId: 'BR-7' }] }, 207))
    expect(await createSdBudgetRule(ctx, sdRule.ruleDetails)).toEqual({ ok: true, id: 'BR-7', error: null })
    expect(bodyOf()).toEqual({ budgetRulesDetails: [sdRule.ruleDetails] })
    h.answers.push(json({ responses: [{ code: 'INVALID_ARGUMENT', details: 'startDate must not be in the past' }] }, 207))
    expect(await updateSdBudgetRule(ctx, 'BR-1', 'PAUSED', sdRule.ruleDetails)).toEqual({ ok: false, id: null, error: 'Amazon refused it: INVALID_ARGUMENT — startDate must not be in the past.' })
    expect(last().init.method).toBe('PUT')
    expect(bodyOf()).toEqual({ budgetRulesDetails: [{ ruleId: 'BR-1', ruleState: 'PAUSED', ruleDetails: sdRule.ruleDetails }] })
    h.answers.push(json({ responses: [{ code: 'SUCCESS', ruleId: 'BR-1' }] }, 207))
    expect((await attachSdBudgetRule(ctx, '100000000001', 'BR-1')).ok).toBe(true)
    expect(bodyOf()).toEqual({ budgetRuleIds: ['BR-1'] })
    h.answers.push(json({}))
    expect((await detachSdBudgetRule(ctx, '100000000001', 'BR-1')).ok).toBe(true)
    expect(last().init.method).toBe('DELETE')
    expect(last().url).toBe(`${HOST}/sd/campaigns/100000000001/budgetRules/BR-1`)
    h.answers.push(json({ code: 'UNPROCESSABLE_ENTITY', details: 'Rule is not associated with the campaign' }, 422))
    await expect(detachSdBudgetRule(ctx, '100000000001', 'BR-9')).rejects.toThrow('Amazon answered 422: UNPROCESSABLE_ENTITY — Rule is not associated with the campaign.')
  })
})

describe('budget recommendations, usage and forecasts: POSTs that only answer', () => {
  it('are reads for the quota ledger and the gateway', () => {
    for (const path of [SD_BUDGET_RECOMMENDATIONS_PATH, SD_BUDGET_USAGE_PATH, SD_FORECAST_PATH]) {
      expect(isMutatingCall('POST', path), path).toBe(false)
      expect(adsKind('POST', `${HOST}${path}`), path).toBe('read')
    }
    expect(adsKind('POST', `${HOST}/sd/optimizationRules`)).toBe('action')
    expect(adsKind('POST', `${HOST}/sd/brandSafety/deny`)).toBe('action')
  })

  it('recommendations and usage: their versioned media types, ≤ 100 ids, success and error per campaign', async () => {
    h.answers.push(json({
      budgetRecommendationsSuccessResults: [{ index: 0, campaignId: '1', suggestedBudget: 30, sevenDaysMissedOpportunities: { startDate: '2026-10-13', endDate: '2026-10-19', percentTimeInBudget: 70, estimatedMissedSalesLower: 10, estimatedMissedSalesUpper: 20 } }],
      budgetRecommendationsErrorResults: [{ index: 1, campaignId: '2', code: '400', details: 'No data' }],
    }, 207))
    const recs = await sdBudgetRecommendations(ctx, Array.from({ length: 120 }, (_, i) => String(i + 1)))
    expect(headers()).toMatchObject({ 'Content-Type': 'application/vnd.sdbudgetrecommendations.v3+json', Accept: 'application/vnd.sdbudgetrecommendations.v3+json' })
    expect(bodyOf().campaignIds).toHaveLength(100)
    expect(recs.recommendations[0]).toMatchObject({ campaignId: '1', suggestedBudget: 30, percentTimeInBudget: 70, missed: { sales: { low: 10, high: 20 } } })
    expect(recs.errors).toEqual([{ campaignId: '2', error: '400 — No data' }])
    h.answers.push(json({ success: [{ campaignId: '1', budgetUsagePercent: 55.5, budget: 30, usageUpdatedTimestamp: '2026-10-20T09:00:00Z', index: 0 }], error: [] }, 207))
    expect(await sdBudgetUsage(ctx, ['1'])).toEqual({ usage: [{ campaignId: '1', usedPercent: 55.5, budget: 30, asOf: '2026-10-20T09:00:00Z' }], errors: [] })
    expect(headers()).toMatchObject({ 'Content-Type': 'application/vnd.sdcampaignbudgetusage.v1+json' })
    expect(last().url).toBe(`${HOST}/sd/campaigns/budget/usage`)
  })

  it('a forecast: the v3.1 media type, the request built from the plan, the answer read (x as an array or an object)', async () => {
    h.answers.push(json({ bidOptimization: 'reach', forecastStatus: 'IMPRESSION_TARGETING_TOO_NARROW', lifetimeForecasts: [{ metric: 'REACH', value: { min: 5, max: 9 } }], curves: [{ graph: 'BUDGET', meetThreshold: false, points: [{ isFocus: true, x: { value: 12 }, y: [{ label: 'REACH', value: { min: 1, max: 2 } }] }] }] }))
    const f = await sdForecast(ctx, {
      campaign: { startDate: '20991101', costType: 'vcpm' }, adGroup: { bidOptimization: 'reach', creativeType: 'VIDEO', defaultBid: 4 },
      skus: ['TEST-SKU'], targets: [{ expression: [{ type: 'asinSameAs', value: 'B0FXTEST01' }] }], negatives: [{ type: 'asinBrandSameAs', value: '123' }],
    })
    expect(headers()).toMatchObject({ 'Content-Type': 'application/vnd.sdforecasts.v3.1+json', Accept: 'application/vnd.sdforecasts.v3.1+json' })
    expect(bodyOf()).toEqual({
      campaign: { startDate: '20991101', costType: 'vcpm' }, adGroup: { bidOptimization: 'reach', creativeType: 'VIDEO', defaultBid: 4 },
      productAds: [{ sku: 'TEST-SKU' }], targetingClauses: [{ expressionType: 'manual', expression: [{ type: 'asinSameAs', value: 'B0FXTEST01' }] }],
      negativeTargetingClauses: [{ expressionType: 'manual', expression: [{ type: 'asinBrandSameAs', value: '123' }] }],
    })
    expect(f).toMatchObject({ status: 'IMPRESSION_TARGETING_TOO_NARROW', lifetime: { REACH: { min: 5, max: 9 } }, budgetCurve: [{ budget: 12, focus: true, reach: { min: 1, max: 2 }, clicks: null }], curveMeetsThreshold: false })
    expect(() => parseSdForecast({ nothing: true })).toThrow(SdAmazonError)
    h.answers.push(json({ code: '400', details: 'productAds must not be empty' }, 400))
    await expect(sdForecast(ctx, { campaign: { startDate: '20991101', costType: 'cpc' }, adGroup: { bidOptimization: 'clicks' }, skus: [], targets: [] })).rejects.toThrow('Amazon answered 400: 400 — productAds must not be empty.')
  })
})

describe('the brand-safety deny list', () => {
  it('reads the list page, the requests and one request with its results', async () => {
    h.answers.push(json({ pagination: { total: 1, limit: 1000, offset: 0 }, domains: [{ domainId: 5, name: 'example.com', type: 'WEBSITE', state: 'ENABLED', createdAt: '2026-10-01T00:00:00Z' }] }))
    expect(await listSdDenyList(ctx)).toEqual({ total: 1, domains: [{ domainId: '5', name: 'example.com', type: 'WEBSITE', state: 'ENABLED', createdAt: '2026-10-01T00:00:00Z' }] })
    expect(last().url).toBe(`${HOST}/sd/brandSafety/deny?startIndex=0&count=1000`)
    h.answers.push(json({ requestStatusList: [{ requestId: 'R1', timestamp: 't', status: 'IN_PROGRESS', statusDetails: 'wait' }] }))
    expect(await sdBrandSafetyRequests(ctx)).toEqual([{ requestId: 'R1', at: 't', status: 'IN_PROGRESS', details: 'wait' }])
    h.answers.push(json({ requestStatus: { requestId: 'R1', status: 'COMPLETED', statusDetails: 'done' } }))
    expect(await sdBrandSafetyRequest(ctx, 'R1')).toMatchObject({ requestId: 'R1', status: 'COMPLETED' })
    expect(last().url).toBe(`${HOST}/sd/brandSafety/R1/status`)
    h.answers.push(json({ results: [{ status: 'FAILURE', details: 'Invalid domain', domainId: 0, name: 'bad' }] }))
    expect(await sdBrandSafetyResults(ctx, 'R1')).toEqual([{ name: 'bad', status: 'FAILURE', details: 'Invalid domain' }])
  })

  it('an add is one POST of the domains; a clear is one DELETE of the whole list; both answer a request id (202)', async () => {
    h.answers.push(json({ requestId: 'R2' }, 202))
    expect(await addSdDenyDomains(ctx, [{ name: 'example.com', type: 'WEBSITE' }, { name: '1234567890', type: 'APP' }])).toEqual({ requestId: 'R2' })
    expect(last().init.method).toBe('POST')
    expect(bodyOf()).toEqual({ domains: [{ name: 'example.com', type: 'WEBSITE' }, { name: '1234567890', type: 'APP' }] })
    h.answers.push(json({ requestId: 'R3' }, 202))
    expect(await clearSdDenyList(ctx)).toEqual({ requestId: 'R3' })
    expect(last().init.method).toBe('DELETE')
    expect(last().init.body ?? null).toBeNull()
    expect(last().url).toBe(`${HOST}/sd/brandSafety/deny`)
    h.answers.push(json({ code: 'UNAUTHORIZED', description: 'Brand Registry is required' }, 403))
    await expect(addSdDenyDomains(ctx, [{ name: 'example.com', type: 'WEBSITE' }])).rejects.toThrow('Amazon answered 403: UNAUTHORIZED — Brand Registry is required.')
  })
})

describe('sandbox mode', () => {
  it('asks nothing and makes nothing up', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    await expect(listSdOptimizationRules(ctx)).rejects.toThrow(/sandbox mode on this server/)
    await expect(clearSdDenyList(ctx)).rejects.toThrow(/nothing was asked of Amazon/)
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toHaveLength(0)
  })
})

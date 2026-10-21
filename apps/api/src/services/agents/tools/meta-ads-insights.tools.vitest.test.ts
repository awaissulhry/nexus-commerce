/**
 * Meta ads step 7 — meta-ads-numbers, meta-ads-report, meta-ads-saved-reports. Every read asks Meta only from the fixed
 * lists (services/meta/meta-insights-lists.ts) and only what the real gateway lets through (a GET's query keys and values;
 * a report run's whole POST body); every campaign, ad set, ad or report run id a caller names is the chosen ad account's
 * own; a combination Meta does not keep, a dead attribution window or a breakdown Nexus does not ask is refused in words
 * before any call; every amount sits under the tools' restricted keys; a person without the ad-spend permission cannot
 * sort or filter by an amount; the portfolio's reports only when no other business reads an ad account of it; no file or
 * sharing link of an unknown shape is passed on. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  answer: null as null | ((req: Req) => unknown),
  known: new Map<string, string>(),
  owners: new Map<string, string>(),
  ownerAnswer: null as null | ((req: Req) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
  products: [] as Array<{ id: string; sku: string }>,
  runs: [] as Array<{ connectionId: string; operation: string; adAccountId: string; params: Record<string, unknown> }>,
  runAnswer: null as null | (() => unknown),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    if (/[oO]wnerCheck$/.test(req.operation)) {
      const out = h.ownerAnswer?.(req)
      if (out instanceof Error) throw out
      if (out) return { body: out, calls: 1 }
      return { body: Object.fromEntries(String(req.query?.fields ?? '').split(',').map((f) => [f, f === 'account_id' ? h.owners.get(req.path) ?? '5550001112' : 'x'])), calls: 1 }
    }
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return { body: out ?? { data: [] }, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => { throw new Error('step 7 reads page by page with metaReadOne') }),
}))
vi.mock('../../gateway/meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../gateway/meta.js')>()),
  metaReportRunCall: vi.fn(async (req: { connectionId: string; operation: string; adAccountId: string; params: Record<string, unknown> }) => {
    h.runs.push(req)
    const out = h.runAnswer?.() ?? { report_run_id: '6000000000001' }
    if (out instanceof Error) throw out
    const text = JSON.stringify(out)
    return { outcome: 'sent', ok: true, status: 200, headers: new Headers(), text, url: '', attempts: 1, verdict: null, rate: { remaining: null, limit: null }, json: () => JSON.parse(text) }
  }),
}))
vi.mock('../../../db.js', () => {
  const found = (pairs: Array<[string, string]>) => vi.fn(async ({ where }: { where: Record<string, string> }) =>
    (pairs.some(([key, kind]) => where[key] && h.known.get(where[key]) === kind) ? { id: 'x' } : null))
  return {
    default: {
      metaAdsCampaign: { findFirst: found([['campaignId', 'campaign']]) },
      metaAdsAdSet: { findFirst: found([['adSetId', 'adset']]) },
      metaAdsAd: { findFirst: found([['adId', 'ad'], ['creativeId', 'creative']]) },
      product: { findMany: vi.fn(async ({ where }: { where: { sku: { in: string[] } } }) => h.products.filter((p) => where.sku.in.includes(p.sku))) },
      $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
    },
  }
})

import { META_ADS_INSIGHTS_TOOLS, NUMBERS_MONEY, REPORT_MONEY, SAVED_MONEY } from './meta-ads-insights.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem, metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const tool = (name: string) => META_ADS_INSIGHTS_TOOLS.find((t) => t.name === name)!
const allMoney = { can: () => true, via: 'claude' as const }
const noMoney = { can: (p: string) => !p.startsWith('financials.'), via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>, ctx: unknown = allMoney) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const data = async (name: string, args: Record<string, unknown>, ctx: unknown = allMoney) => {
  const res = await run(name, args, ctx)
  expect(res, JSON.stringify(res)).toMatchObject({ ok: true })
  return res.data as Record<string, any>
}
const refused = async (name: string, args: Record<string, unknown>, ctx: unknown = allMoney) => {
  const res = await run(name, args, ctx)
  expect(res.ok, JSON.stringify(res)).toBe(false)
  return String(res.error)
}
const refusedByMeta = (words: string, code = '100') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: code, channelMessage: words } as never }), 'x', 1)
const insightCalls = () => h.calls.filter((c) => !/[oO]wnerCheck$/.test(c.operation))
const last = () => insightCalls()[insightCalls().length - 1]
/** Every GET made passes the real gateway (its query keys and values on the allow-list for that path). */
const gatewayProblems = () => h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, p]) => p)
/** A report run's body as metaReportRunCall sends it, judged by the real write allow-list. */
const runVerdict = (i = 0) => {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(h.runs[i].params)) if (v !== undefined && v !== null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  return metaWriteVerdict({ method: 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/act_${h.runs[i].adAccountId}/insights`, kind: 'read', body: body.toString() })
}
/** Every key in an answer that holds money is one of the tool's restricted keys, or sits under one. */
const moneyOutside = (value: unknown, restricted: Record<string, unknown>, under = false): string[] => {
  if (Array.isArray(value)) return value.flatMap((v) => moneyOutside(v, restricted, under))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => {
    const inside = under || k in restricted
    return [...(!inside && /Cents$|spend|roas|cpc|cpm|cost_per/i.test(k) ? [k] : []), ...moneyOutside(v, restricted, inside)]
  })
}

const CAMPAIGN = '120000000000101'
const ADSET = '120000000000201'
const AD = '120000000000301'
const RUN = '6000000000001'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok',
  adAccount: { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: '120000000000010' }, instagram: { instagramId: '170000000000001' }, read: {},
}
const ROW = {
  campaign_id: CAMPAIGN, campaign_name: 'Shop A spring', date_start: '2026-10-01', date_stop: '2026-10-20', spend: '123.45', impressions: '10000', reach: '8000',
  frequency: '1.25', clicks: '250', inline_link_clicks: '200', ctr: '2.5', cpc: '0.4938', cpm: '12.345',
  actions: [{ action_type: 'omni_purchase', value: '7', '7d_click': '6', '1d_view': '1' }, { action_type: 'link_click', value: '200' }],
  action_values: [{ action_type: 'omni_purchase', value: '345.60', '7d_click': '300.10' }],
  purchase_roas: [{ action_type: 'omni_purchase', value: '2.8' }],
  results: [{ indicator: 'actions:omni_purchase', values: [{ value: '7', attribution_windows: ['7d_click', '1d_view'] }] }],
  cost_per_result: [{ indicator: 'actions:omni_purchase', values: [{ value: '17.635', attribution_windows: ['7d_click', '1d_view'] }] }],
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = null; h.taken = []; h.owners = new Map(); h.ownerAnswer = null; h.products = []; h.runs = []; h.runAnswer = null
  h.known = new Map([[CAMPAIGN, 'campaign'], [ADSET, 'adset'], [AD, 'ad']])
  h.owners.set(RUN, '1234567890')
})

describe('three read tools', () => {
  it('read only, reach Meta, need ads.view, name their money keys', () => {
    expect(META_ADS_INSIGHTS_TOOLS.map((t) => [t.name, t.readOnly, !!t.openWorld, t.execute, t.requires, t.surfaces])).toEqual([
      ['meta-ads-numbers', true, true, undefined, ['ads.view'], undefined], ['meta-ads-report', true, true, undefined, ['ads.view'], undefined], ['meta-ads-saved-reports', true, true, undefined, ['ads.view'], undefined],
    ])
    expect(tool('meta-ads-numbers').restrictedFields).toEqual(NUMBERS_MONEY)
    expect(tool('meta-ads-report').restrictedFields).toEqual(REPORT_MONEY)
    expect(tool('meta-ads-saved-reports').restrictedFields).toEqual(SAVED_MONEY)
  })
  it('a business without Meta, or without a chosen ad account, is told who sets it up — before any call', async () => {
    h.connections = []
    expect(await refused('meta-ads-numbers', {})).toMatch(/Settings › Channels › Meta/)
    expect(await refused('meta-ads-report', { action: 'status', reportRunId: RUN })).toMatch(/Settings › Channels › Meta/)
    expect(await refused('meta-ads-saved-reports', { view: 'mmm-reports' })).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect(await refused('meta-ads-numbers', {})).toMatch(/No Meta ad account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('meta-ads-numbers', () => {
  it('default: the account rolled to campaigns, last 30 days, archived and deleted included; money in cents under money only', async () => {
    h.answer = () => ({ data: [ROW], paging: {} })
    const out = await data('meta-ads-numbers', {})
    const call = last()
    expect(call.path).toBe('act_1234567890/insights')
    expect(call.query).toMatchObject({ level: 'campaign', date_preset: 'last_30d', time_increment: 'all_days', limit: 100 })
    expect(String(call.query?.fields).split(',')).toEqual(expect.arrayContaining(['campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'actions', 'purchase_roas', 'results', 'cost_per_result']))
    expect(call.query?.filtering).toEqual([{ field: 'campaign.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'ARCHIVED', 'DELETED'] }])
    expect(call.query).not.toHaveProperty('use_unified_attribution_setting')
    expect(out.rows[0]).toMatchObject({
      campaignId: CAMPAIGN, campaignName: 'Shop A spring', dateStart: '2026-10-01',
      numbers: { impressions: 10000, reach: 8000, frequency: 1.25, ctr: 2.5, actions: [{ actionType: 'omni_purchase', value: 7, windows: { '7d_click': 6, '1d_view': 1 } }, { actionType: 'link_click', value: 200 }], results: [{ indicator: 'actions:omni_purchase', values: [{ value: 7, windows: ['7d_click', '1d_view'] }] }] },
      money: { spend: 12345, cpc: 49, cpm: 1235, action_values: [{ actionType: 'omni_purchase', value: 34560, windows: { '7d_click': 30010 } }], purchase_roas: [{ actionType: 'omni_purchase', value: 2.8 }], cost_per_result: [{ values: [{ value: 1764 }] }] },
    })
    expect(out.estimated).toEqual(expect.arrayContaining(['spend', 'reach', 'frequency']))
    expect(moneyOutside(out, NUMBERS_MONEY)).toEqual([])
    expect(gatewayProblems()).toEqual([])
  })
  it('one campaign, ad set or ad: checked to be the chosen account\'s own first; numbers roll down, never up', async () => {
    await data('meta-ads-numbers', { campaignId: CAMPAIGN, level: 'ad', breakdowns: ['age', 'gender'], datePreset: 'last_7d' })
    expect(last()).toMatchObject({ path: `${CAMPAIGN}/insights`, query: { level: 'ad', breakdowns: ['age', 'gender'], date_preset: 'last_7d' } })
    // Not Nexus's: one live account_id read says it is another account's — refused, no insights read.
    h.calls.length = 0
    expect(await refused('meta-ads-numbers', { adSetId: '120000000000999' })).toMatch(/does not belong to the ad account/)
    expect(insightCalls()).toHaveLength(0)
    expect(await refused('meta-ads-numbers', { adId: AD, level: 'campaign' })).toMatch(/roll down, not up/)
    expect(await refused('meta-ads-numbers', { campaignId: CAMPAIGN, adId: AD })).toMatch(/at most one object/)
    expect(gatewayProblems()).toEqual([])
  })
  it('IN-047 — combinations Meta does not keep, impression_device alone, dead or app breakdowns: refused in words before any call', async () => {
    for (const [args, words] of [
      [{ breakdowns: ['country', 'age'] }, /does not combine country, age/],
      [{ breakdowns: ['impression_device'] }, /never takes impression_device alone/],
      [{ breakdowns: ['dma'] }, /no longer supports dma since 2026-06-22.*comscore_market/],
      [{ breakdowns: ['mmm'] }, /meta-ads-report action start with kind mmm/],
      [{ breakdowns: ['skan_conversion_id'] }, /app-install ads/],
      [{ breakdowns: ['no_such_thing'] }, /not a breakdown Nexus asks/],
      [{ breakdowns: ['age'], actionBreakdowns: ['action_reaction'] }, /action_reaction alone/],
      [{ breakdowns: ['country'], actionBreakdowns: ['action_device'] }, /combines action_device only with/],
      [{ breakdowns: ['device_platform'], actionBreakdowns: ['action_target_id'] }, /only to the breakdowns its list marks/],
      [{ breakdowns: ['product_id'], level: 'account' }, /not answer product_id for the whole account/],
    ] as const) expect(await refused('meta-ads-numbers', args as never), JSON.stringify(args)).toMatch(words)
    expect(h.calls).toHaveLength(0)
    // Meta's own permutations go through.
    for (const args of [
      { breakdowns: ['publisher_platform', 'platform_position', 'impression_device'] }, { breakdowns: ['age', 'gender'], actionBreakdowns: ['action_type', 'action_destination'] },
      { actionBreakdowns: ['action_device'], breakdowns: ['publisher_platform', 'platform_position'] }, { actionBreakdowns: ['action_carousel_card_name'], breakdowns: ['age', 'gender'] },
    ]) await data('meta-ads-numbers', args)
    expect(gatewayProblems()).toEqual([])
  })
  it('Threads and Instagram placements come back in words; a switched-off breakdown is said to be off, never 0', async () => {
    h.answer = () => ({ data: [{ ...ROW, publisher_platform: 'threads', platform_position: 'threads_feed' }, { ...ROW, publisher_platform: 'instagram', platform_position: 'instagram_reels' }] })
    const out = await data('meta-ads-numbers', { breakdowns: ['publisher_platform', 'platform_position'] })
    expect(out.rows.map((r: any) => r.breakdown)).toEqual([
      { publisher_platform: 'threads', platform_position: 'threads_feed', placementText: 'Threads feed' },
      { publisher_platform: 'instagram', platform_position: 'instagram_reels', placementText: 'Instagram Reels' },
    ])
    h.answer = () => ({ data: [] })
    const off = await data('meta-ads-numbers', { breakdowns: ['publisher_platform', 'impression_device'] })
    expect(off.notes[0]).toMatch(/No rows: impression_device may be switched off for this ad account \(not 0\)/)
    expect(off.notes.join(' ')).toMatch(/answers NOTHING, without an error, until the ad account switches it on/)
  })
  it('hourly: reach, frequency and unique counts are left out of the defaults (Meta answers 0); named, they are refused', async () => {
    const out = await data('meta-ads-numbers', { view: 'hourly' })
    expect(last().query?.breakdowns).toEqual(['hourly_stats_aggregated_by_advertiser_time_zone'])
    expect(String(last().query?.fields)).not.toMatch(/(^|,)reach(,|$)/)
    expect(await refused('meta-ads-numbers', { view: 'hourly', metrics: ['reach'] })).toMatch(/reach.*by hour/)
    expect(await refused('meta-ads-numbers', { view: 'hourly', metrics: ['video_p25_watched_actions'] })).toMatch(/no video_\* numbers with an hourly breakdown/)
    await data('meta-ads-numbers', { view: 'hourly', audienceTime: true })
    expect(last().query?.breakdowns).toEqual(['hourly_stats_aggregated_by_audience_time_zone'])
    expect(out.notes.join(' ')).toMatch(/Type 1/)
  })
  it('frequency_value reads reach only; Dynamic Creative assets only their six metrics; region no video percentiles', async () => {
    await data('meta-ads-numbers', { breakdowns: ['frequency_value'] })
    expect(String(last().query?.fields).split(',').filter((f) => !/_id$|_name$/.test(f))).toEqual(['reach'])
    expect(await refused('meta-ads-numbers', { breakdowns: ['frequency_value'], metrics: ['spend'] })).toMatch(/frequency_value with reach only/)
    await data('meta-ads-numbers', { view: 'assets', assetBreakdown: 'body_asset', campaignId: CAMPAIGN })
    expect(last().query).toMatchObject({ level: 'ad', breakdowns: ['body_asset'] })
    expect(await refused('meta-ads-numbers', { view: 'assets', assetBreakdown: 'body_asset', metrics: ['cpc'] })).toMatch(/only impressions, clicks, spend, reach, actions and action_values/)
    expect(await refused('meta-ads-numbers', { view: 'assets' })).toMatch(/Name the asset breakdown/)
    expect(await refused('meta-ads-numbers', { breakdowns: ['region'], metrics: ['video_p75_watched_actions'] })).toMatch(/not answer it by region/)
    // A sort names a metric too: the same rules.
    expect(await refused('meta-ads-numbers', { view: 'assets', assetBreakdown: 'title_asset', sortBy: 'ctr' })).toMatch(/ctr: with a Dynamic Creative asset breakdown/)
    expect(await refused('meta-ads-numbers', { breakdowns: ['frequency_value'], actionBreakdowns: ['action_type'] })).toMatch(/reach only: no actions/)
    expect(await refused('meta-ads-numbers', { view: 'products', breakdowns: ['age'] })).toMatch(/splits by product only/)
    expect(await refused('meta-ads-numbers', { view: 'hourly', breakdowns: ['country'] })).toMatch(/splits by hour only/)
  })
  it('attribution windows: the ones that answer go; 7d_view / 28d_view (no data since 2026-01-12) and undocumented ones are refused', async () => {
    await data('meta-ads-numbers', { windows: ['1d_click', '7d_click', '1d_view', 'incrementality'] })
    expect(last().query?.action_attribution_windows).toEqual(['1d_click', '7d_click', '1d_view', 'incrementality'])
    expect(await refused('meta-ads-numbers', { windows: ['7d_view'] })).toMatch(/no data for 7-day and 28-day view windows since 2026-01-12/)
    expect(await refused('meta-ads-numbers', { windows: ['28d_view_all_conversions'] })).toMatch(/2026-01-12/)
    expect(await refused('meta-ads-numbers', { windows: ['skan_click'] })).toMatch(/app-install postbacks/)
    await data('meta-ads-numbers', { attribution: 'account' })
    expect(last().query?.use_account_attribution_setting).toBe(true)
    expect(gatewayProblems()).toEqual([])
  })
  it('days: exact days within 37 months, never past today; presets; lifetime is gone; rows per week; several periods', async () => {
    await data('meta-ads-numbers', { from: '2026-09-01', to: '2026-09-30', timeIncrement: 'weekly' })
    expect(last().query).toMatchObject({ time_range: { since: '2026-09-01', until: '2026-09-30' }, time_increment: 7 })
    expect(await refused('meta-ads-numbers', { from: '2020-01-01', to: '2020-01-31' })).toMatch(/37 months \(error 3018\)/)
    expect(await refused('meta-ads-numbers', { from: '2026-10-01', to: '2099-01-01' })).toMatch(/after today/)
    expect(await refused('meta-ads-numbers', { datePreset: 'lifetime' })).toMatch(/disabled lifetime: maximum/)
    expect(await refused('meta-ads-numbers', { datePreset: 'last_7d', from: '2026-10-01' })).toMatch(/one way/)
    await data('meta-ads-numbers', { periods: [{ from: '2026-10-01', to: '2026-10-07' }, { from: '2026-10-01', to: '2026-10-14' }] })
    expect(last().query?.time_ranges).toEqual([{ since: '2026-10-01', until: '2026-10-07' }, { since: '2026-10-01', until: '2026-10-14' }])
    expect(last().query).not.toHaveProperty('time_increment')
    expect(await refused('meta-ads-numbers', { periods: [{ from: '2026-10-01', to: '2026-10-07' }], timeIncrement: 'daily' })).toMatch(/several periods/)
    expect(gatewayProblems()).toEqual([])
  })
  it('IN-026 — compare: the period before, computed by Nexus per campaign (Meta\'s insights take no comparison period)', async () => {
    h.answer = () => ({ data: [
      { ...ROW, date_start: '2026-10-08', date_stop: '2026-10-14', spend: '20.00', impressions: '2000' },
      { ...ROW, date_start: '2026-10-01', date_stop: '2026-10-07', spend: '10.00', impressions: '1000' },
    ] })
    const out = await data('meta-ads-numbers', { from: '2026-10-08', to: '2026-10-14', compare: 'previous-period' })
    expect(last().query?.time_ranges).toEqual([{ since: '2026-10-08', until: '2026-10-14' }, { since: '2026-10-01', until: '2026-10-07' }])
    expect(out.rows.map((r: any) => r.period)).toEqual(['current', 'earlier'])
    expect(out.changes[0]).toMatchObject({ campaignId: CAMPAIGN, inCurrent: true, inEarlier: true, numbers: { impressions: { current: 2000, earlier: 1000, change: 1000, changePct: 1 } }, money: { spend: { current: 2000, earlier: 1000, change: 1000 } } })
    expect(moneyOutside(out, NUMBERS_MONEY)).toEqual([])
    await data('meta-ads-numbers', { from: '2026-03-01', to: '2026-03-31', compare: 'previous-year' })
    expect(last().query?.time_ranges).toEqual([{ since: '2026-03-01', until: '2026-03-31' }, { since: '2025-03-01', until: '2025-03-31' }])
    expect(await refused('meta-ads-numbers', { compare: 'previous-period' })).toMatch(/compare needs from and to/)
  })
  it('filters: ids checked to be the account\'s own; amounts only for a person who may see ad spend (and so is sorting by one)', async () => {
    await data('meta-ads-numbers', { filters: [{ field: 'campaign.id', operator: 'IN', value: [CAMPAIGN] }, { field: 'campaign.name', operator: 'CONTAIN', value: 'IT' }, { field: 'publisher_platform', operator: 'IN', value: ['instagram'] }], onlyWithImpressions: true, minSpendCents: 1250, sortBy: 'spend' })
    expect(last().query?.filtering).toEqual(expect.arrayContaining([
      { field: 'campaign.id', operator: 'IN', value: [CAMPAIGN] }, { field: 'campaign.name', operator: 'CONTAIN', value: 'IT' },
      { field: 'campaign.impressions', operator: 'GREATER_THAN', value: 0 }, { field: 'campaign.spend', operator: 'GREATER_THAN_OR_EQUAL', value: '12.50' },
    ]))
    expect(last().query?.sort).toEqual(['spend_descending'])
    h.calls.length = 0
    expect(await refused('meta-ads-numbers', { filters: [{ field: 'campaign.id', operator: 'IN', value: ['120000000000999'] }] })).toMatch(/does not belong to the ad account/)
    expect(insightCalls()).toHaveLength(0)
    expect(await refused('meta-ads-numbers', { sortBy: 'spend' }, noMoney)).toMatch(/needs the ad-spend money permission/)
    expect(await refused('meta-ads-numbers', { minSpendCents: 100 }, noMoney)).toMatch(/needs the ad-spend money permission/)
    expect(await refused('meta-ads-numbers', { filters: [{ field: 'campaign.spend', operator: 'GREATER_THAN', valueCents: 1 }] }, noMoney)).toMatch(/needs the ad-spend money permission/)
    expect(await refused('meta-ads-numbers', { filters: [{ field: 'campaign.budget', operator: 'EQUAL', value: '1' }] })).toMatch(/not a filter Nexus sends/)
    expect(await refused('meta-ads-numbers', { filters: [{ field: 'publisher_platform', operator: 'IN', value: ['myspace'] }] })).toMatch(/takes facebook, instagram/)
    await data('meta-ads-numbers', { sortBy: 'impressions', order: 'ascending' }, noMoney)
    expect(last().query?.sort).toEqual(['impressions_ascending'])
    await data('meta-ads-numbers', { sortAction: 'omni_purchase' })
    expect(last().query?.sort).toEqual(['actions:omni_purchase_descending'])
    expect(gatewayProblems()).toEqual([])
  })
  it('metrics only from the list; the step 6 and ranking fields point to meta-ad-details; action breakdowns add actions', async () => {
    expect(await refused('meta-ads-numbers', { metrics: ['spend', 'access_token'] })).toMatch(/not a metric Nexus asks/)
    expect(await refused('meta-ads-numbers', { metrics: ['auction_bid'] })).toMatch(/meta-ad-details view diagnostics/)
    expect(await refused('meta-ads-numbers', { metrics: ['quality_ranking'] })).toMatch(/not in Meta's v26 insights reference/)
    expect(await refused('meta-ads-numbers', { metrics: ['comparison_node'] })).toMatch(/takes no comparison period/)
    expect(await refused('meta-ads-numbers', { metrics: ['instagram_profile_visits'], level: 'account' })).toMatch(/not for the whole account/)
    expect(await refused('meta-ads-numbers', { metrics: ['messages_delivered'], level: 'ad' })).toMatch(/ad-level insights do not carry it/)
    const out = await data('meta-ads-numbers', { metrics: ['impressions'], actionBreakdowns: ['action_device'] })
    expect(String(last().query?.fields)).toMatch(/actions/)
    expect(out.notes.join(' ')).toMatch(/actions was added/)
    await data('meta-ads-numbers', { groups: ['video'] })
    expect(String(last().query?.fields)).toMatch(/video_p100_watched_actions/)
  })
  it('IN-024 / IN-025 — fields only other Meta pages name: asked, and when Meta refuses them the rows come without them', async () => {
    h.answer = (req) => (String(req.query?.fields).includes('instagram_profile_visits') ? refusedByMeta('(#100) instagram_profile_visits is not a valid field') : { data: [ROW] })
    const out = await data('meta-ads-numbers', { metrics: ['impressions', 'instagram_profile_visits'] })
    expect(insightCalls()).toHaveLength(2)
    expect(String(last().query?.fields)).not.toMatch(/instagram_profile_visits/)
    expect(out.missing[0]).toMatch(/Meta refused instagram_profile_visits here/)
    expect(out.rows).toHaveLength(1)
  })
  it('too much at once: the answer points to the background report run', async () => {
    h.answer = () => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100/1487534', channelMessage: 'Please reduce the amount of data' } as never }), 'x', 1)
    expect(await refused('meta-ads-numbers', { level: 'ad', breakdowns: ['age'] })).toMatch(/meta-ads-report action start with the same arguments/)
  })
  it('products: Meta\'s retailer id matched to this business\'s Nexus SKUs; per-ad product cap', async () => {
    h.products = [{ id: 'p-1', sku: 'SHOPA-JKT-M' }]
    h.answer = () => ({ data: [{ ...ROW, product_id: '9900000000001, Jacket', product_retailer_id: 'SHOPA-JKT-M', product_name: 'Jacket' }, { ...ROW, product_id: '9900000000002, Gloves', product_retailer_id: 'shopify_IT_1_2' }] })
    const out = await data('meta-ads-numbers', { view: 'products', productIdLimit: 25 })
    expect(last().query).toMatchObject({ breakdowns: ['product_id'], product_id_limit: 25, level: 'campaign' })
    expect(out.rows.map((r: any) => [r.breakdown.product_id, r.nexusSku, r.nexusProductId])).toEqual([['9900000000001, Jacket', 'SHOPA-JKT-M', 'p-1'], ['9900000000002, Gloves', null, null]])
    expect(await refused('meta-ads-numbers', { productIdLimit: 5 })).toMatch(/goes with the product breakdown/)
  })
  it('withTotal: Meta\'s own total row, mapped like a row (its money restricted too)', async () => {
    h.answer = () => ({ data: [ROW], summary: { spend: '123.45', impressions: '10000', reach: '7000' } })
    const out = await data('meta-ads-numbers', { withTotal: true, actionBreakdowns: ['action_type'] })
    expect(last().query).toMatchObject({ default_summary: true, summary_action_breakdowns: ['action_type'] })
    expect(out.total).toMatchObject({ numbers: { impressions: 10000, reach: 7000 }, money: { spend: 12345 } })
    expect(gatewayProblems()).toEqual([])
  })
  it('catalogue, check and portfolio make no Meta call', async () => {
    const cat = await data('meta-ads-numbers', { view: 'catalogue' })
    expect(cat.metricGroups.delivery.find((m: any) => m.name === 'reach')).toEqual({ name: 'reach', kind: 'count', estimated: true })
    expect(cat.windows.deadSince20260112).toEqual(expect.arrayContaining(['7d_view', '28d_view']))
    const check = await data('meta-ads-numbers', { view: 'check', breakdowns: ['age'] })
    expect(check).toMatchObject({ ok: true, read: { from: 'the ad account', level: 'campaign', breakdowns: ['age'] } })
    expect((await data('meta-ads-numbers', { view: 'portfolio' })).sentence).toMatch(/no insights for a whole business portfolio/)
    expect(insightCalls()).toHaveLength(0)
  })
})

describe('meta-ads-report', () => {
  it('start: a report run of the chosen account only — the same read as meta-ads-numbers, its body passing the gateway\'s rule', async () => {
    const out = await data('meta-ads-report', { action: 'start', campaignId: CAMPAIGN, level: 'ad', breakdowns: ['country'], from: '2026-01-01', to: '2026-09-30', timeIncrement: 'monthly', exportFormat: 'xls', exportName: 'Shop A report' })
    expect(out).toMatchObject({ reportRunId: RUN, kind: 'numbers' })
    expect(out.sentence).toMatch(/Nexus stores nothing/)
    expect(h.runs[0]).toMatchObject({ connectionId: 'conn-1', adAccountId: '1234567890', params: { level: 'ad', breakdowns: ['country'], time_increment: 'monthly', export_format: 'xls', export_name: 'Shop A report' } })
    // Meta documents the POST on act_<id>/insights only: the campaign is a filter there.
    expect(h.runs[0].params.filtering).toEqual(expect.arrayContaining([{ field: 'campaign.id', operator: 'IN', value: [CAMPAIGN] }]))
    expect(runVerdict()).toMatchObject({ write: { rule: 'insights.reportRun', objectId: '1234567890', reportRun: true, check: false } })
    expect(gatewayProblems()).toEqual([])
  })
  it('start kind mmm: Meta\'s MMM export exactly as its page takes it; only its own filters', async () => {
    await data('meta-ads-report', { action: 'start', kind: 'mmm', datePreset: 'last_7d', timeIncrement: 'daily', filters: [{ field: 'campaign.id', operator: 'IN', value: [CAMPAIGN] }, { field: 'country', operator: 'IN', value: ['IT'] }] })
    expect(h.runs[0].params).toEqual({ level: 'adset', breakdowns: ['mmm'], export_format: 'csv', fields: 'impressions,spend', date_preset: 'last_7d', time_increment: 1, filtering: [{ field: 'campaign.id', operator: 'IN', value: [CAMPAIGN] }, { field: 'country', operator: 'IN', value: ['IT'] }] })
    expect(runVerdict()).toMatchObject({ write: { rule: 'insights.reportRun' } })
    expect(await refused('meta-ads-report', { action: 'start', kind: 'mmm', filters: [{ field: 'campaign.name', operator: 'EQUAL', value: 'x' }] })).toMatch(/takes only these filters/)
    expect(await refused('meta-ads-report', { action: 'start', kind: 'mmm', timeIncrement: 'weekly' })).toMatch(/by day \(daily\) or for the whole period/)
    expect(await refused('meta-ads-report', { action: 'start', kind: 'mmm', campaignId: CAMPAIGN })).toMatch(/whole ad account/)
  })
  it('status: a report run of another ad account, or an id that is no report run, is refused before its state is read', async () => {
    h.answer = (req) => (req.path === RUN ? { id: RUN, account_id: '1234567890', async_status: 'Job Running', async_percent_completion: 40, time_ref: 1792000000 } : { data: [] })
    const out = await data('meta-ads-report', { action: 'status', reportRunId: RUN })
    expect(out).toMatchObject({ reportRunId: RUN, status: 'Job Running', percent: 40, done: false, statusText: 'Running at Meta.' })
    expect(h.calls.find((c) => c.operation === 'report.ownerCheck')?.query).toEqual({ fields: 'account_id,async_status,async_percent_completion' })
    h.owners.set('6000000000002', '5550001112')
    h.calls.length = 0
    expect(await refused('meta-ads-report', { action: 'status', reportRunId: '6000000000002' })).toMatch(/does not belong to the ad account/)
    expect(h.calls.map((c) => c.operation)).toEqual(['report.ownerCheck'])
    // A campaign of the account is not a report run.
    expect(await refused('meta-ads-report', { action: 'status', reportRunId: CAMPAIGN })).toMatch(/is a campaign of this ad account, not a report run/)
    expect(await refused('meta-ads-report', { action: 'fetch' })).toMatch(/Name the report run/)
    expect(gatewayProblems()).toEqual([])
  })
  it('status: finished only when completed AND 100 %; a failed run carries Meta\'s error and what it means', async () => {
    h.answer = (req) => (req.operation === 'report.error' ? { error_code: -3, error_subcode: 1504045, error_message: 'Report too large' } : { id: RUN, account_id: '1234567890', async_status: 'Job Failed', async_percent_completion: 0 })
    const failed = await data('meta-ads-report', { action: 'status', reportRunId: RUN })
    expect(failed).toMatchObject({ done: false, error: { code: -3, subcode: 1504045, meaning: expect.stringMatching(/too large/) } })
    h.answer = () => ({ id: RUN, account_id: '1234567890', async_status: 'Job Completed', async_percent_completion: 99 })
    expect((await data('meta-ads-report', { action: 'status', reportRunId: RUN })).done).toBe(false)
    expect(await refused('meta-ads-report', { action: 'fetch', reportRunId: RUN })).toMatch(/not finished/)
    // The SDK's extra fields refused: the best-practices page's own fields answer.
    h.answer = (req) => (String(req.query?.fields).includes('is_running') ? refusedByMeta('(#100) Tried accessing nonexisting field (is_running)') : { id: RUN, account_id: '1234567890', async_status: 'Job Completed', async_percent_completion: 100 })
    expect(await data('meta-ads-report', { action: 'status', reportRunId: RUN })).toMatchObject({ done: true, dateStart: null })
  })
  it('fetch: the rows of a finished run, mapped like meta-ads-numbers; csv without and with the amounts', async () => {
    h.answer = (req) => (req.path === RUN ? { id: RUN, account_id: '1234567890', async_status: 'Job Completed', async_percent_completion: 100 } : { data: [{ ...ROW, country: 'IT', mystery_field: '1' }], paging: { cursors: { after: 'c2' }, next: 'https://graph.facebook.com/x?access_token=EAAsecret' } })
    const out = await data('meta-ads-report', { action: 'fetch', reportRunId: RUN, maxRows: 1 })
    expect(last()).toMatchObject({ path: `${RUN}/insights`, query: { limit: 1 } })
    expect(out.rows[0]).toMatchObject({ breakdown: { country: 'IT' }, money: { spend: 12345 } })
    expect(out.nextAfter).toBe('c2')
    expect(out.notes[0]).toMatch(/also sent mystery_field/)
    const csv = await data('meta-ads-report', { action: 'fetch', reportRunId: RUN, format: 'csv' })
    expect(csv.csv.split('\n')[0]).toMatch(/campaign_id/)
    expect(csv.csv).not.toMatch(/12345/)
    expect(csv.csvWithMoney).toMatch(/spend \(cents\)/)
    expect(moneyOutside(csv, REPORT_MONEY)).toEqual([])
    expect(JSON.stringify(out)).not.toMatch(/access_token|EAA/)
    expect(gatewayProblems()).toEqual([])
  })
  it('file: Meta\'s documented export link (opens for a person signed in to Meta) — a link of any other shape is never passed on', async () => {
    const done = { id: RUN, account_id: '1234567890', async_status: 'Job Completed', async_percent_completion: 100 }
    h.answer = (req) => (req.operation === 'report.file' ? { async_report_url: `https://www.facebook.com/ads/ads_insights/export_report/?report_run_id=${RUN}&format=csv&name=mmm&extra=1`, is_async_export: true } : done)
    const out = await data('meta-ads-report', { action: 'file', reportRunId: RUN, fileFormat: 'xls', exportName: 'Shop A' })
    expect(out.exportLink).toEqual({
      metaFile: `https://www.facebook.com/ads/ads_insights/export_report/?report_run_id=${RUN}&name=mmm&format=csv`,
      export: `https://www.facebook.com/ads/ads_insights/export_report/?report_run_id=${RUN}&name=Shop+A&format=xls`, format: 'xls',
    })
    h.answer = (req) => (req.operation === 'report.file' ? { async_report_url: 'https://lookaside.fbsbx.com/file/abc.csv?token=xyz' } : done)
    const withheld = await data('meta-ads-report', { action: 'file', reportRunId: RUN })
    expect(withheld.exportLink.metaFile).toBeNull()
    expect(withheld.metaLinkNote).toMatch(/does not recognise/)
    expect(JSON.stringify(withheld)).not.toMatch(/lookaside|token=xyz/)
    expect(moneyOutside(withheld, REPORT_MONEY)).toEqual([])
  })
})

describe('meta-ads-saved-reports', () => {
  it('the account\'s MMM reports and schedules, custom metrics, Report Builder and report specs: their own edges, fixed fields', async () => {
    await data('meta-ads-saved-reports', { view: 'mmm-reports' })
    expect(last()).toMatchObject({ path: 'act_1234567890/ads_reporting_mmm_reports', query: { fields: 'id,export_name,export_format,export_type,async_status,mmm_status,time_start,has_seen' } })
    await data('meta-ads-saved-reports', { view: 'mmm-schedules' })
    expect(last().path).toBe('act_1234567890/ads_reporting_mmm_schedulers')
    await data('meta-ads-saved-reports', { view: 'custom-metrics' })
    expect(last().path).toBe('act_1234567890/ad_custom_derived_metrics')
    expect(String(last().query?.fields)).not.toMatch(/creator|deletor/)
    h.answer = () => ({ data: [{ headers: { columns: ['spend'] }, rows: [{ spend: 12.3 }] }], summary: { total_count: 1 } })
    const rb = await data('meta-ads-saved-reports', { view: 'report-builder', metrics: ['spend', 'impressions'], dimensions: ['campaign_name', 'age'], from: '2026-10-01', to: '2026-10-14', comparisonFrom: '2026-09-17', comparisonTo: '2026-09-30', windows: ['7d_click'], sortBy: 'spend', withTotal: true, filters: [{ field: 'campaign.name', operator: 'CONTAIN', value: 'IT' }] })
    expect(last()).toMatchObject({ path: 'act_1234567890/reporting', query: { metrics: ['spend', 'impressions'], dimensions: ['campaign_name', 'age'], time_range: { since: '2026-10-01', until: '2026-10-14' }, comparison_time_range: { since: '2026-09-17', until: '2026-09-30' }, attribution_windows: ['7d_click'], sorting: [{ field: 'spend', direction: 'desc' }], default_summary: true, summary_count: true } })
    expect(rb.tableAsMeta.data[0].rows).toEqual([{ spend: 12.3 }])
    expect(await refused('meta-ads-saved-reports', { view: 'report-builder', metrics: ['access_token'] })).toMatch(/not a metric Nexus sends/)
    expect(await refused('meta-ads-saved-reports', { view: 'report-builder', windows: ['28d_view'] })).toMatch(/no data since 2026-01-12/)
    await data('meta-ads-saved-reports', { view: 'report-specs' })
    expect(last()).toMatchObject({ path: 'act_1234567890/report_specs' })
    expect(gatewayProblems()).toEqual([])
  })
  it('the portfolio\'s: only when no other business reads an ad account of it, refused before any call otherwise', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: '9876543210' }]
    for (const view of ['exports', 'custom-pivots', 'pivot-preview', 'measurement', 'partner-studies', 'partner-viewability']) {
      expect(await refused('meta-ads-saved-reports', { view, reportType: 'mmm_report_v2' }), view).toMatch(/Another business in Nexus reads an ad account of this Meta business portfolio/)
    }
    expect(await refused('meta-ads-saved-reports', { view: 'mmm-reports', scope: 'portfolio' })).toMatch(/Another business in Nexus/)
    expect(h.calls).toHaveLength(0)
  })
  it('exports never ask a file or sharing link; measurement never its download links and needs its type', async () => {
    await data('meta-ads-saved-reports', { view: 'exports' })
    expect(last().path).toBe('9876543210/ads_reporting_exports')
    expect(String(last().query?.fields)).not.toMatch(/async_report_url|link_sharing_uri/)
    expect(await refused('meta-ads-saved-reports', { view: 'measurement' })).toMatch(/Name the reportType/)
    h.answer = () => ({ data: [{ id: '7700000000001', report_type: 'mmm_report_v2', status: 'READY', metadata: { spend: '1000' } }] })
    const m = await data('meta-ads-saved-reports', { view: 'measurement', reportType: 'mmm_report_v2' })
    expect(last()).toMatchObject({ path: '9876543210/measurement_reports', query: { report_type: 'mmm_report_v2', fields: 'id,report_type,status,metadata' } })
    expect(m.items[0]).toEqual({ reportId: '7700000000001', type: 'mmm_report_v2', status: 'READY', metadataAsMeta: { spend: '1000' } })
    expect(moneyOutside(m, SAVED_MONEY)).toEqual([])
    expect(gatewayProblems()).toEqual([])
  })
  it('a portfolio schedule that does not name the chosen account is its id only; the pivot preview keeps the chosen account\'s rows', async () => {
    h.answer = () => ({ data: [{ id: '8800000000001', report_name: 'Shop A weekly', ad_account_ids: ['act_1234567890', '5550001112'] }, { id: '8800000000002', report_name: 'Other shop', ad_account_ids: ['5550001112'] }] })
    const s = await data('meta-ads-saved-reports', { view: 'mmm-schedules', scope: 'portfolio' })
    expect(s.items).toEqual([
      { scheduleId: '8800000000001', name: 'Shop A weekly', frequency: null, namesThisAdAccount: true, otherAdAccounts: 1, filtering: null },
      { scheduleId: '8800000000002', namesThisAdAccount: false },
    ])
    h.answer = () => ({ data: [{ account_id: '1234567890', campaign_id: CAMPAIGN, campaign_name: 'Shop A spring', custom_breakdown: ['Group 1'] }, { account_id: '5550001112', campaign_id: '120000000000999', campaign_name: 'Other' }] })
    const p = await data('meta-ads-saved-reports', { view: 'pivot-preview', groupName: 'Group 1', datePreset: 'last_30d' })
    expect(last().query).toMatchObject({ ad_account_ids: ['1234567890'], group_name: 'Group 1', date_preset: 'last_30d' })
    expect(p.items).toEqual([{ campaignId: CAMPAIGN, campaignName: 'Shop A spring', adSetId: null, adSetName: null, adId: null, adName: null, groups: ['Group 1'] }])
    expect(gatewayProblems()).toEqual([])
  })
  it('partner studies and viewability: their own filters; what Meta cannot do is said with its proof', async () => {
    await data('meta-ads-saved-reports', { view: 'partner-studies', statuses: ['SUCCESS'], studyTypes: ['BRAND_LIFT'] })
    expect(last()).toMatchObject({ path: '9876543210/third_party_partner_panel_requests', query: { status: ['SUCCESS'], study_type: ['BRAND_LIFT'] } })
    await data('meta-ads-saved-reports', { view: 'partner-studies', recurring: true, statuses: ['ONGOING'] })
    expect(last().path).toBe('9876543210/third_party_partner_panel_recurring_requests')
    expect(await refused('meta-ads-saved-reports', { view: 'partner-studies', statuses: ['ONGOING'] })).toMatch(/statuses are CREATED/)
    await data('meta-ads-saved-reports', { view: 'partner-viewability', from: '2026-10-01', to: '2026-10-07', platform: 'INSTAGRAM', type: 'IMPRESSION' })
    expect(last()).toMatchObject({ path: '9876543210/third_party_partner_viewability_requests', query: { start_ds: '2026-10-01', end_ds: '2026-10-07', platform: 'INSTAGRAM', type: 'IMPRESSION' } })
    await data('meta-ads-saved-reports', { view: 'custom-pivots', permission: 'shared' })
    expect(last()).toMatchObject({ path: '9876543210/custom_pivots', query: { permission: 'shared' } })
    expect(String(last().query?.fields)).not.toMatch(/creator|update_by/)
    const cannot = await data('meta-ads-saved-reports', { view: 'what-meta-cannot' })
    expect(cannot.items.map((c: any) => c.proof)).toEqual(expect.arrayContaining(['reference/ad-account/ad_custom_derived_metrics', 'reference/business/custom_pivots', 'reference/ad-account/ads_reporting_mmm_schedulers']))
    expect(gatewayProblems()).toEqual([])
  })
})

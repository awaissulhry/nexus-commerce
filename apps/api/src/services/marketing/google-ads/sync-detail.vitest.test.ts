/**
 * Google Ads step 1b — the reads below the campaign in one run (sync.service.ts + sync-plan.ts + store-detail.ts), through
 * the REAL read client and channel gateway (only `fetch`, the token, the account state and the ledger are stand-ins) into
 * the REAL store on PGlite (production schema and policies, business profiles on), with Google's answers from the
 * REST-shaped fixtures in test-support/google-ads (a day query answers only the days of its window, as Google does).
 *
 *   the first run: core first, then tiers 2, 3, 4, 5; first reads in pieces (ad groups and keywords 3×30 days, search
 *   terms 2×15); 26 operations of the 27 reserved; every read's state; rows on one daily key summed; only reads
 *   the next day: 22 reserved, 21 spent; what Google no longer returns removed or resolved; recommendations replaced
 *   short of allowance: tier 5, then 4 (… then all) dropped as SKIPPED_BUDGET in words, nothing they read before moves;
 *   the run PARTIAL with its data as of now; no allowance even for the core: no call at all
 *   a refused query: that read FAILED in words, its range unmoved, the run goes on (PARTIAL)
 *   the safety-net twins (their fields are verified valid in v25; refused here anyway): the query is sent again without
 *   the field, within the reservation; what it carries is then "not read"; the refusal is remembered for 7 days
 *   the sign-in lost during step 1b: the run stops; the reads not reached say why (AUTH_LOST)
 *   retention: search terms 180 days, the range moving with them; alerts after the run, never failing it
 *   big accounts: a refusal remembered 7 days per business; never more operations than reserved; one read of an account
 *   at a time; a first read over the row cap read once more over half its window; a search-term read over the cap stops
 *   at the page that crossed it
 */
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
type Answer = (query: string, pageToken: string | null) => Response
const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; query: string; pageToken: string | null }>,
  override: {} as Record<string, Answer>,
  alerts: vi.fn(async (_customerId: string, _now?: Date) => ({ raised: 0 })),
}))
vi.mock('../../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../../marketing-events.service.js', () => ({ publishMarketingEvent: vi.fn() }))
vi.mock('./alerts.service.js', () => ({ raiseGoogleAdsAlerts: h.alerts }))

import { __rateTest } from '../../gateway/rate.js'
import { googleKind } from '../../gateway/google.js'
import { RELEASE_LEASE } from '../../../lib/cron/workspace-lease.js'
import { setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { getGoogleAdsCustomer } from './store.js'
import { readStatesOf } from './store-detail.js'
import { setMaxMetricRowsForTests, syncGoogleAdsAccount } from './sync.service.js'

const raw = (name: string) => readFileSync(new URL(`../../../test-support/google-ads/${name}`, import.meta.url), 'utf8')
const errors = JSON.parse(raw('errors.json')) as Record<string, { httpStatus: number; body: unknown }>
const fail = (name: string): Answer => () => new Response(JSON.stringify(errors[name].body), { status: errors[name].httpStatus })
const page = (name: string) => JSON.parse(raw(name)) as { results: Array<Record<string, unknown>>; nextPageToken?: string }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
/** A fixture as Google answers a query: a day query gets only the days of its window. */
const ok = (name: string): Answer => (query) => {
  const window = /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(query)
  const answer = page(name)
  const results = answer.results.filter((row) => {
    const date = (row.segments as { date?: string } | undefined)?.date
    return !window || !date || (date >= window[1] && date <= window[2])
  })
  return json({ ...answer, results })
}
/** The twin query's answer: the fixture without the parts the twin does not select. */
const without = (name: string, ...keys: string[]): Answer => () =>
  json({ results: page(name).results.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))) })

const A = 'gads_detail_sync_alpha'
const B = 'gads_detail_sync_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const CID = '1234567890'
const TARGET = { connectionId: 'g-conn-1', customerId: CID, loginCustomerId: null }
const RUN_1 = new Date('2026-10-13T06:25:00Z') // Tuesday; the account (Europe/Rome) is on 2026-10-13, yesterday 2026-10-12
const RUN_2 = new Date('2026-10-14T06:25:00Z')
const RUN_3 = new Date('2026-10-15T06:25:00Z')
const RUN_4 = new Date('2026-10-16T06:25:00Z')
const RUN_5 = new Date('2026-10-17T06:25:00Z')
const RUN_6 = new Date('2026-10-20T06:25:00Z')
const RUN_7 = new Date('2026-10-21T06:25:00Z')
const day = (d: string) => new Date(`${d}T00:00:00Z`)

/** Which fixture answers which query. */
const ROUTES: Array<[string, (q: string) => boolean, Answer]> = [
  ['customer', (q) => q.endsWith(' FROM customer'), ok('search-customer.json')],
  ['campaigns', (q) => q.startsWith('SELECT campaign.id, campaign.name, campaign.status'), (q, token) => ok(token ? 'search-campaigns-page-2.json' : 'search-campaigns-page-1.json')(q, token)],
  ['campaignDays', (q) => q.startsWith('SELECT campaign.id, campaign.name, segments.date'), ok('search-campaign-days.json')],
  ['changes', (q) => q.includes(' FROM change_event'), ok('search-change-events.json')],
  ['flags', (q) => q.includes('campaign.ai_max_setting'), ok('search-campaign-flags.json')],
  ['adPolicy', (q) => q.includes(' FROM ad_group_ad '), ok('search-ad-policy.json')],
  ['products', (q) => q.endsWith(' FROM shopping_product'), ok('search-shopping-products.json')],
  ['autoApply', (q) => q.endsWith(' FROM recommendation_subscription'), ok('search-auto-apply.json')],
  ['adGroupDays', (q) => q.includes(' FROM ad_group WHERE segments.date'), ok('search-ad-group-days.json')],
  ['keywordDays', (q) => q.includes(' FROM keyword_view '), ok('search-keyword-days.json')],
  ['assetGroupDays', (q) => q.includes(' FROM asset_group WHERE segments.date'), ok('search-asset-group-days.json')],
  ['productDays', (q) => q.includes(' FROM shopping_performance_view '), ok('search-product-days.json')],
  ['searchTerms', (q) => q.includes(' FROM campaign_search_term_view '), ok('search-search-terms.json')],
  ['adGroups', (q) => q.includes(' FROM ad_group WHERE ad_group.status'), ok('search-ad-groups.json')],
  ['keywords', (q) => q.includes(' FROM ad_group_criterion '), ok('search-keywords.json')],
  ['campaignNegatives', (q) => q.includes(' FROM campaign_criterion '), ok('search-campaign-negatives.json')],
  ['assetGroups', (q) => q.includes(' FROM asset_group WHERE asset_group.status'), ok('search-asset-groups.json')],
  ['listKeywords', (q) => q.includes(' FROM shared_criterion '), ok('search-negative-list-keywords.json')],
  ['listAttachments', (q) => q.includes(' FROM campaign_shared_set '), ok('search-negative-list-attachments.json')],
  ['accountLists', (q) => q.includes(' FROM customer_negative_criterion '), ok('search-customer-negative-criteria.json')],
  ['recommendations', (q) => q.endsWith(' FROM recommendation'), ok('search-recommendations.json')],
]
function answer(query: string, pageToken: string | null): Response {
  const route = ROUTES.find(([, matches]) => matches(query))
  if (!route) throw new Error(`test: no answer for ${query.slice(0, 80)}`)
  return (h.override[route[0]] ?? route[2])(query, pageToken)
}
const routeOf = (query: string) => ROUTES.find(([, matches]) => matches(query))?.[0]

const redisStore = new Map<string, string>()
const memoryRedis: OpsRedis = {
  status: 'ready',
  async incrby(key, n) { const v = Number(redisStore.get(key) ?? 0) + n; redisStore.set(key, String(v)); return v },
  async decrby(key, n) { const v = Number(redisStore.get(key) ?? 0) - n; redisStore.set(key, String(v)); return v },
  async expire() { return 1 },
  async mget(...keys) { return keys.map((k) => redisStore.get(k) ?? null) },
  async get(key) { return redisStore.get(key) ?? null },
  // SET … PX … NX as Redis answers it (the read lock); expiry is not modelled.
  async set(key: string, value: string, _mode?: 'PX', _ms?: number, nx?: 'NX') {
    if (nx === 'NX' && redisStore.has(key)) return null
    redisStore.set(key, value)
    return 'OK'
  },
  // Only the lock's compare-and-delete is understood.
  async eval(script: string, _keys: number, key: string | number, token: string | number) {
    if (script !== RELEASE_LEASE) throw new Error('memory Redis: unknown script')
    if (redisStore.get(String(key)) !== String(token)) return 0
    redisStore.delete(String(key))
    return 1
  },
}
const accountOps = () => [...redisStore.entries()].filter(([k]) => k.startsWith(`nexus:gads:ops:acct:${CID}:`)).reduce((t, [, v]) => t + Number(v), 0)
const alreadyUsed = (now: Date, ops: number) => redisStore.set(`nexus:gads:ops:acct:${CID}:${now.toISOString().slice(0, 13).replace(/[-T]/g, '')}`, String(ops))
const states = () => inA(async () => Object.fromEntries([...(await readStatesOf(CID)).entries()]))
const detailsBy = (result: Awaited<ReturnType<typeof syncGoogleAdsAccount>>) => Object.fromEntries(result.details.map((d) => [d.resource, d.status]))
const run = (now: Date) => inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(
      `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
      [id],
    )
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.override = {}; redisStore.clear(); h.alerts.mockClear()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  setOpsBudgetRedisForTests(memoryRedis)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as { query?: string; pageToken?: string }
    h.calls.push({ url: String(url), method: String(init.method), query: body.query ?? '', pageToken: body.pageToken ?? null })
    return answer(body.query ?? '', body.pageToken ?? null)
  }))
})
afterEach(() => { vi.unstubAllGlobals(); __rateTest.reset(); setOpsBudgetRedisForTests(undefined) })

describe('step 1b reads in the run (fixtures → gateway → PGlite)', () => {
  it('the first run: core first, then tiers 2–5, first reads in pieces — 26 operations of 27, every read recorded, only reads', async () => {
    const result = await run(RUN_1)
    expect(result).toMatchObject({ status: 'SUCCESS', error: null, ops: 26, tiersDropped: [], alertsRaised: 0 })
    expect(detailsBy(result)).toEqual({
      CAMPAIGN_SETTINGS: 'SUCCESS', AD_POLICY: 'SUCCESS', PRODUCT_STATUS: 'SUCCESS', AUTO_APPLY: 'SUCCESS', AD_GROUP_DAYS: 'SUCCESS', KEYWORD_DAYS: 'SUCCESS',
      ASSET_GROUP_DAYS: 'SUCCESS', PRODUCT_DAYS: 'SUCCESS', SEARCH_TERM_DAYS: 'SUCCESS', AD_GROUPS: 'SUCCESS', KEYWORDS: 'SUCCESS', CAMPAIGN_NEGATIVES: 'SUCCESS',
      ASSET_GROUPS: 'SUCCESS', NEGATIVE_LISTS: 'SUCCESS', RECOMMENDATIONS: 'SUCCESS',
    })
    expect(h.calls.map((c) => routeOf(c.query))).toEqual([
      'customer', 'campaigns', 'campaigns', 'campaignDays', 'changes',
      'flags', 'adPolicy', 'products', 'autoApply',
      'adGroupDays', 'adGroupDays', 'adGroupDays', 'keywordDays', 'keywordDays', 'keywordDays', 'assetGroupDays', 'productDays', 'searchTerms', 'searchTerms',
      'adGroups', 'keywords', 'campaignNegatives', 'assetGroups',
      'listKeywords', 'listAttachments', 'accountLists', 'recommendations',
    ])
    const windows = (route: string) => h.calls.filter((c) => routeOf(c.query) === route).map((c) => /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(c.query)!.slice(1).join('..'))
    expect(windows('keywordDays')).toEqual(['2026-07-15..2026-08-13', '2026-08-14..2026-09-12', '2026-09-13..2026-10-12'])
    expect(windows('searchTerms')).toEqual(['2026-09-13..2026-09-27', '2026-09-28..2026-10-12'])
    expect(windows('assetGroupDays')).toEqual(['2026-07-15..2026-10-12'])
    expect(windows('productDays')).toEqual(['2026-09-13..2026-10-12'])
    for (const call of h.calls) {
      expect(call.method).toBe('POST')
      expect(googleKind(call.method, call.url)).toBe('read')
      expect(call.query.startsWith('SELECT ')).toBe(true)
    }
    // 27 reserved (22 + the first reads' 5 extra pieces), 1 given back.
    expect(accountOps()).toBe(26)
    expect(h.alerts).toHaveBeenCalledTimes(1)
    expect(h.alerts).toHaveBeenCalledWith(CID, RUN_1)

    const read = await states()
    expect(Object.keys(read).sort()).toHaveLength(15)
    for (const state of Object.values(read)) expect(state).toMatchObject({ workspaceId: A, lastStatus: 'SUCCESS', lastError: null, readAt: expect.any(Date) })
    expect(read.AD_GROUP_DAYS).toMatchObject({ readFrom: day('2026-07-15'), readThrough: day('2026-10-12'), rows: 2 })
    expect(read.SEARCH_TERM_DAYS).toMatchObject({ readFrom: day('2026-09-13'), readThrough: day('2026-10-12'), rows: 2 })
    expect(read.PRODUCT_DAYS).toMatchObject({ readFrom: day('2026-09-13'), readThrough: day('2026-10-12'), rows: 2 })
    expect(read.AD_POLICY).toMatchObject({ readFrom: null, rows: 2 })
    await inA(async () => {
      // The account's campaign range is the campaign read's (400 days), never a grain's.
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({
        lastSyncStatus: 'SUCCESS', opsUsedLastRun: 26, metricsReadFrom: day('2025-09-08'), metricsReadThrough: day('2026-10-12'), lastSuccessAt: expect.any(Date),
      })
      const flags = await db().googleAdsCampaign.findMany({ orderBy: { campaignId: 'asc' }, select: { campaignId: true, flagsReadAt: true, aiMaxEnabled: true, keywordMatchType: true, assetAutomation: true, dsaDomain: true } })
      expect(flags.map((f) => [f.campaignId, f.aiMaxEnabled, f.keywordMatchType, Array.isArray(f.assetAutomation) ? f.assetAutomation.length : f.assetAutomation, f.dsaDomain])).toEqual([
        ['11111111111', true, 'BROAD', 2, 'shop.example.com'], ['22222222222', false, null, 0, null], ['33333333333', false, null, 0, null],
      ])
      expect(flags.every((f) => f.flagsReadAt instanceof Date)).toBe(true)
      expect(await db().googleAdsPolicyIssue.findMany({ orderBy: { entityKey: 'asc' }, select: { kind: true, entityKey: true, status: true, resolvedAt: true } })).toEqual([
        { kind: 'PRODUCT', entityKey: '5555555555~ONLINE~it~IT~test-sku-1', status: 'NOT_ELIGIBLE', resolvedAt: null },
        { kind: 'PRODUCT', entityKey: '5555555555~ONLINE~it~IT~test-sku-2', status: 'ELIGIBLE_LIMITED', resolvedAt: null },
        { kind: 'AD', entityKey: '71111111111~81111111111', status: 'DISAPPROVED', resolvedAt: null },
        { kind: 'AD', entityKey: '71111111111~81111111112', status: 'APPROVED_LIMITED', resolvedAt: null },
      ])
      expect(await db().googleAdsAutoApply.count()).toBe(2)
      // Rows on one daily key summed: two spellings of one search term, two titles of one product.
      const days = await db().googleAdsDailyMetric.findMany({ where: { entityType: { not: 'CAMPAIGN' } }, orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }, { date: 'asc' }] })
      expect(days.map((d) => `${d.entityType}:${d.label}:${d.date.toISOString().slice(0, 10)}:${d.impressions}/${d.clicks}/${d.conversions.toString()}`)).toEqual([
        'AD_GROUP:Test helmets:2026-10-12:900/30/2', 'AD_GROUP:Test gloves:2026-10-12:120/0/0',
        'ASSET_GROUP:Test asset group:2026-10-12:2500/41/3',
        'KEYWORD:test helmet:2026-10-12:700/25/1.5', 'KEYWORD:test full face helmet:2026-10-11:40/2/0',
        'PRODUCT:Test gloves:2026-10-12:75/0/0', 'PRODUCT:Test helmet, size M:2026-10-12:320/10/1',
        ...days.filter((d) => d.entityType === 'SEARCH_TERM').map((d) => `SEARCH_TERM:${d.label}:${d.date.toISOString().slice(0, 10)}:${d.impressions}/${d.clicks}/${d.conversions.toString()}`),
      ])
      expect(days.filter((d) => d.entityType === 'SEARCH_TERM').map((d) => [d.label, d.clicks, d.conversions.toString()]).sort())
        .toEqual([['test gloves winter', 1, '0'], ['test helmet', 8, '1.5']])
      expect(await db().googleAdsAdGroup.count()).toBe(2)
      expect(await db().googleAdsAssetGroup.count()).toBe(1)
      const keywords = await db().googleAdsKeyword.findMany({ orderBy: [{ level: 'asc' }, { criterionId: 'asc' }], select: { level: true, criterionId: true, negative: true, criterionType: true } })
      expect(keywords.map((k) => `${k.level}:${k.criterionId}:${k.negative ? 'negative' : 'keyword'}:${k.criterionType}`)).toEqual([
        'AD_GROUP:91111:keyword:KEYWORD', 'AD_GROUP:91112:keyword:KEYWORD', 'AD_GROUP:91113:negative:KEYWORD',
        'CAMPAIGN:92111:negative:KEYWORD', 'CAMPAIGN:92112:negative:BRAND_LIST', 'LIST:93111:negative:KEYWORD', 'LIST:93112:negative:KEYWORD',
        'LIST:93121:negative:KEYWORD',
      ])
      // The placement list is not a negative keyword list; the account-level list is, with its type and no campaign — in
      // force, as a customer_negative_criterion of the account points at it.
      expect(await db().googleAdsNegativeList.findMany({ orderBy: { sharedSetId: 'asc' }, select: { sharedSetId: true, name: true, memberCount: true, listType: true, appliesToAccount: true, campaignIds: true } }))
        .toEqual([
          { sharedSetId: '66666666666', name: 'Test negative list', memberCount: 2, listType: 'NEGATIVE_KEYWORDS', appliesToAccount: false, campaignIds: ['11111111111', '33333333333'] },
          { sharedSetId: '77777777777', name: 'Test account negatives', memberCount: 1, listType: 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS', appliesToAccount: true, campaignIds: [] },
        ])
      expect(await db().googleAdsRecommendation.findMany({ orderBy: { resourceName: 'asc' }, select: { type: true, dismissed: true } }))
        .toEqual([{ type: 'KEYWORD', dismissed: false }, { type: 'CAMPAIGN_BUDGET', dismissed: true }])
    })
    await withWorkspace(scope(B), async () => {
      expect(await db().googleAdsReadState.count()).toBe(0)
      expect(await db().googleAdsKeyword.count()).toBe(0)
    })
  })

  it('the next day: 22 reserved, 21 spent, 14 / 7 days; what Google no longer returns is removed or resolved; recommendations replaced whole', async () => {
    h.override.adPolicy = () => json({ results: page('search-ad-policy.json').results.slice(2) }) // only the approved ad is left
    h.override.keywords = () => json({ results: page('search-keywords.json').results.slice(0, 2) })
    h.override.recommendations = () => json({ results: page('search-recommendations.json').results.slice(1) })
    const result = await run(RUN_2)
    expect(result).toMatchObject({ status: 'SUCCESS', ops: 21 })
    expect(h.calls).toHaveLength(5 + 17)
    expect(accountOps()).toBe(21)
    const window = (route: string) => /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(h.calls.find((c) => routeOf(c.query) === route)!.query)!.slice(1).join('..')
    expect(window('keywordDays')).toBe('2026-09-30..2026-10-13')
    expect(window('searchTerms')).toBe('2026-10-07..2026-10-13')
    const read = await states()
    expect(read.KEYWORD_DAYS).toMatchObject({ readFrom: day('2026-07-15'), readThrough: day('2026-10-13') })
    await inA(async () => {
      expect(await db().googleAdsPolicyIssue.count({ where: { kind: 'AD', resolvedAt: RUN_2 } })).toBe(2)
      expect(await db().googleAdsPolicyIssue.count({ where: { kind: 'PRODUCT', resolvedAt: null } })).toBe(2)
      expect(await db().googleAdsKeyword.findFirstOrThrow({ where: { criterionId: '91113' } })).toMatchObject({ removedAt: RUN_2 })
      expect(await db().googleAdsKeyword.count({ where: { level: { not: 'AD_GROUP' }, removedAt: null } })).toBe(5)
      expect(await db().googleAdsRecommendation.findMany({ select: { type: true } })).toEqual([{ type: 'CAMPAIGN_BUDGET' }])
    })
  })

  it('short of allowance: tier 5 then 4 dropped — SKIPPED_BUDGET in words, nothing they read before moves; the run PARTIAL, its data as of now', async () => {
    const before = await states()
    alreadyUsed(RUN_3, 86) // 22 and 18 do not fit under 100; 14 (core + tiers 2 and 3) does
    const result = await run(RUN_3)
    expect(result).toMatchObject({ status: 'PARTIAL', ops: 4 + 4 + 5, tiersDropped: [4, 5] })
    expect(result.error).toMatch(/^Some parts were not read in this run: the Google Ads allowance ran short/)
    expect(accountOps()).toBe(86 + 13)
    const routes = new Set(h.calls.map((c) => routeOf(c.query)))
    for (const route of ['adGroups', 'keywords', 'campaignNegatives', 'assetGroups', 'listKeywords', 'listAttachments', 'accountLists', 'recommendations']) expect(routes.has(route)).toBe(false)
    const read = await states()
    for (const resource of ['AD_GROUPS', 'KEYWORDS', 'CAMPAIGN_NEGATIVES', 'ASSET_GROUPS', 'NEGATIVE_LISTS', 'RECOMMENDATIONS']) {
      expect(read[resource]).toMatchObject({ lastStatus: 'SKIPPED_BUDGET', readAt: before[resource].readAt, rows: before[resource].rows, lastAttemptAt: expect.any(Date) })
      expect(read[resource].lastError).toMatch(/^Not read in this run: the Google Ads allowance ran short/)
    }
    expect(read.KEYWORD_DAYS).toMatchObject({ lastStatus: 'SUCCESS', readThrough: day('2026-10-14') })
    const account = await inA(() => getGoogleAdsCustomer(CID))
    expect(account).toMatchObject({ lastSyncStatus: 'PARTIAL', opsUsedLastRun: 13 })
    // The four core reads succeeded: the data is as of this run.
    expect(account!.lastSuccessAt!.getTime()).toBeGreaterThan(before.KEYWORDS.readAt!.getTime())
  })

  it('only the core fits: every step 1b read SKIPPED_BUDGET; not even the core: no call at all (as in step 1a)', async () => {
    alreadyUsed(RUN_4, 95)
    const core = await run(RUN_4)
    expect(core).toMatchObject({ status: 'PARTIAL', ops: 4, tiersDropped: [2, 3, 4, 5] })
    expect(new Set(core.details.map((d) => d.status))).toEqual(new Set(['SKIPPED_BUDGET']))
    expect(h.calls.map((c) => routeOf(c.query))).toEqual(['customer', 'campaigns', 'campaigns', 'campaignDays', 'changes'])
    h.calls = []
    alreadyUsed(RUN_4, 96)
    const none = await run(RUN_4)
    expect(none).toMatchObject({ status: 'SKIPPED_BUDGET', ops: 0 })
    expect(h.calls).toHaveLength(0)
    const read = await states()
    expect(read.AD_POLICY).toMatchObject({ lastStatus: 'SKIPPED_BUDGET', readAt: expect.any(Date) })
    expect(read.AD_POLICY.lastError).toMatch(/is not started: this account has used 96 of its 100/)
  })

  it('a refused query fails that read only — in words, its range unmoved; the run goes on, PARTIAL, its data as of now', async () => {
    const before = await states()
    h.override.keywordDays = fail('queryError')
    const result = await run(RUN_5)
    expect(result).toMatchObject({ status: 'PARTIAL', ops: 21 })
    expect(result.error).toMatch(/^Keyword numbers: Google Ads refused the request/)
    expect(result.details.filter((d) => d.status !== 'SUCCESS')).toEqual([
      { resource: 'KEYWORD_DAYS', status: 'FAILED', rows: 0, error: expect.stringMatching(/^Google Ads refused the request/) },
    ])
    const read = await states()
    expect(read.KEYWORD_DAYS).toMatchObject({ lastStatus: 'FAILED', readAt: before.KEYWORD_DAYS.readAt, readFrom: before.KEYWORD_DAYS.readFrom, readThrough: before.KEYWORD_DAYS.readThrough })
    expect(read.AD_GROUP_DAYS).toMatchObject({ lastStatus: 'SUCCESS', readThrough: day('2026-10-16') })
    expect(await inA(() => getGoogleAdsCustomer(CID))).toMatchObject({ lastSyncStatus: 'PARTIAL', lastSuccessAt: expect.any(Date) })
  })

  it('safety net: a query Google refuses anyway is sent again without the field; what it carries is then "not read"', async () => {
    const refusedWith = (field: string, fixture: string, ...strip: string[]): Answer => (q, token) => (q.includes(field) ? fail('queryError')(q, token) : (strip.length ? without(fixture, ...strip) : ok(fixture))(q, token))
    h.override.flags = refusedWith('asset_automation_settings', 'search-campaign-flags.json')
    h.override.recommendations = refusedWith('recommendation.impact', 'search-recommendations.json')
    h.override.searchTerms = refusedWith('metrics.clicks > 0', 'search-search-terms.json')
    h.override.listKeywords = refusedWith('shared_set.id', 'search-negative-list-keywords.json', 'sharedSet')
    h.override.listAttachments = refusedWith('shared_set.id', 'search-negative-list-attachments.json', 'sharedSet')
    const result = await run(RUN_6)
    expect(result).toMatchObject({ status: 'SUCCESS', ops: 21 + 5 })
    expect(h.calls).toHaveLength(5 + 17 + 5)
    // 22 reserved: the spare covers the first twin, each of the other four is reserved before it is sent — the run never
    // spends more than it reserved.
    expect(result.opsReserved).toBe(26)
    expect(accountOps()).toBe(26)
    const searchTermQueries = h.calls.filter((c) => routeOf(c.query) === 'searchTerms').map((c) => c.query.includes('metrics.clicks > 0'))
    expect(searchTermQueries).toEqual([true, false])
    await inA(async () => {
      expect(await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '11111111111' } })).toMatchObject({ assetAutomation: null, aiMaxEnabled: true })
      expect(await db().googleAdsRecommendation.findMany({ orderBy: { resourceName: 'asc' }, select: { impact: true, dismissed: true } }))
        .toEqual([{ impact: null, dismissed: false }, { impact: null, dismissed: true }])
      // The term without a click is not kept; each list keeps its name and type; the placement list stays out. Whether
      // the account's list is in force is still read (its query has no field to leave out).
      expect(await db().googleAdsDailyMetric.count({ where: { entityType: 'SEARCH_TERM', label: 'test jacket' } })).toBe(0)
      expect(await db().googleAdsNegativeList.findMany({ where: { removedAt: null }, orderBy: { sharedSetId: 'asc' }, select: { sharedSetId: true, name: true, listType: true, appliesToAccount: true, campaignIds: true } }))
        .toEqual([
          { sharedSetId: '66666666666', name: 'Test negative list', listType: 'NEGATIVE_KEYWORDS', appliesToAccount: false, campaignIds: ['11111111111', '33333333333'] },
          { sharedSetId: '77777777777', name: 'Test account negatives', listType: 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS', appliesToAccount: true, campaignIds: [] },
        ])
    })
  })

  it('the sign-in lost during step 1b: the run stops; the reads it did not reach say why (AUTH_LOST)', async () => {
    h.override.adPolicy = fail('authRevoked')
    const result = await run(RUN_7)
    expect(result).toMatchObject({ status: 'AUTH_LOST', ops: 4 + 2 })
    expect(result.error).toMatch(/^Ad approvals: The Google sign-in no longer works/)
    expect(h.calls.map((c) => routeOf(c.query))).toEqual(['customer', 'campaigns', 'campaigns', 'campaignDays', 'changes', 'flags', 'adPolicy'])
    const by = detailsBy(result)
    expect([by.CAMPAIGN_SETTINGS, by.AD_POLICY, by.RECOMMENDATIONS]).toEqual(['SUCCESS', 'FAILED', 'FAILED'])
    const read = await states()
    expect(read.RECOMMENDATIONS.lastError).toMatch(/^Not read in this run: The Google sign-in no longer works/)
    expect(read.AD_POLICY.lastError).toMatch(/^The Google sign-in no longer works/)
  })

  it('retention: search term days older than 180 days are deleted and the range moves with them; an alert failure never fails the run', async () => {
    await inA(async () => {
      await db().googleAdsDailyMetric.create({ data: {
        customerId: CID, date: day('2026-03-02'), entityType: 'SEARCH_TERM', entityId: '11111111111~000000000000000000000000', campaignId: '11111111111',
        label: 'test old term', clicks: 1, currencyCode: 'EUR', pulledAt: RUN_1,
      } })
      await db().googleAdsReadState.update({ where: { google_ads_read_state: { customerId: CID, resource: 'SEARCH_TERM_DAYS' } }, data: { readFrom: day('2026-03-01') } })
    })
    h.alerts.mockRejectedValueOnce(new Error('alerts are broken'))
    const RUN_8 = new Date('2026-10-22T06:25:00Z')
    const result = await run(RUN_8)
    expect(result).toMatchObject({ status: 'SUCCESS', alertsRaised: null })
    // Yesterday 2026-10-21 − 179 days.
    expect((await states()).SEARCH_TERM_DAYS).toMatchObject({ readFrom: day('2026-04-25'), readThrough: day('2026-10-21') })
    await inA(async () => expect(await db().googleAdsDailyMetric.count({ where: { label: 'test old term' } })).toBe(0))
  })
})

describe('big accounts: refusals remembered, never beyond the reservation, one read at a time, the row cap', () => {
  const C = 'gads_detail_sync_charlie'
  const D = 'gads_detail_sync_delta'
  const inC = <T>(work: () => Promise<T>) => withWorkspace(scope(C), work)
  const inD = <T>(work: () => Promise<T>) => withWorkspace(scope(D), work)
  // After RUN_8; none on the account's Sunday (a longer window).
  const R9 = new Date('2026-10-23T06:25:00Z')
  const R10 = new Date('2026-10-24T06:25:00Z')
  const R11 = new Date('2026-10-31T06:25:00Z') // 8 days after R9
  const R12 = new Date('2026-11-03T06:25:00Z')
  const R13 = new Date('2026-11-04T06:25:00Z')
  const R14 = new Date('2026-11-05T06:25:00Z')
  /** The fields behind the five safety-net twins. */
  const FIELDS = ['asset_automation_settings', 'recommendation.impact', 'metrics.clicks > 0', 'shared_set.id']
  /** Google refuses every query that names one of FIELDS (as if they were unknown); the twins get the fixtures. */
  const refuseAll = () => {
    const refusedWith = (field: string, fixture: string, ...strip: string[]): Answer => (q, token) => (q.includes(field) ? fail('queryError')(q, token) : (strip.length ? without(fixture, ...strip) : ok(fixture))(q, token))
    h.override.flags = refusedWith('asset_automation_settings', 'search-campaign-flags.json')
    h.override.recommendations = refusedWith('recommendation.impact', 'search-recommendations.json')
    h.override.searchTerms = refusedWith('metrics.clicks > 0', 'search-search-terms.json')
    h.override.listKeywords = refusedWith('shared_set.id', 'search-negative-list-keywords.json', 'sharedSet')
    h.override.listAttachments = refusedWith('shared_set.id', 'search-negative-list-attachments.json', 'sharedSet')
  }
  const sent = (field: string) => h.calls.filter((c) => c.query.includes(field)).length
  /** A new run: no call recorded yet, the gateway's Google Ads burst refilled (as the hours between two reads would). */
  const fresh = () => { h.calls = []; __rateTest.useMemory() }
  /** One keyword's day, made from the fixture's first row. */
  const keywordDay = (criterionId: string, date: string) => {
    const row = structuredClone(page('search-keyword-days.json').results[0]) as Record<string, Record<string, unknown>>
    row.adGroupCriterion = { ...row.adGroupCriterion, criterionId, resourceName: `customers/${CID}/adGroupCriteria/71111111111~${criterionId}` }
    row.segments = { date }
    return row
  }
  /** Google's keyword days: these rows, each window getting only its own days. */
  const keywordDays = (rows: Array<Record<string, unknown>>): Answer => (query) => {
    const window = /segments\.date BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(query)!
    return json({ results: rows.filter((r) => { const d = (r.segments as { date: string }).date; return d >= window[1] && d <= window[2] }) })
  }
  const windowsOf = (route: string) => h.calls.filter((c) => routeOf(c.query) === route).map((c) => /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(c.query)!.slice(1).join('..'))

  beforeAll(async () => {
    for (const id of [C, D]) {
      await database.db.query(
        `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
        [id],
      )
    }
  })
  afterEach(() => setMaxMetricRowsForTests(undefined))

  it('a refused query is remembered 7 days for this business and account: the next reads send the twin at once; after 7 days the full query again', async () => {
    refuseAll()
    const first = await run(R9)
    expect(first).toMatchObject({ status: 'SUCCESS', ops: 21 + 5, opsReserved: 26 })
    expect(FIELDS.map(sent)).toEqual([1, 1, 1, 2])
    expect([...redisStore.keys()].filter((k) => k.startsWith('nexus:gads:fallback:')).sort()).toEqual([
      `nexus:gads:fallback:${A}:${CID}:ads.search.campaignSettings`, `nexus:gads:fallback:${A}:${CID}:ads.search.negativeListAttachments`,
      `nexus:gads:fallback:${A}:${CID}:ads.search.negativeListKeywords`, `nexus:gads:fallback:${A}:${CID}:ads.search.recommendations`,
      `nexus:gads:fallback:${A}:${CID}:ads.search.searchTermDays`,
    ])

    // The next day: no refused attempt, no operation beyond the plan.
    fresh()
    const next = await run(R10)
    expect(next).toMatchObject({ status: 'SUCCESS', ops: 21, opsReserved: 22 })
    expect(h.calls).toHaveLength(5 + 17)
    expect(FIELDS.map(sent)).toEqual([0, 0, 0, 0])
    expect(await inA(async () => (await db().googleAdsCampaign.findFirstOrThrow({ where: { campaignId: '11111111111' } })).assetAutomation)).toBeNull()

    // Another business reading the same account remembers nothing of A's: it asks the full queries itself.
    fresh()
    const other = await inC(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: R10 }))
    expect(other.status).toBe('SUCCESS')
    expect(FIELDS.map(sent)).toEqual([1, 1, 1, 2])

    // Seven days on, A tries the full query again (refused again here, so the twin follows and is remembered anew).
    fresh()
    const later = await run(R11)
    expect(later).toMatchObject({ status: 'SUCCESS', ops: 21 + 5, opsReserved: 26 })
    expect(FIELDS.map(sent)).toEqual([1, 1, 1, 2])
  })

  it('never more operations than reserved: with the allowance full, a refused query is not sent again — that read fails in words, the count stays at the cap', async () => {
    alreadyUsed(R12, 78) // the run's 22 fit exactly under 100
    refuseAll()
    const result = await run(R12)
    // The spare pays the first twin (campaign settings); the search terms' and the lists' twins find no allowance; the
    // lists' attachments and account queries are then never sent: one pays the recommendations' twin, one is given back.
    expect(result).toMatchObject({ status: 'PARTIAL', ops: 21, opsReserved: 22 })
    expect(accountOps()).toBe(99)
    expect(detailsBy(result)).toMatchObject({ CAMPAIGN_SETTINGS: 'SUCCESS', SEARCH_TERM_DAYS: 'FAILED', NEGATIVE_LISTS: 'FAILED', RECOMMENDATIONS: 'SUCCESS' })
    expect(result.error).toMatch(/^Search terms: Google Ads refused this query, and the Google Ads allowance ran short/)
    expect(h.calls.filter((c) => routeOf(c.query) === 'listAttachments' || routeOf(c.query) === 'accountLists')).toHaveLength(0)
    const read = await states()
    expect(read.NEGATIVE_LISTS.lastError).toMatch(/allowance ran short to send it again without the field Google refused/)
  })

  it('two reads of one account at once: one reads, the other is skipped in words and spends nothing; no structure row is marked removed', async () => {
    const structure = () => inA(async () => ({
      keywords: await db().googleAdsKeyword.count({ where: { removedAt: null } }),
      adGroups: await db().googleAdsAdGroup.count({ where: { removedAt: null } }),
      assetGroups: await db().googleAdsAssetGroup.count({ where: { removedAt: null } }),
      lists: await db().googleAdsNegativeList.count({ where: { removedAt: null } }),
      issues: await db().googleAdsPolicyIssue.count({ where: { resolvedAt: null } }),
    }))
    await run(R13) // every row seen as Google answers it
    const before = await structure()
    fresh()
    redisStore.clear()
    const both = await Promise.all([run(R13), run(R13)])
    const skipped = both.filter((r) => r.status === 'ALREADY_RUNNING')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ ops: 0, opsReserved: 0, details: [], mode: null })
    expect(skipped[0].error).toMatch(/^Another read of this Google Ads account is running, so this one was skipped/)
    expect(both.filter((r) => r.status === 'SUCCESS')).toHaveLength(1)
    expect(h.calls).toHaveLength(5 + 17)
    expect(accountOps()).toBe(21)
    expect(await structure()).toEqual(before)
    // The lock is given back.
    expect([...redisStore.keys()].filter((k) => k.startsWith('nexus:gads:read-lock:'))).toEqual([])

    // Without Redis: a lock in this process (and no allowance, so no call at all).
    setOpsBudgetRedisForTests(null)
    fresh()
    const local = await Promise.all([run(R13), run(R13)])
    expect(local.map((r) => r.status).sort()).toEqual(['ALREADY_RUNNING', 'SKIPPED_BUDGET'])
    expect(h.calls).toHaveLength(0)
    expect((await run(R13)).status).toBe('SKIPPED_BUDGET')
  })

  it('a first read over the row cap is read once more over half its window, all or nothing — never a third time; the read state says so', async () => {
    setMaxMetricRowsForTests(4)
    // D never read the account. Too many keyword days even in the last 45 days: the read fails, after two attempts only.
    h.override.keywordDays = keywordDays(['2026-09-01', '2026-09-05', '2026-09-10', '2026-09-15', '2026-09-20', '2026-10-01'].map((d, i) => keywordDay(`9500${i}`, d)))
    const failed = await inD(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_1 }))
    expect(windowsOf('keywordDays')).toEqual(['2026-07-15..2026-08-13', '2026-08-14..2026-09-12', '2026-09-13..2026-10-12', '2026-08-29..2026-09-27'])
    expect(failed.details.find((d) => d.resource === 'KEYWORD_DAYS')).toMatchObject({
      status: 'FAILED', error: expect.stringMatching(/^Google sent more than 4 rows of daily numbers for the first 90 days, and more than 4 even for the last 45 days\. Nexus kept none/),
    })
    // The second attempt's operations were reserved before it was sent.
    expect(failed.ops).toBe(27)
    expect(failed.ops).toBeLessThanOrEqual(failed.opsReserved)
    const afterFail = await inD(async () => Object.fromEntries([...(await readStatesOf(CID)).entries()]))
    expect(afterFail.KEYWORD_DAYS).toMatchObject({ lastStatus: 'FAILED', readFrom: null, readThrough: null })
    expect(await inD(() => db().googleAdsDailyMetric.count({ where: { entityType: 'KEYWORD' } }))).toBe(0)

    // The next day the old days hold the bulk: the last 45 days fit, and are stored with a sentence that says so.
    fresh()
    h.override.keywordDays = keywordDays([
      ...['2026-07-20', '2026-07-25', '2026-08-01', '2026-08-05', '2026-08-10'].map((d, i) => keywordDay(`9600${i}`, d)),
      ...page('search-keyword-days.json').results,
    ])
    const shorter = await inD(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    expect(windowsOf('keywordDays')).toEqual(['2026-07-16..2026-08-14', '2026-08-30..2026-09-28', '2026-09-29..2026-10-13'])
    const keywordRead = shorter.details.find((d) => d.resource === 'KEYWORD_DAYS')
    expect(keywordRead).toMatchObject({ status: 'SUCCESS', rows: 2, error: null })
    expect(keywordRead?.note).toMatch(/^Google sent more than 4 rows of daily numbers for the first 90 days, so Nexus read the last 45 days instead\./)
    expect(shorter.ops).toBeLessThanOrEqual(shorter.opsReserved)
    const after = await inD(async () => Object.fromEntries([...(await readStatesOf(CID)).entries()]))
    expect(after.KEYWORD_DAYS).toMatchObject({ lastStatus: 'SUCCESS', readFrom: day('2026-08-30'), readThrough: day('2026-10-13'), rows: 2 })
    expect(after.KEYWORD_DAYS.lastError).toMatch(/so Nexus read the last 45 days instead\. Older days are not read\./)
    expect(await inD(() => db().googleAdsDailyMetric.count({ where: { entityType: 'KEYWORD' } }))).toBe(2)
  })

  it('a search-term read over the cap fails in words at the page that crossed it — the pages after it are never asked for, nothing stored moves', async () => {
    setMaxMetricRowsForTests(4)
    const before = await states()
    // A term stored inside the window this read replaces: a complete read would replace it; a refused one keeps it.
    await inA(() => db().googleAdsDailyMetric.create({ data: {
      customerId: CID, date: day('2026-11-02'), entityType: 'SEARCH_TERM', entityId: '11111111111~111111111111111111111111', campaignId: '11111111111',
      label: 'test kept term', clicks: 2, currencyCode: 'EUR', pulledAt: R13,
    } }))
    const storedTerms = () => inA(() => db().googleAdsDailyMetric.findMany({ where: { entityType: 'SEARCH_TERM', date: { gte: day('2026-10-29') } }, select: { label: true } }))
    const termsBefore = await storedTerms()
    expect(termsBefore).toEqual([{ label: 'test kept term' }])
    const term = (n: number) => ({ ...page('search-search-terms.json').results[0], campaignSearchTermView: { searchTerm: `test term ${n}` }, segments: { date: '2026-11-03' } })
    h.override.searchTerms = (_query, token) => {
      if (!token) return json({ results: [term(1), term(2), term(3)], nextPageToken: 'terms-page-2' })
      if (token === 'terms-page-2') return json({ results: [term(4), term(5), term(6)], nextPageToken: 'terms-page-3' })
      return json({ results: [term(7), term(8), term(9)] })
    }
    const result = await run(R14)
    expect(h.calls.filter((c) => routeOf(c.query) === 'searchTerms').map((c) => c.pageToken)).toEqual([null, 'terms-page-2'])
    expect(result.details.find((d) => d.resource === 'SEARCH_TERM_DAYS')).toMatchObject({
      status: 'FAILED', error: 'Google sent more than 4 rows of daily numbers for 7 days of this part of the account; Nexus kept none of this read.',
    })
    expect(result.ops).toBe(21)
    const read = await states()
    expect(read.SEARCH_TERM_DAYS).toMatchObject({ lastStatus: 'FAILED', readAt: before.SEARCH_TERM_DAYS.readAt, readThrough: before.SEARCH_TERM_DAYS.readThrough })
    expect(await storedTerms()).toEqual(termsBefore)
  })
})

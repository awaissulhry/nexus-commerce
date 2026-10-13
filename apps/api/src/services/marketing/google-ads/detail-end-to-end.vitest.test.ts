/**
 * Google Ads step 1b — the two halves together: ONE first daily read (sync.service.ts through the REAL read client and
 * channel gateway into the REAL store on PGlite, Google's answers from the fixtures in test-support/google-ads, the real
 * alerts raised after the run) and then every read service over exactly the rows that read wrote (R1 reads, R5–R15).
 * Only `fetch`, the token, the gateway's account state and ledger are stand-ins; the business's Google sign-in is a real
 * ChannelConnection with a GoogleAccountLink, as Settings › Channels › Google saves it.
 *
 *   each service finds the account through the sign-in, answers with the run's rows (numbers on read days, settings,
 *   statuses, read states), joins what the other tables hold (product statuses by item id, brand by protected terms,
 *   auto-apply by type, a Nexus product by SKU), and turns micros and currency units into cents; another business gets
 *   none of it (404 for its campaign, empty lists, "not read yet")
 *
 * Money stripping without the ad-spend permission is the routes' job (google-ads-read.routes), not tested here.
 * Values are made up (public repo).
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
type Answer = (query: string, pageToken: string | null) => Response
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

import { __rateTest } from '../../gateway/rate.js'
import { GOOGLE_REQUIRED_SCOPES } from '../../cx/connectors/google/scopes.js'
import { setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { syncGoogleAdsAccount } from './sync.service.js'
import { mapCampaignFlags } from './mappers.js'
import { saveCampaignFlags } from './store-detail.js'
import type { GoogleAdsCampaignFlagsRow } from './types.js'
import { googleAdsOverview } from './read.service.js'
import {
  googleAdsAdGroups, googleAdsAssetGroups, googleAdsDisapprovals, googleAdsKeywords, googleAdsNegatives, googleAdsProducts,
} from './read-detail.service.js'
import { googleAdsBrandSplit, googleAdsSearchTerms } from './read-search-terms.service.js'
import { googleAdsActsOnItsOwn, googleAdsRecommendations } from './read-acts.service.js'
import { googleAdsAlerts } from './alerts.service.js'
import { GOOGLE_READ_RESOURCES } from './read-types.js'

// ── Google's answers (as sync-detail.vitest.test.ts) ─────────────────────────────────────────────────────────────────

const raw = (name: string) => readFileSync(new URL(`../../../test-support/google-ads/${name}`, import.meta.url), 'utf8')
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
  return route[2](query, pageToken)
}

const redisStore = new Map<string, string>()
const memoryRedis: OpsRedis = {
  status: 'ready',
  async incrby(key, n) { const v = Number(redisStore.get(key) ?? 0) + n; redisStore.set(key, String(v)); return v },
  async decrby(key, n) { const v = Number(redisStore.get(key) ?? 0) - n; redisStore.set(key, String(v)); return v },
  async expire() { return 1 },
  async mget(...keys) { return keys.map((k) => redisStore.get(k) ?? null) },
  async get(key) { return redisStore.get(key) ?? null },
  async set(key, value) { redisStore.set(key, value); return 'OK' },
}

// ── The two businesses ───────────────────────────────────────────────────────────────────────────────────────────────

const A = 'gads_e2e_alpha'
const B = 'gads_e2e_bravo'
const OWNER = 'gads-e2e-owner'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)
const CID = '1234567890'
const B_CID = '5550001112'
/** Tuesday 08:25 in Rome: the account's yesterday is 2026-10-12. */
const RUN = new Date('2026-10-13T06:25:00Z')
const W = { from: '2026-10-01', to: '2026-10-12' }
/** What the fixtures' brand looks like in an answer of B's business (names, ids, terms, items). */
const A_TRACES = /1234567890|11111111111|22222222222|33333333333|Test search campaign|Test helmets|test helmet|Test negative list|test-sku|Test asset group|test-rec|DESTINATION_NOT_WORKING/i

let connA = ''
let connB = ''
let run: Awaited<ReturnType<typeof syncGoogleAdsAccount>>
const nexus: Record<string, string> = {}

const googleConnection = (externalAccountId: string, displayName: string) => db().channelConnection.create({
  data: { channelType: 'GOOGLE', isActive: true, authStatus: 'connected', externalAccountId, displayName, grantedScopes: GOOGLE_REQUIRED_SCOPES },
})
const adsLink = (connectionId: string, customerId: string) => db().googleAccountLink.create({
  data: { connectionId, product: 'ADS', externalId: customerId, label: 'Test advertiser', selectedByUserId: OWNER, metadata: { currency: 'EUR', timeZone: 'Europe/Rome' } },
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubEnv('NEXUS_GOOGLE_ADS_ALERTS', '')
  await q(`INSERT INTO "UserProfile" (id, email, "displayName", status, "updatedAt") VALUES ($1,'owner@test.local','Owner','active',CURRENT_TIMESTAMP)`, [OWNER])
  for (const id of [A, B]) {
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  // An owner of A, so the bell the run rings has someone to ring.
  await q(`INSERT INTO "Role" (id, key, name, permissions, "updatedAt") VALUES ('role-owner-gads-e2e','OWNER','Owner',ARRAY[]::text[],CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING`)
  const ownerRole = (await q(`SELECT id FROM "Role" WHERE key = 'OWNER' LIMIT 1`)).rows[0] as { id: string }
  await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ('m-gads-e2e-owner', $1, $2, 'active', CURRENT_TIMESTAMP)`, [A, OWNER])
  await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId", "roleId") VALUES ('m-gads-e2e-owner', $1)`, [ownerRole.id])

  await inA(async () => {
    connA = (await googleConnection('test-google-login-e2e-a', 'owner.a@example.test')).id
    await adsLink(connA, CID)
    // The business's brand for every market (and one for one market only, which Google Ads never uses).
    await db().adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'helmet', matchType: 'CONTAINS', marketplace: null } })
    await db().adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'gloves', matchType: 'CONTAINS', marketplace: 'IT' } })
  })
  // A Nexus product whose SKU is the fixture's item id in another case.
  await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ('gads-e2e-prod-a', $1, 'Test-SKU-1', 'Test helmet product', 10, now())`, [A])
  await inB(async () => {
    connB = (await googleConnection('test-google-login-e2e-b', 'owner.b@example.test')).id
    await adsLink(connB, B_CID)
  })

  // ONE first daily read of A's account, as the cron starts it.
  __rateTest.useMemory()
  setOpsBudgetRedisForTests(memoryRedis)
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as { query?: string; pageToken?: string }
    return answer(body.query ?? '', body.pageToken ?? null)
  }))
  try {
    run = await inA(() => syncGoogleAdsAccount({ connectionId: connA, customerId: CID, loginCustomerId: null }, { kind: 'DAILY', now: RUN }))
  } finally {
    vi.unstubAllGlobals()
    __rateTest.reset()
    setOpsBudgetRedisForTests(undefined)
  }
  await inA(async () => {
    for (const c of await db().googleAdsCampaign.findMany({ select: { id: true, campaignId: true } })) nexus[c.campaignId] = c.id
    for (const g of await db().googleAdsAdGroup.findMany({ select: { id: true, adGroupId: true } })) nexus[g.adGroupId] = g.id
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('A\'s first daily read → B\'s read services', () => {
  it('the run read every part and rang the bell itself (warn and danger, no amount)', async () => {
    expect(run).toMatchObject({ status: 'SUCCESS', error: null, tiersDropped: [] })
    expect(run.details.every((d) => d.status === 'SUCCESS')).toBe(true)
    expect(Object.keys(nexus)).toEqual(expect.arrayContaining(['11111111111', '22222222222', '33333333333', '71111111111', '71111111112']))
    // ads_disapproved, products_not_eligible, auto_apply_on, changed_by_google, moved_to_ai_max.
    expect(run.alertsRaised).toBe(5)
    const rows = (await q(`SELECT type, title, body, "workspaceId" FROM "Notification" WHERE "userId" = $1`, [OWNER])).rows as Array<Record<string, string>>
    expect(rows).toHaveLength(5)
    for (const r of rows) {
      expect(r.workspaceId).toBe(A)
      expect(`${r.title} ${r.body}`).not.toMatch(/€|EUR|\d+[.,]\d{2}\b/)
    }
  })

  it('R1 — the overview names every part read, each at the run', async () => {
    const o = await inA(() => googleAdsOverview({ connectionId: connA, ...W }, RUN))
    expect(o.account?.connectionId).toBe(connA)
    expect(o.reads.map((r) => r.resource)).toEqual([...GOOGLE_READ_RESOURCES])
    for (const r of o.reads) expect(r).toMatchObject({ readAt: expect.any(String), lastStatus: 'SUCCESS', lastError: null })
    expect(o.totals).toMatchObject({ impressions: 1842, clicks: 49, spendCents: 3188 })
  })

  it('R5 ad groups and R6 keywords — settings and numbers of the read days, bids in cents', async () => {
    const groups = await inA(() => googleAdsAdGroups({ connectionId: connA, ...W }, RUN))
    expect(groups).toMatchObject({ currency: 'EUR', total: 2, read: { readAt: expect.any(String) }, numbersRead: { readAt: expect.any(String) }, coverage: { daysInWindow: 12, daysRead: 12 } })
    expect(groups.items.map((g) => [g.name, g.status, g.campaignId, g.campaignName, g.campaignType, g.cpcBidCents, g.targetCpaCents, g.targetRoas, g.searchTermMatching])).toEqual([
      ['Test gloves', 'PAUSED', nexus['11111111111'], 'Test search campaign', 'SEARCH', null, 400, 3.5, 'on'],
      ['Test helmets', 'ENABLED', nexus['11111111111'], 'Test search campaign', 'SEARCH', 65, null, null, 'off'],
    ])
    expect(groups.items.every((g) => g.settingsReadAt && g.metrics)).toBe(true)
    expect(groups.items[0].primaryStatusReasons).toEqual(['AD_GROUP_PAUSED'])
    expect(groups.items[1].metrics).toMatchObject({ impressions: 900, clicks: 30, spendCents: 2100, conversions: 2, conversionValueCents: 18050, avgCpcCents: 70 })
    expect(groups.items[0].metrics).toMatchObject({ impressions: 120, clicks: 0, spendCents: 0, ctr: 0, avgCpcCents: null })

    const keywords = await inA(() => googleAdsKeywords({ connectionId: connA, ...W }, RUN))
    expect(keywords).toMatchObject({ total: 2, read: { readAt: expect.any(String) }, numbersRead: { readAt: expect.any(String) } })
    expect(keywords.items.map((k) => [k.text, k.matchType, k.qualityScore, k.status, k.adGroupId, k.adGroupName, k.cpcBidCents, k.effectiveCpcBidCents])).toEqual([
      ['test helmet', 'PHRASE', 7, 'ENABLED', nexus['71111111111'], 'Test helmets', 70, 70],
      ['test full face helmet', 'EXACT', null, 'PAUSED', nexus['71111111111'], 'Test helmets', null, 65],
    ])
    expect(keywords.items[0]).toMatchObject({ servingStatus: 'ELIGIBLE', approvalStatus: 'APPROVED', settingsReadAt: expect.any(String) })
    expect(keywords.items[0].metrics).toMatchObject({ impressions: 700, clicks: 25, spendCents: 1750, conversions: 1.5, conversionValueCents: 12000 })
    expect(keywords.items[1].metrics).toMatchObject({ impressions: 40, clicks: 2, spendCents: 130 })
    // By ad group (Nexus's id) and by campaign (the step-1a `<customerId>~<googleCampaignId>` id works too).
    expect((await inA(() => googleAdsKeywords({ adGroupId: nexus['71111111111'], ...W }, RUN))).total).toBe(2)
    expect((await inA(() => googleAdsKeywords({ campaignId: `${CID}~22222222222`, ...W }, RUN))).total).toBe(0)
  })

  it('R7 negatives — ad group, campaign (a brand list among them) and list keywords with the list\'s name', async () => {
    const all = await inA(() => googleAdsNegatives({ connectionId: connA }))
    expect(all.read).toMatchObject({ adGroup: { readAt: expect.any(String) }, campaign: { readAt: expect.any(String) }, lists: { readAt: expect.any(String) } })
    expect(all.items.map((n) => [n.level, n.kind, n.text, n.matchType, n.campaignName, n.adGroupName, n.listName])).toEqual([
      ['ad_group', 'keyword', 'test cheap', 'BROAD', 'Test search campaign', 'Test helmets', null],
      ['campaign', 'brand_list', null, null, 'Test performance max campaign', null, null],
      ['campaign', 'keyword', 'test used', 'PHRASE', 'Test search campaign', null, null],
      ['list', 'keyword', 'test free', 'BROAD', null, null, 'Test negative list'],
      ['list', 'keyword', 'test repair manual', 'PHRASE', null, null, 'Test negative list'],
      ['list', 'keyword', 'test second hand', 'EXACT', null, null, 'Test account negatives'],
    ])
    const campaignList = all.lists.find((l) => l.externalListId === '66666666666')!
    expect(all.items.find((n) => n.text === 'test free')!.listId).toBe(campaignList.listId)
    expect(all.lists).toEqual([
      // The account-level list, in force: a customer_negative_criterion of the account points at it (never a campaign).
      expect.objectContaining({ externalListId: '77777777777', name: 'Test account negatives', status: 'ENABLED', memberCount: 1, accountLevel: true, appliesToAccount: true, campaigns: [] }),
      expect.objectContaining({
        externalListId: '66666666666', name: 'Test negative list', status: 'ENABLED', memberCount: 2, accountLevel: false, appliesToAccount: false,
        campaigns: [
          { campaignId: nexus['11111111111'], externalCampaignId: '11111111111', name: 'Test search campaign' },
          { campaignId: nexus['33333333333'], externalCampaignId: '33333333333', name: 'Test shopping campaign' },
        ],
      }),
    ])
    // One campaign (M8): its ad groups' negatives, its own, the lists attached to it — and the account-level list.
    const search = await inA(() => googleAdsNegatives({ campaignId: nexus['11111111111'] }))
    expect(search.items.map((n) => `${n.level}:${n.text}`)).toEqual(['ad_group:test cheap', 'campaign:test used', 'list:test free', 'list:test repair manual', 'list:test second hand'])
    const pmax = await inA(() => googleAdsNegatives({ campaignId: nexus['22222222222'] }))
    expect(pmax.items.map((n) => `${n.level}:${n.kind}:${n.text}`)).toEqual(['campaign:brand_list:null', 'list:keyword:test second hand'])
    expect(pmax.lists.map((l) => [l.name, l.appliesToAccount])).toEqual([['Test account negatives', true]])
  })

  it('R8 search terms and R9 brand split — the business\'s protected terms split them; the rest is "not in the list"', async () => {
    const terms = await inA(() => googleAdsSearchTerms({ connectionId: connA, ...W }, RUN))
    expect(terms).toMatchObject({ scope: 'terms_with_clicks', read: { readAt: expect.any(String) }, brandTerms: { terms: ['helmet'], source: 'protected_terms' } })
    expect(terms.items.map((t) => [t.term, t.brand, t.campaignId, t.campaignName, t.campaignType, t.metrics.clicks, t.metrics.spendCents])).toEqual([
      ['test helmet', true, nexus['11111111111'], 'Test search campaign', 'SEARCH', 8, 560],
      ['test gloves winter', false, nexus['22222222222'], 'Test performance max campaign', 'PERFORMANCE_MAX', 1, 60],
    ])
    expect(terms.items[0].metrics).toMatchObject({ impressions: 60, conversions: 1.5, conversionValueCents: 9950 })
    expect((await inA(() => googleAdsSearchTerms({ brand: 'non_brand', ...W }, RUN))).items.map((t) => t.term)).toEqual(['test gloves winter'])

    const split = await inA(() => googleAdsBrandSplit({ connectionId: connA, ...W }, RUN))
    expect(split.coverage).toMatchObject({ daysInWindow: 12, daysRead: 12 })
    for (const row of split.rows) {
      expect(row.brand).not.toBeNull()
      expect(row.nonBrand).not.toBeNull()
    }
    const by = Object.fromEntries(split.rows.map((r) => [r.campaignType, r]))
    // All: the campaigns (one seen only in the numbers) 31.88; brand 5.60; other terms 0.60; not in the list 25.68.
    expect([by.ALL.total!.spendCents, by.ALL.brand!.spendCents, by.ALL.nonBrand!.spendCents, by.ALL.notInSearchTerms!.spendCents]).toEqual([3188, 560, 60, 2568])
    expect([by.SEARCH.total!.spendCents, by.SEARCH.brand!.spendCents, by.SEARCH.nonBrand!.spendCents, by.SEARCH.notInSearchTerms!.spendCents]).toEqual([3145, 560, 0, 2585])
    expect([by.PERFORMANCE_MAX.brand!.clicks, by.PERFORMANCE_MAX.nonBrand!.clicks]).toEqual([0, 1])
  })

  it('R10 asset groups and R11 products — numbers of the read days; a product joins its status by item id, whatever the case', async () => {
    const groups = await inA(() => googleAdsAssetGroups({ connectionId: connA, ...W }, RUN))
    expect(groups.items).toEqual([expect.objectContaining({
      name: 'Test asset group', status: 'ENABLED', campaignId: nexus['22222222222'], campaignType: 'PERFORMANCE_MAX', adStrength: 'GOOD',
      finalUrls: ['https://shop.example.com/helmets'], primaryStatusReasons: ['ASSET_GROUP_UNDER_REVIEW'], settingsReadAt: expect.any(String),
    })])
    expect(groups.read.readAt).not.toBeNull()
    expect(groups.items[0].metrics).toMatchObject({ impressions: 2500, clicks: 41, spendCents: 1900, conversions: 3, conversionValueCents: 24075 })

    const products = await inA(() => googleAdsProducts({ connectionId: connA, ...W }, RUN))
    expect(products).toMatchObject({ numbersRead: { readAt: expect.any(String) }, statusRead: { readAt: expect.any(String) }, total: 2 })
    expect(products.items.map((p) => [p.productKey, p.itemId, p.title, p.campaignId, p.campaignType, p.status])).toEqual([
      ['33333333333~test-sku-1', 'test-sku-1', 'Test helmet, size M', nexus['33333333333'], 'SHOPPING', 'not_eligible'],
      ['22222222222~test-sku-2', 'test-sku-2', 'Test gloves', nexus['22222222222'], 'PERFORMANCE_MAX', 'limited'],
    ])
    const [helmet, gloves] = products.items
    expect(helmet.metrics).toMatchObject({ impressions: 320, clicks: 10, spendCents: 500, conversions: 1, conversionValueCents: 8990 })
    expect(gloves.metrics).toMatchObject({ impressions: 75, clicks: 0, spendCents: 0 })
    expect(helmet.issues).toEqual([{
      code: 'missing_gtin', severity: 'NOT_ELIGIBLE', text: 'Missing value [gtin]', explanation: 'Add a GTIN for this product.',
      helpUrl: 'https://support.example.com/gtin', regions: ['IT'],
    }])
    expect(gloves.issues).toEqual([{ code: 'image_too_small', severity: 'DEMOTED', text: 'Image too small', explanation: null, helpUrl: null, regions: ['IT', 'SM'] }])
    expect(helmet.nexusProduct).toEqual({ productId: 'gads-e2e-prod-a', sku: 'Test-SKU-1', name: 'Test helmet product' })
    expect(gloves.nexusProduct).toBeNull()
    expect((await inA(() => googleAdsProducts({ issue: 'not_eligible', ...W }, RUN))).items.map((p) => p.itemId)).toEqual(['test-sku-1'])
    expect((await inA(() => googleAdsProducts({ campaignId: nexus['22222222222'], ...W }, RUN))).items.map((p) => p.itemId)).toEqual(['test-sku-2'])

    // Days with no product numbers: Google's product status names no campaign (shopping_product has none), so a product
    // the campaign advertised and Google no longer shows still belongs to that campaign — in R11 as in R15.
    const quiet = { from: '2026-09-13', to: '2026-10-11' }
    const inShopping = await inA(() => googleAdsProducts({ campaignId: nexus['33333333333'], ...quiet }, RUN))
    expect(inShopping.items.map((p) => [p.productKey, p.status, p.campaignId, p.campaignName, p.metrics?.spendCents])).toEqual([
      ['5555555555~ONLINE~it~IT~test-sku-1', 'not_eligible', nexus['33333333333'], 'Test shopping campaign', 0],
    ])
    const issuesInShopping = await inA(() => googleAdsDisapprovals({ campaignId: nexus['33333333333'], kind: 'product' }))
    expect(issuesInShopping.products.map((p) => p.productKey)).toEqual(inShopping.items.map((p) => p.productKey))
    // Not a product of the search campaign; across the account it names no campaign.
    expect((await inA(() => googleAdsProducts({ campaignId: nexus['11111111111'], ...quiet }, RUN))).items).toEqual([])
    // (equal spend: by title)
    expect((await inA(() => googleAdsProducts({ ...quiet }, RUN))).items.map((p) => [p.itemId, p.campaignId])).toEqual([['test-sku-2', null], ['test-sku-1', null]])
  })

  it('R12 acts on its own — flags of every read campaign, the enabled auto-apply, the changes without a person', async () => {
    const acts = await inA(() => googleAdsActsOnItsOwn({ connectionId: connA }, RUN))
    for (const r of Object.values(acts.read)) expect(r.readAt).not.toBeNull()
    expect(acts.autoApply).toEqual({
      enabled: [{ type: 'KEYWORD', typeText: 'Add keywords', since: '2026-09-01T08:00:00.000Z', changedAt: '2026-09-15T07:30:00.000Z' }],
      paused: [{ type: 'CAMPAIGN_BUDGET', typeText: 'Raise the budget', since: '2026-08-20T06:00:00.000Z', changedAt: null }],
    })
    const by = Object.fromEntries(acts.campaigns.map((c) => [c.externalCampaignId, c]))
    expect(acts.campaigns.map((c) => c.name)).toEqual(['Test performance max campaign', 'Test search campaign', 'Test shopping campaign'])
    for (const c of acts.campaigns) {
      expect(c.flagsReadAt).not.toBeNull()
      for (const flag of [c.aiMax, c.campaignBroadMatch, c.searchPartners, c.displayExpansion, c.finalUrlExpansion, c.textCustomization, c.dynamicSearchAds]) expect(flag).not.toBeNull()
      expect(c.brandExclusions).not.toBeNull()
      expect(c.adGroupsWithoutSearchTermMatching).not.toBeNull()
    }
    expect(by['11111111111']).toMatchObject({
      campaignId: nexus['11111111111'], type: 'SEARCH', status: 'ENABLED', aiMax: 'on', campaignBroadMatch: 'on', searchPartners: 'on', displayExpansion: 'off',
      finalUrlExpansion: 'on', finalUrlExpansionByDefault: false, textCustomization: 'off', dynamicSearchAds: 'on', brandExclusions: 0,
      adGroupsWithoutSearchTermMatching: 1, movedToAiMaxAt: '2026-10-01T10:00:00.000Z',
    })
    expect(by['22222222222']).toMatchObject({ aiMax: 'not_applicable', finalUrlExpansion: 'on', finalUrlExpansionByDefault: true, textCustomization: 'on', brandExclusions: 1 })
    expect(by['33333333333']).toMatchObject({ type: 'SHOPPING', searchPartners: 'off', aiMax: 'not_applicable' })
    expect(acts.outsideChanges).toMatchObject({ nexusWrites: 0, coveredFrom: expect.any(String), coveredThrough: expect.any(String) })
    // Newest first.
    expect(acts.outsideChanges.items.map((c) => [c.campaignName, c.resourceType, c.source, c.who, c.watched])).toEqual([
      ['Test search campaign', 'AD_GROUP_CRITERION', 'google_ads_editor', 'person', false],
      ['Test performance max campaign', 'CAMPAIGN', 'google_ads_web', 'person', true],
      ['Test search campaign', 'CAMPAIGN_BUDGET', 'google_automatic', 'google_auto_apply', true],
    ])
    expect(JSON.stringify(acts)).not.toMatch(/test\.person@example\.com/)
  })

  it('R12 when Google refused asset_automation_settings (A\'s NOT VERIFIED fallback): those two flags are "not read", never Google\'s default', async () => {
    const flagRows = page('search-campaign-flags.json').results as GoogleAdsCampaignFlagsRow[]
    const save = (assetAutomationRead: boolean, at: Date) => inA(() => saveCampaignFlags(CID,
      flagRows.map((row) => mapCampaignFlags(row, { timeZone: 'Europe/Rome', assetAutomationRead })).filter((f) => f !== null), at))
    await save(false, new Date('2026-10-13T07:00:00Z'))
    try {
      const by = Object.fromEntries((await inA(() => googleAdsActsOnItsOwn({ connectionId: connA }, RUN))).campaigns.map((c) => [c.externalCampaignId, c]))
      expect(by['11111111111']).toMatchObject({ aiMax: 'on', searchPartners: 'on', finalUrlExpansion: null, finalUrlExpansionByDefault: false, textCustomization: null })
      expect(by['22222222222']).toMatchObject({ aiMax: 'not_applicable', finalUrlExpansion: null, finalUrlExpansionByDefault: false, textCustomization: null })
      expect(by['33333333333']).toMatchObject({ finalUrlExpansion: 'not_applicable', textCustomization: 'not_applicable' })
    } finally {
      await save(true, RUN)
    }
  })

  it('R13 recommendations — the open ones only; Google\'s estimate in cents from micros (a string) and currency units', async () => {
    const recs = await inA(() => googleAdsRecommendations({ connectionId: connA }))
    expect(recs).toMatchObject({ read: { readAt: expect.any(String) }, currency: 'EUR', writes: { mode: 'none' }, byType: [{ type: 'KEYWORD', typeText: 'Add keywords', count: 1 }] })
    expect(recs.items).toEqual([{
      recommendationId: 'test-rec-1', type: 'KEYWORD', typeText: 'Add keywords', explanation: 'Google suggests new keywords for this campaign.',
      campaignId: nexus['11111111111'], externalCampaignId: '11111111111', campaignName: 'Test search campaign', adGroupName: 'Test helmets', autoApplied: true,
      impact: {
        // costMicros "28000000" → 2800 cents; conversionsValue 180 (EUR) → 18000 cents.
        base: { impressions: 1000, clicks: 40, spendCents: 2800, conversions: 2, conversionValueCents: 18000 },
        potential: { impressions: 1300, clicks: 52, spendCents: 3600, conversions: 2.6, conversionValueCents: 23400 },
      },
    }])
    expect((await inA(() => googleAdsRecommendations({ campaignId: nexus['33333333333'] }))).items).toEqual([])
  })

  it('R14 alerts and R15 disapprovals — what the run stored, in Nexus\'s ids, with no amount in the words', async () => {
    const alerts = await inA(() => googleAdsAlerts({ connectionId: connA }, RUN))
    expect(alerts.checkedAt).toBe(RUN.toISOString())
    expect(alerts.notChecked).toEqual([])
    expect(alerts.items.map((a) => [a.kind, a.severity, a.campaignId])).toEqual([
      ['ads_disapproved', 'danger', nexus['11111111111']],
      ['products_not_eligible', 'warn', null],
      ['auto_apply_on', 'warn', null],
      ['changed_by_google', 'warn', null],
      ['moved_to_ai_max', 'warn', nexus['11111111111']],
      ['ads_limited', 'info', nexus['11111111111']],
      ['settings_changed', 'info', null],
    ])
    for (const a of alerts.items) {
      expect(`${a.title} ${a.body}`).not.toMatch(/€|EUR|\d+[.,]\d{2}\b/)
      for (const value of Object.values(a.numbers ?? {})) if (value != null && value >= 100) expect(`${a.title} ${a.body}`).not.toContain(String(value))
    }

    const issues = await inA(() => googleAdsDisapprovals({ connectionId: connA }))
    expect(issues.read.ads.readAt).not.toBeNull()
    expect(issues.read.products.readAt).not.toBeNull()
    expect(issues.truncated).toBe(false)
    expect(issues.ads.map((ad) => [ad.externalAdId, ad.adType, ad.status, ad.campaignId, ad.campaignName, ad.adGroupId, ad.adGroupName, ad.reasons])).toEqual([
      ['81111111111', 'RESPONSIVE_SEARCH_AD', 'DISAPPROVED', nexus['11111111111'], 'Test search campaign', nexus['71111111111'], 'Test helmets', ['DESTINATION_NOT_WORKING']],
      ['81111111112', 'RESPONSIVE_SEARCH_AD', 'APPROVED_LIMITED', nexus['11111111111'], 'Test search campaign', nexus['71111111111'], 'Test helmets', ['TRADEMARKS_IN_AD_TEXT']],
    ])
    expect(issues.products.map((p) => [p.productKey, p.itemId, p.title, p.status, p.issues.map((i) => i.code)])).toEqual([
      ['5555555555~ONLINE~it~IT~test-sku-1', 'test-sku-1', 'Test helmet, size M', 'not_eligible', ['missing_gtin']],
      ['5555555555~ONLINE~it~IT~test-sku-2', 'test-sku-2', 'Test gloves', 'limited', ['image_too_small']],
    ])
    // A campaign's products: the issue names no campaign, the campaign advertised the item.
    expect((await inA(() => googleAdsDisapprovals({ campaignId: nexus['33333333333'], kind: 'product' }))).products.map((p) => p.itemId)).toEqual(['test-sku-1'])
  })

  it('business B: A\'s campaign is not found, A\'s sign-in is not found, and every list holds nothing of A\'s', async () => {
    const campaign = nexus['11111111111']
    for (const read of [
      () => googleAdsAdGroups({ campaignId: campaign, ...W }, RUN), () => googleAdsKeywords({ campaignId: campaign, ...W }, RUN),
      () => googleAdsNegatives({ campaignId: campaign }), () => googleAdsSearchTerms({ campaignId: campaign, ...W }, RUN),
      () => googleAdsAssetGroups({ campaignId: campaign, ...W }, RUN), () => googleAdsProducts({ campaignId: campaign, ...W }, RUN),
      () => googleAdsRecommendations({ campaignId: campaign }), () => googleAdsDisapprovals({ campaignId: campaign }),
      () => googleAdsKeywords({ campaignId: `${CID}~11111111111`, ...W }, RUN),
    ]) {
      await expect(inB(read)).rejects.toMatchObject({ status: 404, message: 'Campaign not found' })
    }
    await expect(inB(() => googleAdsKeywords({ adGroupId: nexus['71111111111'], ...W }, RUN))).rejects.toMatchObject({ status: 404, message: 'Ad group not found' })
    await expect(inB(() => googleAdsAlerts({ connectionId: connA }, RUN))).rejects.toMatchObject({ status: 404, message: 'Google account not found' })

    const pages = await inB(async () => ({
      overview: await googleAdsOverview({ ...W }, RUN),
      adGroups: await googleAdsAdGroups({ ...W }, RUN), keywords: await googleAdsKeywords({ ...W }, RUN), negatives: await googleAdsNegatives({}),
      terms: await googleAdsSearchTerms({ ...W }, RUN), split: await googleAdsBrandSplit({ ...W }, RUN), assetGroups: await googleAdsAssetGroups({ ...W }, RUN),
      products: await googleAdsProducts({ ...W }, RUN), acts: await googleAdsActsOnItsOwn({}, RUN), recs: await googleAdsRecommendations({}),
      alerts: await googleAdsAlerts({}, RUN), issues: await googleAdsDisapprovals({}),
    }))
    expect(pages.overview.account?.connectionId).toBe(connB)
    expect(pages.overview.reads.every((r) => r.readAt === null)).toBe(true)
    for (const list of [pages.adGroups, pages.keywords, pages.negatives, pages.terms, pages.assetGroups, pages.products]) expect(list).toMatchObject({ items: [], total: 0 })
    expect(pages.negatives.lists).toEqual([])
    expect(pages.terms.brandTerms.terms).toEqual([])
    expect(pages.split.rows.every((r) => r.total === null && r.brand === null)).toBe(true)
    expect(pages.acts).toMatchObject({ autoApply: null, campaigns: [], outsideChanges: { items: [] } })
    expect(pages.recs.items).toEqual([])
    expect(pages.alerts.items).toEqual([])
    expect(pages.issues).toMatchObject({ ads: [], products: [] })
    expect(JSON.stringify(pages)).not.toMatch(A_TRACES)
  })
})

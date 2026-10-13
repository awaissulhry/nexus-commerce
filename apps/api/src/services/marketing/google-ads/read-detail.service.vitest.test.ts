/**
 * Google Ads step 1b — the reads below the campaign (R5–R15) and the bell, on a real PostgreSQL with the production
 * schema and every business policy (PGlite), business profiles ON. The business's Google sign-ins are stubbed; every
 * answer comes from the GoogleAds* tables (and AdKeywordProtection, Product, Notification).
 *
 * Proven here: numbers count only the days read AT THAT GRAIN (a day outside is "not read", never 0); money is in
 * minor units; a row seen only in the numbers is still listed; a part never read is `readAt: null`; brand comes from
 * the protected terms for every market (none → null, never false); the brand split adds up; products match a Nexus SKU
 * exactly, case aside; Google's estimates and the alerts' money stay out of the text; the bell rings once per
 * occurrence and never names an amount; and another business sees none of it. Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace, workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { InvalidCursorError } from '../../../lib/pagination/cursor.js'

const mocks = vi.hoisted(() => ({ accounts: {} as Record<string, unknown[]> }))
vi.mock('../../google/google-accounts.service.js', () => ({ listGoogleAccounts: async () => mocks.accounts[workspaceIdForQuery()] ?? [] }))
vi.mock('./enqueue.js', () => ({ enqueueGoogleAdsSync: async () => ({ queued: false, reason: 'test' }) }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

import { googleAdsOverview, keysetPage } from './read.service.js'
import {
  googleAdsAdGroups,
  googleAdsAssetGroups,
  googleAdsDisapprovals,
  googleAdsKeywords,
  googleAdsNegatives,
  googleAdsProducts,
  productIssueTexts,
  searchTermMatchingFlag,
} from './read-detail.service.js'
import { googleAdsBrandSplit, googleAdsSearchTerms } from './read-search-terms.service.js'
import { campaignAutomation, googleAdsActsOnItsOwn, googleAdsRecommendations, impactOf, recommendationWords } from './read-acts.service.js'
import { googleAdsAlerts, raiseGoogleAdsAlerts } from './alerts.service.js'
import { BRAND_TERMS_HREF, googleBrandOf } from './brand.js'
import { GOOGLE_READ_RESOURCES } from './read-types.js'

const A = 'gads_detail_alpha'
const B = 'gads_detail_bravo'
const NONE = 'gads_detail_none'
const OWNER = 'gads-detail-owner'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const inNone = <T>(work: () => Promise<T>) => withWorkspace(scope(NONE), work)
const db = () => database.client
const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)
/** 08:30 in Rome on 13 Oct: the account's yesterday is 12 Oct. */
const NOW = new Date('2026-10-13T06:30:00Z')
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`)
const SEEN = new Date('2026-10-12T06:00:00Z')
const ids: Record<string, string> = {}
const WINDOW = { from: '2026-10-01', to: '2026-10-13' }

const A_CUSTOMER = '1234567890'
const B_CUSTOMER = '5550001112'

function googleAccount(connectionId: string, customerId: string) {
  return {
    connectionId, label: 'Test Google sign-in', state: 'ok', stateText: 'Nexus reads this account once a day.', authStatus: 'connected', missingProducts: [],
    ads: { customerId, name: 'Test advertiser', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false },
    manager: null, merchantCenter: null, analytics: null,
    read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastError: null },
  }
}

type Metric = { type: string; entityId: string; campaignId: string; date: string; cost: number; clicks?: number; impressions?: number; conversions?: string; value?: number; label?: string; adGroupId?: string }
const metric = (customerId: string, m: Metric) => db().googleAdsDailyMetric.create({
  data: {
    customerId, date: day(m.date), entityType: m.type, entityId: m.entityId, campaignId: m.campaignId, adGroupId: m.adGroupId ?? null, label: m.label ?? null,
    impressions: m.impressions ?? 0, clicks: m.clicks ?? 0, costMicros: BigInt(m.cost), conversions: m.conversions ?? '0', conversionsValueMicros: BigInt(m.value ?? 0),
    currencyCode: 'EUR', pulledAt: SEEN,
  },
})
const state = (customerId: string, resource: string, extra: Record<string, unknown> = {}) =>
  db().googleAdsReadState.create({ data: { customerId, resource, readAt: SEEN, lastAttemptAt: SEEN, lastStatus: 'SUCCESS', ...extra } as never })

async function seedA() {
  await inA(async () => {
    await db().googleAdsCustomer.create({
      data: {
        connectionId: 'conn-a', customerId: A_CUSTOMER, currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED',
        metricsReadFrom: day('2026-08-01'), metricsReadThrough: day('2026-10-12'), lastSuccessAt: SEEN,
        changesSyncedThrough: new Date('2026-10-13T06:00:00Z'), structureSyncedAt: SEEN,
      },
    })
    const campaign = (campaignId: string, name: string, extra: Record<string, unknown>) =>
      db().googleAdsCampaign.create({ data: { customerId: A_CUSTOMER, campaignId, name, status: 'ENABLED', channelType: 'SEARCH', currencyCode: 'EUR', lastSeenAt: SEEN, ...extra } as never })
    ids.c1 = (await campaign('111', 'Alpha search', {
      budgetAmountMicros: 10_000_000n, flagsReadAt: SEEN, aiMaxEnabled: true, keywordMatchType: 'BROAD', targetSearchNetwork: true, targetContentNetwork: false,
      assetAutomation: [{ assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' }],
      broadMatchMigratedAt: new Date('2026-10-01T08:00:00Z'),
    })).id
    ids.c2 = (await campaign('222', 'Bravo shopping', { channelType: 'SHOPPING', budgetAmountMicros: 5_000_000n, flagsReadAt: SEEN })).id
    // Read, and Google listed no asset automation entry (the read stores []; null would be "not read").
    ids.c3 = (await campaign('333', 'Charlie max', { channelType: 'PERFORMANCE_MAX', flagsReadAt: SEEN, assetAutomation: [] })).id

    for (const resource of ['AD_GROUPS', 'KEYWORDS', 'CAMPAIGN_NEGATIVES', 'NEGATIVE_LISTS', 'ASSET_GROUPS', 'CAMPAIGN_SETTINGS', 'AD_POLICY', 'PRODUCT_STATUS', 'AUTO_APPLY', 'RECOMMENDATIONS']) {
      await state(A_CUSTOMER, resource)
    }
    for (const resource of ['AD_GROUP_DAYS', 'KEYWORD_DAYS', 'ASSET_GROUP_DAYS', 'PRODUCT_DAYS']) {
      await state(A_CUSTOMER, resource, { readFrom: day('2026-10-01'), readThrough: day('2026-10-10') })
    }
    await state(A_CUSTOMER, 'SEARCH_TERM_DAYS', { readFrom: day('2026-10-05'), readThrough: day('2026-10-10') })

    // Ad groups.
    const adGroup = (adGroupId: string, campaignId: string, name: string, extra: Record<string, unknown> = {}) =>
      db().googleAdsAdGroup.create({ data: { customerId: A_CUSTOMER, campaignId, adGroupId, name, status: 'ENABLED', lastSeenAt: SEEN, ...extra } as never })
    ids.ag1 = (await adGroup('901', '111', 'Ad group one', { type: 'SEARCH_STANDARD', cpcBidMicros: 1_234_000n, targetRoas: '4.5', searchTermMatchingDisabled: true })).id
    ids.ag2 = (await adGroup('902', '111', 'ad group two', { status: 'PAUSED', searchTermMatchingDisabled: false })).id
    ids.ag3 = (await adGroup('903', '222', 'Shop group')).id
    await metric(A_CUSTOMER, { type: 'AD_GROUP', entityId: '901', campaignId: '111', adGroupId: '901', date: '2026-10-05', impressions: 100, clicks: 10, cost: 2_000_000, conversions: '1', value: 5_000_000 })
    await metric(A_CUSTOMER, { type: 'AD_GROUP', entityId: '901', campaignId: '111', adGroupId: '901', date: '2026-10-11', impressions: 999, clicks: 99, cost: 99_000_000 }) // not read at this grain
    await metric(A_CUSTOMER, { type: 'AD_GROUP', entityId: '999', campaignId: '111', adGroupId: '999', date: '2026-10-06', impressions: 10, clicks: 1, cost: 1_000_000, label: 'Old group' })

    // Keywords and negatives.
    const keyword = (level: string, parentKey: string, criterionId: string, extra: Record<string, unknown>) =>
      db().googleAdsKeyword.create({ data: { customerId: A_CUSTOMER, level, parentKey, criterionId, negative: false, criterionType: 'KEYWORD', lastSeenAt: SEEN, ...extra } as never })
    ids.kw1 = (await keyword('AD_GROUP', 'ag:901', '5001', { campaignId: '111', adGroupId: '901', text: 'blue shoes', matchType: 'EXACT', status: 'ENABLED', qualityScore: 7, cpcBidMicros: 500_000n })).id
    ids.kw2 = (await keyword('AD_GROUP', 'ag:901', '5002', { campaignId: '111', adGroupId: '901', text: 'red shoes', matchType: 'PHRASE', status: 'ENABLED' })).id
    ids.neg1 = (await keyword('AD_GROUP', 'ag:901', '5003', { campaignId: '111', adGroupId: '901', negative: true, text: 'cheap', matchType: 'BROAD', status: 'ENABLED' })).id
    ids.neg2 = (await keyword('CAMPAIGN', 'c:111', '6001', { campaignId: '111', negative: true, text: 'free', matchType: 'EXACT', status: 'ENABLED' })).id
    ids.neg3 = (await keyword('CAMPAIGN', 'c:333', '6002', { campaignId: '333', negative: true, criterionType: 'BRAND_LIST', status: 'ENABLED' })).id
    ids.neg4 = (await keyword('LIST', 'l:700', '7001', { sharedSetId: '700', negative: true, text: 'used', matchType: 'PHRASE' })).id
    await keyword('CAMPAIGN', 'c:111', '6003', { campaignId: '111', negative: true, text: 'gone negative', matchType: 'EXACT', status: 'ENABLED', removedAt: SEEN })
    ids.list = (await db().googleAdsNegativeList.create({ data: { customerId: A_CUSTOMER, sharedSetId: '700', name: 'Shared negatives', status: 'ENABLED', memberCount: 1, listType: 'NEGATIVE_KEYWORDS', appliesToAccount: false, campaignIds: ['111'], lastSeenAt: SEEN } })).id
    await metric(A_CUSTOMER, { type: 'KEYWORD', entityId: '901~5001', campaignId: '111', adGroupId: '901', date: '2026-10-05', clicks: 5, cost: 3_000_000 })
    await metric(A_CUSTOMER, { type: 'KEYWORD', entityId: '901~5002', campaignId: '111', adGroupId: '901', date: '2026-10-06', clicks: 2, cost: 1_000_000 })
    await metric(A_CUSTOMER, { type: 'KEYWORD', entityId: '901~5099', campaignId: '111', adGroupId: '901', date: '2026-10-07', clicks: 1, cost: 500_000, label: 'gone keyword' })

    // Asset groups.
    ids.asset = (await db().googleAdsAssetGroup.create({ data: { customerId: A_CUSTOMER, campaignId: '333', assetGroupId: '801', name: 'Asset group one', status: 'ENABLED', adStrength: 'GOOD', finalUrls: ['https://shop.example.test/'], lastSeenAt: SEEN } })).id
    await metric(A_CUSTOMER, { type: 'ASSET_GROUP', entityId: '801', campaignId: '333', date: '2026-10-06', impressions: 400, clicks: 8, cost: 4_000_000 })

    // Products, their issues, and the Nexus product with the same SKU.
    await metric(A_CUSTOMER, { type: 'PRODUCT', entityId: '222~sku-abc', campaignId: '222', date: '2026-10-06', clicks: 3, cost: 2_500_000, label: 'Test jacket' })
    await metric(A_CUSTOMER, { type: 'PRODUCT', entityId: '333~SKU-ZZZ', campaignId: '333', date: '2026-10-07', clicks: 1, cost: 1_000_000, label: 'Test helmet' })
    const issue = (kind: string, entityKey: string, extra: Record<string, unknown>) =>
      db().googleAdsPolicyIssue.create({ data: { customerId: A_CUSTOMER, kind, entityKey, lastSeenAt: SEEN, firstSeenAt: new Date('2026-10-09T06:00:00Z'), ...extra } as never })
    await issue('AD', '901~4001', { campaignId: '111', adGroupId: '901', adId: '4001', adType: 'RESPONSIVE_SEARCH_AD', status: 'DISAPPROVED', reviewStatus: 'REVIEWED', reasons: ['DESTINATION_NOT_WORKING'] })
    await issue('AD', '901~4002', { campaignId: '111', adGroupId: '901', adId: '4002', status: 'APPROVED_LIMITED', reasons: ['TRADEMARKS'] })
    await issue('AD', '901~4003', { campaignId: '111', adGroupId: '901', adId: '4003', status: 'DISAPPROVED', resolvedAt: SEEN })
    await issue('PRODUCT', '42~ONLINE~en~IT~sku-abc', {
      itemId: 'sku-abc', label: 'Test jacket', status: 'ELIGIBLE_LIMITED',
      issues: [{ errorCode: 'missing_gtin', adsSeverity: 'DEMOTED', description: 'Missing GTIN', detail: 'Add a GTIN.', documentation: 'https://support.example.test/1', affectedRegions: ['IT'] }],
    })
    await issue('PRODUCT', '42~ONLINE~en~DE~sku-nope', { itemId: 'sku-nope', label: 'Test gloves', status: 'NOT_ELIGIBLE', issues: [{ errorCode: 'policy', adsSeverity: 'NOT_ELIGIBLE', description: 'Not allowed' }] })
    await issue('PRODUCT', '42~ONLINE~en~AT~sku-nope', { itemId: 'sku-nope', label: 'Test gloves', status: 'NOT_ELIGIBLE', issues: [] })

    // Google's recommendations and auto-apply.
    const recommendation = (n: string, type: string, extra: Record<string, unknown>) =>
      db().googleAdsRecommendation.create({ data: { customerId: A_CUSTOMER, resourceName: `customers/${A_CUSTOMER}/recommendations/${n}`, type, dismissed: false, readAt: SEEN, ...extra } as never })
    await recommendation('rec-a', 'KEYWORD', {
      campaignId: '111', adGroupId: '901',
      impact: { baseMetrics: { impressions: 100, clicks: 10, costMicros: '2000000', conversions: 1, conversionsValue: 12.5 }, potentialMetrics: { impressions: 150, clicks: 15, costMicros: '3000000', conversions: 2, conversionsValue: 20 } },
    })
    await recommendation('rec-b', 'CAMPAIGN_BUDGET', { campaignId: '222' })
    await recommendation('rec-c', 'SOMETHING_NEW_FROM_GOOGLE', {})
    await recommendation('rec-d', 'KEYWORD', { campaignId: '111', dismissed: true })
    await db().googleAdsAutoApply.create({ data: { customerId: A_CUSTOMER, type: 'KEYWORD', status: 'ENABLED', createdAtGoogle: new Date('2026-09-01T10:00:00Z'), lastSeenAt: SEEN } })
    await db().googleAdsAutoApply.create({ data: { customerId: A_CUSTOMER, type: 'TARGET_CPA_OPT_IN', status: 'PAUSED', lastSeenAt: SEEN } })

    // Changes made outside Nexus (with the person's e-mail, which is never answered).
    const change = (n: number, changedAt: string, extra: Record<string, unknown>) =>
      db().googleAdsChangeEvent.create({
        data: { customerId: A_CUSTOMER, resourceName: `customers/${A_CUSTOMER}/changeEvents/${n}~0~0`, changedAt: new Date(changedAt), resourceType: 'CAMPAIGN', changeResourceName: `customers/${A_CUSTOMER}/campaigns/111`, operation: 'UPDATE', campaignId: '111', userEmail: 'test.person@example.test', ...extra } as never,
      })
    await change(1, '2026-10-12T10:00:00Z', { clientType: 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION', changedFields: ['keyword_match_type'] })
    await change(2, '2026-10-11T10:00:00Z', { clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'CAMPAIGN_BUDGET', changedFields: ['amount_micros'] })
    await change(3, '2026-10-10T10:00:00Z', { clientType: 'GOOGLE_ADS_SCRIPTS', resourceType: 'AD_GROUP_CRITERION', changedFields: ['cpc_bid_micros'] })

    // Campaign days for the alerts: Alpha spent fast yesterday and stopped converting; Bravo spent fast this month.
    const day_ = (campaignId: string, date: string, cost: number, clicks: number, conversions = '0') =>
      metric(A_CUSTOMER, { type: 'CAMPAIGN', entityId: campaignId, campaignId, date, cost, clicks, conversions })
    await day_('111', '2026-09-20', 3_000_000, 10, '4')
    await day_('111', '2026-10-10', 5_000_000, 25)
    await day_('111', '2026-10-12', 16_000_000, 5)
    await day_('222', '2026-10-03', 80_000_000, 40, '2')

    // Brand: a protected term for every market, and one for one market only (not Google's).
    await db().adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'acme', matchType: 'CONTAINS', marketplace: null } })
    await db().adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'running', matchType: 'CONTAINS', marketplace: 'IT' } })
    await metric(A_CUSTOMER, { type: 'SEARCH_TERM', entityId: '111~h1', campaignId: '111', date: '2026-10-06', clicks: 2, impressions: 20, cost: 1_000_000, label: 'acme shoes' })
    await metric(A_CUSTOMER, { type: 'SEARCH_TERM', entityId: '111~h2', campaignId: '111', date: '2026-10-07', clicks: 3, impressions: 30, cost: 2_000_000, label: 'running shoes' })
    await metric(A_CUSTOMER, { type: 'SEARCH_TERM', entityId: '333~h3', campaignId: '333', date: '2026-10-08', clicks: 1, impressions: 5, cost: 500_000, label: 'acme helmet' })
    await metric(A_CUSTOMER, { type: 'SEARCH_TERM', entityId: '111~h4', campaignId: '111', date: '2026-10-11', clicks: 9, cost: 9_000_000, label: 'late term' }) // not read
  })
  await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ('gads-prod-1', $1, 'SKU-ABC', 'Test jacket product', 10, now())`, [A])
}

async function seedB() {
  await inB(async () => {
    await db().googleAdsCustomer.create({ data: { connectionId: 'conn-b', customerId: B_CUSTOMER, currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED', metricsReadFrom: day('2026-10-01'), metricsReadThrough: day('2026-10-12'), lastSuccessAt: SEEN } })
    ids.b1 = (await db().googleAdsCampaign.create({ data: { customerId: B_CUSTOMER, campaignId: '777', name: 'Bravo business campaign', status: 'ENABLED', channelType: 'SEARCH', currencyCode: 'EUR', lastSeenAt: SEEN } })).id
    ids.bag = (await db().googleAdsAdGroup.create({ data: { customerId: B_CUSTOMER, campaignId: '777', adGroupId: '7701', name: 'Bravo group', status: 'ENABLED', lastSeenAt: SEEN } })).id
    await state(B_CUSTOMER, 'AD_GROUPS')
  })
  await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ('gads-prod-b', $1, 'SKU-ZZZ', 'Other business product', 10, now())`, [B])
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await q(`INSERT INTO "UserProfile" (id, email, "displayName", status, "updatedAt") VALUES ($1,'owner@test.local','Owner','active',CURRENT_TIMESTAMP)`, [OWNER])
  for (const id of [A, B, NONE]) {
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await q(`INSERT INTO "Role" (id, key, name, permissions, "updatedAt") VALUES ('role-owner-gads','OWNER','Owner',ARRAY[]::text[],CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING`)
  const ownerRole = (await q(`SELECT id FROM "Role" WHERE key = 'OWNER' LIMIT 1`)).rows[0] as { id: string }
  await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ('m-gads-owner', $1, $2, 'active', CURRENT_TIMESTAMP)`, [A, OWNER])
  await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId", "roleId") VALUES ('m-gads-owner', $1)`, [ownerRole.id])
  mocks.accounts[A] = [googleAccount('conn-a', A_CUSTOMER)]
  mocks.accounts[B] = [googleAccount('conn-b', B_CUSTOMER)]
  await seedA()
  await seedB()
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

type Row = Record<string, any>
const EUR = (cents: number) => cents

describe('R1 — the overview names when each part was read', () => {
  it('every part, in a fixed order; a part never read has no time', async () => {
    const o = await inA(() => googleAdsOverview({ ...WINDOW }, NOW))
    expect(o.reads.map((r) => r.resource)).toEqual([...GOOGLE_READ_RESOURCES])
    expect(o.reads.find((r) => r.resource === 'AD_GROUPS')).toEqual({ resource: 'AD_GROUPS', readAt: SEEN.toISOString(), lastAttemptAt: SEEN.toISOString(), lastStatus: 'SUCCESS', lastError: null })
    const b = await inB(() => googleAdsOverview({ ...WINDOW }, NOW))
    expect(b.reads.find((r) => r.resource === 'KEYWORDS')).toEqual({ resource: 'KEYWORDS', readAt: null, lastAttemptAt: null, lastStatus: null, lastError: null })
  })
})

describe('R5 — ad groups', () => {
  it('numbers over the days read at this grain only; settings in minor units; one seen only in the numbers is listed', async () => {
    const page = await inA(() => googleAdsAdGroups({ ...WINDOW }, NOW))
    expect(page.window).toMatchObject({ from: '2026-10-01', to: '2026-10-12' })
    expect(page.coverage).toEqual({ daysInWindow: 12, daysRead: 10, missingDays: ['2026-10-11', '2026-10-12'] })
    expect(page.read.readAt).toBe(SEEN.toISOString())
    expect(page.numbersRead.resource).toBe('AD_GROUP_DAYS')
    expect(page.items.map((g) => g.name)).toEqual(['Ad group one', 'ad group two', 'Old group', 'Shop group'])
    const [one, two, old, shop] = page.items
    expect(one).toEqual({
      campaignId: ids.c1, externalCampaignId: '111', campaignName: 'Alpha search', campaignType: 'SEARCH',
      adGroupId: ids.ag1, externalAdGroupId: '901', name: 'Ad group one', status: 'ENABLED', primaryStatus: null, primaryStatusReasons: [], type: 'SEARCH_STANDARD',
      cpcBidCents: 123, targetCpaCents: null, targetRoas: 4.5, searchTermMatching: 'off', settingsReadAt: SEEN.toISOString(),
      metrics: { impressions: 100, clicks: 10, spendCents: EUR(200), conversions: 1, conversionValueCents: 500, ctr: 0.1, avgCpcCents: 20, roas: 2.5, costPerConversionCents: 200 },
    })
    expect(two).toMatchObject({ status: 'PAUSED', searchTermMatching: 'on', metrics: { spendCents: 0, ctr: null } })
    expect(old).toMatchObject({ adGroupId: `${A_CUSTOMER}~999`, status: null, settingsReadAt: null, campaignName: 'Alpha search', metrics: { spendCents: 100 } })
    // A Shopping campaign has no search term matching.
    expect(shop).toMatchObject({ campaignType: 'SHOPPING', searchTermMatching: 'not_applicable' })
  })

  it('a window this grain never read: metrics null, never 0', async () => {
    const page = await inA(() => googleAdsAdGroups({ from: '2026-09-01', to: '2026-09-10' }, NOW))
    expect(page.coverage.daysRead).toBe(0)
    expect(page.items.every((g) => g.metrics === null)).toBe(true)
  })

  it('filters by campaign, status and name; pages with a cursor bound to its filters and business', async () => {
    const names = async (filters: Record<string, string>) => (await inA(() => googleAdsAdGroups({ ...WINDOW, ...filters }, NOW))).items.map((g) => g.name)
    expect(await names({ campaignId: ids.c2 })).toEqual(['Shop group'])
    expect(await names({ campaignId: `${A_CUSTOMER}~222` })).toEqual(['Shop group'])
    expect(await names({ status: 'paused' })).toEqual(['ad group two'])
    expect(await names({ search: 'GROUP O' })).toEqual(['Ad group one'])
    await expect(inA(() => googleAdsAdGroups({ ...WINDOW, status: 'RUNNING' }, NOW))).rejects.toMatchObject({ status: 400, message: 'status must be ENABLED, PAUSED or REMOVED.' })
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = await inA(() => googleAdsAdGroups({ ...WINDOW, limit: 1, cursor }, NOW))
      expect(page.total).toBe(4)
      seen.push(...page.items.map((g) => g.adGroupId))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([ids.ag1, ids.ag2, `${A_CUSTOMER}~999`, ids.ag3])
    const first = await inA(() => googleAdsAdGroups({ ...WINDOW, limit: 1 }, NOW))
    await expect(inA(() => googleAdsAdGroups({ ...WINDOW, limit: 1, status: 'ENABLED', cursor: first.nextCursor }, NOW))).rejects.toBeInstanceOf(InvalidCursorError)
    await expect(inB(() => googleAdsAdGroups({ ...WINDOW, limit: 1, cursor: first.nextCursor }, NOW))).rejects.toBeInstanceOf(InvalidCursorError)
  })

  it('search term matching only where AI Max can have it, and null while not read', () => {
    expect(searchTermMatchingFlag('SEARCH', { flagsReadAt: SEEN, aiMaxEnabled: true }, false)).toBe('on')
    expect(searchTermMatchingFlag('SEARCH', { flagsReadAt: SEEN, aiMaxEnabled: false }, false)).toBe('not_applicable')
    expect(searchTermMatchingFlag('SEARCH', { flagsReadAt: null, aiMaxEnabled: null }, true)).toBeNull()
    expect(searchTermMatchingFlag('SEARCH', { flagsReadAt: SEEN, aiMaxEnabled: true }, null)).toBeNull()
    expect(searchTermMatchingFlag('UNKNOWN', undefined, true)).toBeNull()
  })
})

describe('R6 — keywords', () => {
  it('spend first by default; minor units; the keyword seen only in the numbers; negatives are not keywords here', async () => {
    const page = await inA(() => googleAdsKeywords({ ...WINDOW }, NOW))
    expect(page.read.resource).toBe('KEYWORDS')
    expect(page.items.map((k) => [k.text, k.metrics?.spendCents])).toEqual([['blue shoes', 300], ['red shoes', 100], ['gone keyword', 50]])
    expect(page.items[0]).toMatchObject({
      keywordId: ids.kw1, externalCriterionId: '5001', adGroupId: ids.ag1, externalAdGroupId: '901', adGroupName: 'Ad group one', matchType: 'EXACT',
      status: 'ENABLED', qualityScore: 7, cpcBidCents: 50, effectiveCpcBidCents: null, campaignId: ids.c1,
    })
    expect(page.items[2]).toMatchObject({ keywordId: `${A_CUSTOMER}~901~5099`, status: null, matchType: null, adGroupName: 'Ad group one' })
    const byText = await inA(() => googleAdsKeywords({ ...WINDOW, sort: 'text' }, NOW))
    expect(byText.items.map((k) => k.text)).toEqual(['blue shoes', 'gone keyword', 'red shoes'])
  })

  it('by ad group (Nexus id or <customer>~<id>), match type and text; an ad group of another business is not found', async () => {
    const texts = async (filters: Record<string, string>) => (await inA(() => googleAdsKeywords({ ...WINDOW, ...filters }, NOW))).items.map((k) => k.text)
    expect(await texts({ adGroupId: ids.ag1, matchType: 'phrase' })).toEqual(['red shoes'])
    expect(await texts({ adGroupId: `${A_CUSTOMER}~901`, search: 'BLUE' })).toEqual(['blue shoes'])
    expect(await texts({ adGroupId: ids.ag3 })).toEqual([])
    await expect(inA(() => googleAdsKeywords({ ...WINDOW, adGroupId: ids.bag }, NOW))).rejects.toMatchObject({ status: 404, message: 'Ad group not found' })
    await expect(inA(() => googleAdsKeywords({ ...WINDOW, adGroupId: `${B_CUSTOMER}~7701` }, NOW))).rejects.toMatchObject({ status: 404 })
    await expect(inA(() => googleAdsKeywords({ ...WINDOW, matchType: 'FUZZY' }, NOW))).rejects.toMatchObject({ status: 400 })
  })
})

describe('a cursor carries a place, never an amount', () => {
  const decoded = (cursor: string | null) => JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as Row

  it('spend-sorted keywords, search terms and products: the cursor names the row and its place only', async () => {
    const keywords = await inA(() => googleAdsKeywords({ ...WINDOW, sort: 'spend', limit: 1 }, NOW))
    expect(keywords.items[0].metrics?.spendCents).toBe(300)
    const terms = await inA(() => googleAdsSearchTerms({ ...WINDOW, sort: 'spend', limit: 1 }, NOW))
    expect(terms.items[0].metrics.spendCents).toBe(200)
    const products = await inA(() => googleAdsProducts({ ...WINDOW, sort: 'spend', limit: 1 }, NOW))
    expect(products.items[0].metrics?.spendCents).toBe(250)
    for (const [page, id, spend] of [[keywords, ids.kw1, 300], [terms, '111~h2', 200], [products, '222~sku-abc', 250]] as const) {
      const cursor = decoded(page.nextCursor)
      expect(Object.keys(cursor).sort()).toEqual(['id', 'k', 's', 'v'])
      expect({ k: cursor.k, id: cursor.id }).toEqual({ k: [1], id })
      // Neither the spend in minor units nor in micros, nor its negation.
      expect(JSON.stringify(cursor.k)).not.toMatch(new RegExp(`${spend}|${spend * 10_000}`))
    }
    // The cursor still follows the spend order to the end.
    const seen: number[] = []
    let cursor: string | null = null
    do {
      const page = await inA(() => googleAdsKeywords({ ...WINDOW, sort: 'spend', limit: 1, cursor }, NOW))
      seen.push(...page.items.map((k) => k.metrics!.spendCents))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([300, 100, 50])
  })

  it('a row gone between two pages: the next page goes on from the same count (no sort value to go on from)', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, spend: 40 - i }))
    const keyOf = (r: { id: string; spend: number }) => ({ values: [-r.spend], id: r.id })
    const first = keysetPage(rows, keyOf, 'test-list', null, 2)
    expect(first.items.map((r) => r.id)).toEqual(['a', 'b'])
    expect(keysetPage(rows, keyOf, 'test-list', first.nextCursor, 2).items.map((r) => r.id)).toEqual(['c', 'd'])
    expect(keysetPage(rows.filter((r) => r.id !== 'b'), keyOf, 'test-list', first.nextCursor, 2).items.map((r) => r.id)).toEqual(['d'])
    expect(() => keysetPage(rows, keyOf, 'another-list', first.nextCursor, 2)).toThrow(InvalidCursorError)
  })
})

describe('R7 — negative keywords', () => {
  it('by level then text; a campaign\'s own, its ad groups\' and its lists\' (M8); removed ones left out', async () => {
    const all = await inA(() => googleAdsNegatives({}))
    expect(all.read).toMatchObject({ adGroup: { resource: 'KEYWORDS' }, campaign: { resource: 'CAMPAIGN_NEGATIVES' }, lists: { resource: 'NEGATIVE_LISTS' } })
    expect(all.items.map((n) => [n.level, n.kind, n.text])).toEqual([
      ['ad_group', 'keyword', 'cheap'], ['campaign', 'brand_list', null], ['campaign', 'keyword', 'free'], ['list', 'keyword', 'used'],
    ])
    expect(all.items[3]).toMatchObject({ listId: ids.list, listName: 'Shared negatives', status: null, campaignId: null, matchType: 'PHRASE' })
    expect(all.items[0]).toMatchObject({ adGroupId: ids.ag1, adGroupName: 'Ad group one', campaignId: ids.c1, campaignName: 'Alpha search', status: 'ENABLED' })
    expect(all.lists).toEqual([{
      listId: ids.list, externalListId: '700', name: 'Shared negatives', status: 'ENABLED', memberCount: 1, accountLevel: false, appliesToAccount: false,
      campaigns: [{ campaignId: ids.c1, externalCampaignId: '111', name: 'Alpha search' }], seenAt: SEEN.toISOString(),
    }])
    const alpha = await inA(() => googleAdsNegatives({ campaignId: ids.c1 }))
    expect(alpha.items.map((n) => n.text)).toEqual(['cheap', 'free', 'used'])
    const charlie = await inA(() => googleAdsNegatives({ campaignId: ids.c3 }))
    expect(charlie.items.map((n) => n.kind)).toEqual(['brand_list'])
    expect(charlie.lists).toEqual([])
    expect((await inA(() => googleAdsNegatives({ level: 'list' }))).items.map((n) => n.text)).toEqual(['used'])
    expect((await inA(() => googleAdsNegatives({ search: 'shared' }))).items.map((n) => n.text)).toEqual(['used'])
  })

  it('the account-level list: in force, not in use or not read (customer_negative_criterion), with each campaign of a type Google applies it to', async () => {
    const listOf = (sharedSetId: string, name: string, listType: string | null, appliesToAccount: boolean | null) =>
      db().googleAdsNegativeList.create({ data: { customerId: A_CUSTOMER, sharedSetId, name, status: 'ENABLED', memberCount: 1, listType, appliesToAccount, lastSeenAt: SEEN } })
    const listKeyword = (sharedSetId: string, criterionId: string, text: string) => db().googleAdsKeyword.create({
      data: { customerId: A_CUSTOMER, level: 'LIST', parentKey: `l:${sharedSetId}`, criterionId, sharedSetId, negative: true, criterionType: 'KEYWORD', text, matchType: 'EXACT', lastSeenAt: SEEN },
    })
    const ACCOUNT = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS'
    const made = await inA(async () => ({
      lists: [
        await listOf('710', 'Account negatives', ACCOUNT, true), // a customer_negative_criterion points at it
        await listOf('711', 'Old account negatives', ACCOUNT, false), // read: none points at it
        await listOf('712', 'Account negatives not read', ACCOUNT, null), // stored before the link was read
        await listOf('720', 'Type not read', null, null), // the read without the lists' details: never taken for the account's
      ],
      keywords: [await listKeyword('710', '7101', 'second hand'), await listKeyword('711', '7111', 'old term'), await listKeyword('712', '7121', 'unread term'), await listKeyword('720', '7201', 'spare parts')],
      display: await db().googleAdsCampaign.create({ data: { customerId: A_CUSTOMER, campaignId: '444', name: 'Delta display', status: 'ENABLED', channelType: 'DISPLAY', currencyCode: 'EUR', lastSeenAt: SEEN } }),
    }))
    try {
      const all = await inA(() => googleAdsNegatives({}))
      expect(all.lists.map((l) => [l.name, l.accountLevel, l.appliesToAccount, l.campaigns.length])).toEqual([
        ['Account negatives', true, true, 0], ['Account negatives not read', true, null, 0], ['Old account negatives', true, false, 0],
        ['Shared negatives', false, false, 1], ['Type not read', null, null, 0],
      ])
      // Search, Shopping and Performance Max campaigns: every account-level list with its keywords, at level 'list' — the
      // web says which is in force, not in use or not read.
      const [inForce, notInUse, notRead] = made.lists
      for (const campaignId of [ids.c1, ids.c2, ids.c3]) {
        const page = await inA(() => googleAdsNegatives({ campaignId }))
        expect(page.lists.filter((l) => l.accountLevel).map((l) => [l.listId, l.appliesToAccount])).toEqual([[inForce.id, true], [notRead.id, null], [notInUse.id, false]])
        expect(page.items.find((n) => n.text === 'second hand')).toMatchObject({ level: 'list', listId: inForce.id, listName: 'Account negatives', campaignId: null })
        expect(page.items.some((n) => n.text === 'spare parts')).toBe(false)
      }
      expect((await inA(() => googleAdsNegatives({ campaignId: ids.c1 }))).items.map((n) => n.text)).toEqual(['cheap', 'free', 'old term', 'second hand', 'unread term', 'used'])
      // A Display campaign: Google does not apply the account-level list to it.
      const display = await inA(() => googleAdsNegatives({ campaignId: made.display.id }))
      expect(display.lists).toEqual([])
      expect(display.items).toEqual([])
      // A list in force whose type the read did not get is still the account's list.
      await inA(() => db().googleAdsNegativeList.update({ where: { id: inForce.id }, data: { listType: null } }))
      expect((await inA(() => googleAdsNegatives({}))).lists.find((l) => l.listId === inForce.id)).toMatchObject({ accountLevel: true, appliesToAccount: true })
    } finally {
      await inA(async () => {
        await db().googleAdsKeyword.deleteMany({ where: { id: { in: made.keywords.map((k) => k.id) } } })
        await db().googleAdsNegativeList.deleteMany({ where: { id: { in: made.lists.map((l) => l.id) } } })
        await db().googleAdsCampaign.delete({ where: { id: made.display.id } })
      })
    }
  })
})

describe('brand — the protected terms for every market', () => {
  it('matches as the Keyword Tracker does; no term → null, never "not brand"', () => {
    const brand = googleBrandOf([
      { term: 'Acme', matchType: 'CONTAINS', isPrefix: false, marketplace: null },
      { term: 'running', matchType: 'CONTAINS', isPrefix: false, marketplace: 'IT' },
    ])
    expect(brand.brandTerms).toEqual({ terms: ['acme'], source: 'protected_terms', editHref: BRAND_TERMS_HREF })
    expect([brand.isBrand('ACME shoes'), brand.isBrand('running shoes')]).toEqual([true, false])
    expect(googleBrandOf([]).isBrand('acme')).toBeNull()
    expect(BRAND_TERMS_HREF).toBe('/marketing/ads/rules-automation/control-room?tab=limits&view=terms')
  })
})

describe('R8 — search terms', () => {
  it('terms with clicks over the days read; brand by the protected terms; a day not read stays out', async () => {
    const page = await inA(() => googleAdsSearchTerms({ ...WINDOW }, NOW))
    expect(page).toMatchObject({ scope: 'terms_with_clicks', read: { resource: 'SEARCH_TERM_DAYS' }, brandTerms: { terms: ['acme'] } })
    expect(page.coverage).toMatchObject({ daysInWindow: 12, daysRead: 6 })
    expect(page.items.map((t) => [t.term, t.brand, t.metrics.spendCents, t.campaignName])).toEqual([
      ['running shoes', false, 200, 'Alpha search'], ['acme shoes', true, 100, 'Alpha search'], ['acme helmet', true, 50, 'Charlie max'],
    ])
    const brandOnly = await inA(() => googleAdsSearchTerms({ ...WINDOW, brand: 'brand', sort: 'term' }, NOW))
    expect(brandOnly.items.map((t) => t.term)).toEqual(['acme helmet', 'acme shoes'])
    const alpha = await inA(() => googleAdsSearchTerms({ ...WINDOW, campaignId: ids.c1, brand: 'non_brand' }, NOW))
    expect(alpha.items.map((t) => t.term)).toEqual(['running shoes'])
    expect((await inA(() => googleAdsSearchTerms({ ...WINDOW, sort: 'clicks' }, NOW))).items.map((t) => t.metrics.clicks)).toEqual([3, 2, 1])
  })
})

describe('R9 — the brand split', () => {
  it('over the days read by both sides; brand + other + not in the list = the total', async () => {
    const split = await inA(() => googleAdsBrandSplit({ ...WINDOW }, NOW))
    expect(split.coverage).toMatchObject({ daysInWindow: 12, daysRead: 6 })
    const row = (type: string) => split.rows.find((r) => r.campaignType === type)!
    expect([row('ALL').total?.spendCents, row('ALL').brand?.spendCents, row('ALL').nonBrand?.spendCents, row('ALL').notInSearchTerms?.spendCents]).toEqual([500, 150, 200, 150])
    expect([row('SEARCH').total?.spendCents, row('SEARCH').brand?.spendCents, row('SEARCH').nonBrand?.spendCents, row('SEARCH').notInSearchTerms?.spendCents]).toEqual([500, 100, 200, 200])
    expect(row('SEARCH').notInSearchTerms?.clicks).toBe(20)
    // Never below zero (the two sides are re-read on different days).
    expect(row('PERFORMANCE_MAX')).toMatchObject({ total: { spendCents: 0 }, brand: { spendCents: 50 }, notInSearchTerms: { spendCents: 0 } })
    expect(row('SHOPPING').total?.spendCents).toBe(0)
  })

  it('days read by one side only: nothing at all', async () => {
    const split = await inA(() => googleAdsBrandSplit({ from: '2026-09-01', to: '2026-09-30' }, NOW))
    expect(split.coverage.daysRead).toBe(0)
    expect(split.rows.every((r) => r.total === null && r.brand === null && r.nonBrand === null && r.notInSearchTerms === null)).toBe(true)
  })
})

describe('R10 — asset groups', () => {
  it('Performance Max asset groups with their numbers', async () => {
    const page = await inA(() => googleAdsAssetGroups({ ...WINDOW }, NOW))
    expect(page.read.resource).toBe('ASSET_GROUPS')
    expect(page.items).toEqual([expect.objectContaining({
      assetGroupId: ids.asset, externalAssetGroupId: '801', campaignId: ids.c3, campaignType: 'PERFORMANCE_MAX', adStrength: 'GOOD',
      finalUrls: ['https://shop.example.test/'], metrics: expect.objectContaining({ spendCents: 400, clicks: 8 }),
    })])
    expect((await inA(() => googleAdsAssetGroups({ ...WINDOW, campaignId: ids.c1 }, NOW))).items).toEqual([])
  })
})

describe('R11 — products', () => {
  it('one row per campaign and item; the issue status; the Nexus product by exact SKU, case aside; one row per feed for a product with no numbers', async () => {
    const page = await inA(() => googleAdsProducts({ ...WINDOW }, NOW))
    expect(page).toMatchObject({ numbersRead: { resource: 'PRODUCT_DAYS' }, statusRead: { resource: 'PRODUCT_STATUS' } })
    expect(page.items.map((p) => [p.productKey, p.status, p.metrics?.spendCents])).toEqual([
      ['222~sku-abc', 'limited', 250], ['333~SKU-ZZZ', 'no_issue', 100], ['42~ONLINE~en~AT~sku-nope', 'not_eligible', 0], ['42~ONLINE~en~DE~sku-nope', 'not_eligible', 0],
    ])
    expect(page.items[0]).toMatchObject({
      itemId: 'sku-abc', title: 'Test jacket', campaignId: ids.c2, campaignType: 'SHOPPING',
      nexusProduct: { productId: 'gads-prod-1', sku: 'SKU-ABC', name: 'Test jacket product' },
      issues: [{ code: 'missing_gtin', severity: 'DEMOTED', text: 'Missing GTIN', explanation: 'Add a GTIN.', helpUrl: 'https://support.example.test/1', regions: ['IT'] }],
    })
    // Another business's product with that SKU is never matched.
    expect(page.items[1].nexusProduct).toBeNull()
    expect(page.items[2]).toMatchObject({ campaignId: null, title: 'Test gloves', nexusProduct: null })
    expect((await inA(() => googleAdsProducts({ ...WINDOW, issue: 'not_eligible' }, NOW))).items.map((p) => p.itemId)).toEqual(['sku-nope', 'sku-nope'])
    expect((await inA(() => googleAdsProducts({ ...WINDOW, campaignId: ids.c3 }, NOW))).items.map((p) => p.itemId)).toEqual(['SKU-ZZZ'])
    expect((await inA(() => googleAdsProducts({ ...WINDOW, search: 'helmet', sort: 'title' }, NOW))).items.map((p) => p.title)).toEqual(['Test helmet'])
  })

  it('issue text: Google\'s fields, a help link only when it is a web address', () => {
    expect(productIssueTexts([{ errorCode: 'x', documentation: 'javascript:alert(1)' }, 'junk', null])).toEqual([
      { code: 'x', severity: 'UNKNOWN', text: 'Google gave no description of this issue.', explanation: null, helpUrl: null, regions: [] },
    ])
  })
})

describe('R12 — where Google acts on its own', () => {
  it('auto-apply, each campaign\'s settings, and the changes made outside Nexus without the person', async () => {
    const acts = await inA(() => googleAdsActsOnItsOwn({}, NOW))
    expect(acts.autoApply).toEqual({
      enabled: [{ type: 'KEYWORD', typeText: 'Add keywords', since: '2026-09-01T10:00:00.000Z', changedAt: null }],
      paused: [{ type: 'TARGET_CPA_OPT_IN', typeText: 'Bid to a target cost per conversion', since: null, changedAt: null }],
    })
    const alpha = acts.campaigns.find((c) => c.campaignId === ids.c1)!
    expect(alpha).toMatchObject({
      aiMax: 'on', campaignBroadMatch: 'on', searchPartners: 'on', displayExpansion: 'off', finalUrlExpansion: 'off', finalUrlExpansionByDefault: false,
      textCustomization: 'on', dynamicSearchAds: 'off', brandExclusions: 0, adGroupsWithoutSearchTermMatching: 1, movedToAiMaxAt: '2026-10-01T08:00:00.000Z',
    })
    const charlie = acts.campaigns.find((c) => c.campaignId === ids.c3)!
    expect(charlie).toMatchObject({ aiMax: 'not_applicable', searchPartners: 'not_applicable', finalUrlExpansion: 'on', finalUrlExpansionByDefault: true, textCustomization: 'on', brandExclusions: 1 })
    expect(acts.outsideChanges).toMatchObject({ nexusWrites: 0, coveredThrough: '2026-10-13T06:00:00.000Z' })
    expect(acts.outsideChanges.items.map((c) => [c.who, c.watched, c.campaignName])).toEqual([
      ['google_auto_apply', true, 'Alpha search'], ['person', true, 'Alpha search'], ['your_google_rules_or_scripts', false, 'Alpha search'],
    ])
    expect(acts.outsideChanges.bySource).toEqual([
      { source: 'google_automatic', sourceText: 'Google, automatically', count: 2 },
      { source: 'google_ads_web', sourceText: 'Google Ads website', count: 1 },
    ])
    expect(JSON.stringify(acts)).not.toMatch(/example\.test|test\.person/)
  })

  it('a setting not read is null, never off', () => {
    const row = {
      id: 'x', campaignId: '1', name: 'X', status: 'ENABLED', removedAt: null, channelType: 'SEARCH', flagsReadAt: null, aiMaxEnabled: null, keywordMatchType: null,
      broadMatchMigratedAt: null, targetSearchNetwork: null, targetContentNetwork: null, assetAutomation: null, dsaDomain: null,
    }
    const flags = campaignAutomation(row, { brandExclusions: null, adGroupsWithoutSearchTermMatching: null })
    expect([flags.aiMax, flags.searchPartners, flags.finalUrlExpansion, flags.finalUrlExpansionByDefault, flags.dynamicSearchAds]).toEqual([null, null, null, false, null])
  })
})

describe('R13 — Google\'s recommendations', () => {
  it('open ones in words, Google\'s estimate in minor units, auto-applied when its type is on; Nexus applies none', async () => {
    const recs = await inA(() => googleAdsRecommendations({}))
    expect(recs.writes).toEqual({ mode: 'none' })
    expect(recs.items.map((r) => [r.type, r.typeText, r.autoApplied])).toEqual([
      ['KEYWORD', 'Add keywords', true], ['CAMPAIGN_BUDGET', 'Raise the budget', false], ['SOMETHING_NEW_FROM_GOOGLE', 'Something new from google', false],
    ])
    expect(recs.items[0]).toMatchObject({
      recommendationId: 'rec-a', campaignId: ids.c1, adGroupName: 'Ad group one',
      impact: { base: { impressions: 100, clicks: 10, spendCents: 200, conversions: 1, conversionValueCents: 1250 }, potential: { spendCents: 300, conversionValueCents: 2000 } },
    })
    expect(recs.items[1].impact).toBeNull()
    expect(recs.byType).toEqual([
      { type: 'CAMPAIGN_BUDGET', typeText: 'Raise the budget', count: 1 }, { type: 'KEYWORD', typeText: 'Add keywords', count: 1 },
      { type: 'SOMETHING_NEW_FROM_GOOGLE', typeText: 'Something new from google', count: 1 },
    ])
    expect((await inA(() => googleAdsRecommendations({ type: 'keyword' }))).items.map((r) => r.recommendationId)).toEqual(['rec-a'])
    expect((await inA(() => googleAdsRecommendations({ campaignId: ids.c2 }))).items.map((r) => r.type)).toEqual(['CAMPAIGN_BUDGET'])
    await expect(inA(() => googleAdsRecommendations({ type: 'drop table' }))).rejects.toMatchObject({ status: 400 })
    expect(impactOf({ baseMetrics: {} }, 2)).toEqual({ base: { impressions: 0, clicks: 0, spendCents: 0, conversions: 0, conversionValueCents: 0 }, potential: { impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null } })
    expect(recommendationWords('KEYWORD').explanation).toBe('Google suggests new keywords for this campaign.')
  })
})

describe('R15 — disapprovals', () => {
  it('open ad issues (disapproved first) and one row per product feed entry; resolved ones are gone', async () => {
    const d = await inA(() => googleAdsDisapprovals({}))
    expect(d.truncated).toBe(false)
    expect(d.ads.map((a) => [a.externalAdId, a.status])).toEqual([['4001', 'DISAPPROVED'], ['4002', 'APPROVED_LIMITED']])
    expect(d.ads[0]).toMatchObject({ adType: 'RESPONSIVE_SEARCH_AD', campaignId: ids.c1, campaignName: 'Alpha search', adGroupId: ids.ag1, adGroupName: 'Ad group one', reasons: ['DESTINATION_NOT_WORKING'], since: '2026-10-09T06:00:00.000Z' })
    expect(d.products.map((p) => [p.productKey, p.status])).toEqual([
      ['42~ONLINE~en~AT~sku-nope', 'not_eligible'], ['42~ONLINE~en~DE~sku-nope', 'not_eligible'], ['42~ONLINE~en~IT~sku-abc', 'limited'],
    ])
    expect((await inA(() => googleAdsDisapprovals({ kind: 'ad' }))).products).toEqual([])
    // A product issue names no campaign: it belongs to the campaign that advertised the item.
    expect((await inA(() => googleAdsDisapprovals({ campaignId: ids.c2 }))).products.map((p) => p.itemId)).toEqual(['sku-abc'])
    expect((await inA(() => googleAdsDisapprovals({ campaignId: ids.c2 }))).ads).toEqual([])
  })
})

describe('R14 — what needs a look', () => {
  it('each rule over the days read; no amount in the text; money only under numbers', async () => {
    const alerts = await inA(() => googleAdsAlerts({}, NOW))
    expect(alerts.checkedAt).toBe(NOW.toISOString())
    const kinds = alerts.items.map((a) => [a.kind, a.campaignName])
    expect(kinds).toEqual([
      ['tracking_stopped', 'Alpha search'],
      ['ads_disapproved', 'Alpha search'],
      ['spend_pace', 'Alpha search'],
      ['month_pace', 'Bravo shopping'],
      ['products_not_eligible', null],
      ['auto_apply_on', null],
      ['changed_by_google', null],
      ['moved_to_ai_max', 'Alpha search'],
      ['ads_limited', 'Alpha search'],
      ['settings_changed', null],
    ])
    const pace = alerts.items.find((a) => a.kind === 'spend_pace')!
    expect(pace).toMatchObject({ campaignId: ids.c1, externalCampaignId: '111', since: '2026-10-12', numbers: { spendCents: 1600, dailyBudgetCents: 1000, ratio: 1.6 } })
    expect(pace.href).toBe(`/marketing/ads/google?campaign=${ids.c1}&tab=overview`)
    expect(alerts.items.find((a) => a.kind === 'month_pace')!.numbers).toMatchObject({ monthSpendCents: 8000, monthBudgetCents: 15200, days: 12 })
    expect(alerts.items.find((a) => a.kind === 'tracking_stopped')!.numbers).toMatchObject({ spendCents: 2100, clicks: 30, priorConversions: 4, days: 7 })
    expect(alerts.items.find((a) => a.kind === 'ads_disapproved')!.href).toBe('/marketing/ads/google?view=disapprovals')
    expect(alerts.items.find((a) => a.kind === 'auto_apply_on')).toMatchObject({ numbers: null, href: '/marketing/ads/google?view=on-its-own' })
    expect(alerts.notChecked).toEqual([])
    for (const a of alerts.items) expect({ kind: a.kind, text: `${a.title} ${a.body}` }).not.toEqual({ kind: a.kind, text: expect.stringMatching(/€|EUR|\d+[.,]\d{2}\b/) })
    expect(JSON.stringify(alerts)).not.toMatch(/example\.test/)
  })

  it('no account, or an account never read: nothing checked, each with a reason', async () => {
    const none = await inNone(() => googleAdsAlerts({}, NOW))
    expect(none.items).toEqual([])
    expect(none.notChecked).toHaveLength(11)
    expect(none.notChecked[0]).toEqual({ kind: 'spend_pace', reason: 'No Google Ads account is chosen yet.' })
  })
})

describe('the bell', () => {
  it('rings the owners once per alert and occurrence, warn and danger only, with no amount; off with the kill switch', async () => {
    const first = await inA(() => raiseGoogleAdsAlerts(A_CUSTOMER, NOW))
    // tracking_stopped, ads_disapproved, spend_pace, month_pace, products_not_eligible, auto_apply_on, changed_by_google, moved_to_ai_max.
    expect(first).toEqual({ raised: 8 })
    expect(await inA(() => raiseGoogleAdsAlerts(A_CUSTOMER, NOW))).toEqual({ raised: 0 })
    const rows = (await q(`SELECT type, title, body, href, "userId", "workspaceId" FROM "Notification" WHERE "userId" = $1 ORDER BY type, title`, [OWNER])).rows as Row[]
    expect(rows).toHaveLength(8)
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['google-ads-spend-pace', 'google-ads-zero-conversions', 'google-ads-disapproved', 'google-ads-auto-apply', 'google-ads-changed-by-google']))
    expect(rows.every((r) => r.workspaceId === A && r.title.startsWith('Google Ads: '))).toBe(true)
    for (const r of rows) expect(`${r.title} ${r.body}`).not.toMatch(/€|EUR|\d+[.,]\d{2}\b|1600|8000/)
    expect(rows.find((r) => r.type === 'google-ads-spend-pace' && r.title.includes('yesterday'))!.body).toMatch(/^Alpha search: /)

    vi.stubEnv('NEXUS_GOOGLE_ADS_ALERTS', 'off')
    try {
      await q(`DELETE FROM "Notification"`)
      expect(await inA(() => raiseGoogleAdsAlerts(A_CUSTOMER, NOW))).toEqual({ raised: 0 })
    } finally {
      vi.stubEnv('NEXUS_GOOGLE_ADS_ALERTS', '')
    }
    // Another business's account: nothing (its rows are not this business's).
    expect(await inB(() => raiseGoogleAdsAlerts(A_CUSTOMER, NOW))).toEqual({ raised: 0 })
    // Never throws, even without a business.
    expect(await raiseGoogleAdsAlerts(A_CUSTOMER, NOW)).toEqual({ raised: 0 })
  })
})

describe('one business never reads another\'s', () => {
  it('another business\'s campaign is not found; its lists hold only its own rows', async () => {
    for (const read of [
      () => googleAdsAdGroups({ campaignId: ids.c1 }, NOW), () => googleAdsKeywords({ campaignId: ids.c1 }, NOW), () => googleAdsNegatives({ campaignId: ids.c1 }),
      () => googleAdsSearchTerms({ campaignId: ids.c1 }, NOW), () => googleAdsAssetGroups({ campaignId: ids.c1 }, NOW), () => googleAdsProducts({ campaignId: ids.c1 }, NOW),
      () => googleAdsRecommendations({ campaignId: ids.c1 }), () => googleAdsDisapprovals({ campaignId: `${A_CUSTOMER}~111` }),
    ]) {
      await expect(inB(read)).rejects.toMatchObject({ status: 404, message: 'Campaign not found' })
    }
    const groups = await inB(() => googleAdsAdGroups({}, NOW))
    expect(groups.items.map((g) => g.name)).toEqual(['Bravo group'])
    const all = JSON.stringify(await inB(async () => [
      await googleAdsKeywords({}, NOW), await googleAdsNegatives({}), await googleAdsSearchTerms({}, NOW), await googleAdsBrandSplit({}, NOW),
      await googleAdsAssetGroups({}, NOW), await googleAdsProducts({}, NOW), await googleAdsActsOnItsOwn({}, NOW), await googleAdsRecommendations({}),
      await googleAdsAlerts({}, NOW), await googleAdsDisapprovals({}),
    ]))
    expect(all).not.toMatch(/Alpha search|blue shoes|acme|sku-abc|Shared negatives|rec-a|1234567890/)
    await expect(inA(() => googleAdsAdGroups({ connectionId: 'conn-b' }, NOW))).rejects.toMatchObject({ status: 404, message: 'Google account not found' })
  })

  it('no Google at all: empty answers, every part "not read yet"', async () => {
    const page = await inNone(() => googleAdsKeywords({}, NOW))
    expect(page).toMatchObject({ items: [], total: 0, nextCursor: null, read: { readAt: null }, numbersRead: { readAt: null } })
    expect(await inNone(() => googleAdsActsOnItsOwn({}, NOW))).toMatchObject({ autoApply: null, campaigns: [], outsideChanges: { nexusWrites: 0, items: [] } })
    expect((await inNone(() => googleAdsBrandSplit({}, NOW))).rows.every((r) => r.total === null)).toBe(true)
  })
})

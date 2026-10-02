/**
 * MCP full control A2 — Claude's advertising reads, run through the one door (call-tool.ts) against a real PostgreSQL
 * with the production schema and the business-isolation policies (PGlite). No mocked query; the ads read cache is a
 * pass-through and the job queue a stub (nothing here enqueues).
 *
 * Proven here, for each of the six reads: the ids a change tool takes come back (Nexus campaign / ad group / target
 * ids, Amazon's campaign and ad group ids, the search term); `dataAsOf` names the newest day of data; a window marks
 * its last 3 days provisional; amounts are in each campaign's own currency; every list walks page by page with no row
 * twice and none missed; filters narrow; another business's ids read as not found; and a person without the ad-spend
 * money permission gets the same answer minus exactly the money keys — while the money-cleared answer carries them.
 *
 * A13 — `ads-overview` and `ad-campaigns` with `channel: ebay`: per eBay market and campaign, in its own currency,
 * each campaign naming its OWN eBay account (a second account's campaign is never shown as the primary's).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { RESTRICTED_FIELDS } from '../../../lib/auth/financial-fields.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
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

import { callTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { resolveRange } from '../../ads-core/date-range.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_ads_read_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-ads-read',
    label: 'Ads read test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'claude',
  }
}
/** Sees every money field. */
const cleared = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])
/** May read ads, sees no money. */
const operator = (workspaceId = A) => principal(workspaceId, [FEATURES.aiRun, FEATURES.adsView])

type Row = Record<string, any>
interface Answer { ok: boolean; error?: string; data?: Row }
async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = cleared()): Promise<Answer> {
  return (await callTool(who, tool, args)).visible as Answer
}
async function walk(tool: string, args: Record<string, unknown>, limit: number, who?: UserPrincipal) {
  const items: Row[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const answer: Answer = await call(tool, { ...args, limit, ...(cursor ? { cursor } : {}) }, who)
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data!.items.length).toBeLessThanOrEqual(limit)
    items.push(...answer.data!.items)
    cursor = answer.data!.nextCursor
    pages++
  } while (cursor && pages < 60)
  return { items, pages }
}

// ── The seed ─────────────────────────────────────────────────────────────────────────────────────────

const TODAY = resolveRange({ windowDays: 1 }).untilStr
const ebay = { primary: '', second: '' }
const dayBefore = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

async function seedA() {
  await inside(A, async () => {
    const db = database.client
    const campaign = (id: string, name: string, marketplace: string, ext: string, extra: Record<string, unknown> = {}) =>
      db.campaign.create({ data: { id, name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace, externalCampaignId: ext, startDate: dayBefore(200), ...extra } as never })
    await campaign('ar-c1', 'Alpha race IT', 'IT', 'EXT-C1', { dailyBudget: '23.45', liveBidWritesEnabled: true, dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 35 }], targetAcos: 0.25 } })
    await campaign('ar-c2', 'Bravo boots UK', 'UK', 'EXT-C2', { dailyBudget: '12.34', dailyBudgetCurrency: 'GBP', bidsSuppressedAt: hoursAgo(5), bidsSuppressedBy: 'user:u-ads' })
    await campaign('ar-c3', 'Charlie paused IT', 'IT', 'EXT-C3', { dailyBudget: '5.00', status: 'PAUSED' })
    const group = (id: string, campaignId: string, name: string, ext: string) => db.adGroup.create({ data: { id, campaignId, name, externalAdGroupId: ext } })
    await group('ar-g1', 'ar-c1', 'Alpha group', 'EXT-G1')
    await group('ar-g2', 'ar-c2', 'Bravo group', 'EXT-G2')
    await group('ar-g3', 'ar-c3', 'Charlie group', 'EXT-G3')
    const target = (id: string, adGroupId: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) =>
      db.adTarget.create({ data: { id, adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, ...extra } })
    await target('ar-t1', 'ar-g1', 'race jacket', 45)
    await target('ar-t2', 'ar-g1', 'leather gloves', 2, { suppressedFromBidCents: 61, expressionType: 'BROAD' })
    await target('ar-t3', 'ar-g2', 'motorbike boots', 77)
    await target('ar-t4', 'ar-g3', 'old term', 33)

    const perf = (data: Record<string, unknown>) =>
      db.amazonAdsDailyPerformance.create({ data: { profileId: 'P1', adProduct: 'SPONSORED_PRODUCTS', currencyCode: 'EUR', entityType: 'CAMPAIGN', reportedAt: new Date(), ...data } as never })
    await perf({ marketplace: 'IT', date: dayBefore(1), entityId: 'EXT-C1', localEntityId: 'ar-c1', impressions: 900, clicks: 31, costMicros: 12_340_000n, sales7dCents: 5678, orders7d: 3 })
    await perf({ marketplace: 'IT', date: dayBefore(5), entityId: 'EXT-C1', localEntityId: 'ar-c1', impressions: 700, clicks: 19, costMicros: 8_760_000n, sales7dCents: 0, orders7d: 0 })
    await perf({ marketplace: 'IT', date: dayBefore(10), entityId: 'EXT-C1', localEntityId: 'ar-c1', impressions: 500, clicks: 11, costMicros: 4_320_000n, sales7dCents: 2468, orders7d: 1 })
    await perf({ marketplace: 'UK', currencyCode: 'GBP', date: dayBefore(2), entityId: 'EXT-C2', localEntityId: 'ar-c2', impressions: 300, clicks: 7, costMicros: 9_870_000n, sales7dCents: 3579, orders7d: 2 })
    await perf({ marketplace: 'IT', entityType: 'AD_TARGET', date: dayBefore(1), entityId: 'EXT-T1', localEntityId: 'ar-t1', impressions: 400, clicks: 13, costMicros: 5_550_000n, sales7dCents: 4321, orders7d: 2 })

    const term = (query: string, campaignId: string, adGroupId: string, costMicros: bigint, orders7d: number, sales7dCents: number, marketplace = 'IT') =>
      db.amazonAdsSearchTerm.create({ data: { profileId: 'P1', marketplace, adProduct: 'SPONSORED_PRODUCTS', date: dayBefore(3), campaignId, adGroupId, query, impressions: 800, clicks: 40, costMicros, currencyCode: 'EUR', orders7d, sales7dCents } })
    await term('cheap helmet', 'EXT-C1', 'EXT-G1', 21_500_000n, 0, 0)
    await term('race jacket xl', 'EXT-C1', 'EXT-G1', 7_000_000n, 3, 8888)
    await term('winter boots', 'EXT-C2', 'EXT-G2', 16_500_000n, 0, 0, 'UK')

    const history = (data: Record<string, unknown>) => db.campaignBidHistory.create({ data: data as never })
    await history({ entityType: 'AD_TARGET', entityId: 'ar-t1', campaignId: 'ar-c1', field: 'bid', oldValue: '40', newValue: '45', changedAt: hoursAgo(2), changedBy: 'automation:rule-abc', reason: 'ACoS 23% under the 30% target' })
    await history({ entityType: 'CAMPAIGN', entityId: 'ar-c1', campaignId: 'ar-c1', field: 'dailyBudget', oldValue: '20.00', newValue: '23.45', changedAt: hoursAgo(1), changedBy: 'user:u-ads', reason: 'more budget for the weekend' })
    await history({ entityType: 'CAMPAIGN', entityId: 'ar-c3', campaignId: 'ar-c3', field: 'status', oldValue: 'ENABLED', newValue: 'PAUSED', changedAt: hoursAgo(3), changedBy: 'user:u-ads' })
    await history({ entityType: 'AD_TARGET', entityId: 'ar-t3', campaignId: 'ar-c2', field: 'bid', oldValue: '70', newValue: '77', changedAt: hoursAgo(0.5), changedBy: 'automation:rule-xyz' })

    const suggestion = (ruleId: string, ruleName: string, entityId: string, action: Record<string, unknown>, key: string) =>
      db.adsRuleSuggestion.create({ data: { ruleId, ruleName, entityType: 'AD_TARGET', entityId, entityName: 'race jacket', marketplace: 'IT', proposedAction: action, proposedKey: key } as never })
    await suggestion('rule-abc', 'Trim bleeders', 'ar-t1', { type: 'bid_down', value: 39 }, 'bid_down:39')
    await suggestion('rule-zero', 'Zero sales', 'ar-t1', { type: 'pause_target' }, 'pause_target')

    // A13 — two eBay accounts, a campaign on each, and their daily fees.
    ebay.primary = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, isPrimary: true, accountLabel: 'Main eBay', externalAccountId: 'SELLER-MAIN' } as never })).id
    ebay.second = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, displayName: 'second-seller', externalAccountId: 'SELLER-TWO' } as never })).id
    const ebayCampaign = (id: string, connectionId: string, marketplace: string, name: string, extra: Record<string, unknown> = {}) =>
      db.ebayCampaign.create({ data: { id, channelConnectionId: connectionId, marketplace, externalCampaignId: `EXT-${id}`, name, fundingStrategy: 'COST_PER_SALE', fundingModel: 'COST_PER_SALE', status: 'RUNNING', startDate: dayBefore(100), ...extra } as never })
    await ebayCampaign('ar-e1', ebay.primary, 'EBAY_IT', 'Italia general', { bidPercentage: '6.50' })
    await ebayCampaign('ar-e2', ebay.second, 'EBAY_GB', 'UK priority', { fundingStrategy: 'COST_PER_CLICK', fundingModel: 'COST_PER_CLICK', dailyBudget: '15.50', budgetCurrency: 'GBP' })
    await ebayCampaign('ar-e3', ebay.primary, 'EBAY_IT', 'Italia ended', { status: 'ENDED' })
    // No fees reported and no budget currency: its currency is the market's configured one (Marketplace.currency).
    await db.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'eBay Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'], marketplaceId: 'EBAY_DE' } as never })
    await ebayCampaign('ar-e4', ebay.primary, 'EBAY_DE', 'Germany start')
    const ebayPerf = (data: Record<string, unknown>) =>
      db.ebayAdsDailyPerformance.create({ data: { fundingModel: 'COST_PER_SALE', entityType: 'CAMPAIGN', currency: 'EUR', reportedAt: new Date(), ...data } as never })
    await ebayPerf({ marketplace: 'EBAY_IT', entityId: 'EXT-ar-e1', date: dayBefore(1), impressions: 1100, clicks: 42, adFeesCents: 7171, salesCents: 9393, soldQty: 3 })
    await ebayPerf({ marketplace: 'EBAY_IT', entityId: 'EXT-ar-e1', date: dayBefore(12), impressions: 300, clicks: 6, adFeesCents: 222, salesCents: 3333, soldQty: 1 })
    await ebayPerf({ marketplace: 'EBAY_GB', fundingModel: 'COST_PER_CLICK', entityId: 'EXT-ar-e2', date: dayBefore(4), impressions: 210, clicks: 9, adFeesCents: 5656, salesCents: 4545, soldQty: 2, currency: 'GBP' })
    // The eBay change log and a rule's pending proposal.
    const ebayAction = (id: string, entityId: string, actionType: string, userId: string, mode: string, hours: number) =>
      db.campaignAction.create({ data: { id, channel: 'EBAY', entityType: 'CAMPAIGN', entityId, actionType, userId, payloadBefore: { bidPercentage: 6.5 }, payloadAfter: { bidPercentage: 7.25, _mode: mode }, channelResponseStatus: 'SUCCESS', createdAt: hoursAgo(hours) } as never })
    await ebayAction('ea-1', 'EXT-ar-e1', 'set_ad_rate', 'user:u-ads', 'sandbox', 3)
    await ebayAction('ea-2', 'EXT-ar-e2', 'update_budget', 'automation:ebay-ads', 'live', 2)
    await ebayAction('ea-3', 'EXT-ar-e1', 'drift_accept', 'user:u-ads', 'accept', 1)
    await db.ebayAdsProposal.create({ data: { id: 'ep-1', kind: 'adjust_ad_rate', entityRef: { campaignId: 'ar-e1', externalCampaignId: 'EXT-ar-e1', campaignName: 'Italia general', listingId: 'L-77', marketplace: 'EBAY_IT' }, proposedAction: { field: 'bidPercentage', from: 6.5, to: 5.75 }, reasoning: { rule: 'rate above break-even' }, proposedKey: 'adjust_ad_rate:ar-e1:L-77', estimatedImpact: { monthlyCents: 3131 } } as never })
    await db.ebayAdsProposal.create({ data: { id: 'ep-2', kind: 'pause_ad', entityRef: { campaignId: 'ar-e2', externalCampaignId: 'EXT-ar-e2', campaignName: 'UK priority', listingId: 'L-88', marketplace: 'EBAY_GB' }, proposedAction: { field: 'status', to: 'PAUSED' }, proposedKey: 'pause_ad:ar-e2:L-88' } as never })

    // An advertised product with no stock: the retail engine words that as "pause"; Nexus never pauses.
    const product = await db.product.create({ data: { sku: 'AR-OOS-1', name: 'Out of stock boots', basePrice: '99.00', totalStock: 0 } })
    await db.adProductAd.create({ data: { adGroupId: 'ar-g2', productId: product.id, asin: 'B0TESTASIN', sku: 'AR-OOS-1' } })
  })
}

async function seedOther() {
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Other business', 'active', 'ads', $1, CURRENT_TIMESTAMP)`, [OTHER])
  await inside(OTHER, async () => {
    const db = database.client
    await db.campaign.create({ data: { id: 'ar-other-c', name: 'Other business campaign', type: 'SP', marketplace: 'IT', externalCampaignId: 'EXT-OTHER', dailyBudget: '9.99', startDate: dayBefore(10) } as never })
    await db.adGroup.create({ data: { id: 'ar-other-g', campaignId: 'ar-other-c', name: 'Other group', externalAdGroupId: 'EXT-OTHER-G' } })
    await db.adTarget.create({ data: { id: 'ar-other-t', adGroupId: 'ar-other-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'other term', bidCents: 50 } })
    const account = await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Other eBay', externalAccountId: 'SELLER-OTHER' } as never })
    await db.ebayCampaign.create({ data: { id: 'ar-other-e', channelConnectionId: account.id, marketplace: 'EBAY_IT', externalCampaignId: 'EXT-OTHER-E', name: 'Other eBay campaign', fundingStrategy: 'COST_PER_SALE', status: 'RUNNING', startDate: dayBefore(10) } as never })
    await db.campaignAction.create({ data: { channel: 'EBAY', entityType: 'CAMPAIGN', entityId: 'EXT-OTHER-E', actionType: 'set_ad_rate', userId: 'user:other', payloadBefore: {}, payloadAfter: {} } as never })
    await db.ebayAdsProposal.create({ data: { kind: 'adjust_ad_rate', entityRef: { campaignId: 'ar-other-e', campaignName: 'Other eBay campaign', marketplace: 'EBAY_IT' }, proposedAction: {}, proposedKey: 'other' } as never })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await seedA()
  await seedOther()
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

const ids = (items: Row[], key: string) => items.map((item) => item[key])

// ── ads-overview ─────────────────────────────────────────────────────────────────────────────────────

describe('A2 — ads-overview', () => {
  it('per market, in that market\'s currency: totals, the window before, each day with the last 3 provisional, top campaigns', async () => {
    const answer = await call('ads-overview', {})
    expect(answer.ok, answer.error).toBe(true)
    const data = answer.data!
    expect(data.channel).toBe('amazon')
    expect(data.dataAsOf).toBe(ymd(dayBefore(1)))
    expect(data.window).toMatchObject({ to: TODAY, days: 7, provisionalFrom: ymd(dayBefore(2)) })
    expect(data.markets.map((m: Row) => m.market)).toEqual(['IT', 'UK'])

    const it_ = data.markets[0]
    expect(it_).toMatchObject({ market: 'IT', currency: 'EUR', dataAsOf: ymd(dayBefore(1)), connection: null })
    expect(it_.campaigns).toEqual({ total: 2, enabled: 1, liveWritesAllowed: 1, bidsSuppressed: 0 })
    expect(it_.totals).toEqual({ impressions: 1600, clicks: 50, orders: 3, spendCents: 2110, salesCents: 5678, acos: 2110 / 5678, roas: 5678 / 2110 })
    expect(it_.previous).toMatchObject({ impressions: 500, clicks: 11, orders: 1, spendCents: 432, salesCents: 2468 })
    const days = new Map(it_.days.map((d: Row) => [d.date, d]))
    expect(days.get(ymd(dayBefore(1)))).toMatchObject({ provisional: true, spendCents: 1234, clicks: 31 })
    expect(days.get(ymd(dayBefore(5)))).toMatchObject({ provisional: false, spendCents: 876 })
    expect(it_.topCampaigns).toEqual([
      { campaignId: 'ar-c1', externalCampaignId: 'EXT-C1', name: 'Alpha race IT', status: 'ENABLED', clicks: 50, spendCents: 2110, salesCents: 5678, acos: 2110 / 5678 },
    ])

    const uk = data.markets[1]
    expect(uk).toMatchObject({ market: 'UK', currency: 'GBP', campaigns: { total: 1, enabled: 1, liveWritesAllowed: 0, bidsSuppressed: 1 } })
    expect(uk.totals).toMatchObject({ spendCents: 987, salesCents: 3579, orders: 2 })
    expect(uk.days).toEqual([expect.objectContaining({ date: ymd(dayBefore(2)), provisional: true })])
  })

  it('also states the automation dial and the data feeds, and narrows to one market', async () => {
    const data = (await call('ads-overview', { market: 'uk', days: 30 })).data!
    expect(data.markets.map((m: Row) => m.market)).toEqual(['UK'])
    expect(data.window.days).toBe(30)
    expect(data.automation).toMatchObject({ autonomy: expect.any(String), halted: false, engines: expect.objectContaining({ AUTO: expect.any(Number) }) })
    expect(data.pipeline.feeds.map((f: Row) => f.id)).toContain('daily-perf')
    expect((await call('ads-overview', { market: 'FR' })).data!.empty).toBe('No Amazon campaign in market FR.')
  })
})

// ── ad-campaigns ─────────────────────────────────────────────────────────────────────────────────────

describe('A2 — ad-campaigns', () => {
  it('each campaign with its ids, own currency, budget, guards and window metrics', async () => {
    const data = (await call('ad-campaigns', { limit: 100 })).data!
    expect(data.total).toBe(3)
    expect(ids(data.items, 'campaignId')).toEqual(['ar-c1', 'ar-c3', 'ar-c2']) // by market, then name
    const [alpha, , bravo] = data.items
    expect(alpha).toMatchObject({
      campaignId: 'ar-c1', externalCampaignId: 'EXT-C1', name: 'Alpha race IT', market: 'IT', status: 'ENABLED', currency: 'EUR',
      dailyBudgetCents: 2345, targetAcos: 0.25, placementsPct: { topOfSearch: 35, productPages: null, restOfSearch: null },
      liveWrites: true, bidsSuppressed: null,
      metrics: { impressions: 2100, clicks: 61, orders: 4, spendCents: 2542, salesCents: 8146 },
    })
    expect(bravo).toMatchObject({ campaignId: 'ar-c2', currency: 'GBP', dailyBudgetCents: 1234, bidsSuppressed: { by: 'user:u-ads' }, metrics: { spendCents: 987 } })
    expect(data.dataAsOf).toBe(ymd(dayBefore(1)))
    expect(data.window).toMatchObject({ days: 30, provisionalFrom: ymd(dayBefore(2)) })
  })

  it('walks page by page with no campaign twice, and filters by market, status and name', async () => {
    const whole = ids((await call('ad-campaigns', { limit: 100 })).data!.items, 'campaignId')
    for (const limit of [1, 2]) {
      const { items, pages } = await walk('ad-campaigns', {}, limit)
      expect(ids(items, 'campaignId')).toEqual(whole)
      expect(pages).toBe(Math.ceil(3 / limit))
    }
    expect(ids((await call('ad-campaigns', { market: 'it' })).data!.items, 'campaignId')).toEqual(['ar-c1', 'ar-c3'])
    expect(ids((await call('ad-campaigns', { status: 'paused' })).data!.items, 'campaignId')).toEqual(['ar-c3'])
    expect(ids((await call('ad-campaigns', { search: 'boots' })).data!.items, 'campaignId')).toEqual(['ar-c2'])
  })

  it('never shows another business\'s campaign', async () => {
    const mine = JSON.stringify((await call('ad-campaigns', { limit: 100 })).data)
    expect(mine).not.toContain('ar-other-c')
    expect(ids((await call('ad-campaigns', {}, cleared(OTHER))).data!.items, 'campaignId')).toEqual(['ar-other-c'])
  })
})

// ── ad-targets ───────────────────────────────────────────────────────────────────────────────────────

describe('A2 — ad-targets', () => {
  it('each target with the ids set-target-bid and the negative tools take, its bid, suppression and metrics', async () => {
    const data = (await call('ad-targets', { limit: 100 })).data!
    // Every target is enabled (the paused campaign's too: liveNow says it does not run). By campaign, ad group, text.
    expect(data.total).toBe(4)
    expect(ids(data.items, 'targetId')).toEqual(['ar-t2', 'ar-t1', 'ar-t3', 'ar-t4'])
    expect(data.items.find((i: Row) => i.targetId === 'ar-t4')).toMatchObject({ liveNow: false, campaignStatus: 'PAUSED' })
    const t1 = data.items.find((i: Row) => i.targetId === 'ar-t1')
    expect(t1).toMatchObject({
      text: 'race jacket', adGroupId: 'ar-g1', externalAdGroupId: 'EXT-G1', campaignId: 'ar-c1', externalCampaignId: 'EXT-C1',
      market: 'IT', currency: 'EUR', bidCents: 45, suppressed: false, liveNow: true,
      metrics: { measured: true, impressions: 400, clicks: 13, orders: 2, spendCents: 555, salesCents: 4321 },
    })
    const t2 = data.items.find((i: Row) => i.targetId === 'ar-t2')
    expect(t2).toMatchObject({ bidCents: 2, suppressed: true, suppressedFromBidCents: 61 })
    expect(data.items.find((i: Row) => i.targetId === 'ar-t3')).toMatchObject({ currency: 'GBP', externalCampaignId: 'EXT-C2' })
  })

  it('pages, and narrows to a campaign, an ad group, a market or a text', async () => {
    const whole = ids((await call('ad-targets', { status: 'all', limit: 100 })).data!.items, 'targetId')
    expect(whole.sort()).toEqual(['ar-t1', 'ar-t2', 'ar-t3', 'ar-t4'])
    const { items } = await walk('ad-targets', { status: 'all' }, 1)
    expect(ids(items, 'targetId').sort()).toEqual(whole.sort())
    expect(new Set(ids(items, 'targetId')).size).toBe(items.length)
    expect(ids((await call('ad-targets', { campaignId: 'ar-c1' })).data!.items, 'targetId').sort()).toEqual(['ar-t1', 'ar-t2'])
    expect(ids((await call('ad-targets', { adGroupId: 'ar-g2' })).data!.items, 'targetId')).toEqual(['ar-t3'])
    expect(ids((await call('ad-targets', { market: 'UK' })).data!.items, 'targetId')).toEqual(['ar-t3'])
    expect(ids((await call('ad-targets', { search: 'gloves' })).data!.items, 'targetId')).toEqual(['ar-t2'])
  })

  it('another business\'s campaign or ad group is not found', async () => {
    expect(await call('ad-targets', { campaignId: 'ar-other-c' })).toEqual({ ok: false, error: 'Campaign not found' })
    expect(await call('ad-targets', { adGroupId: 'ar-other-g' })).toEqual({ ok: false, error: 'Ad group not found' })
    expect(await call('ad-targets', { campaignId: 'ar-c2', adGroupId: 'ar-g1' })).toEqual({ ok: false, error: 'Ad group not found' })
  })
})

// ── ad-search-terms ──────────────────────────────────────────────────────────────────────────────────

describe('A2 — ad-search-terms', () => {
  it('wasteful terms by spend, then converting terms, each with the ids the negative and graduation tools take', async () => {
    const data = (await call('ad-search-terms', { limit: 100 })).data!
    expect(data.dataAsOf).toBe(ymd(dayBefore(3)))
    expect(data.items.map((t: Row) => [t.kind, t.query])).toEqual([
      ['wasteful', 'cheap helmet'], ['wasteful', 'winter boots'], ['converting', 'race jacket xl'],
    ])
    expect(data.items[0]).toMatchObject({
      query: 'cheap helmet', isAsin: false, campaignId: 'ar-c1', externalCampaignId: 'EXT-C1', campaignName: 'Alpha race IT',
      adGroupId: 'ar-g1', externalAdGroupId: 'EXT-G1', market: 'IT', currency: 'EUR', suggestedTool: 'create-negative-keyword',
      metrics: { clicks: 40, orders: 0, spendCents: 2150, salesCents: 0, acos: null },
    })
    expect(data.items[2]).toMatchObject({ suggestedTool: 'graduate-keyword', metrics: { orders: 3, salesCents: 8888 } })
    expect(data.items[1]).toMatchObject({ market: 'UK', currency: 'GBP' })
  })

  it('pages, and narrows by kind, campaign, market and text; another business\'s campaign is not found', async () => {
    const { items } = await walk('ad-search-terms', {}, 1)
    expect(items.map((t) => t.query)).toEqual(['cheap helmet', 'winter boots', 'race jacket xl'])
    expect((await call('ad-search-terms', { kind: 'converting' })).data!.items.map((t: Row) => t.query)).toEqual(['race jacket xl'])
    expect((await call('ad-search-terms', { campaignId: 'ar-c2' })).data!.items.map((t: Row) => t.query)).toEqual(['winter boots'])
    expect((await call('ad-search-terms', { market: 'IT', kind: 'wasteful' })).data!.items.map((t: Row) => t.query)).toEqual(['cheap helmet'])
    expect((await call('ad-search-terms', { search: 'JACKET' })).data!.items.map((t: Row) => t.query)).toEqual(['race jacket xl'])
    expect(await call('ad-search-terms', { campaignId: 'ar-other-c' })).toEqual({ ok: false, error: 'Campaign not found' })
  })
})

// ── ad-changes ───────────────────────────────────────────────────────────────────────────────────────

describe('A2 — ad-changes', () => {
  it('newest first, who and why, amounts apart from plain values, with the campaign named', async () => {
    const data = (await call('ad-changes', { limit: 100 })).data!
    expect(data.items.map((c: Row) => `${c.entity.id}:${c.field}`)).toEqual(['ar-t3:bid', 'ar-c1:dailyBudget', 'ar-t1:bid', 'ar-c3:status'])
    const budget = data.items[1]
    expect(budget).toMatchObject({
      source: 'operator', actor: 'user:u-ads', campaign: { id: 'ar-c1', name: 'Alpha race IT' },
      field: 'dailyBudget', fromAmount: '20.00', toAmount: '23.45', why: 'more budget for the weekend',
    })
    expect(budget).not.toHaveProperty('oldValue')
    expect(data.items[3]).toMatchObject({ field: 'status', oldValue: 'ENABLED', newValue: 'PAUSED' })
    expect(data.items[3]).not.toHaveProperty('fromAmount')
    expect(data.items[2]).toMatchObject({ source: 'automation', actor: 'automation:rule-abc', fromAmount: '40', toAmount: '45' })
    expect(data.dataAsOf).toBe(data.items[0].at)
  })

  it('pages with no change twice, and narrows to a campaign, a target or a source', async () => {
    const whole = ids((await call('ad-changes', { limit: 100 })).data!.items, 'changeId')
    const { items, pages } = await walk('ad-changes', {}, 1)
    expect(ids(items, 'changeId')).toEqual(whole)
    expect(pages).toBe(4)
    expect((await call('ad-changes', { campaignId: 'ar-c1' })).data!.items.map((c: Row) => c.entity.id)).toEqual(['ar-c1', 'ar-t1'])
    expect((await call('ad-changes', { targetId: 'ar-t3' })).data!.items.map((c: Row) => c.entity.id)).toEqual(['ar-t3'])
    expect((await call('ad-changes', { source: 'operator' })).data!.items.map((c: Row) => c.entity.id)).toEqual(['ar-c1', 'ar-c3'])
  })

  it('another business\'s campaign or target is not found', async () => {
    expect(await call('ad-changes', { campaignId: 'ar-other-c' })).toEqual({ ok: false, error: 'Campaign not found' })
    expect(await call('ad-changes', { targetId: 'ar-other-t' })).toEqual({ ok: false, error: 'Target not found' })
  })
})

// ── ad-recommendations ───────────────────────────────────────────────────────────────────────────────

describe('A2 — ad-recommendations', () => {
  it('the engines\' recommendations with the ids a change tool takes, then the rules\' pending suggestions', async () => {
    const data = (await call('ad-recommendations', { limit: 100 })).data!
    const negative = data.items.find((r: Row) => r.category === 'negative' && r.query === 'cheap helmet')
    expect(negative).toMatchObject({
      from: 'engine', campaignId: 'ar-c1', externalCampaignId: 'EXT-C1', externalAdGroupId: 'EXT-G1', adGroupId: 'ar-g1',
      suggestedTool: 'create-negative-keyword', impactCents: 2150, currency: 'EUR',
    })
    const graduate = data.items.find((r: Row) => r.category === 'graduate')
    expect(graduate).toMatchObject({ query: 'race jacket xl', suggestedTool: 'graduate-keyword', campaignId: 'ar-c1' })
    const rules = data.items.filter((r: Row) => r.from === 'rule')
    expect(rules.map((r: Row) => r.action).sort()).toEqual(['bid_down', 'pause_target'])
    expect(rules.find((r: Row) => r.action === 'bid_down')).toMatchObject({
      category: 'rule', rule: { id: 'rule-abc', name: 'Trim bleeders' }, targetId: 'ar-t1', campaignId: 'ar-c1', family: 'bids', proposedChange: { type: 'bid_down', value: 39 },
    })
    expect(rules.find((r: Row) => r.action === 'pause_target')!.noPause).toMatch(/never pauses/)
    // The rules come after every engine recommendation.
    expect(data.items.findIndex((r: Row) => r.from === 'rule')).toBe(data.items.length - rules.length)
  })

  it('an unsellable-product finding is shown, never as a pause', async () => {
    const retail = (await call('ad-recommendations', { category: 'retail' })).data!.items
    expect(retail).toEqual([expect.objectContaining({ category: 'retail', campaignId: 'ar-c2', title: 'Bravo boots UK — unsellable', noPause: expect.stringMatching(/never pauses/) })])
    expect(retail[0].title).not.toMatch(/pause/i)
  })

  it('pages, and narrows by category, campaign and market; another business\'s campaign is not found', async () => {
    const whole = (await call('ad-recommendations', { limit: 100 })).data!
    const { items } = await walk('ad-recommendations', {}, 2)
    expect(ids(items, 'recommendationId')).toEqual(ids(whole.items, 'recommendationId'))
    expect(whole.total).toBe(whole.items.length)
    const c2 = (await call('ad-recommendations', { campaignId: 'ar-c2', limit: 100 })).data!.items
    expect(new Set(c2.map((r: Row) => r.campaignId))).toEqual(new Set(['ar-c2']))
    expect(c2.map((r: Row) => r.category).sort()).toEqual(['negative', 'retail'])
    const uk = (await call('ad-recommendations', { market: 'UK', limit: 100 })).data!.items
    expect(ids(uk, 'recommendationId').sort()).toEqual(ids(c2, 'recommendationId').sort())
    expect((await call('ad-recommendations', { category: 'rule' })).data!.items.every((r: Row) => r.from === 'rule')).toBe(true)
    expect(await call('ad-recommendations', { campaignId: 'ar-other-c' })).toEqual({ ok: false, error: 'Campaign not found' })
  })
})

// ── eBay (A13) ───────────────────────────────────────────────────────────────────────────────────────

describe('A13 — ads-overview and ad-campaigns on eBay', () => {
  it('the overview per eBay market: its currency, accounts, totals, provisional days, the campaigns that cost most', async () => {
    const data = (await call('ads-overview', { channel: 'ebay' })).data!
    expect(data.channel).toBe('ebay')
    expect(data.dataAsOf).toBe(ymd(dayBefore(1)))
    expect(data.writes).toEqual({ mode: 'sandbox', note: expect.stringMatching(/nothing reaches eBay/) })
    expect(data.markets.map((m: Row) => m.market)).toEqual(['EBAY_DE', 'EBAY_GB', 'EBAY_IT'])
    const [de, gb, it_] = data.markets
    expect(de).toMatchObject({ currency: 'EUR', dataAsOf: null, campaigns: { total: 1 }, topCampaigns: [], days: [] })
    expect(gb).toMatchObject({
      currency: 'GBP', dataAsOf: ymd(dayBefore(4)),
      accounts: [{ connectionId: ebay.second, name: 'second-seller', active: true, campaigns: 1 }],
      totals: { impressions: 210, clicks: 9, soldQty: 2, spendCents: 5656, salesCents: 4545 },
      topCampaigns: [expect.objectContaining({ campaignId: 'ar-e2', externalCampaignId: 'EXT-ar-e2', fundingModel: 'COST_PER_CLICK', account: expect.objectContaining({ connectionId: ebay.second }) })],
    })
    expect(it_).toMatchObject({
      currency: 'EUR', campaigns: { total: 2, byStatus: { RUNNING: 1, ENDED: 1 } },
      accounts: [{ connectionId: ebay.primary, name: 'Main eBay', active: true, campaigns: 2 }],
      totals: { spendCents: 7171, salesCents: 9393 }, previous: { spendCents: 222, salesCents: 3333 },
    })
    expect(it_.days).toEqual([expect.objectContaining({ date: ymd(dayBefore(1)), provisional: true, spendCents: 7171 })])
    expect(data.findings.map((f: Row) => f.type)).toContain('rates_above_breakeven')
    expect(data.pacing).toHaveProperty('costPerClick')
    expect(JSON.stringify(data)).not.toContain('ar-other-e')
  })

  it('a short market code names the eBay site', async () => {
    expect((await call('ads-overview', { channel: 'ebay', market: 'it' })).data!.markets.map((m: Row) => m.market)).toEqual(['EBAY_IT'])
    expect((await call('ads-overview', { channel: 'ebay', market: 'UK' })).data!.markets.map((m: Row) => m.market)).toEqual(['EBAY_GB'])
  })

  it('each eBay campaign with its ids, its OWN account, its currency and window metrics; pages and filters', async () => {
    const data = (await call('ad-campaigns', { channel: 'ebay', limit: 100 })).data!
    expect(ids(data.items, 'campaignId')).toEqual(['ar-e4', 'ar-e2', 'ar-e3', 'ar-e1']) // by market, then name
    expect(data.items[0]).toMatchObject({ campaignId: 'ar-e4', currency: 'EUR', metrics: { spendCents: 0 } })
    expect(data.items[1]).toMatchObject({
      externalCampaignId: 'EXT-ar-e2', market: 'EBAY_GB', currency: 'GBP', fundingModel: 'COST_PER_CLICK', dailyBudgetCents: 1550,
      account: { connectionId: ebay.second, name: 'second-seller', active: true },
      metrics: { impressions: 210, clicks: 9, soldQty: 2, spendCents: 5656, salesCents: 4545 },
    })
    expect(data.items[3]).toMatchObject({ campaignId: 'ar-e1', currency: 'EUR', bidPercentage: 6.5, account: { connectionId: ebay.primary } })
    expect(data.writes.mode).toBe('sandbox')
    const { items } = await walk('ad-campaigns', { channel: 'ebay' }, 1)
    expect(ids(items, 'campaignId')).toEqual(['ar-e4', 'ar-e2', 'ar-e3', 'ar-e1'])
    expect(ids((await call('ad-campaigns', { channel: 'ebay', status: 'ended' })).data!.items, 'campaignId')).toEqual(['ar-e3'])
    expect(ids((await call('ad-campaigns', { channel: 'ebay', market: 'IT', search: 'general' })).data!.items, 'campaignId')).toEqual(['ar-e1'])
    expect(ids((await call('ad-campaigns', { channel: 'ebay' }, cleared(OTHER))).data!.items, 'campaignId')).toEqual(['ar-other-e'])
    // A cursor of the eBay list is not one of the Amazon list.
    const cursor = (await call('ad-campaigns', { channel: 'ebay', limit: 1 })).data!.nextCursor
    expect(await call('ad-campaigns', { limit: 1, cursor })).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
  })
})

describe('A13 gap — ad-changes and ad-recommendations on eBay', () => {
  it('the eBay change log: newest first, the campaign named, who made it, what it replaced and wrote, delivery', async () => {
    const data = (await call('ad-changes', { channel: 'ebay', limit: 100 })).data!
    expect(data.channel).toBe('ebay')
    expect(ids(data.items, 'changeId')).toEqual(['ea-3', 'ea-2', 'ea-1'])
    expect(data.items[1]).toMatchObject({ source: 'automation', action: 'update_budget', campaign: { id: 'ar-e2', name: 'UK priority' }, delivery: { state: 'SUCCESS', mode: 'live' } })
    expect(data.items[2]).toMatchObject({ source: 'operator', replaced: { bidPercentage: 6.5 }, wrote: { bidPercentage: 7.25 }, delivery: { mode: 'sandbox' } })
    expect(data.items[0]).toMatchObject({ source: 'external' })
    const { items } = await walk('ad-changes', { channel: 'ebay' }, 1)
    expect(ids(items, 'changeId')).toEqual(['ea-3', 'ea-2', 'ea-1'])
    expect(ids((await call('ad-changes', { channel: 'ebay', campaignId: 'ar-e1' })).data!.items, 'changeId')).toEqual(['ea-3', 'ea-1'])
    expect(ids((await call('ad-changes', { channel: 'ebay', source: 'automation' })).data!.items, 'changeId')).toEqual(['ea-2'])
    expect(await call('ad-changes', { channel: 'ebay', campaignId: 'ar-other-e' })).toEqual({ ok: false, error: 'Campaign not found' })
    expect(JSON.stringify((await call('ad-changes', { channel: 'ebay', limit: 100 })).data)).not.toContain('EXT-OTHER-E')
  })

  it('the eBay rules\' pending proposals as recommendations; a pause is information only', async () => {
    const data = (await call('ad-recommendations', { channel: 'ebay', limit: 100 })).data!
    expect(ids(data.items, 'proposalId').sort()).toEqual(['ep-1', 'ep-2'])
    const rate = data.items.find((r: Row) => r.proposalId === 'ep-1')
    expect(rate).toMatchObject({ recommendationId: 'ebay:ep-1', category: 'rule', kind: 'adjust_ad_rate', campaignId: 'ar-e1', listingId: 'L-77', market: 'EBAY_IT', proposedChange: { to: 5.75 }, why: { rule: 'rate above break-even' } })
    expect(data.items.find((r: Row) => r.proposalId === 'ep-2').noPause).toMatch(/never pauses/)
    expect(ids((await call('ad-recommendations', { channel: 'ebay', market: 'UK' })).data!.items, 'proposalId')).toEqual(['ep-2'])
    expect(ids((await call('ad-recommendations', { channel: 'ebay', campaignId: 'ar-e1' })).data!.items, 'proposalId')).toEqual(['ep-1'])
    expect((await call('ad-recommendations', { channel: 'ebay', category: 'bid' })).error).toMatch(/only category rule applies/)
    expect(await call('ad-recommendations', { channel: 'ebay', campaignId: 'ar-other-e' })).toEqual({ ok: false, error: 'Campaign not found' })
  })
})

// ── Money ────────────────────────────────────────────────────────────────────────────────────────────

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['ads-overview', {}],
  ['ad-campaigns', {}],
  ['ad-targets', { status: 'all' }],
  ['ad-search-terms', {}],
  ['ad-changes', {}],
  ['ad-recommendations', { limit: 100 }],
  ['ads-overview', { channel: 'ebay' }],
  ['ad-campaigns', { channel: 'ebay' }],
  ['ad-changes', { channel: 'ebay' }],
  ['ad-recommendations', { channel: 'ebay', limit: 100 }],
]

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out) }
  return out
}

describe('A2 — money a person may not see never comes back', () => {
  it('a person without the ad-spend permission gets the same answer minus exactly the money keys', async () => {
    for (const [tool, args] of CALLS) {
      const restricted = (key: string) =>
        Object.prototype.hasOwnProperty.call(RESTRICTED_FIELDS, key) || Object.prototype.hasOwnProperty.call(getTool(tool)!.restrictedFields ?? {}, key)
      const full = await call(tool, args, cleared())
      const partial = await call(tool, args, operator())
      expect(full.ok, `${tool}: ${full.error}`).toBe(true)
      expect(partial.ok, `${tool}: ${partial.error}`).toBe(true)
      const stripped = JSON.parse(JSON.stringify(full, (key, value) => (key && restricted(key) ? undefined : value)))
      expect({ tool, answer: partial }).toEqual({ tool, answer: stripped })
      expect({ tool, leaked: [...keysOf(partial)].filter(restricted) }).toEqual({ tool, leaked: [] })
      // Positive control: the money-cleared answer really carries money keys.
      expect({ tool, money: [...keysOf(full)].some(restricted) }).toEqual({ tool, money: true })
    }
  })

  it('no amount the cleared person sees appears anywhere in the operator\'s answer', async () => {
    const amounts = ['2110', '5678', '1234', '2345', '2150', '8888', '4321', '23.45', '20.00', 'more budget for the weekend', '7171', '9393', '5656', '4545', '1550', '7.25', '5.75', '3131']
    for (const [tool, args] of CALLS) {
      const text = JSON.stringify(await call(tool, args, operator()))
      expect({ tool, found: amounts.filter((amount) => text.includes(amount)) }).toEqual({ tool, found: [] })
    }
  })

  it('a reader needs ads.view: without it the read is refused', async () => {
    await expect(callTool(principal(A, [FEATURES.aiRun]), 'ad-campaigns', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})

// ── Cursors ──────────────────────────────────────────────────────────────────────────────────────────

describe('A2 — a cursor belongs to one list, one set of filters and one business', () => {
  it('refuses a changed cursor and one made for other filters, another tool or another business', async () => {
    const cursor = (await call('ad-campaigns', { limit: 1 })).data!.nextCursor as string
    expect(cursor).toBeTruthy()
    const refused = (answer: Answer) => expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    refused(await call('ad-campaigns', { limit: 1, cursor: `${cursor.slice(0, -2)}xx` }))
    refused(await call('ad-campaigns', { limit: 1, market: 'IT', cursor }))
    refused(await call('ad-targets', { limit: 1, cursor }))
    refused(await call('ad-campaigns', { limit: 1, cursor }, cleared(OTHER)))
    const ranked = (await call('ad-recommendations', { limit: 1 })).data!.nextCursor as string
    refused(await call('ad-recommendations', { limit: 1, category: 'bid', cursor: ranked }))
  })

  it('no cursor carries a money value: a keyset cursor holds names and times, a ranked one only a place', async () => {
    for (const [tool, args] of CALLS.filter(([name]) => name !== 'ads-overview')) {
      const cursor = (await call(tool, { ...args, limit: 1 })).data!.nextCursor as string
      expect({ tool, cursor: typeof cursor }).toEqual({ tool, cursor: 'string' })
      const { k } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k: unknown[] }
      const ranked = tool === 'ad-search-terms' || tool === 'ad-recommendations'
      expect({ tool, k: k.map((v) => typeof v) }).toEqual({ tool, k: ranked ? ['number'] : k.map(() => 'string') })
      if (ranked) expect(k[0]).toBe(0)
    }
  })
})

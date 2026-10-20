/**
 * SD reports below the campaign (2026-10-20) — Claude's reads of the Sponsored Display figures under the campaign, run
 * through the one door (call-tool.ts) against a real PostgreSQL with the production schema and the business-isolation
 * policies (PGlite). Every id is made up.
 *
 * Proven here: ad-targets gives a Display target its own SD figures (impressions, viewable impressions, clicks, CPC,
 * orders, units, spend, sales, ACoS, ROAS, detail page views, new-to-brand, after a click and after a view) over the
 * window, while a Sponsored Products target keeps its own; ad-groups measures a Display ad group and its product ads each
 * on its own; ad-purchased-products says what shoppers bought after an ad, most orders first, narrowed by campaign, ad
 * group or ASIN, paged; another business's ids read as not found and its lines never show; and a person without the
 * ad-spend money permission gets the same answers minus exactly the money keys.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

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
const OTHER = 'ws_sd_reports_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user', userId: 'u-sd-reports', label: 'SD reports test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId), via: 'claude',
  }
}
const cleared = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])
const operator = (workspaceId = A) => principal(workspaceId, [FEATURES.aiRun, FEATURES.adsView])

type Row = Record<string, any>
async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = cleared()): Promise<{ ok: boolean; error?: string; data?: Row }> {
  return (await callTool(who, tool, args)).visible as { ok: boolean; error?: string; data?: Row }
}

// The window's last day (yesterday, Rome) and the days before it.
const LAST = resolveRange({ windowDays: 1 }).untilStr
const dayBefore = (n: number) => {
  const d = new Date(`${LAST}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

const CAMPAIGN = '900000000000001'
const GROUP = '900000000000011'
const TARGET = '900000000000021'
const AD = '900000000000031'

/** One SD day of one entity: 14-day figures after a click or a view, and their after-a-click share. */
const sdDay = (entityType: string, entityId: string, localEntityId: string | null, date: Date, k: number) => ({
  profileId: 'p-it', marketplace: 'IT', date, entityType, entityId, localEntityId, campaignId: CAMPAIGN, adGroupId: GROUP, currencyCode: 'EUR',
  impressions: 1000 * k, viewableImpressions: 700 * k, clicks: 10 * k, costMicros: BigInt(5_000_000 * k),
  sales14dCents: 4000 * k, salesClicks14dCents: 1500 * k, orders14d: 4 * k, ordersClicks14d: k, units14d: 5 * k, unitsClicks14d: k,
  detailPageViews14d: 30 * k, detailPageViewsClicks14d: 10 * k,
  ntbOrders14d: 2 * k, ntbOrdersClicks14d: k, ntbSalesCents14d: 2000 * k, ntbSalesClicksCents14d: 1000 * k, ntbUnits14d: 2 * k, ntbUnitsClicks14d: k,
  reportedAt: new Date(),
})
const bought = (date: Date, purchasedAsin: string, orders: number, ordersClicks: number | null, extra: Record<string, unknown> = {}) => ({
  profileId: 'p-it', marketplace: 'IT', date, campaignId: CAMPAIGN, adGroupId: GROUP, promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1', purchasedAsin,
  currencyCode: 'EUR', sales14dCents: orders * 2500, salesClicks14dCents: ordersClicks == null ? null : ordersClicks * 2500,
  orders14d: orders, ordersClicks14d: ordersClicks, units14d: orders, unitsClicks14d: ordersClicks, ...extra,
})

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(A, async () => {
    const db = database.client
    await db.campaign.create({ data: { id: 'c-sd', name: 'Display IT', type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: CAMPAIGN, dailyBudget: '10.00', startDate: dayBefore(200) } as never })
    await db.campaign.create({ data: { id: 'c-sp', name: 'Products IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: '900000000000002', dailyBudget: '10.00', startDate: dayBefore(200) } as never })
    await db.adGroup.create({ data: { id: 'g-sd', campaignId: 'c-sd', name: 'Display group', externalAdGroupId: GROUP } })
    await db.adGroup.create({ data: { id: 'g-sp', campaignId: 'c-sp', name: 'Products group', externalAdGroupId: '900000000000012' } })
    await db.adTarget.create({ data: { id: 't-sd', adGroupId: 'g-sd', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0FXTEST09', externalTargetId: TARGET, bidCents: 80 } })
    await db.adTarget.create({ data: { id: 't-sp', adGroupId: 'g-sp', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test keyword', externalTargetId: '900000000000022', bidCents: 60 } })
    await db.adProductAd.create({ data: { id: 'pa-sd', adGroupId: 'g-sd', asin: 'B0FXTEST01', sku: 'SKU-TEST-1', externalAdId: AD } })
    await db.amazonAdsSdDailyPerformance.createMany({
      data: [
        sdDay('AD_TARGET', TARGET, 't-sd', dayBefore(0), 1),
        sdDay('AD_TARGET', TARGET, 't-sd', dayBefore(3), 2),
        // Outside a 30-day window: never counted in one.
        sdDay('AD_TARGET', TARGET, 't-sd', dayBefore(45), 50),
        sdDay('AD_GROUP', GROUP, 'g-sd', dayBefore(1), 3),
        sdDay('PRODUCT_AD', AD, 'pa-sd', dayBefore(1), 1),
      ],
    })
    // A Sponsored Products target's own figures (the SP targeting report's table).
    await db.amazonAdsDailyPerformance.create({ data: { profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayBefore(2), entityType: 'AD_TARGET', entityId: '900000000000022', localEntityId: 't-sp', impressions: 300, clicks: 6, costMicros: 3_000_000n, currencyCode: 'EUR', sales7dCents: 2000, orders7d: 1, reportedAt: new Date() } })
    await db.amazonAdsSdPurchasedProduct.createMany({
      data: [
        bought(dayBefore(1), 'B0FXTEST04', 3, 1), bought(dayBefore(2), 'B0FXTEST04', 2, 2),
        bought(dayBefore(1), 'B0FXTEST05', 1, 1),
        // A cpc campaign's line: Amazon sends the after-a-click figures only.
        { ...bought(dayBefore(1), 'B0FXTEST06', 0, 4), orders14d: null, units14d: null, sales14dCents: null },
      ],
    })
  })
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Other business', 'active', 'ads', $1, CURRENT_TIMESTAMP)`, [OTHER])
  await inside(OTHER, async () => {
    const db = database.client
    await db.campaign.create({ data: { id: 'c-sd-other', name: 'Other display', type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: '900000000000901', dailyBudget: '10.00', startDate: dayBefore(200) } as never })
    await db.amazonAdsSdPurchasedProduct.create({ data: { ...bought(dayBefore(1), 'B0FXTEST99', 9, 9), profileId: 'p-other', campaignId: '900000000000901', adGroupId: '900000000000911' } })
  })
}, 60_000)
afterAll(async () => { await database?.close() })

describe('ad-targets: a Sponsored Display target carries its own SD figures', () => {
  it('summed over the window, with viewable impressions, ROAS, CPC and after a click / after a view; an SP target keeps its own', async () => {
    const answer = await inside(A, () => call('ad-targets', { market: 'IT', status: 'all', days: 30 }))
    expect(answer.ok, answer.error).toBe(true)
    const sd = answer.data!.items.find((i: Row) => i.targetId === 't-sd')
    expect(sd).toMatchObject({ adProduct: 'SPONSORED_DISPLAY', externalCampaignId: CAMPAIGN })
    // Days 0 and 3 (k = 1 and 2); the day 45 days back is outside the window.
    expect(sd.metrics).toEqual({
      measured: true, impressions: 3000, viewableImpressions: 2100, clicks: 30, orders: 12, units: 15,
      spendCents: 1500, salesCents: 12000, cpcCents: 50, acos: 0.125, roas: 8, detailPageViews: 90,
      newToBrand: { orders: 6, units: 6, salesCents: 6000 },
      afterClick: { orders: 3, units: 3, salesCents: 4500, detailPageViews: 30, newToBrand: { orders: 3, units: 3, salesCents: 3000 } },
      afterView: { orders: 9, units: 12, salesCents: 7500, detailPageViews: 60, newToBrand: { orders: 3, units: 3, salesCents: 3000 } },
    })
    expect(answer.data!.display).toEqual({ dataAsOf: LAST, attribution: expect.stringContaining('14-day attribution') })
    const sp = answer.data!.items.find((i: Row) => i.targetId === 't-sp')
    expect(sp.metrics).toEqual({ measured: true, impressions: 300, clicks: 6, orders: 1, spendCents: 300, salesCents: 2000, cpcCents: 50, acos: 0.15 })
  })

  it('a person without the money permission gets the same figures minus exactly the money', async () => {
    const answer = await inside(A, () => call('ad-targets', { campaignId: 'c-sd', status: 'all' }, operator()))
    const metrics = answer.data!.items[0].metrics
    expect(metrics).toEqual({
      measured: true, impressions: 3000, viewableImpressions: 2100, clicks: 30, orders: 12, units: 15, detailPageViews: 90,
      newToBrand: { orders: 6, units: 6 },
      afterClick: { orders: 3, units: 3, detailPageViews: 30, newToBrand: { orders: 3, units: 3 } },
      afterView: { orders: 9, units: 12, detailPageViews: 60, newToBrand: { orders: 3, units: 3 } },
    })
  })
})

describe('ad-groups: a Sponsored Display ad group and its product ads, each measured on its own', () => {
  it('the ad group\'s and the product ad\'s own SD figures, over the window\'s complete days', async () => {
    const answer = await inside(A, () => call('ad-groups', { campaignId: 'c-sd', days: 30 }))
    expect(answer.ok, answer.error).toBe(true)
    const group = answer.data!.items[0]
    expect(group.metrics).toMatchObject({ measured: true, impressions: 3000, viewableImpressions: 2100, clicks: 30, orders: 12, spendCents: 1500, salesCents: 12000, acos: 0.125, roas: 8, cpcCents: 50 })
    expect(group.productAds).toEqual([expect.objectContaining({ productAdId: 'pa-sd', asin: 'B0FXTEST01', metrics: expect.objectContaining({ measured: true, impressions: 1000, orders: 4, salesCents: 4000 }) })])
    const range = resolveRange({ windowDays: 30 })
    expect(answer.data!.window).toMatchObject({ days: 30, from: range.sinceStr, to: range.untilStr, dataAsOf: ymd(dayBefore(1)) })
    // Without the money permission: the same, minus the money keys (cpcCents included).
    const noMoney = await inside(A, () => call('ad-groups', { campaignId: 'c-sd', days: 30 }, operator()))
    expect(noMoney.data!.items[0].metrics).not.toHaveProperty('cpcCents')
    expect(noMoney.data!.items[0].metrics).not.toHaveProperty('spendCents')
    expect(noMoney.data!.items[0].metrics).toMatchObject({ impressions: 3000, orders: 12 })
  })
})

const ymd = (d: Date) => d.toISOString().slice(0, 10)

describe('ad-purchased-products: what shoppers bought after a Display ad', () => {
  it('is a read for Claude, offered with ads.view', () => {
    expect(getTool('ad-purchased-products')).toMatchObject({ readOnly: true, requires: ['ads.view'] })
  })

  it('one line per advertised product and product bought, summed over the window, most orders first', async () => {
    const answer = await inside(A, () => call('ad-purchased-products', {}))
    expect(answer.ok, answer.error).toBe(true)
    const lines = answer.data!.items.map((i: Row) => [i.boughtAsin, i.clickOrView.orders, i.afterClick.orders, i.afterView.orders])
    // The cpc line ranks by its after-a-click orders (Amazon sent no click-or-view figure for it).
    expect(lines).toEqual([['B0FXTEST04', 5, 3, 2], ['B0FXTEST06', null, 4, null], ['B0FXTEST05', 1, 1, 0]])
    expect(answer.data!.items[0]).toMatchObject({
      campaignId: 'c-sd', externalCampaignId: CAMPAIGN, campaignName: 'Display IT', adGroupId: 'g-sd', externalAdGroupId: GROUP, adGroupName: 'Display group',
      market: 'IT', currency: 'EUR', advertised: { asin: 'B0FXTEST01', sku: 'SKU-TEST-1' },
      clickOrView: { orders: 5, units: 5, salesCents: 12500 }, afterClick: { orders: 3, units: 3, salesCents: 7500 }, afterView: { orders: 2, units: 2, salesCents: 5000 },
    })
    expect(answer.data!).toMatchObject({ total: 3, dataAsOf: ymd(dayBefore(1)), nextCursor: null })
    // Another business's line never shows.
    expect(JSON.stringify(answer.data)).not.toContain('B0FXTEST99')
  })

  it('narrows by ASIN, by campaign and by ad group; pages with a cursor, no line twice', async () => {
    const byAsin = await inside(A, () => call('ad-purchased-products', { asin: 'b0fxtest05' }))
    expect(byAsin.data!.items.map((i: Row) => i.boughtAsin)).toEqual(['B0FXTEST05'])
    const byGroup = await inside(A, () => call('ad-purchased-products', { adGroupId: 'g-sd' }))
    expect(byGroup.data!.total).toBe(3)
    // The read names the campaign it was narrowed to.
    expect(byGroup.data!.campaign).toEqual({ campaignId: 'c-sd', externalCampaignId: CAMPAIGN, campaignName: 'Display IT', market: 'IT', currency: 'EUR' })
    const byOtherCampaign = await inside(A, () => call('ad-purchased-products', { campaignId: 'c-sp' }))
    expect(byOtherCampaign.data!.items).toEqual([])
    const first = await inside(A, () => call('ad-purchased-products', { campaignId: 'c-sd', limit: 2 }))
    expect(first.data!.items).toHaveLength(2)
    const second = await inside(A, () => call('ad-purchased-products', { campaignId: 'c-sd', limit: 2, cursor: first.data!.nextCursor }))
    expect([...first.data!.items, ...second.data!.items].map((i: Row) => i.lineId)).toHaveLength(new Set([...first.data!.items, ...second.data!.items].map((i: Row) => i.lineId)).size)
    expect(second.data!.items.map((i: Row) => i.boughtAsin)).toEqual(['B0FXTEST05'])
    expect(second.data!.nextCursor).toBeNull()
  })

  it('another business\'s campaign reads as not found; without money the amounts are gone, the counts stay', async () => {
    expect(await inside(A, () => call('ad-purchased-products', { campaignId: 'c-sd-other' }))).toEqual({ ok: false, error: 'Campaign not found' })
    const noMoney = await inside(A, () => call('ad-purchased-products', {}, operator()))
    expect(noMoney.data!.items[0]).toMatchObject({ clickOrView: { orders: 5, units: 5 }, afterClick: { orders: 3, units: 3 } })
    expect(noMoney.data!.items[0].clickOrView).not.toHaveProperty('salesCents')
    // Inside the other business its own line reads (control).
    const theirs = await inside(OTHER, () => call('ad-purchased-products', {}, cleared(OTHER)))
    expect(theirs.data!.items.map((i: Row) => i.boughtAsin)).toEqual(['B0FXTEST99'])
  })
})

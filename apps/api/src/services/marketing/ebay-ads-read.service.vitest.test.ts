/**
 * MCP full control A13 — the eBay Promoted Listings reads moved out of `routes/ebay-ads.routes.ts` into
 * `ebay-ads-read.service.ts` with no behaviour change (proven byte-equal against the code before the move on 15 route
 * calls when it was made). These arms keep it so:
 *   · the service answers what the console always read (window sums, the window before, daily points, the grid);
 *   · each of the three routes answers exactly the service's result (T4: and the campaign detail page's);
 *   · each campaign names its OWN eBay account (P4.5a), each market its currency, and the newest day of data is read.
 * PGlite with the production schema.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { resolveRange } from '../ads-core/date-range.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))

import {
  ebayAdsActions,
  ebayPendingProposals,
  ebayAdsCampaigns,
  ebayAdsSummary,
  ebayAdsTrend,
  ebayCampaignAccounts,
  ebayCampaignCensus,
  ebayCampaignDetail,
  ebayMarketCurrencies,
  ebayPerformanceAsOf,
} from './ebay-ads-read.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const TODAY = resolveRange({ windowDays: 1 }).untilStr
const dayBefore = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)
let app: FastifyInstance
const conn = { primary: '', second: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    conn.primary = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, isPrimary: true, accountLabel: 'Main eBay', externalAccountId: 'SELLER-MAIN' } as never })).id
    conn.second = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, displayName: 'second-seller', externalAccountId: 'SELLER-TWO' } as never })).id
    const campaign = (id: string, connectionId: string, marketplace: string, name: string, extra: Record<string, unknown> = {}) =>
      db.ebayCampaign.create({ data: { id, channelConnectionId: connectionId, marketplace, externalCampaignId: `EXT-${id}`, name, fundingStrategy: 'COST_PER_SALE', fundingModel: 'COST_PER_SALE', status: 'RUNNING', startDate: dayBefore(100), ...extra } as never })
    await campaign('eb-1', conn.primary, 'EBAY_IT', 'Italy general', { bidPercentage: '6.50' })
    await campaign('eb-2', conn.second, 'EBAY_GB', 'UK priority', { fundingStrategy: 'COST_PER_CLICK', fundingModel: 'COST_PER_CLICK', dailyBudget: '15.50', budgetCurrency: 'GBP' })
    await campaign('eb-3', conn.primary, 'EBAY_IT', 'Italy old', { status: 'ENDED' })
    const perf = (data: Record<string, unknown>) =>
      db.ebayAdsDailyPerformance.create({ data: { fundingModel: 'COST_PER_SALE', entityType: 'CAMPAIGN', currency: 'EUR', reportedAt: new Date(), ...data } as never })
    await perf({ marketplace: 'EBAY_IT', entityId: 'EXT-eb-1', date: dayBefore(1), impressions: 1000, clicks: 40, adFeesCents: 777, salesCents: 9999, soldQty: 3 })
    await perf({ marketplace: 'EBAY_IT', entityId: 'EXT-eb-1', date: dayBefore(4), impressions: 500, clicks: 10, adFeesCents: 123, salesCents: 0, soldQty: 0 })
    await perf({ marketplace: 'EBAY_IT', entityId: 'EXT-eb-1', date: dayBefore(12), impressions: 300, clicks: 6, adFeesCents: 222, salesCents: 3333, soldQty: 1 })
    await perf({ marketplace: 'EBAY_GB', fundingModel: 'COST_PER_CLICK', entityId: 'EXT-eb-2', date: dayBefore(2), impressions: 200, clicks: 9, adFeesCents: 555, salesCents: 4444, soldQty: 2, currency: 'GBP' })
    await db.ebayAd.create({ data: { campaignId: 'eb-1', marketplace: 'EBAY_IT', listingId: 'L-1', status: 'ACTIVE' } as never })
    await db.ebayAd.create({ data: { campaignId: 'eb-1', marketplace: 'EBAY_IT', listingId: 'L-2', status: 'STALE' } as never })
    const action = (entityId: string, actionType: string, userId: string, mode: string, at: string) =>
      db.campaignAction.create({ data: { channel: 'EBAY', entityType: 'CAMPAIGN', entityId, actionType, userId, payloadBefore: { rate: 5 }, payloadAfter: { rate: 6, _mode: mode }, channelResponseStatus: 'SUCCESS', createdAt: new Date(at) } as never })
    await action('EXT-eb-1', 'set_ad_rate', 'user:u1', 'sandbox', '2026-09-20T10:00:00Z')
    await action('EXT-eb-2', 'update_budget', 'automation:ebay-ads', 'live', '2026-09-21T10:00:00Z')
    await action('EXT-eb-1', 'drift_accept', 'user:u1', 'accept', '2026-09-22T10:00:00Z')
    await db.ebayAdsProposal.create({ data: { kind: 'adjust_ad_rate', entityRef: { campaignId: 'eb-1' }, proposedAction: {}, proposedKey: 'k1' } as never })
    await db.ebayAdsProposal.create({ data: { kind: 'adjust_bid', entityRef: { campaignId: 'eb-2' }, proposedAction: {}, proposedKey: 'k2', status: 'APPLIED' } as never })
  })
  app = Fastify()
  app.addHook('preHandler', (_r, _p, done) => { withWorkspace(business, done) })
  const { default: ebayAdsRoutes } = await import('../../routes/ebay-ads.routes.js')
  await app.register(ebayAdsRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

const WEEK = { startDate: ymd(dayBefore(6)), endDate: TODAY }

describe('ebayAdsSummary / ebayAdsTrend / ebayAdsCampaigns — what the console reads', () => {
  it('the summary sums the window and the window before it, per market when asked', async () => {
    const it_ = await inside(() => ebayAdsSummary({ ...WEEK, marketplace: 'EBAY_IT' }))
    expect(it_.current).toMatchObject({ impressions: 1500, clicks: 50, adFeesCents: 900, salesCents: 9999, soldQty: 3 })
    expect(it_.prior).toMatchObject({ impressions: 300, clicks: 6, adFeesCents: 222, salesCents: 3333 })
    expect(it_.window).toMatchObject({ since: WEEK.startDate, until: TODAY, days: 7 })
    expect(it_.currency).toBe('EUR')
    const all = await inside(() => ebayAdsSummary(WEEK))
    expect(all.campaignCounts).toEqual({ RUNNING: 2, ENDED: 1 })
  })

  it('AM-21 — never adds GBP to EUR: across markets the money is one total per currency, the counts still add', async () => {
    const all = await inside(() => ebayAdsSummary(WEEK))
    // Was { adFeesCents: 1455, salesCents: 14443 }: 900 euro cents + 555 pence printed as one euro amount.
    expect(all.currency).toBeNull()
    expect(all.current).toMatchObject({ adFeesCents: null, salesCents: null, acosPct: null, avgCpcCents: null, impressions: 1700, clicks: 59, soldQty: 5 })
    expect(all.byCurrency.map((c) => [c.currency, c.current.adFeesCents, c.current.salesCents, c.prior.adFeesCents])).toEqual([
      ['EUR', 900, 9999, 222], ['GBP', 555, 4444, 0],
    ])
    expect(all.deltas.adFeesPct).toBeNull()
    const gb = await inside(() => ebayAdsSummary({ ...WEEK, marketplace: 'EBAY_GB' }))
    expect([gb.currency, gb.current.adFeesCents]).toEqual(['GBP', 555])
    // A market with no row in the window takes its currency from its older rows; none at all: EUR, every amount 0.
    expect((await inside(() => ebayAdsSummary({ startDate: '2020-01-01', endDate: '2020-01-07', marketplace: 'EBAY_GB' }))).currency).toBe('GBP')
    expect((await inside(() => ebayAdsSummary({ ...WEEK, marketplace: 'EBAY_FR' }))).currency).toBe('EUR')
  })

  it('AM-15 — the campaign count follows the market', async () => {
    expect((await inside(() => ebayAdsSummary({ ...WEEK, marketplace: 'EBAY_IT' }))).campaignCounts).toEqual({ RUNNING: 1, ENDED: 1 })
    expect((await inside(() => ebayAdsSummary({ ...WEEK, marketplace: 'EBAY_GB' }))).campaignCounts).toEqual({ RUNNING: 1 })
  })

  it('AM-21 — a trend over two currencies carries counts per day and no money', async () => {
    const all = await inside(() => ebayAdsTrend(WEEK))
    expect(all.currency).toBeNull()
    expect(all.points.map((p) => [p.date, p.clicks, p.adFeesCents])).toEqual([
      [ymd(dayBefore(4)), 10, null], [ymd(dayBefore(2)), 9, null], [ymd(dayBefore(1)), 40, null],
    ])
    const gb = await inside(() => ebayAdsTrend({ ...WEEK, marketplace: 'EBAY_GB' }))
    expect([gb.currency, gb.points.map((p) => p.adFeesCents)]).toEqual(['GBP', [555]])
  })

  it('the trend has one point per reported day', async () => {
    const trend = await inside(() => ebayAdsTrend({ ...WEEK, marketplace: 'EBAY_IT' }))
    expect(trend.points.map((p) => [p.date, p.adFeesCents])).toEqual([[ymd(dayBefore(4)), 123], [ymd(dayBefore(1)), 777]])
    expect(trend.currency).toBe('EUR')
  })

  it('the grid carries each campaign with its window metrics and ad counts', async () => {
    const grid = await inside(() => ebayAdsCampaigns(WEEK))
    const byId = Object.fromEntries(grid.campaigns.map((c) => [c.id, c]))
    expect(Object.keys(byId).sort()).toEqual(['eb-1', 'eb-2', 'eb-3'])
    expect(byId['eb-1']).toMatchObject({ externalCampaignId: 'EXT-eb-1', marketplace: 'EBAY_IT', bidPercentage: 6.5, ads: { total: 2, stale: 1, hidden: 0 }, metrics: { adFeesCents: 900, salesCents: 9999 } })
    expect(byId['eb-2']).toMatchObject({ dailyBudgetCents: 1550, budgetCurrency: 'GBP', fundingModel: 'COST_PER_CLICK', metrics: { adFeesCents: 555 } })
    expect(byId['eb-3'].metrics).toMatchObject({ adFeesCents: 0, clicks: 0 })
    expect((await inside(() => ebayAdsCampaigns({ ...WEEK, marketplace: 'EBAY_GB' }))).campaigns.map((c) => c.id)).toEqual(['eb-2'])
    // AM-21 — the grid's one currency only when its rows share one.
    expect(grid.currency).toBeNull()
    expect((await inside(() => ebayAdsCampaigns({ ...WEEK, marketplace: 'EBAY_GB' }))).currency).toBe('GBP')
  })
})

describe('the three routes answer exactly the service', () => {
  const queries = ['', '?marketplace=EBAY_IT', '?preset=last30', `?startDate=${WEEK.startDate}&endDate=${WEEK.endDate}&marketplace=EBAY_GB`, '?marketplace=all']
  const reads = { summary: ebayAdsSummary, trend: ebayAdsTrend, campaigns: ebayAdsCampaigns } as const
  for (const [path, read] of Object.entries(reads)) {
    for (const query of queries) {
      it(`GET /ebay-ads/${path}${query}`, async () => {
        const response = await app.inject({ method: 'GET', url: `/api/ebay-ads/${path}${query}` })
        expect(response.statusCode).toBe(200)
        const q = Object.fromEntries(new URLSearchParams(query))
        expect(response.payload).toBe(JSON.stringify(await inside(() => read(q))))
      })
    }
  }
})

describe('GET /ebay-ads/campaigns/:id answers exactly the service (T4: moved for ebay-ad-details)', () => {
  for (const [id, query] of [['eb-1', ''], ['eb-1', `?startDate=${WEEK.startDate}&endDate=${WEEK.endDate}`], ['eb-2', '?preset=last30'], ['eb-3', '']]) {
    it(`GET /ebay-ads/campaigns/${id}${query}`, async () => {
      const response = await app.inject({ method: 'GET', url: `/api/ebay-ads/campaigns/${id}${query}` })
      expect(response.statusCode).toBe(200)
      expect(response.payload).toBe(JSON.stringify(await inside(() => ebayCampaignDetail(id, Object.fromEntries(new URLSearchParams(query))))))
    })
  }
  it('the page\'s ads with their own rate, and an unknown campaign is 404 (the service says null)', async () => {
    const detail = await inside(() => ebayCampaignDetail('eb-1', WEEK))
    expect(detail!.ads.map((a) => [a.listingId, a.status, a.bidPercentage]).sort()).toEqual([['L-1', 'ACTIVE', null], ['L-2', 'STALE', null]])
    expect(detail!.campaign).toMatchObject({ id: 'eb-1', bidPercentage: 6.5, fundingModel: 'COST_PER_SALE' })
    expect(await inside(() => ebayCampaignDetail('eb-missing', WEEK))).toBeNull()
    const response = await app.inject({ method: 'GET', url: '/api/ebay-ads/campaigns/eb-missing' })
    expect([response.statusCode, response.json()]).toEqual([404, { error: 'campaign not found' }])
  })
})

describe('GET /ebay-ads/actions answers exactly the service (moved with the eBay change log, proven byte-equal on 6 calls)', () => {
  for (const query of ['', '?limit=2', '?entityId=EXT-eb-1', '?actionType=update_budget', '?before=2026-09-22T00:00:00Z']) {
    it(`GET /ebay-ads/actions${query}`, async () => {
      const response = await app.inject({ method: 'GET', url: `/api/ebay-ads/actions${query}` })
      expect(response.statusCode).toBe(200)
      expect(response.payload).toBe(JSON.stringify(await inside(() => ebayAdsActions(Object.fromEntries(new URLSearchParams(query))))))
    })
  }
  it('names each campaign and classifies who made the change', async () => {
    const { actions } = await inside(() => ebayAdsActions({}))
    expect(actions.map((a) => [a.actionType, a.campaignId, a.source])).toEqual([
      ['drift_accept', 'eb-1', 'external_accepted'], ['update_budget', 'eb-2', 'automation'], ['set_ad_rate', 'eb-1', 'operator'],
    ])
  })
})

describe('for the tools: accounts, currencies, freshness', () => {
  it('each campaign names its OWN account — the second account\'s campaign is never the primary\'s', async () => {
    const accounts = await inside(() => ebayCampaignAccounts(['eb-1', 'eb-2', 'eb-3', 'eb-missing']))
    expect(accounts.get('eb-2')).toEqual({ connectionId: conn.second, name: 'second-seller', active: true })
    expect(accounts.get('eb-1')).toEqual({ connectionId: conn.primary, name: 'Main eBay', active: true })
    expect(accounts.get('eb-3')?.connectionId).toBe(conn.primary)
    expect(accounts.has('eb-missing')).toBe(false)
    expect((await inside(() => ebayCampaignAccounts([]))).size).toBe(0)
  })

  it('the rules\' pending proposals only', async () => {
    expect((await inside(() => ebayPendingProposals())).map((p) => p.kind)).toEqual(['adjust_ad_rate'])
  })

  it('each market its reported currency; the newest day overall and per market; the census per market', async () => {
    expect(Object.fromEntries(await inside(() => ebayMarketCurrencies()))).toEqual({ EBAY_IT: 'EUR', EBAY_GB: 'GBP' })
    expect(await inside(() => ebayPerformanceAsOf())).toBe(ymd(dayBefore(1)))
    expect(await inside(() => ebayPerformanceAsOf('EBAY_GB'))).toBe(ymd(dayBefore(2)))
    expect(await inside(() => ebayPerformanceAsOf('EBAY_FR'))).toBeNull()
    const census = await inside(() => ebayCampaignCensus('EBAY_IT'))
    expect(census.map((c) => [c.id, c.status, c.channelConnectionId]).sort()).toEqual([['eb-1', 'RUNNING', conn.primary], ['eb-3', 'ENDED', conn.primary]])
  })
})

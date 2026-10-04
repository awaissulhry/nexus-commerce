/**
 * 4f (review 4.6) — Bid rules see every measured keyword.
 *
 * The defect: builder Bid rules rode KEYWORD_HIGH_ACOS, which offers only converting keywords at
 * ≥20% ACoS (8 of 3,155 targets on the account), so "Scale winners" (ACoS < 20%) and "Floor
 * zero-sale spenders" (Sales = 0) could never match. TARGET_PERFORMANCE offers every ENABLED
 * positive target with a click in the settled window, minus suppressed ones, ACoS absent without
 * sales. Real PostgreSQL (PGlite), the real emitter, the real preview and the real Simulate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

const { buildTargetPerformanceContexts, buildHighAcosKeywordContexts, targetPerformancePasses, simulateOneRule } = await import('./advertising-rule-evaluator.job.js')
const { previewBidRule } = await import('../services/advertising/ads-rule-preview.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
/** UTC midnight, `n` days ago — the default window is today−20 … today−7 (6c: Sponsored Products' 7-day attribution lag). */
const daysAgo = (n: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d }

/** The two Bid starters that could never fire, copied from RuleBuilder.tsx `STARTERS.bid`. */
const SCALE_WINNERS = [{ conditions: [{ metric: 'ACOS', op: 'lt', value: '20' }, { metric: 'Orders', op: 'gte', value: '2' }], action: { op: 'incPct', value: '10' } }]
const FLOOR_ZERO_SALE = [{ conditions: [{ metric: 'Spend', op: 'gte', value: '5' }, { metric: 'Clicks', op: 'gte', value: '10' }, { metric: 'Sales', op: 'eq', value: '0' }], action: { op: 'set', value: '0.05' } }]

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const campaign = (id: string, name: string, extra: Record<string, unknown> = {}) => db().campaign.create({
      data: { id, name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: daysAgo(90), ...extra },
    })
    await campaign('c-a', 'Alpha IT')
    await campaign('c-b', 'Beta IT')
    await campaign('c-sup', 'Suppressed IT', { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'test' })
    await campaign('c-sb', 'Brands IT', { type: 'SB', adProduct: 'SPONSORED_BRANDS' })
    for (const c of ['a', 'b', 'sup', 'sb']) {
      await db().adGroup.create({ data: { id: `g-${c}`, campaignId: `c-${c}`, name: `Group ${c}`, externalAdGroupId: `EXT-g-${c}` } })
    }
    const target = (id: string, group: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) => db().adTarget.create({
      data: { id, adGroupId: group, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id}`, ...extra },
    })
    const perf = (localEntityId: string, ago: number, m: { clicks: number; impressions?: number; costCents?: number; salesCents?: number; orders?: number }, adProduct = 'SPONSORED_PRODUCTS') =>
      db().amazonAdsDailyPerformance.create({
        data: {
          profileId: 'P-IT', marketplace: 'IT', adProduct, date: daysAgo(ago), entityType: 'AD_TARGET',
          entityId: `EXT-${localEntityId}`, localEntityId, currencyCode: 'EUR', reportedAt: new Date(),
          clicks: m.clicks, impressions: m.impressions ?? m.clicks * 20, costMicros: BigInt((m.costCents ?? 0) * 10_000),
          sales7dCents: m.salesCents ?? 0, orders7d: m.orders ?? 0,
        },
      })
    await target('t-win', 'g-a', 'race jacket', 45); await perf('t-win', 10, { clicks: 10, costCents: 400, salesCents: 2500, orders: 3 })
    await target('t-waste', 'g-a', 'cheap gloves', 40); await perf('t-waste', 10, { clicks: 12, costCents: 600 })
    await target('t-b', 'g-b', 'beta jacket', 30); await perf('t-b', 11, { clicks: 4, costCents: 100, salesCents: 1000, orders: 1 })
    // Not offered: no click · clicks only in the attribution tail (6c: 4 days old, inside the old 2-day cut) · a Sponsored
    // Brands row 10 days old (its window ends 14 days ago) · outside 14 days · the three suppressions · paused · negative.
    await target('t-noclick', 'g-a', 'winter boots', 50); await perf('t-noclick', 10, { clicks: 0, impressions: 300 })
    await target('t-recent', 'g-a', 'summer boots', 50); await perf('t-recent', 4, { clicks: 9, costCents: 200 })
    await target('t-old', 'g-a', 'leather jacket', 50); await perf('t-old', 25, { clicks: 5, costCents: 100 })
    await target('t-sb', 'g-sb', 'brand jacket', 50); await perf('t-sb', 10, { clicks: 7, costCents: 250 }, 'SPONSORED_BRANDS')
    await target('t-flag', 'g-a', 'helmet', 2, { suppressedFromBidCents: 60 }); await perf('t-flag', 10, { clicks: 8, costCents: 300 })
    await target('t-low', 'g-a', 'visor', 3); await perf('t-low', 10, { clicks: 8, costCents: 300 })
    await target('t-camp', 'g-sup', 'suppressed campaign jacket', 45); await perf('t-camp', 10, { clicks: 8, costCents: 300 })
    await target('t-paused', 'g-a', 'paused boots', 50, { status: 'PAUSED' }); await perf('t-paused', 10, { clicks: 8, costCents: 300 })
    await target('t-neg', 'g-a', 'free', 50, { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT' }); await perf('t-neg', 10, { clicks: 8, costCents: 300 })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

const ids = (ctxs: Array<{ adTarget: { id: string | null } }>) => ctxs.map((c) => c.adTarget.id)

describe('buildTargetPerformanceContexts — every clicked, enabled, unsuppressed target', () => {
  it('🔴 offers every target with a click in the 14 settled days, and nothing else', async () => {
    const ctxs = await inside(() => buildTargetPerformanceContexts())
    // Highest spend first. Each excluded target is excluded for exactly one reason (see the seed).
    expect(ids(ctxs)).toEqual(['t-waste', 't-win', 't-b'])
  })

  it('carries the campaign, ad group and current bid, and the measured ACoS where there are sales', async () => {
    const win = (await inside(() => buildTargetPerformanceContexts())).find((c) => c.adTarget.id === 't-win')!
    expect(win).toMatchObject({
      trigger: 'TARGET_PERFORMANCE', marketplace: 'IT',
      campaign: { id: 'c-a', name: 'Alpha IT' }, adGroup: { id: 'g-a', name: 'Group a' },
      adTarget: { bidCents: 45, spendCents: 400, salesCents: 2500, orders: 3, clicks: 10, acos: 0.16, cpcCents: 40 },
    })
  })

  it('🔴 ACoS is ABSENT, not 0, on a target with no sales — and Sales stays a measured 0', async () => {
    const waste = (await inside(() => buildTargetPerformanceContexts())).find((c) => c.adTarget.id === 't-waste')!
    expect('acos' in waste.adTarget).toBe(false)
    expect(waste.adTarget.salesCents).toBe(0)
  })

  it('a Bid rule\'s own lookback widens the window (30 days reaches the 25-day-old clicks)', async () => {
    expect(ids(await inside(() => buildTargetPerformanceContexts(30)))).toContain('t-old')
  })

  it('🔴 6c — the newest days wait out the attribution window: 7 days for Sponsored Products, 14 for Brands', async () => {
    // Both rows sit inside the old window (today−15 … today−2), so before 6c both were offered.
    const offered = ids(await inside(() => buildTargetPerformanceContexts()))
    expect(offered).not.toContain('t-recent') // Sponsored Products, 4 days old
    // Same age, different ad product: the Sponsored Products row 10 days old is read, the Brands row is not.
    expect(offered).toContain('t-win')
    expect(offered).not.toContain('t-sb')
    // A longer lookback moves the start, never the end: 30 days still stop 7 (SP) and 14 (Brands) days ago.
    const wide = ids(await inside(() => buildTargetPerformanceContexts(30)))
    expect(wide).not.toContain('t-sb')
    expect(wide).not.toContain('t-recent')
  })

  it('control: KEYWORD_HIGH_ACOS offers neither the winner nor the waster — why the starters never fired', async () => {
    const old = await inside(() => buildHighAcosKeywordContexts())
    expect(ids(old as never)).not.toContain('t-win')
    expect(ids(old as never)).not.toContain('t-waste')
  })
})

describe('targetPerformancePasses — the tick builds a pass per window, only for enabled rules', () => {
  it('builds nothing when no enabled rule rides the trigger (live today: 0 Bid rules)', async () => {
    expect(await inside(() => targetPerformancePasses())).toEqual([])
  })

  it('one pass per distinct window, each admitting only its own rules', async () => {
    const make = (name: string, windowDays?: number) => inside(() => db().automationRule.create({
      data: { domain: 'advertising', name, trigger: 'TARGET_PERFORMANCE', enabled: true, conditions: SCALE_WINNERS, actions: [{ type: 'bid', campaigns: [], ...(windowDays ? { windowDays } : {}) }] },
    }))
    const def = await make('TEST bid default window')
    const wide = await make('TEST bid 30 days', 30)
    try {
      const passes = await inside(() => targetPerformancePasses())
      expect(passes).toHaveLength(2)
      const forRule = (r: { id: string; actions: unknown }) => passes.filter(([, , f]) => f!(r))
      expect(forRule(def)).toHaveLength(1)
      expect(ids(forRule(def)[0][1] as never)).not.toContain('t-old')
      expect(forRule(wide)).toHaveLength(1)
      expect(ids(forRule(wide)[0][1] as never)).toContain('t-old')
    } finally {
      await inside(() => db().automationRule.deleteMany({ where: { id: { in: [def.id, wide.id] } } }))
    }
  })
})

describe('the Bid starters now fire — preview and Simulate', () => {
  const draft = (conditions: unknown, campaigns = ['c-a', 'c-b', 'c-sup']) => ({ actions: [{ type: 'bid', campaigns: campaigns.map((id) => ({ id })) }], conditions })

  it('🔴 "Scale winners" matches the converting keyword under 20% ACoS', async () => {
    const out = await inside(() => previewBidRule(draft(SCALE_WINNERS)))
    expect(out).toMatchObject({ ok: true, measurable: 3, matched: 1, floor: { minClicks: 1 } })
    expect(out.rows.map((r) => r.targetId)).toEqual(['t-win'])
  })

  it('🔴 "Floor zero-sale spenders" matches the keyword with spend, clicks and no sales', async () => {
    const out = await inside(() => previewBidRule(draft(FLOOR_ZERO_SALE)))
    expect(out).toMatchObject({ ok: true, matched: 1 })
    expect(out.rows[0]).toMatchObject({ targetId: 't-waste', currentEur: 0.4, proposedEur: 0.05, acosPct: null })
  })

  it('Simulate builds TARGET_PERFORMANCE contexts and keeps 4a\'s picked-campaign scope', async () => {
    const rule = await inside(() => db().automationRule.create({
      data: { domain: 'advertising', name: 'TEST scale winners — Alpha', trigger: 'TARGET_PERFORMANCE', enabled: false, conditions: SCALE_WINNERS, actions: [{ type: 'bid', campaigns: [{ id: 'c-a', name: 'Alpha IT' }] }] },
    }))
    try {
      const out = await inside(() => simulateOneRule(rule.id))
      expect(out).toMatchObject({ ok: true, trigger: 'TARGET_PERFORMANCE', contextsBuilt: 3, contextsInScope: 2, matched: 1 })
    } finally {
      await inside(() => db().automationRule.delete({ where: { id: rule.id } }))
    }
  })
})

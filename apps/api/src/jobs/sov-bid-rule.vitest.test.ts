/**
 * The live Share-of-Voice rule, end to end on the engine's own pieces:
 *
 *   trigger SOV_BID · adTarget.sovPct < 0.1 · adTarget.acos ≤ 0.2 · adTarget.orders ≥ 1
 *   → bid_apply incPct 10, maxEur 0.8 · scope: market IT + one portfolio
 *
 * `buildSovBidContexts` (the context the tick hands the rule), the rule guard (what save-ad-rule
 * accepts), the conditions the engine evaluates, and the scope the tick and Simulate apply. The SQP
 * share and the database are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ shares: vi.fn() }))

vi.mock('../db.js', () => ({
  default: {
    adTarget: { findMany: vi.fn() },
    amazonAdsDailyPerformance: { groupBy: vi.fn(async () => []) },
  },
}))
vi.mock('../services/advertising/ads-sov-keyword-share.service.js', () => ({
  SOV_SHARE_MAX_AGE_DAYS: 14,
  keywordMarketShares: h.shares,
  sovShareKey: (m: string | null | undefined, q: string | null | undefined) => `${m ?? ''}|${(q ?? '').trim().toLowerCase()}`,
}))
vi.mock('../services/advertising/ads-impression-share.service.js', () => ({ analyzeShareOfVoice: vi.fn(async () => ({ rows: [] })) }))

import prisma from '../db.js'
import { analyzeShareOfVoice } from '../services/advertising/ads-impression-share.service.js'
import { buildSovBidContexts } from './advertising-rule-evaluator.job.js'
import { evaluateConditions } from '../services/automation/conditions-tree.js'
import { contextIdentity, ruleMatchesScope } from '../services/automation-rule-scope.js'
import { guardRule } from '../services/automation/automation-rule-guard.js'
import { ADS_TRIGGER_FIELDS } from '../services/automation/ads-trigger-fields.js'

const db = vi.mocked(prisma, true)
const PORTFOLIO = 'pf-gale-it'

const CONDITIONS = [
  { field: 'adTarget.sovPct', op: 'lt', value: 0.1 },
  { field: 'adTarget.acos', op: 'lte', value: 0.2 },
  { field: 'adTarget.orders', op: 'gte', value: 1 },
]
const ACTIONS = [{ type: 'bid_apply', op: 'incPct', value: 10, maxEur: 0.8 }]

const share = (marketplace: string, query: string, sharePct: number) => ({ marketplace, query, sharePct, impressionsBrand: 1, impressionsTotal: 10, asinRows: 1, weekStart: '2026-09-27', shareAgeDays: 6 })
const target = (id: string, text: string, campaignId: string, marketplace: string) => ({
  id, expressionValue: text, adGroup: { id: `ag-${id}`, campaign: { id: campaignId, marketplace } },
})
// 30 days of settled performance per target: spend, sales (cents), orders.
const perf = (id: string, spendEur: number, salesEur: number, orders: number) => ({
  localEntityId: id, _sum: { costMicros: spendEur * 1_000_000, sales7dCents: salesEur * 100, orders7d: orders, clicks: 40, impressions: 2000 },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.shares.mockResolvedValue({
    byKey: new Map([
      ['IT|giubbotto moto uomo', share('IT', 'giubbotto moto uomo', 0.04)],
      ['IT|giacca moto estiva', share('IT', 'giacca moto estiva', 0.25)],
      ['IT|giacca moto donna', share('IT', 'giacca moto donna', 0.05)],
      ['DE|motorradjacke', share('DE', 'motorradjacke', 0.03)],
    ]),
    periods: [], measuredMarkets: ['IT', 'DE'],
  })
  db.adTarget.findMany.mockResolvedValue([
    target('t1', 'Giubbotto moto uomo ', 'c-gale', 'IT'), // case + space folded; low share, good ACoS → fires
    target('t2', 'giacca moto estiva', 'c-gale', 'IT'),   // share 25 % → no
    target('t3', 'giacca moto donna', 'c-gale', 'IT'),    // low share, spend and NO sales → acos absent → no
    target('t4', 'motorradjacke', 'c-de', 'DE'),          // other market
    target('t5', 'casco integrale', 'c-gale', 'IT'),      // no SQP share at all → no context
  ] as never)
  db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([
    perf('t1', 10, 100, 3), perf('t2', 10, 100, 3), perf('t3', 12, 0, 0), perf('t4', 10, 100, 3),
  ] as never)
})

describe('SOV_BID — the live rule end to end', () => {
  it('save-ad-rule accepts the rule: every field it reads is one SOV_BID hands over', () => {
    expect(guardRule({
      kind: 'amazon-ads', name: 'SOV raise IT', trigger: 'SOV_BID', conditions: CONDITIONS, actions: ACTIONS,
      scope: { marketplace: 'IT', portfolioId: PORTFOLIO }, caps: { maxExecutionsPerDay: 20, maxWritesPerDay: 10, maxValueCentsEur: 500 },
    })).toEqual([])
    for (const c of CONDITIONS) expect(ADS_TRIGGER_FIELDS.SOV_BID).toContain(c.field)
  })

  it('builds one context per keyword target with a market share, carrying sovPct, acos and orders', async () => {
    const ctxs = await buildSovBidContexts()
    expect(ctxs.map((c) => c.adTarget.id)).toEqual(['t1', 't2', 't3', 't4'])
    const t1 = ctxs.find((c) => c.adTarget.id === 't1')!
    expect(t1).toMatchObject({ trigger: 'SOV_BID', marketplace: 'IT', campaign: { id: 'c-gale' }, adGroup: { id: 'ag-t1' } })
    expect(t1.adTarget).toMatchObject({ sovPct: 0.04, orders: 3, spendCents: 1000, salesCents: 10000 })
    expect(t1.adTarget.acos).toBeCloseTo(0.1, 10)
    // No sales → no ACoS: the key is ABSENT, so "acos ≤ 20 %" cannot read it as a 0 % winner.
    expect('acos' in ctxs.find((c) => c.adTarget.id === 't3')!.adTarget).toBe(false)
  })

  it('the conditions fire on the low-share, profitable keyword only', async () => {
    const ctxs = await buildSovBidContexts()
    const fired = ctxs.filter((c) => evaluateConditions(CONDITIONS as never, c as never)).map((c) => c.adTarget.id)
    expect(fired).toEqual(['t1', 't4'])
  })

  it('the scope (market IT + portfolio) keeps only the portfolio\'s IT targets, as the tick and Simulate resolve it', async () => {
    const ctxs = await buildSovBidContexts()
    // The tick's maps: local campaign id → Campaign.portfolioId (external id).
    const localToPortfolio = new Map<string, string | null>([['c-gale', PORTFOLIO], ['c-de', PORTFOLIO]])
    const scope = { scopeMarketplace: 'IT', scopePortfolioId: PORTFOLIO, scopeCampaignId: null }
    const inScope = ctxs.filter((c) => ruleMatchesScope(scope, contextIdentity(c, new Map(), localToPortfolio)))
    expect(inScope.map((c) => c.adTarget.id)).toEqual(['t1', 't2', 't3'])
    const other = new Map<string, string | null>([['c-gale', '999']])
    expect(ctxs.filter((c) => ruleMatchesScope(scope, contextIdentity(c, new Map(), other)))).toEqual([])
  })

  it('Campaign Concentration: a query with no impressions (null) leaves topSharePct absent, never a 0 that "< 60 %" reads as low', async () => {
    vi.mocked(analyzeShareOfVoice).mockImplementation(async (o) => ({
      rows: o?.marketplace === 'IT' ? [{ query: 'giubbotto moto uomo', topCampaignSharePct: null }, { query: 'giacca moto estiva', topCampaignSharePct: 0.9 }] : [],
    }) as never)
    try {
      const ctxs = await buildSovBidContexts()
      expect('topSharePct' in ctxs.find((c) => c.adTarget.id === 't1')!.adTarget).toBe(false)
      expect(ctxs.find((c) => c.adTarget.id === 't2')!.adTarget.topSharePct).toBe(0.9)
      expect(evaluateConditions([{ field: 'adTarget.topSharePct', op: 'lt', value: 0.6 }] as never, ctxs.find((c) => c.adTarget.id === 't1') as never)).toBe(false)
    } finally {
      vi.mocked(analyzeShareOfVoice).mockImplementation(async () => ({ rows: [] }) as never)
    }
  })

  it('A3 — asks for shares at most 14 days old, and every context says how old its share is', async () => {
    const ctxs = await buildSovBidContexts()
    expect(h.shares).toHaveBeenCalledWith({ maxAgeDays: 14 })
    for (const c of ctxs) expect(c.adTarget).toMatchObject({ shareAgeDays: 6, shareWeek: '2026-09-27' })
  })

  it('🔴 A3 — a market whose newest complete week is too old is refused by the gate: its keywords get no context, never a 0', async () => {
    h.shares.mockResolvedValue({
      byKey: new Map([['DE|motorradjacke', share('DE', 'motorradjacke', 0.03)]]),
      periods: [{ marketplace: 'IT', reason: 'too-old', refused: true, note: 'IT: the newest complete Brand Analytics week (week of 2026-09-13) ended 20 days ago; shares older than 14 days are not used' }],
      measuredMarkets: ['DE'],
    })
    const ctxs = await buildSovBidContexts()
    expect(ctxs.map((c) => c.adTarget.id)).toEqual(['t4'])
  })

  it('no complete SQP week in any market → no context at all (the rule then matches nothing, by design)', async () => {
    h.shares.mockResolvedValue({ byKey: new Map(), periods: [], measuredMarkets: [] })
    expect(await buildSovBidContexts()).toEqual([])
    expect(db.adTarget.findMany).not.toHaveBeenCalled()
  })
})

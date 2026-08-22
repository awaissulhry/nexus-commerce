/**
 * KT-P/C1 (2026-08-22) — an unmeasurable metric must be ABSENT from the context, not null.
 *
 * 🔴 The fact this file exists to pin: **`null` and a real `0` are the same value to the rule
 * engine.** `applyOperator` (`automation-rule.service.ts`) coerces with `Number()`, and
 * `Number(null)` is `0` while `Number(undefined)` is `NaN` — and every comparison against `NaN`
 * is false. So a `null` ACoS did not "fail the condition" as three separate code comments in the
 * evaluator claimed; it satisfied every `lt`/`lte` an operator could write.
 *
 * Measured on prod before the fix:
 *   · **38 of 46** campaigns emitting a budget context had no ACoS (spend, no sales) and all 38
 *     matched `ACoS <= 25%`;
 *   · **197 of 435** keyword targets with performance rows had spend and zero sales — 196 of them
 *     in write-enabled campaigns, carrying €713.47 — so a Bid rule "ACoS ≤ 20% → raise bid" read
 *     every one as a 0%-ACoS winner and would have raised the bid on the worst performers;
 *   · **86 of 793** SOV contexts had no Campaign Concentration, and matched `< 60%`.
 *
 * Nothing in tsc, in 5,169 tests, or in any ratchet could see it: the types were satisfied and the
 * behaviour was simply wrong. These tests fail against the original code and against the obvious
 * "fix it by nulling", which is the only reason they are worth having.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn() },
    amazonAdsDailyPerformance: { groupBy: vi.fn() },
    amazonAdsPlacementReport: { groupBy: vi.fn() },
  },
}))

import prisma from '../db.js'
import { buildCampaignBudgetContexts } from './advertising-rule-evaluator.job.js'
import { applyOperator } from '../services/automation-rule.service.js'

const db = vi.mocked(prisma, true)
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

beforeEach(() => {
  vi.clearAllMocks()
  db.amazonAdsPlacementReport.groupBy.mockResolvedValue([] as never)
})

const campaign = (o: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'GALE IT', externalCampaignId: 'x1', marketplace: 'IT', dailyBudget: 10, ...o,
})
const perf = (o: Record<string, unknown> = {}) => ({
  localEntityId: 'c1',
  _sum: { costMicros: 5_000_000, sales7dCents: 0, orders7d: 0, clicks: 10, impressions: 500 },
  ...o,
})

describe('the comparator — why "not measurable" cannot be null', () => {
  it.each([
    ['lte', 0.2],
    ['lt', 0.2],
    ['eq', 0],
    ['gte', 0],
  ] as const)('null is indistinguishable from a real 0 for %s', (op, rhs) => {
    expect(applyOperator(op, null, rhs)).toBe(applyOperator(op, 0, rhs))
    expect(applyOperator(op, 0, rhs)).toBe(true)
  })

  it.each(['lt', 'lte', 'gt', 'gte', 'eq'] as const)('an ABSENT value refuses %s', (op) => {
    expect(applyOperator(op, undefined, 0)).toBe(false)
    expect(applyOperator(op, undefined, 0.2)).toBe(false)
  })
})

describe('buildCampaignBudgetContexts', () => {
  it('OMITS acos on a campaign with spend and no sales, so "ACoS ≤ 20%" cannot match it', async () => {
    db.campaign.findMany.mockResolvedValue([campaign()] as never)
    db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([perf()] as never)

    const [ctx] = await buildCampaignBudgetContexts(7)
    expect(has(ctx.campaign, 'acos')).toBe(false)
    // the live defect: this was `true` before the fix, on 38 of 46 real campaigns
    expect(applyOperator('lte', ctx.campaign.acos, 0.2)).toBe(false)
    // and the honest direction is unaffected — it was already false and stays false
    expect(applyOperator('gte', ctx.campaign.acos, 0.4)).toBe(false)
  })

  it('keeps a real ACoS when there are sales', async () => {
    db.campaign.findMany.mockResolvedValue([campaign()] as never)
    db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([
      perf({ _sum: { costMicros: 5_000_000, sales7dCents: 5000, orders7d: 2, clicks: 10, impressions: 500 } }),
    ] as never)

    const [ctx] = await buildCampaignBudgetContexts(7)
    expect(ctx.campaign.acos).toBeCloseTo(0.1) // 500¢ spend / 5000¢ sales
    expect(applyOperator('lte', ctx.campaign.acos, 0.2)).toBe(true)
  })

  it('a measured ZERO is still a measurement — counts stay, and only the undefined ratios go absent', async () => {
    // Spend but no clicks and no sales. (A campaign with no spend at all emits NO context — the
    // builder's own floor — so the distinction has to be exercised on one that does spend.)
    db.campaign.findMany.mockResolvedValue([campaign()] as never)
    db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([
      perf({ _sum: { costMicros: 5_000_000, sales7dCents: 0, orders7d: 0, clicks: 0, impressions: 0 } }),
    ] as never)

    const [ctx] = await buildCampaignBudgetContexts(7)
    // 0 clicks is a fact we know, so "Clicks = 0" must still match
    expect(ctx.campaign.clicks).toBe(0)
    expect(ctx.campaign.impressions).toBe(0)
    expect(applyOperator('eq', ctx.campaign.clicks, 0)).toBe(true)

    // 🔴 The line the whole fix turns on: ROAS is a real 0 — we spent €5 and got nothing back,
    // which is a measurement — so it STAYS and "ROAS ≤ 1" correctly matches. ACoS, CTR, CVR and
    // CPC divide by zero denominators and are not facts at all, so they go absent.
    expect(ctx.campaign.roas).toBe(0)
    expect(applyOperator('lte', ctx.campaign.roas, 1)).toBe(true)
    for (const k of ['acos', 'ctr', 'cvr', 'cpcCents']) expect(has(ctx.campaign, k)).toBe(false)
  })

  it('omits budgetUtilization only when there is no daily budget to divide by', async () => {
    db.campaign.findMany.mockResolvedValue([campaign({ dailyBudget: null })] as never)
    db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([perf()] as never)
    const [noBudget] = await buildCampaignBudgetContexts(7)
    expect(has(noBudget.campaign, 'budgetUtilization')).toBe(false)
    // 🔴 the armed "Reclaim idle budget — DE" rule gates on this exact leaf: it must not match a
    // campaign whose utilization is unknowable
    expect(applyOperator('lte', noBudget.campaign.budgetUtilization, 0.1)).toBe(false)

    vi.clearAllMocks()
    db.amazonAdsPlacementReport.groupBy.mockResolvedValue([] as never)
    db.campaign.findMany.mockResolvedValue([campaign({ dailyBudget: 10 })] as never)
    db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([perf()] as never)
    const [withBudget] = await buildCampaignBudgetContexts(7)
    expect(withBudget.campaign.budgetUtilization).toBeGreaterThan(0)
  })
})

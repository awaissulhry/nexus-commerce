/**
 * ONE BRAIN AB-7 — test facts for the money plan (budget-*.vitest.test.ts): "Product A" in IT, its campaigns, its ACoS
 * band, with the brain's real settings resolver over the Owner's overrides. Every value is made up (public repo).
 */
import { goalWords, isGoal, resolveGoal } from '../../bid-brain/goal.js'
import { resolveBrainSettings, type OverrideRow } from '../settings.js'
import type { BandFacts, CampaignMoneyFacts } from '../budget-campaigns.js'

export const PRODUCT = 'prod-a'
let n = 0
/** One Owner override of Product A (a campaign one when `campaignId` is given). */
export const ov = (kind: string, key: string, value: unknown, campaignId: string | null = null, ref = ''): OverrideRow => ({
  id: `o${++n}`, productId: PRODUCT, marketplace: 'IT', scope: campaignId ? 'CAMPAIGN' : 'PRODUCT', campaignId, kind, key, ref, value, by: 'user:owner', reason: null, createdAt: `2026-10-08T09:${String(n).padStart(2, '0')}:00Z`, endedAt: null,
})
/** One campaign's money facts (€15 a day budget, €4 a day spend unless told otherwise), the settings resolved over `overrides`. */
export function camp(id: string, over: Partial<CampaignMoneyFacts> = {}, overrides: OverrideRow[] = []): CampaignMoneyFacts {
  const s = resolveBrainSettings({ productId: PRODUCT, market: 'IT', campaignId: id, enrolled: true, overrides })
  const todayCents = over.todayCents ?? 1_500
  return {
    campaignId: id, name: id, status: 'ENABLED', owner: 'product', todayCents, openingCents: todayCents, stepToday: null, minCents: null, maxCents: null, avgDailySpendCents: 400, bidRatio: null,
    settled: { spendCents: 0, salesCents: 0, orders: 0 }, usage: null, spikeWhy: null, ladderedTodayPct: 0,
    excluded: s.excluded.value, budgets: { effective: s.levers.budgets.effective, lock: s.levers.budgets.lock, why: s.levers.budgets.why },
    budgetUsePct: s.values.budgetUsePct, ladderMaxPct: s.values.intradayLadderMaxPct, ...over,
  }
}
const goal = resolveGoal({ target: { kind: 'ACOS', pct: 25 } })
/** Product A's band: ACoS 25 % aimed; its own campaigns over the settled window at ACoS 25 % (20 orders). */
export const BAND: BandFacts = { goal: isGoal(goal) ? { lo: goal.lo, hi: goal.hi, words: goalWords(goal) } : null, product: { spendCents: 14_000, salesCents: 56_000, orders: 20 } }

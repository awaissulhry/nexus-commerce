/**
 * ONE BRAIN AB-7 — test facts for the money plan (budget-*.vitest.test.ts): GALE IT as the design reads it on 2026-10-08
 * (portfolio "Xavia GALE IT", 10 enabled campaigns, 30 days of about €385 spend and €1,220 sales — ACoS about 31.6 %, 16
 * orders, rounded: made up after the design, public repo), with the brain's real settings resolver over the Owner's overrides.
 */
import { goalWords, isGoal, resolveGoal } from '../../bid-brain/goal.js'
import { resolveBrainSettings, type OverrideRow } from '../settings.js'
import type { BandFacts, CampaignMoneyFacts } from '../budget-campaigns.js'

let n = 0
/** One Owner override of GALE IT (a campaign one when `campaignId` is given). */
export const ov = (kind: string, key: string, value: unknown, campaignId: string | null = null, ref = ''): OverrideRow => ({
  id: `o${++n}`, productId: 'gale', marketplace: 'IT', scope: campaignId ? 'CAMPAIGN' : 'PRODUCT', campaignId, kind, key, ref, value, by: 'user:owner', reason: null, createdAt: `2026-10-08T09:${String(n).padStart(2, '0')}:00Z`, endedAt: null,
})
/** One campaign's money facts with the brain's settings resolved over `overrides`. */
export function camp(id: string, over: Partial<CampaignMoneyFacts> = {}, overrides: OverrideRow[] = []): CampaignMoneyFacts {
  const s = resolveBrainSettings({ productId: 'gale', market: 'IT', campaignId: id, enrolled: true, overrides })
  return {
    campaignId: id, name: id, status: 'ENABLED', owner: 'product', todayCents: 2_000, minCents: null, maxCents: null, avgDailySpendCents: 310, bidRatio: null,
    settled: { spendCents: 0, salesCents: 0, orders: 0 }, usage: null, spikeWhy: null, ladderedTodayPct: 0,
    excluded: s.excluded.value, budgets: { effective: s.levers.budgets.effective, lock: s.levers.budgets.lock, why: s.levers.budgets.why },
    budgetUsePct: s.values.budgetUsePct, ladderMaxPct: s.values.intradayLadderMaxPct, ...over,
  }
}
const goal = resolveGoal({ target: { kind: 'ACOS', pct: 30 } })
/** GALE IT's band: ACoS 30 % aimed, 27–34.5 %; its own campaigns over the settled window at ACoS 31.6 % (16 orders). */
export const GALE_BAND: BandFacts = { goal: isGoal(goal) ? { lo: goal.lo, hi: goal.hi, words: goalWords(goal) } : null, product: { spendCents: 38_500, salesCents: 122_000, orders: 16 } }

/**
 * AX3.2 — Full-funnel "Goal" builder (Perpetua-style branded + unbranded).
 *
 * One Goal spins up two coordinated SP campaigns from a product set:
 *   - Branded   → your brand terms, tight target ACoS, defend position
 *   - Unbranded → discovery / generic terms, looser target ACoS, growth
 * Each side carries its own Target ACoS + daily budget (stored in
 * Campaign.dynamicBidding.targetAcos so the bid optimizer can honour it).
 * "Suggest Targets" mines our own search-term history for converting queries,
 * auto-splitting branded vs unbranded by brand-term match. Created via the
 * AX.4 gated write primitives.
 */

import prisma from '../../db.js'
import { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal } from './ads-create.service.js'
import { logger } from '../../utils/logger.js'

function hasBrand(s: string, brandTerms: string[]): boolean { const l = s.toLowerCase(); return brandTerms.some((b) => b && l.includes(b)) }

export interface SuggestedTargets { branded: string[]; unbranded: string[] }
export async function suggestTargets(opts: { brandTerms: string[]; asins?: string[]; limit?: number }): Promise<SuggestedTargets> {
  const brandTerms = opts.brandTerms.map((b) => b.trim().toLowerCase()).filter(Boolean)
  const limit = opts.limit ?? 25
  const since = new Date(Date.now() - 90 * 86_400_000)
  // Converting queries from our own search-term history (best signal).
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query'], where: { date: { gte: since } }, _sum: { orders7d: true, clicks: true },
    orderBy: { _sum: { orders7d: 'desc' } }, take: 400,
  }).catch(() => [] as Array<{ query: string; _sum: { orders7d: number | null; clicks: number | null } }>)
  const branded: string[] = [], unbranded: string[] = []
  for (const r of rows) {
    const q = (r.query || '').trim(); if (!q || (r._sum.clicks ?? 0) < 2) continue
    if (hasBrand(q, brandTerms)) { if (branded.length < limit) branded.push(q) }
    else if (unbranded.length < limit) unbranded.push(q)
    if (branded.length >= limit && unbranded.length >= limit) break
  }
  // Seed branded with the brand terms themselves if history is thin.
  for (const b of brandTerms) if (b && !branded.includes(b)) branded.unshift(b)
  return { branded: branded.slice(0, limit), unbranded: unbranded.slice(0, limit) }
}

export interface GoalSide { enabled: boolean; targetAcos: number; dailyBudgetEur: number; keywords: string[] }
export interface GoalPlan {
  goalName: string; marketplace: string; asins: string[]; skus?: string[]
  matchTypes: Array<'EXACT' | 'PHRASE' | 'BROAD'>
  branded: GoalSide; unbranded: GoalSide
}

export function buildGoalPlan(input: {
  goalName: string; marketplace?: string; asins?: string[]; skus?: string[]
  brandTerms: string[]; matchTypes?: Array<'EXACT' | 'PHRASE' | 'BROAD'>
  branded?: Partial<GoalSide>; unbranded?: Partial<GoalSide>; suggested?: SuggestedTargets
}): GoalPlan {
  const matchTypes: Array<'EXACT' | 'PHRASE' | 'BROAD'> = input.matchTypes?.length ? input.matchTypes : ['EXACT', 'PHRASE']
  return {
    goalName: input.goalName, marketplace: input.marketplace ?? 'IT',
    asins: (input.asins ?? []).map((a) => a.trim()).filter(Boolean), skus: input.skus,
    matchTypes,
    branded: { enabled: input.branded?.enabled ?? true, targetAcos: input.branded?.targetAcos ?? 0.2, dailyBudgetEur: input.branded?.dailyBudgetEur ?? 20, keywords: input.branded?.keywords ?? input.suggested?.branded ?? input.brandTerms },
    unbranded: { enabled: input.unbranded?.enabled ?? true, targetAcos: input.unbranded?.targetAcos ?? 0.35, dailyBudgetEur: input.unbranded?.dailyBudgetEur ?? 20, keywords: input.unbranded?.keywords ?? input.suggested?.unbranded ?? [] },
  }
}

export async function applyGoalPlan(plan: GoalPlan, userId?: string): Promise<{ created: Array<{ side: string; campaignId: string; keywords: number }> }> {
  const created: Array<{ side: string; campaignId: string; keywords: number }> = []
  for (const [side, cfg] of [['Branded', plan.branded], ['Unbranded', plan.unbranded]] as const) {
    if (!cfg.enabled) continue
    const c = await createCampaignLocal({ name: `${plan.goalName} - ${side}`, type: 'SP', marketplace: plan.marketplace, targetingType: 'MANUAL', dailyBudgetEur: cfg.dailyBudgetEur, biddingStrategy: 'autoForSales', userId })
    // Persist the side's target ACoS for the bid optimizer to honour.
    await prisma.campaign.update({ where: { id: c.id }, data: { dynamicBidding: { targetAcos: cfg.targetAcos, goal: plan.goalName, side } as never } }).catch(() => {})
    const g = await createAdGroupLocal({ campaignId: c.id, name: `${plan.goalName} - ${side}`, defaultBidEur: 0.5, userId })
    for (const asin of plan.asins) await createProductAdLocal({ adGroupId: g.id, asin, userId }).catch(() => {})
    for (const sku of plan.skus ?? []) await createProductAdLocal({ adGroupId: g.id, sku, userId }).catch(() => {})
    let kw = 0
    for (const text of cfg.keywords.map((k) => k.trim()).filter(Boolean)) {
      for (const mt of plan.matchTypes) { await createKeywordLocal({ adGroupId: g.id, keywordText: text, matchType: mt, bidEur: 0.5, userId }).catch(() => {}); kw++ }
    }
    created.push({ side, campaignId: c.id, keywords: kw })
  }
  logger.info('[AX3.2] applyGoalPlan', { goal: plan.goalName, created: created.length })
  return { created }
}

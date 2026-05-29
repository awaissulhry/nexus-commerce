/**
 * AX.6 — Keyword-paste auto-architect.
 *
 * Paste a keyword list → generate a full campaign structure by strategy,
 * then create it via the AX.4 primitives. The headline ease-of-use: one
 * paste → campaigns + ad groups + keywords by match type + product ads.
 *
 * Strategies:
 *   MATCH_TYPE_SPLIT — 3 campaigns ({base} Exact/Phrase/Broad), each one
 *                      ad group with all keywords at that match type.
 *   SKAG             — 1 campaign, one ad group per keyword (single-keyword
 *                      ad groups, exact match) — granular bid control.
 *   AUTO_FUNNEL      — 1 AUTO discovery campaign + 1 Broad + 1 Exact manual
 *                      (the discover→harvest funnel; harvest in AX.7).
 *
 * preview() returns the plan without writing; apply() creates everything.
 */

import { logger } from '../../utils/logger.js'
import { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal } from './ads-create.service.js'

export type ArchitectStrategy = 'MATCH_TYPE_SPLIT' | 'SKAG' | 'AUTO_FUNNEL'
type MatchType = 'EXACT' | 'PHRASE' | 'BROAD'

export interface ArchitectInput {
  baseName: string
  marketplace: string
  strategy: ArchitectStrategy
  keywords: string[]
  dailyBudgetEur: number
  defaultBidEur: number
  productSku?: string
  productAsin?: string
  userId?: string
}

interface PlanKeyword { text: string; matchType: MatchType; bidEur: number }
interface PlanAdGroup { name: string; defaultBidEur: number; keywords: PlanKeyword[] }
interface PlanCampaign { name: string; type: 'SP'; targetingType: 'MANUAL' | 'AUTO'; dailyBudgetEur: number; adGroups: PlanAdGroup[] }
export interface ArchitectPlan { strategy: ArchitectStrategy; campaigns: PlanCampaign[]; keywordCount: number; campaignCount: number; adGroupCount: number }

/** Normalize + dedupe a pasted list (one keyword per line or comma-sep). */
export function normalizeKeywords(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw) {
    for (const part of String(line).split(/[\n,]/)) {
      const k = part.trim().replace(/\s+/g, ' ').toLowerCase()
      if (k && !seen.has(k)) { seen.add(k); out.push(k) }
    }
  }
  return out
}

export function buildPlan(input: ArchitectInput): ArchitectPlan {
  const kws = normalizeKeywords(input.keywords)
  const { baseName, dailyBudgetEur, defaultBidEur } = input
  const campaigns: PlanCampaign[] = []

  if (input.strategy === 'MATCH_TYPE_SPLIT') {
    for (const mt of ['EXACT', 'PHRASE', 'BROAD'] as MatchType[]) {
      campaigns.push({
        name: `${baseName} - ${mt[0]}${mt.slice(1).toLowerCase()}`, type: 'SP', targetingType: 'MANUAL', dailyBudgetEur,
        adGroups: [{ name: `${baseName} ${mt}`, defaultBidEur, keywords: kws.map((text) => ({ text, matchType: mt, bidEur: defaultBidEur })) }],
      })
    }
  } else if (input.strategy === 'SKAG') {
    campaigns.push({
      name: `${baseName} - SKAG`, type: 'SP', targetingType: 'MANUAL', dailyBudgetEur,
      adGroups: kws.map((text) => ({ name: text.slice(0, 60), defaultBidEur, keywords: [{ text, matchType: 'EXACT', bidEur: defaultBidEur }] })),
    })
  } else { // AUTO_FUNNEL
    campaigns.push({ name: `${baseName} - Auto (discovery)`, type: 'SP', targetingType: 'AUTO', dailyBudgetEur, adGroups: [{ name: `${baseName} Auto`, defaultBidEur, keywords: [] }] })
    campaigns.push({ name: `${baseName} - Broad`, type: 'SP', targetingType: 'MANUAL', dailyBudgetEur, adGroups: [{ name: `${baseName} Broad`, defaultBidEur, keywords: kws.map((text) => ({ text, matchType: 'BROAD' as MatchType, bidEur: defaultBidEur })) }] })
    campaigns.push({ name: `${baseName} - Exact`, type: 'SP', targetingType: 'MANUAL', dailyBudgetEur, adGroups: [{ name: `${baseName} Exact`, defaultBidEur, keywords: kws.map((text) => ({ text, matchType: 'EXACT' as MatchType, bidEur: defaultBidEur })) }] })
  }

  return {
    strategy: input.strategy, campaigns,
    keywordCount: kws.length, campaignCount: campaigns.length,
    adGroupCount: campaigns.reduce((a, c) => a + c.adGroups.length, 0),
  }
}

export interface ArchitectResult { ok: boolean; created: { campaigns: number; adGroups: number; keywords: number; productAds: number }; campaignIds: string[]; error?: string }

export async function applyPlan(input: ArchitectInput): Promise<ArchitectResult> {
  const plan = buildPlan(input)
  const created = { campaigns: 0, adGroups: 0, keywords: 0, productAds: 0 }
  const campaignIds: string[] = []
  try {
    for (const pc of plan.campaigns) {
      const c = await createCampaignLocal({ name: pc.name, type: pc.type, marketplace: input.marketplace, targetingType: pc.targetingType, dailyBudgetEur: pc.dailyBudgetEur, userId: input.userId })
      created.campaigns++; campaignIds.push(c.id)
      for (const pg of pc.adGroups) {
        const g = await createAdGroupLocal({ campaignId: c.id, name: pg.name, defaultBidEur: pg.defaultBidEur, userId: input.userId })
        created.adGroups++
        if (input.productSku || input.productAsin) { await createProductAdLocal({ adGroupId: g.id, sku: input.productSku, asin: input.productAsin, userId: input.userId }); created.productAds++ }
        for (const kw of pg.keywords) { await createKeywordLocal({ adGroupId: g.id, keywordText: kw.text, matchType: kw.matchType, bidEur: kw.bidEur, userId: input.userId }); created.keywords++ }
      }
    }
    logger.info('[AX.6] architect applied', { strategy: input.strategy, created })
    return { ok: true, created, campaignIds }
  } catch (e) {
    logger.error('[AX.6] architect apply failed', { error: (e as Error)?.message, created })
    return { ok: false, created, campaignIds, error: (e as Error)?.message }
  }
}

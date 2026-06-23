/**
 * AX.7 — Negative + keyword harvesting.
 *
 * From AmazonAdsSearchTerm over a window:
 *   • NEGATIVE candidates — terms that spent ≥ minSpend with 0 orders →
 *     propose adding as a campaign negative (stops the bleed).
 *   • GRADUATE candidates — converting terms (orders ≥ minOrders) found via
 *     auto/broad targeting → propose creating an Exact keyword in the
 *     originating ad group (the auto→manual harvest funnel).
 *
 * preview() returns candidates; apply() executes the chosen actions via the
 * shipped createNegative + AX.4 createKeywordLocal. Sandbox-safe + gated.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { createNegative } from './ads-negative-kw.service.js'
import { createKeywordLocal } from './ads-create.service.js'

export interface HarvestCandidate {
  query: string
  externalCampaignId: string
  externalAdGroupId: string
  impressions: number
  clicks: number
  costCents: number
  orders: number
  salesCents: number
}
export interface HarvestPreview { negatives: HarvestCandidate[]; graduations: HarvestCandidate[]; windowDays: number }

const DEFAULT_MIN_SPEND_CENTS = 1500 // €15 with zero orders → wasteful
const DEFAULT_MIN_ORDERS = 2 // converting → worth graduating

export async function previewHarvest(opts: { windowDays?: number; minSpendCents?: number; minOrders?: number; adGroupExternalIds?: string[] } = {}): Promise<HarvestPreview> {
  const windowDays = opts.windowDays ?? 60
  const minSpend = opts.minSpendCents ?? DEFAULT_MIN_SPEND_CENTS
  const minOrders = opts.minOrders ?? DEFAULT_MIN_ORDERS
  const since = new Date(Date.now() - windowDays * 86400_000)
  // AT.4b — when a rule carries a source scope, only consider search terms from
  // those ad groups (by external id). Note: passing an EMPTY array intentionally
  // matches nothing — a wizard rule scoped to not-yet-live (gated) ad groups
  // harvests zero, never the whole account.
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId'],
    where: { date: { gte: since }, ...(opts.adGroupExternalIds ? { adGroupId: { in: opts.adGroupExternalIds } } : {}) },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const negatives: HarvestCandidate[] = []
  const graduations: HarvestCandidate[] = []
  for (const r of rows) {
    const costCents = Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
    const orders = r._sum.orders7d ?? 0
    const cand: HarvestCandidate = {
      query: r.query, externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId,
      impressions: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0, costCents, orders, salesCents: r._sum.sales7dCents ?? 0,
    }
    if (orders === 0 && costCents >= minSpend) negatives.push(cand)
    else if (orders >= minOrders) graduations.push(cand)
  }
  negatives.sort((a, b) => b.costCents - a.costCents)
  graduations.sort((a, b) => b.orders - a.orders)
  return { negatives, graduations, windowDays }
}

export interface HarvestApplyResult { negativesAdded: number; keywordsGraduated: number; errors: string[] }
// AT.4b — per-(external)-ad-group match-type plan from a wizard rule's `sources`.
// Absent → the original defaults (graduate EXACT, negate NEGATIVE_EXACT).
export type HarvestPlan = Record<string, { graduate?: string[]; negate?: string[] }>

export async function applyHarvest(args: { negatives?: HarvestCandidate[]; graduations?: Array<HarvestCandidate & { bidEur?: number }>; userId?: string; plan?: HarvestPlan }): Promise<HarvestApplyResult> {
  const result: HarvestApplyResult = { negativesAdded: 0, keywordsGraduated: 0, errors: [] }

  for (const n of args.negatives ?? []) {
    try {
      // Resolve a profile from the campaign's marketplace connection.
      const camp = await prisma.campaign.findFirst({ where: { externalCampaignId: n.externalCampaignId }, select: { marketplace: true } })
      const conn = camp?.marketplace ? await prisma.amazonAdsConnection.findFirst({ where: { marketplace: camp.marketplace, isActive: true }, select: { profileId: true } }) : null
      const negMatches = args.plan?.[n.externalAdGroupId]?.negate?.length ? args.plan[n.externalAdGroupId].negate! : ['EXACT']
      for (const nm of negMatches) {
        await createNegative({ profileId: conn?.profileId ?? '', externalCampaignId: n.externalCampaignId, keywordText: n.query, matchType: `NEGATIVE_${nm}`, scope: 'CAMPAIGN' } as never)
      }
      result.negativesAdded++
    } catch (e) { result.errors.push(`neg "${n.query}": ${(e as Error).message}`) }
  }

  for (const g of args.graduations ?? []) {
    try {
      // Graduate into the LOCAL ad group the term came from (by external id).
      const ag = await prisma.adGroup.findFirst({ where: { externalAdGroupId: g.externalAdGroupId }, select: { id: true } })
      if (!ag) { result.errors.push(`grad "${g.query}": no local ad group`); continue }
      // Bid = derived from observed CPC (cost/clicks) or a sensible default.
      const bidEur = g.bidEur ?? (g.clicks > 0 ? Math.max(0.05, g.costCents / g.clicks / 100) : 0.5)
      const gradMatches = args.plan?.[g.externalAdGroupId]?.graduate?.length ? args.plan[g.externalAdGroupId].graduate! : ['EXACT']
      for (const gm of gradMatches) {
        await createKeywordLocal({ adGroupId: ag.id, keywordText: g.query, matchType: gm as 'EXACT' | 'PHRASE' | 'BROAD', bidEur, userId: args.userId })
      }
      result.keywordsGraduated++
    } catch (e) { result.errors.push(`grad "${g.query}": ${(e as Error).message}`) }
  }

  logger.info('[AX.7] harvest applied', result)
  return result
}

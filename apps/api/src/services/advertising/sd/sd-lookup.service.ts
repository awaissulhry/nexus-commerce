/**
 * SD-AUD (2026-10-20) — what Claude's Sponsored Display recommendation reads (agents/tools/ads-sd.tools.ts) take from
 * Nexus: an SD ad group with its campaign's market, tactic and cost type, its own bid optimization and creative type, the
 * ASINs it advertises and its targets' expressions (as the SD sync stored them), so a read can ask Amazon "for this ad
 * group" without the person repeating it. AdGroup is advertising's own storage (scripts/check-context-boundary.mjs), so
 * the read lives here. Read only, in the business of the call: another business's id is simply absent.
 */
import { adProductOf } from '@nexus/shared/ads-ad-product'
import prisma from '../../../db.js'

/** The most targets one bid recommendation read asks about (Amazon takes 100 clauses a request). */
export const SD_MAX_CLAUSES = 100

export interface SdTargetForRead { targetId: string; expression: unknown; resolvedExpression: unknown; bidCents: number }

export interface SdAdGroupForRead {
  adGroupId: string
  name: string
  bidOptimization: string | null
  creativeType: string | null
  campaign: { campaignId: string; name: string; market: string | null; tactic: string | null; costType: string | null; dailyBudgetCurrency: string | null }
  /** The ASINs of its product ads (not archived) Nexus holds, each once. */
  asins: string[]
  /** Its positive targets (not archived), oldest first, at most SD_MAX_CLAUSES + 1 (one more says there are more). */
  targets: SdTargetForRead[]
}

const isSd = (c: { adProduct: string | null; type: unknown }) => adProductOf({ adProduct: c.adProduct, type: c.type == null ? null : String(c.type) }) === 'SPONSORED_DISPLAY'

/** One SD ad group for a read; null when it is not one of this business or not Sponsored Display. */
export async function sdAdGroupForRead(adGroupId: string): Promise<SdAdGroupForRead | null> {
  const g = await prisma.adGroup.findFirst({
    where: { id: adGroupId },
    select: {
      id: true, name: true, bidOptimization: true, creativeType: true,
      campaign: { select: { id: true, name: true, adProduct: true, type: true, marketplace: true, tactic: true, costType: true, dailyBudgetCurrency: true } },
      productAds: { where: { status: { not: 'ARCHIVED' } }, select: { asin: true }, orderBy: { id: 'asc' } },
      targets: {
        where: { isNegative: false, status: { not: 'ARCHIVED' } },
        select: { id: true, expressionJson: true, resolvedExpressionJson: true, bidCents: true },
        orderBy: { id: 'asc' },
        take: SD_MAX_CLAUSES + 1,
      },
    },
  })
  if (!g || !isSd(g.campaign)) return null
  return {
    adGroupId: g.id, name: g.name, bidOptimization: g.bidOptimization, creativeType: g.creativeType,
    campaign: { campaignId: g.campaign.id, name: g.campaign.name, market: g.campaign.marketplace, tactic: g.campaign.tactic, costType: g.campaign.costType, dailyBudgetCurrency: g.campaign.dailyBudgetCurrency },
    asins: [...new Set(g.productAds.map((a) => a.asin).filter((a): a is string => !!a))],
    targets: g.targets.map((t) => ({ targetId: t.id, expression: t.expressionJson, resolvedExpression: t.resolvedExpressionJson, bidCents: t.bidCents })),
  }
}

/** These SD targets (positive, of this business) with their stored expression and bid, in the order asked. */
export async function sdTargetsForRead(ids: readonly string[]): Promise<Array<SdTargetForRead & { market: string | null }>> {
  const rows = await prisma.adTarget.findMany({
    where: { id: { in: [...new Set(ids)] }, isNegative: false },
    select: {
      id: true, expressionJson: true, resolvedExpressionJson: true, bidCents: true,
      adGroup: { select: { campaign: { select: { adProduct: true, type: true, marketplace: true } } } },
    },
  })
  const byId = new Map(rows.filter((t) => isSd(t.adGroup.campaign)).map((t) => [t.id, t]))
  return ids.flatMap((id) => {
    const t = byId.get(id)
    return t ? [{ targetId: t.id, expression: t.expressionJson, resolvedExpression: t.resolvedExpressionJson, bidCents: t.bidCents, market: t.adGroup.campaign.marketplace }] : []
  })
}

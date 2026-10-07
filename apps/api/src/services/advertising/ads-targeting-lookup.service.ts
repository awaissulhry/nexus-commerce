/**
 * ADS AUTONOMY W4-5 — the ad group reads Claude's targeting and negatives tools make (agents/tools/ads-targets.tools.ts,
 * ads-negatives.tools.ts, ads-targeting-kit.ts), kept inside the advertising context: AdGroup is advertising's own
 * storage (scripts/check-context-boundary.mjs). Read only, in the business of the call.
 */
import prisma from '../../db.js'

/** The campaign of an ad group, as the tools judge a target or a negative there. */
export const TARGETING_CAMPAIGN_SELECT = {
  id: true, name: true, type: true, adProduct: true, status: true, marketplace: true, externalCampaignId: true, dailyBudgetCurrency: true, targetingType: true,
  bidsSuppressedAt: true, bidsSuppressedBy: true,
} as const

export interface TargetingCampaign {
  id: string; name: string; type: unknown; adProduct: string | null; status: unknown; marketplace: string | null; externalCampaignId: string | null
  dailyBudgetCurrency: string | null; targetingType: string | null; bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null
}

/** An ad group as a target or a negative is judged there: its state, its default bid, its floor, its campaign. */
export interface TargetingGroup {
  id: string; name: string; status: unknown; externalAdGroupId: string | null; orphanedAt: Date | null; defaultBidCents: number
  bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null; campaign: TargetingCampaign
}

/** These ad groups (the ones this business has), each with its campaign. */
export async function targetingAdGroups(ids: readonly string[]): Promise<TargetingGroup[]> {
  const asked = [...new Set(ids.filter(Boolean))]
  if (!asked.length) return []
  return (await prisma.adGroup.findMany({
    where: { id: { in: asked } },
    select: { id: true, name: true, status: true, externalAdGroupId: true, orphanedAt: true, defaultBidCents: true, bidsSuppressedAt: true, bidsSuppressedBy: true, campaign: { select: TARGETING_CAMPAIGN_SELECT } },
  })) as unknown as TargetingGroup[]
}

/** What a person calls these ad groups (their name and campaign) and where they run (Amazon's id, the market). */
export async function adGroupPlaces(ids: readonly string[]): Promise<Map<string, { id: string; name: string; externalAdGroupId: string | null; campaign: { name: string; marketplace: string | null } }>> {
  const asked = [...new Set(ids.filter(Boolean))]
  if (!asked.length) return new Map()
  const rows = await prisma.adGroup.findMany({ where: { id: { in: asked } }, select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { name: true, marketplace: true } } } })
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * MCP full control A2 — the advertising context's own reads that Claude's ad read tools need
 * (services/agents/tools/ads-read.tools.ts): ad groups by id, by campaign and by Amazon id, and the rules' pending
 * suggestions. AdGroup and AdsRuleSuggestion are advertising's private storage (scripts/check-context-boundary.mjs), so
 * a caller outside the context reads them through here, never through prisma.
 *
 * Read-only. Every read runs in the caller's business (row-level security): another business's id is simply absent.
 */
import prisma from '../../db.js'

/** The campaign an ad group belongs to, or null when the id names no ad group of this business. */
export async function adGroupCampaignId(adGroupId: string): Promise<string | null> {
  const group = await prisma.adGroup.findFirst({ where: { id: adGroupId }, select: { campaignId: true } })
  return group?.campaignId ?? null
}

/** A campaign's ad groups, each with Amazon's id and its targets' ids (positive and negative). */
export async function adGroupsOfCampaign(campaignId: string): Promise<Array<{ id: string; externalAdGroupId: string | null; targetIds: string[] }>> {
  const groups = await prisma.adGroup.findMany({
    where: { campaignId },
    select: { id: true, externalAdGroupId: true, targets: { select: { id: true } } },
  })
  return groups.map((g) => ({ id: g.id, externalAdGroupId: g.externalAdGroupId, targetIds: g.targets.map((t) => t.id) }))
}

/** Ad groups by Nexus id → Amazon's ad group id. */
export async function adGroupExternalIds(ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map()
  const groups = await prisma.adGroup.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, externalAdGroupId: true } })
  return new Map(groups.map((g) => [g.id, g.externalAdGroupId]))
}

/** Ad groups by Nexus id → their campaign (id and market). */
export async function adGroupCampaigns(ids: string[]): Promise<Map<string, { id: string; marketplace: string | null }>> {
  if (!ids.length) return new Map()
  const groups = await prisma.adGroup.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, campaign: { select: { id: true, marketplace: true } } } })
  return new Map(groups.map((g) => [g.id, g.campaign]))
}

/** Ad groups by Amazon's ad group id → the Nexus id and name. */
export async function adGroupsByExternalId(externalIds: string[]): Promise<Map<string, { id: string; name: string }>> {
  const wanted = [...new Set(externalIds.filter(Boolean))]
  if (!wanted.length) return new Map()
  const groups = await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: wanted } }, select: { id: true, name: true, externalAdGroupId: true } })
  return new Map(groups.map((g) => [g.externalAdGroupId as string, { id: g.id, name: g.name }]))
}

/** MCP full control A8 — a campaign's ad groups whose default bid a suppression would floor, and those it remembers. */
export async function adGroupSuppressionCounts(campaignId: string, floorCents: number): Promise<{ aboveFloor: number; remembered: number; ownFloors: number }> {
  // W1-6b — `remembered`: what a campaign restore gives back, so not an ad group floored on its own (its owner lifts
  // that one; `ownFloors` counts them).
  const [aboveFloor, remembered, ownFloors] = await Promise.all([
    prisma.adGroup.count({ where: { campaignId, defaultBidCents: { gt: floorCents }, suppressedFromBidCents: null } }),
    prisma.adGroup.count({ where: { campaignId, bidsSuppressedAt: null, suppressedFromBidCents: { not: null } } }),
    prisma.adGroup.count({ where: { campaignId, bidsSuppressedAt: { not: null } } }),
  ])
  return { aboveFloor, remembered, ownFloors }
}

/**
 * ADS AUTONOMY AA-W2-9 — the highest ad group default bid above a stop bid that a suppression would floor (null: none),
 * so a stop by rule is measured from the highest bid it lowers.
 */
export async function highestAdGroupBidAbove(campaignId: string, floorCents: number): Promise<number | null> {
  const top = await prisma.adGroup.aggregate({ where: { campaignId, defaultBidCents: { gt: floorCents }, suppressedFromBidCents: null }, _max: { defaultBidCents: true } })
  return top._max.defaultBidCents ?? null
}

/** AA-W2-9 — ad groups by Nexus id → their default bid now (an ad undo is judged from the value stored now). */
export async function adGroupDefaultBids(ids: string[]): Promise<Map<string, number | null>> {
  if (!ids.length) return new Map()
  const groups = await prisma.adGroup.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, defaultBidCents: true } })
  return new Map(groups.map((g) => [g.id, g.defaultBidCents]))
}

/** The rules' pending suggestions, the most recently re-proposed first (at most `take`). */
export async function pendingRuleSuggestions(take = 500) {
  return prisma.adsRuleSuggestion.findMany({
    where: { status: 'pending' },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
    take,
    select: {
      id: true, ruleId: true, ruleName: true, entityType: true, entityId: true, entityName: true, marketplace: true,
      proposedAction: true, proposedKey: true, createdAt: true, lastSeenAt: true,
    },
  })
}

/**
 * A11 — what a launch created under one campaign, counted: the campaign, its ad groups, product ads and targets
 * (positive and negative), and how many of them carry an Amazon id. approval-status reads it for create-ad-campaign.
 */
export async function campaignStructureCounts(campaignId: string): Promise<{
  campaign: number; adGroups: number; productAds: number; targets: number; negatives: number; total: number; withAmazonId: number
}> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { externalCampaignId: true } })
  if (!campaign) return { campaign: 0, adGroups: 0, productAds: 0, targets: 0, negatives: 0, total: 0, withAmazonId: 0 }
  const groups = await prisma.adGroup.findMany({
    where: { campaignId },
    select: {
      externalAdGroupId: true,
      productAds: { select: { externalAdId: true } },
      targets: { select: { externalTargetId: true, isNegative: true } },
    },
  })
  const ads = groups.flatMap((g) => g.productAds)
  const targets = groups.flatMap((g) => g.targets)
  const ids = [campaign.externalCampaignId, ...groups.map((g) => g.externalAdGroupId), ...ads.map((a) => a.externalAdId), ...targets.map((t) => t.externalTargetId)]
  return {
    campaign: 1,
    adGroups: groups.length,
    productAds: ads.length,
    targets: targets.filter((t) => !t.isNegative).length,
    negatives: targets.filter((t) => t.isNegative).length,
    total: ids.length,
    withAmazonId: ids.filter(Boolean).length,
  }
}

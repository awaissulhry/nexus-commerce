/**
 * ADS AUTONOMY AA-W2-12 — what pause-ads and enable-ads (agents/tools/ads-status.tools.ts) read of the advertising
 * context's own tables (ad groups, drift), so the tools stay outside them (scripts/check-context-boundary.mjs). Reads
 * only, in the business of the call.
 */
import prisma from '../../db.js'

/** The campaign columns a status change reads. */
export const STATUS_CAMPAIGN_SELECT = { id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, dailyBudget: true, dailyBudgetCurrency: true } as const

/** Ad groups by id, with what a status change needs of each and of its campaign. */
export async function adGroupsForStatus(ids: string[]) {
  if (!ids.length) return []
  return prisma.adGroup.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, status: true, externalAdGroupId: true, orphanedAt: true, campaign: { select: STATUS_CAMPAIGN_SELECT } },
  })
}

/** What stops serving with the campaigns and ad groups paused: their enabled ad groups, keywords and targets, product ads. */
export async function servingUnder(campaignIds: string[], adGroupIds: string[]): Promise<{ adGroups: number; targets: number; productAds: number }> {
  if (!campaignIds.length && !adGroupIds.length) return { adGroups: 0, targets: 0, productAds: 0 }
  const ofCampaigns = campaignIds.length ? await prisma.adGroup.findMany({ where: { campaignId: { in: campaignIds }, status: 'ENABLED' }, select: { id: true } }) : []
  const groups = [...new Set([...ofCampaigns.map((g) => g.id), ...adGroupIds])]
  const [targets, productAds] = await Promise.all([
    prisma.adTarget.count({ where: { adGroupId: { in: groups }, status: 'ENABLED', isNegative: false } }),
    prisma.adProductAd.count({ where: { adGroupId: { in: groups }, status: 'ENABLED' } }),
  ])
  return { adGroups: ofCampaigns.length, targets, productAds }
}

/**
 * The highest bid that serves again with each entity switched back on, in its campaign's currency, keyed
 * `<level>:<id>`: a keyword's or target's own bid; an ad group's default bid and its enabled targets'; a campaign's
 * across its enabled ad groups; a product ad's ad group's. Null when nothing bids.
 */
export async function highestServingBids(refs: Array<{ level: 'campaign' | 'adGroup' | 'target' | 'productAd'; id: string; adGroupId: string | null }>): Promise<Map<string, number | null>> {
  const campaignIds = refs.filter((r) => r.level === 'campaign').map((r) => r.id)
  const groupsAsked = [...new Set(refs.filter((r) => (r.level === 'adGroup' || r.level === 'productAd') && r.adGroupId).map((r) => r.adGroupId!))]
  const targetIds = refs.filter((r) => r.level === 'target').map((r) => r.id)
  const groupSelect = { id: true, campaignId: true, defaultBidCents: true } as const
  const [ofCampaigns, asked, targets] = await Promise.all([
    campaignIds.length ? prisma.adGroup.findMany({ where: { campaignId: { in: campaignIds }, status: 'ENABLED' }, select: groupSelect }) : [],
    groupsAsked.length ? prisma.adGroup.findMany({ where: { id: { in: groupsAsked } }, select: groupSelect }) : [],
    targetIds.length ? prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, bidCents: true } }) : [],
  ])
  const groups = new Map([...ofCampaigns, ...asked].map((g) => [g.id, g]))
  const enabled = groups.size
    ? await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroupId: { in: [...groups.keys()] }, status: 'ENABLED', isNegative: false }, _max: { bidCents: true } })
    : []
  const groupHighest = (id: string | null): number | null => {
    const g = id ? groups.get(id) : undefined
    return g ? Math.max(g.defaultBidCents, enabled.find((e) => e.adGroupId === g.id)?._max.bidCents ?? 0) : null
  }
  const out = new Map<string, number | null>()
  for (const r of refs) {
    const key = `${r.level}:${r.id}`
    if (r.level === 'target') out.set(key, targets.find((t) => t.id === r.id)?.bidCents ?? null)
    else if (r.level === 'campaign') {
      const values = ofCampaigns.filter((g) => g.campaignId === r.id).map((g) => groupHighest(g.id) ?? 0)
      out.set(key, values.length ? Math.max(...values) : null)
    } else out.set(key, groupHighest(r.adGroupId))
  }
  return out
}

/** The status changes Amazon reported made outside Nexus (AdDrift EXTERNAL_CHANGE on status or state), per entity. */
export async function externalStatusChanges(entities: Array<{ entityType: string; ids: string[] }>): Promise<Array<{ entityType: string; entityId: string; lastDetectedAt: Date }>> {
  const wanted = entities.filter((e) => e.ids.length)
  if (!wanted.length) return []
  return prisma.adDrift.findMany({
    where: { OR: wanted.map((e) => ({ entityType: e.entityType, entityId: { in: e.ids } })), field: { in: ['status', 'state'] }, classification: 'EXTERNAL_CHANGE' },
    select: { entityType: true, entityId: true, lastDetectedAt: true },
  })
}

/** The status Nexus holds now for each ad group named. */
export async function adGroupStatuses(ids: string[]): Promise<Array<{ id: string; status: string }>> {
  if (!ids.length) return []
  const rows = await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  return rows.map((r) => ({ id: r.id, status: String(r.status) }))
}

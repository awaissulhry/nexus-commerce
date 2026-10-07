/**
 * ADS AUTONOMY W4-6 — what Claude's ad group tools (agents/tools/ads-ad-groups.tools.ts: ad-groups, create-ad-group,
 * add-product-ads, set-ad-group) read of the advertising context's own ad groups, so the tools stay outside them
 * (scripts/check-context-boundary.mjs: AdGroup is advertising's private storage). Reads only, in the business of the
 * call: another business's id is simply absent.
 */
import prisma from '../../db.js'

/** The campaign columns an ad group change reads (Campaign is shared: the tools read it themselves too). */
export const AD_GROUP_CAMPAIGN_SELECT = {
  id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, externalCampaignId: true, dailyBudget: true,
  dailyBudgetCurrency: true, targetingType: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true, dynamicBidding: true,
} as const

/** One ad group with what a change of it needs: its bids, its floor, whether Amazon holds it, and its campaign. */
export async function adGroupForChange(id: string) {
  return prisma.adGroup.findFirst({
    where: { id },
    select: {
      id: true, name: true, status: true, defaultBidCents: true, externalAdGroupId: true, orphanedAt: true, suppressedFromBidCents: true,
      bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true, campaignId: true, campaign: { select: AD_GROUP_CAMPAIGN_SELECT },
    },
  })
}

/** The ad group of this campaign (not archived) that already holds this name, case-insensitive; null when none does. */
export async function adGroupNamedInCampaign(campaignId: string, name: string, exceptId?: string): Promise<{ id: string; name: string } | null> {
  return prisma.adGroup.findFirst({
    where: { campaignId, status: { not: 'ARCHIVED' }, name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true },
  })
}

export type AdGroupStatusFilter = 'open' | 'enabled' | 'paused' | 'archived' | 'all'
const statusWhere = (s: AdGroupStatusFilter) =>
  s === 'open' ? { status: { not: 'ARCHIVED' as const } }
    : s === 'enabled' ? { status: 'ENABLED' as const }
      : s === 'paused' ? { status: 'PAUSED' as const }
        : s === 'archived' ? { status: 'ARCHIVED' as const } : {}

/**
 * Every ad group of a campaign with its product ads (the campaign page's metrics are shared out over all of them), and
 * the ids of the ones a read asks for (by status, or one ad group).
 */
export async function campaignAdGroupsForRead(campaignId: string, opts: { status: AdGroupStatusFilter; adGroupId?: string | null }) {
  const [all, wanted] = await Promise.all([
    prisma.adGroup.findMany({
      where: { campaignId },
      select: {
        id: true, name: true, status: true, defaultBidCents: true, externalAdGroupId: true, suppressedFromBidCents: true,
        bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true, orphanedAt: true,
        productAds: { select: { id: true, sku: true, asin: true, productId: true, status: true, externalAdId: true }, orderBy: { id: 'asc' } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.adGroup.findMany({ where: { campaignId, ...(opts.adGroupId ? { id: opts.adGroupId } : {}), ...statusWhere(opts.status) }, select: { id: true } }),
  ])
  return { all, wanted: new Set(wanted.map((g) => g.id)) }
}

/** An ad group's default bid, name and own floor now (a change records it; its undo compares it). */
export async function adGroupState(id: string): Promise<{ defaultBidCents: number; name: string; bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null; status: string } | null> {
  const g = await prisma.adGroup.findFirst({ where: { id }, select: { defaultBidCents: true, name: true, bidsSuppressedAt: true, bidsSuppressedBy: true, status: true } })
  return g ? { ...g, status: String(g.status) } : null
}

/**
 * W4-6 review — the ad groups held at a floor of their own (W1-6b): of one campaign, or by id. What restore-campaign
 * leaves floored, and what set-ad-group op start and undo-ad-change ask about.
 */
export async function ownFloorsOf(where: { campaignId?: string; ids?: readonly string[] }): Promise<Array<{ id: string; name: string; bidsSuppressedAt: Date; bidsSuppressedBy: string | null }>> {
  if (!where.campaignId && !where.ids?.length) return []
  const rows = await prisma.adGroup.findMany({
    where: { bidsSuppressedAt: { not: null }, ...(where.campaignId ? { campaignId: where.campaignId } : {}), ...(where.ids?.length ? { id: { in: [...where.ids] } } : {}) },
    select: { id: true, name: true, bidsSuppressedAt: true, bidsSuppressedBy: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return rows.map((r) => ({ ...r, bidsSuppressedAt: r.bidsSuppressedAt as Date }))
}

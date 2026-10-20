/**
 * SD creatives (2026-10-20) — the ad groups a creative belongs to, as Claude's creative tools read them (agents/tools/
 * ads-sd-creatives.tools.ts): the ad group, its campaign and their Amazon ids. Read only; the database client is scoped
 * to the business the call runs in. Here because ad groups are advertising's own storage (scripts/check-context-boundary.mjs).
 */
import prisma from '../../../db.js'

const GROUP_SELECT = {
  id: true, name: true, status: true, externalAdGroupId: true, creativeType: true, campaignId: true,
  campaign: { select: { id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, externalCampaignId: true } },
} as const

export interface SdCreativeGroup {
  id: string
  name: string
  status: unknown
  externalAdGroupId: string | null
  /** The creative type Nexus synced (IMAGE | VIDEO), when it did. */
  creativeType: string | null
  campaignId: string
  campaign: { id: string; name: string; type: unknown; adProduct: string | null; marketplace: string | null; status: unknown; externalCampaignId: string | null }
}

/** One ad group, or null when this business has none of that id. */
export async function sdCreativeGroupById(adGroupId: string): Promise<SdCreativeGroup | null> {
  return (await prisma.adGroup.findFirst({ where: { id: adGroupId }, select: GROUP_SELECT })) as SdCreativeGroup | null
}

/** The ad groups of a campaign (or the one named), by name, at most `take`. */
export async function sdCreativeGroups(filter: { campaignId?: string; adGroupId?: string }, take: number): Promise<SdCreativeGroup[]> {
  return (await prisma.adGroup.findMany({
    where: { ...(filter.adGroupId ? { id: filter.adGroupId } : {}), ...(filter.campaignId ? { campaignId: filter.campaignId } : {}) },
    select: GROUP_SELECT, orderBy: { name: 'asc' }, take,
  })) as SdCreativeGroup[]
}

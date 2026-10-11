/**
 * HARVEST ENGINE (Owner 10-08 D1 = B, Keyword Harvest page lead choice) — a new campaign the brain's own harvest built
 * (AdsBrainHarvest NEW_CAMPAIGN, CAMPAIGN_BUILT: its create-ad-campaign request a person approved) counts as BRAIN-BUILT
 * for its go-live: one normal approval inside the caps, as the structure lever's single-keyword campaigns
 * (brain/structure-golive.ts reads these rows beside its own). Read only; a read that fails answers none (the door's own
 * line — the code — applies, never a looser door).
 */
import prisma from '../../../db.js'

/** The structure-golive rows of these campaigns that a brain harvest built (kind SKC, status BUILT). */
export async function harvestBuiltRows(campaignIds: readonly string[]): Promise<Array<{ key: string; kind: string; status: string; productId: string; marketplace: string; plan: unknown; evidence: unknown; builtCampaignIds: string[] }>> {
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length) return []
  try {
    const rows = await prisma.adsBrainHarvest.findMany({
      where: { actorKind: 'BRAIN', destinationKind: 'NEW_CAMPAIGN', status: 'CAMPAIGN_BUILT', destCampaignId: { in: ids } },
      select: { id: true, productId: true, marketplace: true, destCampaignId: true },
    })
    return rows.map((r) => ({ key: `harvest:${r.id}`, kind: 'SKC', status: 'BUILT', productId: r.productId, marketplace: r.marketplace, plan: {}, evidence: {}, builtCampaignIds: [r.destCampaignId!] }))
  } catch {
    return []
  }
}

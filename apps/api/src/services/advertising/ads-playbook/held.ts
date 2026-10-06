/**
 * ADS PLAYBOOK PB-5b — the campaigns whose bids only a playbook START gives back, so no other door lifts them without
 * the approver's authenticator code (restore-campaign, undo-ad-change):
 *
 *   built   a slot a playbook built (AdsPlaybookLink kind slot, origin built): born at the floor, stopped at the floor
 *   held    a campaign whose hourly plan's floor a playbook STOP took over (kind STOP_FLOOR_KIND, one per campaign: the
 *           STOP's approver holds it, `updatedBy`) — an adopted campaign too; START gives it back and drops the link
 *
 * Only db: the tools read it while the tool registry loads.
 */
import prisma from '../../../db.js'

/** The link a STOP writes for each campaign whose rank floor it took over: key and refId the campaign, updatedBy the holder. */
export const STOP_FLOOR_KIND = 'stopFloor'

/** Which of these campaigns a playbook holds this way (by campaign id); absent: none. */
export async function playbookHolds(campaignIds: readonly string[]): Promise<Map<string, 'built' | 'held'>> {
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const links = await prisma.adsPlaybookLink.findMany({
    where: { refId: { in: ids }, OR: [{ kind: 'slot', origin: 'built' }, { kind: STOP_FLOOR_KIND }] },
    select: { kind: true, refId: true },
  })
  const out = new Map<string, 'built' | 'held'>()
  for (const l of links) if (!out.has(l.refId) || l.kind === 'slot') out.set(l.refId, l.kind === 'slot' ? 'built' : 'held')
  return out
}

/** The same, for the targets, ad groups and campaigns a change touches (each by its campaign): the first one held, or null. */
export async function playbookHoldOf(entities: { targetIds?: readonly string[]; adGroupIds?: readonly string[]; campaignIds?: readonly string[] }): Promise<{ campaignId: string; name: string; why: 'built' | 'held' } | null> {
  const [targets, groups] = await Promise.all([
    entities.targetIds?.length ? prisma.adTarget.findMany({ where: { id: { in: [...entities.targetIds] } }, select: { adGroup: { select: { campaignId: true } } } }) : [],
    entities.adGroupIds?.length ? prisma.adGroup.findMany({ where: { id: { in: [...entities.adGroupIds] } }, select: { campaignId: true } }) : [],
  ])
  const held = await playbookHolds([...(entities.campaignIds ?? []), ...targets.map((t) => t.adGroup.campaignId), ...groups.map((g) => g.campaignId)])
  const first = [...held.entries()][0]
  if (!first) return null
  const name = (await prisma.campaign.findUnique({ where: { id: first[0] }, select: { name: true } }))?.name ?? first[0]
  return { campaignId: first[0], name, why: first[1] }
}

/** Why a door other than START may not give these bids back. */
export function startOnlyRefusal(name: string, why: 'built' | 'held'): string {
  return `${name} ${why === 'built' ? 'was built by an ads playbook' : 'is at a floor a playbook stop holds'}: its bids go back only with apply-ads-playbook op start, `
    + "which needs the approver's authenticator code and switches the playbook's hourly plans and rules on with them"
}

/**
 * C3 (2026-10-10) — an archived campaign leaves the brain. Archiving a campaign did not end what the brain held on it:
 * its BidBrainEnrollment stayed LIVE (or HELD), so `brainOwnedCampaignIds` still counted it, and the Owner's CAMPAIGN
 * overrides stayed in force (endedAt null) — the brain's views listed a campaign Amazon will never serve again as owned.
 *
 * Review 2026-10-10 — a campaign's ARCHIVED status alone is not proof: the settings sync marks a campaign ARCHIVED when
 * Amazon's ENABLED + PAUSED list does not return it (ads-campaign-settings-sync.service.ts reconcileCampaignDeletions),
 * and the next sync that returns it puts its status back. Campaign keeps no "archived since" column, so this waits a day
 * and acts on the evidence it has:
 *   · proof     Amazon accepted Nexus's own archive of the campaign at least ARCHIVED_WAIT_MS ago (an action-log row whose
 *               status went to ARCHIVED, its queue row SUCCESS with syncedAt, or an inline write SUCCESS). An archive
 *               Amazon accepted is final. Then the LIVE or HELD enrollment becomes SHADOW (hold fields cleared) AND the
 *               Owner's open CAMPAIGN overrides end (endedAt now, endedBy 'system:campaign-archived').
 *   · quiet     no such proof (archived in Seller Central, seen only by the sync): the Owner's overrides are NOT ended —
 *               they stay his, and the read side already says they take no effect on an archived campaign. Only the
 *               enrollment becomes SHADOW, once the sync has not seen the campaign alive for ARCHIVED_WAIT_MS
 *               (`lastSyncedAt`: the sync stamps it on every campaign Amazon returns and when it archives one; a sync
 *               that returns the campaign puts its status back, and any write stamps it later, never earlier).
 * Nexus only — nothing is sent to Amazon, nothing is given back; one note per campaign in the ads action log (a
 * custom_event). PAUSED campaigns are left as they are. Idempotent: a second run finds nothing. Run at the start of every
 * ads-brain-state tick (jobs/ads-brain-state.job.ts, hourly).
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { forgetLeverOwners } from './lever-owners.js'

export const CAMPAIGN_ARCHIVED_BY = 'system:campaign-archived'
export const ARCHIVED_OWNERSHIP_NOTE = 'brain ownership ended: the campaign is archived'
/** How long a campaign must have been archived before the brain lets go of it. */
export const ARCHIVED_WAIT_MS = 24 * 3_600_000

export interface ArchivedOwnershipResult {
  /** Campaigns whose enrollment went from LIVE or HELD to SHADOW. */
  enrollments: string[]
  /** CAMPAIGN overrides ended (only on a campaign whose archive Amazon accepted from Nexus). */
  overrides: number
  /** Every campaign something was ended on (one note each). */
  campaigns: string[]
}

const NOTHING: ArchivedOwnershipResult = { enrollments: [], overrides: 0, campaigns: [] }

/**
 * When Amazon accepted Nexus's archive of each campaign (the earliest: an archive Amazon accepted is final). A write
 * whose status was ARCHIVED before is not an archive. Read only.
 */
export async function archiveAcceptedAt(campaignIds: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  if (!campaignIds.length) return out
  const logs = await prisma.advertisingActionLog.findMany({
    where: {
      entityType: 'CAMPAIGN', entityId: { in: [...campaignIds] },
      payloadAfter: { path: ['status'], equals: 'ARCHIVED' },
      NOT: { payloadBefore: { path: ['status'], equals: 'ARCHIVED' } },
    },
    select: { entityId: true, createdAt: true, outboundQueueId: true, amazonResponseStatus: true },
  })
  const queueIds = logs.map((l) => l.outboundQueueId).filter((id): id is string => !!id)
  const sent = new Map(
    (queueIds.length ? await prisma.outboundSyncQueue.findMany({ where: { id: { in: queueIds }, syncStatus: 'SUCCESS', syncedAt: { not: null } }, select: { id: true, syncedAt: true } }) : [])
      .map((q) => [q.id, q.syncedAt!] as const),
  )
  for (const l of logs) {
    const at = l.outboundQueueId ? sent.get(l.outboundQueueId) ?? null : l.amazonResponseStatus === 'SUCCESS' ? l.createdAt : null
    if (!at) continue
    const was = out.get(l.entityId)
    if (!was || at < was) out.set(l.entityId, at)
  }
  return out
}

export async function endBrainOwnershipOfArchived(now: Date = new Date()): Promise<ArchivedOwnershipResult> {
  const [enrolled, open] = await Promise.all([
    prisma.bidBrainEnrollment.findMany({ where: { mode: { in: ['LIVE', 'HELD'] } }, select: { id: true, campaignId: true, mode: true } }),
    prisma.adsBrainOverride.findMany({ where: { scope: 'CAMPAIGN', endedAt: null, campaignId: { not: null } }, select: { id: true, campaignId: true } }),
  ])
  const candidates = [...new Set([...enrolled.map((e) => e.campaignId), ...open.map((o) => o.campaignId!)])]
  if (!candidates.length) return NOTHING
  const archived = await prisma.campaign.findMany({ where: { id: { in: candidates }, status: 'ARCHIVED' }, select: { id: true, lastSyncedAt: true } })
  if (!archived.length) return NOTHING

  const before = now.getTime() - ARCHIVED_WAIT_MS
  const accepted = await archiveAcceptedAt(archived.map((c) => c.id))
  /** Amazon accepted Nexus's archive a day ago or more: final. */
  const proven = new Set(archived.filter((c) => (accepted.get(c.id)?.getTime() ?? Infinity) <= before).map((c) => c.id))
  /** No sync has seen it alive for a day (no proof needed to stop the brain writing it; never enough to end his overrides). */
  const quiet = new Set(archived.filter((c) => c.lastSyncedAt != null && c.lastSyncedAt.getTime() <= before).map((c) => c.id))

  const leaving = enrolled.filter((e) => proven.has(e.campaignId) || quiet.has(e.campaignId))
  const ending = open.filter((o) => proven.has(o.campaignId!))
  if (!leaving.length && !ending.length) return NOTHING
  if (leaving.length) {
    await prisma.bidBrainEnrollment.updateMany({
      where: { id: { in: leaving.map((e) => e.id) }, mode: { in: ['LIVE', 'HELD'] } },
      data: { mode: 'SHADOW', heldUntil: null, heldBy: null, heldReason: null },
    })
  }
  if (ending.length) {
    await prisma.adsBrainOverride.updateMany({ where: { id: { in: ending.map((o) => o.id) }, endedAt: null }, data: { endedAt: now, endedBy: CAMPAIGN_ARCHIVED_BY } })
  }

  const campaigns = [...new Set([...leaving.map((e) => e.campaignId), ...ending.map((o) => o.campaignId!)])].sort()
  await prisma.advertisingActionLog.createMany({
    data: campaigns.map((id) => {
      const enrollment = leaving.find((e) => e.campaignId === id)
      const overrides = ending.filter((o) => o.campaignId === id).length
      const how = proven.has(id)
        ? 'Amazon accepted its archive from Nexus a day or more ago'
        : 'it has been archived and unseen by the settings sync for a day or more; the Owner\'s campaign overrides stay (they take no effect on an archived campaign)'
      return {
        actionType: 'custom_event', entityType: 'CAMPAIGN', entityId: id, userId: CAMPAIGN_ARCHIVED_BY, amazonResponseStatus: 'SUCCESS',
        payloadBefore: { ...(enrollment ? { enrollment: enrollment.mode } : {}), ...(overrides ? { openOverrides: overrides } : {}) },
        payloadAfter: { note: `${ARCHIVED_OWNERSHIP_NOTE} — ${how}`, ...(enrollment ? { enrollment: 'SHADOW' } : {}), ...(overrides ? { overridesEnded: overrides } : {}) },
      }
    }),
  })
  forgetLeverOwners()
  logger.info('[ads-brain] brain ownership ended on archived campaigns', { campaigns, enrollments: leaving.length, overrides: ending.length })
  return { enrollments: leaving.map((e) => e.campaignId).sort(), overrides: ending.length, campaigns }
}

/** The run line when something was ended; empty when nothing was. */
export function archivedOwnershipLine(r: ArchivedOwnershipResult): string {
  if (!r.campaigns.length) return ''
  return `archived campaigns left the brain: ${r.campaigns.length} (enrollments to shadow ${r.enrollments.length}, overrides ended ${r.overrides})`
}

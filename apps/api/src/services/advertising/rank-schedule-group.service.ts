/**
 * ADS AUTONOMY W4-1 — one rank-schedule group (an hourly bid plan on the Hourly Bids page) changed WITHOUT its member
 * list: renamed, switched on or off, or a field of the group row set. This is the lightweight PATCH
 * /advertising/rank-schedule-groups/:id (no `campaignIds`), moved here unchanged so the screen and Claude's
 * set-hourly-bid-plan (op rename, op switch) take one path, never a second. The route parses, calls this and answers
 * with `answer` exactly as before (rank-schedule-group-route-parity.vitest.test.ts holds it byte for byte).
 *
 *   rename   trimmed; refused (409) when another plan in the same scope (portfolio, or none) already has the name — the
 *            duplicate DPS.1 removed would come back by hand otherwise (saveRankScheduleGroup adopts by name).
 *   switch   the members follow the group's `enabled`; switched off, the plan gives back what it floored on every member
 *            once they say paused (2a, rank-release.service.ts releaseGroupMembers).
 *   version  RD.P7 — a version row when something meaningful changed (the comparison saveRankScheduleGroup uses), so the
 *            history answers who switched it and when; a failed snapshot warns and never fails the write.
 *
 * NOT for the windows or the members: this path updates the group row only, and the members' own rows (what the
 * rank-defend engine reads) keep their old hours. Those go through saveRankScheduleGroup (ads-create.service.ts).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

/** The group fields the lightweight PATCH sets, as the route always took them. */
const LIGHT_FIELDS = ['name', 'windows', 'defaultTargetKey', 'targetOverrides', 'enabled', 'marketplace', 'portfolioId', 'timezone'] as const

/**
 * PATCH /advertising/rank-schedule-groups/:id without `campaignIds`. `changedBy`: who the version row names (the route:
 * the `x-actor-id` header as `user:<id>`, else `user:anonymous`).
 */
export async function patchRankScheduleGroup(id: string, b: Record<string, unknown>, changedBy: string): Promise<ServiceOutcome<unknown>> {
  const data: Record<string, unknown> = {}
  for (const k of LIGHT_FIELDS) if (b[k] !== undefined) data[k] = b[k]
  if (!Object.keys(data).length) return refused(400, { error: 'nothing to update' })
  // RDX/B2 — a rename must not manufacture the duplicate DPS.1 spent a phase eliminating.
  // saveRankScheduleGroup adopts an existing (name, portfolioId) group rather than minting a
  // rival, but this lightweight PATCH bypasses that path entirely — so without this guard,
  // renaming "IT AIRMESH 2" to "IT AIRMESH" would recreate the exact collision by hand.
  if (typeof data.name === 'string') {
    const nm = String(data.name).trim()
    if (!nm) return refused(400, { error: 'name is required' })
    data.name = nm
    const self = await prisma.rankScheduleGroup.findUnique({ where: { id }, select: { portfolioId: true } })
    const twin = await prisma.rankScheduleGroup.findFirst({
      where: { name: nm, portfolioId: self?.portfolioId ?? null, NOT: { id } },
      select: { id: true },
    })
    if (twin) return refused(409, { error: `Another schedule in this scope is already called "${nm}".` })
  }
  try {
    const g = await prisma.rankScheduleGroup.update({ where: { id }, data })
    if (b.enabled !== undefined) await prisma.adSchedule.updateMany({ where: { groupId: id }, data: { enabled: !!b.enabled } })
    // 2a (review 3.2) — pausing gives back what the group floored on every member, once the members say paused.
    let release: unknown
    if (b.enabled === false) {
      const { releaseGroupMembers } = await import('./rank-release.service.js')
      release = await releaseGroupMembers(id, 'its rank schedule was paused')
    }
    /**
     * RD.P7 — the most consequential click on the page (Enable/Pause) took this lightweight
     * path and wrote NO version, so the history could not answer "who paused this and when".
     * Snapshot with the same meaningful-change comparison saveRankScheduleGroup uses; a
     * failed snapshot warns and never fails the write it describes.
     */
    try {
      const members = await prisma.adSchedule.count({ where: { groupId: id } })
      const last = await prisma.rankScheduleVersion.findFirst({ where: { groupId: id }, orderBy: { createdAt: 'desc' }, select: { name: true, windows: true, defaultTargetKey: true, campaignCount: true, enabled: true } })
      const changed = !last
        || last.name !== g.name
        || (last.defaultTargetKey ?? null) !== (g.defaultTargetKey ?? null)
        || last.campaignCount !== members
        || last.enabled !== g.enabled
        || JSON.stringify(last.windows) !== JSON.stringify(g.windows)
      if (changed) {
        await prisma.rankScheduleVersion.create({
          data: { groupId: id, name: g.name, windows: g.windows as never, defaultTargetKey: g.defaultTargetKey ?? null, campaignCount: members, enabled: g.enabled, changedBy },
        })
      }
    } catch (e) { logger.warn('[RD.P7] version snapshot failed on lightweight PATCH', { id, error: (e as Error).message }) }
    return done(release ? { ...g, release } : g)
  } catch (e) { return refused(500, { error: (e as Error)?.message }) }
}

/**
 * R10 (MCP full control, part 06) — a dayparting / rank schedule's patch, moved unchanged out of
 * `PATCH /advertising/schedules/:id` (advertising.routes.ts) so turn-down-automation switches a schedule off through the
 * same code. The route answers byte for byte as before (automation-schedule-route-parity.vitest.test.ts).
 *
 * 2a (review 3.3) — switching a schedule off, or deleting it, no longer writes `status: ENABLED`. The RC2.T3 resume read
 * `lastApplied === 'PAUSED'` as "this schedule paused the campaign", but since the no-pause rule the dayparting cron
 * records PAUSED for a closed window it only floored bids — so the resume re-enabled campaigns a person had paused. Both
 * now give back the bids the schedule floored instead (rank-release.service.ts); the campaign keeps its status.
 */
import type { AdSchedule } from '@prisma/client'
import prisma from '../../db.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'
import { readScheduleMembers, releaseScheduleMembers, type ReleaseReport } from './rank-release.service.js'

export async function patchAdSchedule(id: string, b: Record<string, unknown>): Promise<ServiceOutcome<AdSchedule>> {
  const data: Record<string, unknown> = {}
  for (const k of ['name', 'windows', 'timezone', 'enabled', 'defaultTargetKey', 'targetOverrides']) if (b[k] !== undefined) data[k] = b[k]
  const before = await prisma.adSchedule.findUnique({ where: { id }, select: { campaignId: true } })
  if (!before) return refused(404, { error: 'not found' })
  let updated: AdSchedule
  try { updated = await prisma.adSchedule.update({ where: { id }, data }) } catch { return refused(404, { error: 'not found' }) }
  // Switched off: give back what it floored, after the row says so (a tick starting meanwhile skips it).
  if (data.enabled === false) {
    await releaseScheduleMembers([{ scheduleId: id, campaignId: updated.campaignId, windows: updated.windows, defaultTargetKey: updated.defaultTargetKey }], 'its schedule was switched off')
  }
  return done(updated)
}

/** `DELETE /advertising/schedules/:id`: delete the schedule, then give back what it floored. */
export async function deleteAdSchedule(id: string): Promise<ServiceOutcome<{ ok: true; release: ReleaseReport }>> {
  const members = await readScheduleMembers({ id })
  if (!members.length) return refused(404, { error: 'not found' })
  try { await prisma.adSchedule.delete({ where: { id } }) } catch { return refused(404, { error: 'not found' }) }
  return done({ ok: true, release: await releaseScheduleMembers(members, 'its schedule was deleted') })
}

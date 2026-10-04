/**
 * R10 (MCP full control, part 06) — a dayparting / rank schedule's patch, moved unchanged out of
 * `PATCH /advertising/schedules/:id` (advertising.routes.ts) so turn-down-automation switches a schedule off through the
 * same code. The route answers byte for byte as before (automation-schedule-route-parity.vitest.test.ts).
 *
 * 2a (review 3.3) — switching a schedule off, or deleting it, no longer writes `status: ENABLED`. The RC2.T3 resume read
 * `lastApplied === 'PAUSED'` as "this schedule paused the campaign", but since the no-pause rule the dayparting cron
 * records PAUSED for a closed window it only floored bids — so the resume re-enabled campaigns a person had paused. Both
 * now give back the bids the schedule floored instead (rank-release.service.ts); the campaign keeps its status.
 *
 * 2d (review 3.9) — and a classic schedule's bid multiplier comes back too (`giveBackMultiplier`, ad-dayparting.job.ts):
 * the bids still at the window's level return to the bids it remembered. It goes first, so a closing-window floor takes
 * the base into its memory and the release then writes each bid once.
 */
import type { AdSchedule } from '@prisma/client'
import prisma from '../../db.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'
import { readScheduleMembers, releaseScheduleMembers, type ReleaseReport } from './rank-release.service.js'
import type { MultiplierGiveBack } from '../../jobs/ad-dayparting.job.js'

export async function patchAdSchedule(id: string, b: Record<string, unknown>): Promise<ServiceOutcome<AdSchedule>> {
  const data: Record<string, unknown> = {}
  for (const k of ['name', 'windows', 'timezone', 'enabled', 'defaultTargetKey', 'targetOverrides']) if (b[k] !== undefined) data[k] = b[k]
  const before = await prisma.adSchedule.findUnique({ where: { id }, select: { campaignId: true } })
  if (!before) return refused(404, { error: 'not found' })
  let updated: AdSchedule
  try { updated = await prisma.adSchedule.update({ where: { id }, data }) } catch { return refused(404, { error: 'not found' }) }
  // Switched off: give back what it floored, after the row says so (a tick starting meanwhile skips it). A multiplier
  // give-back that must wait (ads automation stopped) stays on the row; the dayparting run gives it back after Resume.
  if (data.enabled === false) {
    await (await import('../../jobs/ad-dayparting.job.js')).giveBackMultiplier(updated, 'bid multiplier given back — its schedule was switched off')
    await releaseScheduleMembers([{ scheduleId: id, campaignId: updated.campaignId, windows: updated.windows, defaultTargetKey: updated.defaultTargetKey }], 'its schedule was switched off')
  }
  return done(updated)
}

/**
 * `DELETE /advertising/schedules/:id`: delete the schedule, then give back its bid multiplier and what it floored. The
 * multiplier's remembered bids live on the row, so a delete that could not give them back now (ads automation stopped)
 * would lose them: refused, nothing changed — switching it off keeps them for the first run after Resume.
 */
export async function deleteAdSchedule(id: string): Promise<ServiceOutcome<{ ok: true; release: ReleaseReport; multiplier?: MultiplierGiveBack }>> {
  const members = await readScheduleMembers({ id })
  if (!members.length) return refused(404, { error: 'not found' })
  const { giveBackMultiplier, multiplierWaitWhy } = await import('../../jobs/ad-dayparting.job.js')
  const row = await prisma.adSchedule.findUnique({ where: { id }, select: { id: true, campaignId: true, originalBids: true } })
  const wait = row ? await multiplierWaitWhy(row) : null
  if (wait) return refused(409, { error: `Its bid multiplier is on and ${wait}, so the bids it changed cannot go back yet. Switch the schedule off instead: its bids come back on the first run after Resume, and it can be deleted then. Nothing was changed.` })
  try { await prisma.adSchedule.delete({ where: { id } }) } catch { return refused(404, { error: 'not found' }) }
  const multiplier = row?.originalBids ? await giveBackMultiplier(row, 'bid multiplier given back — its schedule was deleted') : undefined
  // With the row gone nothing retries: a give-back that did not finish says the bids stay as they are.
  if (multiplier?.deferred) multiplier.why = 'the give-back did not finish and the schedule is deleted, so the bids it changed stay as they are'
  return done({ ok: true, release: await releaseScheduleMembers(members, 'its schedule was deleted'), ...(multiplier && (multiplier.restored || multiplier.deferred) ? { multiplier } : {}) })
}

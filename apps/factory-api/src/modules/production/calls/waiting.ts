import { businessDate } from '@nexus/factory-domain/core/time'
import type { CommandTools } from '../../../core/command'
import { scanSubjectFor } from '../settings/subject'
import { closedDays, dayKey, latestEndOf, lockBlock, lockRunningBlock, readCode, runningStretchOf, type Subject } from '../offstandard/store'
import { dayColumn } from '../offstandard/views'
import { endBlock, insertBlock } from '../offstandard/writes'

/**
 * The station's waiting while a help call is open (MES-148; B-W2b-29's off-standard time): a call of a type that books
 * its waiting to an off-standard code starts a HELP_CALL block for the station's subject when it is sent, and the block
 * ends when the call is solved or cancelled — both in the call's own command, through B-W2b-29's writes (insertBlock,
 * endBlock: their audit rows and events). The waiting time never counts against the worker: its code's pay rule pays it.
 *
 * A call always goes out: the waiting is booked only when it can be, and skipped (never refused) otherwise —
 *   - the call is not the tablet's own station's (a team leader calling for another station: whose waiting is unknown);
 *   - at a site that names workers, the caller is not named (no notice acknowledged): there is no subject to book to;
 *   - the code is no longer an active off-standard code, a bundle runs for the subject (its time is standard work), the
 *     subject already waits on another call (that block covers the time), or the line's day is closed.
 * Another block running for the subject (a tile tapped before the call: waiting for material) ends first (SWITCH).
 */

export interface WaitingStart {
  readonly tenantId: string
  readonly site: { readonly id: string; readonly companyId: string; readonly timezone: string }
  readonly station: { readonly id: string; readonly lineId: string | null }
  readonly codeId: string
  /** The caller where the site names workers (null otherwise). */
  readonly named: { readonly workerId: string; readonly employeeId: string | null } | null
  readonly callId: string
  readonly at: Date
  readonly deviceId: string
}

/** Starts the call's waiting block, or skips it (see above). Returns the block's id, or null when nothing was booked. */
export async function startWaitingInCommand(tools: CommandTools, input: WaitingStart): Promise<string | null> {
  const { tx } = tools
  const subject: Subject | null = (await scanSubjectFor(tx, input.site.id)) === 'STATION' ? { workerId: null, stationId: input.station.id } : input.named ? { workerId: input.named.workerId, stationId: input.station.id } : null
  if (!subject) return null
  const code = await readCode(tx, input.codeId)
  if (!code || !code.active || code.kind !== 'OFF_STANDARD' || code.companyId !== input.site.companyId) return null
  if (await runningStretchOf(tx, input.tenantId, input.site.id, subject)) return null
  const running = await lockRunningBlock(tx, input.tenantId, input.site.id, subject)
  if (running?.helpCallId) return null
  // Never before the subject's latest block ended (a tablet's clock behind): no overlap.
  let startedAt = input.at
  if (running) {
    const runningCode = (await readCode(tx, running.codeId))!
    await endBlock(tools, running, runningCode, { at: startedAt, endedBy: 'SWITCH', bump: true, action: 'production.offStandardEnd' })
  }
  const lastEnd = await latestEndOf(tx, input.site.id, subject)
  if (lastEnd && lastEnd.getTime() > startedAt.getTime()) startedAt = lastEnd.getTime() > tools.now.getTime() ? tools.now : lastEnd
  if (input.station.lineId) {
    const workDate = dayColumn(businessDate(startedAt, input.site.timezone))
    if ((await closedDays(tx, [{ lineId: input.station.lineId, workDate }])).has(dayKey(input.station.lineId, workDate))) return null
  }
  const block = await insertBlock(tools, {
    companyId: input.site.companyId,
    siteId: input.site.id,
    timeZone: input.site.timezone,
    lineId: input.station.lineId,
    stationId: input.station.id,
    workerId: subject.workerId,
    employeeId: subject.workerId ? (input.named?.employeeId ?? null) : null,
    code,
    source: 'HELP_CALL',
    helpCallId: input.callId,
    startedAt,
    deviceId: input.deviceId,
    createdById: subject.workerId,
    action: 'production.offStandardStart',
  })
  return block.id
}

/** Ends the call's OPEN waiting block when the call is solved or cancelled (none: nothing to do). */
export async function endWaitingInCommand(tools: CommandTools, input: { readonly tenantId: string; readonly callId: string; readonly at: Date }): Promise<void> {
  const open = await tools.tx.offStandardEntry.findFirst({ where: { helpCallId: input.callId, status: 'OPEN' }, select: { id: true } })
  if (!open) return
  const block = await lockBlock(tools.tx, input.tenantId, open.id)
  if (!block || block.status !== 'OPEN') return
  const code = (await readCode(tools.tx, block.codeId))!
  await endBlock(tools, block, code, { at: input.at, endedBy: 'HELP_CALL', bump: true, action: 'production.offStandardEnd' })
}

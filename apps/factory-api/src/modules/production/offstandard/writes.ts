import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { minutesOf, statusWhenEnded, type BlockEnding, type BlockSource } from '@nexus/factory-domain/production/offstandard/rules'
import type { CommandTools } from '../../../core/command'
import { BLOCK, lockRunningBlock, readCode, type BlockRow, type CodeRow, type Subject } from './store'
import { dayColumn, isoDay } from './views'

/**
 * The writes of a block INSIDE a command (B-W2b-29), for this module's commands and for the commands of other modules
 * that start or end off-standard time in their own transaction:
 *
 *   insertBlock       a new block (running from the floor, or ended already: typed afterwards, the waiting on a help
 *                     call recorded at once) with its audit row and event. B-W2b-35 (help calls) writes its waiting
 *                     block with source HELP_CALL and the call's id through it.
 *   endBlock          a running block ends: PENDING, or APPROVED at once for a code that needs no approval; audit and event.
 *   endRunningBlock   the hook for "scanning a bundle returns to standard" (MES-156; design floor.operation "No bundle"):
 *                     the subject's running block, if it started before the scan, ends at the scan's time in the scan's
 *                     own command (modules/production/scans: a REPORT; B-W2b-40: START and RESUME, which the database
 *                     refuses while a block runs; B-W2b-33: the clock-out, `CLOCK_OUT`).
 *
 * Who a block names follows the site's floor rules (the caller resolved the subject: settings/subject.ts): at a site that
 * records the station, no worker and no creator (the audit row keeps who acted, as for scans).
 */

export interface NewBlock {
  readonly companyId: string
  readonly siteId: string
  readonly timeZone: string
  readonly lineId: string | null
  readonly stationId: string | null
  readonly workerId: string | null
  readonly employeeId: string | null
  readonly code: CodeRow
  readonly source: BlockSource
  readonly helpCallId?: string | null
  readonly startedAt: Date
  /** Ended already (typed afterwards, an offline record): its status follows the code. */
  readonly endedAt?: Date | null
  readonly note?: string | null
  readonly deviceId?: string | null
  readonly clientEventId?: string | null
  readonly deviceTime?: Date | null
  readonly createdById: string | null
  /** The command's audit action (default: the command's name). */
  readonly action?: string
}

const eventBase = (block: BlockRow, code: CodeRow) => ({
  blockId: block.id,
  siteId: block.siteId,
  lineId: block.lineId,
  stationId: block.stationId,
  codeId: code.id,
  code: code.code,
  kind: code.kind,
  workDate: isoDay(block.workDate),
})

/** What an audit row keeps of a block: its facts and state, never its note (the record has it). */
export const auditedBlock = (block: BlockRow) => ({
  codeId: block.codeId,
  lineId: block.lineId,
  stationId: block.stationId,
  workerId: block.workerId,
  source: block.source,
  workDate: isoDay(block.workDate),
  startedAt: toUtcIso(block.startedAt),
  endedAt: block.endedAt ? toUtcIso(block.endedAt) : null,
  status: block.status,
})

export async function insertBlock(tools: CommandTools, input: NewBlock): Promise<BlockRow> {
  const ended = input.endedAt ?? null
  const status = ended ? statusWhenEnded(input.code.needsApproval) : 'OPEN'
  const block = await tools.tx.offStandardEntry.create({
    data: {
      id: newId(),
      companyId: input.companyId,
      siteId: input.siteId,
      lineId: input.lineId,
      stationId: input.stationId,
      workerId: input.workerId,
      employeeId: input.workerId ? input.employeeId : null,
      codeId: input.code.id,
      source: input.source,
      helpCallId: input.helpCallId ?? null,
      workDate: dayColumn(businessDate(input.startedAt, input.timeZone)),
      startedAt: input.startedAt,
      endedAt: ended,
      status,
      approvedAt: status === 'APPROVED' ? ended : null,
      note: input.note?.trim() || null,
      deviceId: input.deviceId ?? null,
      clientEventId: input.clientEventId ?? null,
      deviceTime: input.deviceTime ?? null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: input.createdById,
    },
    select: BLOCK,
  })
  tools.audit({ ...(input.action ? { action: input.action } : {}), recordType: 'OffStandardEntry', recordId: block.id, companyId: block.companyId, siteId: block.siteId, after: auditedBlock(block) })
  if (status === 'OPEN') {
    tools.emit({ type: 'production.off_standard_started', subject: block.id, companyId: block.companyId, siteId: block.siteId, payload: { ...eventBase(block, input.code), source: block.source, status: 'OPEN' } })
  } else {
    tools.emit({
      type: 'production.off_standard_recorded',
      subject: block.id,
      companyId: block.companyId,
      siteId: block.siteId,
      payload: { ...eventBase(block, input.code), minutes: minutesOf(block.startedAt, block.endedAt), status: status as 'PENDING' | 'APPROVED' },
    })
  }
  return block
}

/**
 * Ends a running block at `at` (never before it started): PENDING, or APPROVED as it ends for a code that needs no
 * approval. `bump`: raise the version here (false when command() guarded the record and raised it already).
 */
export async function endBlock(tools: CommandTools, block: BlockRow, code: CodeRow, options: { readonly at: Date; readonly endedBy: BlockEnding; readonly bump: boolean; readonly action?: string; readonly reason?: string }): Promise<BlockRow> {
  const endedAt = options.at.getTime() < block.startedAt.getTime() ? block.startedAt : options.at
  const status = statusWhenEnded(code.needsApproval)
  const after = await tools.tx.offStandardEntry.update({
    where: { id: block.id },
    data: { endedAt, status, approvedAt: status === 'APPROVED' ? endedAt : null, updatedAt: tools.now, ...(options.bump ? { version: { increment: 1 } } : {}) },
    select: BLOCK,
  })
  tools.audit({
    ...(options.action ? { action: options.action } : {}),
    recordType: 'OffStandardEntry',
    recordId: block.id,
    companyId: block.companyId,
    siteId: block.siteId,
    before: { endedAt: null, status: block.status },
    after: { endedAt: toUtcIso(endedAt), status, endedBy: options.endedBy },
    ...(options.reason ? { reason: options.reason } : {}),
  })
  tools.emit({
    type: 'production.off_standard_ended',
    subject: block.id,
    companyId: block.companyId,
    siteId: block.siteId,
    payload: { ...eventBase(after, code), endedBy: options.endedBy, minutes: minutesOf(after.startedAt, after.endedAt), status },
  })
  return after
}

/**
 * The hook (MES-156: "scanning a bundle returns to standard"): inside the calling command, the subject's running block —
 * if it started at or before `at` — ends at `at`. Returns it, or null when none ran (or it started after: an offline
 * scan sent later). Takes the running block FOR UPDATE.
 */
export async function endRunningBlock(tools: CommandTools, input: { readonly tenantId: string; readonly siteId: string; readonly subject: Subject; readonly at: Date; readonly endedBy: BlockEnding }): Promise<BlockRow | null> {
  const running = await lockRunningBlock(tools.tx, input.tenantId, input.siteId, input.subject)
  if (!running || running.startedAt.getTime() > input.at.getTime()) return null
  const code = (await readCode(tools.tx, running.codeId))!
  return endBlock(tools, running, code, { at: input.at, endedBy: input.endedBy, bump: true, action: 'production.offStandardEnd' })
}

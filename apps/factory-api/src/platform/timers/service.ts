import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { CANCEL_REASONS, TIMER_KEY, timerPlan, type CancelReason, type PendingTimer, type TimerPlan, type WantedTimer } from '@nexus/factory-domain/timers/rules'
import type { CommandTools, CommandTx } from '../../core/command'

/**
 * THE date-timer service (B-W2a-33; PLT-100; rules factory-domain timers/rules; table DueTimer, alerts.prisma): every
 * date-relative firing of the factory is a timer set here, inside the command that knows the date, and fired by the
 * scheduler (./fire.ts, cron `timers.fire`, one replica per tick). The exception rules' DATE kinds keep their timers in
 * step with the records' dates (platform/alerts/engine.ts); B-W2a-52 (PO reminders), B-W2a-54 (invoice deadlines per
 * type), B-W2a-55 (the reminder ladder) and B-W2a-66 (certificate renewals) set their own, with no rule:
 *
 *   setTimerInCommand(tools, spec)                one PENDING timer for a record and key: the same date and time → kept;
 *                                                 another date → the old one CANCELLED (MOVED) and the new one set
 *   cancelTimerInCommand(tools, record, key, r)   the record's PENDING timer of that key, cancelled with the reason
 *   cancelTimersOfRecord(tools, record, r)        every PENDING timer of a record (it closed)
 *   applyTimerPlan(tools, plan, base)             a planned set of changes (the rules' sync)
 *
 * A module's timer is handled by its own worker handler on `timer.fired` (the event names the timer; the handler reads
 * its payload by id and checks its key). No timer is ever deleted (the trigger): a cancelled one keeps its reason.
 */

export interface TimerRecord {
  readonly type: string
  readonly id: string
}

export interface TimerSpec {
  readonly record: TimerRecord
  readonly recordLabel?: string | null
  readonly timerKey: string
  readonly dueAt: Date
  readonly fireAt: Date
  readonly companyId?: string | null
  readonly siteId?: string | null
  readonly partyId?: string | null
  /** The DATE rule that asks for it; none: a module's own timer. */
  readonly ruleId?: string | null
  /** What its handler needs when it fires (an object; never money). */
  readonly payload?: Record<string, Prisma.InputJsonValue | null>
}

export const TIMER_COLUMNS = {
  id: true,
  timerKey: true,
  ruleId: true,
  companyId: true,
  siteId: true,
  partyId: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  dueAt: true,
  fireAt: true,
  status: true,
  firedAt: true,
  cancelledAt: true,
  cancelReason: true,
  payload: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.DueTimerSelect
export type TimerRow = Prisma.DueTimerGetPayload<{ select: typeof TIMER_COLUMNS }>

const actorIdOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

async function cancelRow(tools: CommandTools, row: Pick<TimerRow, 'id' | 'version' | 'timerKey' | 'recordType' | 'recordId' | 'companyId' | 'siteId'>, reason: CancelReason | string): Promise<boolean> {
  const text = reason in CANCEL_REASONS ? CANCEL_REASONS[reason as CancelReason] : reason
  const { count } = await tools.tx.dueTimer.updateMany({ where: { id: row.id, status: 'PENDING', version: row.version }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: text, version: row.version + 1, updatedAt: tools.now } })
  if (count === 0) return false
  tools.audit({ action: 'timers.cancel', recordType: 'DueTimer', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { timerKey: row.timerKey, recordType: row.recordType, recordId: row.recordId, reason: text } })
  return true
}

async function insertTimer(tools: CommandTools, spec: TimerSpec): Promise<string> {
  if (!TIMER_KEY.test(spec.timerKey)) throw new RangeError(`${JSON.stringify(spec.timerKey)} is not a timer key`)
  const id = newId()
  await tools.tx.dueTimer.create({
    data: {
      id,
      timerKey: spec.timerKey,
      ruleId: spec.ruleId ?? null,
      companyId: spec.companyId ?? null,
      siteId: spec.siteId ?? null,
      partyId: spec.partyId ?? null,
      recordType: spec.record.type,
      recordId: spec.record.id,
      recordLabel: spec.recordLabel ?? null,
      dueAt: spec.dueAt,
      fireAt: spec.fireAt,
      payload: (spec.payload ?? {}) as Prisma.InputJsonValue,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  tools.audit({ action: 'timers.set', recordType: 'DueTimer', recordId: id, companyId: spec.companyId ?? null, siteId: spec.siteId ?? null, after: { timerKey: spec.timerKey, recordType: spec.record.type, recordId: spec.record.id, dueAt: toUtcIso(spec.dueAt), fireAt: toUtcIso(spec.fireAt), ruleId: spec.ruleId ?? null } })
  return id
}

/** The record's PENDING timer of a key, locked for the command. */
async function pendingOf(tx: CommandTx, record: TimerRecord, timerKey: string): Promise<TimerRow | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "DueTimer" WHERE "recordType" = ${record.type} AND "recordId" = ${record.id}::uuid AND "timerKey" = ${timerKey} AND status = 'PENDING' FOR UPDATE`
  return rows.length === 0 ? null : tx.dueTimer.findUnique({ where: { id: rows[0]!.id }, select: TIMER_COLUMNS })
}

/** Sets a record's timer (one PENDING per record and key): kept when it watches the same date and time, else moved. */
export async function setTimerInCommand(tools: CommandTools, spec: TimerSpec): Promise<{ readonly timerId: string; readonly outcome: 'SET' | 'MOVED' | 'KEPT' }> {
  const pending = await pendingOf(tools.tx, spec.record, spec.timerKey)
  if (pending && pending.dueAt.getTime() === spec.dueAt.getTime() && pending.fireAt.getTime() === spec.fireAt.getTime()) return { timerId: pending.id, outcome: 'KEPT' }
  if (pending) await cancelRow(tools, pending, 'MOVED')
  return { timerId: await insertTimer(tools, spec), outcome: pending ? 'MOVED' : 'SET' }
}

/** Cancels the record's PENDING timer of a key (the reason in words, or a CANCEL_REASONS code). False: none was pending. */
export async function cancelTimerInCommand(tools: CommandTools, record: TimerRecord, timerKey: string, reason: CancelReason | string): Promise<boolean> {
  const pending = await pendingOf(tools.tx, record, timerKey)
  return pending ? cancelRow(tools, pending, reason) : false
}

/** Cancels every PENDING timer of a record (it closed, was cancelled, was renewed). How many. */
export async function cancelTimersOfRecord(tools: CommandTools, record: TimerRecord, reason: CancelReason | string): Promise<number> {
  const rows = await tools.tx.dueTimer.findMany({ where: { recordType: record.type, recordId: record.id, status: 'PENDING' }, select: TIMER_COLUMNS })
  let cancelled = 0
  for (const row of rows) if (await cancelRow(tools, row, reason)) cancelled++
  return cancelled
}

/** Cancels every PENDING timer a rule asked for (switched off, its numbers or place changed). How many. */
export async function cancelTimersOfRule(tools: CommandTools, ruleId: string, reason: CancelReason): Promise<number> {
  const rows = await tools.tx.dueTimer.findMany({ where: { ruleId, status: 'PENDING' }, select: TIMER_COLUMNS })
  let cancelled = 0
  for (const row of rows) if (await cancelRow(tools, row, reason)) cancelled++
  return cancelled
}

/** A rule's PENDING timers and the FIRED ones still about a date it watches, as the plan reads them. */
export async function timersOfRule(client: CommandTx, ruleId: string, recordIds?: readonly string[]): Promise<{ readonly pending: PendingTimer[]; readonly fired: WantedTimer[]; readonly rows: Map<string, TimerRow> }> {
  const rows = await client.dueTimer.findMany({ where: { ruleId, status: { in: ['PENDING', 'FIRED'] }, ...(recordIds ? { recordId: { in: [...recordIds] } } : {}) }, select: TIMER_COLUMNS })
  const asTimer = (row: TimerRow) => ({ recordType: row.recordType, recordId: row.recordId, timerKey: row.timerKey, dueAt: row.dueAt, fireAt: row.fireAt })
  return {
    pending: rows.filter((row) => row.status === 'PENDING').map((row) => ({ id: row.id, ...asTimer(row) })),
    fired: rows.filter((row) => row.status === 'FIRED').map(asTimer),
    rows: new Map(rows.map((row) => [row.id, row])),
  }
}

/** Applies a plan of a rule's timers: cancels first (a moved date frees the record's key), then sets. */
export async function applyTimerPlan(tools: CommandTools, plan: TimerPlan, rows: ReadonlyMap<string, TimerRow>, specOf: (wanted: WantedTimer) => TimerSpec): Promise<{ readonly set: number; readonly cancelled: number }> {
  let cancelled = 0
  for (const entry of plan.cancel) {
    const row = rows.get(entry.id)
    if (row && (await cancelRow(tools, row, entry.reason))) cancelled++
  }
  let set = 0
  for (const wanted of plan.set) {
    // Another pass may have set it meanwhile (the kind's lock makes that rare): the one PENDING per record and key holds.
    const pending = await pendingOf(tools.tx, { type: wanted.recordType, id: wanted.recordId }, wanted.timerKey)
    if (pending && pending.dueAt.getTime() === wanted.dueAt.getTime() && pending.fireAt.getTime() === wanted.fireAt.getTime()) continue
    if (pending) await cancelRow(tools, pending, 'MOVED')
    await insertTimer(tools, specOf(wanted))
    set++
  }
  return { set, cancelled }
}

export { timerPlan }

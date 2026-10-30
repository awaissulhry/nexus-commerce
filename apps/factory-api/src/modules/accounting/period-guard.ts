import { hardLockedWords, monthOfDay } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { dayOf, liveLocksOver, peopleNames } from './store'

/**
 * A write dated inside a HARD period lock of its company, said in words BEFORE the …_money_w2a_guards'
 * factory_period_refuse_locked refuses it with check_violation 'period lock: …' (a 500 until B-W2a-F1). One call per write
 * path, inside its command, before the dated write:
 *
 *   payments.record, a deposit's payment   payments/payments.ts insertPayment: the day the money was received
 *   payments.void                          payments/payments.ts voidPayment: the day the voided payment was received
 *   invoices.issue, a deposit's TD02       invoicing/issue.ts issueInCommand: today, the issue date (a check of the issue)
 *   every office and system stock move     inventory/ledger/post-moves.ts postMoves: each move's day (Europe/Rome). The
 *                                          floor's moves are dated now and the floor reads no lock: the trigger skips
 *                                          them, and so does this check.
 *
 * It takes the company's 'factory.period-lock' key SHARED first (factory_period_lock_key, the trigger's own lock: a lock
 * being made finishes first and is then seen; none is made while the write is in flight), then reads the LOCKED rows
 * covering the day (store.ts liveLocksOver). Answers null, or the words of the first HARD lock.
 *
 * SOFT locks are not enforced here. B-W2a-39's recipe goes beside this check, in each write's command: a LOCKED SOFT row
 * covering the day → 409 unless the body carries an override reason, audited `accounting.softLockOverride`.
 */

export interface DatedWrite {
  readonly companyId: string
  readonly day: BusinessDate
  /** What is not done, in words: "the payment received on 15 Sep 2026 is not recorded". */
  readonly refused: string
  /** Where the refusal points (`body/receivedOn`, `moves/0/occurredAt`). */
  readonly path: string
}

/** A write refused by a HARD period lock: a 409 in words, at the write's path. */
export class PeriodLockedError extends ConflictError {
  override name = 'PeriodLockedError'
  override readonly issues: readonly Issue[]
  constructor(message: string, path: string) {
    super(message)
    this.issues = [{ path, message: 'Dated inside a month closed for good.' }]
  }
}

/** The Europe/Rome day of an instant (factory_money_rome_day's). */
export const lockDayOf = (at: Date): BusinessDate => businessDate(at)

/** The words of the first write a HARD lock refuses (with that write), or null. */
export async function hardLockOn(tx: CommandTx, context: RequestContext, writes: readonly DatedWrite[]): Promise<{ readonly write: DatedWrite; readonly words: string } | null> {
  if (writes.length === 0) return null
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a period lock check needs a tenant context')
  for (const companyId of [...new Set(writes.map((write) => write.companyId))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared("factory_period_lock_key"(${context.tenantId}::uuid, ${companyId}::uuid))`
  }
  const read = new Set<string>()
  for (const write of writes) {
    // One read per company and day (a batch of moves dated alike reads once).
    if (read.has(`${write.companyId}|${write.day}`)) continue
    read.add(`${write.companyId}|${write.day}`)
    const locks = await liveLocksOver(tx, write.companyId, { month: monthOfDay(write.day), start: write.day, end: write.day })
    const lock = locks.find((row) => row.level === 'HARD')
    if (!lock) continue
    const company = await tx.company.findUnique({ where: { id: write.companyId }, select: { legalName: true } })
    const names = await peopleNames(tx, [lock.lockedById])
    const words = hardLockedWords(
      { start: dayOf(lock.periodStart), end: dayOf(lock.periodEnd), company: company?.legalName ?? 'its company', lockedOn: lockDayOf(lock.lockedAt), lockedBy: names.get(lock.lockedById) ?? null },
      write.refused,
    )
    return { write, words }
  }
  return null
}

/** Throws the 409 of the first write a HARD lock refuses (PeriodLockedError). */
export async function refuseHardLocked(tx: CommandTx, context: RequestContext, writes: readonly DatedWrite[]): Promise<void> {
  const found = await hardLockOn(tx, context, writes)
  if (found) throw new PeriodLockedError(found.words, found.write.path)
}

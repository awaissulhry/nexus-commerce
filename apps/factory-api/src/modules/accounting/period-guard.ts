import { hardLockedWords, monthOfDay, PERIOD_LOCK_ISSUES, PERIOD_LOCK_OVERRIDE_REASON, softLockedWords, type HardLockFacts } from '@nexus/factory-domain/accounting/periods'
import type { PeriodLockLine, PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandTools, CommandTx } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { dayOf, liveLocksOver, peopleNames, type LockRow, type Reader } from './store'

/**
 * The month locks on every write that dates money or stock into a month (B-W2a-F1: HARD; B-W2a-F8: SOFT). One call per
 * write path, inside its command, before the dated write — `honourPeriodLocks(tools, writes, body.periodLockOverride)`:
 *
 *   - a HARD lock covering a day: 409 in words (PeriodLockedError, at the write's path) BEFORE the …_money_w2a_guards'
 *     factory_period_refuse_locked refuses it with check_violation 'period lock: …' (core/errors.ts maps that one to a
 *     409 too, as the last line of defence: issue `period/HARD_LOCKED`);
 *   - a SOFT lock covering a day: 409 in words (SoftLockedError, issue `period/SOFT_LOCKED`) unless the body carries
 *     `periodLockOverride: { reason }` (3–500 characters): then the command goes on and writes ONE audit row
 *     `accounting.softLockOverride` per lock on the PeriodLock (the period, the reason, the records and days written).
 *     A system write (no person, no body) has no reason: it is refused and waits, as costing's posts wait (B-W2a-21).
 *
 *   payments.record, a deposit's payment   payments/payments.ts insertPayment: the day the money was received
 *   payments.void                          payments/payments.ts voidPayment: the day the voided payment was received
 *   invoices.issue, a deposit's TD02       invoicing/issue.ts issueInCommand: today, the issue date (HARD: a problem of
 *                                          the issue, `hardLockOn`; SOFT: after the problems)
 *   payments.refund / payRefund / void     payments/refunds.ts refuseLockedRefund: the refund's bank date
 *   payables register / change / pay       payables/invoices.ts, payables/approval.ts: receivedOn (old and new), paidOn
 *   payables.sdiReceive (system)           payables/sdi.ts: the day SDI delivered it (a refusal waits for the next pickup)
 *   every office and system stock move     inventory/ledger/post-moves.ts postMoves (options.periodLockOverride): each
 *                                          move's day (Europe/Rome). The floor's moves are dated now and the floor reads
 *                                          no lock: the trigger skips them, and so does this check.
 *   costing posts                          not here: costing/actual/post.ts dates an event of a locked month (SOFT or
 *                                          HARD) now, and waits while today is locked too (B-W2a-21).
 *
 * It takes the company's 'factory.period-lock' key SHARED first (factory_period_lock_key, the trigger's own lock: a lock
 * being made finishes first and is then seen; none is made while the write is in flight), then reads the LOCKED rows
 * covering each day (store.ts liveLocksOver).
 */

export interface DatedWrite {
  readonly companyId: string
  readonly day: BusinessDate
  /** What is not done, in words: "the payment received on 15 Sep 2026 is not recorded". */
  readonly refused: string
  /** Where the refusal points (`body/receivedOn`, `moves/0/occurredAt`). */
  readonly path: string
  /** The record the write makes or changes, named on a soft lock's override audit row. */
  readonly record?: { readonly type: string; readonly id: string } | undefined
}

/** The audit action of a write that went into a SOFT-locked month with its reason. */
export const SOFT_LOCK_OVERRIDE = 'accounting.softLockOverride'

/** A write refused by a HARD period lock: a 409 in words, at the write's path. */
export class PeriodLockedError extends ConflictError {
  override name = 'PeriodLockedError'
  override readonly issues: readonly Issue[]
  constructor(message: string, path: string) {
    super(message)
    this.issues = [{ path, message: 'Dated inside a month closed for good.' }]
  }
}

/** A write into a SOFT-locked month sent without an override reason: a 409 in words, `period/SOFT_LOCKED` and the write's path. */
export class SoftLockedError extends ConflictError {
  override name = 'SoftLockedError'
  override readonly issues: readonly Issue[]
  constructor(message: string, path: string) {
    super(message)
    this.issues = [
      { path: PERIOD_LOCK_ISSUES.soft, message: 'Inside a soft-locked month: send it again with an override reason (periodLockOverride.reason), or have the soft lock lifted.' },
      { path, message: 'Dated inside a soft-locked month.' },
    ]
  }
}

/** The Europe/Rome day of an instant (factory_money_rome_day's). */
export const lockDayOf = (at: Date): BusinessDate => businessDate(at)

interface LocksFound {
  /** The first HARD lock met, with the write it refuses. */
  readonly hard: { readonly lock: LockRow; readonly write: DatedWrite } | null
  /** The SOFT locks met, each with the writes dated inside it (in the writes' order). */
  readonly soft: readonly { readonly lock: LockRow; readonly writes: DatedWrite[] }[]
}

async function locksOn(tx: CommandTx, context: RequestContext, writes: readonly DatedWrite[]): Promise<LocksFound> {
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a period lock check needs a tenant context')
  for (const companyId of [...new Set(writes.map((write) => write.companyId))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared("factory_period_lock_key"(${context.tenantId}::uuid, ${companyId}::uuid))`
  }
  const read = new Map<string, LockRow[]>()
  const soft = new Map<string, { lock: LockRow; writes: DatedWrite[] }>()
  for (const write of writes) {
    // One read per company and day (a batch of moves dated alike reads once).
    const at = `${write.companyId}|${write.day}`
    if (!read.has(at)) read.set(at, await liveLocksOver(tx, write.companyId, { month: monthOfDay(write.day), start: write.day, end: write.day }))
    const locks = read.get(at)!
    const hard = locks.find((row) => row.level === 'HARD')
    if (hard) return { hard: { lock: hard, write }, soft: [] }
    for (const lock of locks) {
      const entry = soft.get(lock.id) ?? { lock, writes: [] }
      entry.writes.push(write)
      soft.set(lock.id, entry)
    }
  }
  return { hard: null, soft: [...soft.values()] }
}

/** A lock as its refusal names it: the company, the day it was locked, by whom. */
async function factsOf(tx: Reader, lock: LockRow): Promise<HardLockFacts> {
  const company = await tx.company.findUnique({ where: { id: lock.companyId }, select: { legalName: true } })
  const names = await peopleNames(tx, [lock.lockedById])
  return { start: dayOf(lock.periodStart), end: dayOf(lock.periodEnd), company: company?.legalName ?? 'its company', lockedOn: lockDayOf(lock.lockedAt), lockedBy: names.get(lock.lockedById) ?? null }
}

/** The words of the first write a HARD lock refuses (with that write), or null. SOFT locks are not read here. */
export async function hardLockOn(tx: CommandTx, context: RequestContext, writes: readonly DatedWrite[]): Promise<{ readonly write: DatedWrite; readonly words: string } | null> {
  if (writes.length === 0) return null
  const found = await locksOn(tx, context, writes)
  if (!found.hard) return null
  return { write: found.hard.write, words: hardLockedWords(await factsOf(tx, found.hard.lock), found.hard.write.refused) }
}

/**
 * The month locks over these writes, honoured inside their command: HARD → PeriodLockedError; SOFT → SoftLockedError
 * unless `override` carries a reason, then one `accounting.softLockOverride` audit row per SOFT lock and the command goes on.
 */
export async function honourPeriodLocks(tools: CommandTools, writes: readonly DatedWrite[], override?: PeriodLockOverride | null): Promise<void> {
  if (writes.length === 0) return
  const found = await locksOn(tools.tx, tools.context, writes)
  if (found.hard) throw new PeriodLockedError(hardLockedWords(await factsOf(tools.tx, found.hard.lock), found.hard.write.refused), found.hard.write.path)
  if (found.soft.length === 0) return
  const reason = override?.reason.trim() ?? ''
  if (reason.length < PERIOD_LOCK_OVERRIDE_REASON.min || reason.length > PERIOD_LOCK_OVERRIDE_REASON.max) {
    const first = found.soft[0]!
    throw new SoftLockedError(softLockedWords(await factsOf(tools.tx, first.lock), first.writes[0]!.refused), first.writes[0]!.path)
  }
  for (const { lock, writes: inside } of found.soft) {
    tools.audit({
      action: SOFT_LOCK_OVERRIDE,
      recordType: 'PeriodLock',
      recordId: lock.id,
      companyId: lock.companyId,
      reason,
      after: { periodStart: dayOf(lock.periodStart), periodEnd: dayOf(lock.periodEnd), level: 'SOFT', writes: inside.map((write) => ({ day: write.day, path: write.path, record: write.record ?? null })) },
    })
  }
}

/**
 * B-W2b-22 (Z9:01): the month lock over one write, read WITHOUT a command — the preview a screen shows before it sends the
 * write (the invoice's issue checks), by the same rule as honourPeriodLocks: a HARD lock first (nothing goes in), else a
 * SOFT one (the write needs `periodLockOverride.reason`), with the words the write's refusal would say. null: none. A
 * preview only: the write's own command checks again under the lock.
 */
export async function periodLockPreview(db: Reader, write: Pick<DatedWrite, 'companyId' | 'day' | 'refused'>): Promise<PeriodLockLine | null> {
  const locks = await liveLocksOver(db, write.companyId, { month: monthOfDay(write.day), start: write.day, end: write.day })
  const lock = locks.find((row) => row.level === 'HARD') ?? locks[0]
  if (!lock) return null
  const facts = await factsOf(db, lock)
  const hard = lock.level === 'HARD'
  return {
    level: hard ? 'HARD' : 'SOFT',
    lockId: lock.id,
    periodStart: dayOf(lock.periodStart),
    periodEnd: dayOf(lock.periodEnd),
    needsReason: !hard,
    words: hard ? hardLockedWords(facts, write.refused) : softLockedWords(facts, write.refused),
  }
}

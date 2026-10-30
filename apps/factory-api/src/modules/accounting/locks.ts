import type { Prisma } from '@nexus/factory-db'
import type { LiftBody, LockBody, LocksQuery, LockView } from '@nexus/factory-domain/accounting/contracts'
import { ACCOUNTING_LOCK, ACCOUNTING_UNLOCK, ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/permissions'
import { isYearEndPeriod, lockPhrases, monthLabel, periodOfMonth, phraseMatches, type Period } from '@nexus/factory-domain/accounting/periods'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { AccountingRefusedError, periodOfRow, periodView, refuse } from './exports'
import { unvaluedMovesIn } from './facts'
import { accountingCommand, companyFor, dateOf, latestExported, LOCK_SELECT, lockOfPeriod, officeOf, peopleNames, periodExports, type LockRow, type Reader } from './store'

/**
 * Period locks (B-W2a-39; design finance.accounting "5 · Export and lock": "soft (finance may override with a reason) or
 * hard (typed phrase)"; Owner answer P1: a typed phrase only for the final month close). One lock row per company and
 * month (PeriodLock): locked SOFT or HARD, a soft lock made hard, lifted with a reason, locked again.
 *
 *   SOFT  the API's: shown on the month; writes into it stay possible with a reason (the write paths that honour it are
 *         named in the step's notes: the costing ledger posts a soft-locked month's events dated now, B-W2a-21).
 *   HARD  the database's: every write dated inside it is refused, for every login (the …_money_w2a_guards: an invoice
 *         issued, a payment received or voided, a refund paid or voided, a supplier invoice registered, a cost entry, an
 *         office or system stock move). Locking it needs the typed phrase and refuses while the month holds what can no
 *         longer be set right once closed: an invoice SDI rejected (its correction is a legal duty), a stock move without
 *         its value, a year-end inventory still open. A SOFT lock names the same as warnings.
 *
 * Lifting: a soft lock with accounting.lock and a reason; a hard lock with accounting.unlock (step-up, checked by the
 * route) and a reason. Whether a hard lock may ever be lifted is the accountant's question (GATE-ACCOUNTANT): the
 * database allows it with a reason, and so does the API, to the owner's role only by default.
 */

const lockWords = (row: Pick<LockRow, 'level' | 'status'>): string =>
  row.status === 'UNLOCKED'
    ? 'Lifted: writes dated in the month are open again.'
    : row.level === 'HARD'
      ? 'Closed for good: nothing dated in the month can change (the database refuses it).'
      : 'Soft-locked: finance may still write into the month with a reason.'

export async function lockViews(db: Reader, rows: readonly LockRow[]): Promise<LockView[]> {
  const names = await peopleNames(db, rows.flatMap((row) => [row.lockedById, row.unlockedById]))
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    period: periodView(periodOfRow(row)),
    level: row.level,
    status: row.status,
    lockedAt: toUtcIso(row.lockedAt),
    lockedBy: { id: row.lockedById, name: names.get(row.lockedById) ?? null },
    note: row.note,
    export: row.export ? { id: row.export.id, number: row.export.number, status: row.export.status } : null,
    unlockedAt: row.unlockedAt ? toUtcIso(row.unlockedAt) : null,
    unlockedBy: row.unlockedById ? { id: row.unlockedById, name: names.get(row.unlockedById) ?? null } : null,
    unlockReason: row.unlockReason,
    version: row.version,
    words: lockWords(row),
  }))
}

/** GET /accounting/locks: the period locks of the companies the caller may see, newest month first. */
export async function listLocks(caller: CommandCaller, query: LocksQuery) {
  const context = officeOf(caller)
  const where: Prisma.PeriodLockWhereInput = {
    AND: [scopeWhere(actorOf(context), ACCOUNTING_VIEW, { company: 'companyId' }) as Prisma.PeriodLockWhereInput, query.companyId ? { companyId: query.companyId } : {}, query.status ? { status: query.status } : {}],
  }
  return caller.withClient(async (db) => ({ locks: await lockViews(db, await db.periodLock.findMany({ where, select: LOCK_SELECT, orderBy: [{ periodStart: 'desc' }, { id: 'asc' }], take: 500 })) }))
}

/** What a hard lock waits for in the month (a soft lock shows them as warnings). */
async function closeProblems(db: Reader, companyId: string, period: Period, fiscalYearStartMonth: number): Promise<{ code: string; message: string }[]> {
  const problems: { code: string; message: string }[] = []
  const rejected = await db.invoice.findMany({ where: { companyId, status: 'REJECTED', issueDate: { gte: dateOf(period.start), lte: dateOf(period.end) } }, select: { number: true }, take: 20 })
  if (rejected.length > 0) {
    problems.push({ code: 'INVOICE_REJECTED', message: `${rejected.length} invoice(s) of the month are rejected by SDI (${rejected.map((row) => row.number).join(', ')}): send them again, corrected, before closing it.` })
  }
  const unvalued = await unvaluedMovesIn(db, companyId, period)
  if (unvalued > 0) problems.push({ code: 'STOCK_NOT_VALUED', message: `${unvalued} stock move(s) of the month have no value yet: they are valued first.` })
  const openCounts = await db.stockCount.findMany({
    where: { companyId, kind: 'YEAR_END', inventoryDate: { gte: dateOf(period.start), lte: dateOf(period.end) }, status: { in: ['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED'] } },
    select: { number: true },
  })
  if (openCounts.length > 0) problems.push({ code: 'YEAR_END_COUNT_OPEN', message: `The year-end inventory ${openCounts.map((row) => row.number).join(', ')} is still open: its differences are applied before the year is locked.` })
  if (isYearEndPeriod(period, fiscalYearStartMonth) && openCounts.length === 0) {
    const signed = await db.stockCount.count({ where: { companyId, kind: 'YEAR_END', inventoryDate: dateOf(period.end), status: { in: ['APPLIED', 'SIGNED_OFF'] } } })
    if (signed === 0) problems.push({ code: 'YEAR_END_COUNT_MISSING', message: `No year-end inventory of ${period.end} is applied: the year's physical inventory (c.c. art. 2217) comes first.` })
  }
  return problems
}

/** POST /accounting/locks: a month locked SOFT or HARD (a soft lock made hard; a lifted lock locked again). */
export async function lockMonth(caller: CommandCaller, body: LockBody, idempotencyKey?: string): Promise<{ lock: LockView; warnings: { code: string; message: string }[] }> {
  const context = officeOf(caller)
  const company = await companyFor(caller, body.companyId, ACCOUNTING_LOCK)
  const period = periodOfMonth(body.month)
  const label = monthLabel(period.month)
  if (body.level === 'HARD' && !phraseMatches(period.month, body.phrase)) {
    const phrases = lockPhrases(period.month)
    throw new ValidationError(`Closing ${label} for good needs its phrase typed.`, [{ path: 'body/phrase', message: `Type "${phrases.en}" (or "${phrases.it}").` }])
  }
  const { existing, problems, exportId } = await caller.withClient(async (db) => {
    const found = await lockOfPeriod(db, company.id, period)
    const latest = latestExported(await periodExports(db, company.id, period))
    return { existing: found, problems: await closeProblems(db, company.id, period, company.fiscalYearStartMonth), exportId: latest?.id ?? null }
  })
  if (existing) {
    if (body.version === undefined || existing.version !== body.version) throw new StaleVersionError('PeriodLock', existing.id, existing.version, body.version ?? 0)
    if (existing.status === 'LOCKED' && existing.level === body.level) throw refuse(`${label} is locked already.`, 'ALREADY_LOCKED', lockWords(existing))
    if (existing.status === 'LOCKED' && existing.level === 'HARD') throw refuse(`${label} is closed for good.`, 'HARD_LOCKED', 'A hard lock is lifted first (accounting.unlock, with a reason), never made soft.')
  }
  if (body.level === 'HARD' && problems.length > 0) throw new AccountingRefusedError(`${label} cannot be closed for good yet.`, problems)
  const warnings = body.level === 'SOFT' ? problems : []
  const lockId = existing?.id ?? newId()
  await accountingCommand(
    caller,
    { name: 'accounting.lock', idempotencyKey, input: { ...body, phrase: body.phrase ? 'typed' : null }, ...(existing ? { record: { type: 'PeriodLock' as const, id: existing.id, expectedVersion: existing.version } } : {}) },
    async (tools) => {
      const overlapping = await tools.tx.periodLock.findFirst({
        where: { companyId: company.id, status: 'LOCKED', id: { not: lockId }, periodStart: { lte: dateOf(period.end) }, periodEnd: { gte: dateOf(period.start) } },
        select: { periodStart: true, periodEnd: true },
      })
      if (overlapping) throw refuse(`${label} is inside another lock.`, 'OVERLAPS', `The lock of ${overlapping.periodStart.toISOString().slice(0, 10)} to ${overlapping.periodEnd.toISOString().slice(0, 10)} covers it already.`)
      const data = { level: body.level, exportId, lockedAt: tools.now, lockedById: context.actorId, note: body.note ?? null, updatedAt: tools.now }
      if (!existing) {
        await tools.tx.periodLock.create({ data: { id: lockId, companyId: company.id, periodStart: dateOf(period.start), periodEnd: dateOf(period.end), status: 'LOCKED', ...data, createdAt: tools.now, createdById: context.actorId }, select: { id: true } })
      } else if (existing.status === 'UNLOCKED') {
        await tools.tx.periodLock.update({ where: { id: lockId }, data: { status: 'LOCKED', ...data, unlockedAt: null, unlockedById: null, unlockReason: null }, select: { id: true } })
      } else {
        // A soft lock made hard: the level, the export and the note change while LOCKED (the lock's time is the hard lock's).
        await tools.tx.periodLock.update({ where: { id: lockId }, data, select: { id: true } })
      }
      tools.audit({
        recordType: 'PeriodLock',
        recordId: lockId,
        companyId: company.id,
        before: existing ? { status: existing.status, level: existing.level } : null,
        after: { status: 'LOCKED', level: body.level, periodStart: period.start, periodEnd: period.end, exportId, warnings: warnings.map((warning) => warning.code) },
        ...(body.note ? { reason: body.note } : {}),
      })
      tools.emit({ type: 'period_lock.locked', subject: lockId, companyId: company.id, payload: { lockId, periodStart: period.start, periodEnd: period.end, level: body.level, exportId } })
      return { lockId }
    },
  )
  const lock = await caller.withClient(async (db) => (await lockViews(db, [await db.periodLock.findUniqueOrThrow({ where: { id: lockId }, select: LOCK_SELECT })]))[0]!)
  return { lock, warnings }
}

/** A lock the caller may see, or not found. */
export async function visibleLock(caller: CommandCaller, lockId: string): Promise<LockRow> {
  const context = officeOf(caller)
  if (!isUuid(lockId)) throw new NotFoundError('Period lock not found.')
  const row = await caller.withClient((db) => db.periodLock.findUnique({ where: { id: lockId }, select: LOCK_SELECT }))
  if (!row || !can(actorOf(context), ACCOUNTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Period lock not found.')
  return row
}

/**
 * POST /accounting/locks/:id/lift: a lock lifted with a reason. A HARD one needs accounting.unlock and a fresh step-up
 * (`stepUp`, the route's check, run only for a hard lock).
 */
export async function liftLock(caller: CommandCaller, lockId: string, body: LiftBody, stepUp: () => void, idempotencyKey?: string): Promise<LockView> {
  const context = officeOf(caller)
  const row = await visibleLock(caller, lockId)
  const actor = actorOf(context)
  if (!can(actor, ACCOUNTING_LOCK, { companyId: row.companyId })) throw new ForbiddenError()
  if (row.status !== 'LOCKED') throw refuse('This lock is lifted already.', 'NOT_LOCKED', lockWords(row))
  if (row.level === 'HARD') {
    if (!can(actor, ACCOUNTING_UNLOCK, { companyId: row.companyId })) throw new ForbiddenError('Lifting a hard lock needs accounting.unlock: the accountant has the month.')
    stepUp()
  }
  if (row.version !== body.version) throw new StaleVersionError('PeriodLock', lockId, row.version, body.version)
  const period = periodOfRow(row)
  await accountingCommand(caller, { name: 'accounting.unlock', idempotencyKey, input: { lockId, ...body }, record: { type: 'PeriodLock', id: lockId, expectedVersion: body.version } }, async (tools) => {
    const locked = await tools.tx.periodLock.findUniqueOrThrow({ where: { id: lockId }, select: { status: true, level: true } })
    if (locked.status !== 'LOCKED' || locked.level !== row.level) throw refuse('This lock changed meanwhile.', 'CHANGED', 'Read it again.')
    // The lift takes the period's key exclusively (the guard): writes in flight finish first.
    await tools.tx.periodLock.update({ where: { id: lockId }, data: { status: 'UNLOCKED', unlockedAt: tools.now, unlockedById: context.actorId, unlockReason: body.reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'PeriodLock', recordId: lockId, companyId: row.companyId, before: { status: 'LOCKED', level: row.level }, after: { status: 'UNLOCKED' }, reason: body.reason })
    tools.emit({ type: 'period_lock.lifted', subject: lockId, companyId: row.companyId, payload: { lockId, periodStart: period.start, periodEnd: period.end, level: row.level } })
    return { lockId }
  })
  return caller.withClient(async (db) => (await lockViews(db, [await db.periodLock.findUniqueOrThrow({ where: { id: lockId }, select: LOCK_SELECT })]))[0]!)
}


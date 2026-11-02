import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { PEOPLE_ATTENDANCE_CORRECT } from '@nexus/factory-domain/people/close/permissions'
import { cellOf, correctionProblems, CORRECT_WORDS, differingCells, type CorrectionKind, type DayCells } from '@nexus/factory-domain/people/close/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { dayOf, may, officeOf, problemsError, refuse } from '../employees/access'
import { userNames } from '../employees/employees'
import { ownEmployeeId, refuseOwnDay, requireAttendance } from '../attendance/access'
import { fullName, personOf, type Client } from '../attendance/store'
import { assertPersonDecides } from '../privacy/decide'
import type { CorrectBody, MonthCorrectionsQuery } from './contract'
import { codesById, companyFor, monthDays, monthOfClose, type DayFigures } from './store'

/**
 * Correcting a closed day (B-W2b-48; MES-231; design people.attendance "Correct a closed day": "Correction entry with reason;
 * 'Payroll correction pending' appears on Payroll export"), office only, behind the ATTENDANCE gate of the day's site.
 *
 *   GET  /people/attendance/days/:dayId/corrections   one person's day: the closed figures, what stands now, each correction
 *   POST /people/attendance/days/:dayId/corrections   a new entry (from → to) with its reason, never on one's own day
 *   GET  /people/month-close/:closeId/corrections     a month's corrections: when and what kind, never who or how much
 *
 * A closed day never changes: AttendanceCorrection is append-only and the database's chain holds (the figure before is the
 * closed value, or the latest correction's), so the first thing the command does is take that chain's own lock. The
 * person sends the figure they read: another correction meanwhile is a 409, not a silent overwrite.
 */

const HEAD = { id: true, companyId: true, siteId: true, employeeId: true, date: true, status: true, monthCloseId: true } as const

async function headOf(db: Client, context: OfficeContext, dayId: string) {
  const head = isUuid(dayId) ? await db.attendanceDay.findUnique({ where: { id: dayId }, select: HEAD }) : null
  if (!head || !may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: head.companyId, siteId: head.siteId })) throw new NotFoundError('Day not found.')
  return head
}

const minutesOf = (cells: DayCells) => ({ presentMinutes: cells.present, ordinaryMinutes: cells.ordinary, nightMinutes: cells.night, holidayMinutes: cells.holiday, overtimeDayMinutes: cells.overtimeDay, overtimeNightMinutes: cells.overtimeNight, overtimeHolidayMinutes: cells.overtimeHoliday })

async function dayRecord(db: Client, context: OfficeContext, dayId: string) {
  const head = await headOf(db, context, dayId)
  await requireAttendance(db, head.siteId)
  const person = await personOf(db, head.employeeId)
  if (!person) throw new NotFoundError('Day not found.')
  const date = dayOf(head.date)
  const figures = (await monthDays(db, { employeeId: head.employeeId, from: date, to: date })).find((day) => day.id === head.id)
  if (!figures) throw new NotFoundError('Day not found.')
  const rows = await db.attendanceCorrection.findMany({ where: { dayId: head.id }, select: { id: true, kind: true, absenceCodeId: true, minutesBefore: true, minutesAfter: true, reason: true, createdAt: true, createdById: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const codes = await codesById(db, [...figures.cells.absences.keys(), ...figures.effective.absences.keys(), ...rows.flatMap((row) => (row.absenceCodeId ? [row.absenceCodeId] : []))])
  const names = await userNames(db, rows.map((row) => row.createdById))
  const absences = (cells: DayCells) => [...cells.absences].map(([codeId, minutes]) => ({ codeId, code: codes.get(codeId)?.code ?? '?', minutes }))
  const own = (await ownEmployeeId(db, context)) === person.id
  const closed = head.status === 'CLOSED'
  return {
    dayId: head.id,
    date,
    siteId: head.siteId,
    status: head.status,
    closeId: head.monthCloseId,
    person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, employeeCode: person.employeeCode },
    closedFigures: { ...minutesOf(figures.cells), absences: absences(figures.cells) },
    figuresNow: { ...minutesOf(figures.effective), absences: absences(figures.effective) },
    differs: differingCells(figures.cells, figures.corrections).length > 0,
    corrections: rows.map((row) => ({ id: row.id, kind: row.kind as CorrectionKind, absenceCode: row.absenceCodeId ? (codes.get(row.absenceCodeId)?.code ?? '?') : null, minutesBefore: row.minutesBefore, minutesAfter: row.minutesAfter, reason: row.reason, at: toUtcIso(row.createdAt), by: row.createdById ? (names.get(row.createdById) ?? null) : null })),
    actions: { correct: closed && !own && may(context, PEOPLE_ATTENDANCE_CORRECT, { companyId: head.companyId, siteId: head.siteId }) },
    words: closed ? [CORRECT_WORDS] : ['This day is not closed: it is fixed, not corrected.'],
  }
}

/** GET /people/attendance/days/:dayId/corrections. */
export async function dayCorrections(caller: CommandCaller, dayId: string) {
  const context = officeOf(caller)
  return caller.withClient((db) => dayRecord(db, context, dayId))
}

/** The figure of a cell as it stands now, in the command. */
function figureNow(day: DayFigures, kind: CorrectionKind, absenceCodeId: string | null): number {
  return cellOf(day.effective, kind, absenceCodeId)
}

/** POST /people/attendance/days/:dayId/corrections. */
export async function correctDay(caller: CommandCaller, dayId: string, body: CorrectBody, key?: string) {
  const context = officeOf(caller)
  const absenceCodeId = body.absenceCodeId ?? null
  const problems = correctionProblems({ kind: body.kind, absenceCodeId, minutesAfter: body.minutesAfter, reason: body.reason })
  if (problems.length > 0) throw problemsError(problems, 'Check the correction.')
  const head = await caller.withClient(async (db) => {
    const found = await headOf(db, context, dayId)
    if (!may(context, PEOPLE_ATTENDANCE_CORRECT, { companyId: found.companyId, siteId: found.siteId })) throw new DomainError('forbidden', 'Correcting a closed day needs people.attendance.correct.')
    await requireAttendance(db, found.siteId)
    return found
  })
  const reason = body.reason.trim()
  await command(caller, { name: 'people.correctClosedDay', idempotencyKey: key, input: { dayId, ...body } }, async (tools) => {
    const { tx } = tools
    assertPersonDecides(tools.context, 'ATTENDANCE_CORRECTION')
    await tx.$executeRaw`SELECT "factory_time_lock"('factory.time.correction', ${context.tenantId}::uuid, ${head.id}::uuid)`
    await requireAttendance(tx, head.siteId)
    await refuseOwnDay(tx, context, head.employeeId)
    const row = await tx.attendanceDay.findUnique({ where: { id: head.id }, select: HEAD })
    if (!row) throw new NotFoundError('Day not found.')
    if (row.status !== 'CLOSED' || !row.monthCloseId) refuse('NOT_CLOSED', 'This day is not closed: fix it, a correction is for a closed month.')
    if (absenceCodeId !== null) {
      const code = await tx.absenceCode.findFirst({ where: { id: absenceCodeId, OR: [{ companyId: null }, { companyId: row!.companyId }] }, select: { id: true } })
      if (!code) refuse('NO_SUCH_CODE', 'This absence code is not one of this company.', 'absenceCodeId')
    }
    const date = dayOf(row!.date)
    const figures = (await monthDays(tx, { employeeId: row!.employeeId, from: date, to: date })).find((day) => day.id === row!.id)
    if (!figures) throw new NotFoundError('Day not found.')
    const now = figureNow(figures, body.kind, absenceCodeId)
    if (now !== body.minutesBefore) refuse('CHANGED', `Someone corrected this figure first: it is now ${now} minutes, not ${body.minutesBefore}. Read it again.`, 'minutesBefore')
    if (now === body.minutesAfter) refuse('NO_CHANGE', 'The figure already says this: there is nothing to correct.', 'minutesAfter')
    const id = newId()
    await tx.attendanceCorrection.create({ data: { id, companyId: row!.companyId, employeeId: row!.employeeId, dayId: row!.id, monthCloseId: row!.monthCloseId!, kind: body.kind, absenceCodeId, minutesBefore: now, minutesAfter: body.minutesAfter, reason, createdById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: 'AttendanceCorrection', recordId: id, companyId: row!.companyId, siteId: row!.siteId, before: { minutes: now }, after: { dayId: row!.id, employeeId: row!.employeeId, date, kind: body.kind, absenceCodeId, minutes: body.minutesAfter }, reason })
    tools.emit({ type: 'attendance.day_corrected', subject: row!.employeeId, companyId: row!.companyId, siteId: row!.siteId, payload: { correctionId: id, closeId: row!.monthCloseId!, dayId: row!.id, siteId: row!.siteId, employeeId: row!.employeeId, kind: body.kind } })
    return { id }
  })
  return caller.withClient((db) => dayRecord(db, context, dayId))
}

/** GET /people/month-close/:closeId/corrections: what changed after the close; one row opens the day's record. */
export async function monthCorrections(caller: CommandCaller, closeId: string, query: MonthCorrectionsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const close = isUuid(closeId) ? await db.attendanceMonthClose.findUnique({ where: { id: closeId }, select: { id: true, companyId: true, month: true } }) : null
    if (!close) throw new NotFoundError('Month close not found.')
    await companyFor(db, context, close.companyId, [PEOPLE_ATTENDANCE_VIEW])
    const limit = query.limit ?? 100
    const after = query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}
    const rows = await db.attendanceCorrection.findMany({ where: { monthCloseId: close.id, ...after }, select: { id: true, dayId: true, kind: true, createdAt: true, day: { select: { date: true, siteId: true } } }, orderBy: [{ id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    for (const siteId of new Set(page.map((row) => row.day.siteId))) await requireAttendance(db, siteId)
    return {
      closeId: close.id,
      month: monthOfClose(close),
      corrections: page.map((row) => ({ id: row.id, dayId: row.dayId, date: dayOf(row.day.date), siteId: row.day.siteId, kind: row.kind as CorrectionKind, at: toUtcIso(row.createdAt) })),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      words: ["Corrections show when and what kind: one person's day opens one record at a time (Statuto dei Lavoratori art. 4)."],
    }
  })
}

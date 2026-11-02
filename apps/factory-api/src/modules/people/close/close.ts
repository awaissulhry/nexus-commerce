import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { monthLabel } from '@nexus/factory-domain/accounting/periods'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { lulCalendar, lulCsv, LUL_TO_CONFIRM, type LulDay, type LulFacts, type LulPerson } from '@nexus/factory-domain/people/close/lul'
import { PEOPLE_ATTENDANCE_CLOSE, PEOPLE_ATTENDANCE_LUL } from '@nexus/factory-domain/people/close/permissions'
import {
  CLOSE_CONSEQUENCES,
  closeChecklist,
  closeHolds,
  closeNotes,
  closePhraseMatches,
  closePhrases,
  holdWords,
  LUL_RETENTION_YEARS,
  lulDaysLeft,
  lulDueBy,
  monthOver,
  type MonthFacts,
} from '@nexus/factory-domain/people/close/rules'
import { COMMAND_SETTINGS, command, runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { serverClock } from '../../../core/time'
import { downloadFile, putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { dateOf, officeOf, refuse } from '../employees/access'
import { userNames } from '../employees/employees'
import { fullName, type Client } from '../attendance/store'
import { assertPersonDecides } from '../privacy/decide'
import { gateClosedError } from '../privacy/gate'
import type { CloseBody, MonthQuery, MonthsQuery, OpenLulBody } from './contract'
import { renderLulPdf } from './lul-pdf'
import { closeOfMonth, CLOSE_SELECT, codesById, companyFor, earliestToday, gatesOf, lineDaysLeft, monthDays, monthFactsOf, monthOfClose, periodOfMonth, placeOf, reachesCompany, type CloseRow, type Gates, type Place } from './store'

/**
 * The month close (B-W2b-48; MES-231; D.L. 112/2008 art. 39; design people.attendance "Month close", typed confirm "Close
 * October 2026", new tab "LUL calendar (PDF)"), office only, per company, behind the ATTENDANCE gate of its sites.
 *
 *   GET  /people/month-close                     the panel: the checklist, the deadline, what holds it, the seal
 *   GET  /people/month-close/months              the company's months: open or closed (the period chip, the Attendance tab)
 *   POST /people/month-close                     closes the month with its typed phrase, then seals the LUL calendar
 *   POST /people/month-close/:closeId/seal       seals a closed month's calendar when the store was down at the close
 *   POST /people/month-close/:closeId/lul/open   opens the calendar (PDF or CSV): recorded, a link that lives 60 seconds
 *
 * A close is ONE command under the month's key taken EXCLUSIVELY (the database's own: every write dated in the month takes it
 * shared, so what is in flight finishes first and what comes later sees the month closed). Its counts are read again inside
 * it. A close and its counts are the whole company's: the caller reaches every site of it. Then the calendar: made from the
 * closed figures, which never change, so it can be made after the command: store first, then a second command names it
 * on the close. A store that is down leaves a closed month without a seal, never an open one: `seal` makes it again.
 */

const VIEW = [PEOPLE_ATTENDANCE_VIEW] as const
/** A month's close locks thousands of rows with their triggers: more time than the default command. */
const CLOSE_TIMEOUT_MS = 120_000

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** Some site of the company has the gate open (else 409 gate/ATTENDANCE, before anything of a person is read). */
function requireSomeGate(gates: Gates): void {
  if (gates.open.length === 0) throw gateClosedError('ATTENDANCE')
}

async function panelOf(db: Client, context: OfficeContext, place: Place, month: string, now: Date) {
  const period = periodOfMonth(month, 'querystring/month')
  const gates = await gatesOf(db, place)
  requireSomeGate(gates)
  const close = await closeOfMonth(db, place.company.id, month)
  const closed = close?.status === 'CLOSED'
  const lineDaysOpen = closed ? 0 : await lineDaysLeft(db, place, period)
  const facts = await monthFactsOf(db, place, month, { gates, closed, lineDaysOpen, now })
  const holds = closeHolds(facts)
  const names = await userNames(db, [close?.closedById ?? null])
  const today = earliestToday(place, now)
  const corrections = close && closed ? await db.attendanceCorrection.count({ where: { monthCloseId: close.id } }) : 0
  const mayClose = reachesCompany(context, place, [PEOPLE_ATTENDANCE_CLOSE])
  return {
    companyId: place.company.id,
    month,
    label: monthLabel(month),
    state: closed ? ('CLOSED' as const) : ('OPEN' as const),
    closeId: close?.id ?? null,
    monthOver: monthOver(month, today),
    due: { by: lulDueBy(month), daysLeft: lulDaysLeft(month, today), words: `LUL due by ${lulDueBy(month)} (end of the following month).` },
    checklist: closeChecklist(facts),
    notes: closeNotes(facts),
    holds: holds.map((code) => ({ code, words: holdWords(code, facts) })),
    days: facts.days,
    sites: place.sites.map((site) => ({ siteId: site.id, code: site.code, name: site.name, gateOpen: gates.open.some((entry) => entry.id === site.id) })),
    corrections,
    seal: closed && close ? { closedAt: iso(close.closedAt)!, closedBy: close.closedById ? (names.get(close.closedById) ?? null) : null, sealed: close.lulFileId !== null, sha256: close.lulSha256, fileId: close.lulFileId } : null,
    confirm: { phrases: closePhrases(month), consequences: CLOSE_CONSEQUENCES },
    /** The calendar's layout is generic until the labour consultant confirms it (GATE-PAYROLL). */
    toConfirm: [...LUL_TO_CONFIRM],
    actions: {
      close: holds.length === 0 && mayClose,
      seal: closed && close?.lulFileId === null && mayClose,
      openLul: closed && close?.lulFileId !== null && reachesCompany(context, place, [PEOPLE_ATTENDANCE_LUL]),
    },
  }
}

/** GET /people/month-close. */
export async function monthPanel(caller: CommandCaller, query: MonthQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, VIEW)
    const month = query.month ?? previousMonth(place, serverClock.now())
    return panelOf(db, context, place, month, serverClock.now())
  })
}

const previousMonth = (place: Place, now: Date): string => {
  const today = earliestToday(place, now)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

/** GET /people/month-close/months: the company's closes, newest first (no person; nothing without a close row). */
export async function listMonths(caller: CommandCaller, query: MonthsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, VIEW)
    requireSomeGate(await gatesOf(db, place))
    const rows = await db.attendanceMonthClose.findMany({ where: { companyId: place.company.id }, select: CLOSE_SELECT, orderBy: [{ month: 'desc' }], take: query.limit ?? 24 })
    return {
      companyId: place.company.id,
      months: rows.map((row) => ({ closeId: row.id, month: monthOfClose(row), label: monthLabel(monthOfClose(row)), state: row.status, closedAt: iso(row.closedAt), sealed: row.lulFileId !== null })),
    }
  })
}

// ---- the calendar ----------------------------------------------------------------------------------------------------

/** What the calendar says: the closed figures of the month (never a correction: those stand beside it). */
export async function lulFactsOf(db: Client, place: Place, close: CloseRow): Promise<LulFacts> {
  const month = monthOfClose(close)
  const period = periodOfMonth(month, 'month')
  const days = await monthDays(db, { companyId: place.company.id, ...period })
  const codes = await codesById(db, days.flatMap((day) => [...day.cells.absences.keys()]))
  const ids = [...new Set(days.map((day) => day.employeeId))]
  const people = ids.length === 0 ? [] : await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, kind: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }] })
  const names = await userNames(db, [close.closedById])
  const zone = place.sites[0]?.timezone
  const persons: LulPerson[] = people.map((person) => ({
    employeeCode: person.employeeCode,
    name: fullName(person),
    kind: person.kind,
    days: days
      .filter((day) => day.employeeId === person.id)
      .map((day): LulDay => ({
        date: day.date,
        plannedWork: day.plannedWork,
        presence: day.firstInAt !== null,
        manual: day.manual,
        ordinaryMinutes: day.cells.ordinary,
        nightMinutes: day.cells.night,
        holidayMinutes: day.cells.holiday,
        overtime: { DAY: day.cells.overtimeDay, NIGHT: day.cells.overtimeNight, HOLIDAY: day.cells.overtimeHoliday },
        absences: [...day.cells.absences].map(([codeId, minutes]) => ({ code: codes.get(codeId)?.code ?? '?', lulCode: codes.get(codeId)?.lulCode ?? null, minutes })),
      })),
  }))
  return { company: place.company, month, closedAt: close.closedAt!, closedOn: businessDate(close.closedAt!, zone), closedBy: close.closedById ? (names.get(close.closedById) ?? null) : null, people: persons }
}

interface Prepared {
  readonly pdf: PreparedGeneratedFile
  readonly csv: PreparedGeneratedFile
}

/** The two files in the store, outside any transaction. Office only, kept (the row's retention) and read through this module. */
async function prepareFiles(caller: CommandCaller, place: Place, close: CloseRow): Promise<Prepared> {
  const facts = await caller.withClient((db) => lulFactsOf(db, place, close))
  const calendar = lulCalendar(facts)
  const csv = lulCsv(facts)
  const retainUntil = new Date(close.closedAt!)
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + LUL_RETENTION_YEARS)
  const stored = { companyId: place.company.id, recordType: 'AttendanceMonthClose', recordId: close.id, kind: 'DOCUMENT' as const, visibility: ['OFFICE' as const], retainUntil }
  const runtime = processFiles()
  return {
    pdf: await putGeneratedFile(runtime, caller, { ...stored, originalName: calendar.fileName, contentType: 'application/pdf', body: await renderLulPdf(calendar) }),
    csv: await putGeneratedFile(runtime, caller, { ...stored, originalName: csv.fileName, contentType: 'text/csv', body: Buffer.from(csv.text, 'utf8') }),
  }
}

/** Seals the close: the files recorded, the PDF's SHA-256 on the close (set once: a second seal changes nothing). */
async function seal(caller: CommandCaller, place: Place, close: CloseRow, idempotencyKey?: string): Promise<void> {
  const prepared = await prepareFiles(caller, place, close)
  const month = monthOfClose(close)
  await command(caller, { name: 'people.sealLulCalendar', idempotencyKey, input: { closeId: close.id } }, async (tools) => {
    const row = await tools.tx.attendanceMonthClose.findUnique({ where: { id: close.id }, select: CLOSE_SELECT })
    if (!row || row.status !== 'CLOSED') throw new NotFoundError('Month close not found.')
    if (row.lulFileId !== null) {
      tools.audit({ recordType: 'AttendanceMonthClose', recordId: row.id, companyId: row.companyId, after: { month, alreadySealed: true } })
      return { closeId: row.id }
    }
    const pdf = await recordGeneratedFile(tools, prepared.pdf, { action: 'people.lulCalendarFile', details: { month, format: 'PDF' } })
    await recordGeneratedFile(tools, prepared.csv, { action: 'people.lulCalendarFile', details: { month, format: 'CSV' } })
    await tools.tx.attendanceMonthClose.update({ where: { id: row.id }, data: { lulFileId: pdf.id, lulSha256: prepared.pdf.sha256, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'AttendanceMonthClose', recordId: row.id, companyId: row.companyId, after: { month, lulFileId: pdf.id, lulSha256: prepared.pdf.sha256 } })
    tools.emit({ type: 'attendance.lul_sealed', subject: row.id, companyId: row.companyId, payload: { closeId: row.id, companyId: row.companyId, month } })
    return { closeId: row.id }
  })
}

// ---- the close ---------------------------------------------------------------------------------------------------------

/** The month's key EXCLUSIVE: the database's own (…_time_w2b_guards); every write dated in the month holds it shared. */
async function lockMonth(tx: CommandTx, tenantId: string, companyId: string, firstDay: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock("factory_time_month_key"(${tenantId}::uuid, ${companyId}::uuid, ${firstDay}::date))`
}

function refuseHeld(holds: readonly ReturnType<typeof closeHolds>[number][], facts: MonthFacts): never {
  const words = holds.map((code) => holdWords(code, facts))
  return refuse('HELD', words.join(' '), undefined, holds.map((code, index) => ({ path: `holds/${code}`, message: words[index]! })))
}

/** POST /people/month-close: the company's month closed for good, in one command, then its calendar sealed. */
export async function closeMonth(caller: CommandCaller, body: CloseBody, key?: string) {
  const context = officeOf(caller)
  const period = periodOfMonth(body.month, 'body/month')
  if (!closePhraseMatches(body.month, body.phrase)) {
    const phrases = closePhrases(body.month)
    throw new ValidationError(`Closing ${monthLabel(body.month)} needs its phrase typed.`, [{ path: 'body/phrase', message: `Type "${phrases.en}" (or "${phrases.it}").` }])
  }
  const { place, lineDaysOpen } = await caller.withClient(async (db) => {
    const found = await companyFor(db, context, body.companyId, [...VIEW, PEOPLE_ATTENDANCE_CLOSE])
    if (!reachesCompany(context, found, [PEOPLE_ATTENDANCE_CLOSE])) throw new ForbiddenError('Closing a month needs people.attendance.close over every site of the company.')
    requireSomeGate(await gatesOf(db, found))
    return { place: found, lineDaysOpen: await lineDaysLeft(db, found, period) }
  })
  const companyId = place.company.id
  const { result } = await runCommand(
    caller,
    { name: 'people.closeAttendanceMonth', idempotencyKey: key, input: { companyId, month: body.month } },
    async (tools) => {
      const { tx, now } = tools
      const actorId = assertPersonDecides(tools.context, 'ATTENDANCE_MONTH_CLOSE')
      await lockMonth(tx, context.tenantId, companyId, period.from)
      const gates = await gatesOf(tx, place)
      requireSomeGate(gates)
      const existing = await closeOfMonth(tx, companyId, body.month)
      const facts = await monthFactsOf(tx, place, body.month, { gates, closed: existing?.status === 'CLOSED', lineDaysOpen, now })
      const holds = closeHolds(facts)
      if (holds.length > 0) refuseHeld(holds, facts)
      const closeId = existing?.id ?? newId()
      if (!existing) await tx.attendanceMonthClose.create({ data: { id: closeId, companyId, month: dateOf(period.from), status: 'OPEN', createdById: actorId }, select: { id: true } })
      const dates = { gte: dateOf(period.from), lte: dateOf(period.to) }
      const locked = await tx.attendanceDay.updateMany({ where: { companyId, date: dates, status: 'APPROVED' }, data: { status: 'CLOSED', monthCloseId: closeId, closedAt: now, version: { increment: 1 } } })
      // The database asks again: every day closed by this close, no anomaly open, no overtime waiting.
      await tx.attendanceMonthClose.update({ where: { id: closeId }, data: { status: 'CLOSED', closedAt: now, closedById: actorId, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'AttendanceMonthClose', recordId: closeId, companyId, before: { status: existing?.status ?? null }, after: { status: 'CLOSED', month: body.month, days: locked.count, timesheetsOpen: facts.timesheetsOpen } })
      tools.emit({ type: 'attendance.month_closed', subject: closeId, companyId, payload: { closeId, companyId, month: body.month, days: locked.count } })
      return { closeId }
    },
    { ...COMMAND_SETTINGS, timeoutMs: CLOSE_TIMEOUT_MS },
  )
  const close = await caller.withClient((db) => db.attendanceMonthClose.findUniqueOrThrow({ where: { id: result.closeId }, select: CLOSE_SELECT }))
  if (close.lulFileId === null) await sealOrLeave(caller, place, close, key)
  return caller.withClient((db) => panelOf(db, context, place, body.month, serverClock.now()))
}

/**
 * The month is closed whatever happens here: a store that is down or not set up (an answer in words, ApiError or DomainError)
 * leaves it unsealed and the panel says so; `seal` makes the calendar again. Anything else is a bug and stays one.
 */
async function sealOrLeave(caller: CommandCaller, place: Place, close: CloseRow, key?: string): Promise<void> {
  try {
    await seal(caller, place, close, key ? `${key.slice(0, 80)}:seal` : undefined)
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof DomainError)) throw error
  }
}

async function closeHead(db: Client, context: OfficeContext, closeId: string, permissions: Parameters<typeof reachesCompany>[2]): Promise<{ close: CloseRow; place: Place }> {
  const close = await db.attendanceMonthClose.findUnique({ where: { id: closeId }, select: CLOSE_SELECT })
  const place = close ? await placeOf(db, close.companyId) : null
  if (!close || !place || !reachesCompany(context, place, permissions)) throw new NotFoundError('Month close not found.')
  return { close, place }
}

/** Every site holding days of the closed month has its gate on: the calendar names their people. */
async function requireGatesOfMonth(db: Client, place: Place, close: CloseRow): Promise<void> {
  const gates = await gatesOf(db, place)
  const off = gates.off.map((site) => site.id)
  const held = off.length === 0 ? 0 : await db.attendanceDay.count({ where: { monthCloseId: close.id, siteId: { in: off } } })
  if (held > 0 || gates.open.length === 0) throw gateClosedError('ATTENDANCE')
}

/** POST /people/month-close/:closeId/seal. */
export async function sealMonth(caller: CommandCaller, closeId: string, key?: string) {
  const context = officeOf(caller)
  const { close, place } = await caller.withClient(async (db) => {
    const found = await closeHead(db, context, closeId, [...VIEW, PEOPLE_ATTENDANCE_CLOSE])
    if (!reachesCompany(context, found.place, [PEOPLE_ATTENDANCE_CLOSE])) throw new ForbiddenError('Sealing a calendar needs people.attendance.close over every site of the company.')
    await requireGatesOfMonth(db, found.place, found.close)
    return found
  })
  if (close.status !== 'CLOSED') refuse('NOT_CLOSED', 'This month is not closed: there is no calendar to seal yet.')
  if (close.lulFileId !== null) refuse('ALREADY_SEALED', 'This calendar is sealed already: a seal is set once.')
  await seal(caller, place, close, key)
  return caller.withClient((db) => panelOf(db, context, place, monthOfClose(close), serverClock.now()))
}

/** POST /people/month-close/:closeId/lul/open: the calendar of a closed month. Every opening is recorded; no store call in it. */
export async function openLul(caller: CommandCaller, closeId: string, body: OpenLulBody, key?: string) {
  const context = officeOf(caller)
  const format = body.format ?? 'PDF'
  const { close, place, file } = await caller.withClient(async (db) => {
    const found = await closeHead(db, context, closeId, [PEOPLE_ATTENDANCE_LUL])
    await requireGatesOfMonth(db, found.place, found.close)
    const row = await db.storedFile.findFirst({ where: { recordType: 'AttendanceMonthClose', recordId: found.close.id, status: 'AVAILABLE', contentType: format === 'PDF' ? 'application/pdf' : 'text/csv' }, select: { id: true, originalName: true, sha256: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return { ...found, file: row }
  })
  if (close.lulFileId === null || !file) throw new InvalidStateError('The LUL calendar of this month is not sealed yet.')
  await command(caller, { name: 'people.openLulCalendar', idempotencyKey: key, input: { closeId, format } }, async (tools) => {
    await requireGatesOfMonth(tools.tx, place, close)
    tools.audit({ recordType: 'AttendanceMonthClose', recordId: close.id, companyId: close.companyId, after: { month: monthOfClose(close), format } })
    return { closeId }
  })
  const download = await downloadFile(processFiles(), { caller, system: () => caller }, format === 'PDF' ? close.lulFileId : file.id, { viaModule: true })
  return { closeId, format, fileName: file.originalName, sha256: file.sha256, download }
}

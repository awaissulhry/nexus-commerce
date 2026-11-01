import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { documentRefProblems } from '@nexus/factory-domain/people/attendance/absences'
import { PEOPLE_ATTENDANCE_MANAGE } from '@nexus/factory-domain/people/attendance/permissions'
import { manualTimeProblems, reasonProblems, type ManualReason } from '@nexus/factory-domain/people/attendance/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertVersion, dateOf, dayOf, officeOf, refuse } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { personFor, refuseOwnDay, requireAttendance } from './access'
import { dayFactsOf, lockPerson, syncDayInCommand } from './compute'
import type { DayAbsenceBody, FixDayBody, ManualEntryBody } from './contract'
import { dayForWrite, detailOf } from './days'
import { dayOfPerson, EVENT_SELECT, monthClosed, siteOf, type Client, type PersonRow, type SiteRow } from './store'

/**
 * Manual entries (B-W2b-37; MES-238 manual entry with a reason, MES-228 absence codes; design people.attendance pop-ups
 * "Manual entry", "Fix a day", the inline absence code of the Days grid), office only, behind the site's ATTENDANCE gate,
 * people.attendance.manage over the day's place.
 *
 *   POST /people/attendance/entries               person, date, a clock-in and / or a clock-out (work outside the plant)
 *                                                 and / or an absence code, always with a reason
 *   POST /people/attendance/days/:dayId/fix       one fix of a day: add a clock event, void one (kept, marked void), set
 *                                                 or remove an absence; the reason; the version read
 *   POST /people/attendance/days/:dayId/absence   the absence code of a day nobody clocked in (autosave; null clears)
 *
 * A clock event entered by hand is a MANUAL ClockEvent with its reason (the database refuses one without), a mistaken one
 * is voided by a VOID event (the original kept, marked void): the clock events stay append-only. Each write: ONE command
 * under the person's lock (the clock's), an audit row per event or absence with the reason, attendance.clock_event (and
 * clock.out for a clock-out: open work pauses), the day computed again (anomalies the fix made go are FIXED by the
 * person, with the reason) and marked manual for good ("Manual entries are marked in the LUL calendar"). Never one's own
 * day; never in a closed month; an approved day is reopened first. A sickness is a code and a certificate's number:
 * nothing else about it is written (GDPR art. 9).
 */

const words = (code: ManualReason | undefined, reason: string): string => (code ? `${code}: ${reason.trim()}` : reason.trim())

function problemsOrThrow(problems: Issue[]): void {
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** The ACTIVE absence code, of the person's company or of the whole group (else 404 / refused in words). */
async function codeFor(db: Client, codeId: string, companyId: string) {
  const code = await db.absenceCode.findUnique({ where: { id: codeId }, select: { id: true, code: true, companyId: true, status: true, documentRequired: true, category: true } })
  if (!code || (code.companyId !== null && code.companyId !== companyId)) throw new NotFoundError('Absence code not found.')
  if (code.status !== 'ACTIVE') refuse('CODE_ARCHIVED', `Absence code ${code.code} is archived: use an active one.`, 'codeId')
  return code
}

/** The day's state for a write: never an approved or closed day, never in a closed month. */
async function assertWritable(db: Client, person: PersonRow, date: BusinessDate): Promise<void> {
  if (await monthClosed(db, person.companyId, date)) refuse('MONTH_CLOSED', "This day is in a month whose attendance is closed (its LUL calendar is out): correct the closed day instead.")
  const row = await dayOfPerson(db, person.id, date)
  if (row?.status === 'APPROVED') refuse('DAY_APPROVED', 'This day is approved: reopen it first, with the reason.')
  if (row?.status === 'CLOSED') refuse('DAY_CLOSED', "This day's month is closed: it changes only by a correction.")
}

interface EventToAdd {
  readonly kind: 'IN' | 'OUT' | 'BREAK_OUT' | 'BREAK_IN'
  readonly at: Date
  readonly offSite: boolean
}

/** Writes one MANUAL clock event with its audit row and its events. */
async function addEvent(tools: CommandTools, person: PersonRow, site: SiteRow, event: EventToAdd, reason: string): Promise<string> {
  const id = newId()
  await tools.tx.clockEvent.create({
    data: { id, companyId: person.companyId, siteId: site.id, employeeId: person.id, kind: event.kind, source: 'MANUAL', occurredAt: event.at, reason, offSite: event.offSite && (event.kind === 'IN' || event.kind === 'OUT'), createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: EVENT_SELECT,
  })
  tools.audit({ action: 'people.manualClockEvent', recordType: 'ClockEvent', recordId: id, companyId: person.companyId, siteId: site.id, after: { employeeId: person.id, kind: event.kind, source: 'MANUAL', occurredAt: toUtcIso(event.at), offSite: event.offSite }, reason })
  const where = { subject: person.id, companyId: person.companyId, siteId: site.id }
  tools.emit({ type: 'attendance.clock_event', ...where, payload: { clockEventId: id, siteId: site.id, employeeId: person.id, kind: event.kind, source: 'MANUAL', flagged: false } })
  if (event.kind === 'OUT') tools.emit({ type: 'clock.out', ...where, payload: { clockEventId: id, siteId: site.id, employeeId: person.id, workerId: null, source: 'MANUAL' } })
  return id
}

/** Sets (or changes) one absence of the day under a code, with its audit row. */
async function setAbsence(tools: CommandTools, person: PersonRow, date: BusinessDate, absence: { readonly codeId: string; readonly minutes: number; readonly documentRef: string | null }, reason: string | null): Promise<void> {
  const existing = await tools.tx.absenceEntry.findFirst({ where: { employeeId: person.id, date: dateOf(date), codeId: absence.codeId }, select: { id: true, minutes: true, documentRef: true } })
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  let id: string
  if (existing) {
    id = existing.id
    await tools.tx.absenceEntry.update({ where: { id }, data: { minutes: absence.minutes, documentRef: absence.documentRef, version: { increment: 1 } }, select: { id: true } })
  } else {
    id = newId()
    await tools.tx.absenceEntry.create({ data: { id, companyId: person.companyId, employeeId: person.id, date: dateOf(date), codeId: absence.codeId, minutes: absence.minutes, documentRef: absence.documentRef, createdById: actorId }, select: { id: true } })
  }
  tools.audit({
    action: 'people.setAbsence',
    recordType: 'AbsenceEntry',
    recordId: id,
    companyId: person.companyId,
    ...(existing ? { before: { minutes: existing.minutes, documentRef: existing.documentRef } } : {}),
    after: { employeeId: person.id, date, codeId: absence.codeId, minutes: absence.minutes, documentRef: absence.documentRef },
    ...(reason ? { reason } : {}),
  })
}

async function removeAbsence(tools: CommandTools, person: PersonRow, absenceId: string, reason: string | null): Promise<void> {
  const row = await tools.tx.absenceEntry.findUnique({ where: { id: absenceId }, select: { id: true, employeeId: true, date: true, codeId: true, minutes: true, companyId: true } })
  if (!row || row.employeeId !== person.id) throw new NotFoundError('Absence not found.')
  await tools.tx.absenceEntry.delete({ where: { id: absenceId } })
  tools.audit({ action: 'people.removeAbsence', recordType: 'AbsenceEntry', recordId: absenceId, companyId: row.companyId, before: { employeeId: person.id, date: dayOf(row.date), codeId: row.codeId, minutes: row.minutes }, ...(reason ? { reason } : {}) })
}

/** The minutes of an absence: as given, else the planned shift's working minutes (a whole day). */
async function absenceMinutesOf(db: Client, person: PersonRow, date: BusinessDate, given: number | undefined): Promise<number> {
  if (given !== undefined) return given
  const facts = await dayFactsOf(db, person, date, serverClock.now())
  if (facts.computed.planned && facts.computed.planned.minutes > 0) return facts.computed.planned.minutes
  throw new ValidationError('No shift is planned that day: say how many minutes the absence is.', [{ path: 'body/absence/minutes', message: 'The minutes absent (a whole day: the planned shift).' }])
}

/** A clock event's time must fall around its day (the day before, the day, the day after: a night shift). */
function timeAround(at: Date, date: BusinessDate, timeZone: string, path: string): Issue[] {
  const day = businessDate(at, timeZone)
  return day >= plusDays(date, -1) && day <= plusDays(date, 1) ? [] : [{ path, message: `The time is not on ${date} (or the night around it): give the time of that day.` }]
}

// ---- manual entry --------------------------------------------------------------------------------------------------

export async function manualEntry(caller: CommandCaller, body: ManualEntryBody, key?: string) {
  const context = officeOf(caller)
  problemsOrThrow(reasonProblems(body.reason))
  const inAt = parseInstant(body.in)
  const outAt = parseInstant(body.out)
  if (!inAt && !outAt && !body.absence) throw new ValidationError('Enter a clock-in, a clock-out or an absence code.', [{ path: 'body/in', message: 'A clock-in, a clock-out or an absence.' }])
  const now = serverClock.now()
  const { person, site } = await caller.withClient(async (db) => {
    const found = await personFor(db, context, body.employeeId, PEOPLE_ATTENDANCE_MANAGE, body.siteId)
    const place = await siteOf(db, body.siteId ?? found.siteId)
    if (!place || place.companyId !== found.companyId) throw new NotFoundError('Site not found.')
    await requireAttendance(db, place.id)
    return { person: found, site: place }
  })
  const problems: Issue[] = []
  if (inAt) problems.push(...manualTimeProblems(inAt, now, 'in'), ...timeAround(inAt, body.date, site.timezone, 'in'))
  if (outAt) problems.push(...manualTimeProblems(outAt, now, 'out'), ...timeAround(outAt, body.date, site.timezone, 'out'))
  if (inAt && outAt && outAt.getTime() <= inAt.getTime()) problems.push({ path: 'out', message: 'The clock-out is after the clock-in.' })
  if (body.offSite && !inAt && !outAt) problems.push({ path: 'offSite', message: 'Work outside the plant is a clock-in and a clock-out.' })
  problemsOrThrow(problems)
  const absence = body.absence
    ? await caller.withClient(async (db) => {
        const code = await codeFor(db, body.absence!.codeId, person.companyId)
        problemsOrThrow(documentRefProblems(body.absence!.documentRef, code.documentRequired, 'absence/documentRef'))
        return { codeId: code.id, minutes: await absenceMinutesOf(db, person, body.date, body.absence!.minutes), documentRef: body.absence!.documentRef || null }
      })
    : null
  await caller.withClient((db) => assertWritable(db, person, body.date))
  const reason = words(body.reasonCode, body.reason)
  const { result, replayed } = await command(caller, { name: 'people.manualAttendanceEntry', idempotencyKey: key, input: body }, async (tools) => {
    assertPersonDecides(tools.context, 'ATTENDANCE_CORRECTION')
    await lockPerson(tools.tx, context.tenantId, person.id)
    await requireAttendance(tools.tx, site.id)
    await refuseOwnDay(tools.tx, context, person.id)
    await assertWritable(tools.tx, person, body.date)
    if (inAt) await addEvent(tools, person, site, { kind: 'IN', at: inAt, offSite: body.offSite === true }, reason)
    if (outAt) await addEvent(tools, person, site, { kind: 'OUT', at: outAt, offSite: body.offSite === true }, reason)
    if (absence) await setAbsence(tools, person, body.date, absence, reason)
    const synced = await syncDayInCommand(tools, person, body.date, { change: 'FIXED', fix: { personId: context.actorId, note: reason }, manual: true, reason })
    if (!synced.dayId) refuse('NO_DAY', 'Nothing was entered for that day.')
    return { dayId: synced.dayId! }
  })
  return { created: !replayed, answer: await caller.withClient((db) => detailOf(db, context, result.dayId)) }
}

// ---- fix a day -----------------------------------------------------------------------------------------------------

export async function fixDay(caller: CommandCaller, dayId: string, body: FixDayBody, key?: string) {
  const context = officeOf(caller)
  problemsOrThrow(reasonProblems(body.reason))
  const now = serverClock.now()
  const { person, head, date } = await caller.withClient((db) => dayForWrite(db, context, dayId, PEOPLE_ATTENDANCE_MANAGE))
  const site = (await caller.withClient((db) => siteOf(db, head.siteId)))!
  const action = body.action
  let absence: { codeId: string; minutes: number; documentRef: string | null } | null = null
  if (action.kind === 'ADD_EVENT') {
    const at = parseInstant(action.at)!
    problemsOrThrow([...manualTimeProblems(at, now, 'action/at'), ...timeAround(at, date, site.timezone, 'action/at')])
    if (action.offSite && action.event !== 'IN' && action.event !== 'OUT') problemsOrThrow([{ path: 'action/offSite', message: 'Work outside the plant is a clock-in and a clock-out.' }])
  }
  if (action.kind === 'SET_ABSENCE') {
    absence = await caller.withClient(async (db) => {
      const code = await codeFor(db, action.codeId, person.companyId)
      problemsOrThrow(documentRefProblems(action.documentRef, code.documentRequired, 'action/documentRef'))
      return { codeId: code.id, minutes: await absenceMinutesOf(db, person, date, action.minutes), documentRef: action.documentRef || null }
    })
  }
  const reason = words(body.reasonCode, body.reason)
  await command(caller, { name: 'people.fixAttendanceDay', idempotencyKey: key, input: { dayId, ...body } }, async (tools) => {
    assertPersonDecides(tools.context, 'ATTENDANCE_CORRECTION')
    await lockPerson(tools.tx, context.tenantId, person.id)
    await requireAttendance(tools.tx, head.siteId)
    const row = await tools.tx.attendanceDay.findUnique({ where: { id: dayId }, select: { version: true } })
    assertVersion('attendance day', row!.version, body.version)
    await refuseOwnDay(tools.tx, context, person.id)
    await assertWritable(tools.tx, person, date)
    switch (action.kind) {
      case 'ADD_EVENT':
        await addEvent(tools, person, site, { kind: action.event, at: parseInstant(action.at)!, offSite: action.offSite === true }, reason)
        break
      case 'VOID_EVENT': {
        const target = await tools.tx.clockEvent.findUnique({ where: { id: action.clockEventId }, select: { id: true, employeeId: true, kind: true, occurredAt: true, siteId: true, companyId: true, source: true } })
        if (!target || target.employeeId !== person.id) throw new NotFoundError('Clock event not found.')
        if (target.kind === 'VOID') refuse('NOT_VOIDABLE', 'A void is not voided: enter the right time instead.', 'action/clockEventId')
        if (await tools.tx.clockEvent.findFirst({ where: { voidsEventId: target.id }, select: { id: true } })) refuse('ALREADY_VOID', 'This clock event is voided already.', 'action/clockEventId')
        const id = newId()
        await tools.tx.clockEvent.create({ data: { id, companyId: target.companyId, siteId: target.siteId, employeeId: person.id, kind: 'VOID', source: 'MANUAL', occurredAt: target.occurredAt, reason, voidsEventId: target.id, createdById: context.actorId }, select: { id: true } })
        tools.audit({ action: 'people.voidClockEvent', recordType: 'ClockEvent', recordId: id, companyId: target.companyId, siteId: target.siteId, after: { employeeId: person.id, voids: target.id, voidedKind: target.kind, voidedSource: target.source, occurredAt: toUtcIso(target.occurredAt) }, reason })
        break
      }
      case 'SET_ABSENCE':
        await setAbsence(tools, person, date, absence!, reason)
        break
      case 'REMOVE_ABSENCE':
        await removeAbsence(tools, person, action.absenceId, reason)
        break
    }
    await syncDayInCommand(tools, person, date, { change: action.kind === 'SET_ABSENCE' || action.kind === 'REMOVE_ABSENCE' ? 'ABSENCE' : 'FIXED', fix: { personId: context.actorId, note: reason }, manual: true, reason })
    return { dayId }
  })
  return caller.withClient((db) => detailOf(db, context, dayId))
}

// ---- the inline absence code ---------------------------------------------------------------------------------------

/**
 * The absence code of a day nobody clocked in (design "Inline edit: Absence code on a day with no clock-ins"): one code
 * for the day (others removed), its minutes the planned shift's unless given; null clears the day's absences. Coding an
 * absence on an empty day alters no clocked time: no reason asked, the day not marked manual. A day with clock events
 * changes only through Fix a day, with a reason.
 */
export async function setDayAbsence(caller: CommandCaller, dayId: string, body: DayAbsenceBody, key?: string) {
  const context = officeOf(caller)
  const { person, head, date } = await caller.withClient((db) => dayForWrite(db, context, dayId, PEOPLE_ATTENDANCE_MANAGE))
  const facts = await caller.withClient((db) => dayFactsOf(db, person, date, serverClock.now()))
  if (facts.computed.eventIds.length > 0) refuse('HAS_CLOCK_EVENTS', 'This day has clock events: change it with Fix a day, with the reason.')
  const absence = body.codeId
    ? await caller.withClient(async (db) => {
        const code = await codeFor(db, body.codeId!, person.companyId)
        problemsOrThrow(documentRefProblems(body.documentRef, code.documentRequired, 'documentRef'))
        return { codeId: code.id, minutes: await absenceMinutesOf(db, person, date, body.minutes), documentRef: body.documentRef || null }
      })
    : null
  await command(caller, { name: 'people.setDayAbsence', idempotencyKey: key, input: { dayId, ...body } }, async (tools) => {
    assertPersonDecides(tools.context, 'ATTENDANCE_CORRECTION')
    await lockPerson(tools.tx, context.tenantId, person.id)
    await requireAttendance(tools.tx, head.siteId)
    const row = await tools.tx.attendanceDay.findUnique({ where: { id: dayId }, select: { version: true } })
    assertVersion('attendance day', row!.version, body.version)
    await refuseOwnDay(tools.tx, context, person.id)
    await assertWritable(tools.tx, person, date)
    const others = await tools.tx.absenceEntry.findMany({ where: { employeeId: person.id, date: dateOf(date), ...(absence ? { codeId: { not: absence.codeId } } : {}) }, select: { id: true } })
    for (const other of others) await removeAbsence(tools, person, other.id, null)
    if (absence) await setAbsence(tools, person, date, absence, null)
    const synced = await syncDayInCommand(tools, person, date, { change: 'ABSENCE' })
    if (!synced.changed && others.length === 0 && !absence) tools.audit({ action: 'people.setDayAbsence', recordType: 'AttendanceDay', recordId: dayId, companyId: person.companyId, after: { cleared: 0 } })
    return { dayId }
  })
  return caller.withClient((db) => detailOf(db, context, dayId))
}


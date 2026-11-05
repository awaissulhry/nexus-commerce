import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_TRAINING_RECORD } from '@nexus/factory-domain/safety/records/permissions'
import {
  ATTENDANCE_STATEMENT,
  closePlan,
  COUNTERSIGN_STATEMENT,
  expectedValidUntil,
  LANGUAGE_LAW,
  languageOf,
  RECORD_LIMITS,
  RECORDS_LAW,
  RECORDS_REFUSALS,
  sessionProblems,
  type CloseDecision,
  type SessionDraft,
} from '@nexus/factory-domain/safety/records/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, bodyIssue, dateOf, dayOf, officeOf, problemsError, refuse, siteScope, todayOf } from '../organisation/access'
import {
  ATTENDANCE_SELECT,
  attendanceViews,
  availableCourse,
  filesOf,
  fullName,
  lockSession,
  placeOf,
  readSession,
  RECORD_ATTENDANCE,
  RECORD_SESSION,
  RECORD_TRAINING,
  SESSION_SELECT,
  sessionCounts,
  sessionView,
  type SessionRow,
} from './store'

/**
 * Training sessions in the office (B-W2b-139; QHS-248, QHS-247; design people.skills "Record training … people (or 'from the
 * floor sign-off')", floor.training "The trainer opens the session (from People › Skills & training)"), each write one
 * command with an Idempotency-Key, safety.training.record over the session's company and site:
 *
 *   GET   /safety/training/sessions                     the sessions (?companyId&siteId&status&courseId&from&to): course, day,
 *                                                       hours, language, trainer, where, status, how many signed and
 *                                                       countersigned (counts)
 *   GET   /safety/training/sessions/:id                 one session: its attendances by name (a register), how each signed,
 *                                                       the trainer's countersignature and language check, its records once
 *                                                       closed, the paper sheet's scans
 *   POST  /safety/training/sessions                     open one at a site: an ACTIVE course of the group or the company, a
 *                                                       day, its hours (at most 24), the language, the trainer (a person of
 *                                                       the company, who may countersign on the floor, or an outside trainer
 *                                                       by name with the provider)
 *   PATCH /safety/training/sessions/:id                 edit it while OPEN; once people signed, only where and the note
 *   POST  /safety/training/sessions/:id/paper           people who signed the paper sheet (PAPER): its scan is a file of the
 *                                                       session (POST /files recordType TrainingSession)
 *   POST  /safety/training/sessions/:id/countersign     the trainer's countersignature recorded in the office (PAPER: the
 *                                                       trainer signed the sheet; OFFICE: the office confirms), with the
 *                                                       language check of each person (art. 37 c.13)
 *   POST  /safety/training/sessions/:id/attendances/:attendanceId/void   a wrong attendance, with the reason
 *   POST  /safety/training/sessions/:id/close           held today at the latest; every attendance countersigned or voided;
 *                                                       one training record per countersigned attendance (PASSED unless the
 *                                                       office says FAILED; FAILED when the language was not understood),
 *                                                       valid until its day plus the course's refresher period; signing stops
 *   POST  /safety/training/sessions/:id/cancel          with the reason, while no record came from it; signing stops
 *
 * The office never proves a worker's PIN: a FLOOR_PIN attendance or countersignature comes only from the tablet (./floor.ts;
 * the database refuses it from an office session anyway).
 */

const RECORD_WORDS = 'Training sessions are kept by a role that keeps the training records (safety.training.record).'
const LAW = { training: RECORDS_LAW, language: LANGUAGE_LAW }

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly status?: 'OPEN' | 'CLOSED' | 'CANCELLED' | 'all' | undefined
  readonly courseId?: string | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
}

/** GET /safety/training/sessions. */
export async function listSessions(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const status = query.status ?? 'all'
    const rows = (await client.trainingSession.findMany({
      where: {
        AND: [
          siteScope(context, SAFETY_VIEW) as Prisma.TrainingSessionWhereInput,
          ...(query.companyId ? [{ companyId: query.companyId }] : []),
          ...(query.siteId ? [{ siteId: query.siteId }] : []),
          ...(status === 'all' ? [] : [{ status }]),
          ...(query.courseId ? [{ courseId: query.courseId }] : []),
          ...(query.from ? [{ heldOn: { gte: dateOf(query.from) } }] : []),
          ...(query.to ? [{ heldOn: { lte: dateOf(query.to) } }] : []),
        ],
      },
      orderBy: [{ heldOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: RECORD_LIMITS.list + 1,
      select: SESSION_SELECT,
    })) as SessionRow[]
    const shown = rows.slice(0, RECORD_LIMITS.list)
    const counts = await sessionCounts(
      client,
      shown.map((row) => row.id),
    )
    return {
      sessions: shown.map((row) => sessionView(context, row, counts.get(row.id))),
      complete: rows.length <= RECORD_LIMITS.list,
      canOpen: canRecordAnywhere(context),
      today: todayOf(now),
    }
  })
}

async function readableSession(caller: CommandCaller, context: OfficeContext, sessionId: string): Promise<SessionRow> {
  const row = await caller.withClient((client) => readSession(client, sessionId))
  if (!row) throw new NotFoundError('Training session not found.')
  assertMayAt(context, SAFETY_VIEW, placeOf(row), 'Training session')
  return row
}

/** GET /safety/training/sessions/:sessionId. */
export async function sessionRecord(caller: CommandCaller, sessionId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const row = await readableSession(caller, context, sessionId)
  return caller.withClient(async (client) => {
    const attendances = await client.trainingAttendance.findMany({ where: { sessionId: row.id }, orderBy: [{ signedAt: 'asc' }, { id: 'asc' }], select: ATTENDANCE_SELECT })
    const counts = await sessionCounts(client, [row.id])
    const records = await client.trainingRecord.findMany({ where: { sessionId: row.id, correctsId: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, employeeId: true, result: true, validUntil: true, languageChecked: true } })
    const scans = await filesOf(client, RECORD_SESSION, [row.id])
    return {
      session: sessionView(context, row, counts.get(row.id)),
      attendances: await attendanceViews(client, attendances, row.language),
      records: records.map((record) => ({ id: record.id, employeeId: record.employeeId, result: record.result as 'PASSED' | 'FAILED' | 'VOID', validUntil: record.validUntil ? dayOf(record.validUntil) : null, languageChecked: record.languageChecked })),
      scans: scans.get(row.id) ?? [],
      statements: { attendance: { ...ATTENDANCE_STATEMENT }, countersign: { ...COUNTERSIGN_STATEMENT } },
      scan: { recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId },
      law: LAW,
      today: todayOf(now),
    }
  })
}

// ---- open and edit ----------------------------------------------------------------------------------------------------------

export interface OpenBody {
  readonly siteId: string
  readonly courseId: string
  readonly heldOn: BusinessDate
  readonly hours: string
  readonly language: string
  readonly trainerEmployeeId?: string | null | undefined
  readonly trainerName?: string | null | undefined
  readonly providerPartyId?: string | null | undefined
  readonly location?: string | null | undefined
  readonly note?: string | null | undefined
}

const clean = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

/** The trainer a session names: an ACTIVE person of the company (the name from their record unless typed), or a name. */
async function trainerOf(tx: CommandTx, companyId: string, trainerEmployeeId: string | null, typed: string | null): Promise<{ employeeId: string | null; name: string }> {
  if (trainerEmployeeId === null) return { employeeId: null, name: typed! }
  const trainer = isUuid(trainerEmployeeId) ? await tx.employee.findUnique({ where: { id: trainerEmployeeId }, select: { id: true, companyId: true, status: true, firstName: true, lastName: true } }) : null
  if (!trainer || trainer.companyId !== companyId || trainer.status !== 'ACTIVE') refuse('TRAINER_NOT_AVAILABLE', RECORDS_REFUSALS.TRAINER_NOT_AVAILABLE, 'trainerEmployeeId')
  return { employeeId: trainer!.id, name: typed ?? fullName(trainer!) }
}

async function providerOf(tx: CommandTx, providerPartyId: string | null): Promise<string | null> {
  if (providerPartyId === null) return null
  const party = isUuid(providerPartyId) ? await tx.party.findUnique({ where: { id: providerPartyId }, select: { id: true } }) : null
  if (!party) throw new NotFoundError('Provider not found.')
  return party.id
}

const auditedSession = (row: SessionRow) => ({
  courseId: row.courseId,
  heldOn: dayOf(row.heldOn),
  hours: row.hours.toString(),
  language: row.language,
  trainerEmployeeId: row.trainerEmployeeId,
  trainerName: row.trainerName,
  providerPartyId: row.providerPartyId,
  location: row.location,
  status: row.status,
  note: row.note,
})

function emitSession(tools: CommandTools, row: SessionRow, change: 'OPENED' | 'EDITED' | 'CLOSED' | 'CANCELLED', records = 0) {
  tools.emit({ type: 'training_session.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { sessionId: row.id, courseId: row.courseId, status: row.status as 'OPEN' | 'CLOSED' | 'CANCELLED', change, records } })
}

/** POST /safety/training/sessions. */
export async function openSession(caller: CommandCaller, body: OpenBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const site = isUuid(body.siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true } })) : null
  if (!site) throw new NotFoundError('Site not found.')
  assertMayAt(context, SAFETY_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
  assertMayWriteAt(context, SAFETY_TRAINING_RECORD, { companyId: site.companyId, siteId: site.id }, RECORD_WORDS)
  const draft: SessionDraft = { heldOn: body.heldOn, hours: body.hours, language: body.language, trainerName: clean(body.trainerName), trainerEmployeeId: body.trainerEmployeeId ?? null, location: clean(body.location), note: clean(body.note) }
  const problems = sessionProblems(draft)
  if (problems.length > 0) throw problemsError(problems, 'The session is not complete.')
  const { result, replayed } = await command(caller, { name: 'safety.openTrainingSession', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const course = await availableCourse(tx, body.courseId, site.companyId)
    const trainer = await trainerOf(tx, site.companyId, draft.trainerEmployeeId, draft.trainerName)
    const providerPartyId = await providerOf(tx, body.providerPartyId ?? null)
    const id = newId()
    await tx.trainingSession.create({
      data: {
        id,
        companyId: site.companyId,
        siteId: site.id,
        courseId: course.id,
        heldOn: dateOf(body.heldOn),
        hours: body.hours,
        language: languageOf(body.language),
        trainerEmployeeId: trainer.employeeId,
        trainerName: trainer.name,
        providerPartyId,
        location: draft.location,
        note: draft.note,
        openedById: actorIdOf(tools.context)!,
        createdAt: now,
        updatedAt: now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    const row = (await readSession(tx, id))!
    tools.audit({ action: 'safety.openTrainingSession', recordType: RECORD_SESSION, recordId: id, companyId: row.companyId, siteId: row.siteId, after: auditedSession(row) })
    emitSession(tools, row, 'OPENED')
    return { session: sessionView(context, row, undefined) }
  })
  return { ...result, replayed }
}

export interface EditBody {
  readonly version: number
  readonly heldOn?: BusinessDate | undefined
  readonly hours?: string | undefined
  readonly language?: string | undefined
  readonly trainerEmployeeId?: string | null | undefined
  readonly trainerName?: string | null | undefined
  readonly providerPartyId?: string | null | undefined
  readonly location?: string | null | undefined
  readonly note?: string | null | undefined
}

async function writableSession(caller: CommandCaller, sessionId: string): Promise<{ context: OfficeContext; row: SessionRow }> {
  const context = officeOf(caller)
  const row = await readableSession(caller, context, sessionId)
  assertMayWriteAt(context, SAFETY_TRAINING_RECORD, placeOf(row), RECORD_WORDS)
  return { context, row }
}

const assertOpen = (row: SessionRow): void => {
  if (row.status !== 'OPEN') refuse('SESSION_STOPPED', RECORDS_REFUSALS.SESSION_STOPPED)
}

/** PATCH /safety/training/sessions/:sessionId. */
export async function editSession(caller: CommandCaller, sessionId: string, body: EditBody, idempotencyKey?: string) {
  const { context } = await writableSession(caller, sessionId)
  const { result } = await command(caller, { name: 'safety.editTrainingSession', idempotencyKey, input: { sessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockSession(tx, tools.context.tenantId, sessionId)
    assertVersion('session', row.version, body.version)
    assertOpen(row)
    const signed = await tx.trainingAttendance.count({ where: { sessionId: row.id, voidedAt: null } })
    const draft: SessionDraft = {
      heldOn: body.heldOn ?? dayOf(row.heldOn),
      hours: body.hours ?? row.hours.toString(),
      language: body.language ?? row.language,
      trainerEmployeeId: body.trainerEmployeeId !== undefined ? body.trainerEmployeeId : row.trainerEmployeeId,
      trainerName: body.trainerName !== undefined ? clean(body.trainerName) : body.trainerEmployeeId !== undefined ? null : row.trainerName,
      location: body.location !== undefined ? clean(body.location) : row.location,
      note: body.note !== undefined ? clean(body.note) : row.note,
    }
    const problems = sessionProblems(draft)
    if (problems.length > 0) throw problemsError(problems, 'The session is not complete.')
    const trainer = await trainerOf(tx, row.companyId, draft.trainerEmployeeId, draft.trainerName)
    const providerPartyId = body.providerPartyId !== undefined ? await providerOf(tx, body.providerPartyId) : row.providerPartyId
    const signedFields =
      draft.heldOn !== dayOf(row.heldOn) || Number(draft.hours) !== Number(row.hours.toString()) || languageOf(draft.language) !== row.language || trainer.employeeId !== row.trainerEmployeeId || trainer.name !== row.trainerName
    if (signed > 0 && signedFields) refuse('SIGNED_ALREADY', RECORDS_REFUSALS.SIGNED_ALREADY)
    await tx.trainingSession.update({
      where: { id: row.id },
      data: {
        heldOn: dateOf(draft.heldOn),
        hours: draft.hours,
        language: languageOf(draft.language),
        trainerEmployeeId: trainer.employeeId,
        trainerName: trainer.name,
        providerPartyId,
        location: draft.location,
        note: draft.note,
        version: { increment: 1 },
        updatedAt: now,
      },
      select: { id: true },
    })
    const after = (await readSession(tx, row.id))!
    tools.audit({ action: 'safety.editTrainingSession', recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditedSession(row), after: auditedSession(after) })
    emitSession(tools, after, 'EDITED')
    return { session: sessionView(context, after, (await sessionCounts(tx, [row.id])).get(row.id)) }
  })
  return result
}

// ---- attendance recorded in the office ----------------------------------------------------------------------------------------

async function signedCounts(tx: CommandTx, sessionId: string): Promise<{ signed: number; countersigned: number }> {
  const counts = (await sessionCounts(tx, [sessionId])).get(sessionId)
  return { signed: counts?.signed ?? 0, countersigned: counts?.countersigned ?? 0 }
}

/** POST /safety/training/sessions/:sessionId/paper: people who signed the paper sheet. */
export async function recordPaperAttendance(caller: CommandCaller, sessionId: string, body: { readonly employeeIds: readonly string[] }, idempotencyKey?: string) {
  const { context } = await writableSession(caller, sessionId)
  const people = [...new Set(body.employeeIds)]
  if (people.length !== body.employeeIds.length) throw bodyIssue('employeeIds', 'A person is on the list twice.')
  const { result } = await command(caller, { name: 'safety.recordPaperAttendance', idempotencyKey, input: { sessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockSession(tx, tools.context.tenantId, sessionId)
    assertOpen(row)
    const ids: string[] = []
    for (const [index, employeeId] of people.entries()) {
      const person = isUuid(employeeId) ? await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true, status: true } }) : null
      if (!person) throw new NotFoundError('Employee not found.')
      if (person.companyId !== row.companyId) refuse('PERSON_OTHER_COMPANY', RECORDS_REFUSALS.PERSON_OTHER_COMPANY, `employeeIds/${index}`)
      if (person.status !== 'ACTIVE') refuse('PERSON_NOT_ACTIVE', RECORDS_REFUSALS.PERSON_NOT_ACTIVE, `employeeIds/${index}`)
      const key = `attendance:${row.id}:${person.id}`
      if (await tx.trainingAttendance.findUnique({ where: { tenantId_key: { tenantId: tools.context.tenantId, key } }, select: { id: true } })) refuse('ATTENDED_ALREADY', RECORDS_REFUSALS.ATTENDED_ALREADY, `employeeIds/${index}`)
      const id = newId()
      await tx.trainingAttendance.create({ data: { id, siteId: row.siteId, sessionId: row.id, employeeId: person.id, key, method: 'PAPER', signedAt: now, createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
      ids.push(id)
    }
    tools.audit({ action: 'safety.recordPaperAttendance', recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { attendanceIds: ids, employeeIds: people, method: 'PAPER' } })
    const counts = await signedCounts(tx, row.id)
    tools.emit({ type: 'training_attendance.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { sessionId: row.id, attendanceIds: ids, change: 'PAPER', via: 'OFFICE', ...counts } })
    const attendances = await tx.trainingAttendance.findMany({ where: { id: { in: ids } }, orderBy: [{ signedAt: 'asc' }, { id: 'asc' }], select: ATTENDANCE_SELECT })
    return { attendances: await attendanceViews(tx, attendances, row.language), scan: { recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId } }
  })
  return result
}

export interface CountersignBody {
  readonly method: 'PAPER' | 'OFFICE'
  readonly attendances: readonly { readonly attendanceId: string; readonly languageUnderstood: boolean }[]
}

/** The attendances a countersignature names: of the session, signed, not voided, not countersigned yet (409 in words). */
export async function countersignable(tx: CommandTx, sessionId: string, wanted: readonly { readonly attendanceId: string }[], prefix = 'attendances') {
  const seen = new Set<string>()
  const rows = []
  for (const [index, entry] of wanted.entries()) {
    if (seen.has(entry.attendanceId)) throw bodyIssue(`${prefix}/${index}/attendanceId`, 'An attendance is on the list twice.')
    seen.add(entry.attendanceId)
    const row = isUuid(entry.attendanceId) ? await tx.trainingAttendance.findUnique({ where: { id: entry.attendanceId }, select: { id: true, sessionId: true, employeeId: true, countersignedAt: true, voidedAt: true } }) : null
    if (!row || row.sessionId !== sessionId) refuse('NOT_OF_SESSION', RECORDS_REFUSALS.NOT_OF_SESSION, `${prefix}/${index}/attendanceId`)
    if (row!.voidedAt) refuse('ATTENDANCE_VOIDED', RECORDS_REFUSALS.ATTENDANCE_VOIDED, `${prefix}/${index}/attendanceId`)
    if (row!.countersignedAt) refuse('COUNTERSIGNED_ALREADY', RECORDS_REFUSALS.COUNTERSIGNED_ALREADY, `${prefix}/${index}/attendanceId`)
    rows.push(row!)
  }
  return rows
}

/** POST /safety/training/sessions/:sessionId/countersign: the trainer's countersignature recorded in the office. */
export async function countersignInOffice(caller: CommandCaller, sessionId: string, body: CountersignBody, idempotencyKey?: string) {
  await writableSession(caller, sessionId)
  const { result } = await command(caller, { name: 'safety.countersignAttendance', idempotencyKey, input: { sessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockSession(tx, tools.context.tenantId, sessionId)
    assertOpen(row)
    await countersignable(tx, row.id, body.attendances)
    for (const entry of body.attendances) {
      await tx.trainingAttendance.update({
        where: { id: entry.attendanceId },
        data: { countersignedAt: now, countersignMethod: body.method, countersignedById: actorIdOf(tools.context), languageUnderstood: entry.languageUnderstood, version: { increment: 1 }, updatedAt: now },
        select: { id: true },
      })
    }
    const ids = body.attendances.map((entry) => entry.attendanceId)
    tools.audit({ action: 'safety.countersignAttendance', recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { method: body.method, attendances: body.attendances.map((entry) => ({ attendanceId: entry.attendanceId, languageUnderstood: entry.languageUnderstood })) } })
    const counts = await signedCounts(tx, row.id)
    tools.emit({ type: 'training_attendance.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { sessionId: row.id, attendanceIds: ids, change: 'COUNTERSIGNED', via: 'OFFICE', ...counts } })
    const attendances = await tx.trainingAttendance.findMany({ where: { id: { in: ids } }, orderBy: [{ signedAt: 'asc' }, { id: 'asc' }], select: ATTENDANCE_SELECT })
    return { attendances: await attendanceViews(tx, attendances, row.language) }
  })
  return result
}

/** POST /safety/training/sessions/:sessionId/attendances/:attendanceId/void. */
export async function voidAttendance(caller: CommandCaller, sessionId: string, attendanceId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await writableSession(caller, sessionId)
  const { result } = await command(caller, { name: 'safety.voidAttendance', idempotencyKey, input: { sessionId, attendanceId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockSession(tx, tools.context.tenantId, sessionId)
    assertOpen(row)
    const attendance = isUuid(attendanceId) ? await tx.trainingAttendance.findUnique({ where: { id: attendanceId }, select: { id: true, sessionId: true, version: true, voidedAt: true, employeeId: true } }) : null
    if (!attendance || attendance.sessionId !== row.id) throw new NotFoundError('Attendance not found.')
    assertVersion('attendance', attendance.version, body.version)
    if (attendance.voidedAt) refuse('ATTENDANCE_VOIDED', RECORDS_REFUSALS.ATTENDANCE_VOIDED)
    const reason = body.reason.trim()
    await tx.trainingAttendance.update({ where: { id: attendance.id }, data: { voidedAt: now, voidedById: actorIdOf(tools.context), voidReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.voidAttendance', recordType: RECORD_ATTENDANCE, recordId: attendance.id, companyId: row.companyId, siteId: row.siteId, before: { voided: false }, after: { voided: true, employeeId: attendance.employeeId }, reason })
    const counts = await signedCounts(tx, row.id)
    tools.emit({ type: 'training_attendance.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { sessionId: row.id, attendanceIds: [attendance.id], change: 'VOIDED', via: 'OFFICE', ...counts } })
    const [view] = await attendanceViews(tx, [(await tx.trainingAttendance.findUnique({ where: { id: attendance.id }, select: ATTENDANCE_SELECT }))!], row.language)
    return { attendance: view! }
  })
  return result
}

// ---- close and cancel ---------------------------------------------------------------------------------------------------------

/** POST /safety/training/sessions/:sessionId/close. */
export async function closeSession(caller: CommandCaller, sessionId: string, body: { readonly version: number; readonly results?: readonly CloseDecision[] | undefined }, idempotencyKey?: string) {
  const { context } = await writableSession(caller, sessionId)
  const { result } = await command(caller, { name: 'safety.closeTrainingSession', idempotencyKey, input: { sessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockSession(tx, tools.context.tenantId, sessionId)
    assertVersion('session', row.version, body.version)
    assertOpen(row)
    const today = todayOf(now)
    if (dayOf(row.heldOn) > today) refuse('SESSION_NOT_HELD', RECORDS_REFUSALS.SESSION_NOT_HELD)
    const attendances = await tx.trainingAttendance.findMany({ where: { sessionId: row.id }, orderBy: [{ signedAt: 'asc' }, { id: 'asc' }], select: { id: true, employeeId: true, countersignedAt: true, voidedAt: true, languageUnderstood: true } })
    const plan = closePlan(
      attendances.map((attendance) => ({ id: attendance.id, employeeId: attendance.employeeId, countersigned: attendance.countersignedAt !== null, voided: attendance.voidedAt !== null, languageUnderstood: attendance.languageUnderstood })),
      body.results ?? [],
    )
    if (!plan.ok) refuse(plan.refusal, RECORDS_REFUSALS[plan.refusal], plan.refusal === 'NO_ATTENDANCE' ? undefined : 'results', plan.attendanceIds.map((id) => ({ path: `attendance/${id}`, message: RECORDS_REFUSALS[plan.refusal] })))
    const records = plan.ok ? plan.records : []
    const completedOn = dayOf(row.heldOn)
    const validUntil = expectedValidUntil(completedOn, row.course.refresherMonths)
    const ids = records.map(() => newId())
    for (const [index, record] of records.entries()) {
      await tx.trainingRecord.create({
        data: {
          id: ids[index]!,
          companyId: row.companyId,
          employeeId: record.employeeId,
          courseId: row.courseId,
          sessionId: row.id,
          attendanceId: record.attendanceId,
          completedOn: row.heldOn,
          hours: row.hours,
          trainerName: row.trainerName,
          result: record.result,
          validUntil: record.result === 'PASSED' && validUntil ? dateOf(validUntil) : null,
          language: row.language,
          languageChecked: record.languageChecked,
          note: record.note,
          createdAt: now,
          createdById: actorIdOf(tools.context),
        },
        select: { id: true },
      })
    }
    await tx.trainingSession.update({ where: { id: row.id }, data: { status: 'CLOSED', closedAt: now, closedById: actorIdOf(tools.context), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readSession(tx, row.id))!
    tools.audit({
      action: 'safety.closeTrainingSession',
      recordType: RECORD_SESSION,
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: row.status },
      after: { status: 'CLOSED', records: records.map((record, index) => ({ recordId: ids[index], employeeId: record.employeeId, attendanceId: record.attendanceId, result: record.result, languageChecked: record.languageChecked })) },
    })
    for (const [index, record] of records.entries())
      tools.audit({ action: 'safety.recordTraining', recordType: RECORD_TRAINING, recordId: ids[index]!, companyId: row.companyId, siteId: row.siteId, after: { employeeId: record.employeeId, courseId: row.courseId, sessionId: row.id, attendanceId: record.attendanceId, completedOn, result: record.result, validUntil: record.result === 'PASSED' ? validUntil : null, languageChecked: record.languageChecked } })
    emitSession(tools, after, 'CLOSED', records.length)
    tools.emit({ type: 'training.recorded', subject: row.courseId, companyId: row.companyId, siteId: row.siteId, payload: { courseId: row.courseId, recordIds: ids, employeeIds: [...new Set(records.map((record) => record.employeeId))], way: 'SESSION', sessionId: row.id, correctsId: null } })
    return {
      session: sessionView(context, after, (await sessionCounts(tx, [row.id])).get(row.id)),
      records: records.map((record, index) => ({ id: ids[index]!, employeeId: record.employeeId, attendanceId: record.attendanceId, result: record.result, validUntil: record.result === 'PASSED' ? validUntil : null, languageChecked: record.languageChecked })),
    }
  })
  return result
}

/** POST /safety/training/sessions/:sessionId/cancel. */
export async function cancelSession(caller: CommandCaller, sessionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context } = await writableSession(caller, sessionId)
  const { result } = await command(caller, { name: 'safety.cancelTrainingSession', idempotencyKey, input: { sessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockSession(tx, tools.context.tenantId, sessionId)
    assertVersion('session', row.version, body.version)
    assertOpen(row)
    if ((await tx.trainingRecord.count({ where: { sessionId: row.id } })) > 0) refuse('HAS_RECORDS', RECORDS_REFUSALS.HAS_RECORDS)
    const reason = body.reason.trim()
    await tx.trainingSession.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readSession(tx, row.id))!
    tools.audit({ action: 'safety.cancelTrainingSession', recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'CANCELLED' }, reason })
    emitSession(tools, after, 'CANCELLED')
    return { session: sessionView(context, after, (await sessionCounts(tx, [row.id])).get(row.id)) }
  })
  return result
}

/** A grant to record somewhere (the screen's "Open a session" / "Record training" buttons). */
export const canRecordAnywhere = (context: OfficeContext): boolean => holds(actorOf(context), SAFETY_TRAINING_RECORD)


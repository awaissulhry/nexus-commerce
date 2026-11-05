import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { trainingRecordDocument } from '@nexus/factory-domain/safety/records/documents'
import { SAFETY_INSTRUCTION_RECORD, SAFETY_TRAINING_RECORD } from '@nexus/factory-domain/safety/records/permissions'
import {
  countDue,
  dueCellsOf,
  expectedValidUntil,
  LANGUAGE_LAW,
  languageOf,
  RECORDS_LAW,
  RECORDS_REFUSALS,
  recordProblems,
  validUntilOf,
  type RecordDraft,
  type RecordResult,
} from '@nexus/factory-domain/safety/records/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { actorIdOf, assertMayAt, assertMayWriteAt, bodyIssue, dateOf, dayOf, dayOrNull, officeOf, problemsError, refuse, todayOf } from '../organisation/access'
import { trainingNeedsOf, trainingPeopleOf } from '../training/needs'
import { courseRefs } from '../training/store'
import { recordFactsOf } from './holdings'
import { availableCourse, filesOf, fullName, INSTRUCTION_SELECT, instructionViews, mayInstruct, mayRecord, readRecord, RECORD_SELECT, RECORD_TRAINING, recordView, type RecordRow } from './store'

/**
 * A person's training records (B-W2b-139; QHS-243, QHS-244, QHS-247; design people.employees "Safety training": "Course · date
 * · hours · trainer or provider · result · certificate (file) · expiry (DueCell) · language checked", "Needed but missing
 * courses from the role sheet, as 'Needed' rows", "Hands-on instruction"; people.skills "Record training": "Course · date ·
 * hours · trainer or provider · people · result · certificate (FileDropzone) · expiry from the refresher period (change needs a
 * reason) · language understood per person"; new tab "Certificate (PDF)"), office only, each write one command:
 *
 *   GET  /safety/training/people/:employeeId          the person's records (newest first, corrections and what they correct
 *                                                     named), one due cell per course they need or hold, their instruction
 *                                                     entries; safety.view over the person
 *   POST /safety/training/records                     record training given elsewhere for up to 100 people (one course, one
 *                                                     day, hours, the trainer or provider, the language; per person the
 *                                                     result, the language check, another valid-until with its reason); the
 *                                                     certificate is then a file of each record (POST /files recordType
 *                                                     TrainingRecord, kind CERTIFICATE)
 *   POST /safety/training/records/:id/correct         a correction: a NEW record naming the one it corrects, with the reason
 *                                                     (records never change): another day, hours, trainer, result, language,
 *                                                     valid-until (with its reason), or VOID when it never happened; a
 *                                                     day set with its reason stays while the day and the pass stay, else
 *                                                     valid-until follows the course's refresher period in force (with only
 *                                                     the reason: B-W2b-133's "correct these records" after a period change)
 *   GET  /safety/training/records/:id/pdf?language    the record as the employer's register keeps it (in memory, not stored)
 */

const RECORD_WORDS = 'Training records are kept by a role that keeps them (safety.training.record).'
const LAW = { training: RECORDS_LAW, language: LANGUAGE_LAW }

/** GET /safety/training/people/:employeeId. */
export async function personTraining(caller: CommandCaller, employeeId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const employee = isUuid(employeeId)
      ? await client.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true, firstName: true, lastName: true, employeeCode: true, locale: true, status: true, roleSheetId: true, startDate: true, roleSheet: { select: { id: true, code: true, name: true } } } })
      : null
    if (!employee) throw new NotFoundError('Employee not found.')
    const place = { companyId: employee.companyId, siteId: employee.siteId }
    assertMayAt(context, SAFETY_VIEW, place, 'Employee')
    const people = await trainingPeopleOf(client, { id: employee.id })
    const { needs } = await trainingNeedsOf(client, people, today)
    const facts = await recordFactsOf(client, [employee.id])
    const cells = dueCellsOf({ needs, records: facts, today })
    const rows = (await client.trainingRecord.findMany({ where: { employeeId: employee.id }, orderBy: [{ completedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: 500, select: RECORD_SELECT })) as RecordRow[]
    const certificates = await filesOf(
      client,
      RECORD_TRAINING,
      rows.map((row) => row.id),
    )
    const instruction = await client.instructionRecord.findMany({ where: { employeeId: employee.id }, orderBy: [{ instructedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: 200, select: INSTRUCTION_SELECT })
    const courses = await courseRefs(client, [...cells.map((cell) => cell.courseId), ...rows.map((row) => row.courseId)])
    return {
      employee: { id: employee.id, name: fullName(employee), code: employee.employeeCode, companyId: employee.companyId, siteId: employee.siteId, language: employee.locale.slice(0, 2).toLowerCase(), status: employee.status as 'ACTIVE' | 'LEFT', roleSheet: employee.roleSheet },
      cells: cells.map(({ employeeId: _employeeId, ...cell }) => cell),
      counts: countDue(cells),
      records: rows.map((row) => recordView(row, today, certificates.get(row.id) ?? [])),
      instruction: await instructionViews(client, context, instruction),
      courses,
      canRecord: mayRecord(context, place),
      canInstruct: mayInstruct(context, place),
      certificate: { recordType: RECORD_TRAINING, kind: 'CERTIFICATE' as const, companyId: employee.companyId },
      law: LAW,
      today,
    }
  })
}

// ---- record training given elsewhere -----------------------------------------------------------------------------------------

export interface RecordPerson {
  readonly employeeId: string
  readonly result: 'PASSED' | 'FAILED'
  /** The trainer checked the person understood the language (art. 37 c.13). */
  readonly languageChecked: boolean
  /** Another day than the course's refresher period gives (with its reason); left out: the period's. */
  readonly validUntil?: BusinessDate | null | undefined
  readonly validUntilReason?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface RecordBody {
  readonly courseId: string
  readonly completedOn: BusinessDate
  readonly hours: string
  readonly trainerName: string
  readonly language: string
  readonly people: readonly RecordPerson[]
}

const clean = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

/** POST /safety/training/records. */
export async function recordTraining(caller: CommandCaller, body: RecordBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const seen = new Set<string>()
  body.people.forEach((person, index) => {
    if (seen.has(person.employeeId)) throw bodyIssue(`people/${index}/employeeId`, 'A person is on the list twice.')
    seen.add(person.employeeId)
  })
  const { result, replayed } = await command(caller, { name: 'safety.recordTraining', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    const people = []
    for (const [index, entry] of body.people.entries()) {
      const person = isUuid(entry.employeeId) ? await tx.employee.findUnique({ where: { id: entry.employeeId }, select: { id: true, companyId: true, siteId: true } }) : null
      if (!person) throw new NotFoundError('Employee not found.')
      assertMayAt(context, SAFETY_VIEW, person, 'Employee')
      assertMayWriteAt(context, SAFETY_TRAINING_RECORD, person, RECORD_WORDS)
      people.push({ index, entry, person })
    }
    const companies = [...new Set(people.map((row) => row.person.companyId))]
    if (companies.length > 1) throw bodyIssue('people', 'One course is recorded for the people of one company at a time.')
    const course = await availableCourse(tx, body.courseId, companies[0]!)
    const problems = people.flatMap(({ index, entry }) =>
      recordProblems(
        { completedOn: body.completedOn, hours: body.hours, trainerName: body.trainerName, language: body.language, result: entry.result, validUntil: entry.validUntil, validUntilReason: entry.validUntilReason, note: entry.note },
        course.refresherMonths,
        today,
      ).map((problem) => (['completedOn', 'hours', 'trainerName', 'language'].includes(problem.path) ? problem : { ...problem, path: `people/${index}/${problem.path}` })),
    )
    const unique = [...new Map(problems.map((problem) => [`${problem.path}|${problem.message}`, problem])).values()]
    if (unique.length > 0) throw problemsError(unique, 'The training to record is not complete.')
    const ids = people.map(() => newId())
    for (const [n, { entry, person }] of people.entries()) {
      const validUntil = validUntilOf({ completedOn: body.completedOn, result: entry.result, validUntil: entry.validUntil }, course.refresherMonths)
      await tx.trainingRecord.create({
        data: {
          id: ids[n]!,
          companyId: person.companyId,
          employeeId: person.id,
          courseId: course.id,
          completedOn: dateOf(body.completedOn),
          hours: body.hours,
          trainerName: body.trainerName.trim(),
          result: entry.result,
          validUntil: validUntil ? dateOf(validUntil) : null,
          validUntilReason: entry.result === 'PASSED' && entry.validUntil !== undefined ? clean(entry.validUntilReason) : null,
          language: languageOf(body.language),
          languageChecked: entry.languageChecked,
          note: clean(entry.note),
          createdAt: now,
          createdById: actorIdOf(tools.context),
        },
        select: { id: true },
      })
      tools.audit({
        action: 'safety.recordTraining',
        recordType: RECORD_TRAINING,
        recordId: ids[n]!,
        companyId: person.companyId,
        siteId: person.siteId,
        after: { employeeId: person.id, courseId: course.id, completedOn: body.completedOn, hours: body.hours, result: entry.result, validUntil, languageChecked: entry.languageChecked, way: 'OFFICE' },
      })
    }
    tools.emit({ type: 'training.recorded', subject: course.id, companyId: companies[0]!, payload: { courseId: course.id, recordIds: ids, employeeIds: people.map((row) => row.person.id), way: 'OFFICE', sessionId: null, correctsId: null } })
    const rows = (await tx.trainingRecord.findMany({ where: { id: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: RECORD_SELECT })) as RecordRow[]
    return { records: rows.map((row) => recordView(row, today)), certificate: { recordType: RECORD_TRAINING, kind: 'CERTIFICATE' as const, companyId: companies[0]!, recordIds: ids } }
  })
  return { ...result, replayed }
}

// ---- corrections ------------------------------------------------------------------------------------------------------------

export interface CorrectBody {
  readonly reason: string
  readonly result?: RecordResult | undefined
  readonly completedOn?: BusinessDate | undefined
  readonly hours?: string | undefined
  readonly trainerName?: string | undefined
  readonly language?: string | undefined
  readonly languageChecked?: boolean | undefined
  readonly validUntil?: BusinessDate | null | undefined
  readonly validUntilReason?: string | null | undefined
  readonly note?: string | null | undefined
}

async function readableRecord(client: FactoryClient | CommandTx, context: OfficeContext, recordId: string): Promise<RecordRow> {
  const row = await readRecord(client, recordId)
  if (!row) throw new NotFoundError('Training record not found.')
  assertMayAt(context, SAFETY_VIEW, { companyId: row.companyId, siteId: row.employee.siteId }, 'Training record')
  return row
}

/** POST /safety/training/records/:recordId/correct. */
export async function correctRecord(caller: CommandCaller, recordId: string, body: CorrectBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const read = await caller.withClient((client) => readableRecord(client, context, recordId))
  assertMayWriteAt(context, SAFETY_TRAINING_RECORD, { companyId: read.companyId, siteId: read.employee.siteId }, RECORD_WORDS)
  const { result } = await command(caller, { name: 'safety.correctTrainingRecord', idempotencyKey, input: { recordId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    // One correction at a time per record: the person's row is the lock (records themselves are never updated).
    await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${read.employeeId}::uuid FOR UPDATE`
    const row = (await readRecord(tx, recordId))!
    if (row.corrections.length > 0) refuse('CORRECTED_ALREADY', RECORDS_REFUSALS.CORRECTED_ALREADY)
    const resultNow: RecordResult = body.result ?? (row.result as RecordResult)
    const completedOn = body.completedOn ?? dayOf(row.completedOn)
    // A day set apart from the refresher period (with its reason) stays while the correction keeps the day and the pass; left
    // out otherwise, the day follows the course's period in force (a period changed since moves it: B-W2b-133's "correct
    // these records").
    const ownDay = row.result === 'PASSED' && resultNow === 'PASSED' && row.validUntilReason !== null && completedOn === dayOf(row.completedOn) ? dayOrNull(row.validUntil) : undefined
    const keepsOwnDay = body.validUntil === undefined && ownDay !== undefined && ownDay !== expectedValidUntil(completedOn, row.course.refresherMonths)
    const draft: RecordDraft = {
      completedOn,
      hours: resultNow === 'VOID' ? (body.hours ?? '0') : (body.hours ?? row.hours.toString()),
      trainerName: body.trainerName ?? row.trainerName,
      language: body.language ?? row.language,
      result: resultNow,
      validUntil: keepsOwnDay ? ownDay : body.validUntil,
      validUntilReason: keepsOwnDay ? row.validUntilReason : body.validUntilReason,
      note: body.note !== undefined ? body.note : row.note,
    }
    const problems = recordProblems(draft, row.course.refresherMonths, today)
    if (problems.length > 0) throw problemsError(problems, 'The correction is not valid.')
    const validUntil = validUntilOf(draft, row.course.refresherMonths)
    const validUntilReason = resultNow === 'PASSED' && draft.validUntil !== undefined ? clean(draft.validUntilReason) : null
    const languageChecked = body.languageChecked ?? row.languageChecked
    const same =
      resultNow === row.result &&
      draft.completedOn === dayOf(row.completedOn) &&
      Number(draft.hours) === Number(row.hours.toString()) &&
      draft.trainerName.trim() === row.trainerName &&
      languageOf(draft.language) === row.language &&
      languageChecked === row.languageChecked &&
      validUntil === (row.validUntil ? dayOf(row.validUntil) : null) &&
      validUntilReason === row.validUntilReason &&
      (clean(draft.note) ?? null) === (row.note ?? null)
    if (same) refuse('NOTHING_CHANGES', RECORDS_REFUSALS.NOTHING_CHANGES)
    const id = newId()
    await tx.trainingRecord.create({
      data: {
        id,
        companyId: row.companyId,
        employeeId: row.employeeId,
        courseId: row.courseId,
        sessionId: row.sessionId,
        attendanceId: row.attendanceId,
        completedOn: dateOf(draft.completedOn),
        hours: draft.hours,
        trainerName: draft.trainerName.trim(),
        result: resultNow,
        validUntil: validUntil ? dateOf(validUntil) : null,
        validUntilReason,
        language: languageOf(draft.language),
        languageChecked,
        correctsId: row.id,
        correctionReason: body.reason.trim(),
        note: clean(draft.note),
        createdAt: now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    tools.audit({
      action: 'safety.correctTrainingRecord',
      recordType: RECORD_TRAINING,
      recordId: id,
      companyId: row.companyId,
      siteId: row.employee.siteId,
      before: { recordId: row.id, completedOn: dayOf(row.completedOn), hours: row.hours.toString(), result: row.result, validUntil: row.validUntil ? dayOf(row.validUntil) : null, languageChecked: row.languageChecked },
      after: { corrects: row.id, completedOn: draft.completedOn, hours: draft.hours, result: resultNow, validUntil, languageChecked },
      reason: body.reason.trim(),
    })
    tools.emit({ type: 'training.recorded', subject: row.courseId, companyId: row.companyId, siteId: row.employee.siteId, payload: { courseId: row.courseId, recordIds: [id], employeeIds: [row.employeeId], way: 'CORRECTION', sessionId: row.sessionId, correctsId: row.id } })
    return { record: recordView((await readRecord(tx, id))!, today), corrected: recordView((await readRecord(tx, row.id))!, today) }
  })
  return result
}

// ---- the record's PDF ---------------------------------------------------------------------------------------------------------

/** GET /safety/training/records/:recordId/pdf?language=. */
export async function recordPdf(caller: CommandCaller, recordId: string, language: DocumentLanguage = 'it'): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readableRecord(client, context, recordId))
  const composed = trainingRecordDocument({
    language,
    company: await companyLegalOf(caller, row.companyId),
    person: { name: fullName(row.employee), code: row.employee.employeeCode },
    course: { code: row.course.code, name: row.course.name, legalBasis: row.course.legalBasis },
    record: {
      id: row.id,
      completedOn: dayOf(row.completedOn),
      hours: row.hours.toString(),
      trainerName: row.trainerName,
      result: row.result as RecordResult,
      validUntil: row.validUntil ? dayOf(row.validUntil) : null,
      validUntilReason: row.validUntilReason,
      language: row.language,
      languageChecked: row.languageChecked,
      corrects: row.correctsId !== null,
      correctionReason: row.correctionReason,
      corrected: row.corrections.length > 0,
      createdAt: row.createdAt.toISOString(),
    },
    attendance: row.attendance && row.session ? { method: row.attendance.method as 'FLOOR_PIN' | 'PAPER' | 'OFFICE', countersignMethod: (row.attendance.countersignMethod as 'FLOOR_PIN' | 'PAPER' | 'OFFICE' | null) ?? null, heldOn: dayOf(row.session.heldOn), location: row.session.location } : null,
  })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}

/** A grant to record or instruct somewhere (the screens' buttons). */
export const recordRights = (context: OfficeContext) => ({ canRecord: holds(actorOf(context), SAFETY_TRAINING_RECORD), canInstruct: holds(actorOf(context), SAFETY_INSTRUCTION_RECORD) })


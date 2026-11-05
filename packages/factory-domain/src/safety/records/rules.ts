import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { addDays, addMonths } from '../calendar/rules'
import { holdingKey } from '../rolesheets/rules'
import { HOURS, type PersonNeed } from '../training/rules'

/**
 * The training records, their due lists, the hands-on instruction register and the attendance signed on the floor (B-W2b-139;
 * QHS-243 "Training records per person", QHS-244 "Due and overdue training", QHS-246 "Hands-on instruction register", QHS-247
 * "Language check", QHS-248 "Attendance sign-off on the floor"; design people.skills "Record training", "Instruction
 * register", the tiles and the matrix's safety columns, people.employees "Safety training", floor.training "Training
 * attendance"; D.Lgs. 81/2008 art. 37), pure. The tables are factory-db safety.prisma's TrainingSession (opened in the office;
 * OPEN while the workers sign; CLOSED or CANCELLED, both final), TrainingAttendance (the person's own badge and PIN on the
 * floor, or the paper sheet the office records; countersigned once by the trainer with the language check), TrainingRecord
 * (append-only: a mistake is a correction, a new record naming the one it corrects; VOID when it never happened) and
 * InstructionRecord (written in the office, signed once by the person on the floor or on paper, voided, never deleted).
 *
 * Nothing here holds a number of the law: a record is valid until its day plus the course's refresher period (a setting the
 * company typed in the catalogue, B-W2b-133); another day only with its reason. The only window is the design's own "Due in
 * 60 days" tile (a screen's choice, not a legal interval).
 *
 * Who needs which course is B-W2b-133's (training/rules `needsOf`, read by the API's needs.ts): a person needs a course their
 * role sheet asks or a type of machine they are authorised on asks. A course is overdue while it is needed, not held today,
 * and the requirement's own due day has passed; a record's validity (valid until, due soon, expired since) is this file's.
 */

export const RECORDS_LAW = 'D.Lgs. 81/2008 art. 37'
/** Training is given in a language the person understands; the trainer checks it. */
export const LANGUAGE_LAW = 'D.Lgs. 81/2008 art. 37 c.13'
/** Hands-on instruction (addestramento) at the workstation, recorded. */
export const INSTRUCTION_LAW = 'D.Lgs. 81/2008 art. 37 c.5'
/** A machine that asks particular knowledge is used only by people trained for it: expired training holds its authorisation. */
export const MACHINE_LAW = 'D.Lgs. 81/2008 art. 71 c.7'

export const RECORD_LIMITS = Object.freeze({
  /** The database's bounds: a session lasts above 0 and at most 24 hours, a record at most 200, an entry 1 to 1440 minutes. */
  sessionHours: 24,
  recordHours: 200,
  minutes: 1440,
  /** People one "Record training" writes, attendances one countersignature names. */
  people: 100,
  attendances: 100,
  trainerName: 160,
  location: 160,
  task: 300,
  reason: 500,
  note: 1000,
  list: 500,
  /** The design's tile "Due in 60 days" (people.skills): a screen's window, not the law's. */
  soonDays: 60,
})

/** A language as the records keep it: ISO 639-1, two lower-case letters (the database refuses anything else). */
export const LANGUAGE = /^[a-z]{2}$/
export const languageOf = (value: string): string => value.trim().toLowerCase()

export const SESSION_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]
export const RECORD_RESULTS = ['PASSED', 'FAILED', 'VOID'] as const
export type RecordResult = (typeof RECORD_RESULTS)[number]
export const SIGN_METHODS = ['OFFICE', 'FLOOR_PIN', 'PAPER'] as const
export type SignMethod = (typeof SIGN_METHODS)[number]

export const RECORDS_REFUSALS = {
  COURSE_NOT_AVAILABLE: 'The course is archived or of another company: pick an active course of the whole group or of this company.',
  TRAINER_NOT_AVAILABLE: 'The trainer is not a person who works for this company (active).',
  SESSION_STOPPED: 'This session is closed or cancelled: signing has stopped.',
  SESSION_NOT_HELD: 'The session is held on a later day: it is closed once it was held.',
  SIGNED_ALREADY: 'People signed this session already: its day, hours, language and trainer stay as they signed them.',
  NOT_COUNTERSIGNED: 'Some attendances wait for the trainer’s countersignature: countersign or void them first.',
  NO_ATTENDANCE: 'Nobody’s attendance is countersigned: cancel the session instead.',
  HAS_RECORDS: 'Training records came from this session: it is closed, not cancelled.',
  ATTENDED_ALREADY: 'This person signed this session already.',
  PERSON_NOT_ACTIVE: 'The person does not work for the company any more.',
  PERSON_OTHER_COMPANY: 'The person works for another company than the session’s.',
  NO_EMPLOYEE: 'This worker has no employee record: the office links one before they sign.',
  NOT_THE_TRAINER: 'Only the session’s trainer countersigns, with their own badge and PIN.',
  NO_TRAINER_WORKER: 'The trainer is not a person of the company with a floor sign-in: the office countersigns from the paper sheet.',
  COUNTERSIGNED_ALREADY: 'This attendance is countersigned already.',
  ATTENDANCE_VOIDED: 'This attendance was voided.',
  NOT_OF_SESSION: 'This attendance is not of this session.',
  LANGUAGE_NOT_UNDERSTOOD: 'The trainer found this person did not understand the session’s language: their training is not passed (art. 37 c.13).',
  CORRECTED_ALREADY: 'This record was corrected already: correct the newest one.',
  NOTHING_CHANGES: 'The correction says what the record says: nothing to correct.',
  IN_FUTURE: 'The day is later than today.',
  INSTRUCTOR_IS_PERSON: 'The instructor is not the person instructed.',
  MACHINE_NOT_OF_CLASS: 'The machine is not of the type of machine named.',
  ENTRY_SIGNED: 'This entry is signed already: it is only voided now.',
  ENTRY_VOIDED: 'This entry was voided.',
} as const
export type RecordsRefusalCode = keyof typeof RECORDS_REFUSALS
export const RECORDS_REFUSAL_CODES = Object.keys(RECORDS_REFUSALS) as RecordsRefusalCode[]

// ---- validity -------------------------------------------------------------------------------------------------------------

/** The day a PASSED record is valid until: its day plus the course's refresher period (none: no expiry). */
export const expectedValidUntil = (completedOn: BusinessDate, refresherMonths: number | null): BusinessDate | null => (refresherMonths === null ? null : addMonths(completedOn, refresherMonths))

export const VALIDITY_STATES = ['VALID', 'DUE_SOON', 'EXPIRED'] as const
export type ValidityState = (typeof VALIDITY_STATES)[number]

/** A PASSED record's validity today: VALID, DUE_SOON (valid until within the window), EXPIRED (valid until passed). */
export function validityOf(validUntil: BusinessDate | null, today: BusinessDate, soonDays: number = RECORD_LIMITS.soonDays): ValidityState {
  if (validUntil === null) return 'VALID'
  if (validUntil < today) return 'EXPIRED'
  return validUntil <= addDays(today, soonDays) ? 'DUE_SOON' : 'VALID'
}

export interface RecordFacts {
  readonly id: string
  readonly employeeId: string
  readonly courseId: string
  readonly completedOn: BusinessDate
  readonly result: RecordResult
  readonly validUntil: BusinessDate | null
  readonly languageChecked: boolean
  readonly correctsId: string | null
  /** ISO instant: the order of two records of one day. */
  readonly createdAt: string
}

const newestFirst = (a: RecordFacts, b: RecordFacts): number => b.completedOn.localeCompare(a.completedOn) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)

/** The records that stand: no correction names them (a correction replaces the record; a VOID one removes it), not VOID. */
export function standingOf(records: readonly RecordFacts[]): RecordFacts[] {
  const corrected = new Set(records.filter((record) => record.correctsId !== null).map((record) => record.correctsId!))
  return records.filter((record) => !corrected.has(record.id) && record.result !== 'VOID').sort(newestFirst)
}

/** Per person × course (`holdingKey`): the newest standing PASSED record and the newest standing record of any result. */
export function latestOf(records: readonly RecordFacts[]): Map<string, { passed: RecordFacts | null; last: RecordFacts }> {
  const answer = new Map<string, { passed: RecordFacts | null; last: RecordFacts }>()
  for (const record of standingOf(records)) {
    const key = holdingKey(record.employeeId, record.courseId)
    const entry = answer.get(key)
    if (!entry) answer.set(key, { passed: record.result === 'PASSED' ? record : null, last: record })
    else if (entry.passed === null && record.result === 'PASSED') entry.passed = record
  }
  return answer
}

// ---- the due cell (design DueCell: valid until, due, overdue, Needed) -------------------------------------------------------

export const DUE_STATES = ['VALID', 'DUE_SOON', 'EXPIRED', 'NEEDED'] as const
export type DueState = (typeof DUE_STATES)[number]

export interface DueCell {
  readonly employeeId: string
  readonly courseId: string
  /** VALID / DUE_SOON: a PASSED record holds today; EXPIRED: the newest PASSED record lapsed; NEEDED: needed, never passed. */
  readonly state: DueState
  /** Asked by the person's role sheet or a type of machine they are authorised on (B-W2b-133). */
  readonly needed: boolean
  /** Asked by the role sheet: the matrix shades the cell. */
  readonly required: boolean
  /** Valid until (VALID, DUE_SOON; null: no expiry), the day it lapsed after (EXPIRED), the requirement's due day (NEEDED). */
  readonly dueOn: BusinessDate | null
  /** Needed, not held today, and the requirement's due day passed. */
  readonly overdue: boolean
  /** Counts in "Due in 60 days": needed and due (a refresher or a first course) within the window, not overdue. */
  readonly soon: boolean
  /** The requirement's due day when needed (the earliest of its sources). */
  readonly neededBy: BusinessDate | null
  readonly record: { readonly id: string; readonly completedOn: BusinessDate; readonly validUntil: BusinessDate | null; readonly languageChecked: boolean } | null
  /** The newest standing record's result (a FAILED attempt after a lapsed one shows as FAILED). */
  readonly lastResult: 'PASSED' | 'FAILED' | null
  /** A record that holds today whose language was not checked (art. 37 c.13). */
  readonly languageNotChecked: boolean
}

/**
 * The cells of person × course: every need (B-W2b-133's `needsOf`) and every standing PASSED record, with the record's
 * validity and the need's state. A lapsed record nobody needs any more is EXPIRED but neither overdue nor soon (the due list's
 * `all` view shows it; the tiles do not count it).
 */
export function dueCellsOf(input: { readonly needs: readonly PersonNeed[]; readonly records: readonly RecordFacts[]; readonly today: BusinessDate; readonly soonDays?: number }): DueCell[] {
  const soonDays = input.soonDays ?? RECORD_LIMITS.soonDays
  const soonEnd = addDays(input.today, soonDays)
  const latest = latestOf(input.records)
  const needs = new Map(input.needs.map((need) => [holdingKey(need.employeeId, need.courseId), need] as const))
  const keys = new Set([...needs.keys(), ...[...latest.entries()].filter(([, entry]) => entry.passed !== null).map(([key]) => key)])
  const cells: DueCell[] = []
  for (const key of keys) {
    const need = needs.get(key) ?? null
    const entry = latest.get(key) ?? null
    const passed = entry?.passed ?? null
    const [employeeId, courseId] = key.split('|') as [string, string]
    const validity = passed ? validityOf(passed.validUntil, input.today, soonDays) : null
    const state: DueState = validity ?? 'NEEDED'
    const holds = validity === 'VALID' || validity === 'DUE_SOON'
    const overdue = need !== null && need.state === 'OVERDUE' && !holds
    const soon = need !== null && !overdue && (validity === 'DUE_SOON' || (!holds && need.dueOn <= soonEnd))
    cells.push({
      employeeId,
      courseId,
      state,
      needed: need !== null,
      required: need?.sources.some((source) => source.kind === 'ROLE_SHEET') ?? false,
      dueOn: passed ? passed.validUntil : (need?.dueOn ?? null),
      overdue,
      soon,
      neededBy: need?.dueOn ?? null,
      record: passed ? { id: passed.id, completedOn: passed.completedOn, validUntil: passed.validUntil, languageChecked: passed.languageChecked } : null,
      lastResult: entry ? (entry.last.result as 'PASSED' | 'FAILED') : null,
      languageNotChecked: holds && passed !== null && !passed.languageChecked,
    })
  }
  return cells.sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.courseId.localeCompare(b.courseId))
}

export interface DueCounts {
  /** Person × course, needed and overdue. */
  readonly overdue: number
  /** Person × course, needed and due within the window. */
  readonly dueSoon: number
  /** Person × course whose record holds today without the language check. */
  readonly languageNotChecked: number
}

export const countDue = (cells: readonly DueCell[]): DueCounts => ({
  overdue: cells.filter((cell) => cell.overdue).length,
  dueSoon: cells.filter((cell) => cell.soon).length,
  languageNotChecked: cells.filter((cell) => cell.languageNotChecked).length,
})

export const DUE_VIEWS = ['due', 'overdue', 'soon', 'language', 'all'] as const
export type DueView = (typeof DUE_VIEWS)[number]

/** The due list's lens: due = overdue or soon (default); all = every cell (lapsed records nobody needs included). */
export function inView(cell: DueCell, view: DueView): boolean {
  if (view === 'all') return true
  if (view === 'overdue') return cell.overdue
  if (view === 'soon') return cell.soon
  if (view === 'language') return cell.languageNotChecked
  return cell.overdue || cell.soon
}

// ---- machine authorisations held by training ------------------------------------------------------------------------------

/**
 * Which authorisations in force expired or missing training holds (design people.skills "Machines (Authorised / Held / —)",
 * the tile "Machine authorisations with expired training"): a type of machine that asks an authorisation, a course it asks
 * that the person does not hold today, due before starting or with its days passed. Keyed `holdingKey(employee, class)`.
 */
export function heldByTrainingOf(needs: readonly PersonNeed[], requiredClassIds: ReadonlySet<string>): Map<string, string[]> {
  const held = new Map<string, string[]>()
  for (const need of needs) {
    if (need.met) continue
    for (const source of need.sources) {
      if (source.kind !== 'MACHINE_CLASS' || !requiredClassIds.has(source.id)) continue
      if (source.withinDays !== null && source.state !== 'OVERDUE') continue
      const key = holdingKey(need.employeeId, source.id)
      held.set(key, [...(held.get(key) ?? []), need.courseId])
    }
  }
  return held
}

// ---- problems (400s, paths without `body/`) --------------------------------------------------------------------------------

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''
const hoursIn = (hours: string, max: number): boolean => HOURS.test(hours) && Number(hours) > 0 && Number(hours) <= max

export interface SessionDraft {
  readonly heldOn: BusinessDate
  readonly hours: string
  readonly language: string
  readonly trainerName: string | null
  readonly trainerEmployeeId: string | null
  readonly location: string | null
  readonly note: string | null
}

/** What is wrong with a session's fields (the trainer by name or as a person of the company: one of them). */
export function sessionProblems(draft: SessionDraft, prefix = ''): Issue[] {
  const L = RECORD_LIMITS
  const problems: Issue[] = []
  if (!hoursIn(draft.hours, L.sessionHours)) problems.push({ path: `${prefix}hours`, message: `Above 0 and at most ${L.sessionHours} hours, two decimals at most ("4", "1.5").` })
  if (!LANGUAGE.test(languageOf(draft.language))) problems.push({ path: `${prefix}language`, message: 'The language it is given in, as two letters ("it", "en").' })
  if (draft.trainerEmployeeId === null && blank(draft.trainerName)) problems.push({ path: `${prefix}trainerName`, message: 'Name the trainer: a person of the company, or an outside trainer by name.' })
  if ((draft.trainerName?.trim().length ?? 0) > L.trainerName) problems.push({ path: `${prefix}trainerName`, message: `At most ${L.trainerName} characters.` })
  if ((draft.location?.trim().length ?? 0) > L.location) problems.push({ path: `${prefix}location`, message: `At most ${L.location} characters.` })
  if ((draft.note?.trim().length ?? 0) > L.note) problems.push({ path: `${prefix}note`, message: `At most ${L.note} characters.` })
  return problems
}

export interface RecordDraft {
  readonly completedOn: BusinessDate
  readonly hours: string
  readonly trainerName: string
  readonly language: string
  readonly result: RecordResult
  readonly validUntil: BusinessDate | null | undefined
  readonly validUntilReason: string | null | undefined
  readonly note: string | null | undefined
}

/** What is wrong with a record (the course's refresher period decides its valid until; another day only with its reason). */
export function recordProblems(draft: RecordDraft, refresherMonths: number | null, today: BusinessDate, prefix = ''): Issue[] {
  const L = RECORD_LIMITS
  const problems: Issue[] = []
  if (draft.completedOn > today) problems.push({ path: `${prefix}completedOn`, message: 'The day it was completed: today at the latest.' })
  if (draft.result === 'VOID' ? !(draft.hours === '0' || hoursIn(draft.hours, L.recordHours)) : !hoursIn(draft.hours, L.recordHours))
    problems.push({ path: `${prefix}hours`, message: `Above 0 and at most ${L.recordHours} hours, two decimals at most.` })
  if (blank(draft.trainerName) || draft.trainerName.trim().length > L.trainerName) problems.push({ path: `${prefix}trainerName`, message: `The trainer or the provider, at most ${L.trainerName} characters.` })
  if (!LANGUAGE.test(languageOf(draft.language))) problems.push({ path: `${prefix}language`, message: 'The language it was given in, as two letters ("it", "en").' })
  if ((draft.note?.trim().length ?? 0) > L.note) problems.push({ path: `${prefix}note`, message: `At most ${L.note} characters.` })
  if (draft.result !== 'PASSED') {
    if (draft.validUntil) problems.push({ path: `${prefix}validUntil`, message: 'A training not passed is valid for nothing.' })
    if (!blank(draft.validUntilReason)) problems.push({ path: `${prefix}validUntilReason`, message: 'A training not passed is valid for nothing.' })
    return problems
  }
  const expected = expectedValidUntil(draft.completedOn, refresherMonths)
  const given = draft.validUntil === undefined ? expected : draft.validUntil
  if (given !== null && given <= draft.completedOn) problems.push({ path: `${prefix}validUntil`, message: 'Valid until a day after it was completed.' })
  if (given !== expected && blank(draft.validUntilReason))
    problems.push({ path: `${prefix}validUntilReason`, message: `The course's refresher period gives ${expected ?? 'no expiry'}: say why this record is valid until another day.` })
  if (given === expected && !blank(draft.validUntilReason)) problems.push({ path: `${prefix}validUntilReason`, message: 'A reason only when the day is not the one the refresher period gives.' })
  if ((draft.validUntilReason?.trim().length ?? 0) > L.reason) problems.push({ path: `${prefix}validUntilReason`, message: `At most ${L.reason} characters.` })
  return problems
}

/** The valid-until a record keeps: the one given, else the course's period. */
export const validUntilOf = (draft: Pick<RecordDraft, 'completedOn' | 'result' | 'validUntil'>, refresherMonths: number | null): BusinessDate | null =>
  draft.result !== 'PASSED' ? null : draft.validUntil === undefined ? expectedValidUntil(draft.completedOn, refresherMonths) : draft.validUntil

export interface InstructionDraft {
  readonly instructedOn: BusinessDate
  readonly task: string
  readonly minutes: number
  readonly language: string
  readonly instructorName: string | null
  readonly instructorEmployeeId: string | null
  readonly note: string | null
}

export function instructionProblems(draft: InstructionDraft, employeeId: string, today: BusinessDate, prefix = ''): Issue[] {
  const L = RECORD_LIMITS
  const problems: Issue[] = []
  if (draft.instructedOn > today) problems.push({ path: `${prefix}instructedOn`, message: 'The day it was given: today at the latest.' })
  if (blank(draft.task) || draft.task.trim().length > L.task) problems.push({ path: `${prefix}task`, message: `The task in words, at most ${L.task} characters ("change the press die safely").` })
  if (!Number.isInteger(draft.minutes) || draft.minutes < 1 || draft.minutes > L.minutes) problems.push({ path: `${prefix}minutes`, message: `From 1 to ${L.minutes} minutes.` })
  if (!LANGUAGE.test(languageOf(draft.language))) problems.push({ path: `${prefix}language`, message: 'The language it was given in, as two letters ("it", "en").' })
  if (draft.instructorEmployeeId === null && blank(draft.instructorName)) problems.push({ path: `${prefix}instructorName`, message: 'Name the instructor: a person of the company, or by name.' })
  if ((draft.instructorName?.trim().length ?? 0) > L.trainerName) problems.push({ path: `${prefix}instructorName`, message: `At most ${L.trainerName} characters.` })
  if (draft.instructorEmployeeId !== null && draft.instructorEmployeeId === employeeId) problems.push({ path: `${prefix}instructorEmployeeId`, message: RECORDS_REFUSALS.INSTRUCTOR_IS_PERSON })
  if ((draft.note?.trim().length ?? 0) > L.note) problems.push({ path: `${prefix}note`, message: `At most ${L.note} characters.` })
  return problems
}

// ---- closing a session ------------------------------------------------------------------------------------------------------

export interface AttendanceFacts {
  readonly id: string
  readonly employeeId: string
  readonly countersigned: boolean
  readonly voided: boolean
  readonly languageUnderstood: boolean | null
}

export interface CloseDecision {
  readonly attendanceId: string
  readonly result: 'PASSED' | 'FAILED'
  readonly note?: string | null | undefined
}

export const NOT_UNDERSTOOD_NOTE = 'The trainer found the language of the session was not understood (art. 37 c.13): to repeat in a language the person understands.'

export type ClosePlan =
  | { readonly ok: true; readonly records: readonly { readonly attendanceId: string; readonly employeeId: string; readonly result: 'PASSED' | 'FAILED'; readonly languageChecked: boolean; readonly note: string | null }[] }
  | { readonly ok: false; readonly refusal: 'NOT_COUNTERSIGNED' | 'NO_ATTENDANCE' | 'LANGUAGE_NOT_UNDERSTOOD' | 'NOT_OF_SESSION'; readonly attendanceIds: readonly string[] }

/**
 * The records a session's close writes: one per countersigned attendance not voided, PASSED unless the office says FAILED
 * (or the trainer found the language not understood: FAILED with the reason, and never PASSED). Refused while an attendance
 * waits for its countersignature, when nobody's is countersigned, or for a decision naming another session's attendance.
 */
export function closePlan(attendances: readonly AttendanceFacts[], decisions: readonly CloseDecision[]): ClosePlan {
  const live = attendances.filter((attendance) => !attendance.voided)
  const known = new Set(live.map((attendance) => attendance.id))
  const strangers = decisions.filter((decision) => !known.has(decision.attendanceId)).map((decision) => decision.attendanceId)
  if (strangers.length > 0) return { ok: false, refusal: 'NOT_OF_SESSION', attendanceIds: strangers }
  const waiting = live.filter((attendance) => !attendance.countersigned).map((attendance) => attendance.id)
  if (waiting.length > 0) return { ok: false, refusal: 'NOT_COUNTERSIGNED', attendanceIds: waiting }
  if (live.length === 0) return { ok: false, refusal: 'NO_ATTENDANCE', attendanceIds: [] }
  const decided = new Map(decisions.map((decision) => [decision.attendanceId, decision] as const))
  const notUnderstood = live.filter((attendance) => attendance.languageUnderstood === false && decided.get(attendance.id)?.result === 'PASSED').map((attendance) => attendance.id)
  if (notUnderstood.length > 0) return { ok: false, refusal: 'LANGUAGE_NOT_UNDERSTOOD', attendanceIds: notUnderstood }
  return {
    ok: true,
    records: live.map((attendance) => {
      const decision = decided.get(attendance.id)
      const result = attendance.languageUnderstood === false ? 'FAILED' : (decision?.result ?? 'PASSED')
      const note = decision?.note?.trim() || (attendance.languageUnderstood === false ? NOT_UNDERSTOOD_NOTE : null)
      return { attendanceId: attendance.id, employeeId: attendance.employeeId, result, languageChecked: attendance.languageUnderstood !== null, note }
    }),
  }
}

// ---- what a person signs on the floor -------------------------------------------------------------------------------------

export type StatementLanguage = 'it' | 'en'
/** The words a person signs, in their language (Italian or English; another language reads English). */
export const statementLanguageOf = (locale: string | null | undefined): StatementLanguage => ((locale ?? '').toLowerCase().startsWith('it') ? 'it' : 'en')

export const ATTENDANCE_STATEMENT: Readonly<Record<StatementLanguage, string>> = Object.freeze({
  it: 'Ho partecipato a questa sessione di formazione (art. 37 D.Lgs. 81/2008).',
  en: 'I attended this training session (D.Lgs. 81/2008 art. 37).',
})
export const COUNTERSIGN_STATEMENT: Readonly<Record<StatementLanguage, string>> = Object.freeze({
  it: 'Ho tenuto questa sessione e, per ogni persona che controfirmo, ho verificato se ha compreso la lingua in cui è stata tenuta (art. 37 c.13).',
  en: 'I gave this session and, for each person I countersign, checked whether they understood the language it was given in (art. 37 c.13).',
})
export const INSTRUCTION_STATEMENT: Readonly<Record<StatementLanguage, string>> = Object.freeze({
  it: 'Ho ricevuto questo addestramento al posto di lavoro (art. 37 c.5 D.Lgs. 81/2008).',
  en: 'I received this hands-on instruction at the workstation (D.Lgs. 81/2008 art. 37 c.5).',
})

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface SignedAttendance {
  readonly language: StatementLanguage
  readonly sessionId: string
  readonly courseCode: string
  readonly heldOn: BusinessDate
  readonly hours: string
  readonly sessionLanguage: string
  readonly trainerName: string
  readonly employeeId: string
  readonly workerId: string
  readonly deviceId: string
  readonly signedAt: string
}

/** The exact text a person signs for an attendance: its SHA-256 is kept on the row (the course by CODE: a rename never breaks it). */
export const signedAttendanceText = (signed: SignedAttendance): string =>
  [
    ATTENDANCE_STATEMENT[signed.language],
    `session ${signed.sessionId}`,
    `course ${signed.courseCode}`,
    `held on ${signed.heldOn}`,
    `hours ${String(Number(signed.hours))}`,
    `language ${signed.sessionLanguage}`,
    `trainer ${signed.trainerName.trim()}`,
    `person ${signed.employeeId}`,
    `worker ${signed.workerId}`,
    `tablet ${signed.deviceId}`,
    `at ${signed.signedAt}`,
  ].join('\n')

export interface SignedInstruction {
  readonly language: StatementLanguage
  readonly entryId: string
  readonly instructedOn: BusinessDate
  readonly task: string
  readonly machineClassCode: string | null
  readonly machineAsset: string | null
  readonly instructorName: string
  readonly minutes: number
  readonly entryLanguage: string
  readonly employeeId: string
  readonly workerId: string
  readonly deviceId: string
  readonly signedAt: string
}

export const signedInstructionText = (signed: SignedInstruction): string =>
  [
    INSTRUCTION_STATEMENT[signed.language],
    `entry ${signed.entryId}`,
    `on ${signed.instructedOn}`,
    `task ${signed.task.trim()}`,
    ...(signed.machineClassCode ? [`machine type ${signed.machineClassCode}`] : []),
    ...(signed.machineAsset ? [`machine ${signed.machineAsset}`] : []),
    `instructor ${signed.instructorName.trim()}`,
    `minutes ${signed.minutes}`,
    `language ${signed.entryLanguage}`,
    `person ${signed.employeeId}`,
    `worker ${signed.workerId}`,
    `tablet ${signed.deviceId}`,
    `at ${signed.signedAt}`,
  ].join('\n')

/** The tablet's words when a session no longer takes signatures (design floor.training: "signing stops with the reason"). */
export function stoppedWords(status: SessionStatus, cancelReason: string | null): string | null {
  if (status === 'CLOSED') return 'This session was closed in the office: signing has stopped.'
  if (status === 'CANCELLED') return `This session was cancelled${cancelReason ? `: ${cancelReason}` : ''}. Signing has stopped.`
  return null
}

import { addMonths } from '@nexus/factory-domain/safety/calendar/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Course, CourseDraftBody, CourseType, DueCellValue, InstructionBody, InstructionEntry, InstructionView, NewCourseBody, RecordTrainingBody, RequirementLine, Requirements, StandardCourse } from './api'
import { COURSE_CODE, COURSE_TYPES, HOURS, LANGUAGE, LIMITS, RECORDS_REFUSAL_CODES, TRAINING_REFUSALS } from './constants'

/**
 * The pure rules of the training part of People › Skills & training (B-W2b-146; design people.skills sections "Course
 * catalogue", "Who needs what", "Instruction register", pop-ups "Course" and "Record training"): who may do what, the page's
 * lens in the address, a course's draft and what it sends, the standard list's review, a machine type's courses, Record
 * training (one record per person, the expiry from the refresher period, another day only with its reason), an instruction
 * entry, a DueCell's value and the API's refusals as words. A list carries counts, never a figure about one person.
 */

export const TRAINING_NAMESPACES = ['people-training', 'people-skills', 'people', 'lists'] as const

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface TrainingCan {
  /** safety.view: the catalogue, who needs what, the registers, the PDFs. */
  view: boolean
  /** safety.training.manage: the course catalogue and a machine type's courses. */
  manage: boolean
  /** safety.training.record: Record training, closing a session. */
  record: boolean
  /** safety.instruction.record: the instruction register's entries. */
  instruct: boolean
  /** files.upload: the provider's certificate onto a record. */
  upload: boolean
  /** people.view: a name opens the person's record. */
  employees: boolean
  /** people.skills.view: the matrix lens. */
  matrix: boolean
}

export function trainingCan(permissions: readonly string[]): TrainingCan {
  const held = new Set(permissions)
  return {
    view: held.has('safety.view'),
    manage: held.has('safety.training.manage'),
    record: held.has('safety.training.record'),
    instruct: held.has('safety.instruction.record'),
    upload: held.has('files.upload'),
    employees: held.has('people.view'),
    matrix: held.has('people.skills.view'),
  }
}

// ---- the lens in the address ---------------------------------------------------------------------------------------------------

export const LENSES = ['matrix', 'courses', 'needs', 'instruction'] as const
export type Lens = (typeof LENSES)[number]

/** The lenses a person may open: the matrix with people.skills.view, the three registers with safety.view. */
export const lensesFor = (can: Pick<TrainingCan, 'view' | 'matrix'>): Lens[] => LENSES.filter((lens) => (lens === 'matrix' ? can.matrix : can.view))

/** `?view=` of the page: the lens asked when the person may open it, else the first they may. */
export function lensOf(asked: string | null | undefined, can: Pick<TrainingCan, 'view' | 'matrix'>): Lens {
  const open = lensesFor(can)
  return (open as readonly string[]).includes(asked ?? '') ? (asked as Lens) : (open[0] ?? 'matrix')
}

export const COURSE_LIST_STATUSES = ['ACTIVE', 'ARCHIVED', 'all'] as const
export type CourseListStatus = (typeof COURSE_LIST_STATUSES)[number]
export const INSTRUCTION_VIEWS: readonly InstructionView[] = ['all', 'unsigned', 'signed', 'voided']

export interface TrainingAddress {
  lens: Lens
  /** Courses: ACTIVE (default), ARCHIVED, all. */
  status: CourseListStatus
  /** The Course pop-up: a course's id, or `new`. */
  course: string | null
  /** Who needs what: one role (`role:<id>`) or machine type (`class:<id>`) opened. */
  need: string | null
  /** Instruction register: all (default), unsigned, signed, voided. */
  entries: InstructionView
  q: string
}

const oneOf = <T extends string>(values: readonly T[], value: string | null | undefined, fallback: T): T => ((values as readonly string[]).includes(value ?? '') ? (value as T) : fallback)

export function trainingAddressOf(params: URLSearchParams | null, can: Pick<TrainingCan, 'view' | 'matrix'>): TrainingAddress {
  const need = params?.get('need') ?? null
  return {
    lens: lensOf(params?.get('view'), can),
    status: oneOf(COURSE_LIST_STATUSES, params?.get('status'), 'ACTIVE'),
    course: params?.get('course') || null,
    need: need && /^(role|class):[\w-]+$/.test(need) ? need : null,
    entries: oneOf(INSTRUCTION_VIEWS, params?.get('entries'), 'all'),
    q: params?.get('tq')?.slice(0, 80) ?? '',
  }
}

const TRAINING_TERMS = ['view', 'status', 'course', 'need', 'entries', 'tq']

/** The address of a lens state; the matrix's own terms (tile, show, sort, line, team, q) and others are kept. */
export function trainingAddressText(address: TrainingAddress, keep: URLSearchParams | null, defaultLens: Lens): string {
  const terms = new URLSearchParams()
  for (const [name, value] of keep?.entries() ?? []) if (!TRAINING_TERMS.includes(name)) terms.set(name, value)
  if (address.lens !== defaultLens) terms.set('view', address.lens)
  if (address.status !== 'ACTIVE') terms.set('status', address.status)
  if (address.course) terms.set('course', address.course)
  if (address.need) terms.set('need', address.need)
  if (address.entries !== 'all') terms.set('entries', address.entries)
  if (address.q.trim()) terms.set('tq', address.q.trim())
  const text = terms.toString()
  return text ? `?${text}` : ''
}

// ---- words of values -----------------------------------------------------------------------------------------------------------

export const courseName = (course: { name: string; nameI18n: Record<string, string> | null }, locale: string): string => course.nameI18n?.[locale] || course.name

/** "12.5" → "12,5" in Italian; the API's decimal string otherwise. */
export function hoursText(hours: string, locale: string): string {
  const value = Number(hours)
  if (!Number.isFinite(value)) return hours
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }).format(value)
}

/** Hours as typed ("12,5" or "12.5") → the API's "12.5"; null when not a number of hours above 0 and at most `max`. */
export function hoursIn(text: string, max: number = LIMITS.courseHours): string | null {
  const value = text.trim().replace(',', '.')
  if (!HOURS.test(value)) return null
  const number = Number(value)
  if (!(number > 0) || number > max) return null
  return String(number)
}

/** Whole months 1..120 as typed; null: empty (no refresher); undefined: not a valid period. */
export function monthsIn(text: string): number | null | undefined {
  const value = text.trim()
  if (!value) return null
  if (!/^\d{1,3}$/.test(value)) return undefined
  const months = Number(value)
  return months >= 1 && months <= LIMITS.refresherMonths ? months : undefined
}

/** Days 0..365 as typed; null: empty (before starting); undefined: not valid. */
export function daysIn(text: string): number | null | undefined {
  const value = text.trim()
  if (!value) return null
  if (!/^\d{1,3}$/.test(value)) return undefined
  const days = Number(value)
  return days <= LIMITS.withinDays ? days : undefined
}

/** The DS DueCell's value of one person × course: Needed (or overdue past its day), valid until, expired, done (no expiry). */
export function dueValueOf(cell: Pick<DueCellValue, 'state' | 'overdue' | 'neededBy' | 'dueOn' | 'record'>): { due?: string | null; state?: 'needed' | 'done' | null; doneOn?: string | null } {
  if (cell.state === 'NEEDED') return cell.overdue && (cell.neededBy ?? cell.dueOn) ? { due: cell.neededBy ?? cell.dueOn } : { state: 'needed' }
  const until = cell.record?.validUntil ?? null
  if (until) return { due: until }
  return cell.record ? { state: 'done', doneOn: cell.record.completedOn } : { state: 'needed' }
}

/** The course of a cell is asked by the person's role sheet (the design's shaded cell). */
export const isShaded = (cell: Pick<DueCellValue, 'required'>): boolean => cell.required

// ---- a course's draft ---------------------------------------------------------------------------------------------------------

export interface CourseDraft {
  code: string
  type: CourseType
  nameIt: string
  nameEn: string
  hours: string
  refresherMonths: string
  refresherHours: string
  inPersonRequired: boolean
  provider: string
  legalBasis: string
  /** A course of the whole group (null company) or of the company on screen. */
  groupWide: boolean
}

export function emptyCourseDraft(type: CourseType = 'GENERAL', groupWide = false): CourseDraft {
  return { code: '', type, nameIt: '', nameEn: '', hours: '', refresherMonths: '', refresherHours: '', inPersonRequired: false, provider: '', legalBasis: '', groupWide }
}

const typed = (hours: string | null): string => (hours === null ? '' : hours)

export function courseDraftOf(course: Course): CourseDraft {
  return {
    code: course.code,
    type: course.type,
    nameIt: course.nameI18n?.it ?? course.name,
    nameEn: course.nameI18n?.en ?? course.name,
    hours: typed(course.hours),
    refresherMonths: course.refresherMonths === null ? '' : String(course.refresherMonths),
    refresherHours: typed(course.refresherHours),
    inPersonRequired: course.inPersonRequired,
    provider: course.provider ?? '',
    legalBasis: course.legalBasis,
    groupWide: course.companyId === null,
  }
}

/** Why Save (or Add) is held, as a message key; null: it may go. The API checks it all again. */
export function courseHeld(draft: CourseDraft, isNew: boolean): string | null {
  if (isNew) {
    const code = draft.code.trim().toUpperCase()
    if (!code) return 'held.code'
    if (code.length > LIMITS.code || !COURSE_CODE.test(code)) return 'held.codeShape'
  }
  if (!draft.nameIt.trim() && !draft.nameEn.trim()) return 'held.name'
  if (draft.nameIt.length > LIMITS.name || draft.nameEn.length > LIMITS.name) return 'held.nameLong'
  if (!hoursIn(draft.hours)) return 'held.hours'
  if (monthsIn(draft.refresherMonths) === undefined) return 'held.refresher'
  if (draft.refresherHours.trim() && !hoursIn(draft.refresherHours)) return 'held.refresherHours'
  if (draft.provider.length > LIMITS.provider) return 'held.providerLong'
  if (draft.legalBasis.length > LIMITS.legalBasis) return 'held.lawLong'
  return null
}

const namesOf = (draft: CourseDraft): Record<string, string> => Object.fromEntries([['it', draft.nameIt.trim()], ['en', draft.nameEn.trim()]].filter(([, value]) => value))

/** A new course as sent (the type's law when none is typed: the API fills it). */
export function newCourseBody(draft: CourseDraft): NewCourseBody {
  const names = namesOf(draft)
  return {
    code: draft.code.trim().toUpperCase(),
    type: draft.type,
    name: names.it ?? names.en ?? '',
    nameI18n: names,
    hours: hoursIn(draft.hours) ?? draft.hours.trim(),
    refresherMonths: monthsIn(draft.refresherMonths) ?? null,
    refresherHours: draft.refresherHours.trim() ? (hoursIn(draft.refresherHours) ?? draft.refresherHours.trim()) : null,
    inPersonRequired: draft.inPersonRequired,
    provider: draft.provider.trim() || null,
    ...(draft.legalBasis.trim() ? { legalBasis: draft.legalBasis.trim() } : {}),
  }
}

/** Only what changed from the course read: the fields left out stay (the API's preview and save take the same draft). */
export function courseChanges(course: Course, draft: CourseDraft): CourseDraftBody {
  const body: CourseDraftBody = {}
  const names = namesOf(draft)
  const before = course.nameI18n ?? {}
  if ((names.it ?? '') !== (before.it ?? (before.en ? '' : course.name)) || (names.en ?? '') !== (before.en ?? '')) {
    body.name = names.it ?? names.en ?? course.name
    body.nameI18n = names
  }
  const hours = hoursIn(draft.hours)
  if (hours !== null && Number(hours) !== Number(course.hours)) body.hours = hours
  const months = monthsIn(draft.refresherMonths)
  if (months !== undefined && months !== course.refresherMonths) body.refresherMonths = months
  const refresherHours = draft.refresherHours.trim() ? hoursIn(draft.refresherHours) : null
  if ((refresherHours === null ? null : Number(refresherHours)) !== (course.refresherHours === null ? null : Number(course.refresherHours))) body.refresherHours = refresherHours
  if (draft.inPersonRequired !== course.inPersonRequired) body.inPersonRequired = draft.inPersonRequired
  if ((draft.provider.trim() || null) !== course.provider) body.provider = draft.provider.trim() || null
  if (draft.legalBasis.trim() && draft.legalBasis.trim() !== course.legalBasis) body.legalBasis = draft.legalBasis.trim()
  return body
}

export const nothingChanges = (body: CourseDraftBody): boolean => Object.keys(body).length === 0

/** "Archive" is held while a role sheet or a machine type asks the course (the API refuses it: COURSE_REQUIRED). */
export function archiveHeld(course: Pick<Course, 'requiredBy' | 'status' | 'canManage'>): string | null {
  if (!course.canManage) return 'held.manage'
  if (course.status !== 'ACTIVE') return null
  return course.requiredBy.roleSheets + course.requiredBy.machineClasses > 0 ? 'held.archiveAsked' : null
}

// ---- the standard list --------------------------------------------------------------------------------------------------------

export interface StandardRow {
  code: string
  type: CourseType
  nameIt: string
  nameEn: string
  legalBasis: string
  hours: string
  refresherMonths: string
  take: boolean
  /** A course with this code is in the catalogue already: not offered. */
  taken: boolean
}

export const standardRowsOf = (courses: readonly StandardCourse[]): StandardRow[] =>
  courses.map((course) => ({ code: course.code, type: course.type, nameIt: course.nameI18n.it ?? course.name, nameEn: course.nameI18n.en ?? course.name, legalBasis: course.legalBasis, hours: '', refresherMonths: '', take: !course.codeTaken && course.existing.length === 0, taken: course.codeTaken }))

/** Why "Add N courses" is held; null: it may go. Each course taken needs its hours typed (the plan gives no number). */
export function standardHeld(rows: readonly StandardRow[]): string | null {
  const taken = rows.filter((row) => row.take && !row.taken)
  if (taken.length === 0) return 'held.standardNone'
  if (taken.length > LIMITS.standard) return 'held.standardMany'
  if (taken.some((row) => !hoursIn(row.hours))) return 'held.standardHours'
  if (taken.some((row) => monthsIn(row.refresherMonths) === undefined)) return 'held.refresher'
  return null
}

export const standardBody = (rows: readonly StandardRow[]): NewCourseBody[] =>
  rows
    .filter((row) => row.take && !row.taken)
    .map((row) => ({ code: row.code, type: row.type, name: row.nameIt || row.nameEn, nameI18n: { it: row.nameIt, en: row.nameEn }, hours: hoursIn(row.hours) ?? row.hours, refresherMonths: monthsIn(row.refresherMonths) ?? null, legalBasis: row.legalBasis }))

// ---- who needs what -------------------------------------------------------------------------------------------------------------

export interface NeedRow {
  /** `role:<id>` or `class:<id>`: the address of its record. */
  id: string
  kind: 'role' | 'class'
  refId: string
  code: string
  label: string
  /** The role's site; a machine type is the group's. */
  site: string | null
  people: number
  courses: { courseId: string; withinDays: number | null; met: number; due: number; overdue: number; people: number }[]
  met: number
  due: number
  overdue: number
}

const sum = (lines: readonly { met: number; due: number; overdue: number }[], key: 'met' | 'due' | 'overdue') => lines.reduce((total, line) => total + line[key], 0)

/** One row per role sheet, then per type of machine (each with its courses): counts of person × course, never a name. */
export function needRowsOf(answer: Pick<Requirements, 'roleSheets' | 'machineClasses'>, locale: string): NeedRow[] {
  const roles = answer.roleSheets.map((role): NeedRow => ({ id: `role:${role.id}`, kind: 'role', refId: role.id, code: role.code, label: courseName(role, locale), site: role.site.code, people: role.people, courses: role.courses, met: sum(role.courses, 'met'), due: sum(role.courses, 'due'), overdue: sum(role.courses, 'overdue') }))
  const classes = answer.machineClasses.map((entry): NeedRow => ({ id: `class:${entry.id}`, kind: 'class', refId: entry.id, code: entry.code, label: entry.label[locale] ?? entry.label.en ?? entry.code, site: null, people: entry.people, courses: entry.courses, met: sum(entry.courses, 'met'), due: sum(entry.courses, 'due'), overdue: sum(entry.courses, 'overdue') }))
  return [...roles, ...classes]
}

export const needOf = (address: string | null): { kind: 'role' | 'class'; id: string } | null => {
  const match = address ? /^(role|class):(.+)$/.exec(address) : null
  return match ? { kind: match[1] as 'role' | 'class', id: match[2]! } : null
}

/** A machine type's course lines as edited: the course, the days after the authorisation starts (empty: before starting). */
export interface ClassLine {
  courseId: string
  withinDays: string
  note: string
}

export const classLinesOf = (courses: readonly { courseId: string; withinDays: number | null; note: string | null }[]): ClassLine[] => courses.map((line) => ({ courseId: line.courseId, withinDays: line.withinDays === null ? '' : String(line.withinDays), note: line.note ?? '' }))

export function classLinesHeld(lines: readonly ClassLine[]): string | null {
  if (lines.length > LIMITS.requirements) return 'held.linesMany'
  if (lines.some((line) => !line.courseId)) return 'held.lineCourse'
  if (new Set(lines.map((line) => line.courseId)).size !== lines.length) return 'held.lineTwice'
  if (lines.some((line) => daysIn(line.withinDays) === undefined)) return 'held.lineDays'
  return null
}

export const classBody = (lines: readonly ClassLine[]): RequirementLine[] => lines.map((line) => ({ courseId: line.courseId, withinDays: daysIn(line.withinDays) ?? null, note: line.note.trim() || null }))

/** One line of "What this changes" in words: its message key and figures (names follow from `names`). */
export function impactWords(line: { kind: string; people: number; already: number; withinDays: { from: number | null; to: number | null } | null }): { key: string; params: Record<string, number> } {
  const params = { count: line.people, already: line.already, from: line.withinDays?.from ?? 0, to: line.withinDays?.to ?? 0 }
  if (line.kind === 'COURSE_NEEDED') return { key: 'impact.needed', params }
  if (line.kind === 'COURSE_NOT_NEEDED') return { key: 'impact.notNeeded', params }
  if (line.kind === 'COURSE_DEADLINE') return { key: line.withinDays?.to === null ? 'impact.deadlineBefore' : 'impact.deadline', params }
  return { key: 'impact.other', params }
}

// ---- Record training ------------------------------------------------------------------------------------------------------------

export interface RecordPerson {
  employeeId: string
  name: string
  companyId: string
  result: 'PASSED' | 'FAILED'
  /** The trainer checked the person understood the language (art. 37 c.13). */
  languageChecked: boolean
  /** Another valid-until than the refresher period's: '' = the period's. */
  validUntil: string
  validUntilReason: string
}

export interface RecordDraft {
  courseId: string | null
  completedOn: string
  hours: string
  trainerName: string
  language: string
  people: RecordPerson[]
  /** The provider's certificate (one file, onto each record made). */
  certificate: File | null
}

export const recordPerson = (person: { employeeId: string; name: string; companyId: string }): RecordPerson => ({ ...person, result: 'PASSED', languageChecked: true, validUntil: '', validUntilReason: '' })

export const emptyRecordDraft = (today: string, people: RecordPerson[] = [], courseId: string | null = null): RecordDraft => ({ courseId, completedOn: today, hours: '', trainerName: '', language: 'it', people, certificate: null })

/** The expiry a record gets from the course's refresher period (completedOn + months); null: no refresher. */
export const expiryOf = (completedOn: string, refresherMonths: number | null): string | null => (refresherMonths === null || !completedOn ? null : addMonths(completedOn as BusinessDate, refresherMonths))

/** Why "Record for N people" is held; null: it may go. */
export function recordHeld(draft: RecordDraft, course: { hours: string; refresherMonths: number | null } | null, today: string): string | null {
  if (!draft.courseId || !course) return 'held.course'
  if (!draft.completedOn) return 'held.date'
  if (draft.completedOn > today) return 'held.dateFuture'
  if (!hoursIn(draft.hours, LIMITS.courseHours)) return 'held.hours'
  if (!draft.trainerName.trim()) return 'held.trainer'
  if (draft.trainerName.length > LIMITS.trainerName) return 'held.trainerLong'
  if (!LANGUAGE.test(draft.language)) return 'held.language'
  if (draft.people.length === 0) return 'held.people'
  if (draft.people.length > LIMITS.people) return 'held.peopleMany'
  for (const person of draft.people) {
    if (person.validUntil && person.validUntil < draft.completedOn) return 'held.untilBefore'
    if (person.validUntil && person.validUntil !== (expiryOf(draft.completedOn, course.refresherMonths) ?? '') && person.validUntilReason.trim().length < 3) return 'held.untilReason'
  }
  return null
}

/** What Record training sends: another valid-until only where it differs from the period's, with its reason. */
export function recordBody(draft: RecordDraft, course: { refresherMonths: number | null }): RecordTrainingBody {
  const expected = expiryOf(draft.completedOn, course.refresherMonths)
  return {
    courseId: draft.courseId ?? '',
    completedOn: draft.completedOn,
    hours: hoursIn(draft.hours) ?? draft.hours.trim(),
    trainerName: draft.trainerName.trim(),
    language: draft.language,
    people: draft.people.map((person) => {
      const other = person.result === 'PASSED' && person.validUntil !== '' && person.validUntil !== (expected ?? '')
      return { employeeId: person.employeeId, result: person.result, languageChecked: person.languageChecked, ...(other ? { validUntil: person.validUntil, validUntilReason: person.validUntilReason.trim() } : {}) }
    }),
  }
}

/** A person whose language was not understood cannot pass (art. 37 c.13): the form says so before the API does. */
export const languageWarning = (people: readonly Pick<RecordPerson, 'result' | 'languageChecked'>[]): boolean => people.some((person) => person.result === 'PASSED' && !person.languageChecked)

/** The attendances a session's close turns into records: countersigned, not voided, without a record yet. */
export const closable = <A extends { countersign: unknown; voided: unknown; recordId: string | null }>(attendances: readonly A[]): A[] => attendances.filter((entry) => entry.countersign !== null && entry.voided === null && entry.recordId === null)

/** Why "Close the session" is held. */
export function closeHeld(session: { heldOn: string; counts: { signed: number; countersigned: number; voided: number } } | null, attendances: readonly { countersign: unknown; voided: unknown; recordId: string | null }[], today: string): string | null {
  if (!session) return 'held.session'
  if (session.heldOn > today) return 'held.sessionLater'
  if (attendances.some((entry) => entry.countersign === null && entry.voided === null)) return 'held.notCountersigned'
  if (closable(attendances).length === 0) return 'held.noAttendance'
  return null
}

// ---- the instruction register ----------------------------------------------------------------------------------------------------

export interface InstructionDraft {
  employeeId: string | null
  instructedOn: string
  task: string
  machineClassId: string | null
  instructorEmployeeId: string | null
  instructorName: string
  minutes: string
  language: string
  languageChecked: boolean
  note: string
  /** How the person signs: at the floor tablet with their own PIN, or on the paper sheet. */
  signs: 'floor' | 'paper'
}

export const emptyInstructionDraft = (today: string, employeeId: string | null = null): InstructionDraft => ({ employeeId, instructedOn: today, task: '', machineClassId: null, instructorEmployeeId: null, instructorName: '', minutes: '', language: 'it', languageChecked: true, note: '', signs: 'floor' })

export function minutesIn(text: string): number | null {
  const value = text.trim()
  if (!/^\d{1,4}$/.test(value)) return null
  const minutes = Number(value)
  return minutes >= 1 && minutes <= LIMITS.minutes ? minutes : null
}

export function instructionHeld(draft: InstructionDraft, today: string): string | null {
  if (!draft.employeeId) return 'held.person'
  if (!draft.instructedOn) return 'held.date'
  if (draft.instructedOn > today) return 'held.dateFuture'
  if (!draft.task.trim()) return 'held.task'
  if (draft.task.length > LIMITS.task) return 'held.taskLong'
  if (!draft.instructorEmployeeId && !draft.instructorName.trim()) return 'held.instructor'
  if (draft.instructorEmployeeId && draft.instructorEmployeeId === draft.employeeId) return 'held.instructorSelf'
  if (minutesIn(draft.minutes) === null) return 'held.minutes'
  if (!LANGUAGE.test(draft.language)) return 'held.language'
  return null
}

export function instructionBody(draft: InstructionDraft): InstructionBody {
  return {
    employeeId: draft.employeeId ?? '',
    instructedOn: draft.instructedOn,
    task: draft.task.trim(),
    machineClassId: draft.machineClassId,
    ...(draft.instructorEmployeeId ? { instructorEmployeeId: draft.instructorEmployeeId } : { instructorName: draft.instructorName.trim() }),
    minutes: minutesIn(draft.minutes) ?? 0,
    language: draft.language,
    languageChecked: draft.languageChecked,
    note: draft.note.trim() || null,
    ...(draft.signs === 'paper' ? { paper: true } : {}),
  }
}

/** An entry's state in one word key: voided, signed (on the floor with the PIN, or on paper), waiting for the person. */
export const entryState = (entry: Pick<InstructionEntry, 'signed' | 'voided'>): 'voided' | 'pin' | 'paper' | 'office' | 'waiting' =>
  entry.voided ? 'voided' : entry.signed ? (entry.signed.method === 'FLOOR_PIN' ? 'pin' : entry.signed.method === 'PAPER' ? 'paper' : 'office') : 'waiting'

// ---- refusals in words --------------------------------------------------------------------------------------------------------

const REFUSALS = new Set<string>([...TRAINING_REFUSALS, ...RECORDS_REFUSAL_CODES])
const FIELDS = new Set(['code', 'name', 'hours', 'refresherMonths', 'refresherHours', 'provider', 'legalBasis', 'completedOn', 'trainerName', 'language', 'people', 'validUntil', 'validUntilReason', 'task', 'minutes', 'reason', 'requirements', 'instructedOn', 'courses'])

export interface TrainingProblem {
  key: string
  params?: Record<string, string | number>
}

/** A failed call in this page's words: a refusal by its code, a field by its name, else the kind of failure. */
export function trainingProblem(error: unknown): TrainingProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && REFUSALS.has(path.slice('refusal/'.length))) return { key: `refusal.${path.slice('refusal/'.length)}` }
  }
  if (error.kind === 'invalid') {
    for (const issue of error.issues) {
      const field = issuePath(issue).replace(/^body[./]/, '').split(/[./]/).find((part) => FIELDS.has(part))
      if (field) return { key: `field.${field}` }
    }
    return { key: 'problem.invalid' }
  }
  const kinds: Record<string, string> = { forbidden: 'problem.forbidden', not_found: 'problem.notFound', conflict: 'problem.conflict', signed_out: 'problem.signedOut', rate_limited: 'problem.rateLimited', step_up: 'problem.stepUp' }
  return { key: kinds[error.kind] ?? 'problem.unavailable' }
}

/**
 * A failed read in one key (a section says it and offers Try again; never drawn as empty). A document the API makes on the
 * company's letterhead is refused while the company lacks its legal data (c.c. art. 2250; issues at `company/…`): said so,
 * with where to add it.
 */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.notFound'
  if (error.kind === 'invalid' && error.issues.some((issue) => issuePath(issue).startsWith('company/'))) return 'problem.companyLegal'
  return 'problem.unavailable'
}

export { COURSE_TYPES }

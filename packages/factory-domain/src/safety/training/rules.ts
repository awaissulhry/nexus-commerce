import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { addDays, addMonths } from '../calendar/rules'
import { holdingKey, type RequirementDraft, type RoleAsks } from '../rolesheets/rules'

/**
 * The safety course catalogue and who needs which course (B-W2b-133; QHS-241 "Safety course catalogue", QHS-242 "Training
 * requirements matrix"; design people.skills "Course catalogue", "Who needs what", the pop-up "Course"; D.Lgs. 81/2008 art. 37
 * and the State-Regions agreement), pure. The tables are factory-db safety.prisma's SafetyCourse (the catalogue: type, hours,
 * refresher period and hours, in person, provider, legal basis; archived, never deleted) and TrainingRequirement (a course a
 * ROLE asks: the role sheet's, B-W2b-128; a course a TYPE OF MACHINE asks of who is authorised on it: this module's).
 *
 * The law's numbers are never invented here: the plan gives no duration and no refresher period, so every course's hours
 * and refresher are SETTINGS the company types from its own programme (its consultant's, the agreement's). The standard
 * list fills the types, names and the law each rests on; its hours and periods are left for the person to type.
 *
 * Who needs what is never typed per person: a person needs a course because their role sheet asks it (Employee.roleSheetId;
 * due the day they took the role + the days it allows, none: before starting) or because a type of machine they are
 * authorised on asks it (due the day the authorisation starts + its days). A course is MET while the person's standing
 * record of it holds (rolesheets `coursesMet`: the newest PASSED record no correction names, valid until null or not past).
 */

export const TRAINING_LAW = 'D.Lgs. 81/2008 art. 37'
/** The agreement sets the courses' durations, contents and refreshers; the company types its numbers (never this code). */
export const AGREEMENT_LAW = 'D.Lgs. 81/2008 art. 37 c.2; Accordo Stato-Regioni'
/** A machine that asks particular knowledge is used only by people trained for it. */
export const MACHINE_TRAINING_LAW = 'D.Lgs. 81/2008 art. 71 c.7; art. 73'

export const COURSE_TYPES = ['GENERAL', 'SPECIFIC_LOW', 'SPECIFIC_MEDIUM', 'SPECIFIC_HIGH', 'SUPERVISOR', 'MANAGER', 'RLS', 'FIRST_AID', 'FIRE', 'FORKLIFT', 'OTHER'] as const
export type CourseType = (typeof COURSE_TYPES)[number]
export const COURSE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type CourseStatus = (typeof COURSE_STATUSES)[number]

/** The rule each type of course rests on (references only, never a number): the default legal basis of a new course. */
export const COURSE_TYPE_LAW: Readonly<Record<CourseType, string>> = Object.freeze({
  GENERAL: 'D.Lgs. 81/2008 art. 37 c.1 a; Accordo Stato-Regioni',
  SPECIFIC_LOW: 'D.Lgs. 81/2008 art. 37 c.1 b; Accordo Stato-Regioni',
  SPECIFIC_MEDIUM: 'D.Lgs. 81/2008 art. 37 c.1 b; Accordo Stato-Regioni',
  SPECIFIC_HIGH: 'D.Lgs. 81/2008 art. 37 c.1 b; Accordo Stato-Regioni',
  SUPERVISOR: 'D.Lgs. 81/2008 art. 37 c.7; Accordo Stato-Regioni',
  MANAGER: 'D.Lgs. 81/2008 art. 37 c.7; Accordo Stato-Regioni',
  RLS: 'D.Lgs. 81/2008 art. 37 c.10-11',
  FIRST_AID: 'D.Lgs. 81/2008 art. 37 c.9; art. 45',
  FIRE: 'D.Lgs. 81/2008 art. 37 c.9; art. 46',
  FORKLIFT: 'D.Lgs. 81/2008 art. 73 c.5; Accordo Stato-Regioni',
  OTHER: TRAINING_LAW,
})

export const TRAINING_LIMITS = Object.freeze({
  code: 30,
  name: 160,
  provider: 160,
  legalBasis: 300,
  note: 1000,
  /** The database's own bounds: hours above 0 and at most 200, a refresher every 1 to 120 months. */
  hours: 200,
  refresherMonths: 120,
  sortOrder: 9999,
  list: 500,
  /** The names a line of "What this changes" lists (the count says the rest). */
  names: 100,
  /** Courses one type of machine asks (as a role sheet). */
  requirements: 40,
  withinDays: 365,
  /** The courses one "Start from the standard list" adds. */
  standard: 20,
})

/** A course's code: letters, digits and . _ / - (stored in capitals; the database refuses spaces). */
export const COURSE_CODE = /^[A-Z0-9][A-Z0-9._/-]*$/
export const courseCode = (code: string): string => code.trim().toUpperCase()

/** Hours as the API takes them: a decimal string with at most two decimals ("4", "12.5"). */
export const HOURS = /^\d{1,3}(?:\.\d{1,2})?$/
export const hoursOk = (hours: string): boolean => HOURS.test(hours) && Number(hours) > 0 && Number(hours) <= TRAINING_LIMITS.hours
/** "12.50" and "12.5" are the same hours. */
export const sameHours = (left: string | null, right: string | null): boolean => (left === null || right === null ? left === right : Number(left) === Number(right))
export const hoursWords = (hours: string | null): string | null => (hours === null ? null : String(Number(hours)))

export const TRAINING_REFUSALS = [
  'CODE_TAKEN',
  'ARCHIVED',
  'NOT_ARCHIVED',
  'COURSE_REQUIRED',
  'IMPACT_CHANGED',
  'COURSE_NOT_AVAILABLE',
  'COURSE_NOT_GROUP_WIDE',
  'CLASS_RETIRED',
] as const
export type TrainingRefusalCode = (typeof TRAINING_REFUSALS)[number]

// ---- the standard list ----------------------------------------------------------------------------------------------------

export interface StandardCourse {
  readonly code: string
  readonly type: Exclude<CourseType, 'OTHER'>
  readonly name: string
  readonly nameI18n: { readonly it: string; readonly en: string }
  readonly legalBasis: string
}

/**
 * "Start from the standard list" (design people.skills catalogue, empty state): the common courses of art. 37 and the
 * emergency teams, to review. Types, names and the law only: their hours, refresher periods and refresher hours are typed by
 * the person from the company's programme (the plan gives none of the agreement's numbers, and none is made up here).
 */
export const STANDARD_COURSES: readonly StandardCourse[] = Object.freeze([
  { code: 'GENERAL', type: 'GENERAL', name: 'General worker training', nameI18n: { it: 'Formazione generale dei lavoratori', en: 'General worker training' }, legalBasis: COURSE_TYPE_LAW.GENERAL },
  { code: 'SPECIFIC-LOW', type: 'SPECIFIC_LOW', name: 'Specific training, low risk', nameI18n: { it: 'Formazione specifica, rischio basso', en: 'Specific training, low risk' }, legalBasis: COURSE_TYPE_LAW.SPECIFIC_LOW },
  { code: 'SPECIFIC-MEDIUM', type: 'SPECIFIC_MEDIUM', name: 'Specific training, medium risk', nameI18n: { it: 'Formazione specifica, rischio medio', en: 'Specific training, medium risk' }, legalBasis: COURSE_TYPE_LAW.SPECIFIC_MEDIUM },
  { code: 'SPECIFIC-HIGH', type: 'SPECIFIC_HIGH', name: 'Specific training, high risk', nameI18n: { it: 'Formazione specifica, rischio alto', en: 'Specific training, high risk' }, legalBasis: COURSE_TYPE_LAW.SPECIFIC_HIGH },
  { code: 'SUPERVISOR', type: 'SUPERVISOR', name: 'Supervisor (preposto)', nameI18n: { it: 'Formazione preposti', en: 'Supervisor (preposto)' }, legalBasis: COURSE_TYPE_LAW.SUPERVISOR },
  { code: 'MANAGER', type: 'MANAGER', name: 'Manager (dirigente)', nameI18n: { it: 'Formazione dirigenti', en: 'Manager (dirigente)' }, legalBasis: COURSE_TYPE_LAW.MANAGER },
  { code: 'RLS', type: 'RLS', name: "Workers' safety representative (RLS)", nameI18n: { it: 'Rappresentante dei lavoratori per la sicurezza (RLS)', en: "Workers' safety representative (RLS)" }, legalBasis: COURSE_TYPE_LAW.RLS },
  { code: 'FIRST-AID', type: 'FIRST_AID', name: 'First aid team', nameI18n: { it: 'Addetti al primo soccorso', en: 'First aid team' }, legalBasis: COURSE_TYPE_LAW.FIRST_AID },
  { code: 'FIRE', type: 'FIRE', name: 'Fire and emergency team', nameI18n: { it: 'Addetti antincendio e gestione delle emergenze', en: 'Fire and emergency team' }, legalBasis: COURSE_TYPE_LAW.FIRE },
  { code: 'FORKLIFT', type: 'FORKLIFT', name: 'Forklift operator', nameI18n: { it: 'Addetti alla conduzione di carrelli elevatori', en: 'Forklift operator' }, legalBasis: COURSE_TYPE_LAW.FORKLIFT },
])

// ---- a course -------------------------------------------------------------------------------------------------------------

/** What a course says that may change (its company, code and type never do: the database holds them). */
export interface CourseFields {
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  /** A decimal string. */
  readonly hours: string
  readonly refresherMonths: number | null
  readonly refresherHours: string | null
  readonly inPersonRequired: boolean
  readonly provider: string | null
  readonly legalBasis: string
  readonly sortOrder: number
}
export const COURSE_FIELDS = ['name', 'nameI18n', 'hours', 'refresherMonths', 'refresherHours', 'inPersonRequired', 'provider', 'legalBasis', 'sortOrder'] as const
export type CourseField = (typeof COURSE_FIELDS)[number]

const clean = (words: string | null | undefined): string | null => {
  const trimmed = words?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** Names in other languages: words trimmed, empty ones left out (none: null). */
export function cleanNames(names: Readonly<Record<string, string>> | null | undefined): Record<string, string> | null {
  if (!names) return null
  const entries = Object.entries(names)
    .map(([language, words]) => [language, words.trim()] as const)
    .filter(([, words]) => words !== '')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** The fields as they are stored: words trimmed, an empty provider none, hours as they were typed. */
export function cleanCourse(fields: CourseFields): CourseFields {
  return {
    name: fields.name.trim(),
    nameI18n: cleanNames(fields.nameI18n),
    hours: fields.hours.trim(),
    refresherMonths: fields.refresherMonths,
    refresherHours: fields.refresherMonths === null ? null : (clean(fields.refresherHours) ?? null),
    inPersonRequired: fields.inPersonRequired,
    provider: clean(fields.provider),
    legalBasis: fields.legalBasis.trim(),
    sortOrder: fields.sortOrder,
  }
}

/**
 * What is wrong with a course (paths without `body/`, under `prefix`): a name, the hours (above 0, at most 200, two decimals
 * at most), a refresher every 1 to 120 months or none, its hours only with it, the legal basis it rests on. The numbers are
 * the company's: only the database's bounds are checked, never a value of the law.
 */
export function courseProblems(fields: CourseFields, prefix = ''): Issue[] {
  const L = TRAINING_LIMITS
  const at = (field: string) => `${prefix}${field}`
  const problems: Issue[] = []
  if (fields.name.trim() === '') problems.push({ path: at('name'), message: 'Give the course a name.' })
  if (fields.name.trim().length > L.name) problems.push({ path: at('name'), message: `At most ${L.name} characters.` })
  if (!hoursOk(fields.hours.trim())) problems.push({ path: at('hours'), message: `Its hours: above 0 and at most ${L.hours}, with at most two decimals (as your programme says).` })
  if (fields.refresherMonths !== null && (!Number.isInteger(fields.refresherMonths) || fields.refresherMonths < 1 || fields.refresherMonths > L.refresherMonths))
    problems.push({ path: at('refresherMonths'), message: `A refresher every 1 to ${L.refresherMonths} months, or none.` })
  const refresherHours = clean(fields.refresherHours)
  if (refresherHours !== null && fields.refresherMonths === null) problems.push({ path: at('refresherHours'), message: 'Refresher hours come with a refresher period.' })
  if (refresherHours !== null && !hoursOk(refresherHours)) problems.push({ path: at('refresherHours'), message: `Refresher hours: above 0 and at most ${L.hours}, with at most two decimals.` })
  if (fields.legalBasis.trim() === '') problems.push({ path: at('legalBasis'), message: 'Say the rule the course rests on ("D.Lgs. 81/2008 art. 37").' })
  if (fields.legalBasis.trim().length > L.legalBasis) problems.push({ path: at('legalBasis'), message: `At most ${L.legalBasis} characters.` })
  if ((clean(fields.provider)?.length ?? 0) > L.provider) problems.push({ path: at('provider'), message: `At most ${L.provider} characters.` })
  if (!Number.isInteger(fields.sortOrder) || fields.sortOrder < 0 || fields.sortOrder > L.sortOrder) problems.push({ path: at('sortOrder'), message: `From 0 to ${L.sortOrder}.` })
  return problems
}

export type FieldValue = string | number | boolean | null | Readonly<Record<string, string>>
export interface CourseChange {
  readonly field: CourseField
  readonly from: FieldValue
  readonly to: FieldValue
}

const shown = (field: CourseField, value: FieldValue): FieldValue => (field === 'hours' || field === 'refresherHours' ? hoursWords(value as string | null) : value)

/** The fields a draft changes, from → to (hours said as numbers: "12.50" is "12.5"). */
export function courseChanges(before: CourseFields, after: CourseFields): CourseChange[] {
  const old = cleanCourse(before)
  const next = cleanCourse(after)
  const changes: CourseChange[] = []
  for (const field of COURSE_FIELDS) {
    const from = old[field]
    const to = next[field]
    const same = field === 'hours' || field === 'refresherHours' ? sameHours(from as string | null, to as string | null) : JSON.stringify(from) === JSON.stringify(to)
    if (!same) changes.push({ field, from: shown(field, from), to: shown(field, to) })
  }
  return changes
}

// ---- what a change of the refresher period would move ---------------------------------------------------------------------

/** A person's standing record of the course (the newest PASSED one no correction names). */
export interface Holding {
  readonly employeeId: string
  readonly name: string
  readonly completedOn: BusinessDate
  readonly validUntil: BusinessDate | null
}

export interface RefresherImpact {
  readonly from: number | null
  readonly to: number | null
  /** People holding a standing record of the course. */
  readonly holders: number
  /** Their records whose date came from the period now in force (completed on + the period; none: no expiry). */
  readonly followPeriod: number
  /** Of those, the dates the new period would put elsewhere. */
  readonly wouldMove: number
  /** Dates set otherwise (a reason on the record, or an earlier period): no period change touches them. */
  readonly ownDate: number
  /** Whose date would move (at most TRAINING_LIMITS.names; `wouldMove` counts all), with the date on record and the new one. */
  readonly people: readonly { readonly employeeId: string; readonly name: string; readonly completedOn: BusinessDate; readonly validUntil: BusinessDate | null; readonly withNewPeriod: BusinessDate | null }[]
}

const validityOf = (completedOn: BusinessDate, months: number | null): BusinessDate | null => (months === null ? null : addMonths(completedOn, months))

/**
 * What changing a course's refresher period from `from` to `to` months would do to the dates of the people holding it. A
 * record keeps the date it was given (its "valid until" is frozen on the append-only record; the database computes it from
 * the period in force when the record is written): nothing moves by itself. The answer says whose date WOULD differ, so the
 * person can correct those records (Training records) when their consultant says so; the next records take the new period.
 */
export function refresherImpact(holdings: readonly Holding[], from: number | null, to: number | null): RefresherImpact {
  let followPeriod = 0
  const moving: { employeeId: string; name: string; completedOn: BusinessDate; validUntil: BusinessDate | null; withNewPeriod: BusinessDate | null }[] = []
  for (const holding of holdings) {
    if (holding.validUntil !== validityOf(holding.completedOn, from)) continue
    followPeriod += 1
    const withNewPeriod = validityOf(holding.completedOn, to)
    if (withNewPeriod !== holding.validUntil) moving.push({ employeeId: holding.employeeId, name: holding.name, completedOn: holding.completedOn, validUntil: holding.validUntil, withNewPeriod })
  }
  moving.sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId))
  return { from, to, holders: holdings.length, followPeriod, wouldMove: moving.length, ownDate: holdings.length - followPeriod, people: moving.slice(0, TRAINING_LIMITS.names) }
}

// ---- who needs which course -----------------------------------------------------------------------------------------------

export const NEED_SOURCES = ['ROLE_SHEET', 'MACHINE_CLASS'] as const
export type NeedSourceKind = (typeof NEED_SOURCES)[number]
export const NEED_STATES = ['MET', 'DUE', 'OVERDUE'] as const
export type NeedState = (typeof NEED_STATES)[number]

/** The day a course is due from a source: the day the person took the role (or the authorisation starts) + its days. */
export const dueOf = (since: BusinessDate, withinDays: number | null): BusinessDate => addDays(since, withinDays ?? 0)
/** MET while the standing record holds; else DUE until its day, OVERDUE after it. */
export const needStateOf = (met: boolean, dueOn: BusinessDate, today: BusinessDate): NeedState => (met ? 'MET' : dueOn < today ? 'OVERDUE' : 'DUE')

export interface NeedSource {
  readonly kind: NeedSourceKind
  /** The role sheet or the machine class. */
  readonly id: string
  /** The day the person took the role, or the day the authorisation starts. */
  readonly since: BusinessDate
  /** Days the source allows (null: before starting). */
  readonly withinDays: number | null
  readonly dueOn: BusinessDate
  /** This source's own state (its own due day). */
  readonly state: NeedState
}

/** One person × one course they need: from one source or more (the earliest due day decides). */
export interface PersonNeed {
  readonly employeeId: string
  readonly courseId: string
  readonly met: boolean
  readonly dueOn: BusinessDate
  readonly state: NeedState
  readonly sources: readonly NeedSource[]
}

export interface NeedInputs {
  /** The people: their role sheet (null: none) and the day they took it. */
  readonly people: readonly { readonly employeeId: string; readonly roleSheetId: string | null; readonly roleSince: BusinessDate | null }[]
  /** The courses each role sheet asks. */
  readonly roleRequirements: ReadonlyMap<string, readonly RequirementDraft[]>
  /** Their machine authorisations not revoked and not ended (one that starts later counts from its first day). */
  readonly authorisations: readonly { readonly employeeId: string; readonly machineClassId: string; readonly authorisedOn: BusinessDate }[]
  /** The courses each machine class asks. */
  readonly classRequirements: ReadonlyMap<string, readonly RequirementDraft[]>
  /** `holdingKey(employee, course)` of the courses each person holds today (needs.ts holdingsOf). */
  readonly met: ReadonlySet<string>
  readonly today: BusinessDate
}

/**
 * Who needs which course, from their role sheet and the machine types they are authorised on: one row per person and
 * course, its sources, the earliest due day and the state. Never typed per person; a person with neither needs nothing.
 */
export function needsOf(inputs: NeedInputs): PersonNeed[] {
  const sources = new Map<string, { employeeId: string; courseId: string; list: NeedSource[] }>()
  const add = (employeeId: string, courseId: string, source: Omit<NeedSource, 'state' | 'dueOn'>) => {
    const key = holdingKey(employeeId, courseId)
    const dueOn = dueOf(source.since, source.withinDays)
    const entry = sources.get(key) ?? { employeeId, courseId, list: [] }
    entry.list.push({ ...source, dueOn, state: needStateOf(inputs.met.has(key), dueOn, inputs.today) })
    sources.set(key, entry)
  }
  const known = new Set(inputs.people.map((person) => person.employeeId))
  for (const person of inputs.people) {
    if (!person.roleSheetId || !person.roleSince) continue
    for (const requirement of inputs.roleRequirements.get(person.roleSheetId) ?? []) add(person.employeeId, requirement.courseId, { kind: 'ROLE_SHEET', id: person.roleSheetId, since: person.roleSince, withinDays: requirement.withinDays })
  }
  // One authorisation per person and class counts: the earliest that is not over.
  const firstDay = new Map<string, { employeeId: string; machineClassId: string; authorisedOn: BusinessDate }>()
  for (const authorisation of inputs.authorisations) {
    if (!known.has(authorisation.employeeId)) continue
    const key = holdingKey(authorisation.employeeId, authorisation.machineClassId)
    const was = firstDay.get(key)
    if (!was || authorisation.authorisedOn < was.authorisedOn) firstDay.set(key, authorisation)
  }
  for (const authorisation of firstDay.values())
    for (const requirement of inputs.classRequirements.get(authorisation.machineClassId) ?? [])
      add(authorisation.employeeId, requirement.courseId, { kind: 'MACHINE_CLASS', id: authorisation.machineClassId, since: authorisation.authorisedOn, withinDays: requirement.withinDays })

  const needs: PersonNeed[] = []
  for (const { employeeId, courseId, list } of sources.values()) {
    const met = inputs.met.has(holdingKey(employeeId, courseId))
    const ordered = [...list].sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    const dueOn = ordered[0]!.dueOn
    needs.push({ employeeId, courseId, met, dueOn, state: needStateOf(met, dueOn, inputs.today), sources: ordered })
  }
  return needs.sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.dueOn.localeCompare(b.dueOn) || a.courseId.localeCompare(b.courseId))
}

export interface NeedCounts {
  /** People asked the course (by this source, or at all). */
  readonly people: number
  readonly met: number
  readonly due: number
  readonly overdue: number
}

/** Counts of person × course rows (each person once per course), by the state the source (or the merged row) gives. */
export function countNeeds(rows: readonly { readonly state: NeedState }[]): NeedCounts {
  let met = 0
  let due = 0
  let overdue = 0
  for (const row of rows) {
    if (row.state === 'MET') met += 1
    else if (row.state === 'DUE') due += 1
    else overdue += 1
  }
  return { people: rows.length, met, due, overdue }
}

// ---- the courses a type of machine asks -----------------------------------------------------------------------------------

/** The courses a type of machine asks, as the screen sends them: words trimmed, empty notes none. */
export const cleanRequirements = (requirements: readonly RequirementDraft[]): RequirementDraft[] =>
  requirements.map((requirement) => ({ courseId: requirement.courseId, withinDays: requirement.withinDays, note: clean(requirement.note) }))

/** What is wrong with a machine type's courses (paths without `body/`): one line per course, the days in range. */
export function classRequirementProblems(requirements: readonly RequirementDraft[]): Issue[] {
  const L = TRAINING_LIMITS
  const problems: Issue[] = []
  if (requirements.length > L.requirements) problems.push({ path: 'requirements', message: `A type of machine asks at most ${L.requirements} courses.` })
  const seen = new Set<string>()
  requirements.forEach((requirement, index) => {
    if (seen.has(requirement.courseId)) problems.push({ path: `requirements/${index}/courseId`, message: 'This type of machine asks this course already: one line per course.' })
    seen.add(requirement.courseId)
    if (requirement.withinDays !== null && (!Number.isInteger(requirement.withinDays) || requirement.withinDays < 0 || requirement.withinDays > L.withinDays))
      problems.push({ path: `requirements/${index}/withinDays`, message: `From 0 to ${L.withinDays} days after the authorisation starts, or none: before starting.` })
    if ((requirement.note?.trim().length ?? 0) > L.note) problems.push({ path: `requirements/${index}/note`, message: `At most ${L.note} characters.` })
  })
  return problems
}

/**
 * A machine type's courses in the shape of what a role asks (no risks, no kit, no health plan), so the role sheets' own
 * diff and "What this changes" (rolesheets `sheetChanges`, `sheetImpact`) say it for the people authorised on it.
 */
export const classAsks = (requirements: readonly RequirementDraft[]): RoleAsks => ({ content: { items: [], kit: [], requirements: cleanRequirements(requirements) }, needed: null, frequencyMonths: null })

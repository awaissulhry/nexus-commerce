import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { PLANT_CODE, PLANT_LIMITS } from '../rules'

/**
 * Statutory periodic checks of machines (B-W2b-124; QHS-205, QHS-219; D.Lgs. 81/2008 art. 71; design plant.preventive
 * "Plans", "Check register", "New plan", "Record a check result", "Move a check", plant.settings "Statutory check types").
 * The rules every caller shares: a check type's words, law and retention; a plan's interval, due dates and reminder; a
 * result's next due date and how long it is kept; what is due now; and the refusals in words.
 *
 * The law here is only what the plan gives: the results are kept at least three years (D.Lgs. 81/2008 art. 71). Nothing
 * here knows an interval the law sets for a kind of machine: the office types each check type with its legal basis and
 * its default interval (Plant settings), and each plan with its own. Preventive maintenance by time or use is Later.
 *
 * Dates are calendar days (`YYYY-MM-DD`, Europe/Rome). Months and years are added as the database adds them: the 31st plus
 * one month is the last day of a shorter month, 29 February plus one year is 28 February.
 */

export const CHECK_INTERVAL_UNITS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const
export type CheckIntervalUnit = (typeof CHECK_INTERVAL_UNITS)[number]

export const CHECK_OUTCOMES = ['PASSED', 'PASSED_WITH_REMARKS', 'FAILED'] as const
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number]

export const CHECK_PLAN_STATUSES = ['ACTIVE', 'ENDED'] as const
export type CheckPlanStatus = (typeof CHECK_PLAN_STATUSES)[number]

/** A plan's tone on the calendar and in the grid: overdue, due within DUE_SOON_DAYS, planned later, or ended. */
export const DUE_STATES = ['OVERDUE', 'DUE_SOON', 'PLANNED', 'ENDED'] as const
export type DueState = (typeof DUE_STATES)[number]

/** The page's tiles (design plant.preventive "Tiles": Checks overdue, Due in 30 days, Reports missing). */
export const CHECK_TILES = ['OVERDUE', 'DUE_SOON', 'REPORTS_MISSING'] as const
export type CheckTile = (typeof CHECK_TILES)[number]

/** "Due in 30 days" (the design's tile). */
export const DUE_SOON_DAYS = 30

/** Results are kept at least three years (D.Lgs. 81/2008 art. 71; the plan's "results kept at least 3 years"). */
export const LEAST_RETENTION_YEARS = 3
export const MAX_RETENTION_YEARS = 30

/** An interval from 1 to at most ten years in its unit (the database's factory_plant_interval_ok). */
export const INTERVAL_MAX: Readonly<Record<CheckIntervalUnit, number>> = Object.freeze({ DAY: 3660, WEEK: 520, MONTH: 120, YEAR: 10 })

export const CHECK_LIMITS = Object.freeze({
  label: PLANT_LIMITS.label,
  languages: PLANT_LIMITS.languages,
  legalBasis: 300,
  performedBy: 200,
  text: PLANT_LIMITS.text,
  note: PLANT_LIMITS.note,
  reason: PLANT_LIMITS.note,
  types: 200,
  reminderDays: 365,
  /** The calendar reads at most this many days at once (a year and a month). */
  calendarDays: 400,
  /** Projected occurrences of one plan on the calendar (after its next due date). */
  projected: 60,
  /** A list page. */
  page: 500,
})

const LANGUAGE = /^[a-z]{2,3}$/
const DAY_MS = 86_400_000
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// ---- calendar days ------------------------------------------------------------------------------------------------------

const partsOf = (date: BusinessDate): [number, number, number] => {
  const match = DATE.exec(date)
  if (!match) throw new RangeError(`not a calendar day: ${date}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
const formatted = (time: number): BusinessDate => new Date(time).toISOString().slice(0, 10)
const timeOf = (date: BusinessDate): number => {
  const [year, month, day] = partsOf(date)
  return Date.UTC(year, month - 1, day)
}

/** The day plus some days (negative: before). */
export const addDays = (date: BusinessDate, days: number): BusinessDate => formatted(timeOf(date) + days * DAY_MS)

/** Whole days from one day to another (negative when `to` is before `from`). */
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((timeOf(to) - timeOf(from)) / DAY_MS)

/** The day plus some months, on the last day of a shorter month (as PostgreSQL's date + interval). */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [year, month, day] = partsOf(date)
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = index - targetYear * 12
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return formatted(Date.UTC(targetYear, targetMonth, Math.min(day, last)))
}

/** The day plus an interval of a plan. */
export function addInterval(date: BusinessDate, amount: number, unit: CheckIntervalUnit): BusinessDate {
  switch (unit) {
    case 'DAY':
      return addDays(date, amount)
    case 'WEEK':
      return addDays(date, amount * 7)
    case 'MONTH':
      return addMonths(date, amount)
    case 'YEAR':
      return addMonths(date, amount * 12)
  }
}

/** The day a Date column holds (PostgreSQL `date` comes back as midnight UTC). */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
/** A calendar day as the Date a `date` column takes. */
export const dateOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

// ---- check types --------------------------------------------------------------------------------------------------------

export interface CheckTypeDraft {
  readonly code?: string | undefined
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly legalBasis?: string | undefined
  readonly defaultInterval?: number | undefined
  readonly defaultIntervalUnit?: CheckIntervalUnit | undefined
  readonly retentionYears?: number | undefined
}

/** A check type's fields (only those present are checked; `code` only on a new type); paths without `body/`. */
export function checkTypeProblems(draft: CheckTypeDraft, isNew: boolean): Issue[] {
  const problems: Issue[] = []
  if (isNew && (draft.code === undefined || !PLANT_CODE.test(draft.code))) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits and underscores, starting with a letter (PRESS_GUARDS).' })
  for (const field of ['labelIt', 'labelEn'] as const) {
    const value = draft[field]
    if (value === undefined) continue
    if (value.trim() === '') problems.push({ path: field, message: field === 'labelIt' ? 'Name the check type in Italian.' : 'Name the check type in English.' })
    else if (value.trim().length > CHECK_LIMITS.label) problems.push({ path: field, message: `At most ${CHECK_LIMITS.label} characters.` })
  }
  const entries = Object.entries(draft.labelI18n ?? {})
  if (entries.length > CHECK_LIMITS.languages) problems.push({ path: 'labelI18n', message: `At most ${CHECK_LIMITS.languages} other languages.` })
  for (const [language, words] of entries) {
    if (!LANGUAGE.test(language) || language === 'it' || language === 'en') problems.push({ path: `labelI18n/${language}`, message: 'A language is its ISO 639 code (ro, ur, zh); Italian and English have their own words.' })
    else if (words !== null && words.trim() === '') problems.push({ path: `labelI18n/${language}`, message: 'Leave a language out instead of blank words.' })
    else if (words !== null && words.trim().length > CHECK_LIMITS.label) problems.push({ path: `labelI18n/${language}`, message: `At most ${CHECK_LIMITS.label} characters.` })
  }
  if (draft.legalBasis !== undefined) {
    if (draft.legalBasis.trim() === '') problems.push({ path: 'legalBasis', message: 'Name the law or standard the check rests on, in words (for example "D.Lgs. 81/2008 art. 71").' })
    else if (draft.legalBasis.trim().length > CHECK_LIMITS.legalBasis) problems.push({ path: 'legalBasis', message: `At most ${CHECK_LIMITS.legalBasis} characters.` })
  }
  if (draft.defaultInterval !== undefined || draft.defaultIntervalUnit !== undefined) {
    problems.push(...intervalProblems(draft.defaultInterval, draft.defaultIntervalUnit, 'defaultInterval'))
  }
  if (draft.retentionYears !== undefined && (!Number.isInteger(draft.retentionYears) || draft.retentionYears < LEAST_RETENTION_YEARS || draft.retentionYears > MAX_RETENTION_YEARS)) {
    problems.push({ path: 'retentionYears', message: `Results are kept ${LEAST_RETENTION_YEARS} to ${MAX_RETENTION_YEARS} years (D.Lgs. 81/2008 art. 71: at least ${LEAST_RETENTION_YEARS}).` })
  }
  return problems
}

/** An interval from 1 to at most ten years in its unit (both given together when one changes). */
export function intervalProblems(amount: number | undefined, unit: CheckIntervalUnit | undefined, path = 'interval'): Issue[] {
  if (amount === undefined || unit === undefined) return [{ path, message: 'Give the interval with its unit (days, weeks, months or years).' }]
  if (!Number.isInteger(amount) || amount < 1 || amount > INTERVAL_MAX[unit]) return [{ path, message: `An interval is from 1 to at most ten years (at most ${INTERVAL_MAX[unit]} ${unit.toLowerCase()}s).` }]
  return []
}

/** How many years a type's results are kept: its retention, never under the law's three. */
export const keptYearsOf = (retentionYears: number): number => Math.max(LEAST_RETENTION_YEARS, retentionYears)

// ---- plans and results ----------------------------------------------------------------------------------------------------

/** A reminder lead time: 0 to 365 days. */
export function reminderProblems(days: number | undefined): Issue[] {
  if (days === undefined) return []
  return Number.isInteger(days) && days >= 0 && days <= CHECK_LIMITS.reminderDays ? [] : [{ path: 'reminderDays', message: `A reminder goes 0 to ${CHECK_LIMITS.reminderDays} days before the check is due.` }]
}

/** Until when a result is kept: the day it was done plus its type's retention, at least three years. */
export const keptUntilOf = (performedOn: BusinessDate, retentionYears: number): BusinessDate => addInterval(performedOn, keptYearsOf(retentionYears), 'YEAR')

/**
 * The plan's next due date after a result: the date the check gave, else the day it was done plus the plan's interval;
 * never before the plan's first due date (a check done long before the plan's first date leaves it there).
 */
export function nextDueAfter(plan: { readonly interval: number; readonly intervalUnit: CheckIntervalUnit; readonly firstDueOn: BusinessDate }, result: { readonly performedOn: BusinessDate; readonly nextDueOn: BusinessDate | null }): BusinessDate {
  const next = result.nextDueOn ?? addInterval(result.performedOn, plan.interval, plan.intervalUnit)
  return next < plan.firstDueOn ? plan.firstDueOn : next
}

/** Where a plan stands today. */
export function dueStateOf(plan: { readonly status: CheckPlanStatus; readonly nextDueOn: BusinessDate }, today: BusinessDate): { readonly state: DueState; readonly days: number } {
  const days = daysBetween(today, plan.nextDueOn)
  if (plan.status === 'ENDED') return { state: 'ENDED', days }
  if (days < 0) return { state: 'OVERDUE', days }
  if (days <= DUE_SOON_DAYS) return { state: 'DUE_SOON', days }
  return { state: 'PLANNED', days }
}

/** The first day of the reminder window of a plan's next due date. */
export const reminderFromOf = (plan: { readonly nextDueOn: BusinessDate; readonly reminderDays: number }): BusinessDate => addDays(plan.nextDueOn, -plan.reminderDays)

/**
 * Whether the reminder of the plan's next due date goes now: the plan is active, its window opened (the due date minus
 * the lead time) and no reminder went for this due date yet. A command that moves the next due date clears
 * lastRemindedAt, so each due date is reminded once.
 */
export function reminderDue(plan: { readonly status: CheckPlanStatus; readonly nextDueOn: BusinessDate; readonly reminderDays: number; readonly lastRemindedAt: Date | null }, today: BusinessDate): boolean {
  return plan.status === 'ACTIVE' && plan.lastRemindedAt === null && today >= reminderFromOf(plan)
}

/** The plan's future occurrences after its next due date, inside [from, to] (the calendar's planned chips). */
export function projectedDates(plan: { readonly nextDueOn: BusinessDate; readonly interval: number; readonly intervalUnit: CheckIntervalUnit }, from: BusinessDate, to: BusinessDate, max: number = CHECK_LIMITS.projected): BusinessDate[] {
  const dates: BusinessDate[] = []
  let step = 1
  let next = addInterval(plan.nextDueOn, plan.interval, plan.intervalUnit)
  while (next <= to && dates.length < max) {
    if (next >= from) dates.push(next)
    step++
    // From the next due date each time (a month-end date stays month-end where it can).
    next = addInterval(plan.nextDueOn, plan.interval * step, plan.intervalUnit)
  }
  return dates
}

export interface ResultDraft {
  readonly performedOn: BusinessDate
  readonly outcome: CheckOutcome
  readonly remarks?: string | null | undefined
  readonly performedBy: string
  readonly nextDueOn?: BusinessDate | null | undefined
  readonly correctsId?: string | null | undefined
  readonly correctionReason?: string | null | undefined
}

/** A result's own fields, before anything is read; paths without `body/`. */
export function resultProblems(draft: ResultDraft, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (draft.performedOn > today) problems.push({ path: 'performedOn', message: 'A check is recorded once it is done: the day is today or before.' })
  if (draft.outcome !== 'PASSED' && !draft.remarks?.trim()) problems.push({ path: 'remarks', message: draft.outcome === 'FAILED' ? 'Say what failed.' : 'Say what the remarks are.' })
  if (draft.remarks !== undefined && draft.remarks !== null && draft.remarks.trim() === '' && draft.outcome === 'PASSED') problems.push({ path: 'remarks', message: 'Leave the remarks out instead of blank words.' })
  if (draft.remarks && draft.remarks.trim().length > CHECK_LIMITS.text) problems.push({ path: 'remarks', message: `At most ${CHECK_LIMITS.text} characters.` })
  if (!draft.performedBy.trim()) problems.push({ path: 'performedBy', message: 'Say who did the check, as on the report: the outside body or the inspector.' })
  else if (draft.performedBy.trim().length > CHECK_LIMITS.performedBy) problems.push({ path: 'performedBy', message: `At most ${CHECK_LIMITS.performedBy} characters.` })
  if (draft.nextDueOn && draft.nextDueOn <= draft.performedOn) problems.push({ path: 'nextDueOn', message: 'The next due date is after the day the check was done.' })
  const corrects = Boolean(draft.correctsId)
  const reason = Boolean(draft.correctionReason?.trim())
  if (corrects && !reason) problems.push({ path: 'correctionReason', message: 'Say why the result is corrected.' })
  if (!corrects && reason) problems.push({ path: 'correctsId', message: 'Name the result this one corrects.' })
  if (draft.correctionReason && draft.correctionReason.trim().length > CHECK_LIMITS.reason) problems.push({ path: 'correctionReason', message: `At most ${CHECK_LIMITS.reason} characters.` })
  return problems
}

/** A job may be made of a failed check or of one with remarks (the database's rule on MaintenanceJob.checkResultId). */
export const takesJob = (outcome: CheckOutcome): boolean => outcome === 'FAILED' || outcome === 'PASSED_WITH_REMARKS'
/** The machine is locked as unsafe from a failed check only (design: "Failed → Make a job and Lock as unsafe"). */
export const takesLock = (outcome: CheckOutcome): boolean => outcome === 'FAILED'

/** The job a check makes starts as: SAFETY · P1 for a failed check, CORRECTIVE · P2 for remarks. */
export const jobDefaultsOf = (outcome: CheckOutcome): { readonly type: 'SAFETY' | 'CORRECTIVE'; readonly priority: 'P1' | 'P2' } => (outcome === 'FAILED' ? { type: 'SAFETY', priority: 'P1' } : { type: 'CORRECTIVE', priority: 'P2' })

/** The job's problem in words (English: a job's problem is typed text; the screens prefill their own words). */
export function jobProblemOf(input: { readonly outcome: CheckOutcome; readonly typeLabel: string; readonly performedOn: BusinessDate; readonly remarks: string | null }): string {
  const head = input.outcome === 'FAILED' ? `Failed check "${input.typeLabel}" of ${input.performedOn}` : `Check "${input.typeLabel}" of ${input.performedOn} passed with remarks`
  return (input.remarks ? `${head}: ${input.remarks}` : head).slice(0, CHECK_LIMITS.text)
}

/** The words of the lock request a failed check makes (the request's description; English, typed text). */
export function lockWordsOf(input: { readonly typeLabel: string; readonly performedOn: BusinessDate; readonly remarks: string | null; readonly note: string | null }): string {
  const parts = [`Locked as unsafe after the failed check "${input.typeLabel}" of ${input.performedOn}`, input.remarks ? `: ${input.remarks}` : '', input.note ? ` (${input.note})` : '']
  return parts.join('').slice(0, CHECK_LIMITS.text)
}

// ---- refusals ------------------------------------------------------------------------------------------------------------

export const STATUTORY_REFUSALS = [
  'TYPE_TAKEN',
  'TYPE_RETIRED',
  'TYPE_OTHER_CLASS',
  'TOO_MANY_TYPES',
  'MACHINE_RETIRED',
  'PLAN_EXISTS',
  'PLAN_ENDED',
  'PLAN_OTHER',
  'BEFORE_FIRST_DUE',
  'SAME_DATE',
  'CORRECTED_ALREADY',
  'CORRECTS_OTHER',
  'NO_JOB_FOR_PASSED',
  'LOCK_NEEDS_FAILED',
  'JOB_EXISTS',
  'LOCKED_ALREADY',
] as const
export type StatutoryRefusalCode = (typeof STATUTORY_REFUSALS)[number]

export interface StatutoryRefusal {
  readonly code: StatutoryRefusalCode
  /** What happened and why, in words. */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
}

const refusal = (code: StatutoryRefusalCode, message: string, fix: string): StatutoryRefusal => ({ code, message, fix })

export const typeTaken = (code: string, active: boolean): StatutoryRefusal =>
  refusal('TYPE_TAKEN', `Check type ${code} exists${active ? '' : ' (retired)'}.`, active ? 'Pick another code, or change the type that has it.' : 'Make the retired type active again instead.')
export const tooManyTypes = (): StatutoryRefusal => refusal('TOO_MANY_TYPES', `At most ${CHECK_LIMITS.types} check types.`, 'Retire the types no longer used first.')
export const typeRetired = (code: string): StatutoryRefusal => refusal('TYPE_RETIRED', `Check type ${code} is retired: it takes no new plan.`, 'Make the type active again in Plant settings, or pick another type.')
export const typeOtherClass = (code: string, assetNumber: string): StatutoryRefusal =>
  refusal('TYPE_OTHER_CLASS', `Check type ${code} is for another class of machine than ${assetNumber}.`, 'Pick a check type of this machine\'s class, or one for any machine.')
export const machineRetired = (assetNumber: string): StatutoryRefusal => refusal('MACHINE_RETIRED', `Machine ${assetNumber} is retired: it takes no new check plan or result.`, 'Pick a machine in use.')
export const planExists = (code: string, assetNumber: string, nextDueOn: BusinessDate): StatutoryRefusal =>
  refusal('PLAN_EXISTS', `Machine ${assetNumber} has a plan for check ${code} already (next due ${nextDueOn}).`, 'Change that plan, or give a reason to end it and start the new one in its place.')
export const planEnded = (): StatutoryRefusal => refusal('PLAN_ENDED', 'This check plan is ended: it never changes and takes no more results.', 'Record the check out of plan, or start a new plan for the machine.')
export const planOther = (): StatutoryRefusal => refusal('PLAN_OTHER', 'The plan named is of another machine or check type.', 'Pick the plan of this machine and check type, or leave the plan out.')
export const beforeFirstDue = (firstDueOn: BusinessDate): StatutoryRefusal =>
  refusal('BEFORE_FIRST_DUE', `A check of this plan is never due before its first due date (${firstDueOn}).`, `Pick ${firstDueOn} or later, or start a new plan with an earlier first date.`)
export const sameDate = (nextDueOn: BusinessDate): StatutoryRefusal => refusal('SAME_DATE', `The check is due on ${nextDueOn} already.`, 'Pick another date.')
export const correctedAlready = (): StatutoryRefusal => refusal('CORRECTED_ALREADY', 'This result was corrected already: a result is corrected once.', 'Correct the newer result instead.')
export const correctsOther = (): StatutoryRefusal => refusal('CORRECTS_OTHER', 'A correction is of a result of the same machine and check type.', 'Pick the result of this machine and check type.')
export const noJobForPassed = (): StatutoryRefusal => refusal('NO_JOB_FOR_PASSED', 'A check that passed makes no job.', 'Make a job by hand in Maintenance jobs if the machine needs one.')
export const lockNeedsFailed = (): StatutoryRefusal =>
  refusal('LOCK_NEEDS_FAILED', 'Only a failed check locks the machine from here.', 'Report the machine as unsafe in Machine requests if it is unsafe: anyone may (Owner answer H1).')
export const jobExists = (number: string): StatutoryRefusal => refusal('JOB_EXISTS', `Job ${number} was made of this check and is still open.`, `Open job ${number} instead.`)
export const lockedAlready = (assetNumber: string): StatutoryRefusal =>
  refusal('LOCKED_ALREADY', `Machine ${assetNumber} is locked as unsafe already: it stays do-not-use until a technician signs it safe.`, 'Record the result without the lock; the technician signs the machine safe when it is.')

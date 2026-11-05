import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { addDays, addMonths, daysBetween, DUE_SOON_DAYS } from '../calendar/rules'

/**
 * Health surveillance, the sorveglianza sanitaria (B-W2b-135; QHS-252 plans per role, QHS-253 visits and the due list, QHS-254
 * fitness judgements only, QHS-256 strict access; design plant.health SCR-212; D.Lgs. 81/2008 art. 41; GDPR art. 9), pure. The
 * tables are factory-db health.prisma's HealthPlan (one per role sheet: needed, how often, the doctor), HealthVisit (a person's
 * visit: its type, due day, booking, done or cancelled; a return visit carries the absence's LENGTH only) and FitnessJudgement
 * (the outcome, the task limits the doctor wrote for the task, the day, the expiry: never a diagnosis), and ProtectedView (every
 * view of a visit or a judgement); their guards hold the same shape for every login.
 *
 * Nothing clinical exists anywhere: four outcomes, fixed reasons, dates. The only words a person types are the task limits
 * ("no lifting over 15 kg") and the booked place; the task limits are checked for words that name a medical reason
 * (`clinicalWordsIn`), since the form's hint says "never the medical reason" and the database cannot read meaning.
 *
 * Live use waits for the company doctor (W2b plan §3, gate 5): until the occupational doctor confirms the plans and how the
 * judgements are recorded, the paper route stays. Nothing builds itself from a plan the doctor has not set (a plan with its
 * doctor recorded): such a plan's visits are proposals for HR to plan by hand.
 */

export const HEALTH_LAW = 'D.Lgs. 81/2008 art. 41'
export const PROTECTED_HEALTH_LAW = 'GDPR art. 9; D.Lgs. 81/2008 artt. 25, 41'
export const JUDGEMENT_LAW = 'D.Lgs. 81/2008 art. 41 c.6'
export const RETURN_VISIT_LAW = 'D.Lgs. 81/2008 art. 41 c.2 e-ter'

export const VISIT_TYPES = ['PREVENTIVE', 'PERIODIC', 'ON_REQUEST', 'CHANGE_OF_TASK', 'RETURN_AFTER_ABSENCE', 'END_OF_EMPLOYMENT'] as const
export type VisitType = (typeof VISIT_TYPES)[number]
export const VISIT_STATUSES = ['DUE', 'BOOKED', 'DONE', 'CANCELLED'] as const
export type VisitStatus = (typeof VISIT_STATUSES)[number]
export const OPEN_VISIT_STATUSES = ['DUE', 'BOOKED'] as const satisfies readonly VisitStatus[]
export const VISIT_CANCEL_REASONS = ['NOT_NEEDED', 'LEFT', 'REPLACED', 'MISTAKE'] as const
export type VisitCancelReason = (typeof VISIT_CANCEL_REASONS)[number]
export const FITNESS_OUTCOMES = ['FIT', 'FIT_WITH_LIMITS', 'TEMPORARILY_UNFIT', 'UNFIT'] as const
export type FitnessOutcome = (typeof FITNESS_OUTCOMES)[number]
export const VOID_REASONS = ['WRONG_PERSON', 'WRONG_DETAILS', 'DUPLICATE'] as const
export type VoidReason = (typeof VOID_REASONS)[number]

/** A visit's state for the due list (DueCell): late, within 30 days, later, booked, done, cancelled. */
export const VISIT_STATES = ['OVERDUE', 'DUE_SOON', 'PLANNED', 'BOOKED', 'DONE', 'CANCELLED'] as const
export type VisitState = (typeof VISIT_STATES)[number]
/** A judgement's state: the person's newest not voided is in force (or expiring within 30 days, or expired); older ones are superseded. */
export const JUDGEMENT_STATES = ['IN_FORCE', 'EXPIRING', 'EXPIRED', 'SUPERSEDED', 'VOIDED'] as const
export type JudgementState = (typeof JUDGEMENT_STATES)[number]
/** Why a visit is proposed ("Plan visits"). */
export const PROPOSAL_REASONS = ['STARTER', 'NOTHING_ON_FILE', 'ROLE_CHANGED', 'PERIODIC', 'JUDGEMENT_EXPIRES', 'UNFIT_ENDS'] as const
export type ProposalReason = (typeof PROPOSAL_REASONS)[number]
/** The view log of the health page (factory-db ProtectedRecordType, the health ones). */
export const HEALTH_VIEW_RECORDS = ['HEALTH_VISIT', 'FITNESS_JUDGEMENT', 'HEALTH_VISIT_LIST'] as const
export type HealthViewRecord = (typeof HEALTH_VIEW_RECORDS)[number]
export const VIEW_WHATS = ['OPEN', 'LIST', 'COPY', 'PRINT'] as const
export type ViewWhat = (typeof VIEW_WHATS)[number]
/** The health reasons of an absence whose length makes a return visit due (factory-db AbsenceCategory): sickness and injury. */
export const HEALTH_ABSENCE_CATEGORIES = ['SICKNESS', 'INJURY'] as const

export const HEALTH_LIMITS = Object.freeze({
  taskLimits: 1000,
  bookedPlace: 200,
  /** Rows per page of the due list; visits planned or booked at once; judgements shown at once. */
  list: 200,
  items: 100,
  show: 100,
  /** A return visit: more than 60 continuous days (art. 41 c.2 e-ter), at most ten years (the guard). */
  absenceDaysMin: 61,
  absenceDaysMax: 3650,
  /** Health absence days this far apart still count as one continuous absence (a weekend and a holiday between). */
  absenceGapDays: 4,
  frequencyMin: 1,
  frequencyMax: 60,
  /** "Plan visits" looks this many days ahead by default, at most `horizonMax`. */
  horizonDays: 60,
  horizonMax: 400,
  /** A judgement expiring within these days is EXPIRING; "Temporary unfit ending in 14 days". */
  expiringDays: DUE_SOON_DAYS,
  unfitEndingDays: 14,
  /** A person who started this many days ago or less, or starts later, is a starter (a visit before the task). */
  starterDays: 30,
  /** Rows of "Who looked". */
  views: 500,
})

export const TASK_LIMITS_HINT = Object.freeze({
  en: 'Write the task limit only, e.g. no lifting over 15 kg. Never the medical reason.',
  it: 'Scrivi solo la limitazione per la mansione, ad es. niente sollevamento oltre 15 kg. Mai il motivo medico.',
})

export const PRIVACY_WORDS = Object.freeze({
  en: 'Protected · HR and the occupational doctor · every view recorded',
  it: 'Protetto · HR e medico competente · ogni consultazione è registrata',
})

export const LIVE_USE_WORDS = Object.freeze({
  en: 'Live use waits for the company doctor: until the occupational doctor confirms the plans and how judgements are recorded here, keep the paper route. Only the judgement is kept, never a diagnosis.',
  it: 'L’uso reale attende il medico competente: finché non conferma i piani e come si registrano qui i giudizi, resta la via cartacea. Si conserva solo il giudizio, mai una diagnosi.',
})

export const AUTOMATIC_WORDS = Object.freeze({
  en: 'Visits plan themselves only from plans the doctor set: a starter or a role change, a return after more than 60 days of sickness (its length only), the periodic visit and the end of employment. A plan without its doctor proposes; HR plans by hand.',
  it: 'Le visite si pianificano da sole solo dai piani fissati dal medico: assunzione o cambio mansione, rientro dopo oltre 60 giorni di malattia (solo la durata), periodica e fine rapporto. Un piano senza medico propone; l’HR pianifica a mano.',
})

// ---- no clinical words ----------------------------------------------------------------------------------------------------

/**
 * Words that name a medical reason rather than a limit for the task (Italian and English stems, lower case). Not a medical
 * dictionary: the commonest ways a reason slips into a limit ("ernia del disco: niente sollevamento"). The form refuses them in
 * words and asks for the limit only.
 */
export const CLINICAL_STEMS = Object.freeze([
  'diagnos', 'patolog', 'malatti', 'disease', 'illness', 'sindrom', 'syndrom', 'ernia', 'hernia', 'diabet', 'epiless', 'epilep',
  'tumor', 'tumour', 'cancr', 'cancer', 'oncolog', 'depress', 'ansia', 'anxiet', 'psichiatr', 'psychiatr', 'gravid', 'pregnan',
  'hiv', 'asma', 'asthma', 'cardiopat', 'infart', 'ictus', 'terapi', 'therap', 'farmac', 'medication', 'medicin', 'allergi',
  'allergy', 'artros', 'arthrit', 'osteopor', 'sclerosi', 'invalidit', 'disabilit', 'handicap', 'chirurg', 'surgery', 'frattur',
  'fracture', 'lombalgi', 'cervicalg', 'sciatic', 'tunnel carpale', 'carpal tunnel', 'ipertens', 'hypertens', 'alcol',
  'alcohol', 'droga', 'drug', 'tossicodip', 'addict',
])

/** The medical words found in a text (empty: none). Matched at the start of a word, any case. */
export function clinicalWordsIn(text: string | null | undefined): string[] {
  if (!text) return []
  const lower = ` ${text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')} `
  const found = new Set<string>()
  for (const stem of CLINICAL_STEMS) {
    const at = lower.search(new RegExp(`[^a-z0-9]${stem.replace(/ /g, '\\s+')}`))
    if (at >= 0) found.add(stem)
  }
  return [...found]
}

// ---- the shapes of a judgement and a visit ----------------------------------------------------------------------------------

export interface JudgementInput {
  readonly outcome: FitnessOutcome
  readonly taskLimits?: string | null | undefined
  readonly unfitUntil?: BusinessDate | null | undefined
  readonly judgedOn: BusinessDate
  readonly expiresOn?: BusinessDate | null | undefined
  readonly today: BusinessDate
}

/** What is wrong with a judgement as typed (paths are body fields). */
export function judgementProblems(input: JudgementInput): Issue[] {
  const problems: Issue[] = []
  const limits = input.taskLimits?.trim() ?? ''
  if (input.outcome === 'FIT_WITH_LIMITS') {
    if (limits === '') problems.push({ path: 'taskLimits', message: `Fit with limits says the limits for the task. ${TASK_LIMITS_HINT.en}` })
    else if (limits.length > HEALTH_LIMITS.taskLimits) problems.push({ path: 'taskLimits', message: `The task limits take at most ${HEALTH_LIMITS.taskLimits} characters.` })
    else {
      const words = clinicalWordsIn(limits)
      if (words.length > 0) problems.push({ path: 'taskLimits', message: `The task limits name a medical reason (${words.join(', ')}). ${TASK_LIMITS_HINT.en}` })
    }
  } else if (limits !== '') problems.push({ path: 'taskLimits', message: 'Only a judgement fit with limits carries task limits.' })
  if (input.outcome === 'TEMPORARILY_UNFIT') {
    if (!input.unfitUntil) problems.push({ path: 'unfitUntil', message: 'Temporarily unfit says until which day.' })
    else if (input.unfitUntil <= input.judgedOn) problems.push({ path: 'unfitUntil', message: 'Unfit until a day after the judgement’s.' })
  } else if (input.unfitUntil) problems.push({ path: 'unfitUntil', message: 'Only a judgement temporarily unfit says until when.' })
  if (input.judgedOn > input.today) problems.push({ path: 'judgedOn', message: 'The judgement’s day is today at the latest.' })
  if (input.outcome === 'UNFIT' && input.expiresOn) problems.push({ path: 'expiresOn', message: 'A judgement unfit for the task does not expire.' })
  else if (input.expiresOn && input.expiresOn <= input.judgedOn) problems.push({ path: 'expiresOn', message: 'It expires after the judgement’s day.' })
  return problems
}

export interface VisitInput {
  readonly type: VisitType
  readonly absenceDays?: number | null | undefined
}

/** What is wrong with a visit as typed: a return visit carries the absence's length in days (above 60), and only it does. */
export function visitProblems(input: VisitInput, path = ''): Issue[] {
  const at = (field: string) => (path ? `${path}/${field}` : field)
  if (input.type === 'RETURN_AFTER_ABSENCE') {
    if (input.absenceDays === undefined || input.absenceDays === null) return [{ path: at('absenceDays'), message: 'A return visit says how many days the absence lasted (only its length, never its reason).' }]
    if (input.absenceDays < HEALTH_LIMITS.absenceDaysMin || input.absenceDays > HEALTH_LIMITS.absenceDaysMax) return [{ path: at('absenceDays'), message: `A return visit is due after more than 60 continuous days of absence for health reasons (${RETURN_VISIT_LAW}): ${HEALTH_LIMITS.absenceDaysMin} to ${HEALTH_LIMITS.absenceDaysMax} days.` }]
    return []
  }
  if (input.absenceDays !== undefined && input.absenceDays !== null) return [{ path: at('absenceDays'), message: 'Only a return visit carries the absence’s length.' }]
  return []
}

// ---- states -------------------------------------------------------------------------------------------------------------------

export interface VisitFacts {
  readonly employeeId: string
  readonly type: VisitType
  readonly status: VisitStatus
  readonly dueOn: BusinessDate
  readonly bookedOn?: BusinessDate | null
  readonly doneOn?: BusinessDate | null
}

/** The due list's state of a visit: a booked visit counts from its booked day, a due one from its due day. */
export function visitStateOf(visit: Pick<VisitFacts, 'status' | 'dueOn' | 'bookedOn'>, today: BusinessDate): VisitState {
  if (visit.status === 'DONE') return 'DONE'
  if (visit.status === 'CANCELLED') return 'CANCELLED'
  if (visit.status === 'BOOKED' && visit.bookedOn) return visit.bookedOn < today ? 'OVERDUE' : 'BOOKED'
  if (visit.dueOn < today) return 'OVERDUE'
  if (daysBetween(today, visit.dueOn) <= DUE_SOON_DAYS) return 'DUE_SOON'
  return 'PLANNED'
}

export interface JudgementFacts {
  readonly id: string
  readonly employeeId: string
  readonly outcome: FitnessOutcome
  readonly judgedOn: BusinessDate
  readonly expiresOn: BusinessDate | null
  readonly unfitUntil: BusinessDate | null
  readonly voided: boolean
  /** When it was recorded (ISO): the later of two on the same day is the newer. */
  readonly createdAt: string
}

/** A person's judgement: the newest not voided, by its day then by when it was recorded. */
export function currentJudgement<J extends Pick<JudgementFacts, 'judgedOn' | 'voided' | 'createdAt'>>(judgements: readonly J[]): J | null {
  let best: J | null = null
  for (const judgement of judgements) {
    if (judgement.voided) continue
    if (!best || judgement.judgedOn > best.judgedOn || (judgement.judgedOn === best.judgedOn && judgement.createdAt > best.createdAt)) best = judgement
  }
  return best
}

/** One judgement's state, given the id of the person's current one. */
export function judgementStateOf(judgement: Pick<JudgementFacts, 'id' | 'expiresOn' | 'voided'>, currentId: string | null, today: BusinessDate): JudgementState {
  if (judgement.voided) return 'VOIDED'
  if (judgement.id !== currentId) return 'SUPERSEDED'
  if (judgement.expiresOn && judgement.expiresOn < today) return 'EXPIRED'
  if (judgement.expiresOn && daysBetween(today, judgement.expiresOn) <= HEALTH_LIMITS.expiringDays) return 'EXPIRING'
  return 'IN_FORCE'
}

/**
 * Fit yes or no (design people.skills "Authorise a machine": "fitness valid (yes / no only, no detail)"): the person's current
 * judgement says fit, with or without limits, and has not expired. Temporarily unfit, unfit, expired or none on file: no. The
 * limits never travel with the answer (whether a limit touches a machine is for HR and the doctor to read).
 */
export function fitYesNo(current: Pick<JudgementFacts, 'outcome' | 'expiresOn'> | null, today: BusinessDate): boolean {
  if (!current) return false
  if (current.outcome !== 'FIT' && current.outcome !== 'FIT_WITH_LIMITS') return false
  return current.expiresOn === null || current.expiresOn >= today
}

// ---- what is due (the due list builds itself) ------------------------------------------------------------------------------

export interface PersonInPlan {
  readonly employeeId: string
  readonly roleSheetId: string
  readonly startDate: BusinessDate
  /** The day the person took the role (their newest role change, else their start). */
  readonly roleSince: BusinessDate
}

export interface PlanFacts {
  readonly planId: string
  readonly roleSheetId: string
  readonly needed: boolean
  readonly frequencyMonths: number | null
  readonly endOfEmploymentVisit: boolean
  /** The plan names its doctor: the doctor set it (visits then plan themselves). */
  readonly doctorSet: boolean
}

export interface Proposal {
  readonly employeeId: string
  readonly roleSheetId: string
  readonly planId: string
  readonly type: VisitType
  readonly dueOn: BusinessDate
  readonly why: ProposalReason
  readonly doctorSet: boolean
}

const later = (a: BusinessDate | null, b: BusinessDate | null): BusinessDate | null => (a === null ? b : b === null ? a : a > b ? a : b)

/**
 * The visits a person in a role that needs surveillance is due and nobody planned yet ("Plan visits"): nothing when a visit of
 * theirs is open (due or booked) or their judgement says unfit for the task (a decision for HR and the doctor, not a visit).
 * Nothing on file: a visit before the task (a starter, due the day they take the role) or, for someone who has worked here
 * longer, one due today. On file (the last visit done or the current judgement's day): a role taken after it, by a change after
 * the start (a visit before hiring is the role's own), asks a change-of-task visit on the day it was taken; else the periodic one
 * at the plan's frequency, sooner when the judgement expires
 * or a temporary unfitness ends first. Only what falls due within `horizonDays` (late ones included).
 */
export function visitProposals(input: {
  readonly today: BusinessDate
  readonly horizonDays: number
  readonly people: readonly PersonInPlan[]
  readonly plans: ReadonlyMap<string, PlanFacts>
  readonly visits: readonly VisitFacts[]
  readonly judgements: readonly JudgementFacts[]
}): Proposal[] {
  const until = addDays(input.today, input.horizonDays)
  const proposals: Proposal[] = []
  for (const person of input.people) {
    const plan = input.plans.get(person.roleSheetId)
    if (!plan || !plan.needed) continue
    const own = input.visits.filter((visit) => visit.employeeId === person.employeeId)
    if (own.some((visit) => visit.status === 'DUE' || visit.status === 'BOOKED')) continue
    const current = currentJudgement(input.judgements.filter((judgement) => judgement.employeeId === person.employeeId))
    if (current?.outcome === 'UNFIT') continue
    const lastDone = own.filter((visit) => visit.status === 'DONE' && visit.doneOn).reduce<BusinessDate | null>((at, visit) => later(at, visit.doneOn!), null)
    const last = later(lastDone, current?.judgedOn ?? null)
    let type: VisitType
    let dueOn: BusinessDate
    let why: ProposalReason
    if (last === null) {
      const starter = daysBetween(person.startDate, input.today) <= HEALTH_LIMITS.starterDays
      type = 'PREVENTIVE'
      why = starter ? 'STARTER' : 'NOTHING_ON_FILE'
      dueOn = starter ? person.roleSince : input.today
    } else if (person.roleSince > last && person.roleSince > person.startDate) {
      type = 'CHANGE_OF_TASK'
      why = 'ROLE_CHANGED'
      dueOn = person.roleSince
    } else {
      type = 'PERIODIC'
      why = 'PERIODIC'
      dueOn = addMonths(last, plan.frequencyMonths ?? 12)
      if (current?.expiresOn && current.expiresOn < dueOn) {
        dueOn = current.expiresOn
        why = 'JUDGEMENT_EXPIRES'
      }
      if (current?.outcome === 'TEMPORARILY_UNFIT' && current.unfitUntil && current.unfitUntil < dueOn) {
        dueOn = current.unfitUntil
        why = 'UNFIT_ENDS'
      }
    }
    if (dueOn <= until) proposals.push({ employeeId: person.employeeId, roleSheetId: person.roleSheetId, planId: plan.planId, type, dueOn, why, doctorSet: plan.doctorSet })
  }
  return proposals.sort((a, b) => (a.dueOn === b.dueOn ? a.employeeId.localeCompare(b.employeeId) : a.dueOn < b.dueOn ? -1 : 1))
}

/** The proposals that plan themselves (the daily pass): from a plan the doctor set, the periodic ones only. */
export const automaticProposals = (proposals: readonly Proposal[]): Proposal[] => proposals.filter((proposal) => proposal.doctorSet && (proposal.why === 'PERIODIC' || proposal.why === 'JUDGEMENT_EXPIRES' || proposal.why === 'UNFIT_ENDS'))

/**
 * A role change's visit (design plant.health "employee.role_changed → change-of-task visit due", "employee.created → before-task
 * visit due"): the new role's plan needs visits and the doctor set it. A first role for a starter (started within 30 days or
 * later) asks a visit before the task, due the day they start or today; a move from another role a change-of-task visit, due
 * today. A first role for someone who has worked here longer plans nothing by itself (their paper judgement may be on file
 * soon: "Plan visits" proposes it).
 */
export function roleChangeVisit(input: { readonly fromRoleSheetId: string | null; readonly plan: PlanFacts | null; readonly startDate: BusinessDate; readonly today: BusinessDate }): { readonly type: VisitType; readonly dueOn: BusinessDate } | null {
  if (!input.plan || !input.plan.needed || !input.plan.doctorSet) return null
  if (input.fromRoleSheetId !== null) return { type: 'CHANGE_OF_TASK', dueOn: input.today }
  if (daysBetween(input.startDate, input.today) > HEALTH_LIMITS.starterDays) return null
  return { type: 'PREVENTIVE', dueOn: input.startDate > input.today ? input.startDate : input.today }
}

export interface AbsenceRun {
  readonly from: BusinessDate
  readonly to: BusinessDate
  /** Calendar days from the first to the last absent day. */
  readonly days: number
}

/**
 * The continuous absences for health reasons in a person's absence days (sickness or injury; any order, repeats allowed): days
 * at most `absenceGapDays` apart are one absence (a weekend and a holiday have no absence entry). Only the length leaves this
 * function: never a code, a reason or a document.
 */
export function absenceRunsOf(days: readonly BusinessDate[]): AbsenceRun[] {
  const sorted = [...new Set(days)].sort()
  const runs: AbsenceRun[] = []
  let from: BusinessDate | null = null
  let to: BusinessDate | null = null
  for (const day of sorted) {
    if (from === null || to === null) {
      from = day
      to = day
    } else if (daysBetween(to, day) <= HEALTH_LIMITS.absenceGapDays) to = day
    else {
      runs.push({ from, to, days: daysBetween(from, to) + 1 })
      from = day
      to = day
    }
  }
  if (from !== null && to !== null) runs.push({ from, to, days: daysBetween(from, to) + 1 })
  return runs
}

/**
 * The return visit an absence asks (art. 41 c.2 e-ter: before going back after more than 60 continuous days away for health
 * reasons): due the day after its last absent day, the length capped at the guard's ten years. Only an absence still running
 * or ended within `recentDays`.
 */
export function returnVisitOf(run: AbsenceRun, today: BusinessDate, recentDays = 30): { readonly absenceDays: number; readonly dueOn: BusinessDate } | null {
  if (run.days < HEALTH_LIMITS.absenceDaysMin) return null
  if (daysBetween(run.to, today) > recentDays) return null
  return { absenceDays: Math.min(run.days, HEALTH_LIMITS.absenceDaysMax), dueOn: addDays(run.to, 1) }
}

// ---- tiles ---------------------------------------------------------------------------------------------------------------------

export interface HealthTiles {
  readonly overdue: number
  readonly dueIn30: number
  /** Before-task visits needed: open visits before the task or for a change of task, and such visits nobody planned yet. */
  readonly beforeTask: number
  /** Open return visits (absence over 60 days). */
  readonly returnVisits: number
  /** Current judgements temporarily unfit whose day ends within 14 days. */
  readonly unfitEnding: number
}

export function healthTiles(input: { readonly visits: readonly VisitFacts[]; readonly proposals: readonly Pick<Proposal, 'type'>[]; readonly current: readonly Pick<JudgementFacts, 'outcome' | 'unfitUntil'>[]; readonly today: BusinessDate }): HealthTiles {
  const open = input.visits.filter((visit) => visit.status === 'DUE' || visit.status === 'BOOKED')
  const states = open.map((visit) => visitStateOf(visit, input.today))
  const beforeTask = (type: VisitType) => type === 'PREVENTIVE' || type === 'CHANGE_OF_TASK'
  const ending = addDays(input.today, HEALTH_LIMITS.unfitEndingDays)
  return {
    overdue: states.filter((state) => state === 'OVERDUE').length,
    dueIn30: open.filter((visit, i) => states[i] !== 'OVERDUE' && daysBetween(input.today, visit.status === 'BOOKED' && visit.bookedOn ? visit.bookedOn : visit.dueOn) <= DUE_SOON_DAYS).length,
    beforeTask: open.filter((visit) => beforeTask(visit.type)).length + input.proposals.filter((proposal) => beforeTask(proposal.type)).length,
    returnVisits: open.filter((visit) => visit.type === 'RETURN_AFTER_ABSENCE').length,
    unfitEnding: input.current.filter((judgement) => judgement.outcome === 'TEMPORARILY_UNFIT' && judgement.unfitUntil !== null && judgement.unfitUntil >= input.today && judgement.unfitUntil <= ending).length,
  }
}

// ---- refusals -------------------------------------------------------------------------------------------------------------------

export const HEALTH_REFUSALS = [
  'PERSON_LEFT',
  'NO_ROLE',
  'ROLE_OTHER_SITE',
  'PLAN_NOT_NEEDED',
  'OPEN_VISIT_EXISTS',
  'VISIT_CLOSED',
  'VISIT_NOT_BOOKED',
  'BOOKED_IN_PAST',
  'VISIT_OTHER_PERSON',
  'VISIT_CANCELLED',
  'VISIT_JUDGED',
  'JUDGEMENT_VOIDED',
  'NOT_A_DOCTOR',
  'PLAN_ARCHIVED',
  'NOT_EXIT_STEP',
  'EXIT_VISIT_NOT_DONE',
] as const
export type HealthRefusalCode = (typeof HEALTH_REFUSALS)[number]
export interface HealthRefusal {
  readonly code: HealthRefusalCode
  readonly message: string
  readonly field?: string
}

export const HEALTH_REFUSAL_WORDS: Readonly<Record<HealthRefusalCode, string>> = Object.freeze({
  PERSON_LEFT: 'This person has left: no visit is planned for them now (an end-of-employment visit is planned while they are leaving).',
  NO_ROLE: 'This person has no role sheet: say the role the visit is for.',
  ROLE_OTHER_SITE: 'The role sheet is of another site than the person’s.',
  PLAN_NOT_NEEDED: 'The role’s plan says it needs no surveillance visits: plan a visit on request instead, or change the role sheet first.',
  OPEN_VISIT_EXISTS: 'This person already has a visit of this type planned or booked: book or move that one.',
  VISIT_CLOSED: 'This visit is done or cancelled: it no longer changes.',
  VISIT_NOT_BOOKED: 'This visit is not booked.',
  BOOKED_IN_PAST: 'A visit is booked for today or a later day.',
  VISIT_OTHER_PERSON: 'That visit is another person’s.',
  VISIT_CANCELLED: 'A judgement comes from a visit that took place, not a cancelled one.',
  VISIT_JUDGED: 'That visit already has its judgement: void the wrong one first.',
  JUDGEMENT_VOIDED: 'This judgement is voided already.',
  NOT_A_DOCTOR: 'Name the occupational doctor’s appointment of the person’s company (Safety organisation).',
  PLAN_ARCHIVED: 'This plan is archived (its role sheet was archived).',
  NOT_EXIT_STEP: 'This step is not the end-of-employment visit.',
  EXIT_VISIT_NOT_DONE: 'Name the person’s end-of-employment visit once it took place (DONE).',
})

export const healthRefusalOf = (code: HealthRefusalCode, field?: string): HealthRefusal => ({ code, message: HEALTH_REFUSAL_WORDS[code], ...(field ? { field } : {}) })

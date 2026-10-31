import type { BusinessDate } from '../../core/time'
import { addDays } from '../employees/rules'

/**
 * Leaver steps (B-W2b-26; MES-214; design people.employees "Leavers in progress", "Start leaver steps"). Pure: the API
 * (apps/factory-api modules/people/leavers) reads the facts in its command and writes the rows; the …_people_w2b_guards
 * triggers stay the last word (one OPEN case per person, steps written only while their case is OPEN, DONE only with
 * no step open, a person LEFT only once the end date has come).
 *
 *   start     a person's last working day and the steps it needs, decided from what the person has: a floor sign-in
 *             (badge off and sessions ended, automatic; the badge handed back), an office account (access ended,
 *             automatic: a step-up act in Admin › Users, ticked when the account is deactivated), open work to hand
 *             over, PPE to hand back and the end-of-employment visit (when asked: the doctor's plan is W2b-2), shifts
 *             cleared after the last day (automatic) and the flag on the next payroll export (automatic).
 *   tick      automatic steps tick themselves (by the system: no person): after the last working day the floor sign-in
 *             is switched off (the worker deactivated, its badges revoked, its sessions ended), shifts are cleared when
 *             no shift after the last day remains, the access step when the account is deactivated. A person ticks or
 *             skips (with the reason) any step, and reopens one while the case is open.
 *   close     when no step is open and the last working day has come, the case closes (DONE) in the same command: the
 *             record becomes LEFT with its end date, its team membership ends that day.
 *   cancel    "Cancel leaving" until the last day (with the reason).
 */

/** The steps in the order the checklist shows them. */
export const LEAVER_STEP_KINDS = ['BADGE_OFF', 'SESSIONS_ENDED', 'BADGE_RETURNED', 'ACCESS_ENDED', 'WORK_HANDED_OVER', 'PPE_RETURNED', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED', 'EXIT_VISIT'] as const
export type LeaverStepKind = (typeof LEAVER_STEP_KINDS)[number]
export const AUTOMATIC_STEPS: ReadonlySet<LeaverStepKind> = new Set(['BADGE_OFF', 'SESSIONS_ENDED', 'ACCESS_ENDED', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED'])
export const LEAVER_CASE_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type LeaverCaseStatus = (typeof LEAVER_CASE_STATUSES)[number]
export const LEAVER_STEP_STATUSES = ['OPEN', 'DONE', 'SKIPPED'] as const
export type LeaverStepStatus = (typeof LEAVER_STEP_STATUSES)[number]
export const LEAVER_VIEWS = ['open', 'done', 'cancelled', 'all'] as const
export type LeaverView = (typeof LEAVER_VIEWS)[number]

/**
 * Where each step is done (design "Each step links to where it is done"): the web turns it into a link.
 *   FLOOR_SIGN_IN   the worker in Admin › Users (badge, sessions)        OFFICE_ACCOUNT   the user in Admin › Users
 *   OPEN_WORK       the person's open tasks and maintenance jobs          PPE              Plant › PPE (W2b-2)
 *   SHIFTS          People › Shifts (B-W2b-32)                            PAYROLL          People › Payroll export (B-W2b-54)
 *   HEALTH          Plant › Health surveillance (W2b-2)
 */
export const STEP_PLACES = ['FLOOR_SIGN_IN', 'OFFICE_ACCOUNT', 'OPEN_WORK', 'PPE', 'SHIFTS', 'PAYROLL', 'HEALTH'] as const
export type StepPlace = (typeof STEP_PLACES)[number]
export const STEP_PLACE: Readonly<Record<LeaverStepKind, StepPlace>> = Object.freeze({
  BADGE_OFF: 'FLOOR_SIGN_IN',
  SESSIONS_ENDED: 'FLOOR_SIGN_IN',
  BADGE_RETURNED: 'FLOOR_SIGN_IN',
  ACCESS_ENDED: 'OFFICE_ACCOUNT',
  WORK_HANDED_OVER: 'OPEN_WORK',
  PPE_RETURNED: 'PPE',
  SHIFTS_CLEARED: 'SHIFTS',
  PAYROLL_FLAGGED: 'PAYROLL',
  EXIT_VISIT: 'HEALTH',
})

export const LEAVER_LIMITS = { reason: 500, daysAhead: 366 } as const

/** What the steps are decided from. */
export interface LeaverFacts {
  /** ACTIVE floor sign-ins (workers) linked to the person. */
  readonly floorSignIns: number
  /** ACTIVE badges of those sign-ins. */
  readonly activeBadges: number
  /** An office account linked to the person. */
  readonly officeAccount: boolean
}

export interface LeaverChoices {
  /** The end-of-employment visit (when the doctor's plan says so: W2b-2 keeps the plan). */
  readonly exitVisit: boolean
  /** PPE to hand back (W2b-2 keeps the PPE issued). */
  readonly ppeReturn: boolean
}

export interface PlannedStep {
  readonly kind: LeaverStepKind
  readonly seq: number
  readonly automatic: boolean
  readonly dueOn: BusinessDate | null
}

/** The steps a leaving needs, in the checklist's order, numbered from 1. */
export function leaverStepsFor(facts: LeaverFacts, choices: LeaverChoices, lastWorkingDay: BusinessDate): PlannedStep[] {
  const wanted: { kind: LeaverStepKind; dueOn: BusinessDate | null }[] = []
  if (facts.floorSignIns > 0) {
    wanted.push({ kind: 'BADGE_OFF', dueOn: lastWorkingDay }, { kind: 'SESSIONS_ENDED', dueOn: lastWorkingDay })
  }
  if (facts.activeBadges > 0) wanted.push({ kind: 'BADGE_RETURNED', dueOn: lastWorkingDay })
  if (facts.officeAccount) wanted.push({ kind: 'ACCESS_ENDED', dueOn: lastWorkingDay })
  wanted.push({ kind: 'WORK_HANDED_OVER', dueOn: lastWorkingDay })
  if (choices.ppeReturn) wanted.push({ kind: 'PPE_RETURNED', dueOn: lastWorkingDay })
  wanted.push({ kind: 'SHIFTS_CLEARED', dueOn: addDays(lastWorkingDay, 1) }, { kind: 'PAYROLL_FLAGGED', dueOn: null })
  if (choices.exitVisit) wanted.push({ kind: 'EXIT_VISIT', dueOn: null })
  return wanted.map((step, index) => ({ ...step, seq: index + 1, automatic: AUTOMATIC_STEPS.has(step.kind) }))
}

/** The refusals of the leaver commands (a 409 whose issues are `refusal/<CODE>`; the web has the words of each). */
export const LEAVER_REFUSALS = ['LEFT', 'ALREADY_LEAVING', 'BEFORE_START', 'TOO_FAR', 'NOT_OPEN', 'PAST_LAST_DAY', 'STEP_OPEN', 'STEP_NOT_OPEN', 'STEP_KIND_TWICE', 'NO_REASON'] as const
export type LeaverRefusalCode = (typeof LEAVER_REFUSALS)[number]
export interface LeaverRefusal {
  readonly code: LeaverRefusalCode
  readonly message: string
}

/** Why a leaving cannot start (null: it can). A last day in the past is allowed: a leaver recorded late. */
export function startRefusal(facts: { readonly status: string; readonly leaving: boolean; readonly startDate: BusinessDate; readonly lastWorkingDay: BusinessDate; readonly today: BusinessDate }): LeaverRefusal | null {
  if (facts.status === 'LEFT') return { code: 'LEFT', message: 'This person has left already.' }
  if (facts.leaving) return { code: 'ALREADY_LEAVING', message: 'Leaver steps are open for this person already: change those.' }
  if (facts.lastWorkingDay < facts.startDate) return { code: 'BEFORE_START', message: 'The last working day comes on or after the start date.' }
  if (facts.lastWorkingDay > addDays(facts.today, LEAVER_LIMITS.daysAhead)) return { code: 'TOO_FAR', message: `The last working day is at most ${LEAVER_LIMITS.daysAhead} days ahead.` }
  return null
}

/** Why a leaving cannot be cancelled (null: it can): only an open one, until its last day. */
export function cancelRefusal(facts: { readonly status: LeaverCaseStatus; readonly lastWorkingDay: BusinessDate; readonly today: BusinessDate }): LeaverRefusal | null {
  if (facts.status !== 'OPEN') return { code: 'NOT_OPEN', message: 'This leaving is closed: nothing changes any more.' }
  if (facts.lastWorkingDay < facts.today) return { code: 'PAST_LAST_DAY', message: 'The last working day has passed: the leaving can no longer be cancelled (a return is a new start).' }
  return null
}

export const STEP_ACTIONS = ['DONE', 'SKIP', 'REOPEN'] as const
export type StepAction = (typeof STEP_ACTIONS)[number]

/** Why a step cannot move (null: it can). */
export function stepRefusal(caseStatus: LeaverCaseStatus, stepStatus: LeaverStepStatus, action: StepAction, reason: string | null | undefined): LeaverRefusal | null {
  if (caseStatus !== 'OPEN') return { code: 'NOT_OPEN', message: 'This leaving is closed: its steps no longer change.' }
  if (action === 'REOPEN') return stepStatus === 'OPEN' ? { code: 'STEP_OPEN', message: 'This step is open already.' } : null
  if (stepStatus !== 'OPEN') return { code: 'STEP_NOT_OPEN', message: 'This step is done or skipped: reopen it first.' }
  if (action === 'SKIP' && (reason ?? '').trim().length === 0) return { code: 'NO_REASON', message: 'Say why the step is skipped.' }
  return null
}

/** The case closes on its own when no step is open and the last working day has come. */
export const closesNow = (steps: readonly { readonly status: LeaverStepStatus }[], lastWorkingDay: BusinessDate, today: BusinessDate): boolean =>
  steps.length > 0 && steps.every((step) => step.status !== 'OPEN') && lastWorkingDay <= today

/** What the system finds about an open case's automatic steps. */
export interface AutomaticFacts {
  readonly today: BusinessDate
  readonly lastWorkingDay: BusinessDate
  /** ACTIVE floor sign-ins of the person (deactivated by the system after the last day). */
  readonly activeWorkers: number
  /** The office account is deactivated (or there is none). */
  readonly accountEnded: boolean
  /** Shifts planned for the person after the last working day. */
  readonly shiftsAfter: number
}

/** What the system does now: switch the floor sign-in off, and the automatic steps it ticks. */
export interface AutomaticPlan {
  readonly switchOffFloor: boolean
  readonly tick: readonly LeaverStepKind[]
}

/**
 * The automatic steps that tick now. The floor sign-in is switched off once the last working day is over (the day
 * after); then badge off and sessions ended tick. Access ended ticks when the account is deactivated (never done by the
 * system: a step-up act); shifts cleared once the day after has come with no shift after the last day. The payroll flag
 * is ticked by the payroll export (B-W2b-54) or a person.
 */
export function automaticPlan(facts: AutomaticFacts, open: readonly LeaverStepKind[]): AutomaticPlan {
  const over = facts.lastWorkingDay < facts.today
  const floorStep = open.includes('BADGE_OFF') || open.includes('SESSIONS_ENDED')
  const switchOffFloor = over && floorStep && facts.activeWorkers > 0
  const floorOff = over && (facts.activeWorkers === 0 || switchOffFloor)
  const tick: LeaverStepKind[] = []
  for (const kind of open) {
    if ((kind === 'BADGE_OFF' || kind === 'SESSIONS_ENDED') && floorOff) tick.push(kind)
    if (kind === 'ACCESS_ENDED' && facts.accountEnded) tick.push(kind)
    if (kind === 'SHIFTS_CLEARED' && over && facts.shiftsAfter === 0) tick.push(kind)
  }
  return { switchOffFloor, tick }
}

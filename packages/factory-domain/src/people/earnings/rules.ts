import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { standingOf, type ClockFact } from '../clock/rules'
import { monthPeriod } from '../overtime/timesheets'
import type { PeriodStatus } from '../schemes/rules'

/**
 * Earnings and pay periods (B-W2b-43; MES-256 earnings ledger, MES-264 scans pay only while clocked in, MES-148 waiting does
 * not cut pay, MES-260 pay period calculation; c.c. arts. 2100-2101), pure. apps/factory-api modules/people/earnings reads
 * the facts and writes the ledger with these rules. GATE-PIECE-PAY: nothing here pays outside a site's piece-pay window, and
 * a site's switch ships OFF.
 *
 *   window     a work day pays by the piece only inside one of the site's windows (the latest one and the earlier ones):
 *              late work of a past window stays payable after the switch went off (pay owed is never withheld)
 *   hold       a scan by a worker who was not clocked in, or on a break, at the moment of the scan is held and pays nothing
 *              until it is resolved. Only where the rule can be read at all: the scheme asks for it
 *              (payOnlyWhileClockedIn) and the site's ATTENDANCE gate is on. With the gate off there is no clock to read,
 *              and a rule nobody can meet never withholds pay
 *   pieces     a REPORT or CORRECTION reports the whole bundle at the operation, a PARTIAL the pieces done so far by
 *              someone else: the report pays what the partials did not
 *   waiting    see `paidRuleOf`: waiting on a help call is always paid, whatever the code says (c.c. art. 2100)
 *   period     OPEN → PREVIEW ⇄ OPEN, PREVIEW → REVIEW ⇄ PREVIEW, REVIEW → LOCKED, once the month is over and nothing
 *              blocks it (`periodChecks`). A LOCKED period never changes: later changes are new entries in a later period
 *              that names it
 */

export const EARNINGS_KINDS = ['SCAN', 'TEAM_SPLIT', 'MAKE_UP', 'OFF_STANDARD', 'ADJUSTMENT'] as const
export type EarningsKind = (typeof EARNINGS_KINDS)[number]
export const HOLD_REASONS = ['NOT_CLOCKED_IN', 'ON_BREAK'] as const
export type HoldReason = (typeof HOLD_REASONS)[number]
export const HOLD_STATUSES = ['OPEN', 'COUNTED', 'NOT_PAID'] as const
export type HoldStatus = (typeof HOLD_STATUSES)[number]
export const STATEMENT_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const
export type StatementStatus = (typeof STATEMENT_STATUSES)[number]

export const REASON_MIN = 3
export const REASON_MAX = 500
export const NOTE_MAX = 500
/** How far back a later period looks for waiting decided after an earlier month was locked. */
export const LATE_DAYS = 92
export const LIST_LIMIT = 200

export const HOLD_WORDS: Readonly<Record<HoldReason, string>> = Object.freeze({
  NOT_CLOCKED_IN: 'The worker was not clocked in at the time of the scan.',
  ON_BREAK: 'The worker was on a break at the time of the scan.',
})

export const NOTHING_TO_PAY_WORDS = 'The scan was undone or corrected: there is nothing left to pay on it.'
export const FIXED_BY_CLOCK_WORDS = 'The attendance now shows the worker clocked in at the time of the scan.'
export const REVERSAL_WORDS = 'The scan was undone or corrected.'
export const PERIOD_FIGURE_WORDS = 'What the period run computes changed.'
export const OWN_FAULT_WORDS = 'Scrap and rework on your own scan follow the scheme\'s own-fault rule. Dispute the entry if it was not your fault.'

// ---- windows --------------------------------------------------------------------------------------------------------------

/** One piece-pay window of a site: its first day, and the first day it no longer pays (null: still open). */
export interface PayWindow {
  readonly from: BusinessDate
  readonly to: BusinessDate | null
}

/** Every window of a site's switch, as the ledger's guard reads them. */
export function windowsOf(row: { readonly onFrom: BusinessDate | null; readonly offFrom: BusinessDate | null; readonly earlierWindows: unknown }): PayWindow[] {
  const earlier = Array.isArray(row.earlierWindows) ? (row.earlierWindows as readonly { readonly from: BusinessDate; readonly to: BusinessDate }[]).map((span) => ({ from: span.from, to: span.to })) : []
  return [...earlier, ...(row.onFrom ? [{ from: row.onFrom, to: row.offFrom }] : [])]
}

export const paysOn = (windows: readonly PayWindow[], day: BusinessDate): boolean => windows.some((window) => window.from <= day && (window.to === null || day < window.to))

// ---- clocked in? ----------------------------------------------------------------------------------------------------------

export interface ClockAt {
  /** Null: clocked in at that moment. */
  readonly hold: HoldReason | null
  /** The clock-in that covers the moment. */
  readonly clockEventId: string | null
}

/**
 * Where a person stood at a moment. The events are the person's, by employee: a clock-in HR entered (MANUAL) names no
 * floor worker. A VOID counts whenever it was written (a correction made later voids the earlier event); every other event
 * only up to the moment.
 */
export function clockAt(events: readonly ClockFact[], at: Date): ClockAt {
  const standing = standingOf(events.filter((event) => event.kind === 'VOID' || event.occurredAt.getTime() <= at.getTime()), at)
  if (standing.state === 'IN') return { hold: null, clockEventId: standing.openEventId }
  return { hold: standing.state === 'ON_BREAK' ? 'ON_BREAK' : 'NOT_CLOCKED_IN', clockEventId: null }
}

/** Does the clocked-in rule apply here? The scheme asks for it and the site's clock may be read. */
export const clockRuleApplies = (input: { readonly payOnlyWhileClockedIn: boolean | null; readonly attendanceGateOpen: boolean }): boolean => input.attendanceGateOpen && (input.payOnlyWhileClockedIn ?? true)

// ---- pieces ---------------------------------------------------------------------------------------------------------------

export const PAID_SCAN_KINDS = ['REPORT', 'CORRECTION', 'PARTIAL'] as const
export type PaidScanKind = (typeof PAID_SCAN_KINDS)[number]
export const isPaidScan = (kind: string): kind is PaidScanKind => (PAID_SCAN_KINDS as readonly string[]).includes(kind)

export interface ScanFact {
  readonly id: string
  readonly kind: string
  readonly correctsId: string | null
  readonly goodQuantity: number
}

/** The scans an UNDO or a CORRECTION of the same bundle and operation voids. */
export const voidedScans = (scans: readonly Pick<ScanFact, 'kind' | 'correctsId'>[]): Set<string> =>
  new Set(scans.flatMap((scan) => ((scan.kind === 'UNDO' || scan.kind === 'CORRECTION') && scan.correctsId ? [scan.correctsId] : [])))

/** The scans of one bundle and operation that pay, with the pieces each pays. */
export function payablePieces(scans: readonly ScanFact[]): Map<string, number> {
  const voided = voidedScans(scans)
  const standing = scans.filter((scan) => isPaidScan(scan.kind) && !voided.has(scan.id))
  const partials = standing.filter((scan) => scan.kind === 'PARTIAL').reduce((sum, scan) => sum + scan.goodQuantity, 0)
  return new Map(standing.map((scan) => [scan.id, scan.kind === 'PARTIAL' ? scan.goodQuantity : Math.max(0, scan.goodQuantity - partials)]))
}

// ---- rates ----------------------------------------------------------------------------------------------------------------

/** One rate of a site that may pay a day: an entry of a version in force, with its table. */
export interface RateCandidate {
  readonly entryId: string
  readonly operationId: string
  readonly sizeBand: string
  readonly ratePerPiece: string
  readonly standardMinutes: string | null
  readonly currency: string
  readonly status: string
  readonly effectiveFrom: BusinessDate
  readonly effectiveTo: BusinessDate | null
  readonly styleId: string | null
  readonly lineId: string | null
}

export const ALL_SIZES = 'ALL'
const PAYING = new Set(['PROVISIONAL', 'PUBLISHED', 'SUPERSEDED'])

/**
 * The rate that pays one work day: of a version in force that day, for the operation, of a table for the work order's style
 * or for none, and for the work's line or for none. The closest wins: the style's before the general table, the line's
 * before the site's, the size's own band before ALL.
 */
export function rateFor(candidates: readonly RateCandidate[], work: { readonly day: BusinessDate; readonly operationId: string; readonly styleId: string; readonly lineId: string | null; readonly size: string }): RateCandidate | null {
  const score = (rate: RateCandidate): number => (rate.styleId ? 4 : 0) + (rate.lineId ? 2 : 0) + (rate.sizeBand === work.size ? 1 : 0)
  const fits = candidates.filter(
    (rate) =>
      PAYING.has(rate.status) &&
      rate.operationId === work.operationId &&
      rate.effectiveFrom <= work.day &&
      (rate.effectiveTo === null || work.day <= rate.effectiveTo) &&
      (rate.styleId === null || rate.styleId === work.styleId) &&
      (rate.lineId === null || rate.lineId === work.lineId) &&
      (rate.sizeBand === ALL_SIZES || rate.sizeBand === work.size),
  )
  return [...fits].sort((a, b) => score(b) - score(a) || (a.entryId < b.entryId ? -1 : 1))[0] ?? null
}

// ---- waiting and paid time (MES-148) --------------------------------------------------------------------------------------

export interface BlockPayFacts {
  /** The block is the waiting while a help call was open (source HELP_CALL), or its code is one a help-call type books to. */
  readonly waiting: boolean
  /** The code's rule (read at pay time, CCNL UNVERIFIED). */
  readonly payRule: 'AVERAGE' | 'BASE' | 'UNPAID'
}

/**
 * How off-standard time pays. Waiting is never unpaid, whatever the code says: the scheme's waitingPay (c.c. art. 2100; a
 * worker waiting for help is at the employer's disposal). Other time by its code: at the average, at the guaranteed rate,
 * or not at all. Null: this block pays nothing.
 */
export function paidRuleOf(block: BlockPayFacts, scheme: { readonly waitingPay: 'AVERAGE' | 'GUARANTEED' }): 'AVERAGE' | 'GUARANTEED' | null {
  if (block.waiting) return scheme.waitingPay
  if (block.payRule === 'UNPAID') return null
  return block.payRule === 'AVERAGE' ? 'AVERAGE' : 'GUARANTEED'
}

// ---- trainees and skill weights ------------------------------------------------------------------------------------------

export interface TraineeSpan {
  readonly since: BusinessDate
  readonly traineeUntil: BusinessDate
  readonly signedOffOn: BusinessDate | null
}

/** The day falls in a span where the person is a trainee (until the day, unless signed off before). */
export const traineeOn = (spans: readonly TraineeSpan[], day: BusinessDate): boolean =>
  spans.some((span) => span.since <= day && day <= span.traineeUntil && (span.signedOffOn === null || day < span.signedOffOn))

/** A team's split by skill: the member's level in the operation's skill (no level recorded: as learning). */
export const SKILL_WEIGHTS: Readonly<Record<string, string>> = Object.freeze({ LEARNING: '1', CAN_DO: '2', EXPERT: '3', TRAINER: '3' })
export const skillWeightOf = (level: string | null | undefined): string => (level ? (SKILL_WEIGHTS[level] ?? '1') : '1')

// ---- periods --------------------------------------------------------------------------------------------------------------

/** The month of a day (YYYY-MM). */
export const monthOf = (day: BusinessDate): string => day.slice(0, 7)

/** The month after a month. */
export function monthAfter(month: string): string {
  const bounds = monthPeriod(month)
  if (!bounds) throw new RangeError(`not a month: ${month}`)
  return monthOf(plusDays(bounds.periodEnd, 1))
}

export const lockPhrase = (month: string): string => `LOCK ${month}`

export const EARNINGS_REFUSALS = [
  'WRONG_STATE',
  'NOT_OVER',
  'CHECKS_OPEN',
  'STATEMENTS_OPEN',
  'STATEMENT_STALE',
  'WRONG_PHRASE',
  'OWN_RECORD',
  'NOT_CLOCKED_IN_YET',
  'SCAN_VOIDED',
  'DECIDED',
  'NOT_DRAFT',
  'NOT_REVIEW',
  'ALREADY_REVERSED',
  'IS_REVERSAL',
  'NO_WORKER',
  'NOT_A_LEAD',
] as const
export type EarningsRefusalCode = (typeof EARNINGS_REFUSALS)[number]

export interface EarningsRefusal {
  readonly code: EarningsRefusalCode
  readonly message: string
  readonly fix?: string
}

const refusal = (code: EarningsRefusalCode, message: string, fix?: string): EarningsRefusal => Object.freeze({ code, message, ...(fix ? { fix } : {}) })

export const STATE_WORDS: Readonly<Record<PeriodStatus, string>> = Object.freeze({
  OPEN: 'open',
  PREVIEW: 'in preview',
  REVIEW: 'in review',
  LOCKED: 'locked',
})

/** A move of the period its state does not allow (the guard's transitions, in words). */
export function moveRefusal(status: PeriodStatus, move: 'RUN' | 'REOPEN' | 'START_REVIEW' | 'BACK' | 'LOCK'): EarningsRefusal | null {
  const allowed = { RUN: ['OPEN', 'PREVIEW'], REOPEN: ['PREVIEW'], START_REVIEW: ['PREVIEW'], BACK: ['REVIEW'], LOCK: ['REVIEW'] } as const
  if ((allowed[move] as readonly string[]).includes(status)) return null
  if (status === 'LOCKED') return refusal('WRONG_STATE', 'This pay period is locked: it never changes. A change is a new entry in a later period.')
  return refusal('WRONG_STATE', `This pay period is ${STATE_WORDS[status]}: that step is not open now.`, move === 'LOCK' ? 'Run the period and start its review first.' : undefined)
}

export const notOver = (month: string, today: BusinessDate): EarningsRefusal => refusal('NOT_OVER', `${month} is not over yet (today is ${today}): its review starts after its last day. A preview can run at any time.`)
export const checksOpen = (words: readonly string[]): EarningsRefusal => refusal('CHECKS_OPEN', `The review cannot start: ${words.join(' ')}`, 'Settle these, then start the review.')
export const statementsOpen = (count: number): EarningsRefusal => refusal('STATEMENTS_OPEN', `${count} ${count === 1 ? 'statement is' : 'statements are'} not approved yet: a period locks with every person's statement approved (c.c. art. 2101).`, 'Approve each statement first.')
export const statementStale = (count: number): EarningsRefusal => refusal('STATEMENT_STALE', `${count} ${count === 1 ? 'statement no longer matches' : 'statements no longer match'} the ledger: something changed after the statement was made.`, 'Take the review back, run the period, and approve again.')
export const wrongPhrase = (month: string): EarningsRefusal => refusal('WRONG_PHRASE', `Type ${lockPhrase(month)} to lock this period.`)
export const OWN_RECORD = refusal('OWN_RECORD', 'This is your own pay: another person decides it.', 'Ask another person with this right.')
export const notClockedInYet = (day: BusinessDate): EarningsRefusal =>
  refusal('NOT_CLOCKED_IN_YET', `The attendance of ${day} still does not show the worker clocked in at the time of the scan.`, 'Fix the attendance day first, or decide not to pay this scan.')
export const SCAN_VOIDED = refusal('SCAN_VOIDED', 'This scan was undone or corrected: there is nothing to count.', 'Decide not to pay it.')
export const DECIDED = refusal('DECIDED', 'This held scan was decided already: that is final.')
export const NOT_DRAFT = refusal('NOT_DRAFT', 'This statement is not a draft: a change is a new revision, from a new run of the period.')
export const NOT_REVIEW = refusal('NOT_REVIEW', 'Statements are reviewed and approved while the period is in review.', 'Start the review of the period first.')
export const ALREADY_REVERSED = refusal('ALREADY_REVERSED', 'This entry was reversed already.')
export const IS_REVERSAL = refusal('IS_REVERSAL', 'This entry is itself a reversal: correct the entry it reverses.')
export const NO_WORKER = refusal('NO_WORKER', 'This person has no floor sign-in at this site: the ledger pays a floor sign-in.', 'Link a floor sign-in to the person first (People › Employees).')
export const NOT_A_LEAD = refusal('NOT_A_LEAD', "You review only the statements of people you lead, at a site whose legal basis lets leads see one person's figures.")

/** What a period's checks count (read by the API). */
export interface PeriodFacts {
  readonly heldOpen: number
  readonly daysOpen: number
  readonly overtimePending: number
  readonly blocksWaiting: number
  /** STANDARD_MINUTE_BONUS schemes in force in the month. */
  readonly bonusSchemes: number
  readonly scansWithoutRate: number
  readonly workersWithoutEmployee: number
  readonly disputesOpen: number
  readonly sitesWithoutClock: number
}

export const PERIOD_CHECKS = ['HELD_OPEN', 'DAYS_OPEN', 'OVERTIME_PENDING', 'BLOCKS_WAITING', 'BONUS_SCHEME', 'NO_RATE', 'NO_EMPLOYEE', 'DISPUTES_OPEN', 'NO_CLOCK'] as const
export type PeriodCheckCode = (typeof PERIOD_CHECKS)[number]

export interface PeriodCheck {
  readonly code: PeriodCheckCode
  /** Stops the review from starting; the others are told. */
  readonly blocking: boolean
  readonly count: number
  readonly words: string
}

/**
 * What stands between a period and its review, each in words. Blocking: what would change the pay after a person looked at
 * it (a held scan, an open attendance day, overtime or a block not decided: waiting not decided yet is pay not paid yet), and
 * a standard-minute bonus, which the ledger cannot book yet. Told only: a scan with no rate and a worker with no employee are
 * not paid and stay payable by a correction; an open dispute is answered as a correction; a site with no clock has no
 * minutes, so no make-up.
 */
export function periodChecks(facts: PeriodFacts): PeriodCheck[] {
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const checks: PeriodCheck[] = [
    { code: 'HELD_OPEN', blocking: true, count: facts.heldOpen, words: `${plural(facts.heldOpen, 'scan is', 'scans are')} held: resolve them.` },
    { code: 'DAYS_OPEN', blocking: true, count: facts.daysOpen, words: `${plural(facts.daysOpen, 'attendance day is', 'attendance days are')} not approved.` },
    { code: 'OVERTIME_PENDING', blocking: true, count: facts.overtimePending, words: `${plural(facts.overtimePending, 'overtime entry waits', 'overtime entries wait')} for a decision: only approved overtime is paid.` },
    { code: 'BLOCKS_WAITING', blocking: true, count: facts.blocksWaiting, words: `${plural(facts.blocksWaiting, 'off-standard block is', 'off-standard blocks are')} still running or waiting for approval.` },
    { code: 'BONUS_SCHEME', blocking: true, count: facts.bonusSchemes, words: `${plural(facts.bonusSchemes, 'standard-minute bonus scheme applies', 'standard-minute bonus schemes apply')} this month, and the ledger cannot book a bonus yet.` },
    { code: 'NO_RATE', blocking: false, count: facts.scansWithoutRate, words: `${plural(facts.scansWithoutRate, 'scan has', 'scans have')} no rate in force: not paid until a rate applies.` },
    { code: 'NO_EMPLOYEE', blocking: false, count: facts.workersWithoutEmployee, words: `${plural(facts.workersWithoutEmployee, 'floor sign-in has', 'floor sign-ins have')} no employee record: their scans are not paid until they are linked.` },
    { code: 'DISPUTES_OPEN', blocking: false, count: facts.disputesOpen, words: `${plural(facts.disputesOpen, 'dispute is', 'disputes are')} open: an answer after the lock is paid as a correction.` },
    { code: 'NO_CLOCK', blocking: false, count: facts.sitesWithoutClock, words: `${plural(facts.sitesWithoutClock, 'site has', 'sites have')} no attendance on (the legal gate is off): no minutes present, so no make-up, and scans there are not held.` },
  ]
  return checks.filter((check) => check.count > 0)
}

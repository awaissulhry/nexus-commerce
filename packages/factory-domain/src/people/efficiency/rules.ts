import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { rowTime, stretchesOf, timedOfRow, type Stretch, type TimingRow } from '../../production/terminal/rules'
import { Dec, type Decimal } from '../../tax/decimal'
import { traineeOn } from '../skills/rules'
import type { LevelFacts } from '../skills/rules'

/**
 * Efficiency (B-W2b-44; MES-247 operator efficiency behind the art. 4 switch, MES-250 planned against actual minutes, MES-251
 * the standard review queue, ANA-016 operation cycle time, ANA-017 line efficiency; design people.efficiency; Statuto dei
 * Lavoratori art. 4; Owner answers W1, F2, H3). Pure: the API reads the records and masks every group with the company's
 * minimum size (B-W2b-27).
 *
 *   line figures   earned minutes (good pieces × the operation's frozen standard) against the minutes attended on the line
 *                  (attendance days, presentMinutes), against the minutes on standard work (attended less coded
 *                  off-standard and indirect time) and against the minutes planned (the shifts of the people on the line).
 *   a group        a line, a line's day, an operation, an operation's day. Its headcount is the smaller of the people who
 *                  reported and the people who attended: a line of eight where one person scanned everything shows that
 *                  one person's output, so it is one person's figure and stays hidden.
 *   totals         add up only the groups shown: a total with a hidden group in it gives that group away by subtraction.
 *   planned/actual actual minutes per piece = the person-minutes of the closed stretches of the bundles at the operation
 *                  (B-W2b-40; pauses left out, a team counted once per member) ÷ the pieces of their standing reports.
 *                  A one-tap report has no timing and is not counted. A bundle a trainee worked on is not counted (MES-244).
 *   the review     an operation off its standard by more than the tolerance, in either direction, over at least the
 *                  minimum number of bundles, counted since its last decision. A person decides, with a reason.
 *   one person     the worker's own solo timed reports of one site, one day at a time; no comparison with anyone, no rank,
 *                  no target. Never built from attendance minutes: they are kept for attendance (see PERSON_DENOMINATOR).
 */

export const EFFICIENCY_LIMITS = Object.freeze({ reasonMin: 3, reasonMax: 500, maxStandardMinutes: 9999.999 })

/**
 * The standard review's rule. People settings has no column for these yet (a schema need of B-W2b-44), so they are the
 * build's defaults, the same for every company: "a set %" and "enough bundles" of the design.
 */
export const STANDARD_REVIEW = Object.freeze({ tolerancePercent: 10, minBundles: 5, windowDays: 60 })

const ZERO = new Dec(0)
const num = (value: string | number): Decimal => new Dec(value)

/** Minutes as the answers show them: three decimals. */
const minutesFigure = (value: Decimal | number): string => new Dec(value).toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(3)

/** A share as a percentage with one decimal; null when there is nothing to divide by. */
export function percentOf(part: Decimal, whole: Decimal | null): string | null {
  if (whole === null || !whole.gt(0)) return null
  return part.div(whole).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

// ---- trainees (MES-244) ------------------------------------------------------------------------------------------------

export type TraineeFacts = Pick<LevelFacts, 'since' | 'traineeUntil' | 'signedOffOn'>

/** A trainee day: the person was in a trainee period of any skill that day. */
export const isTraineeDay = (levels: readonly TraineeFacts[], day: BusinessDate): boolean => levels.some((level) => traineeOn(level, day))

// ---- attended minutes per line ---------------------------------------------------------------------------------------

export interface LoanFacts {
  readonly toLineId: string
  readonly startsAt: Date
  readonly endsAt: Date
}

export interface AttendedDayFacts {
  readonly presentMinutes: number
  readonly plannedMinutes: number | null
  readonly firstInAt: Date | null
  readonly lastOutAt: Date | null
  readonly homeLineId: string | null
  readonly loans: readonly LoanFacts[]
}

export interface AttendedShare {
  readonly lineId: string | null
  readonly minutes: number
  readonly plannedMinutes: number
}

/**
 * One person's attendance day split over lines: the minutes of a loan to another line, as far as the loan overlaps the
 * day from first in to last out, go to that line; the rest stays on the home line (null: the person has none). The day's
 * planned minutes go with the biggest share. It reads the day by the person, never a clock event: a day made by a MANUAL
 * event (no worker, no tablet) counts like any other.
 */
export function attendedShares(day: AttendedDayFacts): AttendedShare[] {
  let left = Math.max(0, day.presentMinutes)
  const shares = new Map<string | null, number>()
  if (day.firstInAt && day.lastOutAt) {
    for (const loan of day.loans) {
      const from = Math.max(day.firstInAt.getTime(), loan.startsAt.getTime())
      const to = Math.min(day.lastOutAt.getTime(), loan.endsAt.getTime())
      const overlap = Math.min(left, Math.max(0, Math.floor((to - from) / 60_000)))
      if (overlap > 0) {
        shares.set(loan.toLineId, (shares.get(loan.toLineId) ?? 0) + overlap)
        left -= overlap
      }
    }
  }
  if (left > 0 || shares.size === 0) shares.set(day.homeLineId, (shares.get(day.homeLineId) ?? 0) + left)
  const rows = [...shares.entries()].map(([lineId, minutes]) => ({ lineId, minutes }))
  const biggest = rows.reduce((best, row) => (row.minutes > best.minutes ? row : best), rows[0]!)
  return rows.map((row) => ({ ...row, plannedMinutes: row === biggest ? (day.plannedMinutes ?? 0) : 0 }))
}

// ---- line figures (MES-247, ANA-017) -----------------------------------------------------------------------------------

export type LineFact =
  /** One person's share of an attendance day on a line. */
  | { readonly kind: 'ATTENDED'; readonly lineId: string | null; readonly day: BusinessDate; readonly employeeId: string; readonly minutes: number; readonly plannedMinutes: number }
  /** One standing report made on a line; subjects: who made it (the workers of a team, or the station). */
  | { readonly kind: 'EARNED'; readonly lineId: string | null; readonly day: BusinessDate; readonly subjects: readonly string[]; readonly earnedMinutes: string }
  /** A block of off-standard or indirect time, coded (rejected blocks are left out). */
  | { readonly kind: 'OFF_STANDARD'; readonly lineId: string | null; readonly day: BusinessDate; readonly minutes: number }

export interface LineFigures extends Record<string, unknown> {
  readonly earnedMinutes: string | null
  readonly attendedMinutes: string | null
  readonly plannedMinutes: string | null
  readonly offStandardMinutes: string | null
  readonly onStandardMinutes: string | null
  /** Earned ÷ attended. */
  readonly efficiency: string | null
  /** Earned ÷ minutes on standard work. */
  readonly onStandardEfficiency: string | null
  /** Earned ÷ planned. */
  readonly plannedEfficiency: string | null
}

interface Sums {
  readonly earned: Decimal
  readonly attended: Decimal | null
  readonly planned: Decimal | null
  readonly offStandard: Decimal
}

function figuresOf(sums: Sums): LineFigures {
  const onStandard = sums.attended === null ? null : Dec.max(ZERO, sums.attended.minus(sums.offStandard))
  return {
    earnedMinutes: minutesFigure(sums.earned),
    attendedMinutes: sums.attended === null ? null : minutesFigure(sums.attended),
    plannedMinutes: sums.planned === null ? null : minutesFigure(sums.planned),
    offStandardMinutes: minutesFigure(sums.offStandard),
    onStandardMinutes: onStandard === null ? null : minutesFigure(onStandard),
    efficiency: percentOf(sums.earned, sums.attended),
    onStandardEfficiency: percentOf(sums.earned, onStandard),
    plannedEfficiency: percentOf(sums.earned, sums.planned),
  }
}

export interface LineGroup {
  readonly key: string
  /** The smaller of the people who reported and the people who attended (a set with nobody in it does not count). */
  readonly people: number
  readonly figures: LineFigures
}

/** The headcount a group's figures stand on (see the module's comment). */
export function headcountOf(reported: ReadonlySet<string>, attended: ReadonlySet<string>): number {
  const sizes = [reported.size, attended.size].filter((size) => size > 0)
  return sizes.length === 0 ? 0 : Math.min(...sizes)
}

/** Groups the facts by `keyOf` (a line; a line and a day). `attendanceOpen` false: no attended, planned or derived figure. */
export function lineGroupsOf(facts: readonly LineFact[], attendanceOpen: boolean, keyOf: (fact: LineFact) => string): LineGroup[] {
  const groups = new Map<string, { earned: Decimal; attended: Decimal; planned: Decimal; offStandard: Decimal; reported: Set<string>; present: Set<string> }>()
  for (const fact of facts) {
    const key = keyOf(fact)
    const group = groups.get(key) ?? { earned: ZERO, attended: ZERO, planned: ZERO, offStandard: ZERO, reported: new Set<string>(), present: new Set<string>() }
    groups.set(key, group)
    if (fact.kind === 'EARNED') {
      group.earned = group.earned.plus(fact.earnedMinutes)
      for (const subject of fact.subjects) group.reported.add(subject)
    } else if (fact.kind === 'ATTENDED') {
      if (!attendanceOpen) continue
      group.attended = group.attended.plus(fact.minutes)
      group.planned = group.planned.plus(fact.plannedMinutes)
      if (fact.minutes > 0) group.present.add(fact.employeeId)
    } else group.offStandard = group.offStandard.plus(fact.minutes)
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    people: headcountOf(group.reported, group.present),
    figures: figuresOf({ earned: group.earned, attended: attendanceOpen ? group.attended : null, planned: attendanceOpen ? group.planned : null, offStandard: group.offStandard }),
  }))
}

/** The tiles: the sum of the groups SHOWN, so no hidden group can be worked out from a total; null when none is shown. */
export function totalsOf(shown: readonly LineFigures[], attendanceOpen: boolean): LineFigures | null {
  if (shown.length === 0) return null
  const sum = (pick: (row: LineFigures) => string | null): Decimal => shown.reduce<Decimal>((total, row) => total.plus(pick(row) ?? 0), ZERO)
  return figuresOf({
    earned: sum((row) => row.earnedMinutes),
    attended: attendanceOpen ? sum((row) => row.attendedMinutes) : null,
    planned: attendanceOpen ? sum((row) => row.plannedMinutes) : null,
    offStandard: sum((row) => row.offStandardMinutes),
  })
}

// ---- timed bundles (MES-250, ANA-016) ---------------------------------------------------------------------------------

/** One bundle at one operation: its standing report and the timing behind it, with nobody's name in the figures. */
export interface OperationSample {
  /** The report's moment and site day. */
  readonly at: Date
  readonly day: BusinessDate
  /** Pieces worked on: the standing report's good, scrap and rework. */
  readonly pieces: number
  /** Running time, a team counted once. */
  readonly seconds: number
  /** Running time × the people on it (the labour). */
  readonly personSeconds: number
  readonly pausedSeconds: number
  /** First start to the report, pauses included. */
  readonly elapsedSeconds: number
  /** Who worked on it, for the headcount only. */
  readonly subjects: readonly string[]
}

const subjectOf = (stretch: Pick<Stretch, 'workerId' | 'stationId'>): string | null => (stretch.workerId ? `worker:${stretch.workerId}` : stretch.stationId ? `station:${stretch.stationId}` : null)

/** Who ran a bundle at an operation: each stretch's subject and the members its runs name. */
function stretchSubjects(stretches: readonly Stretch[], members: ReadonlyMap<string, readonly string[]>): string[] {
  const out = new Set<string>()
  for (const stretch of stretches) {
    const subject = subjectOf(stretch)
    if (subject) out.add(subject)
    for (const run of stretch.runs) for (const worker of members.get(run.openedBy) ?? []) out.add(`worker:${worker}`)
  }
  return [...out]
}

export interface TimedReport {
  readonly seconds: number
  readonly personSeconds: number
  readonly pausedSeconds: number
  readonly elapsedSeconds: number
  readonly subjects: readonly string[]
}

/**
 * The timing behind a standing report: every stretch of its bundle at its operation (hand-backs and pieces-so-far of other
 * people included: the time is kept). Null when the report closed no stretch: a one-tap report (Owner answer F3) has no
 * timing, and what ran before it is only part of the work.
 */
export function timedReportOf(rows: readonly TimingRow[], members: ReadonlyMap<string, readonly string[]>, reportScanId: string): TimedReport | null {
  const stretches = stretchesOf(rows, members).filter((stretch) => stretch.closedBy !== null)
  if (timedOfRow(stretches, reportScanId) === null) return null
  const first = stretches.reduce<Date | null>((earliest, stretch) => (earliest === null || stretch.startedAt < earliest ? stretch.startedAt : earliest), null)
  const report = rows.find((row) => row.id === reportScanId)
  return {
    seconds: stretches.reduce((sum, stretch) => sum + stretch.secondsClosed, 0),
    personSeconds: stretches.reduce((sum, stretch) => sum + stretch.personSecondsClosed, 0),
    pausedSeconds: stretches.reduce((sum, stretch) => sum + stretch.pauses.reduce((total, pause) => total + pause.seconds, 0), 0),
    elapsedSeconds: first && report ? Math.max(0, Math.floor((rowTime(report).getTime() - first.getTime()) / 1000)) : 0,
    subjects: stretchSubjects(stretches, members),
  }
}

export const OPERATION_STATES = ['WITHIN', 'REVIEW', 'TOO_FEW_BUNDLES'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

export interface OperationFigures extends Record<string, unknown> {
  readonly bundles: number | null
  readonly pieces: number | null
  /** Person-minutes per piece. */
  readonly actualMinutes: string | null
  /** (Actual − standard) ÷ standard: above zero the work takes longer than the standard. */
  readonly differencePercent: string | null
  readonly state: OperationState | null
}

const headcount = (samples: readonly Pick<OperationSample, 'subjects'>[]): number => new Set(samples.flatMap((sample) => sample.subjects)).size

function actualOf(samples: readonly OperationSample[]): Decimal | null {
  const pieces = samples.reduce((sum, sample) => sum + sample.pieces, 0)
  if (pieces <= 0) return null
  return num(samples.reduce((sum, sample) => sum + sample.personSeconds, 0)).div(60).div(pieces)
}

function differenceOf(actual: Decimal | null, standardMinutes: string): Decimal | null {
  const standard = num(standardMinutes)
  return actual === null || !standard.gt(0) ? null : actual.minus(standard).div(standard).times(100)
}

const differenceFigure = (value: Decimal | null): string | null => (value === null ? null : value.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1))

const offBeyond = (difference: Decimal | null, tolerancePercent: number): boolean => difference !== null && difference.abs().gt(tolerancePercent)

/** One operation's figures against its standard over these samples, with the headcount they stand on. */
export function operationFiguresOf(samples: readonly OperationSample[], standardMinutes: string, rule: { readonly tolerancePercent: number; readonly minBundles: number } = STANDARD_REVIEW): { readonly people: number; readonly figures: OperationFigures } {
  const actual = actualOf(samples)
  const difference = differenceOf(actual, standardMinutes)
  const state: OperationState = samples.length < rule.minBundles ? 'TOO_FEW_BUNDLES' : offBeyond(difference, rule.tolerancePercent) ? 'REVIEW' : 'WITHIN'
  return {
    people: headcount(samples),
    figures: {
      bundles: samples.length,
      pieces: samples.reduce((sum, sample) => sum + sample.pieces, 0),
      actualMinutes: actual === null ? null : minutesFigure(actual),
      differencePercent: differenceFigure(difference),
      state,
    },
  }
}

export interface OperationDay {
  readonly date: BusinessDate
  readonly people: number
  readonly actualMinutes: string | null
  readonly differencePercent: string | null
}

/** The operation's days, oldest first (each still to be masked: a day may stand on fewer people than the period). */
export function operationDaysOf(samples: readonly OperationSample[], standardMinutes: string): OperationDay[] {
  const days = new Map<BusinessDate, OperationSample[]>()
  for (const sample of samples) days.set(sample.day, [...(days.get(sample.day) ?? []), sample])
  return [...days.keys()].sort().map((date) => {
    const day = days.get(date)!
    const actual = actualOf(day)
    return { date, people: headcount(day), actualMinutes: actual === null ? null : minutesFigure(actual), differencePercent: differenceFigure(differenceOf(actual, standardMinutes)) }
  })
}

/** The first day of the unbroken run of days off the standard, in one direction, up to the last day; null: not off now. */
export function offSinceOf(days: readonly Pick<OperationDay, 'date' | 'differencePercent'>[], tolerancePercent: number = STANDARD_REVIEW.tolerancePercent): BusinessDate | null {
  let since: BusinessDate | null = null
  let sign = 0
  for (const day of [...days].reverse()) {
    const value = day.differencePercent === null ? null : num(day.differencePercent)
    if (!offBeyond(value, tolerancePercent)) break
    const direction = value!.gt(0) ? 1 : -1
    if (sign !== 0 && direction !== sign) break
    sign = direction
    since = day.date
  }
  return since
}

export interface CycleFigures extends Record<string, unknown> {
  readonly bundles: number | null
  readonly pieces: number | null
  readonly cycleMinutesPerBundle: string | null
  readonly cycleMinutesPerPiece: string | null
  readonly pausedMinutesPerBundle: string | null
  readonly elapsedMinutesPerBundle: string | null
}

/** Operation cycle time (ANA-016): how long the operation runs, a team counted once; per operation, never per person. */
export function cycleFiguresOf(samples: readonly OperationSample[]): { readonly people: number; readonly figures: CycleFigures } {
  const bundles = samples.length
  const pieces = samples.reduce((sum, sample) => sum + sample.pieces, 0)
  const seconds = (pick: (sample: OperationSample) => number): Decimal => num(samples.reduce((sum, sample) => sum + pick(sample), 0))
  const perBundle = (value: Decimal): string | null => (bundles === 0 ? null : minutesFigure(value.div(60).div(bundles)))
  return {
    people: headcount(samples),
    figures: {
      bundles,
      pieces,
      cycleMinutesPerBundle: perBundle(seconds((sample) => sample.seconds)),
      cycleMinutesPerPiece: pieces === 0 ? null : minutesFigure(seconds((sample) => sample.seconds).div(60).div(pieces)),
      pausedMinutesPerBundle: perBundle(seconds((sample) => sample.pausedSeconds)),
      elapsedMinutesPerBundle: perBundle(seconds((sample) => sample.elapsedSeconds)),
    },
  }
}

// ---- the standard review (MES-251) -------------------------------------------------------------------------------------

/** KEEP, CHANGE and INVESTIGATE are a person's decision with a reason; SEND puts an operation on the queue by hand. */
export const REVIEW_DECISIONS = ['KEEP', 'CHANGE', 'INVESTIGATE', 'SEND'] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

export const REVIEW_REASONS = ['OFF_STANDARD', 'INVESTIGATING', 'SENT'] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

export const REVIEW_WORDS: Readonly<Record<ReviewDecision, string>> = Object.freeze({
  KEEP: 'The standard stays as it is.',
  CHANGE: 'The standard changes through a new routing revision in Products; piece rates follow only as c.c. art. 2101 allows.',
  INVESTIGATE: 'Under investigation: the operation stays on the queue until a person decides.',
  SEND: 'Sent to the standard review by hand.',
})

export interface ReviewMark {
  readonly decision: ReviewDecision
  readonly at: Date
}

export interface ReviewPlace {
  /** On the queue, and why; null: it is not. */
  readonly reason: ReviewReason | null
  /** The bundles the queue judges it on: since the last KEEP or CHANGE. */
  readonly samples: readonly OperationSample[]
}

/**
 * Where an operation stands on the queue. KEEP and CHANGE close it: only bundles reported after that decision count, so a
 * decided operation comes back only when enough newer bundles are off again. INVESTIGATE and SEND keep it on until a
 * person keeps or changes it, whatever the figures say.
 */
export function reviewPlaceOf(samples: readonly OperationSample[], mark: ReviewMark | null, standardMinutes: string, rule: { readonly tolerancePercent: number; readonly minBundles: number } = STANDARD_REVIEW): ReviewPlace {
  if (mark?.decision === 'INVESTIGATE') return { reason: 'INVESTIGATING', samples }
  if (mark?.decision === 'SEND') return { reason: 'SENT', samples }
  const counted = mark ? samples.filter((sample) => sample.at > mark.at) : samples
  return { reason: operationFiguresOf(counted, standardMinutes, rule).figures.state === 'REVIEW' ? 'OFF_STANDARD' : null, samples: counted }
}

export interface DecisionInput {
  readonly decision: ReviewDecision
  readonly reason?: string | null | undefined
  readonly proposedMinutes?: string | null | undefined
}

export function decisionProblems(input: DecisionInput, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const reason = input.reason?.trim() ?? ''
  if (input.decision !== 'SEND' && reason.length < EFFICIENCY_LIMITS.reasonMin) problems.push({ path: `${at}/reason`, message: 'Say why: a decision about a standard is kept with its reason (c.c. art. 2101).' })
  if (reason.length > EFFICIENCY_LIMITS.reasonMax) problems.push({ path: `${at}/reason`, message: `Keep the reason to ${EFFICIENCY_LIMITS.reasonMax} characters.` })
  if (input.decision === 'CHANGE') {
    const proposed = Number(input.proposedMinutes)
    if (!Number.isFinite(proposed) || proposed <= 0 || proposed > EFFICIENCY_LIMITS.maxStandardMinutes) problems.push({ path: `${at}/proposedMinutes`, message: 'Say what the standard should become, in minutes per piece.' })
  } else if (input.proposedMinutes !== undefined && input.proposedMinutes !== null) problems.push({ path: `${at}/proposedMinutes`, message: 'A new standard goes only with Change.' })
  return problems
}

export const TOO_FEW_PEOPLE = Object.freeze({ code: 'TOO_FEW_PEOPLE', message: 'Too few people worked on this operation to review it without identifying them.' })

export const REVIEW_MOVED = Object.freeze({ code: 'REVIEW_MOVED', message: 'Someone decided about this operation after you opened it: read it again.' })

// ---- one person's figures (MES-247, H3) ----------------------------------------------------------------------------------

/**
 * What one person's daily efficiency divides by. AttendanceDay.presentMinutes is tagged for ATTENDANCE only (the ownership
 * file time.json), and a use outside a column's tags is refused until a person decides a new purpose (B-W2b-27; GDPR art.
 * 5(1)(b)): this figure about one person's work is PERFORMANCE, so it stands on the timed minutes of the person's own work.
 * The API's test reads the tag from the ownership file: widening it fails that test and asks for this choice again.
 */
export const PERSON_DENOMINATOR = 'TIMED_MINUTES' as const
export const ATTENDED_MINUTES_TAGS: readonly string[] = Object.freeze(['ATTENDANCE'])

export const PERSON_WORDS = Object.freeze({
  logged: "This view is recorded and visible to HR and the data protection officer. No comparison with others, no export, no print.",
  denominator: "Efficiency here is earned minutes against the person's own timed minutes. Attended minutes are kept for attendance, not for one person's work figures (GDPR art. 5(1)(b)).",
  excluded: "Trainee days and team operations are left out: a trainee's day does not count, and a team's minutes are not one person's.",
})

/** One of the person's own reports, worked alone; `timedPersonSeconds` null: a one-tap report, no timing. */
export interface PersonReport {
  readonly day: BusinessDate
  readonly pieces: number
  readonly earnedMinutes: string
  readonly timedPersonSeconds: number | null
}

export interface PersonDay {
  readonly date: BusinessDate
  readonly pieces: number
  readonly earnedMinutes: string
  readonly timedEarnedMinutes: string
  readonly timedMinutes: string
  readonly offStandardMinutes: string
  readonly efficiency: string | null
}

/**
 * One person's days: pieces and earned minutes of every solo report, and the efficiency of the timed ones (earned ÷ timed
 * minutes on the same reports: a one-tap report has earned minutes and no time). Nothing about anyone else, no rank, no
 * target, no judgement.
 */
export function personDaysOf(reports: readonly PersonReport[], offStandard: ReadonlyMap<BusinessDate, number>): PersonDay[] {
  const days = [...new Set([...reports.map((report) => report.day), ...offStandard.keys()])].sort()
  return days.map((date) => {
    const own = reports.filter((report) => report.day === date)
    const timed = own.filter((report) => report.timedPersonSeconds !== null)
    const earned = own.reduce<Decimal>((sum, report) => sum.plus(report.earnedMinutes), ZERO)
    const timedEarned = timed.reduce<Decimal>((sum, report) => sum.plus(report.earnedMinutes), ZERO)
    const minutes = num(timed.reduce((sum, report) => sum + (report.timedPersonSeconds ?? 0), 0)).div(60)
    return {
      date,
      pieces: own.reduce((sum, report) => sum + report.pieces, 0),
      earnedMinutes: minutesFigure(earned),
      timedEarnedMinutes: minutesFigure(timedEarned),
      timedMinutes: minutesFigure(minutes),
      offStandardMinutes: minutesFigure(offStandard.get(date) ?? 0),
      efficiency: percentOf(timedEarned, minutes),
    }
  })
}

// ---- how it is computed --------------------------------------------------------------------------------------------------

/** "How efficiency is computed" (design pop-up `how`): the formula, the sources and what is left out. */
export const HOW_COMPUTED = Object.freeze({
  formulas: Object.freeze([
    'Line efficiency = earned minutes ÷ attended minutes.',
    'On-standard efficiency = earned minutes ÷ minutes on standard work (attended less coded off-standard and indirect minutes).',
    'Planned efficiency = earned minutes ÷ the planned shift minutes of the people on the line.',
    'Earned minutes = good pieces of the standing reports × the operation\'s standard minutes on the work order.',
    'Actual minutes per piece = person-minutes of the closed stretches ÷ pieces reported; pauses are left out.',
  ]),
  sources: Object.freeze(['Production scans and timing', 'Off-standard blocks', 'Attendance days', 'The standards of each routing revision']),
  exclusions: Object.freeze([
    'Trainee days: on both sides of the line figures. Bundles a trainee worked on: from the operations.',
    'One-tap reports: they have no timing, so they count as earned minutes and not as actual minutes.',
    'Off-standard codes: rejected blocks are left out; the rest come off the minutes on standard work.',
    'Work done outside: a report of a subcontract receipt.',
    'Any group under the minimum size, also from the totals.',
  ]),
})

import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { hours, restWarnings, weekAverageOf, type LimitKind, type LimitLevel, type LimitRule, type LimitRules, type PlannedWork } from '../shifts/limits'
import { mondayOf } from '../shifts/rules'

/**
 * What a limit says about the time a person actually worked (B-W2b-42; MES-229 "limit checks", MES-232 "warnings before
 * a limit is broken"; design people.attendance "Overtime to approve": annual cap, rest under 11 h, 48 h weekly average,
 * each a tone with LawRef; "better": working-time limits are checked before overtime is approved, with the law in plain
 * words), pure. B-W2b-32's limit engine answers for planned time; here the worked days take the place of the plan up to
 * today and the plan counts from tomorrow, so the warning comes BEFORE the limit is broken:
 *
 *   OVERTIME_YEARLY_CAP  the overtime of the year against the cap (art. 5 c.3)
 *   DAILY_REST           the rest around a day, as worked, or before the next planned shift (art. 7)
 *   WEEKLY_AVERAGE       the hours worked over the reference period's weeks (art. 4)
 *
 * A check is OK, NEAR (at NEAR_PERCENT of the limit, or a rest that would break it if the plan is kept) or OVER, and its
 * level is the rule's: WARN shows; BLOCK holds an approval until a person says why it stands. Each check is about ONE
 * person: its figures stay inside one record, and a list shows the tone only (Owner answer W1).
 */

export const LIMIT_STATES = ['OK', 'NEAR', 'OVER'] as const
export type LimitState = (typeof LIMIT_STATES)[number]

/** The limits checked against worked time, in the order the design lists them. */
export const CHECKED_LIMITS = ['OVERTIME_YEARLY_CAP', 'DAILY_REST', 'WEEKLY_AVERAGE'] as const satisfies readonly LimitKind[]
export type CheckedLimit = (typeof CHECKED_LIMITS)[number]

/** A check turns NEAR at this share of the limit. */
export const NEAR_PERCENT = 90

export interface LimitCheck {
  readonly rule: CheckedLimit
  readonly state: LimitState
  readonly level: LimitLevel
  /** The day it is about. */
  readonly date: BusinessDate
  readonly law: string
  readonly words: string
  readonly values: Readonly<Record<string, number | string>>
}

/** A worked day as the checks read it (an AttendanceDay's columns). */
export interface WorkedDay {
  readonly date: BusinessDate
  readonly firstInAt: Date | null
  readonly lastOutAt: Date | null
  readonly presentMinutes: number
  readonly breakMinutes: number
}

/** Worked days as the limit engine's work (a day nobody clocked in is no work). */
export const workOfDays = (days: readonly WorkedDay[]): PlannedWork[] =>
  days.filter((day) => day.firstInAt !== null && day.lastOutAt !== null).map((day) => ({ date: day.date, kind: 'SHIFT' as const, start: day.firstInAt, end: day.lastOutAt, minutes: day.presentMinutes, breakMinutes: day.breakMinutes }))

const stateOf = (value: number, limit: number): LimitState => (value > limit ? 'OVER' : value * 100 >= limit * NEAR_PERCENT ? 'NEAR' : 'OK')

/** The year's overtime against the cap (art. 5 c.3): what was worked and approved, plus what is being decided. */
export function yearlyCapCheck(input: { readonly date: BusinessDate; readonly minutes: number }, rule: LimitRule): LimitCheck {
  const year = input.date.slice(0, 4)
  return {
    rule: 'OVERTIME_YEARLY_CAP',
    state: stateOf(input.minutes, rule.limitMinutes),
    level: rule.action,
    date: input.date,
    law: rule.legalReference,
    words: `Overtime in ${year}: ${hours(input.minutes)} of ${hours(rule.limitMinutes)} — at most ${hours(rule.limitMinutes)} a year (${rule.legalReference})`,
    values: { year, usedMinutes: input.minutes, limitMinutes: rule.limitMinutes },
  }
}

/**
 * The rest around `date` (art. 7): as worked, and before the next planned shift. A rest that ends on a day still to be
 * worked is NEAR: it would break the limit if the plan is kept, so somebody can still change the plan.
 */
export function restCheck(input: { readonly work: readonly PlannedWork[]; readonly date: BusinessDate; readonly workedDates: ReadonlySet<BusinessDate>; readonly timeZone: string }, rule: LimitRule): LimitCheck {
  const found = restWarnings(input.work, rule, new Set([input.date, plusDays(input.date, 1)]), input.timeZone)
  const worst = found.find((warning) => input.workedDates.has(warning.date)) ?? found[0]
  if (!worst) {
    return { rule: 'DAILY_REST', state: 'OK', level: rule.action, date: input.date, law: rule.legalReference, words: `At least ${hours(rule.limitMinutes)} of rest (${rule.legalReference})`, values: { limitMinutes: rule.limitMinutes } }
  }
  return { rule: 'DAILY_REST', state: input.workedDates.has(worst.date) ? 'OVER' : 'NEAR', level: rule.action, date: worst.date, law: rule.legalReference, words: worst.words, values: worst.values }
}

/** The hours worked over the reference period's weeks ending with the week of `date` (art. 4). */
export function averageCheck(input: { readonly work: readonly PlannedWork[]; readonly date: BusinessDate; readonly employedFrom: BusinessDate }, rule: LimitRule): LimitCheck {
  const week = mondayOf(input.date)
  const { months, start, count, weekMinutes, average } = weekAverageOf(input.work, rule, week, input.employedFrom)
  return {
    rule: 'WEEKLY_AVERAGE',
    state: stateOf(average, rule.limitMinutes),
    level: rule.action,
    date: input.date,
    law: rule.legalReference,
    words: `${hours(average)} a week on average over ${count} week${count === 1 ? '' : 's'} — at most ${hours(rule.limitMinutes)} a week on average over ${months} month${months === 1 ? '' : 's'} (${rule.legalReference})`,
    values: { averageMinutes: Math.round(average), weekMinutes: Math.round(weekMinutes), weeks: count, limitMinutes: rule.limitMinutes, referenceMonths: months, periodFrom: start },
  }
}

export interface ChecksInput {
  readonly date: BusinessDate
  /** The days of `work` already worked (the others are the plan). */
  readonly workedDates: ReadonlySet<BusinessDate>
  readonly timeZone: string
  readonly employedFrom: BusinessDate
  readonly rules: LimitRules
  /** Worked up to today, planned after it (`workOfDays` + the roster). */
  readonly work: readonly PlannedWork[]
  /** The year's overtime the cap is checked on. */
  readonly overtimeMinutes: number
}

/** One person's checks on a day, always all three (a tone each), in the design's order. */
export function limitChecks(input: ChecksInput): LimitCheck[] {
  return [yearlyCapCheck({ date: input.date, minutes: input.overtimeMinutes }, input.rules.OVERTIME_YEARLY_CAP), restCheck(input, input.rules.DAILY_REST), averageCheck(input, input.rules.WEEKLY_AVERAGE)]
}

/** The checks that hold an approval: over the limit, and the rule blocks. */
export const blockingChecks = (checks: readonly LimitCheck[]): LimitCheck[] => checks.filter((check) => check.state === 'OVER' && check.level === 'BLOCK')

/** The checks a person should look at (a warning list's rows). */
export const raisedChecks = (checks: readonly LimitCheck[]): LimitCheck[] => checks.filter((check) => check.state !== 'OK')

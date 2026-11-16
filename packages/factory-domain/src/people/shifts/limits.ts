import { daysFrom, localInstant, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { ATTENDANCE_RULES } from '../attendance/rules'
import { mondayOf } from './rules'

/**
 * Working-time warnings on a planned roster and on planned overtime (B-W2b-32; design people.shifts "A cell that breaks
 * a limit shows a tone and InfoTip", "Why this warning", "Request overtime: each with remaining annual cap and rest
 * check"), pure. Each warning says the rule in words with its law (D.Lgs. 66/2003), and its level: WARN (shown) or BLOCK
 * (the plan is held with the reason), as People settings say per limit (WorkingTimeRule, B-W2b-07).
 *
 *   DAILY_REST           at least 11 consecutive hours of rest in every 24 (art. 7): between one working day's last
 *                        planned minute and the next one's first, and a single day longer than 13 hours
 *   BREAK_AFTER          a break once the working day passes 6 hours (art. 8; at least 10 minutes unless the CCNL says)
 *   WEEKLY_AVERAGE       at most 48 hours a week on average, overtime included, over the reference period (art. 4: 4
 *                        months; a CCNL may say up to 12)
 *   OVERTIME_YEARLY_CAP  at most 250 hours of overtime a year (art. 5 c.3; a CCNL may say otherwise)
 *   WEEKLY_REST          B-W2b-GF2: at least 24 consecutive hours of rest every 7 days, on top of the 11 hours of daily
 *                        rest (35 hours), as an average over 14 days (art. 9 c.1)
 *   NIGHT_AVERAGE        B-W2b-GF2: a night worker's working time at most 8 hours in 24 (art. 13 c.1): a working day
 *                        with at least 3 hours in the night period (22:00-06:00, art. 1 c.2 d-e) over the limit
 *
 * Everything here is PLANNED time: the roster's shifts (or the default shift) and the overtime people agreed to. What a
 * person actually worked is attendance (B-W2b-37, B-W2b-42: their own checks on approval), never read here.
 */

// B-W2b-GF2: WEEKLY_REST (art. 9) and NIGHT_AVERAGE (art. 13), kept by People settings since B-W2b-42, checked now.
export const LIMIT_KINDS = ['DAILY_REST', 'BREAK_AFTER', 'WEEKLY_AVERAGE', 'OVERTIME_YEARLY_CAP', 'WEEKLY_REST', 'NIGHT_AVERAGE'] as const
export type LimitKind = (typeof LIMIT_KINDS)[number]
export const LIMIT_LEVELS = ['WARN', 'BLOCK'] as const
export type LimitLevel = (typeof LIMIT_LEVELS)[number]

/** The law's values (D.Lgs. 66/2003), used when no WorkingTimeRule of the kind is in force. */
export const LAW_LIMITS: Readonly<Record<LimitKind, { readonly limitMinutes: number; readonly breakMinutes: number | null; readonly referenceMonths: number | null; readonly legalReference: string }>> = Object.freeze({
  DAILY_REST: { limitMinutes: 660, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 7' },
  BREAK_AFTER: { limitMinutes: 360, breakMinutes: 10, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 8' },
  WEEKLY_AVERAGE: { limitMinutes: 2880, breakMinutes: null, referenceMonths: 4, legalReference: 'D.Lgs. 66/2003 art. 4' },
  OVERTIME_YEARLY_CAP: { limitMinutes: 15000, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 5' },
  WEEKLY_REST: { limitMinutes: 1440, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 9' },
  NIGHT_AVERAGE: { limitMinutes: 480, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 13' },
})

/** A WorkingTimeRule row as the checks read it. */
export interface RuleRow {
  readonly id: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly kind: string
  readonly limitMinutes: number
  readonly breakMinutes: number | null
  readonly referenceMonths: number | null
  readonly action: LimitLevel
  readonly source: 'LAW' | 'CCNL'
  readonly legalReference: string
  readonly status: string
}

/** The rule a plan is checked against, and where it comes from. */
export interface LimitRule {
  readonly kind: LimitKind
  readonly limitMinutes: number
  readonly breakMinutes: number | null
  readonly referenceMonths: number | null
  readonly action: LimitLevel
  /** LAW or CCNL as People settings record it; DEFAULT: no rule on record, the law's value warns. */
  readonly source: 'LAW' | 'CCNL' | 'DEFAULT'
  readonly legalReference: string
  readonly ruleId: string | null
  readonly scope: 'SITE' | 'COMPANY' | 'TENANT' | 'DEFAULT'
}

export type LimitRules = Readonly<Record<LimitKind, LimitRule>>

/** The rules in force at a site: per kind the most specific ACTIVE one (the site's, the company's, the tenant's), else the law's. */
export function rulesInForce(rows: readonly RuleRow[], place: { readonly companyId: string; readonly siteId: string }): LimitRules {
  const out = {} as Record<LimitKind, LimitRule>
  for (const kind of LIMIT_KINDS) {
    const active = rows.filter((row) => row.kind === kind && row.status === 'ACTIVE')
    const site = active.find((row) => row.siteId === place.siteId)
    const company = active.find((row) => row.siteId === null && row.companyId === place.companyId)
    const tenant = active.find((row) => row.siteId === null && row.companyId === null)
    const row = site ?? company ?? tenant
    const law = LAW_LIMITS[kind]
    out[kind] = row
      ? {
          kind,
          limitMinutes: row.limitMinutes,
          breakMinutes: kind === 'BREAK_AFTER' ? (row.breakMinutes ?? law.breakMinutes) : null,
          referenceMonths: kind === 'WEEKLY_AVERAGE' ? (row.referenceMonths ?? law.referenceMonths) : null,
          action: row.action,
          source: row.source,
          legalReference: row.legalReference,
          ruleId: row.id,
          scope: site ? 'SITE' : company ? 'COMPANY' : 'TENANT',
        }
      : { kind, ...law, action: 'WARN', source: 'DEFAULT', ruleId: null, scope: 'DEFAULT' }
  }
  return out
}

/** One stretch of planned work of one person. */
export interface PlannedWork {
  /** The day it belongs to (a night shift: the day it starts). */
  readonly date: BusinessDate
  readonly kind: 'SHIFT' | 'OVERTIME'
  /** Its real start and end; null for overtime planned without a time (it counts in the week's hours only). */
  readonly start: Date | null
  readonly end: Date | null
  /** Working minutes: the window less its break. */
  readonly minutes: number
  readonly breakMinutes: number
}

export interface LimitWarning {
  readonly rule: LimitKind
  readonly level: LimitLevel
  /** The day (cell) it shows on. */
  readonly date: BusinessDate
  /** The law (and CCNL article) as LawRef shows it. */
  readonly law: string
  /** The rule in words, with the figures of this case. */
  readonly words: string
  /** The figures, for the words in another language. */
  readonly values: Readonly<Record<string, number | string>>
}

export const hours = (minutes: number): string => {
  const whole = Math.floor(minutes / 60)
  const rest = Math.round(minutes - whole * 60)
  return rest === 0 ? `${whole} h` : `${whole} h ${rest} min`
}

const clocks = new Map<string, Intl.DateTimeFormat>()
/** HH:MM of an instant in a time zone. */
export function clockAt(instant: Date, timeZone: string): string {
  let format = clocks.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    clocks.set(timeZone, format)
  }
  return format.format(instant)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayWords = (date: BusinessDate): string => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`

interface DayDuty {
  readonly date: BusinessDate
  readonly start: Date
  readonly end: Date
  /** Working minutes of the day (every stretch less its breaks). */
  readonly minutes: number
  /** Breaks inside the stretches plus the gaps between them. */
  readonly pauseMinutes: number
}

/** Each day's duty: its first planned minute to its last, the working minutes, the breaks and gaps between. */
function dutiesOf(work: readonly PlannedWork[]): DayDuty[] {
  const byDate = new Map<BusinessDate, PlannedWork[]>()
  for (const item of work) {
    if (item.start === null || item.end === null) continue
    byDate.set(item.date, [...(byDate.get(item.date) ?? []), item])
  }
  const duties: DayDuty[] = []
  for (const [date, items] of byDate) {
    const sorted = [...items].sort((a, b) => a.start!.getTime() - b.start!.getTime())
    let gaps = 0
    let reach = sorted[0]!.end!.getTime()
    for (const item of sorted.slice(1)) {
      if (item.start!.getTime() > reach) gaps += (item.start!.getTime() - reach) / 60_000
      reach = Math.max(reach, item.end!.getTime())
    }
    duties.push({
      date,
      start: sorted[0]!.start!,
      end: new Date(reach),
      minutes: sorted.reduce((sum, item) => sum + item.minutes, 0),
      pauseMinutes: gaps + sorted.reduce((sum, item) => sum + item.breakMinutes, 0),
    })
  }
  return duties.sort((a, b) => a.start.getTime() - b.start.getTime())
}

/** Rest between working days and within 24 hours (art. 7), on the days in `report`. */
export function restWarnings(work: readonly PlannedWork[], rule: LimitRule, report: ReadonlySet<BusinessDate>, timeZone: string): LimitWarning[] {
  const out: LimitWarning[] = []
  const duties = dutiesOf(work)
  const longest = 1440 - rule.limitMinutes
  for (const [index, duty] of duties.entries()) {
    const span = (duty.end.getTime() - duty.start.getTime()) / 60_000
    if (report.has(duty.date) && span > longest) {
      out.push({
        rule: 'DAILY_REST',
        level: rule.action,
        date: duty.date,
        law: rule.legalReference,
        words: `A working day of ${hours(span)} (${clockAt(duty.start, timeZone)}-${clockAt(duty.end, timeZone)}) leaves less than ${hours(rule.limitMinutes)} of rest in 24 hours — at least ${hours(rule.limitMinutes)} of consecutive rest every 24 hours (${rule.legalReference})`,
        values: { spanMinutes: Math.round(span), limitMinutes: rule.limitMinutes, from: clockAt(duty.start, timeZone), to: clockAt(duty.end, timeZone) },
      })
    }
    const before = duties[index - 1]
    if (!before || !report.has(duty.date)) continue
    const rest = Math.max(0, (duty.start.getTime() - before.end.getTime()) / 60_000)
    if (rest < rule.limitMinutes) {
      out.push({
        rule: 'DAILY_REST',
        level: rule.action,
        date: duty.date,
        law: rule.legalReference,
        words: `Rest ${hours(rest)} between ${clockAt(before.end, timeZone)} (${dayWords(before.date)}) and ${clockAt(duty.start, timeZone)} — minimum ${hours(rule.limitMinutes)} (${rule.legalReference})`,
        values: { restMinutes: Math.round(rest), limitMinutes: rule.limitMinutes, from: clockAt(before.end, timeZone), fromDate: before.date, to: clockAt(duty.start, timeZone) },
      })
    }
  }
  return out
}

/** A break once the working day passes the limit (art. 8), on the days in `report`. */
export function breakWarnings(work: readonly PlannedWork[], rule: LimitRule, report: ReadonlySet<BusinessDate>, timeZone: string): LimitWarning[] {
  const needed = rule.breakMinutes ?? LAW_LIMITS.BREAK_AFTER.breakMinutes!
  return dutiesOf(work)
    .filter((duty) => report.has(duty.date) && duty.minutes > rule.limitMinutes && duty.pauseMinutes < needed)
    .map((duty) => ({
      rule: 'BREAK_AFTER' as const,
      level: rule.action,
      date: duty.date,
      law: rule.legalReference,
      words: `${hours(duty.minutes)} of work ${clockAt(duty.start, timeZone)}-${clockAt(duty.end, timeZone)} with ${Math.round(duty.pauseMinutes)} min of break — a break of at least ${needed} min once the day passes ${hours(rule.limitMinutes)} (${rule.legalReference})`,
      values: { workMinutes: Math.round(duty.minutes), breakMinutes: Math.round(duty.pauseMinutes), neededMinutes: needed, limitMinutes: rule.limitMinutes, from: clockAt(duty.start, timeZone), to: clockAt(duty.end, timeZone) },
    }))
}

/** The weeks of a reference period of `months` months: 4 months are 17 weeks. */
export const referenceWeeks = (months: number): number => Math.max(1, Math.round((months * 52) / 12))

/** The first day the weekly-average check needs planned work from, for the weeks of `from` … `to`. */
export function weeklyAverageWindowStart(from: BusinessDate, rule: LimitRule): BusinessDate {
  return plusDays(mondayOf(from), -7 * (referenceWeeks(rule.referenceMonths ?? LAW_LIMITS.WEEKLY_AVERAGE.referenceMonths!) - 1))
}

/** The average of the reference period's weeks ending with `week` (B-W2b-42 reads it for worked time too). */
export interface WeekAverage {
  readonly months: number
  /** The period's first Monday (the person's first week, for a newcomer). */
  readonly start: BusinessDate
  readonly count: number
  readonly weekMinutes: number
  readonly average: number
}

export function weekAverageOf(work: readonly PlannedWork[], rule: LimitRule, week: BusinessDate, employedFrom: BusinessDate): WeekAverage {
  const months = rule.referenceMonths ?? LAW_LIMITS.WEEKLY_AVERAGE.referenceMonths!
  const span = referenceWeeks(months)
  const byWeek = new Map<BusinessDate, number>()
  for (const item of work) byWeek.set(mondayOf(item.date), (byWeek.get(mondayOf(item.date)) ?? 0) + item.minutes)
  const firstWeek = mondayOf(employedFrom)
  const periodStart = plusDays(week, -7 * (span - 1))
  const start = periodStart < firstWeek ? firstWeek : periodStart
  const count = Math.max(1, Math.floor(daysFrom(start, week) / 7) + 1)
  let total = 0
  for (let at = start; at <= week; at = plusDays(at, 7)) total += byWeek.get(at) ?? 0
  return { months, start, count, weekMinutes: byWeek.get(week) ?? 0, average: total / count }
}

/**
 * The 48-hour weekly average (art. 4) for each week that has a day in `report`: the planned working minutes of the
 * reference period's weeks ending with it, divided by its weeks (only those since the person started: a newcomer's
 * empty weeks before their first day do not lower the average). Shown on the week's last planned day in `report`.
 */
export function weeklyAverageWarnings(work: readonly PlannedWork[], rule: LimitRule, report: ReadonlySet<BusinessDate>, employedFrom: BusinessDate): LimitWarning[] {
  const weeks = [...new Set([...report].map(mondayOf))].sort()
  const out: LimitWarning[] = []
  for (const week of weeks) {
    const { months, start, count, weekMinutes, average } = weekAverageOf(work, rule, week, employedFrom)
    if (average <= rule.limitMinutes) continue
    const days = [...report].filter((date) => mondayOf(date) === week).sort()
    const planned = days.filter((date) => work.some((item) => item.date === date && item.minutes > 0))
    const date = planned.at(-1) ?? days.at(-1)!
    out.push({
      rule: 'WEEKLY_AVERAGE',
      level: rule.action,
      date,
      law: rule.legalReference,
      words: `${hours(weekMinutes)} planned in the week of ${dayWords(week)}; ${hours(average)} a week on average over ${count} week${count === 1 ? '' : 's'} — at most ${hours(rule.limitMinutes)} a week on average over ${months} month${months === 1 ? '' : 's'} (${rule.legalReference})`,
      values: { weekMinutes: Math.round(weekMinutes), averageMinutes: Math.round(average), weeks: count, limitMinutes: rule.limitMinutes, referenceMonths: months, week, periodFrom: start },
    })
  }
  return out
}

/**
 * The yearly overtime cap (art. 5 c.3): the overtime of the year, with the request being checked, over the limit.
 * B-W2b-GF2: `workedMinutes` is the overtime already worked this year (approved or waiting; B-W2b-42's entries), which the
 * cap counts too; its figure is attendance data, so the words name it only when `showWorked` (the reader may see the
 * person's attendance): otherwise they say the cap is passed with the overtime worked, without the figure.
 */
export function yearlyCapWarnings(input: { readonly date: BusinessDate; readonly plannedMinutes: number; readonly workedMinutes?: number; readonly showWorked?: boolean }, rule: LimitRule): LimitWarning[] {
  const worked = input.workedMinutes ?? 0
  if (input.plannedMinutes + worked <= rule.limitMinutes) return []
  const year = input.date.slice(0, 4)
  const words =
    worked === 0
      ? `Planned overtime in ${year} would be ${hours(input.plannedMinutes)} — at most ${hours(rule.limitMinutes)} a year (${rule.legalReference})`
      : input.showWorked
        ? `Overtime in ${year} would be ${hours(input.plannedMinutes + worked)} (${hours(worked)} worked, ${hours(input.plannedMinutes)} planned) — at most ${hours(rule.limitMinutes)} a year (${rule.legalReference})`
        : `Planned overtime in ${year} would pass the yearly cap together with the overtime already worked — at most ${hours(rule.limitMinutes)} a year (${rule.legalReference})`
  return [
    {
      rule: 'OVERTIME_YEARLY_CAP',
      level: rule.action,
      date: input.date,
      law: rule.legalReference,
      words,
      values: { plannedMinutes: input.plannedMinutes, limitMinutes: rule.limitMinutes, year, ...(worked > 0 ? (input.showWorked ? { workedMinutes: worked } : { withWorked: 'yes' }) : {}) },
    },
  ]
}

// ---- B-W2b-GF2: weekly rest (art. 9) and night work (art. 13) ----------------------------------------------------------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const weekdayOf = (date: BusinessDate): string => WEEKDAYS[(daysFrom(mondayOf(date), date) + 7) % 7]!
const dayFormats = new Map<string, Intl.DateTimeFormat>()
/** The calendar day of an instant in a time zone. */
function dateIn(instant: Date, timeZone: string): BusinessDate {
  let format = dayFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormats.set(timeZone, format)
  }
  return format.format(instant) as BusinessDate
}
/** "Sat 14:00": a weekday and a time of an instant in a time zone. */
const momentWords = (instant: Date, timeZone: string): string => `${weekdayOf(dateIn(instant, timeZone))} ${clockAt(instant, timeZone)}`

/** A stretch of rest between two working days (or before the first / after the last one known). */
export interface RestStretch {
  readonly from: Date
  readonly to: Date
  readonly minutes: number
  /** The week (its Monday) the rest belongs to: the week of its middle, so one rest never counts for two weeks. */
  readonly week: BusinessDate
}

/**
 * The rests between the working days of `work`, inside a window of whole days (`from` 00:00 … the day after `to`): before
 * the first duty, between duties and after the last. Rest at the window's edges is as long as the window shows: work
 * outside it is not read, so an edge rest is the least it can be.
 */
export function restStretches(work: readonly PlannedWork[], window: { readonly from: BusinessDate; readonly to: BusinessDate }, timeZone: string): RestStretch[] {
  const start = localInstant(window.from, 0, timeZone)
  const end = localInstant(plusDays(window.to, 1), 0, timeZone)
  const duties = dutiesOf(work).filter((duty) => duty.end.getTime() > start.getTime() && duty.start.getTime() < end.getTime())
  const stretches: RestStretch[] = []
  const add = (from: Date, to: Date) => {
    const minutes = (to.getTime() - from.getTime()) / 60_000
    if (minutes > 0) stretches.push({ from, to, minutes, week: mondayOf(dateIn(new Date((from.getTime() + to.getTime()) / 2), timeZone)) })
  }
  let reach = start
  for (const duty of duties) {
    if (duty.start.getTime() > reach.getTime()) add(reach, duty.start)
    if (duty.end.getTime() > reach.getTime()) reach = duty.end
  }
  if (end.getTime() > reach.getTime()) add(reach, end)
  return stretches
}

/**
 * The weekly rest (art. 9 c.1) of each week that has a day in `report`: its longest rest against the rule's 24 hours on top
 * of the daily rest's 11 (35 hours). A rest counts for the week of its middle, whole (one rest never counts twice), and
 * for any week it covers for at least the 35 hours (a holiday, a long weekend: each week it covers had its rest). A shorter
 * week stands when the 14 days with the week before or after it still give twice that (the law's average over 14 days: a
 * week of 59 hours of rest covers a week of 11). Shown on the week's last day in `report`. `window`: the days `work`
 * covers; a week is read only when the window holds it whole with the day before it and the Monday after it (a rest cut
 * by the window's edge is never judged).
 */
export const weekReadable = (week: BusinessDate, window: { readonly from: BusinessDate; readonly to: BusinessDate }): boolean => plusDays(week, -1) >= window.from && plusDays(week, 7) <= window.to

/** The days a weekly-rest check of `from` … `to` needs `work` for: the week before the first, and the week after the last. */
export function weeklyRestWindow(from: BusinessDate, to: BusinessDate): { readonly from: BusinessDate; readonly to: BusinessDate } {
  return { from: plusDays(mondayOf(from), -8), to: plusDays(mondayOf(to), 14) }
}
export function weeklyRestWarnings(work: readonly PlannedWork[], rule: LimitRule, dailyRest: LimitRule, report: ReadonlySet<BusinessDate>, window: { readonly from: BusinessDate; readonly to: BusinessDate }, timeZone: string): LimitWarning[] {
  const needed = rule.limitMinutes + dailyRest.limitMinutes
  const stretches = restStretches(work, window, timeZone)
  /** The rest a week counts: a stretch of its own (its middle in the week), or one that covers the week for the 35 hours. */
  const longest = (week: BusinessDate): { readonly minutes: number; readonly stretch: RestStretch } | null => {
    const start = localInstant(week, 0, timeZone).getTime()
    const end = localInstant(plusDays(week, 7), 0, timeZone).getTime()
    let best: { minutes: number; stretch: RestStretch } | null = null
    for (const stretch of stretches) {
      const own = stretch.week === week ? stretch.minutes : 0
      const covered = (Math.min(stretch.to.getTime(), end) - Math.max(stretch.from.getTime(), start)) / 60_000
      const minutes = Math.max(own, covered >= needed ? covered : 0)
      if (minutes > 0 && (best === null || minutes > best.minutes)) best = { minutes, stretch }
    }
    return best
  }
  const out: LimitWarning[] = []
  for (const week of [...new Set([...report].map(mondayOf))].sort()) {
    if (!weekReadable(week, window)) continue
    const found = longest(week)
    const best = found?.stretch ?? null
    const rest = found?.minutes ?? 0
    if (rest >= needed) continue
    const pairs = [plusDays(week, -7), plusDays(week, 7)].filter((other) => weekReadable(other, window)).map((other) => rest + (longest(other)?.minutes ?? 0))
    if (pairs.some((sum) => sum >= 2 * needed)) continue
    const date = [...report].filter((day) => mondayOf(day) === week).sort().at(-1)!
    const from = best ? momentWords(best.from, timeZone) : null
    const to = best ? momentWords(best.to, timeZone) : null
    out.push({
      rule: 'WEEKLY_REST',
      level: rule.action,
      date,
      law: rule.legalReference,
      words: `The longest rest in the week of ${dayWords(week)} is ${hours(rest)}${from ? ` (from ${from} to ${to})` : ''} — at least ${hours(rule.limitMinutes)} of consecutive rest every 7 days on top of the ${hours(dailyRest.limitMinutes)} between shifts (${hours(needed)}), as an average over 14 days (${rule.legalReference})`,
      values: { restMinutes: Math.round(rest), neededMinutes: needed, limitMinutes: rule.limitMinutes, dailyRestMinutes: dailyRest.limitMinutes, week, ...(from && to ? { from, to } : {}) },
    })
  }
  return out
}

/** The night period of art. 1 c.2 d (22:00-06:00, People's attendance rule): the minutes of a stretch inside it. */
function nightMinutesOf(item: PlannedWork, timeZone: string): number {
  if (item.start === null || item.end === null) return 0
  let total = 0
  for (const day of [plusDays(item.date, -1), item.date, plusDays(item.date, 1)]) {
    const from = Math.max(item.start.getTime(), localInstant(day, ATTENDANCE_RULES.nightStartMinute, timeZone).getTime())
    const to = Math.min(item.end.getTime(), localInstant(day, 1440 + ATTENDANCE_RULES.nightEndMinute, timeZone).getTime())
    if (to > from) total += (to - from) / 60_000
  }
  return Math.min(total, item.minutes)
}

/** A working day with at least this much of its working time in the night period is a night worker's day (art. 1 c.2 e). */
export const NIGHT_WORKER_MINUTES = 180

/**
 * A night worker's day (art. 13 c.1): a working day with at least 3 hours in the night period works at most the rule's
 * 8 hours in its 24 (the law's reference; a CCNL's longer one has no column yet), on the days in `report`.
 */
export function nightWarnings(work: readonly PlannedWork[], rule: LimitRule, report: ReadonlySet<BusinessDate>, timeZone: string): LimitWarning[] {
  const nightOf = new Map<BusinessDate, number>()
  for (const item of work) nightOf.set(item.date, (nightOf.get(item.date) ?? 0) + nightMinutesOf(item, timeZone))
  return dutiesOf(work)
    .filter((duty) => report.has(duty.date) && (nightOf.get(duty.date) ?? 0) >= NIGHT_WORKER_MINUTES && duty.minutes > rule.limitMinutes)
    .map((duty) => ({
      rule: 'NIGHT_AVERAGE' as const,
      level: rule.action,
      date: duty.date,
      law: rule.legalReference,
      words: `${hours(duty.minutes)} of work ${clockAt(duty.start, timeZone)}-${clockAt(duty.end, timeZone)}, ${hours(Math.round(nightOf.get(duty.date) ?? 0))} of it at night — a night worker works at most ${hours(rule.limitMinutes)} in 24 hours (${rule.legalReference})`,
      values: { workMinutes: Math.round(duty.minutes), nightMinutes: Math.round(nightOf.get(duty.date) ?? 0), limitMinutes: rule.limitMinutes, from: clockAt(duty.start, timeZone), to: clockAt(duty.end, timeZone) },
    }))
}

/**
 * Every roster warning of one person on the days in `report`: rest, break, the weekly average, and (B-W2b-GF2) the weekly
 * rest and night work. `window`: the days `work` covers (the weekly rest reads the weeks around the report); left out, the
 * report's own days.
 */
export function rosterWarnings(input: { readonly work: readonly PlannedWork[]; readonly rules: LimitRules; readonly report: ReadonlySet<BusinessDate>; readonly timeZone: string; readonly employedFrom: BusinessDate; readonly window?: { readonly from: BusinessDate; readonly to: BusinessDate } }): LimitWarning[] {
  const days = [...input.report].sort()
  if (days.length === 0) return []
  const window = input.window ?? { from: days[0]!, to: days.at(-1)! }
  return [
    ...restWarnings(input.work, input.rules.DAILY_REST, input.report, input.timeZone),
    ...breakWarnings(input.work, input.rules.BREAK_AFTER, input.report, input.timeZone),
    ...weeklyAverageWarnings(input.work, input.rules.WEEKLY_AVERAGE, input.report, input.employedFrom),
    ...weeklyRestWarnings(input.work, input.rules.WEEKLY_REST, input.rules.DAILY_REST, input.report, window, input.timeZone),
    ...nightWarnings(input.work, input.rules.NIGHT_AVERAGE, input.report, input.timeZone),
  ].sort((a, b) => a.date.localeCompare(b.date) || LIMIT_KINDS.indexOf(a.rule) - LIMIT_KINDS.indexOf(b.rule))
}

/** A warning's identity: the same rule on the same day (to tell a new one from one that was there before). */
export const warningKey = (warning: Pick<LimitWarning, 'rule' | 'date'>): string => `${warning.rule}|${warning.date}`

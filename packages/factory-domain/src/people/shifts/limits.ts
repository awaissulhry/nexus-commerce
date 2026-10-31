import { daysFrom, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
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
 *
 * Everything here is PLANNED time: the roster's shifts (or the default shift) and the overtime people agreed to. What a
 * person actually worked is attendance (B-W2b-37, B-W2b-42: their own checks on approval), never read here.
 */

export const LIMIT_KINDS = ['DAILY_REST', 'BREAK_AFTER', 'WEEKLY_AVERAGE', 'OVERTIME_YEARLY_CAP'] as const
export type LimitKind = (typeof LIMIT_KINDS)[number]
export const LIMIT_LEVELS = ['WARN', 'BLOCK'] as const
export type LimitLevel = (typeof LIMIT_LEVELS)[number]

/** The law's values (D.Lgs. 66/2003), used when no WorkingTimeRule of the kind is in force. */
export const LAW_LIMITS: Readonly<Record<LimitKind, { readonly limitMinutes: number; readonly breakMinutes: number | null; readonly referenceMonths: number | null; readonly legalReference: string }>> = Object.freeze({
  DAILY_REST: { limitMinutes: 660, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 7' },
  BREAK_AFTER: { limitMinutes: 360, breakMinutes: 10, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 8' },
  WEEKLY_AVERAGE: { limitMinutes: 2880, breakMinutes: null, referenceMonths: 4, legalReference: 'D.Lgs. 66/2003 art. 4' },
  OVERTIME_YEARLY_CAP: { limitMinutes: 15000, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 5' },
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

const hours = (minutes: number): string => {
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

/**
 * The 48-hour weekly average (art. 4) for each week that has a day in `report`: the planned working minutes of the
 * reference period's weeks ending with it, divided by its weeks (only those since the person started: a newcomer's
 * empty weeks before their first day do not lower the average). Shown on the week's last planned day in `report`.
 */
export function weeklyAverageWarnings(work: readonly PlannedWork[], rule: LimitRule, report: ReadonlySet<BusinessDate>, employedFrom: BusinessDate): LimitWarning[] {
  const months = rule.referenceMonths ?? LAW_LIMITS.WEEKLY_AVERAGE.referenceMonths!
  const span = referenceWeeks(months)
  const byWeek = new Map<BusinessDate, number>()
  for (const item of work) byWeek.set(mondayOf(item.date), (byWeek.get(mondayOf(item.date)) ?? 0) + item.minutes)
  const weeks = [...new Set([...report].map(mondayOf))].sort()
  const out: LimitWarning[] = []
  const firstWeek = mondayOf(employedFrom)
  for (const week of weeks) {
    const periodStart = plusDays(week, -7 * (span - 1))
    const start = periodStart < firstWeek ? firstWeek : periodStart
    const count = Math.max(1, Math.floor(daysFrom(start, week) / 7) + 1)
    let total = 0
    for (let at = start; at <= week; at = plusDays(at, 7)) total += byWeek.get(at) ?? 0
    const average = total / count
    if (average <= rule.limitMinutes) continue
    const days = [...report].filter((date) => mondayOf(date) === week).sort()
    const planned = days.filter((date) => work.some((item) => item.date === date && item.minutes > 0))
    const date = planned.at(-1) ?? days.at(-1)!
    const weekMinutes = byWeek.get(week) ?? 0
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

/** The yearly overtime cap (art. 5 c.3): the planned overtime of the year, with the request being checked, over the limit. */
export function yearlyCapWarnings(input: { readonly date: BusinessDate; readonly plannedMinutes: number }, rule: LimitRule): LimitWarning[] {
  if (input.plannedMinutes <= rule.limitMinutes) return []
  const year = input.date.slice(0, 4)
  return [
    {
      rule: 'OVERTIME_YEARLY_CAP',
      level: rule.action,
      date: input.date,
      law: rule.legalReference,
      words: `Planned overtime in ${year} would be ${hours(input.plannedMinutes)} — at most ${hours(rule.limitMinutes)} a year (${rule.legalReference})`,
      values: { plannedMinutes: input.plannedMinutes, limitMinutes: rule.limitMinutes, year },
    },
  ]
}

/** Every roster warning of one person on the days in `report`: rest, break and the weekly average. */
export function rosterWarnings(input: { readonly work: readonly PlannedWork[]; readonly rules: LimitRules; readonly report: ReadonlySet<BusinessDate>; readonly timeZone: string; readonly employedFrom: BusinessDate }): LimitWarning[] {
  return [
    ...restWarnings(input.work, input.rules.DAILY_REST, input.report, input.timeZone),
    ...breakWarnings(input.work, input.rules.BREAK_AFTER, input.report, input.timeZone),
    ...weeklyAverageWarnings(input.work, input.rules.WEEKLY_AVERAGE, input.report, input.employedFrom),
  ].sort((a, b) => a.date.localeCompare(b.date) || LIMIT_KINDS.indexOf(a.rule) - LIMIT_KINDS.indexOf(b.rule))
}

/** A warning's identity: the same rule on the same day (to tell a new one from one that was there before). */
export const warningKey = (warning: Pick<LimitWarning, 'rule' | 'date'>): string => `${warning.rule}|${warning.date}`

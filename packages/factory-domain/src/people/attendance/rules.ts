import { localInstant, plusDays } from '../../calendars/dates'
import type { Issue } from '../../core/errors'
import { businessDate, businessDayStart, type BusinessDate } from '../../core/time'
import { countedEvents, CLOCK_RULES, durationText, FLAG_WORDS, shiftForClockIn, timeText, type ClockFact, type ClockFlag, type ShiftWindow } from '../clock/rules'

/**
 * Attendance days (B-W2b-37; MES-225 rounding, tolerance and grace, MES-226 attendance anomalies, MES-238 manual entry
 * with a reason; design people.attendance "Days", "Day detail", "How this anomaly is found", people.settings "Rounding,
 * tolerance and grace"), pure. apps/factory-api modules/people/attendance reads a person's clock events (B-W2b-33), the
 * planned shift (B-W2b-32's planner) and the company's People settings, asks `computeDay` for the day's minutes and
 * anomalies, and writes the AttendanceDay with its AttendanceAnomaly rows.
 *
 *   stretches  the counted clock events (VOID events and the events they void left out) make stretches: a clock-in to
 *              its clock-out, with the breaks between (an OUT ends a break). A clock-in while already in is a double
 *              clock-in (the first one counts); a clock-out with no clock-in is a missing clock-in; a stretch still open
 *              after 13 hours (24 h less the 11 h of daily rest, D.Lgs. 66/2003 art. 7), or followed by a clock-in more
 *              than 13 hours later, was never closed: a missing clock-out (a clock-out up to a day later still closes
 *              it: a long day, LONG_DAY). A stretch belongs to the shift its clock-in fits (the day the shift starts: a night shift is
 *              the day it starts), else to the day of its clock-in.
 *   counting   (People settings) a clock-in before the shift counts from the shift's start when "early clock-in counts
 *              from shift start" is on; a clock-in up to the lateness grace after the start counts from the start;
 *              every other clock event is rounded to the nearest 5 or 15 minutes (or to the minute: none). Breaks are
 *              the shift's (fixed: deducted where the person was present; a shift typed by hand deducts its break minutes
 *              once the day passes 6 hours) or the clocked ones. Present = in to out less the breaks; ordinary = the
 *              present minutes inside the planned shift, up to its working minutes; overtime = the rest, in whole units
 *              of the overtime unit (paid only once approved: B-W2b-42); night = 22:00 to 06:00 (D.Lgs. 66/2003 art. 1);
 *              holiday = worked on a day the person was planned off (a rest day or a public holiday).
 *   anomalies  each with the rule that found it (`ruleKey`) and the values for its words (`detail`): missing clock-out
 *              (also an automatic clock-out: the rule closed the day, a person looks), missing clock-in, double clock-in,
 *              over the day's maximum (16 h), no shift planned, a flagged event (forgot badge, a wrong tablet clock),
 *              rest under the daily rest (art. 7), no break once the day passed the break rule (art. 8). Scans while not
 *              clocked in (SCANS_WITHOUT_CLOCK_IN) are not raised here (see B-W2b-37's notes).
 *
 * Statuto dei Lavoratori art. 4 c.2: an attendance tool, behind the site's ATTENDANCE gate; one person's day is one
 * record, never a row of a ranking or a total by person (Owner answer W1).
 */

export const DAY_STATUSES = ['OPEN', 'NEEDS_FIX', 'APPROVED', 'CLOSED'] as const
export type DayStatus = (typeof DAY_STATUSES)[number]

export const ANOMALY_KINDS = ['MISSING_CLOCK_OUT', 'MISSING_CLOCK_IN', 'DOUBLE_CLOCK_IN', 'LONG_DAY', 'NO_SHIFT', 'SCANS_WITHOUT_CLOCK_IN', 'FLAGGED_EVENT', 'SHORT_REST', 'NO_BREAK'] as const
export type AnomalyKind = (typeof ANOMALY_KINDS)[number]

export const ANOMALY_RESOLUTIONS = ['FIXED', 'ACCEPTED', 'CLEARED'] as const
export type AnomalyResolution = (typeof ANOMALY_RESOLUTIONS)[number]

/** What changed on a day (the live message's `change`). */
export const DAY_CHANGES = ['COMPUTED', 'FIXED', 'ABSENCE', 'APPROVED', 'REOPENED', 'ACCEPTED'] as const
export type DayChange = (typeof DAY_CHANGES)[number]

export const ATTENDANCE_RULES = Object.freeze({
  /** A day longer than this is LONG_DAY ("Over 16 h"); People settings has no column for it yet (B-W2b-37's notes). */
  maxDayMinutes: 16 * 60,
  /** The night window (D.Lgs. 66/2003 art. 1 c.2 d: seven hours or more including midnight to 05:00); a CCNL may say otherwise. */
  nightStartMinute: 22 * 60,
  nightEndMinute: 6 * 60,
  /** A shift typed by hand (no break placed) deducts its break minutes once the presence passes this (art. 8's 6 hours). */
  unplacedBreakAfterMinutes: 6 * 60,
  /** A list or a count covers at most this many days. */
  rangeDays: 62,
  listLimit: 500,
  /** The reasons: 3 to 500 characters. */
  reasonMin: 3,
  reasonMax: 500,
})

// ---- People settings: rounding, tolerance and grace (MES-225) ---------------------------------------------------------

export const ROUNDING_CHOICES = [0, 5, 15] as const

/** How clock events become hours (PeopleSettings; one row per company, none: these defaults). */
export interface AttendanceSettings {
  readonly earlyClockInFromShiftStart: boolean
  readonly lateGraceMinutes: number
  readonly overtimeUnitMinutes: number
  readonly roundingMinutes: number
  /** The tolerance: an open clock-in is closed this many minutes after the shift's end (B-W2b-33); null: never. */
  readonly autoClockOutAfterMinutes: number | null
  readonly fixedBreaks: boolean
}

export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = Object.freeze({
  earlyClockInFromShiftStart: true,
  lateGraceMinutes: 0,
  overtimeUnitMinutes: 15,
  roundingMinutes: 0,
  autoClockOutAfterMinutes: null,
  fixedBreaks: true,
})

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

/** Everything wrong with a settings change (the database's limits, in words). */
export function settingsProblems(input: Partial<Record<keyof AttendanceSettings, unknown>>, at = ''): Issue[] {
  const problems: Issue[] = []
  const path = (field: string) => `${at}${field}`
  if (input.lateGraceMinutes !== undefined && (!whole(input.lateGraceMinutes) || input.lateGraceMinutes < 0 || input.lateGraceMinutes > 60)) {
    problems.push({ path: path('lateGraceMinutes'), message: 'Give the lateness grace as 0 to 60 minutes.' })
  }
  if (input.overtimeUnitMinutes !== undefined && (!whole(input.overtimeUnitMinutes) || input.overtimeUnitMinutes < 1 || input.overtimeUnitMinutes > 60)) {
    problems.push({ path: path('overtimeUnitMinutes'), message: 'Count overtime in units of 1 to 60 minutes.' })
  }
  if (input.roundingMinutes !== undefined && !(ROUNDING_CHOICES as readonly unknown[]).includes(input.roundingMinutes)) {
    problems.push({ path: path('roundingMinutes'), message: 'Round clock events to none, 5 or 15 minutes.' })
  }
  if (input.autoClockOutAfterMinutes !== undefined && input.autoClockOutAfterMinutes !== null && (!whole(input.autoClockOutAfterMinutes) || input.autoClockOutAfterMinutes < 0 || input.autoClockOutAfterMinutes > 720)) {
    problems.push({ path: path('autoClockOutAfterMinutes'), message: 'Close an open clock-in 0 to 720 minutes after the shift ends, or never.' })
  }
  return problems
}

const clock = (minute: number): string => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** The minute of the day a rounding gives (nearest unit; none: the minute itself). */
export const roundMinute = (minute: number, unit: number): number => (unit > 0 ? Math.round(minute / unit) * unit : minute)

/**
 * The worked example under the settings ("A clock-in at 05:52 for a 06:00 shift counts from 06:00"), one sentence per
 * rule, in the order of the card; it follows the values typed (design people.settings: "the example updates as you
 * type").
 */
export function workedExample(settings: AttendanceSettings): string[] {
  const start = 6 * 60
  const lines: string[] = []
  lines.push(
    settings.earlyClockInFromShiftStart
      ? `A clock-in at 05:52 for a 06:00 shift counts from 06:00.`
      : `A clock-in at 05:52 for a 06:00 shift counts from ${clock(roundMinute(start - 8, settings.roundingMinutes))}: the minutes before 06:00 count only as overtime.`,
  )
  lines.push(
    settings.lateGraceMinutes > 0
      ? `A clock-in up to ${clock(start + settings.lateGraceMinutes)} still counts from 06:00; at ${clock(start + settings.lateGraceMinutes + 1)} it counts from ${clock(roundMinute(start + settings.lateGraceMinutes + 1, settings.roundingMinutes))}.`
      : `A clock-in after 06:00 counts from that minute${settings.roundingMinutes > 0 ? `, rounded` : ''} (no lateness grace).`,
  )
  lines.push(
    settings.roundingMinutes > 0
      ? `Clock events are rounded to the nearest ${settings.roundingMinutes} minutes: 13:52 counts as ${clock(roundMinute(13 * 60 + 52, settings.roundingMinutes))}, 13:53 as ${clock(roundMinute(13 * 60 + 53, settings.roundingMinutes))}.`
      : 'Clock events are not rounded: they count to the minute.',
  )
  const unit = settings.overtimeUnitMinutes
  lines.push(`Overtime counts in whole units of ${unit} minutes: a clock-out ${unit + 5} minutes after a 14:00 shift end gives ${unit} minutes${unit > 5 ? `; ${unit - 1} minutes after it gives none` : ''}.`)
  lines.push(
    settings.autoClockOutAfterMinutes === null
      ? 'An open clock-in is never closed automatically: the day is flagged for a person to fix.'
      : `An open clock-in is closed automatically ${settings.autoClockOutAfterMinutes} minutes after the shift ends, and the day is flagged for a person to look at.`,
  )
  lines.push(settings.fixedBreaks ? "Breaks come from the shift and are deducted automatically; nobody clocks them." : 'People clock out for a break and back in; the clocked breaks are deducted.')
  return lines
}

// ---- the day ------------------------------------------------------------------------------------------------------------

/** One planned day of the person (B-W2b-32's planner): its shifts (instants, breaks placed), or a day off, or nothing. */
export interface PlannedDay {
  readonly date: BusinessDate
  /** WORK: shifts planned; OFF: a day off (the roster's, or the calendar's rest day or holiday); NONE: no default shift. */
  readonly kind: 'WORK' | 'OFF' | 'NONE'
  readonly shifts: readonly ShiftWindow[]
}

/** The working-time limits the day is checked against (WorkingTimeRule, the most specific ACTIVE one; else the law's). */
export interface DayRules {
  readonly breakRule: { readonly limitMinutes: number; readonly breakMinutes: number; readonly ruleId: string | null }
  readonly dailyRest: { readonly limitMinutes: number; readonly ruleId: string | null }
  readonly maxDayMinutes: number
}

export const LAW_DAY_RULES: DayRules = Object.freeze({
  breakRule: Object.freeze({ limitMinutes: CLOCK_RULES.breakAfterMinutes, breakMinutes: CLOCK_RULES.breakMinutes, ruleId: null }),
  dailyRest: Object.freeze({ limitMinutes: 11 * 60, ruleId: null }),
  maxDayMinutes: ATTENDANCE_RULES.maxDayMinutes,
})

export interface DayInput {
  readonly date: BusinessDate
  readonly timeZone: string
  readonly now: Date
  readonly settings: AttendanceSettings
  /** The planned days around the day (the day before, the day, the day after: a stretch is placed by its shift). */
  readonly plans: readonly PlannedDay[]
  /** The person's clock events around the day (from the day before's midnight to two days after), voids included. */
  readonly events: readonly ClockFact[]
  /** The minutes of the day's absences (AbsenceEntry). */
  readonly absenceMinutes: readonly number[]
  readonly rules: DayRules
}

/** What a day found wrong, with the rule that found it. */
export interface FoundAnomaly {
  readonly kind: AnomalyKind
  readonly ruleKey: string
  readonly clockEventId: string | null
  readonly workingTimeRuleId: string | null
  readonly detail: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

export interface DayFigures {
  readonly firstInAt: Date | null
  readonly lastOutAt: Date | null
  readonly presentMinutes: number
  readonly breakMinutes: number
  readonly ordinaryMinutes: number
  readonly overtimeMinutes: number
  readonly nightMinutes: number
  readonly holidayMinutes: number
  readonly absenceMinutes: number
}

export interface PlannedShift {
  readonly label: string | null
  /** Minutes from the date's midnight (site time zone); a night shift ends past 1440. */
  readonly startMinute: number
  readonly endMinute: number
  /** The working minutes (the window less its break). */
  readonly minutes: number
}

export interface ComputedDay {
  readonly date: BusinessDate
  readonly planned: PlannedShift | null
  readonly plannedKind: PlannedDay['kind']
  readonly figures: DayFigures
  readonly anomalies: FoundAnomaly[]
  /** Someone clocked in that day (a stretch belongs to it). */
  readonly presence: boolean
  /** A stretch of the day is still open and younger than 13 hours: the day is not over. */
  readonly running: boolean
  /** The ids of the clock events that belong to the day (counted, voided and VOID ones), oldest first. */
  readonly eventIds: string[]
}

interface Span {
  readonly start: number
  readonly end: number
}

interface Stretch {
  readonly inEvent: ClockFact
  outEvent: ClockFact | null
  /** The clocked breaks (an OUT ends one; an open one at the end: up to the stretch's end). */
  readonly breaks: { start: number; end: number | null }[]
  /** Other counted events inside it (breaks, a double clock-in), for the flags. */
  readonly inside: ClockFact[]
  /** Closed as never clocked out (open past 13 hours, or a later clock-in or clock-out came too late). */
  forgotten: boolean
}

const MINUTE = 60_000
const OPEN_LIMIT_MS = CLOCK_RULES.openLimitMinutes * MINUTE
/** A clock-out up to a day after its clock-in still closes it (a long day is LONG_DAY, not two anomalies). */
const JOIN_LIMIT_MS = 24 * 60 * MINUTE

const total = (spans: readonly Span[]): number => spans.reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0)

/** Spans less the cut spans (both sorted or not). */
function minus(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let out = spans.map((span) => ({ ...span }))
  for (const cut of cuts) {
    const next: Span[] = []
    for (const span of out) {
      if (cut.end <= span.start || cut.start >= span.end) {
        next.push(span)
        continue
      }
      if (cut.start > span.start) next.push({ start: span.start, end: cut.start })
      if (cut.end < span.end) next.push({ start: cut.end, end: span.end })
    }
    out = next
  }
  return out.filter((span) => span.end > span.start)
}

const intersect = (spans: readonly Span[], window: Span): Span[] =>
  spans.map((span) => ({ start: Math.max(span.start, window.start), end: Math.min(span.end, window.end) })).filter((span) => span.end > span.start)

/** The stretches of the counted events (see the module's comment), and the clock-outs with no clock-in. */
export function stretchesOf(events: readonly ClockFact[], now: Date): { stretches: Stretch[]; orphans: ClockFact[]; doubles: ClockFact[] } {
  const stretches: Stretch[] = []
  const orphans: ClockFact[] = []
  const doubles: ClockFact[] = []
  let open: Stretch | null = null
  const close = (at: number) => {
    if (open) {
      const pause = open.breaks.at(-1)
      if (pause && pause.end === null) pause.end = at
    }
  }
  for (const event of countedEvents(events)) {
    const at = event.occurredAt.getTime()
    // A clock-in more than 13 hours after the open one starts a new day (the clock's reading: the old one was forgotten);
    // a clock-out or a break more than a day after it no longer belongs to it.
    const limit = event.kind === 'IN' ? OPEN_LIMIT_MS : JOIN_LIMIT_MS
    if (open && at - open.inEvent.occurredAt.getTime() > limit) {
      close(open.inEvent.occurredAt.getTime())
      open.forgotten = true
      open = null
    }
    switch (event.kind) {
      case 'IN': {
        if (!open) {
          open = { inEvent: event, outEvent: null, breaks: [], inside: [], forgotten: false }
          stretches.push(open)
          break
        }
        const pause = open.breaks.at(-1)
        if (pause && pause.end === null) {
          // Back from a break by a clock-in (standingOf's reading).
          pause.end = at
          open.inside.push(event)
        } else {
          open.inside.push(event)
          doubles.push(event)
        }
        break
      }
      case 'OUT':
        if (!open) {
          orphans.push(event)
          break
        }
        close(at)
        open.outEvent = event
        open = null
        break
      case 'BREAK_OUT':
        if (open) {
          const pause = open.breaks.at(-1)
          if (!pause || pause.end !== null) open.breaks.push({ start: at, end: null })
          open.inside.push(event)
        }
        break
      case 'BREAK_IN':
        if (open) {
          const pause = open.breaks.at(-1)
          if (pause && pause.end === null) pause.end = at
          open.inside.push(event)
        }
        break
      default:
        break
    }
  }
  if (open && now.getTime() - open.inEvent.occurredAt.getTime() > OPEN_LIMIT_MS) {
    close(open.inEvent.occurredAt.getTime())
    open.forgotten = true
  }
  return { stretches, orphans, doubles }
}

/** The day a stretch belongs to: its shift's (the clock-in fits it), else its clock-in's. */
function dayOfStretch(stretch: Stretch, shifts: readonly ShiftWindow[], timeZone: string): { date: BusinessDate; shift: ShiftWindow | null } {
  const shift = shiftForClockIn(shifts, stretch.inEvent.occurredAt)
  return shift ? { date: shift.date, shift } : { date: businessDate(stretch.inEvent.occurredAt, timeZone), shift: null }
}

/** The day a clock-out with no clock-in belongs to: the latest shift started before it (within 13 hours of its end), else its own. */
function dayOfOrphan(event: ClockFact, shifts: readonly ShiftWindow[], timeZone: string): BusinessDate {
  const at = event.occurredAt.getTime()
  const fits = shifts.filter((shift) => shift.startsAt.getTime() <= at && at <= shift.endsAt.getTime() + OPEN_LIMIT_MS).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
  return fits[0]?.date ?? businessDate(event.occurredAt, timeZone)
}

/** An instant counted by the rounding (nearest unit; none: to the minute). */
export function roundInstant(at: number, unitMinutes: number): number {
  if (unitMinutes <= 0) return Math.floor(at / MINUTE) * MINUTE
  const unit = unitMinutes * MINUTE
  return Math.round(at / unit) * unit
}

/** Where a clock-in counts from (early clock-in, lateness grace, rounding). */
export function countedIn(at: number, shift: ShiftWindow | null, settings: AttendanceSettings, outAt: number): number {
  if (shift) {
    const start = shift.startsAt.getTime()
    if (at < start && settings.earlyClockInFromShiftStart && outAt > start) return start
    if (at >= start && at <= start + settings.lateGraceMinutes * MINUTE) return start
  }
  return roundInstant(at, settings.roundingMinutes)
}

const minutesOf = (ms: number): number => Math.max(0, Math.floor(ms / MINUTE))
const capDay = (minutes: number): number => Math.min(1440, Math.max(0, minutes))

/**
 * One person's attendance day (see the module's comment): the planned shift, the minutes by kind, the anomalies with
 * the rule that found each, whether anyone clocked in and whether the day is still running.
 */
export function computeDay(input: DayInput): ComputedDay {
  const { date, timeZone, settings, rules } = input
  const allShifts = input.plans.flatMap((plan) => plan.shifts)
  const plan = input.plans.find((entry) => entry.date === date) ?? { date, kind: 'NONE' as const, shifts: [] }
  const { stretches, orphans, doubles } = stretchesOf(input.events, input.now)
  const placed = stretches.map((stretch) => ({ stretch, ...dayOfStretch(stretch, allShifts, timeZone) }))
  const mine = placed.filter((entry) => entry.date === date)
  const myOrphans = orphans.filter((event) => dayOfOrphan(event, allShifts, timeZone) === date)

  // The day's shift: the one its first stretch fits, else the day's first planned shift.
  const dayShift = mine.find((entry) => entry.shift && entry.shift.date === date)?.shift ?? plan.shifts[0] ?? null
  const midnight = businessDayStart(date, timeZone).getTime()
  const planned: PlannedShift | null =
    dayShift && plan.kind === 'WORK'
      ? (() => {
          const startMinute = Math.round((dayShift.startsAt.getTime() - midnight) / MINUTE)
          const endMinute = Math.round((dayShift.endsAt.getTime() - midnight) / MINUTE)
          return { label: dayShift.label, startMinute, endMinute, minutes: Math.max(0, endMinute - startMinute - dayShift.breakMinutes) }
        })()
      : null

  // Closed stretches count; an open one counts nothing until it is closed (or fixed by a person).
  const presence: Span[] = []
  const clocked: Span[] = []
  let running = false
  for (const { stretch, shift } of mine) {
    if (!stretch.outEvent) {
      if (!stretch.forgotten) running = true
      continue
    }
    const outAt = roundInstant(stretch.outEvent.occurredAt.getTime(), settings.roundingMinutes)
    const inAt = countedIn(stretch.inEvent.occurredAt.getTime(), shift ?? (plan.kind === 'WORK' ? dayShift : null), settings, outAt)
    if (outAt <= inAt) continue
    presence.push({ start: inAt, end: outAt })
    if (!settings.fixedBreaks) {
      for (const pause of stretch.breaks) {
        const end = pause.end ?? stretch.outEvent.occurredAt.getTime()
        const span = { start: roundInstant(pause.start, settings.roundingMinutes), end: roundInstant(end, settings.roundingMinutes) }
        if (span.end > span.start) clocked.push(span)
      }
    }
  }
  const spanMs = total(presence)
  let breakSpans: Span[] = []
  let unplaced = 0
  if (settings.fixedBreaks) {
    if (dayShift && plan.kind === 'WORK') {
      if (dayShift.breaks.length > 0) breakSpans = dayShift.breaks.map((pause) => ({ start: pause.startsAt.getTime(), end: pause.endsAt.getTime() }))
      else if (dayShift.breakMinutes > 0 && minutesOf(spanMs) >= ATTENDANCE_RULES.unplacedBreakAfterMinutes) unplaced = dayShift.breakMinutes * MINUTE
    }
  } else {
    breakSpans = clocked
  }
  const worked = minus(presence, breakSpans)
  const breakMs = Math.min(spanMs, spanMs - total(worked) + unplaced)
  const presentMs = Math.max(0, spanMs - breakMs)

  let ordinaryMs = 0
  if (planned && dayShift) {
    const inside = total(intersect(worked, { start: dayShift.startsAt.getTime(), end: dayShift.endsAt.getTime() }))
    ordinaryMs = Math.min(Math.max(0, inside - unplaced), planned.minutes * MINUTE)
  }
  const ordinary = minutesOf(ordinaryMs)
  const present = minutesOf(presentMs)
  const unit = Math.max(1, settings.overtimeUnitMinutes)
  const overtime = Math.floor(Math.max(0, present - ordinary) / unit) * unit
  let nightMs = 0
  for (const day of [plusDays(date, -1), date, plusDays(date, 1)]) {
    const window = { start: localInstant(day, ATTENDANCE_RULES.nightStartMinute, timeZone).getTime(), end: localInstant(day, 1440 + ATTENDANCE_RULES.nightEndMinute, timeZone).getTime() }
    nightMs += total(intersect(worked, window))
  }
  const holiday = plan.kind === 'OFF' ? present : 0

  const closed = mine.filter((entry) => entry.stretch.outEvent)
  const firstIn = mine[0]?.stretch.inEvent.occurredAt ?? null
  const lastOut = closed.at(-1)?.stretch.outEvent?.occurredAt ?? null

  // ---- anomalies ----
  const anomalies: FoundAnomaly[] = []
  const found = (kind: AnomalyKind, ruleKey: string, clockEventId: string | null, detail: FoundAnomaly['detail'] = {}, workingTimeRuleId: string | null = null) =>
    anomalies.push({ kind, ruleKey, clockEventId, workingTimeRuleId, detail })
  for (const { stretch } of mine) {
    if (stretch.forgotten) found('MISSING_CLOCK_OUT', 'people.clock.openLimit', stretch.inEvent.id, { inAt: stretch.inEvent.occurredAt.toISOString(), limitMinutes: CLOCK_RULES.openLimitMinutes })
    else if (stretch.outEvent?.source === 'AUTO') found('MISSING_CLOCK_OUT', 'people.autoClockOutAfterMinutes', stretch.outEvent.id, { auto: true, outAt: stretch.outEvent.occurredAt.toISOString(), afterMinutes: settings.autoClockOutAfterMinutes ?? 0 })
  }
  for (const event of myOrphans) found('MISSING_CLOCK_IN', 'people.clock.outWithoutIn', event.id, { outAt: event.occurredAt.toISOString() })
  const mineIds = new Set(mine.flatMap(({ stretch }) => [stretch.inEvent.id, ...stretch.inside.map((event) => event.id), ...(stretch.outEvent ? [stretch.outEvent.id] : [])]))
  for (const event of doubles) if (mineIds.has(event.id)) found('DOUBLE_CLOCK_IN', 'people.clock.doubleIn', event.id, { inAt: event.occurredAt.toISOString() })
  // Over the day's maximum: the time at work as clocked (raw clock-in to clock-out), not as counted.
  const spanMinutes = minutesOf(mine.reduce((sum, { stretch }) => sum + (stretch.outEvent ? stretch.outEvent.occurredAt.getTime() - stretch.inEvent.occurredAt.getTime() : 0), 0))
  if (spanMinutes > rules.maxDayMinutes) found('LONG_DAY', 'people.attendance.maxDayMinutes', null, { limitMinutes: rules.maxDayMinutes, foundMinutes: spanMinutes })
  if (mine.length > 0 && plan.kind !== 'WORK') found('NO_SHIFT', 'people.attendance.noShift', null, { planned: plan.kind })
  const dayEvents = [...mine.flatMap(({ stretch }) => [stretch.inEvent, ...stretch.inside, ...(stretch.outEvent ? [stretch.outEvent] : [])]), ...myOrphans]
  for (const event of dayEvents) if (event.flags.length > 0) found('FLAGGED_EVENT', 'people.clock.flagged', event.id, { flags: [...event.flags] })
  if (firstIn) {
    const own = new Set([...mineIds, ...myOrphans.map((event) => event.id)])
    const before = countedEvents(input.events).filter((event) => event.kind === 'OUT' && event.occurredAt.getTime() < firstIn.getTime() && !own.has(event.id))
    const previous = before.at(-1)
    if (previous) {
      const rest = minutesOf(firstIn.getTime() - previous.occurredAt.getTime())
      if (rest < rules.dailyRest.limitMinutes) found('SHORT_REST', 'time.rule.DAILY_REST', null, { limitMinutes: rules.dailyRest.limitMinutes, foundMinutes: rest }, rules.dailyRest.ruleId)
    }
  }
  const breakMinutes = minutesOf(breakMs)
  if (present > rules.breakRule.limitMinutes && breakMinutes < rules.breakRule.breakMinutes) {
    found('NO_BREAK', 'time.rule.BREAK_AFTER', null, { limitMinutes: rules.breakRule.limitMinutes, breakMinutes: rules.breakRule.breakMinutes, foundBreakMinutes: breakMinutes }, rules.breakRule.ruleId)
  }

  const allIds = new Set([...mineIds, ...myOrphans.map((event) => event.id)])
  const voids = input.events.filter((event) => event.kind === 'VOID' && event.voidsEventId)
  const voidedOfDay = input.events.filter((event) => voids.some((entry) => entry.voidsEventId === event.id) && businessDate(event.occurredAt, timeZone) === date)
  for (const event of voidedOfDay) allIds.add(event.id)
  for (const entry of voids) if (entry.voidsEventId && allIds.has(entry.voidsEventId)) allIds.add(entry.id)
  const eventIds = input.events.filter((event) => allIds.has(event.id)).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1)).map((event) => event.id)

  return {
    date,
    planned,
    plannedKind: plan.kind,
    figures: {
      firstInAt: firstIn,
      lastOutAt: lastOut && firstIn && lastOut.getTime() >= firstIn.getTime() ? lastOut : null,
      presentMinutes: capDay(present),
      breakMinutes: capDay(breakMinutes),
      ordinaryMinutes: capDay(ordinary),
      overtimeMinutes: capDay(overtime),
      nightMinutes: capDay(minutesOf(nightMs)),
      holidayMinutes: capDay(holiday),
      absenceMinutes: capDay(input.absenceMinutes.reduce((sum, minutes) => sum + minutes, 0)),
    },
    anomalies,
    presence: mine.length > 0,
    running,
    eventIds,
  }
}

// ---- anomalies: raise, clear, fix -------------------------------------------------------------------------------------

/** An anomaly already on the day. */
export interface StoredAnomaly {
  readonly id: string
  readonly kind: AnomalyKind
  readonly clockEventId: string | null
  readonly resolution: AnomalyResolution | null
}

export const anomalyKey = (anomaly: { readonly kind: string; readonly clockEventId: string | null }): string => `${anomaly.kind}|${anomaly.clockEventId ?? ''}`

/**
 * What a new computation does to the day's anomalies: raise those found that are not open already (an anomaly a person
 * ACCEPTED stays accepted and is not raised again; a fixed or cleared one found again is raised again), and resolve the
 * open ones no longer found (CLEARED by the system, or FIXED when a person's fix made it go).
 */
export function reconcileAnomalies(stored: readonly StoredAnomaly[], found: readonly FoundAnomaly[]): { readonly raise: FoundAnomaly[]; readonly resolve: string[]; readonly open: number } {
  const open = new Map(stored.filter((entry) => entry.resolution === null).map((entry) => [anomalyKey(entry), entry]))
  const accepted = new Set(stored.filter((entry) => entry.resolution === 'ACCEPTED').map(anomalyKey))
  const foundKeys = new Set<string>()
  const raise: FoundAnomaly[] = []
  for (const anomaly of found) {
    const key = anomalyKey(anomaly)
    if (foundKeys.has(key)) continue
    foundKeys.add(key)
    if (open.has(key) || accepted.has(key)) continue
    raise.push(anomaly)
  }
  const resolve = [...open.entries()].filter(([key]) => !foundKeys.has(key)).map(([, entry]) => entry.id)
  return { raise, resolve, open: open.size - resolve.length + raise.length }
}

/** The status a computed day takes (an approved or closed day is never computed again: reopen it first). */
export const statusAfter = (openAnomalies: number): 'OPEN' | 'NEEDS_FIX' => (openAnomalies > 0 ? 'NEEDS_FIX' : 'OPEN')

// ---- words ------------------------------------------------------------------------------------------------------------

/** "How this anomaly is found": the rule and its setting, in words. */
export function ruleWords(kind: AnomalyKind, detail: FoundAnomaly['detail'] | null, settings: AttendanceSettings): string {
  const value = (key: string): number | null => (typeof detail?.[key] === 'number' ? (detail[key] as number) : null)
  switch (kind) {
    case 'MISSING_CLOCK_OUT':
      return detail?.auto
        ? `The automatic clock-out closed the day at the shift end + ${value('afterMinutes') ?? settings.autoClockOutAfterMinutes ?? 0} min (People settings); a person checks the real time.`
        : `A clock-in open for more than ${durationText(CLOCK_RULES.openLimitMinutes)} was never closed (24 h less the 11 h of daily rest, D.Lgs. 66/2003 art. 7).`
    case 'MISSING_CLOCK_IN':
      return 'A clock-out with no clock-in before it.'
    case 'DOUBLE_CLOCK_IN':
      return 'A clock-in while already clocked in: the first one counts.'
    case 'LONG_DAY':
      return `Over ${durationText(value('limitMinutes') ?? ATTENDANCE_RULES.maxDayMinutes)} from the first clock-in to the last clock-out (People settings).`
    case 'NO_SHIFT':
      return 'Clocked in on a day with no shift planned (People › Shifts: the roster, else the default shift).'
    case 'SCANS_WITHOUT_CLOCK_IN':
      return 'Work recorded on the floor while not clocked in.'
    case 'FLAGGED_EVENT':
      return 'A clock event the tablet flagged for the team leader: signed by name and PIN (forgot the badge), or kept offline while the tablet clock looked wrong.'
    case 'SHORT_REST':
      return `Less than ${durationText(value('limitMinutes') ?? 660)} of rest since the last clock-out (D.Lgs. 66/2003 art. 7; the working-time limit in force).`
    case 'NO_BREAK':
      return `Over ${durationText(value('limitMinutes') ?? CLOCK_RULES.breakAfterMinutes)} worked with less than ${value('breakMinutes') ?? CLOCK_RULES.breakMinutes} minutes of break (D.Lgs. 66/2003 art. 8; the working-time limit in force).`
  }
}

/** The anomaly in words ("Clock-out missing; automatic clock-out at 22:15 after shift end + 15 min"). */
export function anomalyWords(kind: AnomalyKind, detail: FoundAnomaly['detail'] | null, timeZone: string): string {
  const at = (key: string): string | null => (typeof detail?.[key] === 'string' ? timeText(new Date(detail[key] as string), timeZone) : null)
  const num = (key: string): number => (typeof detail?.[key] === 'number' ? (detail[key] as number) : 0)
  switch (kind) {
    case 'MISSING_CLOCK_OUT':
      return detail?.auto ? `Clock-out missing; automatic clock-out at ${at('outAt') ?? '—'} after shift end + ${num('afterMinutes')} min.` : `Clock-out missing after the clock-in at ${at('inAt') ?? '—'}.`
    case 'MISSING_CLOCK_IN':
      return `Clock-in missing before the clock-out at ${at('outAt') ?? '—'}.`
    case 'DOUBLE_CLOCK_IN':
      return `Clocked in twice: again at ${at('inAt') ?? '—'}.`
    case 'LONG_DAY':
      return `Over ${durationText(num('limitMinutes'))}: ${durationText(num('foundMinutes'))} from the first clock-in to the last clock-out.`
    case 'NO_SHIFT':
      return detail?.planned === 'OFF' ? 'Clocked in on a day off.' : 'Clocked in with no shift planned.'
    case 'SCANS_WITHOUT_CLOCK_IN':
      return 'Scans without a clock-in.'
    case 'FLAGGED_EVENT': {
      const flags = Array.isArray(detail?.flags) ? (detail.flags as readonly string[]) : []
      return flags.map((flag) => FLAG_WORDS[flag as ClockFlag] ?? flag).join(' ') || 'A flagged clock event.'
    }
    case 'SHORT_REST':
      return `Rest of ${durationText(num('foundMinutes'))} since the last clock-out, under ${durationText(num('limitMinutes'))}.`
    case 'NO_BREAK':
      return `No break of ${num('breakMinutes')} minutes in a day over ${durationText(num('limitMinutes'))} (${num('foundBreakMinutes')} min taken).`
  }
}

// ---- approval -------------------------------------------------------------------------------------------------------

export const APPROVAL_HOLDS = ['ALREADY_APPROVED', 'CLOSED', 'NOT_OVER', 'RUNNING', 'ANOMALIES_OPEN', 'NO_ABSENCE_CODE', 'OWN_DAY'] as const
export type ApprovalHold = (typeof APPROVAL_HOLDS)[number]

export interface ApprovalFacts {
  readonly status: DayStatus
  readonly date: BusinessDate
  readonly today: BusinessDate
  readonly openAnomalies: number
  /** Someone clocked in that day. */
  readonly presence: boolean
  /** A shift was planned that day. */
  readonly plannedWork: boolean
  readonly absenceMinutes: number
  readonly running: boolean
  /** The day is the approver's own (their employee record). */
  readonly own: boolean
}

export const HOLD_WORDS: Readonly<Record<ApprovalHold, string>> = Object.freeze({
  ALREADY_APPROVED: 'This day is approved already.',
  CLOSED: "This day's month is closed: it changes only by a correction.",
  NOT_OVER: 'This day is not over yet: approve it from tomorrow.',
  RUNNING: 'Someone is still clocked in on this day.',
  ANOMALIES_OPEN: 'This day has anomalies open: fix them or accept them with a note first.',
  NO_ABSENCE_CODE: 'A shift was planned and nobody clocked in: set the absence code first.',
  OWN_DAY: 'Nobody approves their own attendance day: another person does (D.Lgs. 152/1997 art. 1-bis).',
})

/** Why a day cannot be approved now (empty: it may). */
export function approvalHolds(facts: ApprovalFacts): ApprovalHold[] {
  if (facts.status === 'APPROVED') return ['ALREADY_APPROVED']
  if (facts.status === 'CLOSED') return ['CLOSED']
  const holds: ApprovalHold[] = []
  if (facts.own) holds.push('OWN_DAY')
  if (facts.date >= facts.today) holds.push('NOT_OVER')
  if (facts.running) holds.push('RUNNING')
  if (facts.openAnomalies > 0) holds.push('ANOMALIES_OPEN')
  if (facts.plannedWork && !facts.presence && facts.absenceMinutes === 0) holds.push('NO_ABSENCE_CODE')
  return holds
}

/** A day where a shift was planned, nobody clocked in, the day is over and no absence was coded ("Absences without a code"). */
export const absenceMissing = (facts: Pick<ApprovalFacts, 'plannedWork' | 'presence' | 'absenceMinutes' | 'date' | 'today'>): boolean =>
  facts.plannedWork && !facts.presence && facts.absenceMinutes === 0 && facts.date < facts.today

// ---- manual entries (MES-238) ---------------------------------------------------------------------------------------

/** Why a manual entry is made (the list of the "Manual entry" and "Fix a day" windows; the text says the rest). */
export const MANUAL_REASONS = ['FORGOT_CLOCK_IN', 'FORGOT_CLOCK_OUT', 'BADGE_PROBLEM', 'TABLET_PROBLEM', 'DUPLICATE', 'OFF_SITE', 'ABSENCE', 'OTHER'] as const
export type ManualReason = (typeof MANUAL_REASONS)[number]

/** The reason as stored on the clock event: never health details (a sickness is a code and a certificate number). */
export function reasonProblems(reason: unknown, at = 'reason'): Issue[] {
  if (typeof reason !== 'string' || reason.trim().length < ATTENDANCE_RULES.reasonMin) return [{ path: at, message: 'Say why: a manual entry always carries its reason (it is marked in the LUL calendar).' }]
  if (reason.trim().length > ATTENDANCE_RULES.reasonMax) return [{ path: at, message: `Keep the reason to ${ATTENDANCE_RULES.reasonMax} characters.` }]
  return []
}

export const MANUAL_WORDS = 'Manual entries are marked in the LUL calendar.'

/** A day in the future cannot take a clock event (the database never dates one ahead); the window to enter one. */
export function manualTimeProblems(at: Date, now: Date, path = 'at'): Issue[] {
  if (at.getTime() > now.getTime() + CLOCK_RULES.aheadGraceSeconds * 1000) return [{ path, message: 'A clock event is never entered ahead of time: enter it once it has happened.' }]
  return []
}

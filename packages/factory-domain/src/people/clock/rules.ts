import { isoWeekday, localInstant, plusDays } from '../../calendars/dates'
import { shiftsOf, type Segment } from '../../calendars/patterns'
import { businessDate, businessDayStart, type BusinessDate } from '../../core/time'

/**
 * Clock in and out (B-W2b-33; MES-223 clock in and out, MES-224 breaks, MES-227 automatic clock-out, MES-239 forgot badge,
 * MES-199 offline clock-in and clock-out; design floor.clock SCR-170 "Your time today", "Breaks", "Forgot your badge",
 * "Offline clocking"), pure. apps/factory-api modules/people/clock records one ClockEvent per action and reads them back;
 * the rules here say what an action means, when it is refused and in which words.
 *
 *   who      a badge alone (Owner answer F1: badge alone starts work), or the worker's name and PIN when the badge was
 *            forgotten (flagged FORGOT_BADGE for the team leader). No biometrics, ever (GDPR art. 9; Garante): nothing
 *            here reads a face or a fingerprint.
 *   when     online: the server's time. Offline: the tablet's time, kept as it was (MES-199), flagged CLOCK_SKEW when the
 *            tablet's clock was more than 5 minutes off when it sent; a time in the future is never kept (the database
 *            refuses a clock event dated over 2 minutes after it arrived).
 *   state    from the person's counted events (VOID events and the events they void left out): OUT (not clocked in),
 *            IN, or ON_BREAK. A clock-in older than 13 hours was never closed (24 hours less the 11 hours of daily rest,
 *            D.Lgs. 66/2003 art. 7): it counts as forgotten, a new clock-in starts a new day and the team leader
 *            corrects the old one (B-W2b-37 raises the anomaly).
 *   breaks   fixed (PeopleSettings.fixedBreaks): the shift's breaks are deducted, nobody clocks them; clocked: Break out
 *            and Back from break (D.Lgs. 66/2003 art. 8: a break after 6 hours of work).
 *   auto     an open clock-in is closed at the shift's end plus the company's tolerance (autoClockOutAfterMinutes; null:
 *            never, the day is flagged instead), at that time, with the rule in words. A clock-in with no shift that
 *            fits it is never closed by the rule.
 *
 * Attendance is art. 4 c.2 of the Statuto dei Lavoratori: no union agreement, but the worker notice and the impact
 * assessment before live use (GATE-LABOUR: the site's ATTENDANCE gate, checked by the API before anything is read or
 * recorded). The hours here are the raw minutes so far, for the worker's own screen; the day's counted hours (rounding,
 * grace, anomalies) are the attendance day's (B-W2b-37).
 */

export const CLOCK_ACTIONS = ['IN', 'OUT', 'BREAK_OUT', 'BREAK_IN'] as const
export type ClockAction = (typeof CLOCK_ACTIONS)[number]

/** Every kind a clock event has (VOID: a person's correction in the office, B-W2b-37). */
export const CLOCK_KINDS = [...CLOCK_ACTIONS, 'VOID'] as const
export type ClockKind = (typeof CLOCK_KINDS)[number]

export const CLOCK_SOURCES = ['BADGE', 'NAME_PIN', 'OFFLINE', 'MANUAL', 'AUTO'] as const
export type ClockSource = (typeof CLOCK_SOURCES)[number]

export const CLOCK_FLAGS = ['FORGOT_BADGE', 'CLOCK_SKEW'] as const
export type ClockFlag = (typeof CLOCK_FLAGS)[number]

export const CLOCK_STATES = ['OUT', 'IN', 'ON_BREAK'] as const
export type ClockState = (typeof CLOCK_STATES)[number]

/** How the person showed who they are: a badge, or their name and PIN. */
export const CLOCK_WAYS = ['BADGE', 'NAME'] as const
export type ClockWay = (typeof CLOCK_WAYS)[number]

export const CLOCK_RULES = Object.freeze({
  /** A badge scanned again within this many seconds answers the scan before (a double scan never clocks back out). */
  repeatSeconds: 60,
  /** An open clock-in older than this was never closed: 24 hours less the 11 hours of daily rest (D.Lgs. 66/2003 art. 7). */
  openLimitMinutes: 13 * 60,
  /** The database's grace: a clock event is never dated more than 2 minutes after it arrived. */
  aheadGraceSeconds: 120,
  /** A tablet's clock more than 5 minutes off when it sent: its offline events are flagged (scans' CLOCK_WARN_MS). */
  skewWarnSeconds: 5 * 60,
  /** A clock-in up to 3 hours before a shift's start belongs to that shift (the automatic clock-out finds its end). */
  earlyWindowMinutes: 3 * 60,
  /** How far back the state is read: an open clock-in older than the limit is forgotten anyway. */
  readBackHours: 36,
  /** How far back the automatic clock-out looks for an open clock-in. */
  autoLookBackDays: 7,
  /** D.Lgs. 66/2003 art. 8 when no working-time rule says otherwise: a break after 6 hours, at least 10 minutes. */
  breakAfterMinutes: 6 * 60,
  breakMinutes: 10,
})

export const BREAK_LAW = 'D.Lgs. 66/2003 art. 8'
export const ATTENDANCE_LAW = 'Statuto dei Lavoratori art. 4 c.2-3; GDPR arts. 13, 35'

/** A clock event as the rules read it. */
export interface ClockFact {
  readonly id: string
  readonly kind: ClockKind
  readonly source: ClockSource
  readonly occurredAt: Date
  readonly voidsEventId: string | null
  readonly flags: readonly ClockFlag[]
}

const byTime = (a: ClockFact, b: ClockFact): number => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The events that count, oldest first: VOID events and the events they void are left out. */
export function countedEvents(events: readonly ClockFact[]): ClockFact[] {
  const voided = new Set(events.filter((event) => event.kind === 'VOID' && event.voidsEventId).map((event) => event.voidsEventId!))
  return events.filter((event) => event.kind !== 'VOID' && !voided.has(event.id)).sort(byTime)
}

/** Where a person stands. */
export interface ClockStanding {
  /** As it counts now: a clock-in older than the open limit counts as OUT (forgotten). */
  readonly state: ClockState
  /** IN or ON_BREAK: the clock-in that opened the stretch. */
  readonly since: Date | null
  /** ON_BREAK: when the break began. */
  readonly breakSince: Date | null
  /** The latest counted event. */
  readonly last: ClockFact | null
  /** A clock-in never closed and older than the limit (the team leader corrects it), else null. */
  readonly forgotten: Date | null
  /** The open stretch as recorded, forgotten or not (the automatic clock-out closes it): its clock-in, else null. */
  readonly openSince: Date | null
  /** The clock-in event of the open stretch (forgotten or not). */
  readonly openEventId: string | null
}

/**
 * The person's state after their counted events. Lenient about odd orders (an offline event sent late): a second
 * clock-in keeps the first, a break with no clock-in and a return with no break are ignored, a clock-out ends a break.
 */
export function standingOf(events: readonly ClockFact[], now: Date): ClockStanding {
  let state: ClockState = 'OUT'
  let since: Date | null = null
  let sinceId: string | null = null
  let breakSince: Date | null = null
  const counted = countedEvents(events)
  for (const event of counted) {
    switch (event.kind) {
      case 'IN':
        if (state === 'OUT') {
          state = 'IN'
          since = event.occurredAt
          sinceId = event.id
        } else if (state === 'ON_BREAK') {
          state = 'IN'
          breakSince = null
        }
        break
      case 'OUT':
        state = 'OUT'
        since = null
        sinceId = null
        breakSince = null
        break
      case 'BREAK_OUT':
        if (state === 'IN') {
          state = 'ON_BREAK'
          breakSince = event.occurredAt
        }
        break
      case 'BREAK_IN':
        if (state === 'ON_BREAK') {
          state = 'IN'
          breakSince = null
        }
        break
      default:
        break
    }
  }
  const last = counted.at(-1) ?? null
  const forgotten = since !== null && now.getTime() - since.getTime() > CLOCK_RULES.openLimitMinutes * 60_000 ? since : null
  return {
    state: forgotten ? 'OUT' : state,
    since: forgotten ? null : since,
    breakSince: forgotten ? null : breakSince,
    last,
    forgotten,
    openSince: since,
    openEventId: sinceId,
  }
}

/** What a badge scanned on the clock does now: in when out, out when in, back from the break when on one. */
export function nextActionOf(standing: Pick<ClockStanding, 'state'>): ClockAction {
  return standing.state === 'OUT' ? 'IN' : standing.state === 'IN' ? 'OUT' : 'BREAK_IN'
}

/** The buttons the clock offers now (the first is the main one). */
export function actionsOf(standing: Pick<ClockStanding, 'state'>, fixedBreaks: boolean): ClockAction[] {
  if (standing.state === 'OUT') return ['IN']
  if (standing.state === 'IN') return fixedBreaks ? ['OUT'] : ['OUT', 'BREAK_OUT']
  return ['BREAK_IN', 'OUT']
}

/** A scan again within the repeat window: the event it repeats (nothing is recorded twice), else null. */
export function repeatOf(standing: Pick<ClockStanding, 'last'>, now: Date): ClockFact | null {
  const last = standing.last
  if (!last || last.source === 'AUTO' || last.source === 'MANUAL') return null
  const age = now.getTime() - last.occurredAt.getTime()
  return age >= 0 && age < CLOCK_RULES.repeatSeconds * 1000 ? last : null
}

/** The state an action leads to. */
export const stateAfter = (action: ClockAction): ClockState => (action === 'BREAK_OUT' ? 'ON_BREAK' : action === 'OUT' ? 'OUT' : 'IN')

// ---- refusals -------------------------------------------------------------------------------------------------------------------

export const CLOCK_REFUSAL_CODES = [
  'ALREADY_IN',
  'NOT_IN',
  'ON_BREAK',
  'NOT_ON_BREAK',
  'ALREADY_ON_BREAK',
  'BREAKS_FIXED',
  'NO_EMPLOYEE',
  'EMPLOYEE_LEFT',
  'CLOCK_AHEAD',
  'MONTH_CLOSED',
  'OTHER_PERSON',
] as const
export type ClockRefusalCode = (typeof CLOCK_REFUSAL_CODES)[number]

/** A refusal in words: what happened, the one thing to do, and whether sending it again later can pass (offline). */
export interface ClockRefusal {
  readonly code: ClockRefusalCode
  readonly message: string
  readonly fix: string
  readonly final: boolean
}

const hhmm = new Map<string, Intl.DateTimeFormat>()

/** `HH:MM` of an instant in a time zone. */
export function timeText(at: Date, timeZone: string): string {
  let format = hhmm.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    hhmm.set(timeZone, format)
  }
  return format.format(at)
}

/** `30 Oct 08:00` (another day than `now`'s) or `08:00` (the same day), in the site's time zone. */
export function whenText(at: Date, now: Date, timeZone: string): string {
  const time = timeText(at, timeZone)
  const day = businessDate(at, timeZone)
  if (day === businessDate(now, timeZone)) return time
  const [, month, date] = day.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(date)} ${months[Number(month) - 1]} ${time}`
}

/** Whole minutes as `4 h 12 min` / `35 min`. */
export function durationText(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes))
  const hours = Math.floor(whole / 60)
  const rest = whole % 60
  return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/**
 * Why an action is refused in the person's state (null: it may be recorded). `fixedBreaks`: breaks are deducted, not
 * clocked. An online action only: an offline one is kept as the tablet recorded it (the attendance day judges it).
 */
export function actionRefusal(standing: ClockStanding, action: ClockAction, facts: { readonly fixedBreaks: boolean; readonly timeZone: string; readonly now: Date }): ClockRefusal | null {
  const at = (when: Date | null) => (when ? whenText(when, facts.now, facts.timeZone) : '')
  if ((action === 'BREAK_OUT' || action === 'BREAK_IN') && facts.fixedBreaks) {
    return {
      code: 'BREAKS_FIXED',
      message: `Breaks are deducted from your shift automatically here: nobody clocks them (${BREAK_LAW}).`,
      fix: 'Just take your break at its time; clock out only when you leave.',
      final: true,
    }
  }
  switch (standing.state) {
    case 'OUT':
      if (action === 'IN') return null
      return {
        code: 'NOT_IN',
        message: standing.forgotten
          ? `You are not clocked in: your clock-in of ${at(standing.forgotten)} was never closed.`
          : 'You are not clocked in.',
        fix: standing.forgotten ? 'Clock in now; your team leader corrects the day you did not clock out.' : 'Clock in first.',
        final: true,
      }
    case 'IN':
      if (action === 'OUT' || action === 'BREAK_OUT') return null
      if (action === 'IN') return { code: 'ALREADY_IN', message: `You are clocked in since ${at(standing.since)}.`, fix: 'Clock out when you leave.', final: true }
      return { code: 'NOT_ON_BREAK', message: 'You are not on a break.', fix: 'Tap Break when you start one.', final: true }
    case 'ON_BREAK':
      if (action === 'BREAK_IN' || action === 'OUT') return null
      if (action === 'BREAK_OUT') return { code: 'ALREADY_ON_BREAK', message: `You are on a break since ${at(standing.breakSince)}.`, fix: 'Tap Back from break when it ends.', final: true }
      return { code: 'ON_BREAK', message: `You are on a break since ${at(standing.breakSince)}.`, fix: 'Tap Back from break.', final: true }
  }
}

export const NO_EMPLOYEE: ClockRefusal = {
  code: 'NO_EMPLOYEE',
  message: 'You are not on the staff list yet, so the clock cannot record you.',
  fix: 'Ask HR to add you in People › Employees and link your floor sign-in.',
  final: true,
}

export const EMPLOYEE_LEFT: ClockRefusal = {
  code: 'EMPLOYEE_LEFT',
  message: 'Your employment has ended: the clock no longer records you.',
  fix: 'Ask HR if this is a mistake.',
  final: true,
}

export const MONTH_CLOSED: ClockRefusal = {
  code: 'MONTH_CLOSED',
  message: "This day is in a month whose attendance is closed (its LUL calendar is out): the clock records nothing in it.",
  fix: 'Ask HR to correct the closed day.',
  final: true,
}

export const OTHER_PERSON: ClockRefusal = {
  code: 'OTHER_PERSON',
  message: "This clock event was saved for another person: it is sent when they sign in on this tablet, never under someone else's name.",
  fix: 'Ask that person to sign in on this tablet.',
  final: false,
}

/** An offline event whose tablet time is in the future (the tablet's clock ran ahead): never kept. */
export function clockAheadRefusal(deviceTime: Date, now: Date): ClockRefusal | null {
  const ahead = deviceTime.getTime() - now.getTime()
  if (ahead <= CLOCK_RULES.aheadGraceSeconds * 1000) return null
  return {
    code: 'CLOCK_AHEAD',
    message: `This tablet's clock was ${durationText(Math.ceil(ahead / 60_000))} ahead: a clock event is never kept in the future.`,
    fix: "Ask your team leader to enter the time in the office, and have the tablet's clock set.",
    final: true,
  }
}

/** The tablet's clock was more than 5 minutes off when it sent (skew: the server's time less the tablet's). */
export const clockLooksWrong = (skewSeconds: number | null | undefined): boolean => typeof skewSeconds === 'number' && Math.abs(skewSeconds) > CLOCK_RULES.skewWarnSeconds

/** The source and flags of a floor event: how the person showed who they are, and whether it was kept offline. */
export function sourceAndFlags(input: { readonly way: ClockWay; readonly offline: boolean; readonly skewSeconds?: number | null | undefined }): { readonly source: 'BADGE' | 'NAME_PIN' | 'OFFLINE'; readonly flags: ClockFlag[] } {
  const flags: ClockFlag[] = []
  if (input.way === 'NAME') flags.push('FORGOT_BADGE')
  if (!input.offline) return { source: input.way === 'BADGE' ? 'BADGE' : 'NAME_PIN', flags }
  if (clockLooksWrong(input.skewSeconds)) flags.push('CLOCK_SKEW')
  return { source: 'OFFLINE', flags }
}

/** What a flag tells the team leader, in words. */
export const FLAG_WORDS: Readonly<Record<ClockFlag, string>> = Object.freeze({
  FORGOT_BADGE: 'Clocked by name and PIN (forgot the badge): for the team leader to check.',
  CLOCK_SKEW: "Kept offline while the tablet's clock looked wrong: for the team leader to check.",
})

// ---- shifts, breaks and minutes ------------------------------------------------------------------------------------------------

/** A shift of one person on one day, as instants (a night shift ends the next morning). */
export interface ShiftWindow {
  readonly label: string | null
  /** The day it starts (a night shift belongs to the day it starts). */
  readonly date: BusinessDate
  readonly startsAt: Date
  readonly endsAt: Date
  /** The breaks placed in it (from the shift pattern); a shift typed by hand has none placed. */
  readonly breaks: readonly { readonly label: string | null; readonly startsAt: Date; readonly endsAt: Date }[]
  /** The unpaid break minutes of the shift (placed or not). */
  readonly breakMinutes: number
  /** ROSTER: the published roster cell; DEFAULT: the person's default shift pattern. */
  readonly source: 'ROSTER' | 'DEFAULT'
}

/** A day's roster cell as the rules need it (B-W2b-07 RosterEntry, PUBLISHED). */
export interface RosterDay {
  readonly kind: 'WORK' | 'OFF'
  readonly shiftLabel: string | null
  readonly startMinute: number | null
  readonly endMinute: number | null
  readonly breakMinutes: number
  /** The segments of the pattern the shift was taken from (to place its breaks), when it names one. */
  readonly patternSegments: readonly Segment[] | null
}

/**
 * A person's shifts on one day: the published roster cell (a day off: none), else the person's default pattern's
 * shifts of that weekday, else none.
 */
export function shiftsOfDay(input: { readonly date: BusinessDate; readonly timeZone: string; readonly roster: RosterDay | null; readonly defaultSegments: readonly Segment[] | null }): ShiftWindow[] {
  const { date, timeZone, roster } = input
  const at = (minute: number) => localInstant(date, minute, timeZone)
  const weekday = isoWeekday(date)
  if (roster) {
    if (roster.kind === 'OFF' || roster.startMinute === null || roster.endMinute === null) return []
    const start = roster.startMinute
    const end = roster.endMinute
    const breaks = (roster.patternSegments ?? [])
      .filter((segment) => segment.weekday === weekday && segment.kind === 'BREAK' && segment.startMinute >= start && segment.endMinute <= end)
      .sort((a, b) => a.startMinute - b.startMinute)
      .map((segment) => ({ label: segment.label, startsAt: at(segment.startMinute), endsAt: at(segment.endMinute) }))
    return [{ label: roster.shiftLabel, date, startsAt: at(start), endsAt: at(end), breaks, breakMinutes: roster.breakMinutes, source: 'ROSTER' }]
  }
  if (!input.defaultSegments) return []
  return shiftsOf(input.defaultSegments, weekday).map((shift) => ({
    label: shift.label,
    date,
    startsAt: at(shift.startMinute),
    endsAt: at(shift.endMinute),
    breaks: shift.breaks.map((pause) => ({ label: pause.label, startsAt: at(pause.startMinute), endsAt: at(pause.endMinute) })),
    breakMinutes: shift.breaks.reduce((sum, pause) => sum + pause.endMinute - pause.startMinute, 0),
    source: 'DEFAULT',
  }))
}

/** The days whose shifts can hold `at` (the day before for a night shift, and that day), in the site's time zone. */
export const daysAround = (at: Date, timeZone: string): [BusinessDate, BusinessDate] => {
  const day = businessDate(at, timeZone)
  return [plusDays(day, -1), day]
}

/**
 * The shift a clock-in at `at` belongs to: one that ends after it and starts at most 3 hours after it (an early
 * clock-in), the earliest ending first; null when none fits (a clock-in after every shift ended: no rule closes it).
 */
export function shiftForClockIn(shifts: readonly ShiftWindow[], at: Date): ShiftWindow | null {
  const early = CLOCK_RULES.earlyWindowMinutes * 60_000
  const fits = shifts.filter((shift) => shift.endsAt.getTime() > at.getTime() && shift.startsAt.getTime() - early <= at.getTime())
  return fits.sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())[0] ?? null
}

/** The shift to show now: the open stretch's, else the one running now, else the next to start today, else null. */
export function shiftToShow(shifts: readonly ShiftWindow[], standing: Pick<ClockStanding, 'since'>, now: Date, timeZone: string): ShiftWindow | null {
  if (standing.since) return shiftForClockIn(shifts, standing.since)
  const running = shiftForClockIn(shifts, now)
  if (running) return running
  const today = businessDate(now, timeZone)
  return shifts.filter((shift) => shift.date === today && shift.startsAt.getTime() > now.getTime()).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null
}

/** The next fixed break of a shift still to come or running at `now`, or null. */
export function nextBreakOf(shift: ShiftWindow | null, now: Date): ShiftWindow['breaks'][number] | null {
  return shift?.breaks.find((pause) => pause.endsAt.getTime() > now.getTime()) ?? null
}

/** "Deducted automatically 12:00–12:30". */
export const fixedBreakWords = (pause: { readonly startsAt: Date; readonly endsAt: Date }, timeZone: string): string =>
  `Deducted automatically ${timeText(pause.startsAt, timeZone)}–${timeText(pause.endsAt, timeZone)}.`

interface Span {
  readonly start: number
  readonly end: number
}

const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/** The minutes so far from `from` to `now`: present, clocked breaks, fixed breaks deducted, worked (present less both). */
export interface MinutesSoFar {
  readonly present: number
  readonly clockedBreaks: number
  readonly fixedBreaks: number
  readonly worked: number
  /** Worked without a break since the last break (or the clock-in) while still in, for the break reminder. */
  readonly sinceBreak: number
}

/**
 * The raw minutes of the counted events from `from` (the window must start before the open stretch's clock-in) to
 * `now`: present between a clock-in and a clock-out (the open one up to now), less the clocked breaks, less the fixed
 * breaks that fell inside the presence (when breaks are fixed). No rounding and no grace: the attendance day's.
 */
export function minutesSoFar(events: readonly ClockFact[], input: { readonly from: Date; readonly now: Date; readonly fixedBreaks: readonly { readonly startsAt: Date; readonly endsAt: Date }[] }): MinutesSoFar {
  const now = input.now.getTime()
  const present: Span[] = []
  const breaks: Span[] = []
  let inAt: number | null = null
  let breakAt: number | null = null
  let lastBreakEnd: number | null = null
  for (const event of countedEvents(events)) {
    const at = Math.min(event.occurredAt.getTime(), now)
    if (at < input.from.getTime()) continue
    switch (event.kind) {
      case 'IN':
        if (inAt === null) inAt = at
        if (breakAt !== null) {
          breaks.push({ start: breakAt, end: at })
          breakAt = null
          lastBreakEnd = at
        }
        break
      case 'OUT':
        if (breakAt !== null) breaks.push({ start: breakAt, end: at })
        if (inAt !== null) present.push({ start: inAt, end: at })
        inAt = null
        breakAt = null
        lastBreakEnd = null
        break
      case 'BREAK_OUT':
        if (inAt !== null && breakAt === null) breakAt = at
        break
      case 'BREAK_IN':
        if (breakAt !== null) {
          breaks.push({ start: breakAt, end: at })
          breakAt = null
          lastBreakEnd = at
        }
        break
      default:
        break
    }
  }
  if (breakAt !== null) breaks.push({ start: breakAt, end: now })
  const openIn = inAt
  if (inAt !== null) present.push({ start: inAt, end: now })
  const presentMs = present.reduce((sum, span) => sum + (span.end - span.start), 0)
  const clockedMs = breaks.reduce((sum, pause) => sum + present.reduce((inner, span) => inner + overlap(pause, span), 0), 0)
  const fixedMs = input.fixedBreaks.reduce((sum, pause) => {
    const span = { start: pause.startsAt.getTime(), end: Math.min(pause.endsAt.getTime(), now) }
    return span.end <= span.start ? sum : sum + present.reduce((inner, stretch) => inner + overlap(span, stretch), 0)
  }, 0)
  const minutes = (ms: number) => Math.floor(ms / 60_000)
  const sinceBreak = openIn !== null && breakAt === null ? minutes(now - Math.max(openIn, lastBreakEnd ?? openIn)) : 0
  return {
    present: minutes(presentMs),
    clockedBreaks: minutes(clockedMs),
    fixedBreaks: minutes(fixedMs),
    worked: Math.max(0, minutes(presentMs - clockedMs - fixedMs)),
    sinceBreak,
  }
}

/** Where the window of "your time today" starts: the site's midnight, or the open stretch's clock-in when earlier. */
export function todayFrom(standing: Pick<ClockStanding, 'since'>, now: Date, timeZone: string): Date {
  const midnight = businessDayStart(businessDate(now, timeZone), timeZone)
  return standing.since && standing.since.getTime() < midnight.getTime() ? standing.since : midnight
}

/** A working-time rule for breaks (B-W2b-07 WorkingTimeRule BREAK_AFTER), or the law's values. */
export interface BreakRule {
  readonly limitMinutes: number
  readonly breakMinutes: number
  readonly legalReference: string
}

export const LAW_BREAK_RULE: BreakRule = Object.freeze({ limitMinutes: CLOCK_RULES.breakAfterMinutes, breakMinutes: CLOCK_RULES.breakMinutes, legalReference: BREAK_LAW })

/** Clocked breaks: worked at a stretch past the rule's limit → the reminder in words; null otherwise. */
export function breakDueWords(sinceBreak: number, rule: BreakRule): string | null {
  if (sinceBreak < rule.limitMinutes) return null
  return `You have worked ${durationText(sinceBreak)} without a break: take at least ${rule.breakMinutes} minutes (${rule.legalReference}).`
}

// ---- the automatic clock-out (MES-227) ----------------------------------------------------------------------------------------

/** When the rule closes an open clock-in of this shift: its end plus the company's tolerance. */
export const autoClockOutAt = (shift: Pick<ShiftWindow, 'endsAt'>, afterMinutes: number): Date => new Date(shift.endsAt.getTime() + afterMinutes * 60_000)

/** The reason an automatic clock-out records (the database wants one): the rule in words. */
export function autoClockOutReason(shift: Pick<ShiftWindow, 'endsAt' | 'label'>, afterMinutes: number, timeZone: string): string {
  const name = shift.label ? ` "${shift.label}"` : ''
  return `Automatic clock-out: shift${name} ended ${timeText(shift.endsAt, timeZone)} + ${afterMinutes} min (People settings). The clock-out was missing.`
}

/**
 * The time to close an open stretch at, or null: the stretch's shift is known, its end plus the tolerance has come,
 * and nothing was recorded after that time (a person still clocking breaks after it is not closed by the rule).
 */
export function autoClockOutDue(standing: ClockStanding, shift: ShiftWindow | null, afterMinutes: number | null, now: Date): Date | null {
  if (afterMinutes === null || !standing.openSince || !shift) return null
  const at = autoClockOutAt(shift, afterMinutes)
  if (at.getTime() > now.getTime()) return null
  if (at.getTime() <= standing.openSince.getTime()) return null
  if (standing.last && standing.last.occurredAt.getTime() >= at.getTime()) return null
  return at
}

// ---- words for the confirmation --------------------------------------------------------------------------------------------------

/** "In since 07:58 · 4 h 12 min today" (design floor.clock "Your time today"). */
export function stateWords(standing: Pick<ClockStanding, 'state' | 'since' | 'breakSince' | 'forgotten'>, worked: number, now: Date, timeZone: string): string {
  const today = `${durationText(worked)} today`
  if (standing.state === 'IN') return `In since ${whenText(standing.since!, now, timeZone)} · ${today}`
  if (standing.state === 'ON_BREAK') return `On a break since ${whenText(standing.breakSince!, now, timeZone)} · ${today}`
  return worked > 0 ? `Not clocked in · ${today}` : 'Not clocked in'
}

/** "Saved on this tablet at 07:58 (tablet time)." (design floor.clock "Offline clocking"). */
export const offlineWords = (deviceTime: Date, timeZone: string, skewed: boolean): string =>
  `Saved on this tablet at ${timeText(deviceTime, timeZone)} (tablet time).${skewed ? " The tablet's clock looked wrong: your team leader will check it." : ''}`

/** The confirmation of a recorded action, in words. */
export function recordedWords(action: ClockAction, at: Date, timeZone: string): string {
  const time = timeText(at, timeZone)
  switch (action) {
    case 'IN':
      return `Clocked in at ${time}.`
    case 'OUT':
      return `Clocked out at ${time}.`
    case 'BREAK_OUT':
      return `Break started at ${time}.`
    case 'BREAK_IN':
      return `Back from the break at ${time}.`
  }
}

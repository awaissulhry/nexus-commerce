/**
 * CalendarGrid's rules (factory part "CalendarGrid"): pure, no React, no clock. Every date is an ISO day
 * (`YYYY-MM-DD`) and every month an ISO month (`YYYY-MM`); the arithmetic runs on UTC midnights, so no time zone or
 * summer-time change can move a day.
 *
 * - A day's kind: its own entry in `days` (an exception or a fact the app gives: a holiday, a closure, an extra shift),
 *   else the weekly base pattern (`weekKinds`, Monday first), else not known (never guessed as a working day).
 * - The list twin: the days of the period that differ from the weekly pattern, in date order.
 * - Keyboard: a roving focus day; arrows by day and week, Home / End to the week's ends, Page Up / Down by month;
 *   Shift with a move extends a range from an anchor (`calendarKeyStep`).
 */
import type { Tone } from '../../primitives/tone'

export type CalendarView = 'month' | 'year'
export type CalendarLayout = 'grid' | 'list'
/**
 * How a kind is drawn besides its colour (never colour alone): `hatch` (a day off), `cross` (cross-hatched), `dots`,
 * `stripe` (an edge bar), `outline` (a dashed frame). Give kinds that sit side by side different patterns.
 */
export type CalendarPattern = 'plain' | 'hatch' | 'cross' | 'dots' | 'stripe' | 'outline'
/** 0 = Sunday … 6 = Saturday (as `Date.getUTCDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** One entry of the key: what a kind of day is called and how it is drawn. The app names every kind. */
export interface CalendarKind {
  id: string
  /** "Working day", "Public holiday", "Closure", "Extra shift", "Short day", "Line closed". */
  label: string
  /** The ground colour; none = the plain surface (a normal working day). */
  tone?: Tone
  /** The pattern; default `hatch` for a day off (`off`), else `plain`. */
  pattern?: CalendarPattern
  /** No work that day (weekend, holiday, closure): counted apart and hatched unless a pattern is given. */
  off?: boolean
}

/** What the app knows about one day. */
export interface CalendarDay {
  /** A kind id from `kinds`. */
  kind: string
  /** Why: the holiday's or the closure's name ("Ferragosto", "Summer closure"). */
  reason?: string
  /** A second line: hours, the lines it applies to ("06:00–14:00", "Line 2 only"). */
  detail?: string
}

export interface CalendarRange {
  from: string
  to: string
}

/** What one day is, resolved. */
export interface DayInfo {
  date: string
  kind: CalendarKind | null
  reason: string | null
  detail: string | null
  /** The day has its own entry that differs from the weekly pattern (or adds a reason or a detail). */
  exception: boolean
}

export interface CalendarGridWords {
  previousMonth: string
  nextMonth: string
  previousYear: string
  nextYear: string
  today: string
  todayMark: string
  viewLabel: string
  viewMonth: string
  viewYear: string
  layoutLabel: string
  layoutGrid: string
  layoutList: string
  legend: string
  legendToday: string
  legendCountOne: string
  legendCountOther: string
  day: string
  dayReason: string
  dayPlain: string
  withDetail: string
  withToday: string
  withSelected: string
  instructions: string
  selectingOne: string
  selectingOther: string
  selectedOne: string
  selectedOther: string
  cleared: string
  shown: string
  list: string
  listEmpty: string
  listLoading: string
  kindReason: string
  open: string
  openDay: string
  openMonth: string
  loading: string
}

export const CALENDAR_GRID_WORDS: CalendarGridWords = {
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  previousYear: 'Previous year',
  nextYear: 'Next year',
  today: 'Today',
  todayMark: 'Today',
  viewLabel: 'Show',
  viewMonth: 'Month',
  viewYear: 'Year',
  layoutLabel: 'Show as',
  layoutGrid: 'Calendar',
  layoutList: 'List',
  legend: 'Key',
  legendToday: 'Today',
  legendCountOne: '{kind}: 1 day',
  legendCountOther: '{kind}: {count} days',
  day: '{date}, {kind}',
  dayReason: '{date}, {kind}: {reason}',
  dayPlain: '{date}',
  withDetail: '{text}. {detail}',
  withToday: '{text}. Today',
  withSelected: '{text}. Selected',
  instructions:
    'Arrow keys move between days, Page Up and Page Down change the month, Home and End go to the start and the end of the week. Enter opens a day. Hold Shift with the arrow keys to select days, then press Enter to use them; Escape clears the selection.',
  selectingOne: 'Selecting {from}: 1 day.',
  selectingOther: 'Selecting {from} to {to}: {count} days.',
  selectedOne: '{from} selected: 1 day.',
  selectedOther: '{from} to {to} selected: {count} days.',
  cleared: 'Selection cleared.',
  shown: '{period}.',
  list: 'Days that differ from the weekly pattern',
  listEmpty: 'Every day of {period} follows the weekly pattern.',
  listLoading: 'Loading the days of {period}…',
  kindReason: '{kind}: {reason}',
  open: 'Open',
  openDay: 'Open {date}',
  openMonth: 'Open {month}',
  loading: 'Loading the calendar…',
}

/** `{name}` → its value; a placeholder with no value stays as written, so a missing one shows. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

// ── ISO days on UTC midnights ───────────────────────────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_MONTH = /^(\d{4})-(\d{2})$/
const DAY_MS = 86_400_000
const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** A real calendar day written `YYYY-MM-DD` (not 2026-02-30). */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = ISO_DAY.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)
}

export function isIsoMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = ISO_MONTH.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12
}

/** Days in a month (`month` 1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const msOf = (iso: string): number => {
  const m = ISO_DAY.exec(iso)
  if (!m) throw new RangeError(`CalendarGrid: "${iso}" is not an ISO day`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

const isoOfMs = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** The day's UTC midnight as a Date (for `Intl.DateTimeFormat` with `timeZone: 'UTC'`). */
export const dateOf = (iso: string): Date => new Date(msOf(iso))

export const isoDay = (year: number, month: number, day: number): string => `${pad(year, 4)}-${pad(month)}-${pad(day)}`

export const addDays = (iso: string, days: number): string => isoOfMs(msOf(iso) + days * DAY_MS)

/** Whole days from `a` to `b` (b − a). */
export const daysBetween = (a: string, b: string): number => Math.round((msOf(b) - msOf(a)) / DAY_MS)

export const weekdayOf = (iso: string): Weekday => new Date(msOf(iso)).getUTCDay() as Weekday

export const monthOf = (iso: string): string => iso.slice(0, 7)

export const yearOf = (isoDayOrMonth: string): number => Number(isoDayOrMonth.slice(0, 4))

export function addMonths(month: string, months: number): string {
  const y = yearOf(month)
  const m = Number(month.slice(5, 7)) - 1 + months
  const year = y + Math.floor(m / 12)
  return `${pad(year, 4)}-${pad(((m % 12) + 12) % 12 + 1)}`
}

/** The same day of the month `months` away, at the last day when that month is shorter (31 Jan + 1 → 28/29 Feb). */
export function addMonthsToDay(iso: string, months: number): string {
  const month = addMonths(monthOf(iso), months)
  const y = yearOf(month)
  const m = Number(month.slice(5, 7))
  return isoDay(y, m, Math.min(Number(iso.slice(8, 10)), daysInMonth(y, m)))
}

/** Today in the browser's own calendar (the app may pass its own: the site's time zone). */
export function localToday(now: Date = new Date()): string {
  return isoDay(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** The month's weeks as rows of seven, `null` outside the month; `weekStartsOn` 1 = Monday (default). */
export function monthWeeks(month: string, weekStartsOn: Weekday = 1): (string | null)[][] {
  const y = yearOf(month)
  const m = Number(month.slice(5, 7))
  const first = isoDay(y, m, 1)
  const lead = (weekdayOf(first) - weekStartsOn + 7) % 7
  const count = daysInMonth(y, m)
  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= count; d++) cells.push(isoDay(y, m, d))
  while (cells.length % 7) cells.push(null)
  const weeks: (string | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** The weekdays in column order from `weekStartsOn`. */
export const weekdayOrder = (weekStartsOn: Weekday = 1): Weekday[] => Array.from({ length: 7 }, (_, i) => ((weekStartsOn + i) % 7) as Weekday)

/** Every day of a month, or of the month's year. */
export function periodDays(view: CalendarView, month: string): string[] {
  const y = yearOf(month)
  const months = view === 'year' ? Array.from({ length: 12 }, (_, i) => i + 1) : [Number(month.slice(5, 7))]
  return months.flatMap((m) => Array.from({ length: daysInMonth(y, m) }, (_, i) => isoDay(y, m, i + 1)))
}

/** The months a view draws: one, or the twelve of its year. */
export const periodMonths = (view: CalendarView, month: string): string[] =>
  view === 'year' ? Array.from({ length: 12 }, (_, i) => `${pad(yearOf(month), 4)}-${pad(i + 1)}`) : [month]

/** Is `iso` inside what the view shows? */
export const inPeriod = (view: CalendarView, month: string, iso: string): boolean =>
  view === 'year' ? yearOf(iso) === yearOf(month) : monthOf(iso) === month

// ── Day kinds ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const patternOf = (kind: CalendarKind | null | undefined): CalendarPattern => kind?.pattern ?? (kind?.off ? 'hatch' : 'plain')

/** The weekly base kind of a day: `weekKinds` is Monday first (index 0 = Monday … 6 = Sunday); null = not given. */
export function baseKindId(iso: string, weekKinds: readonly (string | null | undefined)[] | undefined): string | null {
  if (!weekKinds || weekKinds.length !== 7) return null
  return weekKinds[(weekdayOf(iso) + 6) % 7] ?? null
}

export interface DayInput {
  kinds: readonly CalendarKind[]
  days?: Readonly<Record<string, CalendarDay>>
  weekKinds?: readonly (string | null | undefined)[]
}

/** What a day is: its own entry, else the weekly pattern, else not known. A kind id the key lacks is not known either. */
export function dayInfo(iso: string, { kinds, days, weekKinds }: DayInput): DayInfo {
  const own = days?.[iso]
  const base = baseKindId(iso, weekKinds)
  const kindId = own?.kind ?? base
  const kind = kindId ? (kinds.find((k) => k.id === kindId) ?? null) : null
  const reason = own?.reason?.trim() || null
  const detail = own?.detail?.trim() || null
  const exception = !!own && (own.kind !== base || reason !== null || detail !== null)
  return { date: iso, kind, reason, detail, exception }
}

/** The list twin: the period's days that differ from the weekly pattern, in date order. */
export function exceptionsIn(view: CalendarView, month: string, input: DayInput): DayInfo[] {
  if (!input.days) return []
  return Object.keys(input.days)
    .filter((iso) => isIsoDay(iso) && inPeriod(view, month, iso))
    .sort()
    .map((iso) => dayInfo(iso, input))
    .filter((info) => info.exception)
}

/** How many days of the period are of each kind (the key's counts). Days of no known kind are not counted. */
export function kindCounts(view: CalendarView, month: string, input: DayInput): Map<string, number> {
  const counts = new Map<string, number>()
  for (const iso of periodDays(view, month)) {
    const kind = dayInfo(iso, input).kind
    if (kind) counts.set(kind.id, (counts.get(kind.id) ?? 0) + 1)
  }
  return counts
}

// ── Ranges ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Two days in either order as a range from the earlier. */
export const rangeOf = (a: string, b: string): CalendarRange => (a <= b ? { from: a, to: b } : { from: b, to: a })

export const inRange = (iso: string, range: CalendarRange | null | undefined): boolean => !!range && iso >= range.from && iso <= range.to

export const rangeLength = (range: CalendarRange): number => daysBetween(range.from, range.to) + 1

// ── Keyboard ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CalendarNavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown'

export const isCalendarNavKey = (key: string): key is CalendarNavKey =>
  key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown'

/** Where a navigation key moves the focus day (`dir` = reading direction: left and right swap in right-to-left). */
export function moveDay(iso: string, key: CalendarNavKey, weekStartsOn: Weekday = 1, dir: 'ltr' | 'rtl' = 'ltr'): string {
  const offset = (weekdayOf(iso) - weekStartsOn + 7) % 7
  switch (key) {
    case 'ArrowLeft':
      return addDays(iso, dir === 'ltr' ? -1 : 1)
    case 'ArrowRight':
      return addDays(iso, dir === 'ltr' ? 1 : -1)
    case 'ArrowUp':
      return addDays(iso, -7)
    case 'ArrowDown':
      return addDays(iso, 7)
    case 'Home':
      return addDays(iso, -offset)
    case 'End':
      return addDays(iso, 6 - offset)
    case 'PageUp':
      return addMonthsToDay(iso, -1)
    case 'PageDown':
      return addMonthsToDay(iso, 1)
  }
}

/** The keyboard's state: the focus day and, while Shift extends a range, where it started. */
export interface KeyState {
  focus: string
  anchor: string | null
}

export interface KeyStepResult {
  state: KeyState
  /** The range now drawn (Shift held), or null. */
  range: CalendarRange | null
  /** The selection was refused (read-only): say the reason. */
  held: boolean
}

/**
 * One navigation key. Without Shift the focus moves and any range is let go; with Shift the range runs from the anchor
 * (the focus day when Shift was first used) to the new focus. Read-only (`held`): the focus still moves, a Shift range
 * is refused.
 */
export function calendarKeyStep(state: KeyState, key: CalendarNavKey, shift: boolean, options: { weekStartsOn?: Weekday; dir?: 'ltr' | 'rtl'; held?: boolean } = {}): KeyStepResult {
  const focus = moveDay(state.focus, key, options.weekStartsOn ?? 1, options.dir ?? 'ltr')
  if (!shift) return { state: { focus, anchor: null }, range: null, held: false }
  if (options.held) return { state: { focus, anchor: null }, range: null, held: true }
  const anchor = state.anchor ?? state.focus
  return { state: { focus, anchor }, range: rangeOf(anchor, focus), held: false }
}

/** The month a view shows after the focus moved to `focus` (the month itself, or the focus's month in another year). */
export function shownAfter(view: CalendarView, shown: string, focus: string): string {
  if (inPeriod(view, shown, focus)) return shown
  return monthOf(focus)
}

/** The focus day when a view opens on `month`: today if it is in the period, else a kept focus in it, else the 1st. */
export function focusIn(view: CalendarView, month: string, wanted: string | null, today: string | null): string {
  if (wanted && isIsoDay(wanted) && inPeriod(view, month, wanted)) return wanted
  if (today && isIsoDay(today) && inPeriod(view, month, today)) return today
  return view === 'year' ? `${month.slice(0, 4)}-01-01` : `${month}-01`
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DayNameInput {
  info: DayInfo
  /** The day written out ("Tuesday 8 December 2026"). */
  date: string
  today: boolean
  selected: boolean
}

/** A day's whole name for a screen reader: date, kind and reason, detail, today, selected. */
export function dayName(words: CalendarGridWords, { info, date, today, selected }: DayNameInput): string {
  let text = info.kind
    ? fill(info.reason ? words.dayReason : words.day, { date, kind: info.kind.label, reason: info.reason ?? '' })
    : info.reason
      ? fill(words.withDetail, { text: date, detail: info.reason })
      : fill(words.dayPlain, { date })
  if (info.detail) text = fill(words.withDetail, { text, detail: info.detail })
  if (today) text = fill(words.withToday, { text })
  if (selected) text = fill(words.withSelected, { text })
  return text
}

/** The sentence a range is said with, while selecting or once used. */
export function rangeSentence(words: CalendarGridWords, range: CalendarRange, format: (iso: string) => string, done: boolean): string {
  const count = rangeLength(range)
  const vars = { from: format(range.from), to: format(range.to), count }
  if (count === 1) return fill(done ? words.selectedOne : words.selectingOne, vars)
  return fill(done ? words.selectedOther : words.selectingOther, vars)
}

export const legendCount = (words: CalendarGridWords, kind: string, count: number): string =>
  fill(count === 1 ? words.legendCountOne : words.legendCountOther, { kind, count })

/** A heading's first letter in upper case, as the language writes it ("agosto 2026" → "Agosto 2026"). */
export const capitalise = (text: string, locale: string): string => (text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text)

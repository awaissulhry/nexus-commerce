import type { Issue } from '../core/errors'
import { clockText } from './dates'

/**
 * Shift patterns (PLN-002; B-W2a-08), pure: a named week of shifts, each weekday's SHIFTs (working time) and the BREAKs
 * inside them, in minutes from that weekday's local midnight (360-840 is 06:00-14:00; a night shift runs past 1440:
 * 22:00-06:00 is 1320-1800). A day's working time is its shifts less its breaks; a night shift belongs to the day it
 * starts. The database (…_platform_w2a_guards) holds the bounds and "a break lies inside a shift" at commit; these
 * rules also refuse what would count time twice (shifts that overlap, breaks that overlap, a night shift running into
 * the next morning's shift) and say every problem in words.
 *
 * No person is named in a pattern: who works which shift is People (W2b), never a planning figure (Statuto dei
 * Lavoratori art. 4).
 */

export const SEGMENT_KINDS = ['SHIFT', 'BREAK'] as const
export type SegmentKind = (typeof SEGMENT_KINDS)[number]

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
export const WEEKDAY_NAMES: Readonly<Record<number, string>> = Object.freeze({ 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' })

/** Limits of one pattern. */
export const PATTERN_LIMITS = Object.freeze({ segments: 200, perWeekday: 24, label: 60, code: 20, name: 200, description: 300 })

/** A pattern's code: capital letters, digits and hyphens ("1T", "2T", "SAT-AM"). */
export const PATTERN_CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/

export interface Segment {
  /** ISO weekday: 1 Monday … 7 Sunday. */
  readonly weekday: number
  readonly kind: SegmentKind
  readonly label: string | null
  readonly startMinute: number
  readonly endMinute: number
}

/** A pattern as the working-time rules read it. */
export interface Pattern {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly segments: readonly Segment[]
}

/** A stretch of working time inside one weekday's frame, in minutes (end excluded). */
export interface MinuteSpan {
  readonly start: number
  readonly end: number
}

/** One shift of a weekday with its breaks and the working stretches between them. */
export interface ShiftOfDay {
  readonly label: string | null
  readonly startMinute: number
  readonly endMinute: number
  readonly breaks: readonly { readonly label: string | null; readonly startMinute: number; readonly endMinute: number }[]
  /** The shift less its breaks. */
  readonly working: readonly MinuteSpan[]
  /** Nominal minutes (the wall clock): the shift less its breaks. */
  readonly minutes: number
}

/**
 * The planning default when no calendar names a pattern (design planning.settings: "the site default (Mon–Fri, one
 * shift) is used until you set one"): one shift 08:00-17:00 with a lunch hour, Monday to Friday, 480 minutes a day.
 */
export const DEFAULT_PATTERN: Pattern = Object.freeze({
  id: 'DEFAULT',
  code: 'DEFAULT',
  name: 'One shift (default)',
  segments: Object.freeze(
    [1, 2, 3, 4, 5].flatMap((weekday) => [
      Object.freeze({ weekday, kind: 'SHIFT' as const, label: 'Day', startMinute: 480, endMinute: 1020 }),
      Object.freeze({ weekday, kind: 'BREAK' as const, label: 'Lunch', startMinute: 720, endMinute: 780 }),
    ]),
  ),
})

const byStart = <T extends { readonly startMinute: number; readonly endMinute: number }>(a: T, b: T): number => a.startMinute - b.startMinute || a.endMinute - b.endMinute

/** A weekday's shifts, earliest first, each with its breaks and its working stretches. */
export function shiftsOf(segments: readonly Segment[], weekday: number): ShiftOfDay[] {
  const ofDay = segments.filter((segment) => segment.weekday === weekday)
  const breaks = ofDay.filter((segment) => segment.kind === 'BREAK').sort(byStart)
  return ofDay
    .filter((segment) => segment.kind === 'SHIFT')
    .sort(byStart)
    .map((shift) => {
      const inside = breaks.filter((pause) => pause.startMinute >= shift.startMinute && pause.endMinute <= shift.endMinute)
      const working: MinuteSpan[] = []
      let cursor = shift.startMinute
      for (const pause of inside) {
        if (pause.startMinute > cursor) working.push({ start: cursor, end: pause.startMinute })
        cursor = Math.max(cursor, pause.endMinute)
      }
      if (cursor < shift.endMinute) working.push({ start: cursor, end: shift.endMinute })
      return {
        label: shift.label,
        startMinute: shift.startMinute,
        endMinute: shift.endMinute,
        breaks: inside.map((pause) => ({ label: pause.label, startMinute: pause.startMinute, endMinute: pause.endMinute })),
        working,
        minutes: working.reduce((sum, span) => sum + span.end - span.start, 0),
      }
    })
}

/** A weekday's nominal working minutes: its shifts less their breaks. */
export function weekdayMinutes(segments: readonly Segment[], weekday: number): number {
  return shiftsOf(segments, weekday).reduce((sum, shift) => sum + shift.minutes, 0)
}

/** The weekdays that have at least one shift, ascending. */
export function weekdaysWithShifts(segments: readonly Segment[]): number[] {
  return WEEKDAYS.filter((weekday) => segments.some((segment) => segment.weekday === weekday && segment.kind === 'SHIFT'))
}

/**
 * When the shifts end, as `HH:MM`, once each, earliest first: what a site's floor sign-out times (FloorSettings.shiftEnds)
 * would be if taken from this pattern.
 */
export function shiftEndsOf(segments: readonly Segment[]): string[] {
  const ends = segments.filter((segment) => segment.kind === 'SHIFT').map((segment) => segment.endMinute % 1440)
  return [...new Set(ends)].sort((a, b) => a - b).map(clockText)
}

const range = (weekdays: readonly number[]): string => {
  if (weekdays.length === 0) return 'no day'
  const runs: number[][] = []
  for (const weekday of weekdays) {
    const last = runs.at(-1)
    if (last && last.at(-1) === weekday - 1) last.push(weekday)
    else runs.push([weekday])
  }
  return runs
    .map((run) => (run.length >= 3 ? `${WEEKDAY_NAMES[run[0]!]} to ${WEEKDAY_NAMES[run.at(-1)!]}` : run.map((weekday) => WEEKDAY_NAMES[weekday]).join(', ')))
    .join(', ')
}

/** One line for pickers: "06:00-14:00 and 14:00-22:00, Monday to Friday" (weekdays with the same shifts grouped). */
export function describePattern(segments: readonly Segment[]): string {
  const groups = new Map<string, number[]>()
  for (const weekday of weekdaysWithShifts(segments)) {
    const key = shiftsOf(segments, weekday)
      .map((shift) => `${clockText(shift.startMinute)}-${clockText(shift.endMinute)}`)
      .join(' and ')
    groups.set(key, [...(groups.get(key) ?? []), weekday])
  }
  if (groups.size === 0) return 'No shifts'
  return [...groups.entries()].map(([shifts, weekdays]) => `${shifts}, ${range(weekdays)}`).join('; ')
}

const at = (index: number) => `segments/${index}`
const when = (segment: Segment) => `${WEEKDAY_NAMES[segment.weekday] ?? `day ${segment.weekday}`} ${clockText(segment.startMinute)}-${clockText(segment.endMinute)}`
const overlaps = (a: { startMinute: number; endMinute: number }, b: { startMinute: number; endMinute: number }) => a.startMinute < b.endMinute && b.startMinute < a.endMinute

/**
 * What is wrong with a pattern's segments, every problem at its path (`segments/<i>[/field]`); empty when the pattern
 * can be saved. A pattern has at least one shift; each segment is on a weekday 1-7; a SHIFT starts in its day
 * (0-1439) and lasts at most 24 hours; a BREAK lies inside one SHIFT of its weekday; shifts of a weekday do not
 * overlap, nor do its breaks, and a night shift does not run into the next weekday's first shift.
 */
export function segmentProblems(segments: readonly Segment[]): Issue[] {
  const issues: Issue[] = []
  if (segments.length === 0) return [{ path: 'segments', message: 'A shift pattern has at least one shift.' }]
  if (segments.length > PATTERN_LIMITS.segments) return [{ path: 'segments', message: `A shift pattern has at most ${PATTERN_LIMITS.segments} shifts and breaks.` }]
  const sane: { segment: Segment; index: number }[] = []
  segments.forEach((segment, index) => {
    const before = issues.length
    if (!Number.isInteger(segment.weekday) || segment.weekday < 1 || segment.weekday > 7) issues.push({ path: `${at(index)}/weekday`, message: 'Expected an ISO weekday: 1 (Monday) to 7 (Sunday).' })
    if (!(SEGMENT_KINDS as readonly string[]).includes(segment.kind)) issues.push({ path: `${at(index)}/kind`, message: 'Expected SHIFT or BREAK.' })
    if (segment.label !== null && (segment.label.trim() === '' || segment.label.length > PATTERN_LIMITS.label)) {
      issues.push({ path: `${at(index)}/label`, message: `A name has 1 to ${PATTERN_LIMITS.label} characters, or none.` })
    }
    const start = segment.startMinute
    const end = segment.endMinute
    const latestStart = segment.kind === 'SHIFT' ? 1439 : 2879
    if (!Number.isInteger(start) || start < 0 || start > latestStart) {
      issues.push({ path: `${at(index)}/startMinute`, message: segment.kind === 'SHIFT' ? 'A shift starts in its day: 0 (00:00) to 1439 (23:59).' : 'A break starts between 0 and 2879 minutes (a night shift runs past midnight).' })
    } else if (!Number.isInteger(end) || end <= start || end - start > 1440 || end > 2880) {
      issues.push({ path: `${at(index)}/endMinute`, message: 'It ends after it starts, at most 24 hours later (a night shift ends past 1440: 22:00-06:00 is 1320-1800).' })
    }
    if (issues.length === before) sane.push({ segment, index })
  })
  const shifts = sane.filter(({ segment }) => segment.kind === 'SHIFT')
  const breaks = sane.filter(({ segment }) => segment.kind === 'BREAK')
  if (shifts.length === 0 && issues.length === 0) issues.push({ path: 'segments', message: 'A shift pattern has at least one shift.' })
  for (const weekday of WEEKDAYS) {
    const day = sane.filter(({ segment }) => segment.weekday === weekday)
    if (day.length > PATTERN_LIMITS.perWeekday) issues.push({ path: 'segments', message: `${WEEKDAY_NAMES[weekday]} has more than ${PATTERN_LIMITS.perWeekday} shifts and breaks.` })
  }
  for (const [n, a] of shifts.entries()) {
    for (const b of shifts.slice(n + 1)) {
      if (a.segment.weekday === b.segment.weekday && overlaps(a.segment, b.segment)) {
        issues.push({ path: at(b.index), message: `The shift ${when(b.segment)} overlaps the shift ${when(a.segment)}: working time would count twice.` })
      }
    }
    if (a.segment.endMinute > 1440) {
      const next = (a.segment.weekday % 7) + 1
      const spill = { startMinute: 0, endMinute: a.segment.endMinute - 1440 }
      for (const b of shifts) {
        if (b.segment.weekday === next && overlaps(spill, b.segment)) {
          issues.push({ path: at(a.index), message: `The night shift ${when(a.segment)} runs into the shift ${when(b.segment)}: working time would count twice.` })
        }
      }
    }
  }
  for (const [n, pause] of breaks.entries()) {
    const holder = shifts.find(({ segment }) => segment.weekday === pause.segment.weekday && segment.startMinute <= pause.segment.startMinute && segment.endMinute >= pause.segment.endMinute)
    if (!holder) issues.push({ path: at(pause.index), message: `The break ${when(pause.segment)} is not inside a shift of ${WEEKDAY_NAMES[pause.segment.weekday]}.` })
    for (const other of breaks.slice(n + 1)) {
      if (other.segment.weekday === pause.segment.weekday && overlaps(pause.segment, other.segment)) {
        issues.push({ path: at(other.index), message: `The break ${when(other.segment)} overlaps the break ${when(pause.segment)}.` })
      }
    }
  }
  return issues
}

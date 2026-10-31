import type { Issue } from '../core/errors'
import type { BusinessDate } from '../core/time'
import { daysFrom, isTimeZone, plusDays } from './dates'
import type { CalendarScope, DayKind } from './working-time'

/**
 * Days set on many calendars at once, and the days of one calendar copied onto another (B-W2b-20; B-W2a-08 and B-W2a-59
 * gaps: "no route to set the same closure on several calendars in one command; no copy of another calendar's days"),
 * and a supplier calendar's own time zone (B-W2b-03's column). Pure; apps/factory-api's platform/calendars says them
 * in words before the database's guards would refuse the same.
 *
 *   targets     a closure over several calendars names each one once: a calendar by its id, or an owner (company,
 *               site, line, workshop, supplier) whose ACTIVE calendar takes it (one is made when it has none); at most
 *               MAX_TARGETS in one command.
 *   copy        the days of a calendar (an ACTIVE one, or an ARCHIVED one into its successor) from a day to a day, at
 *               most MAX_COPY_DAYS: each keeps its kind, name, note, public holiday list and shift pattern. A day whose
 *               pattern the target may not use (archived, another company's) is not copied: it is listed as skipped
 *               with the reason, and a person sets it by hand. Our calendars and suppliers' calendars never copy into
 *               each other (a supplier's days are not ours, and ours carry shifts).
 *   time zone   only a supplier's calendar has one (IANA: "Asia/Karachi"); ours keep their company's and site's zone.
 */

/** At most this many calendars take one closure in one command. */
export const MAX_TARGETS = 50
/** A copy covers at most two years and a day (this year and the next, as a calendar's read). */
export const MAX_COPY_DAYS = 2 * 366 + 1

/** A target of a closure over several calendars: a calendar, or an owner whose ACTIVE calendar it is. */
export type DaysTarget = { readonly calendarId: string; readonly version?: number | undefined } | { readonly scope: CalendarScope; readonly ownerId: string }

export const targetKey = (target: DaysTarget): string => ('calendarId' in target ? `calendar:${target.calendarId}` : `${target.scope}:${target.ownerId}`)

/** Each target once, between 1 and MAX_TARGETS of them. */
export function targetsProblems(targets: readonly DaysTarget[], path = 'targets'): Issue[] {
  if (targets.length === 0) return [{ path, message: 'Name at least one calendar or owner.' }]
  if (targets.length > MAX_TARGETS) return [{ path, message: `At most ${MAX_TARGETS} calendars in one closure; this one names ${targets.length}.` }]
  const seen = new Map<string, number>()
  const problems: Issue[] = []
  targets.forEach((target, index) => {
    const key = targetKey(target)
    const first = seen.get(key)
    if (first !== undefined) problems.push({ path: `${path}/${index}`, message: `Named twice (also target ${first + 1}): name each calendar once.` })
    else seen.set(key, index)
  })
  return problems
}

/** The days a copy covers: from `from` (default today) to `to` (default the longest copy from `from`). */
export function copyRange(query: { readonly from?: BusinessDate | undefined; readonly to?: BusinessDate | undefined }, today: BusinessDate): { from: BusinessDate; to: BusinessDate; problems: Issue[] } {
  const from = query.from ?? today
  const to = query.to ?? plusDays(from, MAX_COPY_DAYS - 1)
  const span = daysFrom(from, to)
  if (span < 0) return { from, to, problems: [{ path: 'to', message: `The range ends (${to}) before it starts (${from}).` }] }
  if (span + 1 > MAX_COPY_DAYS) return { from, to, problems: [{ path: 'to', message: `A copy covers at most ${MAX_COPY_DAYS} days; this one has ${span + 1}.` }] }
  return { from, to, problems: [] }
}

/** Which calendars may copy into which: ours into ours, a supplier's into a supplier's, never a calendar into itself. */
export function copyPairProblems(source: { readonly id: string; readonly scope: CalendarScope }, target: { readonly id: string; readonly scope: CalendarScope }, path = 'fromCalendarId'): Issue[] {
  if (source.id === target.id) return [{ path, message: 'A calendar does not copy its own days: pick another calendar.' }]
  if ((source.scope === 'SUPPLIER') !== (target.scope === 'SUPPLIER')) {
    return [{ path, message: "A supplier's days and ours are not copied into each other: a supplier's calendar copies a supplier's." }]
  }
  return []
}

export interface CopyDay {
  readonly date: BusinessDate
  readonly kind: DayKind
  readonly name: string
  readonly shiftPatternId: string | null
  readonly note: string | null
  readonly holidaySet: string | null
}

/** What the target may do with a pattern a copied day names. */
export type PatternUse = 'USABLE' | 'ARCHIVED' | 'OTHER_COMPANY' | 'NOT_FOUND'
export const COPY_SKIP_REASONS = ['PATTERN_ARCHIVED', 'PATTERN_OTHER_COMPANY', 'PATTERN_NOT_FOUND'] as const
export type CopySkipReason = (typeof COPY_SKIP_REASONS)[number]

const SKIP_WORDS: Readonly<Record<CopySkipReason, string>> = Object.freeze({
  PATTERN_ARCHIVED: 'its shift pattern is archived',
  PATTERN_OTHER_COMPANY: "its shift pattern is another company's",
  PATTERN_NOT_FOUND: 'its shift pattern was not found',
})

/** The source's days split into those the target takes and those it skips (with the reason in words), by date. */
export function copyPlan(days: readonly CopyDay[], patternUse: (patternId: string) => PatternUse): { copy: CopyDay[]; skipped: { date: BusinessDate; name: string; reason: CopySkipReason; words: string }[] } {
  const copy: CopyDay[] = []
  const skipped: { date: BusinessDate; name: string; reason: CopySkipReason; words: string }[] = []
  for (const day of [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const use = day.shiftPatternId === null ? 'USABLE' : patternUse(day.shiftPatternId)
    if (use === 'USABLE') {
      copy.push(day)
      continue
    }
    const reason: CopySkipReason = use === 'ARCHIVED' ? 'PATTERN_ARCHIVED' : use === 'OTHER_COMPANY' ? 'PATTERN_OTHER_COMPANY' : 'PATTERN_NOT_FOUND'
    skipped.push({ date: day.date, name: day.name, reason, words: `${day.date} (${day.name}) is not copied: ${SKIP_WORDS[reason]}.` })
  }
  return { copy, skipped }
}

/** A calendar's own time zone: only a supplier's, and a zone the platform knows (null: the company's, Europe/Rome). */
export function timeZoneProblems(scope: CalendarScope, timeZone: string | null | undefined, path = 'timeZone'): Issue[] {
  if (timeZone === null || timeZone === undefined) return []
  if (scope !== 'SUPPLIER') return [{ path, message: "Only a supplier's calendar has a time zone of its own: ours keep their company's and site's." }]
  if (!isTimeZone(timeZone)) return [{ path, message: `${timeZone} is not a time zone we know: use an IANA name such as Asia/Karachi.` }]
  return []
}

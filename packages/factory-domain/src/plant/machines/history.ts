import { businessDayRange, type BusinessDate } from '../../core/time'
import type { MachineStatus } from '../rules'

/** A calendar day `days` after `date` (`YYYY-MM-DD`; days, never instants: a clock change is no matter). */
export const addDaysTo = (date: BusinessDate, days: number): BusinessDate => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)

/**
 * A machine's status over time (B-W2b-136; QHS-167; design plant.machines › Machine › "Status & downtime": a DayStrip per
 * day of the week, with the reasons). Pure: the API reads the machine's MachineStatusEvent rows (written by the database's
 * trigger `Machine_status_history` for every status change, never by the API) and the status the machine had when the
 * window starts; the screen draws the spans this file cuts, day by day in the site's time zone.
 *
 * The history starts at the machine's first change (no backfill, B-W2b-86): before its first event a machine was in the
 * first event's `fromStatus` (the status it was registered with) since it was registered; with no event at all it has been
 * in its status now since it was registered. Nothing before the machine was registered, nothing after now. No person.
 */

export interface StatusEventInput {
  readonly at: string
  readonly from: MachineStatus | null
  readonly to: MachineStatus
  readonly reason: string | null
}

export interface StatusSpan {
  /** ISO instants; `to` excluded. */
  readonly from: string
  readonly to: string
  readonly status: MachineStatus
  readonly reason: string | null
}

export interface HistoryInput {
  /** The window asked, ISO instants (`to` excluded). */
  readonly from: string
  readonly to: string
  /** Now: nothing is drawn after it. */
  readonly now: string
  /** When the machine was registered: nothing is drawn before it. */
  readonly registeredAt: string
  /** Its status (and the reason it carried) when the window starts: from the last event before the window, else null. */
  readonly before: { readonly status: MachineStatus; readonly reason: string | null } | null
  /** Its status now (used when it never changed). */
  readonly current: { readonly status: MachineStatus; readonly reason: string | null }
  /** The events inside the window, oldest first. */
  readonly events: readonly StatusEventInput[]
}

const ms = (value: string): number => new Date(value).getTime()
const iso = (value: number): string => new Date(value).toISOString()

/** The spans of one machine's statuses inside the window, oldest first, each with the reason it carried. */
export function statusSpans(input: HistoryInput): StatusSpan[] {
  const start = Math.max(ms(input.from), ms(input.registeredAt))
  const end = Math.min(ms(input.to), ms(input.now))
  if (!(end > start)) return []
  const events = [...input.events].filter((event) => Number.isFinite(ms(event.at))).sort((a, b) => ms(a.at) - ms(b.at))
  let state: { status: MachineStatus; reason: string | null }
  if (input.before) state = { status: input.before.status, reason: input.before.reason }
  else if (events[0]?.from) state = { status: events[0].from, reason: null }
  else if (events.length > 0) state = { status: events[0]!.to, reason: events[0]!.reason }
  else state = { status: input.current.status, reason: input.current.reason }
  const spans: StatusSpan[] = []
  let cursor = start
  for (const event of events) {
    const at = ms(event.at)
    if (at <= cursor) {
      state = { status: event.to, reason: event.reason }
      continue
    }
    if (at >= end) break
    spans.push({ from: iso(cursor), to: iso(at), status: state.status, reason: state.reason })
    cursor = at
    state = { status: event.to, reason: event.reason }
  }
  if (end > cursor) spans.push({ from: iso(cursor), to: iso(end), status: state.status, reason: state.reason })
  // Two spans in a row with the same status and reason are one (an event that changed nothing visible).
  return spans.reduce<StatusSpan[]>((out, span) => {
    const last = out.at(-1)
    if (last && last.status === span.status && last.reason === span.reason && last.to === span.from) out[out.length - 1] = { ...last, to: span.to }
    else out.push(span)
    return out
  }, [])
}

export interface StatusDay {
  readonly date: BusinessDate
  /** The day's own range (local midnight to midnight). */
  readonly from: string
  readonly to: string
  /** The spans of that day, cut at its edges. */
  readonly spans: readonly StatusSpan[]
}

/** `days` calendar days from `first`, each with the spans that fall in it (cut at local midnight). */
export function statusDays(spans: readonly StatusSpan[], first: BusinessDate, days: number, timeZone: string): StatusDay[] {
  const out: StatusDay[] = []
  for (let index = 0; index < days; index += 1) {
    const date = addDaysTo(first, index)
    const range = businessDayRange(date, timeZone)
    const dayFrom = range.start.getTime()
    const dayTo = range.end.getTime()
    const cut = spans.flatMap((span) => {
      const from = Math.max(ms(span.from), dayFrom)
      const to = Math.min(ms(span.to), dayTo)
      return to > from ? [{ ...span, from: iso(from), to: iso(to) }] : []
    })
    out.push({ date, from: iso(dayFrom), to: iso(dayTo), spans: cut })
  }
  return out
}

/** Minutes in each status over the spans (whole minutes, rounded down per status). */
export function minutesByStatus(spans: readonly StatusSpan[]): Partial<Record<MachineStatus, number>> {
  const total: Partial<Record<MachineStatus, number>> = {}
  for (const span of spans) total[span.status] = (total[span.status] ?? 0) + (ms(span.to) - ms(span.from))
  return Object.fromEntries(Object.entries(total).map(([status, value]) => [status, Math.floor((value ?? 0) / 60_000)])) as Partial<Record<MachineStatus, number>>
}

/** The longest window the history reads at once (a week is what the tab shows; a month at most). */
export const HISTORY_MAX_DAYS = 31

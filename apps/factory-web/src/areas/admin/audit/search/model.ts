/**
 * The audit search's own filters (B-W2b-413; design admin.audit "date range, IP (W2b)"), pure: a window between two days as
 * the instants the address and the API take (the start of the first day, the start of the day after the last: `to` is
 * exclusive), in the browser's own zone (the person's), and back to the days the picker shows.
 */

const startOfDay = (day: Date) => {
  const start = new Date(day)
  start.setHours(0, 0, 0, 0)
  return start
}

/** The window from the first day's start to the start of the day after the last. */
export function rangeOf(first: Date, last: Date): { from: string; to: string } {
  const [a, b] = first.getTime() <= last.getTime() ? [first, last] : [last, first]
  const end = startOfDay(b)
  end.setDate(end.getDate() + 1)
  return { from: startOfDay(a).toISOString(), to: end.toISOString() }
}

/** The last seven days, today included: the window offered when "Between two days" is picked. */
export function lastWeek(now: Date): { from: string; to: string } {
  const first = new Date(now)
  first.setDate(first.getDate() - 6)
  return rangeOf(first, now)
}

/** The days the picker shows for a window (the last day is the one before the exclusive end). */
export function daysOf(from: string | null, to: string | null, now: Date): { start: Date; end: Date } {
  const fallback = lastWeek(now)
  const start = new Date(from ?? fallback.from)
  const end = new Date(new Date(to ?? fallback.to).getTime() - 1)
  return { start, end }
}

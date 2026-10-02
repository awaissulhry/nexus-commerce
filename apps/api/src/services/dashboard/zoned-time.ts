/**
 * MCP full control P3 — the operator's calendar day in Europe/Rome, shared by the dashboard routes and the Global
 * Snapshot service (global-snapshot.service.ts). Moved from dashboard.routes.ts unchanged.
 */

// DO.2 — Italian operator timezone is Europe/Rome (UTC+1 winter,
// UTC+2 DST). Server runs in UTC, so the previous code's `today`
// = `from.setHours(0,0,0,0)` resolved to UTC midnight, meaning
// the operator's first 1–2 hours of every day were missing from
// the dashboard until 02:00 local. `ytd` had the same defect at
// the year boundary (Italy crosses Dec 31 → Jan 1 before UTC
// does). The rolling windows (7d/30d/90d) are unaffected — they
// are duration-based, not calendar-aligned.
export const OPERATOR_TIMEZONE = 'Europe/Rome'

// Compute the UTC instant corresponding to local midnight (00:00)
// on the calendar date observed in `timeZone` at instant `at`. DST
// safe: probes the zone offset on the target civil date and
// subtracts it from UTC midnight on that same civil date.
export function zonedStartOfDay(at: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  const [y, m, d] = ymd.split('-').map(Number)
  return zonedMidnight(y, m - 1, d, timeZone)
}

// UTC instant for local midnight on civil date (y, m, d) in zone.
export function zonedMidnight(
  y: number,
  m: number,
  d: number,
  timeZone: string,
): Date {
  // Probe noon UTC on that civil date — comfortably inside the day
  // for any zone — then read what `timeZone` thinks the local time
  // is. The difference between observed-local and probe-UTC is the
  // zone offset in effect on that civil date.
  const probe = new Date(Date.UTC(y, m, d, 12, 0, 0))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(probe)
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? '0')
  const observedLocal = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
  )
  const offsetMs = observedLocal - probe.getTime()
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMs)
}

// UTC instant for Jan 1 00:00 in the zone, for the calendar year
// observed in `timeZone` at instant `at`.
export function zonedStartOfYear(at: Date, timeZone: string): Date {
  const yearStr = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
  }).format(at)
  const y = Number(yearStr)
  return zonedMidnight(y, 0, 1, timeZone)
}

/**
 * IH-series — /insights service layer.
 *
 * Cross-functional aggregations for the unified Insights hub. Lives
 * separately from `analytics.routes.ts` (PA portfolio) and
 * `dashboard.routes.ts` (Command Center) so each phase's report
 * family (sales, profit, advertising, fiscal, …) can compose helpers
 * from a single namespace.
 *
 * IH.0 ships a minimal summary helper + filter-parsing shared types
 * to validate end-to-end wiring; subsequent phases add per-report
 * helpers (sales, profit, ads, …) here without bloating individual
 * route files.
 *
 * ─────────────────────────────────────────────────────────────────
 * DA-RT.7 — Order status semantic policy (canonical)
 * ─────────────────────────────────────────────────────────────────
 * Decision matrix for whether CANCELLED + PENDING + €0 orders count
 * toward each report. Apply consistently — divergence creates
 * cross-page disagreement (the symptom that prompted DA-RT-series).
 *
 *   Surface                       CANCELLED  PENDING  €0+units
 *   ────────────────────────────  ─────────  ───────  ─────────
 *   Global Snapshot tile (MS.6)   INCLUDE    INCLUDE  ESTIMATE  ← matches Amazon Seller Central "Sales" tile
 *   /insights/sales               INCLUDE    INCLUDE  ESTIMATE  ← same semantic as snapshot
 *   /insights/profit              EXCLUDE    INCLUDE  EXCLUDE   ← profit is realized; no revenue on €0 cancelled
 *   /insights/fiscal (IVA)        EXCLUDE    INCLUDE  WARN      ← regulatory: VAT on completed sales only
 *   DailySalesAggregate (F.1)     EXCLUDE    INCLUDE  APPORTION ← forecast/replenishment source of truth
 *   /orders workspace             EXCLUDE    INCLUDE  INCLUDE   ← operator "actionable" filter (OX.17)
 *   sales-reconciliation banner   INCLUDE    INCLUDE  WARN      ← matches snapshot tile for parity check
 *
 * "ESTIMATE" = surface fills in via ChannelListing.price-based
 * estimate (DA-RT.1 helper). Flagged with `*` annotation.
 * "WARN" = report includes the count + estimated value as a
 * separate metadata field but DOES NOT add into core totals — operator
 * resolves before downstream action (filing, reconciling).
 * "APPORTION" = Order.totalPrice apportioned by quantity share when
 * item prices are €0 (DA-RT.2 CTE logic).
 *
 * When in doubt: COMMENT the choice at the `where:` clause site.
 * Surfaces that diverge from this matrix need an explicit reason in
 * the comment + a follow-up to align, OR formal exemption added
 * here.
 */

import type { FastifyRequest } from 'fastify'

export type InsightsWindow =
  | 'today'
  | '7d'
  | '30d'
  | '90d'
  | 'mtd'
  | 'qtd'
  | 'ytd'
  | 'custom'

export type InsightsCompare = 'prev' | 'dod' | 'wow' | 'mom' | 'yoy' | 'none'

export interface InsightsFilters {
  window: InsightsWindow
  from: Date | null
  to: Date | null
  compare: InsightsCompare
  channels: string[]
  markets: string[]
  brands: string[]
}

const OPERATOR_TIMEZONE = 'Europe/Rome'

function zonedMidnight(
  y: number,
  m: number,
  d: number,
  timeZone: string,
): Date {
  const probe = new Date(Date.UTC(y, m, d, 12, 0, 0))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(probe)
  const find = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0)
  const hour = find('hour')
  // Compute zone offset in hours at noon UTC on this date (target zone
  // hour vs UTC's 12). For midnight, simply subtract `hour` from probe.
  const offsetHours = 12 - hour
  return new Date(probe.getTime() - offsetHours * 3600_000)
}

function zonedStartOfDay(at: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  const [y, m, d] = ymd.split('-').map(Number)
  return zonedMidnight(y!, (m ?? 1) - 1, d!, timeZone)
}

/** I8 — extract Europe/Rome calendar Y/M/D from a Date.
 *  Used by addZonedDays to perform calendar arithmetic instead of
 *  millisecond addition (which drifts across DST transitions). */
function zonedYMD(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  const [y, m, d] = ymd.split('-').map(Number)
  return { y: y!, m: (m ?? 1) - 1, d: d! }
}

/** I8 — add N calendar days to a zoned-midnight Date and return the
 *  resulting zoned-midnight Date. Safe across DST: spring-forward
 *  shrinks the offset by one hour, fall-back grows it by one hour,
 *  but the calendar day count is preserved exactly.
 *
 *  Naive arithmetic of `d.getTime() + N * 24*3600_000` drifts by an
 *  hour around the European DST transition (last Sunday of March /
 *  October), which can flip a record into the wrong day-bucket. */
function addZonedDays(d: Date, days: number, timeZone: string): Date {
  const { y, m, d: day } = zonedYMD(d, timeZone)
  // JS Date Y/M/D math in UTC handles month/year rollover; we then
  // re-anchor to the target zone's midnight so DST doesn't cause drift.
  const utc = new Date(Date.UTC(y, m, day + days, 12, 0, 0))
  const next = zonedYMD(utc, timeZone)
  return zonedMidnight(next.y, next.m, next.d, timeZone)
}

/** I8 — parse a user-supplied custom range value.
 *  Accepts:
 *    • YYYY-MM-DD     → interpreted as Europe/Rome midnight (operator-local)
 *    • full ISO 8601  → parsed as-is (UTC if Z suffix; honors offset)
 *  Falls back to null on bad input.
 *
 *  Rationale: `new Date("2026-05-21")` parses as UTC midnight (00:00Z),
 *  which is 02:00 Rome (CEST) — silently chopping the first two hours
 *  of the Italian operator's day off any custom range. Parsing as
 *  Rome midnight makes the operator's intent literal. */
function parseZonedDateInput(value: string, timeZone: string): Date | null {
  if (!value) return null
  // Pure date form (YYYY-MM-DD) — interpret as zoned midnight.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2]) - 1
    const d = Number(dateOnly[3])
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
    return zonedMidnight(y, m, d, timeZone)
  }
  // Full ISO 8601 form — let JS handle it. Includes "T", "Z", or offset.
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function resolveWindowRange(filters: InsightsFilters): {
  from: Date
  to: Date
} {
  const now = new Date()
  const today = zonedStartOfDay(now, OPERATOR_TIMEZONE)
  // I8 — `to` = first instant of *tomorrow* in Rome (exclusive upper bound).
  // Computed via calendar addition so DST transitions don't shift it by 1h.
  const endOfWindow = addZonedDays(today, 1, OPERATOR_TIMEZONE)
  switch (filters.window) {
    case 'today':
      return { from: today, to: endOfWindow }
    case '7d':
      // I8 — calendar-day arithmetic. Spring-forward Sunday is still
      // a calendar day even though it's only 23 wall-clock hours.
      return {
        from: addZonedDays(today, -6, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    case '30d':
      return {
        from: addZonedDays(today, -29, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    case '90d':
      return {
        from: addZonedDays(today, -89, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    case 'mtd': {
      const { y, m } = zonedYMD(now, OPERATOR_TIMEZONE)
      return {
        from: zonedMidnight(y, m, 1, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    }
    case 'qtd': {
      const { y, m } = zonedYMD(now, OPERATOR_TIMEZONE)
      const quarterStartMonth = Math.floor(m / 3) * 3
      return {
        from: zonedMidnight(y, quarterStartMonth, 1, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    }
    case 'ytd': {
      const { y } = zonedYMD(now, OPERATOR_TIMEZONE)
      return {
        from: zonedMidnight(y, 0, 1, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    }
    case 'custom': {
      // I8 — `filters.from`/`filters.to` arrive pre-parsed by parseInsightsFilters
      // using parseZonedDateInput, so YYYY-MM-DD strings get the operator's
      // local midnight rather than UTC midnight.
      const from = filters.from ?? addZonedDays(today, -29, OPERATOR_TIMEZONE)
      const to = filters.to ?? endOfWindow
      return { from, to }
    }
  }
}

/** I8 — count whole calendar days in a range. Uses Rome midnight
 *  anchors so DST-spanning windows still report the correct number. */
function zonedDayCount(from: Date, to: Date, timeZone: string): number {
  const fromStart = zonedStartOfDay(from, timeZone)
  const toStart = zonedStartOfDay(to, timeZone)
  return Math.round((toStart.getTime() - fromStart.getTime()) / (24 * 3600_000))
}

export function resolveCompareRange(
  filters: InsightsFilters,
  current: { from: Date; to: Date },
): { from: Date; to: Date } | null {
  if (filters.compare === 'none') return null
  // I8 — span measured in calendar days (Rome) so we can shift via
  // addZonedDays and preserve day alignment across DST.
  const spanDays = Math.max(1, zonedDayCount(current.from, current.to, OPERATOR_TIMEZONE))
  const shiftDays: Partial<Record<InsightsCompare, number>> = {
    dod: 1,
    wow: 7,
    mom: 30,
    yoy: 365,
  }
  if (filters.compare === 'prev') {
    return {
      from: addZonedDays(current.from, -spanDays, OPERATOR_TIMEZONE),
      to: current.from,
    }
  }
  const shift = shiftDays[filters.compare] ?? spanDays
  return {
    from: addZonedDays(current.from, -shift, OPERATOR_TIMEZONE),
    to: addZonedDays(current.to, -shift, OPERATOR_TIMEZONE),
  }
}

export function parseInsightsFilters(
  req: FastifyRequest,
): InsightsFilters {
  const q = (req.query ?? {}) as Record<string, string | undefined>
  const window = (q.window ?? '30d') as InsightsWindow
  const compare = (q.compare ?? 'prev') as InsightsCompare
  return {
    window: [
      'today',
      '7d',
      '30d',
      '90d',
      'mtd',
      'qtd',
      'ytd',
      'custom',
    ].includes(window)
      ? window
      : '30d',
    // I8 — YYYY-MM-DD interpreted as Europe/Rome midnight (operator-local).
    // `new Date('2026-05-21')` would land at UTC midnight = 02:00 Rome (CEST)
    // and silently exclude the first two hours of the day.
    from: q.from ? parseZonedDateInput(q.from, OPERATOR_TIMEZONE) : null,
    to: q.to ? parseZonedDateInput(q.to, OPERATOR_TIMEZONE) : null,
    compare: [
      'prev',
      'dod',
      'wow',
      'mom',
      'yoy',
      'none',
    ].includes(compare)
      ? compare
      : 'prev',
    channels: (q.channels ?? '').split(',').filter(Boolean),
    markets: (q.markets ?? '').split(',').filter(Boolean),
    brands: (q.brands ?? '').split(',').filter(Boolean),
  }
}

export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) {
    if (current === 0) return 0
    return null
  }
  return ((current - previous) / previous) * 100
}

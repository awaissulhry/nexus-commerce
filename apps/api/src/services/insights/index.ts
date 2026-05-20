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

export function resolveWindowRange(filters: InsightsFilters): {
  from: Date
  to: Date
} {
  const now = new Date()
  const today = zonedStartOfDay(now, OPERATOR_TIMEZONE)
  const endOfWindow = new Date(today.getTime() + 24 * 3600_000)
  switch (filters.window) {
    case 'today':
      return { from: today, to: endOfWindow }
    case '7d':
      return {
        from: new Date(today.getTime() - 6 * 24 * 3600_000),
        to: endOfWindow,
      }
    case '30d':
      return {
        from: new Date(today.getTime() - 29 * 24 * 3600_000),
        to: endOfWindow,
      }
    case '90d':
      return {
        from: new Date(today.getTime() - 89 * 24 * 3600_000),
        to: endOfWindow,
      }
    case 'mtd': {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: OPERATOR_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now)
      const [y, m] = ymd.split('-').map(Number)
      return {
        from: zonedMidnight(y!, (m ?? 1) - 1, 1, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    }
    case 'qtd': {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: OPERATOR_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now)
      const [y, m] = ymd.split('-').map(Number)
      const quarterStartMonth = Math.floor(((m ?? 1) - 1) / 3) * 3
      return {
        from: zonedMidnight(y!, quarterStartMonth, 1, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    }
    case 'ytd': {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: OPERATOR_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now)
      const [y] = ymd.split('-').map(Number)
      return {
        from: zonedMidnight(y!, 0, 1, OPERATOR_TIMEZONE),
        to: endOfWindow,
      }
    }
    case 'custom': {
      const from = filters.from ?? new Date(today.getTime() - 29 * 24 * 3600_000)
      const to = filters.to ?? endOfWindow
      return { from, to }
    }
  }
}

export function resolveCompareRange(
  filters: InsightsFilters,
  current: { from: Date; to: Date },
): { from: Date; to: Date } | null {
  if (filters.compare === 'none') return null
  const span = current.to.getTime() - current.from.getTime()
  const shifts: Partial<Record<InsightsCompare, number>> = {
    dod: 24 * 3600_000,
    wow: 7 * 24 * 3600_000,
    mom: 30 * 24 * 3600_000,
    yoy: 365 * 24 * 3600_000,
  }
  if (filters.compare === 'prev') {
    return {
      from: new Date(current.from.getTime() - span),
      to: new Date(current.from.getTime()),
    }
  }
  const shift = shifts[filters.compare] ?? span
  return {
    from: new Date(current.from.getTime() - shift),
    to: new Date(current.to.getTime() - shift),
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
    from: q.from ? new Date(q.from) : null,
    to: q.to ? new Date(q.to) : null,
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

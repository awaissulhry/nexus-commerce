/**
 * RPT.2 — client-side types + loader for GET /api/advertising/reporting/coverage.
 *
 * Mirrors the shape returned by ads-reporting-coverage.service.ts. Kept in its own
 * module so the catalogue can depend on the types without pulling in React.
 */
import { getBackendUrl } from '@/lib/backend-url'

export interface MarketCoverage {
  marketplace: string
  rows: number
  firstDay: string | null
  lastDay: string | null
  days: number
  lagDays: number | null
}

export interface ReportCoverage {
  rows: number
  firstDay: string | null
  lastDay: string | null
  days: number
  spanDays: number
  lagDays: number | null
  byMarket: MarketCoverage[]
}

export interface ReportingCoverage {
  asOf: string
  reports: Record<string, ReportCoverage>
  campaigns: Array<{ adProduct: string; enabled: number; paused: number; other: number }>
  ebayEconomicsStatus: Array<{ status: string; rows: number }>
  pipeline: {
    reportJobs: Array<{ status: string; jobs: number; rowsIngested: number }>
    reportTypes: Array<{ adProduct: string; reportTypeId: string; jobs: number; rowsIngested: number }>
    exportJobFailures: number
    dataKioskJobs: number
  }
  warnings: string[]
}

export async function fetchReportingCoverage(signal?: AbortSignal): Promise<ReportingCoverage> {
  // credentials:'include' — this route requires ads.view, and the console
  // authenticates by cookie. Without it every card would render "Checking…".
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/coverage`, {
    credentials: 'include',
    signal,
  })
  if (!res.ok) throw new Error(`Coverage unavailable (${res.status})`)
  return (await res.json()) as ReportingCoverage
}

/** "12,345" — thousands separated, locale-stable. */
export const fmtInt = (n: number): string => n.toLocaleString('en-GB')

/** "22 Mar → 2 Aug" from two YYYY-MM-DD strings. */
export function fmtWindow(first: string | null, last: string | null): string | null {
  if (!first || !last) return null
  const d = (s: string) => {
    const dt = new Date(`${s}T00:00:00Z`)
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  }
  return first === last ? d(first) : `${d(first)} → ${d(last)}`
}

/** "today" · "1 day old" · "8 days old" */
export function fmtLag(lagDays: number | null): string {
  if (lagDays == null) return '—'
  if (lagDays <= 0) return 'today'
  return `${lagDays} day${lagDays === 1 ? '' : 's'} old`
}

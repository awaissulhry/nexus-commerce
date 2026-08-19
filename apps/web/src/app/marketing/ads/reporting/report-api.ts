/**
 * RPT.3 — client contract for GET /api/advertising/reporting/run.
 *
 * The client defines NO columns of its own. Labels, formats and alignment all
 * arrive with the response, so there is exactly one definition of every column
 * and the grid cannot drift from what the export (RPT.4) will write.
 */
import { getBackendUrl } from '@/lib/backend-url'

export type ColumnFormat = 'text' | 'date' | 'int' | 'money' | 'pct' | 'ratio' | 'hour'

export interface ColumnMeta {
  id: string
  label: string
  kind: 'dimension' | 'metric'
  format: ColumnFormat
  align: 'left' | 'right'
  help?: string
}

export interface ReportResult {
  reportId: string
  title: string
  columns: ColumnMeta[]
  rows: Array<Record<string, unknown>>
  totals: Record<string, unknown> | null
  total: number
  page: number
  pageSize: number
  currency: string
  applied: {
    from: string | null
    to: string | null
    marketplaces: string[]
    adProducts: string[]
    search: string | null
    groupBy: string[]
    sort: { col: string; dir: 'asc' | 'desc' }
  }
  options: {
    columns: ColumnMeta[]
    dimensions: Array<{ id: string; label: string }>
    marketplaces: string[]
    adProducts: string[]
  }
  elapsedMs: number
}

export interface ReportParams {
  reportId: string
  from: string
  to: string
  marketplaces: string[]
  adProducts: string[]
  search: string
  groupBy: string[]
  columns: string[]
  sortCol: string | null
  sortDir: 'asc' | 'desc'
  page: number
  pageSize: number
}

/** Query string for a run. Shared so the export button can reuse it verbatim. */
export function runQueryString(p: ReportParams): string {
  const qs = new URLSearchParams({ reportId: p.reportId })
  if (p.from) qs.set('from', p.from)
  if (p.to) qs.set('to', p.to)
  if (p.marketplaces.length) qs.set('marketplaces', p.marketplaces.join(','))
  if (p.adProducts.length) qs.set('adProducts', p.adProducts.join(','))
  if (p.search.trim()) qs.set('search', p.search.trim())
  if (p.groupBy.length) qs.set('groupBy', p.groupBy.join(','))
  if (p.columns.length) qs.set('columns', p.columns.join(','))
  if (p.sortCol) {
    qs.set('sortCol', p.sortCol)
    qs.set('sortDir', p.sortDir)
  }
  qs.set('page', String(p.page))
  qs.set('pageSize', String(p.pageSize))
  return qs.toString()
}

export async function runReport(p: ReportParams, signal?: AbortSignal): Promise<ReportResult> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/reporting/run?${runQueryString(p)}`,
    { credentials: 'include', signal },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Report failed (${res.status})`)
  }
  return (await res.json()) as ReportResult
}

/**
 * Render a value for its declared format.
 *
 * null is ALWAYS "—", never 0. An ACOS with no sales behind it is undefined, not
 * zero percent, and the whole console has been bitten before by `Number(null)`
 * quietly becoming a real 0.
 */
export function formatCell(v: unknown, format: ColumnFormat, currency: string): string {
  if (v == null || v === '') return '—'
  if (format === 'text') return String(v)
  if (format === 'date') return String(v)
  if (format === 'hour') return `${String(v).padStart(2, '0')}:00`
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)
  switch (format) {
    case 'int':
      return n.toLocaleString('en-GB')
    case 'money':
      return n.toLocaleString('en-GB', { style: 'currency', currency, maximumFractionDigits: 2 })
    case 'pct':
      return `${(n * 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`
    case 'ratio':
      return n.toLocaleString('en-GB', { maximumFractionDigits: 2 })
    default:
      return String(v)
  }
}

/**
 * YYYY-MM-DD for a Date, read in LOCAL parts.
 *
 * 🔴 R2 — this was `toISOString().slice(0,10)`, i.e. UTC. That is not interchangeable with the
 * local form: measured in the operator's own timezone (Europe/Rome, UTC+2), a Date at local
 * midnight — which is exactly what `DateRangePicker` produces for every day you click —
 * serialises one day EARLY under UTC. Picking 19 Aug asked the server for 18 Aug.
 *
 * The runner now writes the picked range in local days, so the default window has to speak the
 * same vocabulary or the two disagree for the two hours after local midnight: the header would
 * open on a range ending yesterday while the picker's own "Today" meant today. One control,
 * one meaning. The calendar is rendered in local time, so local is the side to standardise on.
 */
export const isoDay = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Default window: the trailing 30 days, ending today. */
export function defaultRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - 29)
  return { from: isoDay(from), to: isoDay(to) }
}

/**
 * Download URL for the current query. Deliberately built from the SAME
 * ReportParams the grid is rendering, minus pagination — so "export what I am
 * looking at" is literally true rather than approximately true.
 */
export function exportUrl(p: ReportParams, format: 'csv' | 'xlsx'): string {
  const qs = new URLSearchParams(runQueryString(p))
  qs.delete('page')
  qs.delete('pageSize')
  qs.set('format', format)
  return `${getBackendUrl()}/api/advertising/reporting/export?${qs.toString()}`
}

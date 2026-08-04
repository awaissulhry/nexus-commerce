/** RPT.10 — client contract for KPI totals, period comparison and the trend series. */
import { getBackendUrl } from '@/lib/backend-url'
import type { ColumnFormat, ReportParams } from './report-api'

export type CompareMode = 'none' | 'previous' | 'yoy'

export interface KpiMetric {
  id: string
  label: string
  format: ColumnFormat
  /** null = neither direction is an improvement (spend), so no colour is applied. */
  betterWhen: 'higher' | 'lower' | null
  current: number | null
  previous: number | null
  deltaPct: number | null
}

export interface SummaryResult {
  reportId: string
  currency: string
  compare: CompareMode
  window: { from: string | null; to: string | null }
  comparisonWindow: { from: string | null; to: string | null } | null
  metrics: KpiMetric[]
  series: Array<Record<string, number | string | null>>
  bucket: 'day' | 'week' | 'month'
  timeSeries: boolean
  noSeriesReason: string | null
  elapsedMs: number
}

export async function fetchSummary(
  p: ReportParams, compare: CompareMode, signal?: AbortSignal,
): Promise<SummaryResult> {
  const qs = new URLSearchParams({ reportId: p.reportId, compare })
  if (p.from) qs.set('from', p.from)
  if (p.to) qs.set('to', p.to)
  if (p.marketplaces.length) qs.set('marketplaces', p.marketplaces.join(','))
  if (p.adProducts.length) qs.set('adProducts', p.adProducts.join(','))
  if (p.search.trim()) qs.set('search', p.search.trim())
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/summary?${qs}`, {
    credentials: 'include', signal,
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(b?.error ?? `Summary failed (${res.status})`)
  }
  return (await res.json()) as SummaryResult
}

/**
 * Is this delta an improvement? null when the metric has no preferred direction
 * (spend) or there is no baseline — in both cases the number is shown without
 * colour rather than guessed at.
 */
export function deltaIsGood(m: KpiMetric): boolean | null {
  if (m.deltaPct == null || m.betterWhen == null || m.deltaPct === 0) return null
  return (m.deltaPct > 0) === (m.betterWhen === 'higher')
}

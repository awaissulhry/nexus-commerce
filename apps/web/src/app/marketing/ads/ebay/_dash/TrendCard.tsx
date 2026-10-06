'use client'

/**
 * ER3.3 (delta 6) — trend card with metric views: Fees+Sales (default) ·
 * Fees+ACOS · Clicks+Impressions. Same TrendPayload, three graph configs.
 */
import { useMemo, useState } from 'react'
import { PerformanceGraph } from '@/design-system/components/PerformanceGraph'
import { FilterChip } from '@/design-system/primitives'
import type { TrendPayload } from '../_lib'
import { money } from '../../campaigns/_grid/format'
import { trendPoint } from './trendPoints'

type View = 'fees_sales' | 'fees_acos' | 'clicks_impr'
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'fees_sales', label: 'Fees + Sales' },
  { id: 'fees_acos', label: 'Fees + ACOS' },
  { id: 'clicks_impr', label: 'Clicks + Impressions' },
]

export function TrendCard({ trend, loading }: { trend: TrendPayload | null; loading: boolean }) {
  const [view, setView] = useState<View>('fees_sales')
  const data = useMemo(
    // AM-19 — a no-sales day has no ACOS: a gap in the line, never 0 %.
    () => (trend?.points ?? []).map(trendPoint),
    [trend],
  )
  // AM-21 — money lines in the window's own currency; a window that spans currencies (all markets with eBay GB) has
  // no money per day, so the two money views say so instead of drawing a sum of pounds and euros.
  const ccy = trend?.currency ?? 'EUR'
  const mixedMoney = trend?.currency === null && view !== 'clicks_impr'
  const fmtMoney = (v: number) => money(Math.round(v * 100), ccy)
  const cfg = view === 'fees_sales'
    ? { left: { key: 'fees', label: 'Ad fees', color: '#e5484d', axis: 'left' as const, format: fmtMoney }, right: { key: 'sales', label: 'Ad sales', color: '#1f6fde', axis: 'right' as const, format: fmtMoney } }
    : view === 'fees_acos'
      ? { left: { key: 'fees', label: 'Ad fees', color: '#e5484d', axis: 'left' as const, format: fmtMoney }, right: { key: 'acos', label: 'ACOS', color: '#b87503', axis: 'right' as const, format: (v: number) => `${v.toFixed(1)}%` } }
      : { left: { key: 'clicks', label: 'Clicks', color: '#12855f', axis: 'left' as const, format: (v: number) => `${Math.round(v)}` }, right: { key: 'impressions', label: 'Impressions', color: '#1f6fde', axis: 'right' as const, format: (v: number) => `${Math.round(v)}` } }
  return (
    <div className="dash-card">
      <div className="dash-card-h">
        <span>Performance trend</span>
        {/* `role="group"`, not `tablist`: these chips have no tabpanels — they choose which
            series the chart draws — and the DS `FilterChip` states that with `aria-pressed`. */}
        <span className="eb-dash-views" role="group" aria-label="Chart metrics">
          {VIEWS.map((v) => (
            <FilterChip key={v.id} pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</FilterChip>
          ))}
        </span>
      </div>
      <div className="dash-chart">
        {data.length === 0 ? (
          <div className="dash-empty">{loading ? 'Loading…' : 'No performance data in this window — reports land daily.'}</div>
        ) : mixedMoney ? (
          <div className="dash-empty">These markets report in different currencies, so one money line would add them together. Pick one market, or view Clicks + Impressions.</div>
        ) : (
          <PerformanceGraph data={data} xKey="date" left={cfg.left} right={cfg.right} height={240} />
        )}
      </div>
    </div>
  )
}

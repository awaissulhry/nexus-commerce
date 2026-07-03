'use client'

/**
 * ER3.3 (delta 6) — trend card with metric views: Fees+Sales (default) ·
 * Fees+ACOS · Clicks+Impressions. Same TrendPayload, three graph configs.
 */
import { useMemo, useState } from 'react'
import { PerformanceGraph } from '@/design-system/components/PerformanceGraph'
import type { TrendPayload } from '../_lib'

type View = 'fees_sales' | 'fees_acos' | 'clicks_impr'
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'fees_sales', label: 'Fees + Sales' },
  { id: 'fees_acos', label: 'Fees + ACOS' },
  { id: 'clicks_impr', label: 'Clicks + Impressions' },
]

export function TrendCard({ trend, loading }: { trend: TrendPayload | null; loading: boolean }) {
  const [view, setView] = useState<View>('fees_sales')
  const data = useMemo(
    () => (trend?.points ?? []).map((p) => ({
      date: p.date.slice(5),
      fees: p.adFeesCents / 100, sales: p.salesCents / 100,
      acos: p.acosPct ?? 0, clicks: p.clicks, impressions: p.impressions,
    })),
    [trend],
  )
  const cfg = view === 'fees_sales'
    ? { left: { key: 'fees', label: 'Ad fees', color: '#e5484d', axis: 'left' as const, format: (v: number) => `€${v.toFixed(2)}` }, right: { key: 'sales', label: 'Ad sales', color: '#1f6fde', axis: 'right' as const, format: (v: number) => `€${v.toFixed(2)}` } }
    : view === 'fees_acos'
      ? { left: { key: 'fees', label: 'Ad fees', color: '#e5484d', axis: 'left' as const, format: (v: number) => `€${v.toFixed(2)}` }, right: { key: 'acos', label: 'ACOS', color: '#b87503', axis: 'right' as const, format: (v: number) => `${v.toFixed(1)}%` } }
      : { left: { key: 'clicks', label: 'Clicks', color: '#12855f', axis: 'left' as const, format: (v: number) => `${Math.round(v)}` }, right: { key: 'impressions', label: 'Impressions', color: '#1f6fde', axis: 'right' as const, format: (v: number) => `${Math.round(v)}` } }
  return (
    <div className="dash-card">
      <div className="dash-card-h">
        <span>Performance trend</span>
        <span className="eb-dash-views" role="tablist" aria-label="Chart metrics">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={`eb-kind-chip ${view === v.id ? 'on' : ''}`} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </span>
      </div>
      <div className="dash-chart">
        {data.length === 0 ? (
          <div className="dash-empty">{loading ? 'Loading…' : 'No performance data in this window — reports land daily.'}</div>
        ) : (
          <PerformanceGraph data={data} xKey="date" left={cfg.left} right={cfg.right} height={240} />
        )}
      </div>
    </div>
  )
}

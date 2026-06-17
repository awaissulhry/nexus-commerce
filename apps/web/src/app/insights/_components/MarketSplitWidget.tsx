'use client'

import { Card } from '@/components/ui/Card'
import { BreakdownBar, formatCurrencyCompact } from '@/components/insights'
import type { InsightsBreakdown } from './useInsightsData'

export function MarketSplitWidget({
  breakdown,
  loading,
}: {
  breakdown: InsightsBreakdown | null
  loading: boolean
}) {
  if (loading && !breakdown) {
    return (
      <Card title="Market split">
        <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
          Loading…
        </div>
      </Card>
    )
  }
  if (!breakdown) return null

  const total = breakdown.byMarket.reduce((s, b) => s + b.revenue, 0)
  const top = [...breakdown.byMarket]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8)

  return (
    <Card
      title="Market split"
      description="Top markets by revenue"
      action={
        <span className="text-xs text-slate-500 tabular-nums">
          {formatCurrencyCompact(total, breakdown.currency)}
        </span>
      }
    >
      <BreakdownBar
        entries={top.map((b) => ({
          key: b.key,
          label: b.label,
          value: b.revenue,
          delta: b.deltaPct,
        }))}
        format="currency"
        currency={breakdown.currency}
        total={total}
      />
    </Card>
  )
}

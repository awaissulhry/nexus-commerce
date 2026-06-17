'use client'

import { Card } from '@/components/ui/Card'
import { BreakdownPie, formatCurrencyCompact } from '@/components/insights'
import type { InsightsBreakdown } from './useInsightsData'

export function ChannelSplitWidget({
  breakdown,
  loading,
}: {
  breakdown: InsightsBreakdown | null
  loading: boolean
}) {
  if (loading && !breakdown) {
    return (
      <Card title="Channel split">
        <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
          Loading…
        </div>
      </Card>
    )
  }
  if (!breakdown) return null

  const total = breakdown.byChannel.reduce((s, b) => s + b.revenue, 0)

  return (
    <Card
      title="Channel split"
      action={
        <span className="text-xs text-slate-500 tabular-nums">
          {formatCurrencyCompact(total, breakdown.currency)}
        </span>
      }
    >
      <BreakdownPie
        entries={breakdown.byChannel.map((b) => ({
          key: b.key,
          label: b.label,
          value: b.revenue,
          delta: b.deltaPct,
        }))}
        variant="donut"
        currency={breakdown.currency}
        height={220}
        ariaLabel="Revenue by channel"
        centerLabel="Channels"
        centerValue={String(breakdown.byChannel.length)}
      />
    </Card>
  )
}

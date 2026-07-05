'use client'

import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { color } from '@/design-system/tokens'

export interface ChartSeries {
  key: string
  label: string
  color: string
  axis: 'left' | 'right'
  format?: (v: number) => string
}

export interface PerformanceGraphProps {
  data: Array<Record<string, number | string>>
  xKey: string
  left: ChartSeries
  right: ChartSeries
  height?: number
  className?: string
}

function ChartTooltip({
  active,
  payload,
  label,
  left,
  right,
}: {
  active?: boolean
  payload?: Array<{ dataKey?: string | number; value?: number }>
  label?: string
  left: ChartSeries
  right: ChartSeries
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="h10-ds-chart-tt">
      <div className="d">{label}</div>
      {payload.map((p) => {
        const s = p.dataKey === left.key ? left : right
        return (
          <div className="r" key={String(p.dataKey)}>
            <span className="dot" style={{ background: s.color }} />
            <span style={{ color: 'var(--h10-text-2)' }}>{s.label}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{s.format && p.value != null ? s.format(p.value) : p.value}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Dual-axis combo chart (H10 AdManagerGraph): two line series on independent
 * left/right axes, tokenized axes + grid, custom tooltip + legend. Recharts.
 */
export function PerformanceGraph({ data, xKey, left, right, height = 240, className }: PerformanceGraphProps) {
  return (
    <div className={className || undefined}>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={color.borderSubtle} vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: color.text3 }} tickLine={false} axisLine={{ stroke: color.border }} />
          <YAxis yAxisId="left" tick={{ fontSize: 11, fill: color.text3 }} tickLine={false} axisLine={false} width={46} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: color.text3 }} tickLine={false} axisLine={false} width={46} />
          <Tooltip
            cursor={{ stroke: color.border }}
            content={(props) => <ChartTooltip active={props.active} payload={props.payload as never} label={props.label as string} left={left} right={right} />}
          />
          <Line yAxisId={left.axis} dataKey={left.key} stroke={left.color} dot={false} strokeWidth={2} />
          <Line yAxisId={right.axis} dataKey={right.key} stroke={right.color} dot={false} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="h10-ds-chart-legend">
        <span className="sw">
          <span className="ln" style={{ background: left.color }} />
          {left.label}
        </span>
        <span className="sw">
          <span className="ln" style={{ background: right.color }} />
          {right.label}
        </span>
      </div>
    </div>
  )
}

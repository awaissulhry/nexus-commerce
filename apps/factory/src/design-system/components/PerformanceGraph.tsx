'use client'

import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { color } from '@/design-system/tokens'
import { axisScale, isolatedPoints } from './performanceGraphModel'

export interface ChartSeries {
  key: string
  label: string
  color: string
  axis: 'left' | 'right'
  format?: (v: number) => string
  /**
   * The name of this series' axis, shown above it ("Cost (EUR)"). Two series on two axes whose scales differ read as
   * the same size without one; set it on both, or on neither.
   */
  axisLabel?: string
  /**
   * A fixed range for this series' axis — `[0, 5]` for a 5-star rating, which fitted to its data ran 0–8. Default: fitted
   * to the data. Data outside it still widens the axis, so nothing is drawn off the chart.
   */
  domain?: [number, number]
  /** The axis's tick values, e.g. `[0, 1, 2, 3, 4, 5]` (the ones inside `domain`). Default: Recharts picks them. */
  ticks?: number[]
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
    <div className="nds-chart-tt">
      <div className="d">{label}</div>
      {payload.map((p) => {
        const s = p.dataKey === left.key ? left : right
        return (
          <div className="r" key={String(p.dataKey)}>
            <span className="dot" style={{ background: s.color }} />
            <span style={{ color: 'var(--nds-text-2)' }}>{s.label}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{s.format && p.value != null ? s.format(p.value) : p.value}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A value with no value on either side has no line segment: it gets a dot in its series' colour, or it would not show at
 * all (`isolatedPoints`). Every other point stays a plain line, as before.
 */
function loneDots(data: PerformanceGraphProps['data'], series: ChartSeries) {
  const lone = isolatedPoints(data.map((row) => row[series.key]))
  if (lone.size === 0) return false
  return function LoneDot({ index, cx, cy }: { index: number; cx?: number; cy?: number }) {
    return lone.has(index) && cx != null && cy != null ? <circle cx={cx} cy={cy} r={3} fill={series.color} /> : null
  }
}

/**
 * Dual-axis combo chart (H10 AdManagerGraph): two line series on independent
 * left/right axes, tokenized axes + grid, custom tooltip + legend. Recharts.
 * A series may fix its axis (`domain`, `ticks`); a lone value between gaps shows as a dot.
 */
export function PerformanceGraph({ data, xKey, left, right, height = 240, className }: PerformanceGraphProps) {
  const leftAxis = left.axis === 'left' ? left : right.axis === 'left' ? right : null
  const rightAxis = right.axis === 'right' ? right : left.axis === 'right' ? left : null
  return (
    <div className={className || undefined}>
      {(leftAxis?.axisLabel || rightAxis?.axisLabel) && (
        <div className="nds-chart-axes">
          {[leftAxis, rightAxis].map((s, i) => (
            <span key={i} className={i === 0 ? 'l' : 'r'}>
              {s?.axisLabel && <><span className="ln" style={{ background: s.color }} aria-hidden="true" />{s.axisLabel}</>}
            </span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={color.borderSubtle} vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: color.text3 }} tickLine={false} axisLine={{ stroke: color.border }} />
          <YAxis yAxisId="left" tick={{ fontSize: 11, fill: color.text3 }} tickLine={false} axisLine={false} width={46} {...axisScale(leftAxis)} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: color.text3 }} tickLine={false} axisLine={false} width={46} {...axisScale(rightAxis)} />
          <Tooltip
            cursor={{ stroke: color.border }}
            content={(props) => <ChartTooltip active={props.active} payload={props.payload as never} label={props.label as string} left={left} right={right} />}
          />
          <Line yAxisId={left.axis} dataKey={left.key} stroke={left.color} dot={loneDots(data, left)} strokeWidth={2} />
          <Line yAxisId={right.axis} dataKey={right.key} stroke={right.color} dot={loneDots(data, right)} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="nds-chart-legend">
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

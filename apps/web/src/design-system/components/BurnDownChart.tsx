'use client'

/**
 * BurnDownChart — cumulative actual vs plan, on ONE axis.
 *
 * Added by BSP.1 rather than reusing `PerformanceGraph`, and the reason is a rule not a preference:
 * `PerformanceGraph` is a **dual-axis** component (`left` / `right`, two `YAxis`), and a burn-down
 * has one unit. Every series here is money, so two y-scales would be actively misleading — the
 * single most common charting mistake there is. This component therefore has no `right` prop and
 * cannot grow one.
 *
 * ── The encoding, and why identity is never carried by hue alone ───────────────────────────────
 *
 *   actual     solid, brand hue      what has been spent, cumulative, stops at today
 *   forecast   dashed, SAME hue      the same entity projected — a projection is not a new series,
 *                                    so it is differentiated by dash, never by a second colour
 *   expected   dashed, neutral ink   the plan's own pace line; a reference, deliberately recessive
 *   cap        dashed, critical hue  a threshold, drawn as a rule with its own label
 *
 * That is two real hues, validated: #1f6fde vs #b3261e is ΔE 28.7 under deuteranopia and 33.5 for
 * normal vision, comfortably past the ΔE 8 floor. The neutral is intentionally low-chroma because
 * it is a reference, not an identity, and it carries a dash pattern and a legend entry as its
 * secondary encoding.
 *
 * A legend is always rendered, so no series is identified by colour alone.
 */

import type { CSSProperties } from 'react'
import {
  ComposedChart, Line, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

export interface BurnDownPoint {
  day: number
  /** Cumulative actual, in the display unit. null after today. */
  actual: number | null
  expected: number
  /** Cumulative projection. null before today. */
  forecast: number | null
}

export interface BurnDownChartProps {
  data: BurnDownPoint[]
  /** Drawn as a horizontal threshold rule. Omit when the plan has no cap. */
  capValue?: number | null
  capLabel?: string
  /** Formats every value — axis ticks, tooltip rows and the cap label. */
  format: (v: number) => string
  height?: number
  /** Marks "today" with a faint vertical rule, so the actual/forecast handover is legible. */
  todayDay?: number | null
  className?: string
}

const HUE_ACTUAL = '#1f6fde'
const HUE_CAP = '#b3261e'
const INK_REFERENCE = '#667080'
const INK_AXIS = '#8a93a1'
const GRID = '#eef1f5'

function BurnTooltip({ active, payload, label, format }: {
  active?: boolean
  payload?: Array<{ dataKey?: string | number; value?: number | null }>
  label?: string | number
  format: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const at = (k: string) => payload.find((p) => p.dataKey === k)?.value
  const rows: Array<[string, number | null | undefined, string]> = [
    ['Spent', at('actual'), HUE_ACTUAL],
    ['Projected', at('forecast'), HUE_ACTUAL],
    ['Planned', at('expected'), INK_REFERENCE],
  ]
  return (
    <div className="h10-ds-burn-tip">
      <b>Day {label}</b>
      {rows.filter(([, v]) => v != null).map(([k, v, c]) => (
        <span key={k}>
          <i style={{ background: c }} aria-hidden="true" />
          {k}
          {/* The value wears text ink, never the series colour — the swatch carries identity. */}
          <em>{format(v as number)}</em>
        </span>
      ))}
    </div>
  )
}

export function BurnDownChart({
  data, capValue, capLabel, format, height = 168, todayDay, className,
}: BurnDownChartProps) {
  // The cap must be inside the domain or the threshold rule renders off-canvas and the chart
  // silently stops saying the one thing it exists to say.
  const values = data.flatMap((d) => [d.actual, d.expected, d.forecast]).filter((v): v is number => v != null)
  const top = Math.max(...values, capValue ?? 0, 1)

  return (
    <div className={`h10-ds-burn${className ? ` ${className}` : ''}`}>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10, fill: INK_AXIS }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          {/* ONE axis. Every series is the same unit. */}
          <YAxis
            tick={{ fontSize: 10, fill: INK_AXIS }}
            tickLine={false}
            axisLine={false}
            width={52}
            domain={[0, Math.ceil(top * 1.06)]}
            tickFormatter={format}
          />
          <Tooltip
            cursor={{ stroke: '#c2c9d3' }}
            content={(p) => (
              <BurnTooltip active={p.active} payload={p.payload as never} label={p.label as never} format={format} />
            )}
          />

          {todayDay != null && (
            <ReferenceLine x={todayDay} stroke="#c2c9d3" strokeDasharray="2 3" />
          )}
          {capValue != null && capValue > 0 && (
            <ReferenceLine
              y={capValue}
              stroke={HUE_CAP}
              strokeDasharray="5 4"
              // Left, not right: a cumulative chart's lines END high, so a right-aligned label sits
              // exactly where the actual and projected series arrive. The left of the plot is empty
              // by construction — day 1 of a cumulative series is always at the bottom.
              label={{ value: capLabel ?? format(capValue), position: 'insideTopLeft', fontSize: 10, fill: HUE_CAP }}
            />
          )}

          {/* The plan's pace — recessive, because it is the thing being compared against. */}
          <Line type="monotone" dataKey="expected" stroke={INK_REFERENCE} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          {/* The same entity, projected: same hue, dashed. Not a fourth colour. */}
          <Line type="monotone" dataKey="forecast" stroke={HUE_ACTUAL} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
          {/* What actually happened. Thickest, solid, drawn last so it sits on top. */}
          <Line type="monotone" dataKey="actual" stroke={HUE_ACTUAL} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Always present: four marks, three of which share two hues, so colour alone never identifies. */}
      {/* 🔴 The hue goes in as a custom property, NOT as `background`. The shorthand resets
          `background-image`, which is what draws the dash — so an inline `background` made every
          swatch solid and left "Spent" and "Projected" (which share a hue by design) identical. */}
      <div className="h10-ds-burn-key">
        <span><i className="ln solid" style={{ '--c': HUE_ACTUAL } as CSSProperties} aria-hidden="true" />Spent</span>
        <span><i className="ln dash" style={{ '--c': HUE_ACTUAL } as CSSProperties} aria-hidden="true" />Projected</span>
        <span><i className="ln dash" style={{ '--c': INK_REFERENCE } as CSSProperties} aria-hidden="true" />Planned pace</span>
        {capValue != null && capValue > 0 && (
          <span><i className="ln dash" style={{ '--c': HUE_CAP } as CSSProperties} aria-hidden="true" />Cap</span>
        )}
      </div>
    </div>
  )
}

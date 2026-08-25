'use client'

/**
 * R4 — MetricChart: the ONE time-series chart in the ads console.
 *
 * The console had two, and they disagreed about everything that matters. The Ad Manager's
 * graph offered exactly two metrics, one per axis, picked from two dropdowns. Reporting's
 * offered exactly one, chosen by clicking a KPI tile. Neither could answer the question the
 * operator actually asks — *show me impressions, clicks, sales and ACOS together* — and each
 * carried its own tooltip, its own legend and its own idea of what a chart looks like.
 *
 * So this is the Amazon Advertising console's model, which is the one operators already know:
 * **tick any metrics and every ticked metric is plotted.** Untick to drop it. No left/right
 * slots, no two-metric ceiling.
 *
 * ── Scale, which is the whole difficulty ────────────────────────────────────────────────────
 *
 * Impressions run to seven figures and ACOS is a fraction under one. On a shared axis ACOS is a
 * flat line along the floor — present, and unreadable. So **every plotted metric is drawn to its
 * own domain**: each gets its own `YAxis`, and only the first two are rendered visibly, because
 * six labelled axes is not a chart. The legend says so in one line rather than leaving you to
 * infer it, and the tooltip carries every ticked metric's TRUE value with its unit — which is
 * where an exact number belongs anyway.
 *
 * ── What is shared, and what a consumer supplies ────────────────────────────────────────────
 *
 * Shared: the frame, the axes, the grid, the legend, the picker, the tooltip, the resize grip,
 * the colours, the empty and loading states. All of it, identically, on both pages.
 *
 * Supplied: the data and the metric list — because those genuinely differ. The Ad Manager reads
 * `/advertising/trends`; a report reads its own summary series over whatever grain it was run
 * at. `trailingAverage` and `annotations` are CAPABILITIES rather than per-page styling: pass
 * the data and the feature appears, identically wherever it appears.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ChevronDown, Equal } from 'lucide-react'
import { AnnotationTooltipRows, type DayAnnotation } from '../campaigns/ChangeAnnotations'

export type MetricUnit = 'eur' | 'pct' | 'count' | 'ratio'

export interface ChartMetric {
  key: string
  label: string
  unit: MetricUnit
}

/**
 * Six lines is the point at which one more stops adding information and starts taking it away —
 * hue differences get too fine to hold while your eye is on the shape. Amazon caps for the same
 * reason. The picker says so rather than silently ignoring the seventh click.
 */
export const MAX_PLOTTED = 6

/**
 * Categorical line colours, taken from the console's own status ramp (`ads.css`) rather than
 * invented: the blue is `--nds-primary`, the green `--nds-success-strong`, the red and amber the
 * danger/warning strongs. Ordered so the first two — the ones that get a labelled axis — are the
 * furthest apart. Every one clears 3:1 against the white card these sit on, which is the bar for
 * a graphical object; hue is never the only cue, because the legend and tooltip both name them.
 */
const SERIES_COLORS = ['#1f6fde', '#c2410c', '#15803d', '#7c3aed', '#0e7490', '#c0392b']
/** The trailing mean is the same hue, lightened, so it reads as a companion and not a rival. */
const AVG_COLORS = ['#93b8ec', '#e0a97f', '#8dc4a3', '#bda2ea', '#7fb3c2', '#dfa39c']

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const fmtFull = (v: number | null, u: MetricUnit): string => {
  // null is never 0 here either: a metric with no denominator is undefined, not zero.
  if (v == null || !Number.isFinite(v)) return '—'
  if (u === 'eur') return eur(v)
  if (u === 'pct') return `${(v * 100).toFixed(2)}%`
  if (u === 'ratio') return v.toLocaleString('en-IE', { maximumFractionDigits: 2 })
  return v.toLocaleString('en-IE')
}
const fmtAxis = (v: number, u: MetricUnit): string => {
  if (u === 'pct') return `${+(v * 100).toFixed(1)}%`
  if (u === 'eur') return v >= 1000 ? `€${(v / 1000).toFixed(1)}k` : Number.isInteger(v) ? `€${v}` : `€${v.toFixed(2)}`
  if (u === 'ratio') return v.toFixed(1)
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`
}
const dayShort = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const dayLong = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Suffix for the trailing-average companion series, kept off the data keys the consumer owns. */
const AVG = '__avg__'

// ── the picker ────────────────────────────────────────────────────────────────────────────────
function MetricPicker({
  metrics, selected, onChange,
}: { metrics: ChartMetric[]; selected: string[]; onChange: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const atCap = selected.length >= MAX_PLOTTED
  const toggle = (key: string) => {
    if (selected.includes(key)) {
      // Never leave the chart with nothing on it — unticking the last metric would render an
      // empty frame with no way back except reading the legend that is no longer there.
      if (selected.length === 1) return
      onChange(selected.filter((k) => k !== key))
    } else if (!atCap) {
      onChange([...selected, key])
    }
  }

  return (
    <div className={`h10-gsel ${open ? 'open' : ''}`} ref={ref}>
      <button
        type="button" className="h10-gsel-btn" onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox" aria-expanded={open}
      >
        <span className="h10-gmdots" aria-hidden>
          {selected.slice(0, MAX_PLOTTED).map((k, i) => (
            <span key={k} className="dot" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          ))}
        </span>
        <span className="lb">{selected.length === 1
          ? metrics.find((m) => m.key === selected[0])?.label ?? '1 metric'
          : `${selected.length} metrics`}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="h10-gsel-pop" role="listbox" aria-multiselectable>
          {metrics.map((m) => {
            const i = selected.indexOf(m.key)
            const on = i >= 0
            // A control that refuses has to say why it refused, where the refusal happens.
            const blocked = !on && atCap
            const last = on && selected.length === 1
            return (
              <button
                type="button" key={m.key} role="option" aria-selected={on}
                className={`${on ? 'sel' : ''} ${blocked || last ? 'dis' : ''}`}
                onClick={() => toggle(m.key)}
                title={blocked ? `Untick one first — ${MAX_PLOTTED} metrics is the most this chart plots at once.`
                  : last ? 'The chart needs at least one metric.' : undefined}
              >
                <span className="tick" aria-hidden>{on ? '✓' : ''}</span>
                <span
                  className="dot"
                  style={{ background: on ? SERIES_COLORS[i % SERIES_COLORS.length] : 'transparent' }}
                  aria-hidden
                />
                {m.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── the tooltip ───────────────────────────────────────────────────────────────────────────────
function ChartTooltip({
  active, payload, plotted, annotations, trailingAverage,
}: {
  active?: boolean
  payload?: Array<{ payload: Record<string, string | number | null> }>
  plotted: ChartMetric[]
  annotations?: Map<string, DayAnnotation>
  trailingAverage?: number
}) {
  if (!active || !payload?.length) return null
  const p = payload[0]?.payload
  if (!p) return null
  const date = String(p.date ?? '')
  return (
    <div className="h10-gtt">
      <div className="h10-gtt-d">{dayLong(date)}</div>
      {plotted.map((m, i) => (
        <div className="h10-gtt-r" key={m.key}>
          <span className="dot" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          <span className="nm">{m.label}</span>
          <span className="v">{fmtFull(p[m.key] as number | null, m.unit)}</span>
        </div>
      ))}
      {trailingAverage ? plotted.map((m, i) => (
        <div className="h10-gtt-r" key={`${m.key}avg`}>
          <span className="dot" style={{ background: AVG_COLORS[i % AVG_COLORS.length] }} />
          <span className="nm">{m.label} · {trailingAverage}-day average</span>
          <span className="v">{fmtFull(p[m.key + AVG] as number | null, m.unit)}</span>
        </div>
      )) : null}
      {annotations?.get(date) && <AnnotationTooltipRows day={annotations.get(date)!} />}
    </div>
  )
}

export interface MetricChartProps {
  title: string
  subtitle?: string
  /** One row per bucket: `date` (ISO day) plus one numeric field per metric key. */
  data: Array<Record<string, string | number | null>>
  /** Everything that CAN be plotted, in picker order. */
  metrics: ChartMetric[]
  selected: string[]
  onSelectedChange: (keys: string[]) => void
  loading?: boolean
  emptyLabel?: string
  /** Persists the chart height under this key. Omit ⇒ not persisted. */
  storageKey?: string
  /** Draw a dashed trailing mean of N buckets beside each plotted metric. */
  trailingAverage?: number
  /** Change markers on the timeline, keyed by ISO day. */
  annotations?: Map<string, DayAnnotation>
  /** The consumer's own annotation toggle, rendered in the legend row. */
  annotationSlot?: ReactNode
}

export function MetricChart({
  title, subtitle, data, metrics, selected, onSelectedChange,
  loading, emptyLabel = 'No data in this date range.', storageKey,
  trailingAverage, annotations, annotationSlot,
}: MetricChartProps) {
  const [height, setHeight] = useState(300)
  useEffect(() => {
    if (!storageKey) return
    try { const h = Number(localStorage.getItem(`${storageKey}-h`)); if (h >= 220 && h <= 640) setHeight(h) } catch { /* ignore */ }
  }, [storageKey])
  useEffect(() => {
    if (!storageKey) return
    try { localStorage.setItem(`${storageKey}-h`, String(height)) } catch { /* ignore */ }
  }, [height, storageKey])

  const heightRef = useRef(height); heightRef.current = height
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY, h0 = heightRef.current
    const move = (ev: PointerEvent) => setHeight(clamp(h0 + (ev.clientY - y0), 220, 640))
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const plotted = useMemo(
    () => selected.map((k) => metrics.find((m) => m.key === k)).filter((m): m is ChartMetric => !!m).slice(0, MAX_PLOTTED),
    [selected, metrics],
  )

  /** The trailing mean is computed here so both consumers get the same arithmetic. */
  const points = useMemo(() => {
    if (!trailingAverage) return data
    const n = trailingAverage
    return data.map((row, i) => {
      const out: Record<string, string | number | null> = { ...row }
      for (const m of plotted) {
        let sum = 0, seen = 0
        for (let j = Math.max(0, i - (n - 1)); j <= i; j++) {
          const v = data[j]?.[m.key]
          // Skip nulls rather than counting them as zero — an average that silently treats
          // "no data" as "zero sales" drags the line down and looks like a real decline.
          if (typeof v === 'number' && Number.isFinite(v)) { sum += v; seen++ }
        }
        out[m.key + AVG] = seen ? sum / seen : null
      }
      return out
    })
  }, [data, plotted, trailingAverage])

  return (
    <div className="h10-am-graph">
      <button type="button" className="h10-gresize" aria-label="Drag to resize chart" onPointerDown={startResize}>
        <Equal size={16} />
      </button>

      <div className="h10-ghead">
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>

      <div className="h10-gctrl">
        <MetricPicker metrics={metrics} selected={selected} onChange={onSelectedChange} />
      </div>

      <div className="h10-glegend">
        {plotted.map((m, i) => (
          <span className="h10-gsw" key={m.key}>
            <span className="ln" style={{ borderTop: `2px solid ${SERIES_COLORS[i % SERIES_COLORS.length]}` }} />
            <span>{m.label}</span>
          </span>
        ))}
        {trailingAverage ? plotted.map((m, i) => (
          <span className="h10-gsw" key={`${m.key}avg`}>
            <span className="ln" style={{ borderTop: `2px dashed ${AVG_COLORS[i % AVG_COLORS.length]}` }} />
            <span>{m.label} · {trailingAverage}-day average</span>
          </span>
        )) : null}
        {annotationSlot}
      </div>

      {/* Said once, plainly. Without it a flat line along the bottom reads as "this metric is
          near zero" when it only means "this metric is small in its own units". */}
      {plotted.length > 1 && (
        <p className="h10-gscale">Each metric is drawn to its own scale. Hover for exact values.</p>
      )}

      <div className="h10-gchart" style={{ height }}>
        {loading ? (
          <div className="h10-gmsg">Loading…</div>
        ) : points.length === 0 || plotted.length === 0 ? (
          <div className="h10-gmsg">{emptyLabel}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 6, right: 6, bottom: 2, left: 6 }}>
              <CartesianGrid vertical={false} stroke="#eef1f5" />
              <XAxis
                dataKey="date" tickFormatter={dayShort} tickLine={false}
                axisLine={{ stroke: '#e6e9ee' }} tick={{ fontSize: 11.5, fill: '#8a93a1' }}
                interval="preserveStartEnd" minTickGap={24} padding={{ left: 8, right: 8 }}
              />
              {/* One axis per plotted metric so each keeps its own domain; the first two are
                  drawn, the rest are real axes that simply are not labelled. */}
              {plotted.map((m, i) => {
                const shown = i < 2
                return (
                  <YAxis
                    key={m.key} yAxisId={m.key} domain={[0, 'auto']}
                    orientation={i === 1 ? 'right' : 'left'}
                    hide={!shown}
                    tickFormatter={(v: number) => fmtAxis(v, m.unit)}
                    tickLine={false} axisLine={false}
                    tick={{ fontSize: 11.5, fill: SERIES_COLORS[i % SERIES_COLORS.length] }}
                    /* 🔴 `width` MUST be 0 on the hidden axes. Recharts derives the plot area's
                       left offset from the LAST left-hand axis it sees, so a hidden third metric
                       declaring width 58 reset the offset to the bare margin and drew the first
                       axis's labels 37px OUTSIDE the SVG, where they are clipped and simply
                       vanish. Measured: two metrics put the leftmost tick at x=155 and three put
                       it at x=97 against an SVG starting at 134. */
                    width={shown ? 58 : 0}
                  />
                )
              })}
              {annotations && [...annotations.values()].map((d) => (
                <ReferenceLine
                  key={d.date} yAxisId={plotted[0]?.key} x={d.date}
                  stroke={d.failed > 0 ? '#e0a52e' : '#c2cbd8'}
                  strokeDasharray="3 3" strokeWidth={1}
                />
              ))}
              <Tooltip
                content={<ChartTooltip plotted={plotted} annotations={annotations} trailingAverage={trailingAverage} />}
                cursor={{ stroke: '#c2cbd8', strokeWidth: 1 }}
                wrapperStyle={{ outline: 'none' }}
              />
              {trailingAverage ? plotted.map((m, i) => (
                <Line
                  key={`${m.key}avg`} yAxisId={m.key} dataKey={m.key + AVG}
                  stroke={AVG_COLORS[i % AVG_COLORS.length]} strokeWidth={1.6} strokeDasharray="5 4"
                  dot={false} isAnimationActive={false} connectNulls
                />
              )) : null}
              {plotted.map((m, i) => (
                <Line
                  key={m.key} yAxisId={m.key} dataKey={m.key}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2}
                  dot={false} activeDot={{ r: 3.5 }} isAnimationActive={false} connectNulls
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

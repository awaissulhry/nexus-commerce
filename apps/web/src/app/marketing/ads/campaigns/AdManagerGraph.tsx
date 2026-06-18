'use client'

/**
 * CBN.2e — Ad Manager "Campaign Performance" graph, pixel-matched to Helium 10.
 *
 * A dual-axis time-series combo chart: a LEFT metric (navy, drives the left
 * axis) and a RIGHT metric (blue, drives the right axis), each drawn as a solid
 * line plus a dashed 7-day trailing-average line — four series total. Two metric
 * pickers sit in the top corners (the metric chosen on one side is greyed out on
 * the other, so it can't be plotted twice); a centred legend sits below them; a
 * hover tooltip surfaces the date + all four series; and a drag grip resizes the
 * chart height. Account-wide data comes from GET /api/advertising/trends, scoped
 * to the header's market + date range (no campaignId = whole account).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { ChevronDown, GripHorizontal } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { rangeBounds } from '../_shell/AdsPageHeader'

// ── metric catalog (order + units match the H10 dropdown) ───────────────────
type Unit = 'eur' | 'pct' | 'count'
interface Metric { key: string; label: string; unit: Unit }
const METRICS: Metric[] = [
  { key: 'spend', label: 'Spend', unit: 'eur' },
  { key: 'sales', label: 'Sales', unit: 'eur' },
  { key: 'cpc', label: 'CPC', unit: 'eur' },
  { key: 'cvr', label: 'CVR', unit: 'pct' },
  { key: 'acos', label: 'ACoS', unit: 'pct' },
  { key: 'ctr', label: 'CTR', unit: 'pct' },
  { key: 'clicks', label: 'Clicks', unit: 'count' },
  { key: 'impressions', label: 'Impressions', unit: 'count' },
  { key: 'ppcOrders', label: 'PPC Orders', unit: 'count' },
  { key: 'totalSales', label: 'Total sales', unit: 'eur' },
  { key: 'tacos', label: 'TACoS', unit: 'pct' },
]
const META: Record<string, Metric> = Object.fromEntries(METRICS.map((m) => [m.key, m]))

// Colours sampled from the H10 recording: left axis = deep navy, right = blue;
// each side's 7-day average is a lighter dashed variant of its colour.
const LEFT_COLOR = '#002f66', LEFT_AVG = '#94a3b8'
const RIGHT_COLOR = '#0a5ed3', RIGHT_AVG = '#7fb0f5'

interface TrendRow {
  date: string; impressions: number; clicks: number; orders: number
  adSpendCents: number; adSalesCents: number; totalRevenueCents: number
  acos: number | null; tacos: number | null; ctr: number | null
}
interface ChartPoint { date: string; leftVal: number; rightVal: number; leftAvg: number; rightAvg: number }

const metricValue = (r: TrendRow, key: string): number => {
  const spend = r.adSpendCents / 100, sales = r.adSalesCents / 100
  switch (key) {
    case 'spend': return spend
    case 'sales': return sales
    case 'cpc': return r.clicks > 0 ? spend / r.clicks : 0
    case 'cvr': return r.clicks > 0 ? (r.orders / r.clicks) * 100 : 0
    case 'acos': return r.acos ?? (sales > 0 ? (spend / sales) * 100 : 0)
    case 'ctr': return r.ctr ?? (r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0)
    case 'clicks': return r.clicks
    case 'impressions': return r.impressions
    case 'ppcOrders': return r.orders
    case 'totalSales': return r.totalRevenueCents / 100
    case 'tacos': return r.tacos ?? 0
    default: return 0
  }
}

// ── formatters ──────────────────────────────────────────────────────────────
const eurFull = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtFull = (v: number, u: Unit): string =>
  u === 'eur' ? eurFull(v) : u === 'pct' ? `${v.toFixed(2)}%` : v.toLocaleString('en-IE')
const fmtAxis = (v: number, u: Unit): string => {
  if (u === 'pct') return `${+v.toFixed(2)}%`
  if (u === 'eur') return v >= 1000 ? `€${(v / 1000).toFixed(1)}k` : v >= 10 ? `€${v.toFixed(0)}` : `€${v.toFixed(2)}`
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`
}
const dayShort = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const dayLong = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Build the four-series chart frame from raw daily rows: each metric value plus
// its trailing 7-day mean (inclusive of the current day).
function buildPoints(rows: TrendRow[], leftKey: string, rightKey: string): ChartPoint[] {
  const lv = rows.map((r) => metricValue(r, leftKey))
  const rv = rows.map((r) => metricValue(r, rightKey))
  const trailing = (arr: number[], i: number) => {
    let sum = 0, n = 0
    for (let j = Math.max(0, i - 6); j <= i; j++) { sum += arr[j] ?? 0; n++ }
    return n ? sum / n : 0
  }
  return rows.map((r, i) => ({
    date: r.date, leftVal: lv[i] ?? 0, rightVal: rv[i] ?? 0,
    leftAvg: trailing(lv, i), rightAvg: trailing(rv, i),
  }))
}

// ── metric picker (single-select, colour dot, other-side metric disabled) ────
function MetricSelect({ value, otherValue, onChange, color, align }: {
  value: string; otherValue: string; onChange: (k: string) => void; color: string; align: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const cur = META[value]
  return (
    <div className={`h10-gsel ${align} ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="h10-gsel-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label="Select metric">
        <span className="dot" style={{ background: color }} />
        <span className="lb">{cur?.label ?? value}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="h10-gsel-pop" role="listbox">
          {METRICS.map((m) => {
            const disabled = m.key === otherValue
            return (
              <button
                type="button" key={m.key} role="option" aria-selected={m.key === value}
                className={`${m.key === value ? 'sel' : ''} ${disabled ? 'dis' : ''}`}
                disabled={disabled}
                onClick={() => { if (!disabled) { onChange(m.key); setOpen(false) } }}
              >{m.label}</button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── legend swatch (solid for the metric, dashed for its 7-day average) ───────
function Swatch({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="h10-gsw">
      <span className="ln" style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }} />
      <span>{label}</span>
    </span>
  )
}

// ── hover tooltip (date header + four series, values right-aligned) ──────────
function GraphTooltip({ active, payload, leftKey, rightKey }: {
  active?: boolean; payload?: Array<{ payload: ChartPoint }>; leftKey?: string; rightKey?: string
}) {
  if (!active || !payload?.length || !leftKey || !rightKey) return null
  const p = payload[0]?.payload
  if (!p) return null
  const L = META[leftKey], R = META[rightKey]
  const rows = [
    { c: LEFT_COLOR, name: L?.label ?? leftKey, v: fmtFull(p.leftVal, L?.unit ?? 'count') },
    { c: LEFT_AVG, name: `${L?.label ?? leftKey} 7-Day Average`, v: fmtFull(p.leftAvg, L?.unit ?? 'count') },
    { c: RIGHT_COLOR, name: R?.label ?? rightKey, v: fmtFull(p.rightVal, R?.unit ?? 'count') },
    { c: RIGHT_AVG, name: `${R?.label ?? rightKey} 7-Day Average`, v: fmtFull(p.rightAvg, R?.unit ?? 'count') },
  ]
  return (
    <div className="h10-gtt">
      <div className="h10-gtt-d">{dayLong(p.date)}</div>
      {rows.map((it) => (
        <div className="h10-gtt-r" key={it.name}>
          <span className="dot" style={{ background: it.c }} />
          <span className="nm">{it.name}</span>
          <span className="v">{it.v}</span>
        </div>
      ))}
    </div>
  )
}

// ── main panel ───────────────────────────────────────────────────────────────
export function AdManagerGraph({ market, rangePreset }: { market: string; rangePreset: string }) {
  const [leftKey, setLeftKey] = useState('spend')
  const [rightKey, setRightKey] = useState('acos')
  const [rows, setRows] = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [height, setHeight] = useState(300)

  // restore persisted metric choices + chart height
  useEffect(() => {
    try {
      const l = localStorage.getItem('h10-am-graph-left'); if (l && META[l]) setLeftKey(l)
      const r = localStorage.getItem('h10-am-graph-right'); if (r && META[r]) setRightKey(r)
      const h = Number(localStorage.getItem('h10-am-graph-h')); if (h >= 220 && h <= 640) setHeight(h)
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { try { localStorage.setItem('h10-am-graph-h', String(height)) } catch { /* ignore */ } }, [height])

  const pickLeft = (k: string) => { if (k === rightKey) return; setLeftKey(k); try { localStorage.setItem('h10-am-graph-left', k) } catch { /* ignore */ } }
  const pickRight = (k: string) => { if (k === leftKey) return; setRightKey(k); try { localStorage.setItem('h10-am-graph-right', k) } catch { /* ignore */ } }

  const { start, end } = useMemo(() => rangeBounds(rangePreset), [rangePreset])
  const startStr = ymd(start), endStr = ymd(end)

  useEffect(() => {
    let abort = false
    setLoading(true)
    const params = new URLSearchParams({ startDate: startStr, endDate: endStr })
    if (market !== 'all') params.set('marketplace', market)
    fetch(`${getBackendUrl()}/api/advertising/trends?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!abort) setRows((d?.rows ?? []) as TrendRow[]) })
      .catch(() => { if (!abort) setRows([]) })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [market, startStr, endStr])

  const data = useMemo(() => buildPoints(rows, leftKey, rightKey), [rows, leftKey, rightKey])
  const L = META[leftKey], R = META[rightKey]
  const subtitle = `${dayLong(startStr)} - ${dayLong(endStr)}`

  // drag-to-resize grip (top-centre, matching H10's card grip position)
  const heightRef = useRef(height); heightRef.current = height
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY, h0 = heightRef.current
    const move = (ev: PointerEvent) => setHeight(clamp(h0 + (ev.clientY - y0), 220, 640))
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }, [])

  return (
    <div className="h10-am-graph">
      <button type="button" className="h10-gresize" aria-label="Drag to resize graph" onPointerDown={startResize}>
        <GripHorizontal size={16} />
      </button>

      <div className="h10-ghead">
        <h3>Campaign Performance</h3>
        <p>{subtitle}</p>
      </div>

      <div className="h10-gctrl">
        <MetricSelect value={leftKey} otherValue={rightKey} onChange={pickLeft} color={LEFT_COLOR} align="left" />
        <MetricSelect value={rightKey} otherValue={leftKey} onChange={pickRight} color={RIGHT_COLOR} align="right" />
      </div>

      <div className="h10-glegend">
        <Swatch color={LEFT_COLOR} label={L?.label ?? leftKey} />
        <Swatch color={LEFT_AVG} label={`${L?.label ?? leftKey} 7-Day Average`} dashed />
        <Swatch color={RIGHT_COLOR} label={R?.label ?? rightKey} />
        <Swatch color={RIGHT_AVG} label={`${R?.label ?? rightKey} 7-Day Average`} dashed />
      </div>

      <div className="h10-gchart" style={{ height }}>
        {loading ? (
          <div className="h10-gmsg">Loading…</div>
        ) : data.length === 0 ? (
          <div className="h10-gmsg">No advertising data in this date range.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 6, right: 6, bottom: 2, left: 6 }}>
              <CartesianGrid vertical={false} stroke="#eef1f5" />
              <XAxis
                dataKey="date" tickFormatter={dayShort} tickLine={false}
                axisLine={{ stroke: '#e6e9ee' }} tick={{ fontSize: 11.5, fill: '#8a93a1' }}
                interval="preserveStartEnd" minTickGap={24} padding={{ left: 8, right: 8 }}
              />
              <YAxis
                yAxisId="left" domain={[0, 'auto']} tickFormatter={(v: number) => fmtAxis(v, L?.unit ?? 'count')}
                tickLine={false} axisLine={false} tick={{ fontSize: 11.5, fill: '#6b7480' }} width={58}
              />
              <YAxis
                yAxisId="right" orientation="right" domain={[0, 'auto']} tickFormatter={(v: number) => fmtAxis(v, R?.unit ?? 'count')}
                tickLine={false} axisLine={false} tick={{ fontSize: 11.5, fill: '#6b7480' }} width={58}
              />
              <Tooltip
                content={<GraphTooltip leftKey={leftKey} rightKey={rightKey} />}
                cursor={{ stroke: '#c2cbd8', strokeWidth: 1 }}
                wrapperStyle={{ outline: 'none' }}
              />
              <Line yAxisId="left" dataKey="leftVal" stroke={LEFT_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} isAnimationActive={false} />
              <Line yAxisId="left" dataKey="leftAvg" stroke={LEFT_AVG} strokeWidth={1.6} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              <Line yAxisId="right" dataKey="rightVal" stroke={RIGHT_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} isAnimationActive={false} />
              <Line yAxisId="right" dataKey="rightAvg" stroke={RIGHT_AVG} strokeWidth={1.6} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

'use client'

/**
 * DaypartingChart — the chart view of the Dayparting Schedule Criteria (the toggle alternative
 * to the heatmap), pixel-matched to Helium 10 Ads. An SVG area+line chart of up to two metrics
 * over Hour of Day (24 buckets) or Day of Week (7 buckets), filtered by Days of Week Included.
 * Decoupled from the data source — parent passes `cells` (the same multi-campaign /dayparting
 * aggregation the heatmap consumes, carrying both metric values per dow×hour).
 *
 * Series colours mirror the shell's Metric pickers: Metric 1 navy #0b2447, Metric 2 blue #1f6fde.
 */
import { useMemo, useState } from 'react'
import './dayparting.css'

export interface ChartCell { dow: number; hour: number; m1: number; m2: number } // dow 0=Sun..6=Sat
export type ChartUnit = 'eur' | 'pct' | 'int'
type GroupBy = 'hour' | 'weekday'
type DaysFilter = 'all' | 'weekdays' | 'weekends'

const M1 = '#0b2447', M2 = '#1f6fde'
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon-first
const hourLabel = (h: number) => (h === 0 ? '12AM' : h < 12 ? String(h).padStart(2, '0') : h === 12 ? '12PM' : String(h - 12).padStart(2, '0'))
const fmt = (v: number, u: ChartUnit) => (u === 'eur' ? `€${v.toFixed(v >= 100 ? 0 : 2)}` : u === 'pct' ? `${v.toFixed(1)}%` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))
const inFilter = (dow: number, f: DaysFilter) => f === 'all' ? true : f === 'weekdays' ? dow >= 1 && dow <= 5 : dow === 0 || dow === 6

// build an SVG area+line path from normalized points
const W = 880, H = 220, PADL = 8, PADR = 8, PADT = 14, PADB = 26
const xAt = (i: number, n: number) => PADL + (n <= 1 ? (W - PADL - PADR) / 2 : (i * (W - PADL - PADR)) / (n - 1))
const yAt = (v: number, max: number) => PADT + (H - PADT - PADB) * (1 - (max > 0 ? v / max : 0))
const linePath = (vals: number[], max: number) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i, vals.length).toFixed(1)} ${yAt(v, max).toFixed(1)}`).join(' ')
const areaPath = (vals: number[], max: number) => `${linePath(vals, max)} L ${xAt(vals.length - 1, vals.length).toFixed(1)} ${H - PADB} L ${xAt(0, vals.length).toFixed(1)} ${H - PADB} Z`

export function DaypartingChart({ cells, metric1, metric2, unit1 = 'eur', unit2 = 'pct', groupBy = 'hour', daysFilter = 'all', loading = false }: {
  cells: ChartCell[]
  metric1: string; metric2: string
  unit1?: ChartUnit; unit2?: ChartUnit
  groupBy?: GroupBy; daysFilter?: DaysFilter
  loading?: boolean
}) {
  const [hi, setHi] = useState<number | null>(null)

  const { labels, s1, s2 } = useMemo(() => {
    const keys = groupBy === 'hour' ? Array.from({ length: 24 }, (_, h) => h) : WD_ORDER
    const a1 = keys.map(() => 0), a2 = keys.map(() => 0)
    for (const c of cells) {
      if (!inFilter(c.dow, daysFilter)) continue
      const idx = groupBy === 'hour' ? c.hour : WD_ORDER.indexOf(c.dow)
      if (idx < 0) continue
      a1[idx] += c.m1; a2[idx] += c.m2
    }
    return { labels: keys.map((k) => (groupBy === 'hour' ? hourLabel(k as number) : WD[k as number])), s1: a1, s2: a2 }
  }, [cells, groupBy, daysFilter])

  if (loading) return <div className="h10-dp-heat loading"><div className="h10-dp-skel" /></div>

  const max1 = Math.max(1, ...s1), max2 = Math.max(1, ...s2)
  const n = labels.length
  // X-axis ticks: every hour for weekday, every 2nd for hour-of-day to avoid crowding
  const tickEvery = groupBy === 'hour' ? 2 : 1

  return (
    <div className="h10-dp-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric1} and ${metric2} by ${groupBy === 'hour' ? 'hour of day' : 'day of week'}`} preserveAspectRatio="none" onMouseLeave={() => setHi(null)}>
        <defs>
          <linearGradient id="dpFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={M2} stopOpacity="0.18" />
            <stop offset="100%" stopColor={M2} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={PADL} y1={PADT + (H - PADT - PADB) * g} x2={W - PADR} y2={PADT + (H - PADT - PADB) * g} stroke="#eef1f5" strokeWidth="1" />)}
        {/* Metric 1 area+line (navy) */}
        <path d={areaPath(s1, max1)} fill="url(#dpFill)" />
        <path d={linePath(s1, max1)} fill="none" stroke={M1} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        {/* Metric 2 line (blue, scaled to its own max) */}
        <path d={linePath(s2, max2)} fill="none" stroke={M2} strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" strokeLinecap="round" />
        {/* hover hit-areas + markers */}
        {labels.map((_, i) => (
          <rect key={i} x={xAt(i, n) - (W / n) / 2} y={0} width={W / n} height={H - PADB} fill="transparent" onMouseEnter={() => setHi(i)} />
        ))}
        {hi != null && (<>
          <line x1={xAt(hi, n)} y1={PADT} x2={xAt(hi, n)} y2={H - PADB} stroke="#c8cfd9" strokeWidth="1" />
          <circle cx={xAt(hi, n)} cy={yAt(s1[hi], max1)} r="3.5" fill={M1} />
          <circle cx={xAt(hi, n)} cy={yAt(s2[hi], max2)} r="3.5" fill={M2} />
        </>)}
        {/* x labels */}
        {labels.map((l, i) => (i % tickEvery === 0 ? <text key={i} x={xAt(i, n)} y={H - 8} textAnchor="middle" fontSize="9" fill="#8a93a1">{l}</text> : null))}
      </svg>
      {hi != null && (
        <div className="h10-dp-ctip">
          <b>{labels[hi]}</b>
          <span><i style={{ background: M1 }} />{metric1}: {fmt(s1[hi], unit1)}</span>
          <span><i style={{ background: M2 }} />{metric2}: {fmt(s2[hi], unit2)}</span>
        </div>
      )}
      <div className="h10-dp-chart-legend">
        <span><i style={{ background: M1 }} />{metric1}</span>
        <span><i style={{ background: M2 }} className="dashed" />{metric2}</span>
      </div>
    </div>
  )
}

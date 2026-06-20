'use client'

/**
 * DaypartingHeatmap — the 7-day × 24-hour performance heatmap for the Dayparting Schedule
 * Criteria, pixel-matched to Helium 10 Ads. Rows MON–SUN, columns 12AM–11PM; each cell is
 * colour-scaled by the selected metric over the chosen period, with a 6-step blue legend and
 * a hover tooltip ("Tuesday, 09:00 AM" + value). Decoupled from the data source — the parent
 * passes `cells` (the multi-campaign /dayparting aggregation), so this renders identically
 * whether fed live data, a preview, or a test harness.
 *
 * Colours sampled from the recording legend at native res:
 *   >0 #f2f9fb · >1 #cae8fc · >2 #50a8fc · >3 #0562e1 · >4 #0048ab · >5 #002e65
 */
import { useMemo, useState } from 'react'
import './dayparting.css'

export interface HeatCell { dow: number; hour: number; value: number } // dow 0=Sun..6=Sat
export type MetricUnit = 'eur' | 'pct' | 'int'

const SCALE = ['#f2f9fb', '#cae8fc', '#50a8fc', '#0562e1', '#0048ab', '#002e65']
// MON-first display order mapped to Postgres DOW (0=Sun..6=Sat)
const ROWS = [
  { dow: 1, short: 'MON', label: 'Monday' }, { dow: 2, short: 'TUE', label: 'Tuesday' },
  { dow: 3, short: 'WED', label: 'Wednesday' }, { dow: 4, short: 'THU', label: 'Thursday' },
  { dow: 5, short: 'FRI', label: 'Friday' }, { dow: 6, short: 'SAT', label: 'Saturday' },
  { dow: 0, short: 'SUN', label: 'Sunday' },
]
const hourLabel = (h: number) => (h === 0 ? '12AM' : h < 12 ? String(h).padStart(2, '0') : h === 12 ? '12PM' : String(h - 12).padStart(2, '0'))
const hourClock = (h: number) => { const ampm = h < 12 ? 'AM' : 'PM'; const hh = h === 0 ? 12 : h <= 12 ? h : h - 12; return `${String(hh).padStart(2, '0')}:00 ${ampm}` }

const fmt = (v: number, unit: MetricUnit): string =>
  unit === 'eur' ? `€${v.toFixed(v >= 100 ? 0 : 2)}` : unit === 'pct' ? `${v.toFixed(1)}%` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))

// cell text stays legible on dark fills
const cellText = (bucket: number) => (bucket >= 3 ? '#fff' : '#1c2530')

export function DaypartingHeatmap({ cells, unit = 'eur', loading = false, thresholds }: {
  cells: HeatCell[]
  unit?: MetricUnit
  loading?: boolean
  /** 5 ascending bucket boundaries (b1..b5); value < b1 → palest, ≥ b5 → darkest. Defaults to data quantiles. */
  thresholds?: [number, number, number, number, number]
}) {
  const [hover, setHover] = useState<{ dow: number; hour: number; x: number; y: number } | null>(null)
  const lookup = useMemo(() => { const m = new Map<string, number>(); for (const c of cells) m.set(`${c.dow}:${c.hour}`, c.value); return m }, [cells])

  // bucket boundaries: explicit, else 5 evenly-spaced steps up to the max non-zero value
  const bounds = useMemo<[number, number, number, number, number]>(() => {
    if (thresholds) return thresholds
    const max = cells.reduce((m, c) => Math.max(m, c.value), 0)
    if (max <= 0) return [1, 2, 3, 4, 5]
    return [1, 2, 3, 4, 5].map((i) => Math.round((max * i / 5) * 100) / 100) as [number, number, number, number, number]
  }, [cells, thresholds])
  const bucketOf = (v: number) => (v <= 0 ? 0 : v < bounds[0] ? 0 : v < bounds[1] ? 1 : v < bounds[2] ? 2 : v < bounds[3] ? 3 : v < bounds[4] ? 4 : 5)

  if (loading) return <div className="h10-dp-heat loading"><div className="h10-dp-skel" /></div>

  const hv = hover ? lookup.get(`${hover.dow}:${hover.hour}`) ?? 0 : 0
  const hLabel = hover ? ROWS.find((r) => r.dow === hover.dow)?.label : ''

  return (
    <div className="h10-dp-heat">
      <div className="h10-dp-grid" role="img" aria-label="Performance by day of week and hour of day">
        {ROWS.map((r) => (
          <div className="h10-dp-row" key={r.dow}>
            <span className="h10-dp-daylbl">{r.short}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = lookup.get(`${r.dow}:${h}`) ?? 0
              const b = bucketOf(v)
              return (
                <span
                  key={h}
                  className="h10-dp-cell"
                  style={{ background: SCALE[b], color: cellText(b) }}
                  onMouseEnter={(e) => setHover({ dow: r.dow, hour: h, x: e.currentTarget.offsetLeft, y: e.currentTarget.offsetTop })}
                  onMouseLeave={() => setHover(null)}
                >{v > 0 ? fmt(v, unit) : 0}</span>
              )
            })}
          </div>
        ))}
        {hover && (
          <div className="h10-dp-tip" style={{ left: hover.x, top: hover.y }} role="tooltip">
            <b>{hLabel}, {hourClock(hover.hour)}</b><span>{fmt(hv, unit)}</span>
          </div>
        )}
      </div>
      <div className="h10-dp-hours">
        <span className="sp" />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="h10-dp-hr">{hourLabel(h)}</span>)}
      </div>
      <div className="h10-dp-legend">
        <span className="sp" />
        <span className="bar">{SCALE.map((c, i) => <span key={i} style={{ background: c }} />)}</span>
      </div>
      <div className="h10-dp-legend-lbls">
        <span className="sp" />
        {[0, ...bounds].map((b, i) => <span key={i} className="lbl">&gt;{fmt(b, unit)}</span>)}
      </div>
    </div>
  )
}

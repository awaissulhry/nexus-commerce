'use client'

/**
 * RGD.3 — readable day×hour demand heatmap (H10-reskinned from the ads-console RD.10e readout).
 * Bigger cells, a stepped high-contrast scale + legend, the per-row peak ringed, plus marginal
 * totals — a bar per day down the right, a bar per hour along the bottom. Darker = more sales that
 * hour. Non-EUR markets weight by order count, not €.
 */
import { useMemo } from 'react'

export interface DemandCell { revenueCents: number; orders: number; units?: number; familyOrders?: number; confidence?: 'high' | 'med' | 'low' }
export interface DemandProfile { key: number; orders: number; units: number; revenueCents: number; index: number | null }

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const hh = (h: number) => String(h).padStart(2, '0')
const eur = (c: number) => `€${(c / 100).toFixed(0)}`
const bucket = (v: number, max: number): number => { if (v <= 0 || max <= 0) return 0; const r = v / max; return r < 0.12 ? 1 : r < 0.3 ? 2 : r < 0.6 ? 3 : 4 }

export function DemandReadout({ grid, hourProfile, weekdayProfile, timezone, metric }: { grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[]; timezone?: string; metric?: 'revenue' | 'orders' }) {
  const byOrders = metric === 'orders'
  const cv = (c: DemandCell) => (byOrders ? (c.orders ?? 0) : c.revenueCents)
  const pv = (p: DemandProfile) => (byOrders ? p.orders : p.revenueCents)
  const fmt = (v: number) => (byOrders ? `${v} orders` : eur(v))
  const tz = timezone ?? 'Europe/Rome'
  const cellMax = useMemo(() => Math.max(1, ...grid.flat().map(cv)), [grid, byOrders]) // eslint-disable-line react-hooks/exhaustive-deps
  const hMax = useMemo(() => Math.max(1, ...hourProfile.map(pv)), [hourProfile, byOrders]) // eslint-disable-line react-hooks/exhaustive-deps
  const wMax = useMemo(() => Math.max(1, ...weekdayProfile.map(pv)), [weekdayProfile, byOrders]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!grid || grid.length !== 7) return null

  return (
    <div className="h10-hm2">
      <div className="h10-hm2-hd">
        <span className="ttl">When the family sells · day × hour <span className="tz">({tz}{byOrders ? ' · by orders' : ''})</span></span>
        <span className="grow" />
        <span className="h10-hm2-legend">less <i className="L0" /><i className="L1" /><i className="L2" /><i className="L3" /><i className="L4" /> more</span>
      </div>

      <div className="h10-hm2-grid">
        <div className="h10-hm2-row head">
          <div className="h10-hm2-dlbl" />
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="h10-hm2-hh">{h % 2 === 0 ? hh(h) : ''}</div>)}
          <div className="h10-hm2-tot head">day</div>
        </div>

        {DOW_ORDER.map((d) => {
          const row = grid[d] ?? []
          const peakH = row.reduce((bi, c, i, arr) => (cv(c) > (arr[bi] ? cv(arr[bi]) : 0) ? i : bi), 0)
          const hasPeak = (row[peakH] ? cv(row[peakH]) : 0) > 0
          const w = weekdayProfile[d]
          return (
            <div key={d} className="h10-hm2-row">
              <div className="h10-hm2-dlbl">{DOW_LABEL[d]}</div>
              {row.map((c, h) => (
                <div key={h} className={`h10-hm2-cell L${bucket(cv(c), cellMax)}${h === peakH && hasPeak ? ' peak' : ''}`}
                  title={`${DOW_LABEL[d]} ${hh(h)}:00 — ${fmt(cv(c))}${byOrders ? '' : ` · ${c.orders} orders`}${c.confidence ? ` · ${c.confidence} confidence` : ''}`} />
              ))}
              <div className="h10-hm2-tot" title={`${DOW_LABEL[d]} total — ${fmt(w ? pv(w) : 0)}`}><span className="b" style={{ width: `${Math.max(3, ((w ? pv(w) : 0) / wMax) * 100)}%` }} /></div>
            </div>
          )
        })}

        <div className="h10-hm2-row foot">
          <div className="h10-hm2-dlbl">all</div>
          {hourProfile.map((h) => (
            <div key={h.key} className="h10-hm2-hbar" title={`${hh(h.key)}:00 — ${fmt(pv(h))}${byOrders ? '' : ` · ${h.orders} orders`}`}><span style={{ height: `${Math.max(4, (pv(h) / hMax) * 100)}%` }} className={h.index != null && h.index >= 1.2 ? 'peak' : ''} /></div>
          ))}
          <div className="h10-hm2-tot" />
        </div>
      </div>
      <div className="h10-hm2-note">Darker cell = more sales that hour. Right column = each day&apos;s total; bottom bars = each hour&apos;s total across the week (green = busiest hours). Hover for exact figures.</div>
    </div>
  )
}

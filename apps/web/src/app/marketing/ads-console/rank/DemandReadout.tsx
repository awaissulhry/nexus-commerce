'use client'

/**
 * RD.10e — readable day×hour demand heatmap.
 *
 * The grid form (back by request), rebuilt for legibility: bigger cells, a stepped
 * high-contrast colour scale with a legend, clear hour/day labels, the per-row peak
 * ringed, AND marginal totals — a bar per day down the right, a bar per hour along
 * the bottom — so "which hours/days are busy" reads at a glance while the day×hour
 * detail stays in the grid. Darker = more sales that hour (Europe/Rome).
 */

import { useMemo } from 'react'

export interface DemandCell { revenueCents: number; orders: number; units?: number; familyOrders?: number; confidence?: 'high' | 'med' | 'low' }
export interface DemandProfile { key: number; orders: number; units: number; revenueCents: number; index: number | null }

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const hh = (h: number) => String(h).padStart(2, '0')
const eur = (c: number) => `€${(c / 100).toFixed(0)}`
// Stepped 0–4 bucket with tuned thresholds so the busy cells stand out clearly.
const bucket = (v: number, max: number): number => { if (v <= 0 || max <= 0) return 0; const r = v / max; return r < 0.12 ? 1 : r < 0.3 ? 2 : r < 0.6 ? 3 : 4 }

export function DemandReadout({ grid, hourProfile, weekdayProfile }: { grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[] }) {
  const cellMax = useMemo(() => Math.max(1, ...grid.flat().map((c) => c.revenueCents)), [grid])
  const hMax = useMemo(() => Math.max(1, ...hourProfile.map((h) => h.revenueCents)), [hourProfile])
  const wMax = useMemo(() => Math.max(1, ...weekdayProfile.map((w) => w.revenueCents)), [weekdayProfile])
  if (!grid || grid.length !== 7) return null

  return (
    <div className="az-hm2">
      <div className="az-hm2-hd">
        <span className="ttl">When the family sells · day × hour <span className="tz">(Europe/Rome)</span></span>
        <span className="grow" />
        <span className="az-hm2-legend">less <i className="L0" /><i className="L1" /><i className="L2" /><i className="L3" /><i className="L4" /> more</span>
      </div>

      <div className="az-hm2-grid">
        {/* hour header */}
        <div className="az-hm2-row head">
          <div className="az-hm2-dlbl" />
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="az-hm2-hh">{h % 2 === 0 ? hh(h) : ''}</div>)}
          <div className="az-hm2-tot head">day</div>
        </div>

        {/* one row per day (Mon→Sun) */}
        {DOW_ORDER.map((d) => {
          const row = grid[d] ?? []
          const peakH = row.reduce((bi, c, i, arr) => (c.revenueCents > (arr[bi]?.revenueCents ?? 0) ? i : bi), 0)
          const hasPeak = (row[peakH]?.revenueCents ?? 0) > 0
          const w = weekdayProfile[d]
          return (
            <div key={d} className="az-hm2-row">
              <div className="az-hm2-dlbl">{DOW_LABEL[d]}</div>
              {row.map((c, h) => (
                <div key={h} className={`az-hm2-cell L${bucket(c.revenueCents, cellMax)}${h === peakH && hasPeak ? ' peak' : ''}`}
                  title={`${DOW_LABEL[d]} ${hh(h)}:00 — ${eur(c.revenueCents)} · ${c.orders} orders${c.confidence ? ` · ${c.confidence} confidence` : ''}`} />
              ))}
              <div className="az-hm2-tot" title={`${DOW_LABEL[d]} total — ${eur(w?.revenueCents ?? 0)}`}><span className="b" style={{ width: `${Math.max(3, ((w?.revenueCents ?? 0) / wMax) * 100)}%` }} /></div>
            </div>
          )
        })}

        {/* hour-of-day totals along the bottom */}
        <div className="az-hm2-row foot">
          <div className="az-hm2-dlbl">all</div>
          {hourProfile.map((h) => (
            <div key={h.key} className="az-hm2-hbar" title={`${hh(h.key)}:00 — ${eur(h.revenueCents)} · ${h.orders} orders`}><span style={{ height: `${Math.max(4, (h.revenueCents / hMax) * 100)}%` }} className={h.index != null && h.index >= 1.2 ? 'peak' : ''} /></div>
          ))}
          <div className="az-hm2-tot" />
        </div>
      </div>
      <div className="az-hm2-note">Darker cell = more sales that hour. Right column = each day&apos;s total; bottom bars = each hour&apos;s total across the week (green = busiest hours). Hover for exact figures.</div>
    </div>
  )
}

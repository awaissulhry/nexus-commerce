'use client'

/**
 * RC2.DD2 — per-day demand heatmap. A 7×24 grid (rows = days Mon→Sun, cols =
 * hours, Europe/Rome) coloured by the family's sales intensity per hour, so you
 * can see how the hours differ across days. Each day's peak hour is ringed; hover
 * shows real orders + confidence. Data is the DD1 market-blended demand, so even
 * sparse products show a trustworthy shape.
 */

import { useMemo } from 'react'

export interface HeatCell { orders: number; units: number; revenueCents: number; familyOrders?: number; confidence?: 'high' | 'med' | 'low' }
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const pad2 = (n: number) => String(n).padStart(2, '0')
const eur = (c: number) => `€${(c / 100).toFixed(0)}`

export function DemandHeatmap({ grid }: { grid: HeatCell[][] | null }) {
  const max = useMemo(() => (grid ? Math.max(1, ...grid.flat().map(c => c.revenueCents)) : 1), [grid])
  if (!grid || grid.length !== 7) return null
  return (
    <div className="az-heat" role="img" aria-label="Family demand heatmap by day and hour">
      <div className="az-heat-row head">
        <div className="az-heat-dlbl" />
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="az-heat-hh">{h % 3 === 0 ? pad2(h) : ''}</div>)}
      </div>
      {DOW_ORDER.map(d => {
        const row = grid[d]
        const peakH = row.reduce((bi, c, i, arr) => (c.revenueCents > arr[bi].revenueCents ? i : bi), 0)
        const hasPeak = row[peakH]?.revenueCents > 0
        return (
          <div key={d} className="az-heat-row">
            <div className="az-heat-dlbl">{DOW_LABEL[d]}</div>
            {row.map((c, h) => (
              <div
                key={h}
                className={`az-heat-cell ${h === peakH && hasPeak ? 'peak' : ''}`}
                style={{ background: `rgba(31,111,235,${Math.max(0.04, c.revenueCents / max)})` }}
                title={`${DOW_LABEL[d]} ${pad2(h)}:00 — ${c.orders} orders · ${eur(c.revenueCents)}${c.familyOrders != null ? ` · ${c.confidence} confidence (${c.familyOrders} real)` : ''}`}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

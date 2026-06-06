'use client'

/**
 * RD.10d — readable demand readout for rank decisions.
 *
 * The 7×24 micro-heatmap was hard to read. Since you set rank windows BY HOUR, the
 * decision view is an hour-of-day demand curve (24 bars) with the busy hours called
 * out in plain language, plus a day-of-week strip. Peak hours (≥1.2× the daily mean)
 * are the ones worth holding the top slot in; quiet hours (<0.6×) you can ease off.
 */

import { useMemo } from 'react'

export interface DemandProfile { key: number; orders: number; units: number; revenueCents: number; index: number | null }

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const hh = (h: number) => `${String(h).padStart(2, '0')}`
const eur = (c: number) => `€${(c / 100).toFixed(0)}`
const tone = (idx: number | null) => (idx == null ? '' : idx >= 1.2 ? 'peak' : idx < 0.6 ? 'low' : 'mid')

// Plain-language busiest span from the peak hours (≥1.2×). Handles the common
// contiguous evening peak; if it wraps oddly, just show min–max.
function peakLabel(hours: DemandProfile[]): string {
  const peaks = hours.filter((h) => h.index != null && h.index >= 1.2).map((h) => h.key).sort((a, b) => a - b)
  if (peaks.length === 0) return 'no clear peak'
  return `${hh(peaks[0])}:00–${hh((peaks[peaks.length - 1] + 1) % 24)}:00`
}

export function DemandReadout({ hourProfile, weekdayProfile }: { hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[] }) {
  const hMax = useMemo(() => Math.max(1, ...hourProfile.map((h) => h.revenueCents)), [hourProfile])
  const wMax = useMemo(() => Math.max(1, ...weekdayProfile.map((w) => w.revenueCents)), [weekdayProfile])
  if (!hourProfile?.length) return null
  const busiest = peakLabel(hourProfile)

  return (
    <div className="az-dr2">
      <div className="az-dr2-hd">
        <span className="ttl">Sales by hour of day <span className="tz">· Europe/Rome</span></span>
        <span className="grow" />
        <span className="az-dr2-key"><i className="peak" /> busy <i className="mid" /> normal <i className="low" /> quiet</span>
      </div>
      <div className="az-dr2-bars">
        {hourProfile.map((h) => (
          <div key={h.key} className="az-dr2-col" title={`${hh(h.key)}:00 — ${eur(h.revenueCents)} · ${h.orders} orders${h.index != null ? ` · ${h.index.toFixed(1)}× the daily average` : ''}`}>
            <div className="wrap"><div className={`bar ${tone(h.index)}`} style={{ height: `${Math.max(3, (h.revenueCents / hMax) * 100)}%` }} /></div>
            <div className="hlbl">{h.key % 3 === 0 ? hh(h.key) : ''}</div>
          </div>
        ))}
      </div>
      <div className="az-dr2-callout">Busiest hours: <b>{busiest}</b> — best place to hold the top slot.</div>

      <div className="az-dr2-week">
        <span className="wlead">By day</span>
        {DOW_ORDER.map((d) => {
          const w = weekdayProfile[d]
          if (!w) return null
          return (
            <div key={d} className="az-dr2-wcol" title={`${DOW_LABEL[d]} — ${eur(w.revenueCents)} · ${w.orders} orders${w.index != null ? ` · ${w.index.toFixed(1)}×` : ''}`}>
              <div className="wwrap"><div className={`wbar ${tone(w.index)}`} style={{ height: `${Math.max(6, (w.revenueCents / wMax) * 100)}%` }} /></div>
              <div className="wlbl">{DOW_LABEL[d][0]}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

'use client'

/**
 * U8 — "Hourly Campaign Performance", finally reading the data.
 *
 * 🔴 **This card was a CONSTANT.** `SchedulesSection.tsx` rendered
 * "Hourly data is not available for this marketplace." unconditionally, never called an endpoint,
 * and its two metric pickers changed nothing — the [[reference_fleet_stale_constant_class]] shape
 * exactly, and a defect the RA notes have carried since the tab was first built. Measured on prod
 * 2026-08-18: `GET /advertising/budget-schedules/hourly-performance` answers **200 with
 * `hasData: true`** and 24 hourly buckets (spend · sales · orders · clicks · impressions · acos,
 * Europe/Rome). H10's own account genuinely has no hourly data for its marketplace and shows that
 * sentence honestly; ours has 17,963 rows, so showing it here was simply false.
 *
 * The chart is two series on two axes, H10's shape: Metric 1 (navy, left) and Metric 2 (blue,
 * right), 24 columns 12AM…11PM. Drawn as inline SVG rather than a chart library — this is 24
 * points and the section already refuses new dependencies.
 *
 * The empty state is kept for the case it was written for: if `hasData` is false, the marketplace
 * really has no hourly data and the sentence is true.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export interface HourPoint {
  hour: number
  spend: number
  sales: number
  orders: number
  clicks: number
  impressions: number
  acos: number
}

/** The metric names the picker offers → the key this endpoint returns. */
const METRIC_KEY: Record<string, keyof HourPoint | null> = {
  Spend: 'spend', Sales: 'sales', Orders: 'orders', Clicks: 'clicks',
  Impressions: 'impressions', ACoS: 'acos',
  // Offered by the shared picker but not returned by this endpoint. Naming them here — rather than
  // silently plotting zero — is what lets the card say so.
  CPC: null, CTR: null, CVR: null, ROAS: null, CPA: null,
}
const isMoney = (m: string) => m === 'Spend' || m === 'Sales'
const isPct = (m: string) => m === 'ACoS'

const fmt = (m: string, v: number) =>
  isMoney(m) ? `€${v.toLocaleString('en-IE', { maximumFractionDigits: 0 })}`
  : isPct(m) ? `${v.toFixed(0)}%`
  : v.toLocaleString('en-IE', { maximumFractionDigits: 0 })

const hourLabel = (h: number) => (h === 0 ? '12AM' : h === 12 ? '12PM' : h < 12 ? `${h}AM` : `${h - 12}PM`)

export function HourlyPerformanceCard({ metric1, metric2 }: { metric1: string; metric2: string }) {
  const [data, setData] = useState<{ hasData: boolean; timezone: string; series: HourPoint[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/budget-schedules/hourly-performance`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        setData({ hasData: j?.hasData === true, timezone: String(j?.timezone ?? ''), series: Array.isArray(j?.series) ? j.series : [] })
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
    return () => { alive = false }
  }, [])

  const k1 = METRIC_KEY[metric1] ?? null
  const k2 = METRIC_KEY[metric2] ?? null
  const series = data?.series ?? []

  const geom = useMemo(() => {
    if (!series.length) return null
    const W = 960, H = 190, padL = 8, padR = 8, padT = 12, padB = 22
    const n = series.length
    const bw = (W - padL - padR) / n
    const v1 = series.map((p) => (k1 ? Number(p[k1]) || 0 : 0))
    const v2 = series.map((p) => (k2 ? Number(p[k2]) || 0 : 0))
    const max1 = Math.max(1, ...v1)
    const max2 = Math.max(1, ...v2)
    const y2 = (v: number) => padT + (H - padT - padB) * (1 - v / max2)
    const line = v2.map((v, i) => `${i === 0 ? 'M' : 'L'} ${padL + bw * i + bw / 2} ${y2(v)}`).join(' ')
    return { W, H, padL, padT, padB, bw, v1, v2, max1, max2, line, barH: (v: number) => (H - padT - padB) * (v / max1) }
  }, [series, k1, k2])

  if (err != null) {
    return (
      <div className="h10-sb-nodata" role="alert">
        <span className="ill"><AlertTriangle size={24} /></span>
        <span className="t">Hourly performance failed to load {err} — a failed read, not an absence of data.</span>
      </div>
    )
  }
  if (data == null) return <div className="h10-sb-nodata"><span className="t">Loading hourly performance…</span></div>
  if (!data.hasData || !geom) {
    // The sentence this card used to print unconditionally — true only here.
    return (
      <div className="h10-sb-nodata">
        <span className="ill"><Search size={26} /></span>
        <span className="t">Hourly data is not available for this marketplace.</span>
      </div>
    )
  }

  const unsupported = [k1 ? null : metric1, k2 ? null : metric2].filter(Boolean) as string[]

  return (
    <div className="h10-bsp-hourly">
      <svg viewBox={`0 0 ${geom.W} ${geom.H}`} className="chart" role="img"
        aria-label={`${metric1} and ${metric2} by hour of day, ${data.timezone}`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={geom.padL} x2={geom.W - 8} y1={geom.padT + (geom.H - geom.padT - geom.padB) * f} y2={geom.padT + (geom.H - geom.padT - geom.padB) * f} className="grid" />
        ))}
        {series.map((p, i) => {
          const h = geom.barH(geom.v1[i])
          return (
            <g key={p.hour}>
              <rect
                x={geom.padL + geom.bw * i + 3} width={Math.max(2, geom.bw - 6)}
                y={geom.H - geom.padB - h} height={Math.max(0, h)}
                className="bar"
              ><title>{`${hourLabel(p.hour)} · ${metric1} ${fmt(metric1, geom.v1[i])}${k2 ? ` · ${metric2} ${fmt(metric2, geom.v2[i])}` : ''}`}</title></rect>
              {i % 3 === 0 && (
                <text x={geom.padL + geom.bw * i + geom.bw / 2} y={geom.H - 6} textAnchor="middle" className="xlab">{hourLabel(p.hour)}</text>
              )}
            </g>
          )
        })}
        {k2 && <path d={geom.line} className="line2" fill="none" />}
      </svg>
      <p className="h10-bsp-hourfoot">
        <b>{metric1}</b> {fmt(metric1, Math.max(...geom.v1))} peak
        {k2 && <> · <b>{metric2}</b> {fmt(metric2, Math.max(...geom.v2))} peak</>}
        {' · '}by hour of day, {data.timezone || 'account timezone'}
        {unsupported.length > 0 && (
          <> · <i>{unsupported.join(' and ')} {unsupported.length === 1 ? 'is' : 'are'} not returned hourly, so {unsupported.length === 1 ? 'it is' : 'they are'} not plotted.</i></>
        )}
      </p>
    </div>
  )
}

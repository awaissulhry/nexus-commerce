'use client'

/**
 * U8 — "Hourly Campaign Performance", finally reading the data.
 *
 * 🔴 **This card was a CONSTANT.** `SchedulesSection.tsx` rendered
 * "Hourly data is not available for this marketplace." unconditionally, never called an endpoint,
 * and its two metric pickers changed nothing — the [[reference_fleet_stale_constant_class]] shape
 * exactly. Measured on prod 2026-08-18: `GET /advertising/budget-schedules/hourly-performance`
 * answers **200 with `hasData: true`** and 24 hourly buckets (spend · sales · orders · clicks ·
 * impressions · acos, Europe/Rome).
 *
 * The chart is two series on two axes, H10's shape: Metric 1 (navy bars, left axis) and Metric 2
 * (blue line, right axis), 24 columns 12AM…11PM. Inline SVG rather than a chart library — 24
 * points, and the section refuses new dependencies.
 *
 * ── BSP-P1 (2026-08-21) — 🔴 a null ACoS was being DRAWN AS ZERO ──────────────────────────────
 *
 * The route returns `acos: null` for an hour with no attributed sales. This card typed it `number`
 * and read `Number(p[k]) || 0`, so every such hour landed on the zero baseline — and ACoS is the
 * DEFAULT Metric 2, so this was the tab's default view. Measured on prod by SVG geometry (not by
 * reading the source): hours 03, 06 and 07 sat exactly on y=168, the value-zero baseline, with
 * tooltips reading "7AM · Spend €61 · ACoS 0%". Those three hours have **zero sales in 60 days**.
 * €61/hour returning nothing was drawn as the flattest, most efficient point on the chart — the
 * precise inverse of the truth, on the one screen whose job is choosing which hours get budget.
 * Same class as [[reference_sov_zero_vs_rounding]]: a null is not a zero.
 *
 * So: `acos` is `number | null` end to end, an unmeasurable bucket is a GAP in the line (the path
 * breaks; an isolated point becomes a dot), the tooltip says "no sales", and the footer counts the
 * buckets it could not compute. An empty hour must render and say it is empty — only a failed
 * FETCH may be silent ([[reference_day_grouping_utc_local_trap]] §"ONE PAGE, TWO FEEDS").
 *
 * ── BSP-P2 — the card is MARKET-SCOPED ──────────────────────────────────────────────────────────
 *
 * It fetched account-wide while the page header offered IT/DE/ES/FR. The four markets peak up to
 * four hours apart (IT h22 · DE h18 · ES h15 · FR h19), so the merged curve was true of no market.
 * The card now takes the header's market, sends it, and NAMES what it drew in the footer.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export interface HourPoint {
  /** Present for the `hour` and `cell` grains. */
  hour?: number
  /** Present for the `weekday` and `cell` grains. 0=Sun…6=Sat, Postgres DOW. */
  dow?: number
  spend: number
  sales: number
  orders: number
  clicks: number
  impressions: number
  /** 🔴 null = no attributed sales in this bucket, so ACoS is UNDEFINED. Never coerce to 0. */
  acos: number | null
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

/** The one place a missing value becomes words. Used by the tooltip AND the footer, so the two
 *  can never drift into disagreeing about what a gap means. */
const fmtOrNone = (m: string, v: number | null) => (v == null ? (isPct(m) ? 'no sales' : 'no data') : fmt(m, v))

const hourLabel = (h: number) => (h === 0 ? '12AM' : h === 12 ? '12PM' : h < 12 ? `${h}AM` : `${h - 12}PM`)
/** BSP-P5 — Postgres DOW (0=Sun) → the MON-first names the rest of this section uses. */
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const bucketLabel = (p: HourPoint) => (p.dow != null && p.hour == null ? DOW_LABEL[p.dow] ?? '?' : hourLabel(p.hour ?? 0))

/** Read one metric off a bucket, PRESERVING null. `Number(null)` is 0 and that was the whole bug. */
const valueAt = (p: HourPoint, key: keyof HourPoint | null): number | null => {
  if (!key) return null
  const raw = p[key]
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function HourlyPerformanceCard({ metric1, metric2, market, groupBy = 'hour' }: { metric1: string; metric2: string; market?: string; groupBy?: 'hour' | 'weekday' }) {
  const [data, setData] = useState<{ hasData: boolean; timezone: string; series: HourPoint[]; windowStart: string; windowEnd: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const scope = market && market !== 'all' ? market : null

  useEffect(() => {
    let alive = true
    setData(null)
    setErr(null)
    const params = new URLSearchParams()
    if (scope) params.set('marketplace', scope)
    if (groupBy !== 'hour') params.set('groupBy', groupBy)
    const qs = params.toString() ? `?${params}` : ''
    fetch(`${getBackendUrl()}/api/advertising/budget-schedules/hourly-performance${qs}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        setData({
          hasData: j?.hasData === true,
          timezone: String(j?.timezone ?? ''),
          series: Array.isArray(j?.series) ? j.series : [],
          windowStart: String(j?.windowStart ?? ''),
          windowEnd: String(j?.windowEnd ?? ''),
        })
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
    return () => { alive = false }
  }, [scope, groupBy])

  const k1 = METRIC_KEY[metric1] ?? null
  const k2 = METRIC_KEY[metric2] ?? null
  const series = data?.series ?? []

  const geom = useMemo(() => {
    if (!series.length) return null
    // BSP-P1 — padL/padR widened from 8 to make room for the two value axes. A chart with no scale
    // asks the reader to guess the magnitude of what it is showing.
    const W = 960, H = 200, padL = 46, padR = 52, padT = 12, padB = 22
    const n = series.length
    const bw = (W - padL - padR) / n
    const v1 = series.map((p) => valueAt(p, k1))
    const v2 = series.map((p) => valueAt(p, k2))
    const finite = (xs: Array<number | null>) => xs.filter((v): v is number => v != null)
    const max1 = Math.max(1, ...finite(v1))
    const max2 = Math.max(1, ...finite(v2))
    const plotH = H - padT - padB
    const y2 = (v: number) => padT + plotH * (1 - v / max2)
    const cx = (i: number) => padL + bw * i + bw / 2

    /**
     * 🔴 The gap, drawn as a gap. A null breaks the path into a new subpath rather than being
     * plotted at zero; a non-null point with null neighbours on both sides can't be a segment at
     * all, so it becomes a dot — otherwise it would silently vanish, which is the same class of
     * lie in the other direction.
     */
    const segments: string[] = []
    const dots: Array<{ x: number; y: number }> = []
    let run: number[] = []
    const flush = () => {
      if (run.length === 1) { const i = run[0]; dots.push({ x: cx(i), y: y2(v2[i] as number) }) }
      else if (run.length > 1) segments.push(run.map((i, j) => `${j === 0 ? 'M' : 'L'} ${cx(i)} ${y2(v2[i] as number)}`).join(' '))
      run = []
    }
    for (let i = 0; i < n; i++) { if (v2[i] == null) flush(); else run.push(i) }
    flush()

    return {
      W, H, padL, padR, padT, padB, plotH, bw, v1, v2, max1, max2, cx,
      segments, dots,
      barH: (v: number) => plotH * (v / max1),
    }
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
    // BSP-P1 — the sentence this card used to print unconditionally, now stating the SCOPE it
    // actually asked about. "for this marketplace" was written for an account-wide fetch and said
    // nothing true about which market had no data.
    return (
      <div className="h10-sb-nodata">
        <span className="ill"><Search size={26} /></span>
        <span className="t">
          {scope
            ? `No hourly performance has been reported for ${scope} between ${data.windowStart} and ${data.windowEnd}.`
            : `No hourly performance has been reported for this account between ${data.windowStart} and ${data.windowEnd}.`}
        </span>
      </div>
    )
  }

  const unsupported = [k1 ? null : metric1, k2 ? null : metric2].filter(Boolean) as string[]
  const finite1 = geom.v1.filter((v): v is number => v != null)
  const finite2 = geom.v2.filter((v): v is number => v != null)
  const gaps2 = k2 ? geom.v2.filter((v) => v == null).length : 0
  const axisTicks = [1, 0.5, 0]

  return (
    <div className="h10-bsp-hourly">
      <svg viewBox={`0 0 ${geom.W} ${geom.H}`} className="chart" role="img"
        aria-label={`${metric1} and ${metric2} by ${groupBy === 'weekday' ? 'day of week' : 'hour of day'}, ${data.timezone}${scope ? `, ${scope}` : ', all markets'}${gaps2 ? `; ${gaps2} buckets have no ${metric2} because they had no sales` : ''}`}>
        {axisTicks.map((f) => {
          const y = geom.padT + geom.plotH * (1 - f)
          return (
            <g key={f}>
              <line x1={geom.padL} x2={geom.W - geom.padR} y1={y} y2={y} className="grid" />
              {/* BSP-P1 — the left axis is Metric 1's scale, the right is Metric 2's. Without them
                  the two series shared a picture and neither had a magnitude. */}
              {k1 && <text x={geom.padL - 8} y={y + 4} textAnchor="end" className="axlab">{fmt(metric1, geom.max1 * f)}</text>}
              {k2 && <text x={geom.W - geom.padR + 8} y={y + 4} textAnchor="start" className="axlab m2">{fmt(metric2, geom.max2 * f)}</text>}
            </g>
          )
        })}
        {series.map((p, i) => {
          const v = geom.v1[i]
          const h = v == null ? 0 : geom.barH(v)
          const tip = `${bucketLabel(p)} · ${metric1} ${fmtOrNone(metric1, v)}${k2 ? ` · ${metric2} ${fmtOrNone(metric2, geom.v2[i])}` : ''}`
          return (
            <g key={p.dow != null && p.hour == null ? `d${p.dow}` : `h${p.hour}`}>
              {/* A full-height transparent target so an hour with NO bar still answers the hover —
                  a gap the reader cannot interrogate is a gap they will read as zero. */}
              <rect x={geom.padL + geom.bw * i} width={geom.bw} y={geom.padT} height={geom.plotH} className="hit"><title>{tip}</title></rect>
              {v != null && (
                <rect
                  x={geom.padL + geom.bw * i + 3} width={Math.max(2, geom.bw - 6)}
                  y={geom.H - geom.padB - h} height={Math.max(0, h)}
                  className="bar"
                ><title>{tip}</title></rect>
              )}
              {/* Weekday has 7 buckets — label every one; hour has 24, so label every third. */}
              {(series.length <= 7 || i % 3 === 0) && (
                <text x={geom.cx(i)} y={geom.H - 6} textAnchor="middle" className="xlab">{bucketLabel(p)}</text>
              )}
            </g>
          )
        })}
        {k2 && geom.segments.map((d, i) => <path key={i} d={d} className="line2" fill="none" />)}
        {k2 && geom.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={2.5} className="dot2" />)}
      </svg>
      <p className="h10-bsp-hourfoot">
        <b>{metric1}</b> {finite1.length ? `${fmt(metric1, Math.max(...finite1))} peak` : 'not reported'}
        {k2 && <> · <b>{metric2}</b> {finite2.length ? `${fmt(metric2, Math.max(...finite2))} peak` : 'not reported'}</>}
        {' · '}by {groupBy === 'weekday' ? 'day of week' : 'hour of day'}, {data.timezone || 'account timezone'} · {scope ?? 'all markets'} · {data.windowStart} to {data.windowEnd}
        {/* 🔴 The count that used to be invisible: the buckets the chart could NOT compute. */}
        {gaps2 > 0 && (
          <> · <i>{gaps2} of {series.length} {groupBy === 'weekday' ? 'days' : 'hours'} had no attributed sales, so {metric2} is undefined there and is left as a gap — not plotted as zero.</i></>
        )}
        {unsupported.length > 0 && (
          <> · <i>{unsupported.join(' and ')} {unsupported.length === 1 ? 'is' : 'are'} not returned hourly, so {unsupported.length === 1 ? 'it is' : 'they are'} not plotted.</i></>
        )}
      </p>
    </div>
  )
}

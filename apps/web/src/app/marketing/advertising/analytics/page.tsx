/**
 * Phase 7 — TACOS + ACOS daily trends.
 *
 * Merges two data sources server-side:
 *   - AmazonAdsDailyPerformance → ad spend + ad-attributed sales
 *   - DailySalesAggregate (channel=AMAZON) → total organic+ad revenue
 *
 * TACOS = ad spend / total revenue  (needs both sources)
 * ACOS  = ad spend / ad sales       (ads-only, always available)
 *
 * Charts are inline SVG — no charting library dependency.
 */

import type { Metadata } from 'next'
import { TrendingDown, TrendingUp, BarChart2, MousePointerClick, ShoppingCart } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Amazon Ads · Analytics' }
export const dynamic = 'force-dynamic'

interface TrendsRow {
  date: string
  impressions: number
  clicks: number
  orders: number
  adSpendCents: number
  adSalesCents: number
  totalRevenueCents: number
  acos: number | null
  tacos: number | null
  ctr: number | null
}

interface TrendsResponse {
  windowDays: number
  count: number
  rows: TrendsRow[]
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

// ── SVG line chart ───────────────────────────────────────────────────────────

const W = 680
const H = 140
const PAD = { top: 10, right: 12, bottom: 28, left: 42 }

function lerp(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return (outMin + outMax) / 2
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin)
}

function niceMax(max: number): number {
  if (max <= 0) return 10
  const mag = Math.pow(10, Math.floor(Math.log10(max)))
  return Math.ceil(max / mag) * mag
}

interface LineChartProps {
  values: (number | null)[]
  labels: string[]
  color: string
  unit: string
  yLabel: string
}

function LineChart({ values, labels, color, unit, yLabel }: LineChartProps) {
  const defined = values.filter((v): v is number => v != null)
  if (defined.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-slate-400">
        No data yet
      </div>
    )
  }

  const yMin = 0
  const yMax = niceMax(Math.max(...defined))
  const xMin = PAD.left
  const xMax = W - PAD.right
  const yBottom = H - PAD.bottom
  const yTop = PAD.top

  const pts = values.map((v, i) => {
    const x = lerp(i, 0, values.length - 1, xMin, xMax)
    const y = v != null ? lerp(v, yMin, yMax, yBottom, yTop) : null
    return { x, y, v }
  })

  // Build path segments — skip nulls
  const segments: string[] = []
  let seg: string[] = []
  for (const p of pts) {
    if (p.y != null) {
      seg.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    } else if (seg.length > 0) {
      segments.push('M' + seg.join('L'))
      seg = []
    }
  }
  if (seg.length > 0) segments.push('M' + seg.join('L'))
  const pathD = segments.join(' ')

  // Y-axis ticks (3 levels)
  const yTicks = [0, yMax / 2, yMax].map((v) => ({
    v,
    y: lerp(v, yMin, yMax, yBottom, yTop),
    label: `${v.toFixed(1)}${unit}`,
  }))

  // X-axis label every N points so they don't overlap
  const step = Math.max(1, Math.ceil(values.length / 6))
  const xLabels = labels
    .map((l, i) => ({ l, i, x: lerp(i, 0, values.length - 1, xMin, xMax) }))
    .filter((_, i) => i % step === 0)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label={yLabel}>
      {/* Grid lines */}
      {yTicks.map((t) => (
        <g key={t.v}>
          <line x1={xMin} y1={t.y} x2={xMax} y2={t.y} stroke="currentColor"
            className="text-slate-200 dark:text-slate-700" strokeWidth={0.5} />
          <text x={xMin - 4} y={t.y + 3} textAnchor="end" fontSize={9}
            className="fill-slate-400 dark:fill-slate-500 font-mono">
            {t.label}
          </text>
        </g>
      ))}

      {/* X labels */}
      {xLabels.map(({ l, x }) => (
        <text key={l} x={x} y={H - 4} textAnchor="middle" fontSize={9}
          className="fill-slate-400 dark:fill-slate-500">
          {l.slice(5)}  {/* MM-DD */}
        </text>
      ))}

      {/* Line */}
      <path d={pathD} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* Dots (only when few points) */}
      {values.length <= 30 && pts.map((p, i) =>
        p.y != null ? (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={color} />
        ) : null,
      )}
    </svg>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function centsToEur(cents: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'EUR',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(cents / 100)
}

function fmtPct(v: number | null, digits = 1): string {
  return v != null ? `${v.toFixed(digits)}%` : '—'
}

function avg(vals: (number | null)[]): number | null {
  const defined = vals.filter((v): v is number => v != null)
  if (defined.length === 0) return null
  return defined.reduce((a, b) => a + b, 0) / defined.length
}

// ── KPI tile ─────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  sub,
  color = 'text-slate-800 dark:text-slate-100',
}: {
  label: string
  value: string
  sub?: string
  color?: string
}) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Chart card ───────────────────────────────────────────────────────────────

function ChartCard({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string
  subtitle: string
  icon: React.ElementType
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
            <Icon className="h-4 w-4 text-slate-400" aria-hidden />
            {title}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

// ── Data table (last 14 rows) ────────────────────────────────────────────────

function DataTable({ rows }: { rows: TrendsRow[] }) {
  const recent = [...rows].reverse().slice(0, 14)
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            {['Date','Impressions','Clicks','CTR','Orders','Ad Spend','Ad Sales','ACOS','Total Rev','TACOS'].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {recent.map((r) => (
            <tr key={r.date} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
              <td className="px-3 py-1.5 text-xs font-mono text-slate-500 whitespace-nowrap">{r.date.slice(5)}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">{r.impressions.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">{r.clicks.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">{fmtPct(r.ctr, 2)}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">{r.orders}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-700 dark:text-slate-300">{centsToEur(r.adSpendCents)}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-700 dark:text-slate-300">{centsToEur(r.adSalesCents)}</td>
              <td className={`px-3 py-1.5 text-xs tabular-nums font-medium ${
                r.acos == null ? 'text-slate-400' :
                r.acos > 30 ? 'text-red-600 dark:text-red-400' :
                r.acos > 20 ? 'text-amber-600 dark:text-amber-400' :
                'text-emerald-600 dark:text-emerald-400'
              }`}>{fmtPct(r.acos)}</td>
              <td className="px-3 py-1.5 text-xs tabular-nums text-slate-700 dark:text-slate-300">
                {r.totalRevenueCents > 0 ? centsToEur(r.totalRevenueCents) : '—'}
              </td>
              <td className={`px-3 py-1.5 text-xs tabular-nums font-medium ${
                r.tacos == null ? 'text-slate-400' :
                r.tacos > 20 ? 'text-red-600 dark:text-red-400' :
                r.tacos > 12 ? 'text-amber-600 dark:text-amber-400' :
                'text-emerald-600 dark:text-emerald-400'
              }`}>{fmtPct(r.tacos)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Window picker links ──────────────────────────────────────────────────────

function WindowPicker({ current }: { current: number }) {
  const options = [7, 14, 30, 60, 90]
  return (
    <div className="flex items-center gap-1">
      {options.map((d) => (
        <a
          key={d}
          href={`?windowDays=${d}`}
          className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
            current === d
              ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 border-slate-800 dark:border-slate-200'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'
          }`}
        >
          {d}d
        </a>
      ))}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<{ windowDays?: string; marketplace?: string; adProduct?: string }>
}

export default async function AnalyticsPage({ searchParams }: PageProps) {
  const params = await searchParams
  const windowDays = Math.max(7, Math.min(180, Number(params.windowDays ?? 30)))
  const marketplace = params.marketplace ?? ''
  const adProduct   = params.adProduct ?? ''

  const backend = getBackendUrl()
  const qs = new URLSearchParams({ windowDays: String(windowDays) })
  if (marketplace) qs.set('marketplace', marketplace)
  if (adProduct)   qs.set('adProduct', adProduct)

  const data = await fetchJson<TrendsResponse>(
    `${backend}/api/advertising/trends?${qs.toString()}`,
    { windowDays, count: 0, rows: [] },
  )

  const rows = data.rows
  const dates    = rows.map((r) => r.date)
  const acosVals = rows.map((r) => r.acos)
  const tacosVals = rows.map((r) => r.tacos)
  const spendVals = rows.map((r) => r.adSpendCents / 100)
  const ctrVals   = rows.map((r) => r.ctr)

  const avgAcos  = avg(acosVals)
  const avgTacos = avg(tacosVals)
  const totalSpend = rows.reduce((s, r) => s + r.adSpendCents, 0)
  const totalRev   = rows.reduce((s, r) => s + r.totalRevenueCents, 0)
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0)

  return (
    <div className="px-4 py-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <BarChart2 className="h-5 w-5 text-blue-500" aria-hidden />
            Advertising Analytics
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            TACOS, ACOS and spend trends. TACOS requires DailySalesAggregate data (SP-API
            Sales &amp; Traffic) — shown as — when that source hasn&apos;t run yet.
          </p>
        </div>
        <WindowPicker current={windowDays} />
      </div>

      <AdvertisingNav />

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <KpiTile
          label="Avg ACOS"
          value={fmtPct(avgAcos)}
          sub={`${windowDays}-day avg`}
          color={avgAcos == null ? 'text-slate-400' : avgAcos > 30 ? 'text-red-600 dark:text-red-400' : avgAcos > 20 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}
        />
        <KpiTile
          label="Avg TACOS"
          value={fmtPct(avgTacos)}
          sub="needs SP-API revenue"
          color={avgTacos == null ? 'text-slate-400' : avgTacos > 20 ? 'text-red-600 dark:text-red-400' : avgTacos > 12 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}
        />
        <KpiTile
          label="Ad Spend"
          value={centsToEur(totalSpend)}
          sub={`last ${windowDays} days`}
        />
        <KpiTile
          label="Total Revenue"
          value={totalRev > 0 ? centsToEur(totalRev) : '—'}
          sub="organic + ad (SP-API)"
        />
        <KpiTile
          label="Ad Orders"
          value={totalOrders.toLocaleString()}
          sub="7-day attribution"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <ChartCard
          title="ACOS Trend"
          subtitle="Ad spend ÷ ad-attributed sales (7d window)"
          icon={TrendingDown}
        >
          {rows.length === 0
            ? <div className="text-xs text-slate-400 py-8 text-center">No ad performance data yet.</div>
            : <LineChart values={acosVals} labels={dates} color="#f59e0b" unit="%" yLabel="ACOS %" />
          }
        </ChartCard>

        <ChartCard
          title="TACOS Trend"
          subtitle="Ad spend ÷ total Amazon revenue (SP-API)"
          icon={TrendingUp}
        >
          {rows.length === 0 || acosVals.every((v) => v == null)
            ? <div className="text-xs text-slate-400 py-8 text-center">No data yet.</div>
            : <LineChart values={tacosVals} labels={dates} color="#3b82f6" unit="%" yLabel="TACOS %" />
          }
        </ChartCard>

        <ChartCard
          title="Daily Ad Spend"
          subtitle={`EUR spend over last ${windowDays} days`}
          icon={BarChart2}
        >
          {rows.length === 0
            ? <div className="text-xs text-slate-400 py-8 text-center">No spend data yet.</div>
            : <LineChart values={spendVals} labels={dates} color="#10b981" unit="€" yLabel="Spend €" />
          }
        </ChartCard>

        <ChartCard
          title="CTR Trend"
          subtitle="Click-through rate (clicks ÷ impressions)"
          icon={MousePointerClick}
        >
          {rows.length === 0
            ? <div className="text-xs text-slate-400 py-8 text-center">No data yet.</div>
            : <LineChart values={ctrVals} labels={dates} color="#8b5cf6" unit="%" yLabel="CTR %" />
          }
        </ChartCard>
      </div>

      {/* Data table */}
      <div className="mb-2 flex items-center gap-2">
        <ShoppingCart className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Daily breakdown — last 14 days
        </h2>
      </div>
      {rows.length === 0
        ? <p className="text-sm text-slate-400">No data in this window.</p>
        : <DataTable rows={rows} />
      }
    </div>
  )
}

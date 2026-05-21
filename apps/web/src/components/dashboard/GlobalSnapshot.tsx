'use client'

/**
 * GS.2 — collapsed Global Snapshot strip. Mirrors Amazon Seller
 * Central's home-page widget: Sales · Open Orders · Buyer Messages
 * with a chevron on each tile that opens a detail panel.
 *
 * Designed to mount on multiple surfaces (top of /orders + the
 * standalone /dashboard route) with no per-surface knobs. One data
 * fetch, three tiles, click-to-expand.
 *
 * Expand panels (Sales / Open Orders detail tables) land in GS.3+GS.4.
 * For GS.2, expanding shows a placeholder so the interaction is wired
 * but the heavy table layout doesn't block this commit.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, ShoppingCart, Package, Mail, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { getBackendUrl } from '@/lib/backend-url'

type SalesRow = {
  marketplace: string
  region: string
  currency: string
  valueCents: number
  units: number
  orderCount: number
}

type OpenOrdersRow = {
  marketplace: string
  region: string
  fbmUnshipped: number
  fbmPending: number
  fbaPending: number
}

type Snapshot = {
  period: { key: string; from: string; to: string; timezone: string }
  sales: {
    total: { valueCents: number; currency: string; units: number }
    sparkline: Array<{ date: string; valueCents: number }>
    byMarketplace: SalesRow[]
  }
  openOrders: {
    total: number
    fbmUnshipped: number
    fbmPending: number
    fbaPending: number
    byMarketplace: OpenOrdersRow[]
  }
  lastUpdatedAt: string
}

type TileKey = 'sales' | 'openOrders' | 'messages'

function formatEur(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`
}

function freshness(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return `${h}h ago`
}

export function GlobalSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<TileKey | null>(null)
  const [tick, setTick] = useState(0)

  const fetchSnapshot = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/global-snapshot?period=today`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setData(await res.json())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchSnapshot() }, [])

  // Re-tick the "Xs ago" label every 5s without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  const onToggle = (key: TileKey) => setExpanded((cur) => (cur === key ? null : key))

  if (loading && !data) {
    return (
      <Card title="Global snapshot">
        <Skeleton lines={3} />
      </Card>
    )
  }
  if (error && !data) {
    return (
      <Card title="Global snapshot">
        <div className="text-sm text-rose-600 dark:text-rose-400">Failed to load: {error}</div>
      </Card>
    )
  }
  if (!data) return null

  return (
    <Card
      title="Global snapshot"
      action={
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span title={new Date(data.lastUpdatedAt).toLocaleString()}>
            Updated {freshness(data.lastUpdatedAt)}
            <span aria-hidden="true">&nbsp;·&nbsp;{tick === 0 ? '' : ''}</span>
          </span>
          <button
            type="button"
            onClick={fetchSnapshot}
            className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
            aria-label="Refresh snapshot"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      }
      noPadding
    >
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-700">
        <SnapshotTile
          icon={ShoppingCart}
          label="Sales"
          expanded={expanded === 'sales'}
          onToggle={() => onToggle('sales')}
        >
          <div className="space-y-1">
            <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
              {formatEur(data.sales.total.valueCents)}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {data.period.key === 'today' ? 'Today so far' : data.period.key}
              {' · '}
              <span>{data.sales.total.units} units</span>
            </div>
            <Sparkline data={data.sales.sparkline} />
          </div>
        </SnapshotTile>

        <SnapshotTile
          icon={Package}
          label="Open Orders"
          expanded={expanded === 'openOrders'}
          onToggle={() => onToggle('openOrders')}
        >
          <div className="space-y-1.5">
            <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
              {data.openOrders.total}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Total count</div>
            <ul className="text-xs pt-2 mt-2 border-t border-slate-200 dark:border-slate-700 space-y-0.5">
              <SubLine label="FBM unshipped" value={data.openOrders.fbmUnshipped} href="/orders?fulfillment=FBM&status=PROCESSING,ON_HOLD" />
              <SubLine label="FBM pending" value={data.openOrders.fbmPending} href="/orders?fulfillment=FBM&status=PENDING,AWAITING_PAYMENT" />
              <SubLine label="FBA pending" value={data.openOrders.fbaPending} href="/orders?fulfillment=FBA&status=PENDING,AWAITING_PAYMENT" />
            </ul>
          </div>
        </SnapshotTile>

        <SnapshotTile
          icon={Mail}
          label="Buyer Messages"
          expanded={expanded === 'messages'}
          onToggle={() => onToggle('messages')}
        >
          <div className="space-y-1">
            <div className="text-2xl font-bold tabular-nums text-slate-400 dark:text-slate-500">—</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Not ingested yet</div>
          </div>
        </SnapshotTile>
      </div>

      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-900">
          {expanded === 'sales' && <SalesPanelPlaceholder data={data} />}
          {expanded === 'openOrders' && <OpenOrdersPanelPlaceholder data={data} />}
          {expanded === 'messages' && <MessagesPanelPlaceholder />}
        </div>
      )}
    </Card>
  )
}

function SnapshotTile({
  icon: Icon,
  label,
  expanded,
  onToggle,
  children,
}: {
  icon: any
  label: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="p-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-start justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Icon size={13} className="text-slate-500 dark:text-slate-400" aria-hidden="true" />
          {label}
        </div>
        <span className="text-slate-400 dark:text-slate-500">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      <div className="mt-2">{children}</div>
    </div>
  )
}

function SubLine({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <Link
        href={href}
        className={`tabular-nums font-semibold ${value > 0 ? 'text-blue-600 dark:text-blue-400 hover:underline' : 'text-slate-400 dark:text-slate-500'}`}
        onClick={(e) => { if (value === 0) e.preventDefault() }}
      >
        {value}
      </Link>
    </li>
  )
}

/**
 * Minimal inline SVG sparkline — 7 days ending today. No external dep.
 * The detail-page chart in GS.3 will be richer; this is just the tile.
 */
function Sparkline({ data }: { data: Array<{ date: string; valueCents: number }> }) {
  if (data.length === 0) return null
  const W = 180
  const H = 40
  const PAD = 4
  const max = Math.max(1, ...data.map((d) => d.valueCents))
  const min = 0
  const xStep = (W - 2 * PAD) / Math.max(1, data.length - 1)
  const yScale = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD)
  const points = data.map((d, i) => `${PAD + i * xStep},${yScale(d.valueCents)}`)
  const path = `M ${points.join(' L ')}`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="overflow-visible mt-1" aria-label="7-day sales sparkline">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-700 dark:text-slate-300" />
      {data.map((d, i) => (
        <circle
          key={d.date}
          cx={PAD + i * xStep}
          cy={yScale(d.valueCents)}
          r={i === data.length - 1 ? 3 : 1.5}
          className={i === data.length - 1 ? 'fill-slate-900 dark:fill-slate-100' : 'fill-slate-400 dark:fill-slate-500'}
        />
      ))}
    </svg>
  )
}

// GS.3 placeholder — full panel with period dropdown + Table/Graph
// toggle + per-marketplace flagged table lands next phase.
function SalesPanelPlaceholder({ data }: { data: Snapshot }) {
  if (data.sales.byMarketplace.length === 0) {
    return <div className="text-sm text-slate-500 dark:text-slate-400">No sales in this period.</div>
  }
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
        Sales by marketplace ({data.period.key})
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-slate-500 dark:text-slate-400">
          <tr><th className="text-left py-1">Marketplace</th><th className="text-right py-1">Revenue</th><th className="text-right py-1">Units</th></tr>
        </thead>
        <tbody>
          {data.sales.byMarketplace.map((r) => (
            <tr key={r.marketplace} className="border-t border-slate-200 dark:border-slate-700">
              <td className="py-1 text-slate-700 dark:text-slate-300 font-mono">{r.marketplace}</td>
              <td className="py-1 text-right tabular-nums text-slate-900 dark:text-slate-100">{formatEur(r.valueCents)}</td>
              <td className="py-1 text-right tabular-nums text-slate-700 dark:text-slate-300">{r.units}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link href="/insights/sales" className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:underline">
        Go to Sales Dashboard →
      </Link>
    </div>
  )
}

function OpenOrdersPanelPlaceholder({ data }: { data: Snapshot }) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Open orders breakdown</div>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-slate-500 dark:text-slate-400">
          <tr>
            <th className="text-left py-1">Marketplace</th>
            <th className="text-right py-1">FBM unshipped</th>
            <th className="text-right py-1">FBM pending</th>
            <th className="text-right py-1">FBA pending</th>
          </tr>
        </thead>
        <tbody>
          {data.openOrders.byMarketplace.map((r) => (
            <tr key={r.marketplace} className="border-t border-slate-200 dark:border-slate-700">
              <td className="py-1 text-slate-700 dark:text-slate-300 font-mono">{r.marketplace}</td>
              <td className="py-1 text-right tabular-nums text-slate-900 dark:text-slate-100">{r.fbmUnshipped}</td>
              <td className="py-1 text-right tabular-nums text-slate-900 dark:text-slate-100">{r.fbmPending}</td>
              <td className="py-1 text-right tabular-nums text-slate-900 dark:text-slate-100">{r.fbaPending}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link href="/orders" className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:underline">
        Go to open orders →
      </Link>
    </div>
  )
}

function MessagesPanelPlaceholder() {
  return (
    <div className="text-sm text-slate-600 dark:text-slate-400">
      Buyer messages aren't ingested yet. Manage them in Seller Central until GS.5 wires the inbox.
    </div>
  )
}

'use client'

// PO.13 — Spend summary tile at the top of /fulfillment/purchase-orders.
//
// Four tiles + aging strip + top suppliers list. Each tile is
// click-to-drill: open POs → list with status=active filter; late
// bucket → list with ?late=<bucket> (UI-side filter for now); top
// supplier → list filtered to that supplier.
//
// Refreshes on every po.* invalidation via the PO.4 SSE pipe so the
// tile stays sub-second-fresh after every transition.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowRight,
  Clock,
  Loader2,
  TrendingUp,
  Truck,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'
import { formatCurrency } from './po-lens'

interface SpendSummary {
  openCount: number
  openValueCents: number
  inTransitValueCents: number
  thisMonthCommitCents: number
  aging: {
    upTo7: { count: number; valueCents: number }
    upTo14: { count: number; valueCents: number }
    upTo30: { count: number; valueCents: number }
    over30: { count: number; valueCents: number }
  }
  late: { count: number; valueCents: number }
  topSuppliers: Array<{
    supplierId: string
    name: string
    poCount: number
    openValueCents: number
  }>
  currencyCode: string
}

export function SpendSummaryTile({ onPickSupplier }: { onPickSupplier?: (id: string) => void }) {
  const [data, setData] = useState<SpendSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('po.spend.collapsed') === 'true'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem('po.spend.collapsed', String(collapsed))
    } catch {
      /* ignore */
    }
  }, [collapsed])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/spend-summary`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // PO.4 — refresh on every PO event since the tile aggregates value
  // across the whole list. Debouncing is unnecessary at Xavia's scale
  // (sub-200 active POs).
  useInvalidationChannel(
    [
      'po.created',
      'po.updated',
      'po.transitioned',
      'po.deleted',
      'po.restored',
      'po.received',
      'inbound.received',
    ],
    useCallback(() => {
      load()
    }, [load]),
  )

  if (collapsed) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg px-3 py-1.5 flex items-center justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" />
          {data
            ? `Spend tile · ${data.openCount} open · ${formatCurrency(data.openValueCents, data.currencyCode)}`
            : 'Spend tile (collapsed)'}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          Expand
        </button>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg p-4 text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading spend summary…
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
        <AlertCircle className="w-4 h-4" />
        Spend summary: {error ?? 'unavailable'}
      </div>
    )
  }

  const ccy = data.currencyCode

  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" /> Spend summary
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-sm font-normal text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 normal-case tracking-normal"
        >
          Collapse
        </button>
      </div>

      {/* Headline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 border-b border-default dark:border-slate-700">
        <SpendTile
          label="Open"
          primary={formatCurrency(data.openValueCents, ccy)}
          secondary={`${data.openCount} PO${data.openCount === 1 ? '' : 's'}`}
          icon={<TrendingUp className="w-4 h-4" />}
          href="/fulfillment/purchase-orders?status=active"
        />
        <SpendTile
          label="In transit"
          primary={formatCurrency(data.inTransitValueCents, ccy)}
          secondary="supplier holds it"
          icon={<Truck className="w-4 h-4" />}
          href="/fulfillment/purchase-orders?status=SUBMITTED,ACKNOWLEDGED"
        />
        <SpendTile
          label="This month"
          primary={formatCurrency(data.thisMonthCommitCents, ccy)}
          secondary="new commits"
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <SpendTile
          label="Late"
          primary={`${data.late.count}`}
          secondary={
            data.late.count > 0
              ? formatCurrency(data.late.valueCents, ccy)
              : 'all on time'
          }
          icon={<Clock className="w-4 h-4" />}
          tone={data.late.count > 0 ? 'amber' : 'green'}
        />
      </div>

      {/* Aging strip + top suppliers, side-by-side on desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-700">
        <div className="p-4">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide mb-2">
            Aging (days late)
          </div>
          {data.late.count === 0 ? (
            <div className="text-base text-slate-500 dark:text-slate-400">
              No POs are past their expected delivery date.
            </div>
          ) : (
            <div className="space-y-1.5">
              <AgingRow label="0–7 days late" bucket={data.aging.upTo7} ccy={ccy} tone="amber" />
              <AgingRow label="7–14 days late" bucket={data.aging.upTo14} ccy={ccy} tone="amber" />
              <AgingRow label="14–30 days late" bucket={data.aging.upTo30} ccy={ccy} tone="red" />
              <AgingRow label="30+ days late" bucket={data.aging.over30} ccy={ccy} tone="red" />
            </div>
          )}
        </div>

        <div className="p-4">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide mb-2">
            Top suppliers by open spend
          </div>
          {data.topSuppliers.length === 0 ? (
            <div className="text-base text-slate-500 dark:text-slate-400">
              No active suppliers.
            </div>
          ) : (
            <div className="space-y-1.5">
              {data.topSuppliers.map((s) => (
                <button
                  key={s.supplierId}
                  type="button"
                  onClick={() => onPickSupplier?.(s.supplierId)}
                  className="w-full flex items-center justify-between gap-2 text-base hover:bg-slate-50 dark:hover:bg-slate-800 rounded px-2 py-1 -mx-2 transition-colors text-left"
                >
                  <span className="text-slate-900 dark:text-slate-100 truncate">{s.name}</span>
                  <span className="flex items-center gap-2 text-sm tabular-nums flex-shrink-0">
                    <span className="text-slate-500 dark:text-slate-400">
                      {s.poCount} PO{s.poCount === 1 ? '' : 's'}
                    </span>
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {formatCurrency(s.openValueCents, ccy)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SpendTile({
  label,
  primary,
  secondary,
  icon,
  href,
  tone = 'slate',
}: {
  label: string
  primary: string
  secondary?: string
  icon: React.ReactNode
  href?: string
  tone?: 'green' | 'amber' | 'red' | 'slate'
}) {
  const toneCls: Record<typeof tone, string> = {
    green: 'text-green-700 dark:text-green-300',
    amber: 'text-amber-700 dark:text-amber-300',
    red: 'text-red-700 dark:text-red-300',
    slate: 'text-slate-900 dark:text-slate-100',
  } as any
  const inner = (
    <div className="px-4 py-3 border-r last:border-r-0 border-default dark:border-slate-700 h-full">
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1 inline-flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className={cn('text-xl font-semibold tabular-nums', toneCls[tone])}>{primary}</div>
      {secondary && (
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{secondary}</div>
      )}
    </div>
  )
  if (href) {
    return (
      <Link href={href as any} className="block hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
        {inner}
      </Link>
    )
  }
  return inner
}

function AgingRow({
  label,
  bucket,
  ccy,
  tone,
}: {
  label: string
  bucket: { count: number; valueCents: number }
  ccy: string
  tone: 'amber' | 'red'
}) {
  if (bucket.count === 0) return null
  return (
    <div className="flex items-center justify-between gap-2 text-base">
      <span className={cn(tone === 'red' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300')}>
        {label}
      </span>
      <span className="inline-flex items-center gap-2 text-sm tabular-nums">
        <span className="text-slate-500 dark:text-slate-400">
          {bucket.count} PO{bucket.count === 1 ? '' : 's'}
        </span>
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatCurrency(bucket.valueCents, ccy)}
        </span>
        <ArrowRight className="w-3 h-3 text-tertiary dark:text-slate-500" />
      </span>
    </div>
  )
}

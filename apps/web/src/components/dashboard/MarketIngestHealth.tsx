'use client'

/**
 * MS.4 — per-marketplace ingest health.
 *
 * Operators want to know at a glance: are all my Amazon marketplaces
 * delivering data? Or has IT gone quiet while DE keeps flowing?
 * This widget reads /api/dashboard/market-health and renders a
 * compact grid: one row per configured market with a status dot,
 * last-order time, and a 24h / 7d order count.
 *
 * Auto-refreshes every 60s.
 */

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { getBackendUrl } from '@/lib/backend-url'

type MarketStatus = 'active' | 'quiet' | 'silent' | 'never'

interface MarketRow {
  marketplaceId: string
  code: string
  name: string
  currency: string
  lastOrderAt: string | null
  ordersLast24h: number
  ordersLast7d: number
  secondsSinceLastOrder: number | null
  status: MarketStatus
}

interface HealthPayload {
  configured: number
  rollup: { active: number; quiet: number; silent: number; never: number }
  markets: MarketRow[]
  checkedAt: string
}

const FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧',
  NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷',
}

function relativeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const STATUS_TONE: Record<MarketStatus, { dot: string; label: string; chip: string }> = {
  active: {
    dot: 'bg-emerald-500',
    label: 'Active',
    chip: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  quiet: {
    dot: 'bg-amber-500',
    label: 'Quiet',
    chip: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  },
  silent: {
    dot: 'bg-rose-500',
    label: 'Silent',
    chip: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  },
  never: {
    dot: 'bg-slate-300 dark:bg-slate-600',
    label: 'No orders',
    chip: 'bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  },
}

export function MarketIngestHealth() {
  const [data, setData] = useState<HealthPayload | null>(null)
  const [, setTick] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/market-health`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setData(await res.json())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    }
  }

  useEffect(() => {
    load()
    const refresh = setInterval(load, 60_000)
    return () => clearInterval(refresh)
  }, [])

  // Re-tick "Xs ago" labels every 10s without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])

  if (!data && !error) {
    return (
      <Card title="Market ingest health">
        <Skeleton lines={2} />
      </Card>
    )
  }
  if (error && !data) {
    return (
      <Card title="Market ingest health">
        <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>
      </Card>
    )
  }
  if (!data) return null

  const total = data.configured
  const r = data.rollup

  return (
    <Card
      title="Market ingest health"
      description={`${total} Amazon markets configured · ${r.active} active · ${r.quiet} quiet · ${r.silent} silent · ${r.never} no orders ever`}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {data.markets.map((m) => {
          const tone = STATUS_TONE[m.status]
          return (
            <div
              key={m.marketplaceId}
              className={`relative px-3 py-2 rounded border border-slate-200 dark:border-slate-700 ${m.status === 'silent' ? 'bg-rose-50/40 dark:bg-rose-950/20' : ''}`}
              title={
                m.lastOrderAt
                  ? `Last order: ${new Date(m.lastOrderAt).toLocaleString()} · ${m.ordersLast7d} in last 7 days`
                  : 'No orders ever ingested for this marketplace'
              }
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1">
                  <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden="true" />
                  <span aria-hidden="true">{FLAG[m.code] ?? '🏳️'}</span>
                  {m.name}
                </span>
                <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${tone.chip}`}>
                  {tone.label}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>Last: <span className="text-slate-700 dark:text-slate-300 font-medium">{relativeAgo(m.lastOrderAt)}</span></span>
                <span className="tabular-nums">
                  <span className="text-slate-700 dark:text-slate-300 font-medium">{m.ordersLast24h}</span>
                  <span className="text-slate-400 dark:text-slate-500">/24h</span>
                </span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Auto-refreshes every 60s. <span className="text-slate-400">Updated {relativeAgo(data.checkedAt)}.</span>
      </div>
    </Card>
  )
}

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
  id: string
  marketplaceId: string
  code: string
  name: string
  currency: string
  isActive: boolean
  isParticipating: boolean
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
  // MS.5 — per-row toggle busy state so we don't double-fire while a
  // PATCH is in flight.
  const [busy, setBusy] = useState<Set<string>>(new Set())

  // Optimistically flip + PATCH the marketplace's isActive flag.
  // Cron picks up the change on the next 15-min tick (or sooner if
  // the operator triggers a manual sync).
  const toggleActive = async (row: MarketRow) => {
    if (busy.has(row.id)) return
    setBusy((s) => new Set(s).add(row.id))
    setData((d) =>
      d
        ? {
            ...d,
            markets: d.markets.map((m) =>
              m.id === row.id ? { ...m, isActive: !m.isActive } : m,
            ),
          }
        : d,
    )
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/admin/marketplace-config/${row.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !row.isActive }),
        },
      )
      if (!res.ok) throw new Error(`${res.status}`)
      // Re-fetch so the rollup counts reflect the new state.
      await load()
    } catch {
      // Roll back the optimistic flip on failure.
      setData((d) =>
        d
          ? {
              ...d,
              markets: d.markets.map((m) =>
                m.id === row.id ? { ...m, isActive: row.isActive } : m,
              ),
            }
          : d,
      )
    } finally {
      setBusy((s) => {
        const next = new Set(s)
        next.delete(row.id)
        return next
      })
    }
  }

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

  const activeCount = data.markets.filter((m) => m.isActive).length
  const totalKnown = data.markets.length
  const r = data.rollup

  return (
    <Card
      title="Market ingest health"
      description={`${activeCount} of ${totalKnown} Amazon EU markets actively ingesting · ${r.active} active · ${r.quiet} quiet · ${r.silent} silent · ${r.never} no orders ever`}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {data.markets.map((m) => {
          const tone = STATUS_TONE[m.status]
          const isBusy = busy.has(m.id)
          const inactiveStyle = !m.isActive ? 'opacity-50 grayscale' : ''
          return (
            <div
              key={m.marketplaceId}
              className={`relative px-3 py-2 rounded border border-slate-200 dark:border-slate-700 transition-opacity ${m.isActive && m.status === 'silent' ? 'bg-rose-50/40 dark:bg-rose-950/20' : ''} ${inactiveStyle}`}
              title={
                !m.isActive
                  ? 'Ingest disabled — cron skips this market on every tick. Toggle on to resume.'
                  : m.lastOrderAt
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
              {/* MS.5 — operator toggle. Optimistic flip + PATCH. */}
              <button
                type="button"
                onClick={() => toggleActive(m)}
                disabled={isBusy}
                className={`mt-2 w-full h-6 text-[11px] font-medium rounded transition-colors disabled:opacity-50 ${
                  m.isActive
                    ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200'
                    : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800 dark:bg-emerald-950/60 dark:hover:bg-emerald-950 dark:text-emerald-300'
                }`}
                title={m.isActive ? 'Disable cron ingest for this marketplace' : 'Enable cron ingest for this marketplace'}
              >
                {isBusy ? '…' : m.isActive ? 'Ingest: ON' : 'Ingest: OFF'}
              </button>
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

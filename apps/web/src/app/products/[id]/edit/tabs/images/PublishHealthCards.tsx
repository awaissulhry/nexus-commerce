'use client'

// PB.13 — Per-channel publish health cards. Compact 3-card row at
// the top of the Images tab summarising channel publish performance
// from existing UnifiedJob data — no new endpoint or schema.
//
// Per card:
//   • Last published — relative time (or "never")
//   • 30d publishes  — count of attempts in last 30 days
//   • Success rate   — DONE / settled
//   • Avg duration   — mean of completedAt − submittedAt for DONE
//   • Recent errors  — count + most recent error short tag
//
// Click a card to filter the publish-history accordion to that
// channel (jump via PB.2's data-publish-anchor doesn't apply here —
// this is a different navigation: scroll to history + open the
// channel section).

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, ShoppingBag, Store } from 'lucide-react'
import { cn } from '@/lib/utils'
import { beFetch } from './api'

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

interface UnifiedJob {
  id: string
  channel: Channel
  marketplace: string | null
  status: string
  errorMessage: string | null
  submittedAt: string
  completedAt: string | null
}

interface ChannelStats {
  total30d: number
  done: number
  failed: number
  inFlight: number
  successRate: number | null
  avgDurationMs: number | null
  lastPublishedAt: string | null
  lastError: string | null
}

interface Props {
  productId: string
  /** Bumped by ImagesTab on publish events so the cards re-fetch
   *  without a full reload. */
  refreshKey?: number
}

function elapsed(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return '<1s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function aggregate(jobs: UnifiedJob[], channel: Channel): ChannelStats {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000
  const inWindow = jobs.filter((j) => j.channel === channel && new Date(j.submittedAt).getTime() >= since)
  const done = inWindow.filter((j) => j.status === 'DONE').length
  const failed = inWindow.filter((j) => j.status === 'FATAL' || j.status === 'ERROR' || j.status === 'CANCELLED').length
  const inFlight = inWindow.filter((j) => !['DONE', 'FATAL', 'ERROR', 'CANCELLED'].includes(j.status)).length
  const settled = done + failed
  const successRate = settled === 0 ? null : Math.round((done / settled) * 100)

  const durations = inWindow
    .filter((j) => j.status === 'DONE' && j.completedAt)
    .map((j) => new Date(j.completedAt!).getTime() - new Date(j.submittedAt).getTime())
    .filter((d) => d > 0)
  const avgDurationMs = durations.length === 0
    ? null
    : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)

  // Most recent DONE across all time, not just window — operator
  // wants to know "when did this channel last work" even if it's
  // outside the 30d window.
  const allDone = jobs
    .filter((j) => j.channel === channel && j.status === 'DONE' && j.completedAt)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  const lastPublishedAt = allDone[0]?.completedAt ?? null

  // Most recent error (any settled error) in window — short hint.
  const recentError = inWindow
    .filter((j) => (j.status === 'FATAL' || j.status === 'ERROR') && j.errorMessage)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
  const lastError = recentError?.errorMessage ?? null

  return {
    total30d: inWindow.length,
    done,
    failed,
    inFlight,
    successRate,
    avgDurationMs,
    lastPublishedAt,
    lastError,
  }
}

export default function PublishHealthCards({ productId, refreshKey = 0 }: Props) {
  const [jobs, setJobs] = useState<UnifiedJob[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    beFetch(`/api/products/${productId}/image-publish-jobs?limit=100`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ jobs: UnifiedJob[] }>
      })
      .then((body) => {
        if (cancelled) return
        setJobs(body.jobs ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Health fetch failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [productId, refreshKey])

  const stats = useMemo(() => ({
    amazon: aggregate(jobs, 'AMAZON'),
    ebay: aggregate(jobs, 'EBAY'),
    shopify: aggregate(jobs, 'SHOPIFY'),
  }), [jobs])

  // Hide entirely on first load when there's no data — the card
  // would just be empty placeholders.
  const hasAnyData = jobs.length > 0
  if (!hasAnyData && !loading && !error) return null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
      <HealthCard
        title="Amazon"
        icon={<AmazonGlyph />}
        accent="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
        stats={stats.amazon}
        loading={loading}
        error={error}
      />
      <HealthCard
        title="eBay"
        icon={<ShoppingBag className="w-3.5 h-3.5" />}
        accent="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
        stats={stats.ebay}
        loading={loading}
        error={error}
      />
      <HealthCard
        title="Shopify"
        icon={<Store className="w-3.5 h-3.5" />}
        accent="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
        stats={stats.shopify}
        loading={loading}
        error={error}
      />
    </div>
  )
}

function AmazonGlyph() {
  return (
    <span className="text-[10px] font-mono font-bold inline-flex items-center justify-center w-3.5 h-3.5">A</span>
  )
}

function HealthCard({
  title,
  icon,
  accent,
  stats,
  loading,
  error,
}: {
  title: string
  icon: React.ReactNode
  accent: string
  stats: ChannelStats
  loading: boolean
  error: string | null
}) {
  const rateTone = stats.successRate === null
    ? 'text-slate-400'
    : stats.successRate >= 90
      ? 'text-emerald-600 dark:text-emerald-400'
      : stats.successRate >= 70
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-rose-600 dark:text-rose-400'

  return (
    <div className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded font-semibold flex-shrink-0', accent)}>
          {icon}
        </span>
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{title}</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-slate-400 ml-auto" />}
        {!loading && stats.inFlight > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-px rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ml-auto">
            {stats.inFlight} in flight
          </span>
        )}
      </div>

      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400 truncate">{error}</div>
      )}

      {!error && (
        <>
          <div className="grid grid-cols-3 gap-1.5 text-[11px]">
            <Stat
              label="Last"
              value={stats.lastPublishedAt ? elapsed(stats.lastPublishedAt) : 'never'}
              valueClass="font-mono"
            />
            <Stat
              label="Success"
              value={stats.successRate === null ? '—' : `${stats.successRate}%`}
              valueClass={cn('font-mono tabular-nums font-semibold', rateTone)}
            />
            <Stat
              label="Avg"
              value={formatDuration(stats.avgDurationMs)}
              valueClass="font-mono tabular-nums"
            />
          </div>
          <div className="flex items-center gap-2 text-[10px] text-slate-400">
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-2.5 h-2.5" />
              {stats.total30d} in 30d
            </span>
            {stats.done > 0 && (
              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-2.5 h-2.5" />
                {stats.done}
              </span>
            )}
            {stats.failed > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-rose-600 dark:text-rose-400"
                title={stats.lastError ?? undefined}
              >
                <AlertTriangle className="w-2.5 h-2.5" />
                {stats.failed}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase font-semibold tracking-wide text-slate-400">{label}</span>
      <span className={cn('text-[11px] text-slate-700 dark:text-slate-300', valueClass)}>{value}</span>
    </div>
  )
}

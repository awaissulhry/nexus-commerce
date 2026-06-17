'use client'

/**
 * R0.3 — Amazon Reports hub (docs/AMAZON_DATA_STRATEGY.md).
 *
 * Mirrors Seller Central's report repository inside Nexus: every Amazon
 * data feed with its source, cadence, status, and freshness ("as of …"),
 * plus per-feed pull history and a "Refresh freshness" action. Reads the
 * R0.2 registry endpoints (GET /api/amazon/reports[/runs], POST …/backfill).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  Database,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronRight,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface FeedRow {
  reportType: string
  label: string
  source: string
  cadence: string
  cronJob: string | null
  status: string
  freshAsOf: string | null
  lastPulledAt: string | null
  rowCount: number | null
}

interface RunRow {
  id: string
  reportType: string
  marketplace: string | null
  source: string
  status: string
  reportId: string | null
  rowCount: number | null
  freshAsOf: string | null
  triggeredBy: string | null
  errorMessage: string | null
  requestedAt: string
  completedAt: string | null
}

function ago(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString()
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'DONE'
      ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
      : status === 'IN_PROGRESS'
        ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900'
        : status === 'FATAL' || status === 'CANCELLED'
          ? 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900'
          : 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border-default dark:border-slate-700'
  const Icon =
    status === 'DONE'
      ? CheckCircle2
      : status === 'IN_PROGRESS'
        ? Loader2
        : status === 'FATAL' || status === 'CANCELLED'
          ? XCircle
          : Clock
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm border rounded px-1.5 py-0.5 ${tone}`}
    >
      <Icon
        className={`w-3 h-3 ${status === 'IN_PROGRESS' ? 'animate-spin' : ''}`}
      />
      {status}
    </span>
  )
}

export default function AmazonReportsClient() {
  const backend = getBackendUrl()
  const [feeds, setFeeds] = useState<FeedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, RunRow[]>>({})

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${backend}/api/amazon/reports`, {
        cache: 'no-store',
      })
      const d = await r.json().catch(() => null)
      setFeeds(d?.reports ?? [])
    } catch {
      setError('Could not load reports.')
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      await fetch(`${backend}/api/amazon/reports/backfill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      await load()
    } catch {
      setError('Refresh failed.')
    } finally {
      setRefreshing(false)
    }
  }, [backend, load])

  const toggleRuns = useCallback(
    async (reportType: string) => {
      if (expanded === reportType) {
        setExpanded(null)
        return
      }
      setExpanded(reportType)
      if (!runs[reportType]) {
        try {
          const r = await fetch(
            `${backend}/api/amazon/reports/runs?reportType=${encodeURIComponent(reportType)}&limit=10`,
            { cache: 'no-store' },
          )
          const d = await r.json().catch(() => null)
          setRuns((prev) => ({ ...prev, [reportType]: d?.runs ?? [] }))
        } catch {
          setRuns((prev) => ({ ...prev, [reportType]: [] }))
        }
      }
    },
    [backend, expanded, runs],
  )

  const fresh = feeds.filter((f) => f.status === 'DONE').length

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <Link
          href="/insights"
          className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Insights
        </Link>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <Database className="w-5 h-5" /> Amazon Reports
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            The exact reports Amazon produces, mirrored in Nexus — each feed
            with its source and how fresh it is. Money data (settlements,
            finances) is on Amazon&apos;s batch schedule; we match Seller
            Central, never beat it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="h-9 px-3 text-base border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50 flex-shrink-0"
        >
          {refreshing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Refresh freshness
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-base text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> loading…
        </div>
      ) : (
        <>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {fresh} of {feeds.length} feeds with a recorded pull.
          </div>
          <div className="border border-default dark:border-slate-700 rounded-md overflow-hidden">
            <table className="w-full text-base">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 text-sm">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Feed</th>
                  <th className="text-left font-medium px-3 py-2">Source</th>
                  <th className="text-left font-medium px-3 py-2">Cadence</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-right font-medium px-3 py-2">Fresh as of</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map((f) => (
                  <FeedRows
                    key={f.reportType}
                    feed={f}
                    expanded={expanded === f.reportType}
                    runs={runs[f.reportType]}
                    onToggle={() => void toggleRuns(f.reportType)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function FeedRows({
  feed,
  expanded,
  runs,
  onToggle,
}: {
  feed: FeedRow
  expanded: boolean
  runs: RunRow[] | undefined
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className="border-t border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2">
          <div className="inline-flex items-center gap-1.5">
            <ChevronRight
              className={`w-3.5 h-3.5 text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            <span className="text-slate-900 dark:text-slate-100">
              {feed.label}
            </span>
          </div>
        </td>
        <td className="px-3 py-2 text-sm text-slate-500">{feed.source}</td>
        <td className="px-3 py-2 text-sm text-slate-500">{feed.cadence}</td>
        <td className="px-3 py-2">
          <StatusBadge status={feed.status} />
        </td>
        <td
          className="px-3 py-2 text-right text-slate-600 dark:text-slate-300"
          title={feed.freshAsOf ?? ''}
        >
          {ago(feed.freshAsOf)}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/60 dark:bg-slate-800/20">
          <td colSpan={5} className="px-3 py-2">
            <div className="text-sm font-mono text-slate-500 dark:text-slate-400 mb-1">
              {feed.reportType}
            </div>
            {!runs ? (
              <div className="text-sm text-tertiary inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> loading runs…
              </div>
            ) : runs.length === 0 ? (
              <div className="text-sm text-tertiary">
                No recorded pulls yet — will populate on the next sync.
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="text-slate-500 dark:text-slate-400">
                      <td className="py-0.5 pr-3">{r.status}</td>
                      <td className="py-0.5 pr-3">{r.triggeredBy ?? '—'}</td>
                      <td className="py-0.5 pr-3">
                        {r.marketplace ?? 'account-wide'}
                      </td>
                      <td className="py-0.5 pr-3 text-right">
                        {ago(r.completedAt ?? r.requestedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

'use client'

/**
 * P.1b — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. Pulls /api/listings/health and
 * surfaces:
 *   - Top stat strip: Errors / Suppressed / Drafts / Pending-sync
 *   - Recent failed listings list (per-channel deep-link)
 *
 * Refreshes when listing/sync events fire across tabs (P.5
 * useInvalidationChannel subscription).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { CHANNEL_TONE } from '@/lib/products/theme'

interface HealthData {
  errorCount: number
  suppressedCount: number
  draftCount: number
  pendingSyncCount: number
  recentErrors: Array<{
    id: string
    channel: string
    marketplace: string
    productSku: string
    productName: string
    lastSyncError?: string
  }>
}

export function HealthLens() {
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  // P.5 — split state for the error case so the previous failure
  // doesn't get masked by a stale `data` from the last successful
  // load. Was: 5xx responses were parsed as JSON and stored as
  // `data`, which then rendered as "—" everywhere instead of an
  // honest failure banner.
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/health`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // P.5 — refresh when listings change in any tab so the lens
  // reflects the latest sync status without manual reload.
  useInvalidationChannel(
    ['listing.updated', 'listing.created', 'listing.deleted', 'bulk-job.completed'],
    () => {
      void refresh()
    },
  )

  if (loading && !data)
    return (
      <Card>
        <div
          role="status"
          aria-live="polite"
          className="text-md text-slate-500 dark:text-slate-400 py-8 text-center"
        >
          Loading health…
        </div>
      </Card>
    )
  if (error)
    return (
      <Card>
        <div
          role="alert"
          className="py-8 text-center space-y-2"
        >
          <div className="text-md text-rose-600 dark:text-rose-400">
            Failed to load health: {error}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="h-7 px-3 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 inline-flex items-center gap-1.5"
          >
            Retry
          </button>
        </div>
      </Card>
    )
  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HealthStat label="Errors" value={data.errorCount} tone="danger" />
        <HealthStat label="Suppressed" value={data.suppressedCount} tone="warning" />
        <HealthStat label="Drafts" value={data.draftCount} tone="default" />
        <HealthStat label="Pending sync" value={data.pendingSyncCount} tone="info" />
      </div>
      <Card title="Recent failed listings">
        {data.recentErrors.length === 0 ? (
          <div className="py-6 text-base text-slate-400 dark:text-slate-500 text-center">
            No errors right now
          </div>
        ) : (
          <ul className="space-y-1 -my-1">
            {data.recentErrors.slice(0, 30).map((e) => (
              <li key={e.id}>
                <Link
                  href={`/listings/${e.channel.toLowerCase()}?search=${encodeURIComponent(e.productSku)}`}
                  className="flex items-start justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <span
                      className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[e.channel]}`}
                    >
                      {e.channel}
                    </span>
                    <span className="text-sm font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {e.marketplace}
                    </span>
                    <div className="min-w-0">
                      <div className="text-base text-slate-900 dark:text-slate-100 truncate">
                        {e.productName}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                        {e.productSku}
                      </div>
                      {e.lastSyncError && (
                        <div className="text-xs text-rose-600 dark:text-rose-400 truncate mt-0.5">
                          {e.lastSyncError}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function HealthStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'danger' | 'warning' | 'info' | 'default'
}) {
  const tones = {
    danger: 'text-rose-600 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/40',
    warning: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40',
    info: 'text-blue-600 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40',
    default: 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800',
  }[tone]
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded inline-flex items-center justify-center ${tones}`}>
          <AlertTriangle size={18} />
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {value}
          </div>
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {label}
          </div>
        </div>
      </div>
    </Card>
  )
}

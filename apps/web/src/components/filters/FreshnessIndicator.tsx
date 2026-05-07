/**
 * Phase 10e — FreshnessIndicator.
 *
 * Compact "data is X seconds old" badge mounted in page headers.
 * Updates the displayed age every 10 seconds so the user can tell
 * at a glance whether they're looking at fresh state. When data
 * crosses the stale threshold (default 60s) the badge shifts to an
 * amber tone with a "Refresh" button.
 *
 * Used by the same five pages that mount UniversalFilterBar so the
 * "this page is alive and listening" signal is consistent.
 */

'use client'

import { useEffect, useState } from 'react'
import { Clock, RefreshCw, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FreshnessIndicatorProps {
  /** ms since epoch of the last successful fetch. */
  lastFetchedAt: number | null
  /** Optional refresh trigger; renders as the click handler on the badge. */
  onRefresh?: () => void
  /** True while a fetch is currently in flight. */
  loading?: boolean
  /** Last fetch errored; renders red. */
  error?: boolean
  /** ms after which the badge tips to amber "stale". Default 60_000. */
  staleAfterMs?: number
  className?: string
}

export default function FreshnessIndicator({
  lastFetchedAt,
  onRefresh,
  loading,
  error,
  staleAfterMs = 60_000,
  className,
}: FreshnessIndicatorProps) {
  // The "now" state ticks every 10s so the displayed age is accurate
  // without re-rendering the entire page tree. 10s is a good
  // compromise: granular enough to feel alive, infrequent enough
  // not to thrash.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(id)
  }, [])

  const ageMs = lastFetchedAt ? Math.max(0, now - lastFetchedAt) : null
  const isStale = ageMs != null && ageMs > staleAfterMs

  const tone = error
    ? 'border-rose-200 bg-rose-50 text-rose-700'
    : isStale
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-slate-200 bg-white text-slate-600'

  const Icon = error ? AlertCircle : Clock
  const label = (() => {
    if (error) return 'Refresh failed'
    if (loading && !lastFetchedAt) return 'Loading…'
    if (loading) return 'Refreshing…'
    if (ageMs == null) return 'No data'
    return `Updated ${formatAge(ageMs)} ago`
  })()

  const interactive = !!onRefresh
  const Wrapper = interactive ? 'button' : 'span'

  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onRefresh : undefined}
      title={
        interactive
          ? 'Click to refresh'
          : lastFetchedAt
          ? new Date(lastFetchedAt).toLocaleString()
          : undefined
      }
      className={cn(
        'inline-flex items-center gap-1.5 h-6 px-2 text-sm rounded-md border transition-colors',
        tone,
        interactive && 'hover:border-slate-300 cursor-pointer',
        className,
      )}
    >
      {loading ? (
        <RefreshCw className="w-3 h-3 animate-spin" />
      ) : (
        <Icon className="w-3 h-3" />
      )}
      <span>{label}</span>
      {interactive && !loading && (isStale || error) && (
        <span className="ml-0.5 opacity-70">·&nbsp;refresh</span>
      )}
    </Wrapper>
  )
}

/**
 * Human-friendly relative time. Stays compact (no "approximately",
 * no "just now") so the badge fits in a header row across sizes.
 */
function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  return `${day}d`
}

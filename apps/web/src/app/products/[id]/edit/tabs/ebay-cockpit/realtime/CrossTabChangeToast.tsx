'use client'

// EC.3.3 — CrossTabChangeToast
//
// Slim banner that surfaces when upstream data for this product
// changed while the cockpit was open — either the master record
// (Master / Aliexpress / Pricing tabs), the per-marketplace
// translation (LocalesTab), or a sibling marketplace's listing.
//
// One click "Refresh" rerenders the cockpit with the new data via
// router.refresh(). Auto-dismisses after manual refresh or 30s.
// Multiple distinct change kinds stack into a single toast so the
// operator gets one decision point, not three.

import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

interface Props {
  masterChangedAt: number | null
  listingUpdatedAt: number | null
  siblingChangedAt: number | null
  /** Optional: callbacks fire after the refresh kicks off so the
   *  cockpit can reset Field Source provenance or unmark dirty flags
   *  if needed. */
  onRefreshed?: () => void
}

function relativeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

export default function CrossTabChangeToast({
  masterChangedAt,
  listingUpdatedAt,
  siblingChangedAt,
  onRefreshed,
}: Props) {
  const router = useRouter()
  const [dismissed, setDismissed] = useState(0) // most recent ts the user dismissed
  const [, setTick] = useState(0)

  // Re-tick once per 5s so "Xs ago" stays honest.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) % 100_000), 5000)
    return () => window.clearInterval(id)
  }, [])

  const changes = useMemo(() => {
    const out: Array<{ kind: 'master' | 'listing' | 'sibling'; ts: number; label: string }> = []
    if (masterChangedAt && masterChangedAt > dismissed) {
      out.push({ kind: 'master', ts: masterChangedAt, label: 'Master record changed' })
    }
    if (listingUpdatedAt && listingUpdatedAt > dismissed) {
      out.push({ kind: 'listing', ts: listingUpdatedAt, label: 'This listing changed elsewhere' })
    }
    if (siblingChangedAt && siblingChangedAt > dismissed) {
      out.push({ kind: 'sibling', ts: siblingChangedAt, label: 'A sibling marketplace listing changed' })
    }
    return out
  }, [masterChangedAt, listingUpdatedAt, siblingChangedAt, dismissed])

  // 30s auto-dismiss timer.
  useEffect(() => {
    if (changes.length === 0) return
    const newest = Math.max(...changes.map((c) => c.ts))
    const remaining = 30_000 - (Date.now() - newest)
    if (remaining <= 0) {
      setDismissed(newest)
      return
    }
    const id = window.setTimeout(() => setDismissed(newest), remaining)
    return () => window.clearTimeout(id)
  }, [changes])

  if (changes.length === 0) return null

  const newest = Math.max(...changes.map((c) => c.ts))
  const handleRefresh = () => {
    setDismissed(newest)
    router.refresh()
    onRefreshed?.()
  }
  const handleDismiss = () => setDismissed(newest)

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded border text-xs',
        'border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/30',
        'text-blue-900 dark:text-blue-200',
      )}
    >
      <RefreshCw className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {changes.length === 1
            ? changes[0]!.label
            : `${changes.length} upstream changes detected`}
        </div>
        <div className="text-[10.5px] text-blue-700/80 dark:text-blue-300/80 mt-0.5 flex items-center gap-2 flex-wrap">
          {changes.map((c) => (
            <span key={c.kind}>
              {c.kind === 'master' ? 'Master' : c.kind === 'listing' ? 'Listing' : 'Sibling'} ·{' '}
              {relativeAgo(c.ts)}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={handleRefresh}
        className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-medium whitespace-nowrap"
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        className="p-1 text-blue-500 hover:text-blue-800 dark:hover:text-blue-200 rounded"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

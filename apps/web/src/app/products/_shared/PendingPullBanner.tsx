'use client'

/**
 * PendingPullBanner — Phase 5 auto-resume surface.
 *
 * Shown when the editor mount probe finds a completed-but-unreviewed
 * pull job for this (channel, marketplace [, productType]). Lets the
 * operator open the diff modal to apply the cached results — the rows
 * are loaded from FlatFilePullJob.rows, not re-fetched from
 * SP-API / Sell API.
 */

import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!then || isNaN(then)) return ''
  const deltaSec = Math.round((then - Date.now()) / 1000)
  const abs = Math.abs(deltaSec)
  if (abs < 60)    return RELATIVE_FORMATTER.format(deltaSec, 'second')
  if (abs < 3600)  return RELATIVE_FORMATTER.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return RELATIVE_FORMATTER.format(Math.round(deltaSec / 3600), 'hour')
  return RELATIVE_FORMATTER.format(Math.round(deltaSec / 86400), 'day')
}

export interface PendingPullBannerProps {
  channelLabel: string       // 'Amazon' or 'eBay'
  marketplace: string
  rowCount: number
  doneAt: string | null
  onReview: () => void
  onDismiss: () => void
}

export function PendingPullBanner({
  channelLabel, marketplace, rowCount, doneAt, onReview, onDismiss,
}: PendingPullBannerProps) {
  return (
    <div className="px-4 py-2 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-900 flex items-center gap-3 text-sm flex-shrink-0">
      <Download className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
      <div className="flex-1 text-blue-900 dark:text-blue-100">
        Your last pull from {channelLabel} {marketplace}
        {' '}
        <span className="font-semibold">({rowCount} row{rowCount === 1 ? '' : 's'})</span>
        {' '}finished {relativeTime(doneAt)}. Review and apply?
      </div>
      <Button size="sm" onClick={onReview}>
        Review changes
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss — clears the banner; the pull still shows in history"
        className="text-blue-400 hover:text-blue-700 dark:hover:text-blue-200 p-1 rounded"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

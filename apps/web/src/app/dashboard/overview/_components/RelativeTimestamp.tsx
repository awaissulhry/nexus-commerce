'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { T } from '../_lib/types'

/**
 * Live-updating "5s ago / 2m ago / 1h ago" label. Re-renders on a
 * 5-second tick so the Command Center's "last refreshed" indicator
 * stays current without poking the API. Tone shifts emerald → slate
 * → amber as the value ages, so a stale dashboard reads as stale at
 * a glance.
 */
export default function RelativeTimestamp({
  t,
  at,
  compact = false,
}: {
  t: T
  at: number
  compact?: boolean
}) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = globalThis.setInterval(() => force((n) => n + 1), 5_000)
    return () => globalThis.clearInterval(id)
  }, [])
  if (!Number.isFinite(at)) return null
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  const label =
    seconds < 5
      ? t('overview.relTime.justNow')
      : seconds < 60
      ? t('overview.relTime.seconds', { n: seconds })
      : seconds < 3600
      ? t('overview.relTime.minutes', { n: Math.floor(seconds / 60) })
      : t('overview.relTime.hours', { n: Math.floor(seconds / 3600) })
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums whitespace-nowrap',
        seconds < 30
          ? 'text-emerald-600 dark:text-emerald-400'
          : seconds < 120
          ? 'text-slate-500 dark:text-slate-400'
          : 'text-amber-600 dark:text-amber-400',
      )}
      title={`${new Date(at).toLocaleString()}`}
    >
      {!compact && (
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      )}
      {label}
    </span>
  )
}

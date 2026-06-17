'use client'

// PO.4 — connection-state chip for the PO SSE pipe.
//
// Differs from /orders' LiveSyncBadge (LS.3) which talks to an Amazon
// SP-API sync-health endpoint. POs don't depend on external push, so
// this chip is simpler: it just reflects whether the in-process SSE
// stream is open + how recently the last event landed.
//
//   ● Live              (emerald)  — stream connected
//   ● Live · 12s ago    (emerald)  — connected, recent event
//   ◌ Reconnecting…     (slate)    — EventSource is between retries
//
// Updates every 5s so the "Xs ago" label stays fresh without
// re-rendering the parent.

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface PoLiveSyncChipProps {
  connected: boolean
  lastEventAt: number | null
}

function relativeAgo(ms: number | null): string | null {
  if (ms == null) return null
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function PoLiveSyncChip({ connected, lastEventAt }: PoLiveSyncChipProps) {
  // Tick every 5s so the "Xs ago" label rolls forward without parent
  // re-renders.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 5000)
    return () => window.clearInterval(id)
  }, [])

  const ago = relativeAgo(lastEventAt)

  if (!connected) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 h-7 text-sm rounded-md border border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
        title="Reconnecting to the live event stream…"
      >
        <span className="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500 animate-pulse" />
        Reconnecting…
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 h-7 text-sm rounded-md border',
        'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
      )}
      title={
        ago
          ? `Last PO event ${ago}`
          : 'Connected — waiting for the first PO event'
      }
    >
      <span className="w-2 h-2 rounded-full bg-emerald-500" />
      Live{ago ? ` · ${ago}` : ''}
    </span>
  )
}

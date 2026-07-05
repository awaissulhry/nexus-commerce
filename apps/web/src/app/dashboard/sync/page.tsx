'use client'

/**
 * H.13 — sync health dashboard.
 *
 * Distinct from /dashboard/health (which covers marketplace vitals +
 * conflict resolution). This page is operationally tighter: queue
 * depth, per-channel sync status, recent errors. Use it when
 * something feels off and you need to triage in one screen.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the old server-side fetch 401'd and
 * everyone stared at "Loading sync health…" until the first 30s poll tick.
 * The initial load MUST run client-side where the patched window.fetch adds
 * credentials; SyncHealthClient keeps polling every 30s for live counts.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import SyncHealthClient from './SyncHealthClient'

export default function SyncHealthPage() {
  const [state, setState] = useState<{ initial: unknown } | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      let initial: unknown = null
      try {
        const res = await fetch(`${getBackendUrl()}/api/dashboard/health`, {
          cache: 'no-store',
        })
        initial = res.ok ? await res.json() : null
      } catch {
        initial = null
      }
      if (alive) setState({ initial })
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!state) {
    // Mirrors SyncHealthClient's own empty state so the swap is seamless.
    return (
      <div
        className="px-6 py-12 text-center text-base text-tertiary dark:text-slate-500 italic"
        aria-busy="true"
      >
        <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
        Loading sync health…
      </div>
    )
  }

  return <SyncHealthClient initial={state.initial as any} />
}

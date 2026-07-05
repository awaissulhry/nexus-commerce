'use client'

/**
 * MC.9.2 — Client-side data loader for the Brand Story builder.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the story detail MUST load
 * client-side where the fetch patch adds credentials. Server-side this
 * fetch 401'd into "Failed to load Brand Story (status 401)" for everyone.
 *
 * `refreshToken` comes from the server page render (Date.now() under
 * force-dynamic): the builder calls router.refresh() after submit /
 * schedule / version-restore, which re-renders the server page, mints a
 * new token, and re-triggers this fetch — the fresh `initial` object then
 * flows into the builder's prop-sync effect, exactly as before.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import BrandStoryBuilderClient from '../_components/BrandStoryBuilderClient'
import type { BrandStoryDetail } from '../_lib/types'

type LoadState =
  | { kind: 'ok'; story: BrandStoryDetail }
  | { kind: 'notfound' }
  | { kind: 'error'; status: number }

export default function BrandStoryBuilderLoader({
  id,
  refreshToken,
}: {
  id: string
  refreshToken: number
}) {
  const [state, setState] = useState<{ id: string; result: LoadState } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/brand-stories/${encodeURIComponent(id)}`,
          { cache: 'no-store' },
        )
        if (cancelled) return
        if (res.status === 404) {
          setState({ id, result: { kind: 'notfound' } })
          return
        }
        if (!res.ok) {
          setState({ id, result: { kind: 'error', status: res.status } })
          return
        }
        const data = (await res.json()) as { story: BrandStoryDetail }
        if (!cancelled) setState({ id, result: { kind: 'ok', story: data.story } })
      } catch {
        if (!cancelled) setState({ id, result: { kind: 'error', status: 0 } })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, refreshToken])

  // Drop stale data when navigating between stories.
  const current = state && state.id === id ? state.result : null

  if (!current) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-96 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800" />
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading Brand Story…</p>
      </div>
    )
  }

  if (current.kind === 'notfound') notFound()

  if (current.kind === 'error') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        Failed to load Brand Story (status {current.status}).
      </div>
    )
  }

  return <BrandStoryBuilderClient initial={current.story} apiBase={getBackendUrl()} />
}

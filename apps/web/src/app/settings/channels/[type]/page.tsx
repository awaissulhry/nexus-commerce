'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side fetch 401'd and
// everyone saw "Failed to load channel detail (HTTP 401)" in prod. Data MUST
// load client-side where the patched window.fetch adds credentials.

import { useEffect, useState } from 'react'
import { notFound, useParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import ChannelDetailClient, {
  type ChannelDetail,
} from './ChannelDetailClient'

const KNOWN = new Set(['amazon', 'ebay', 'shopify', 'woocommerce', 'etsy'])

export default function ChannelDetailPage() {
  const params = useParams<{ type: string }>()
  const lower = (params?.type ?? '').toLowerCase()
  const known = KNOWN.has(lower)

  const [state, setState] = useState<{
    detail: ChannelDetail | null
    loadError: string | null
  } | null>(null)

  useEffect(() => {
    if (!known) return
    let alive = true
    ;(async () => {
      let detail: ChannelDetail | null = null
      let loadError: string | null = null
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/settings/channels/${lower}/detail`,
          { cache: 'no-store' },
        )
        if (!res.ok) {
          loadError = `Failed to load channel detail (HTTP ${res.status})`
        } else {
          detail = (await res.json()) as ChannelDetail
        }
      } catch (err: any) {
        loadError = err?.message ?? String(err)
      }
      if (alive) setState({ detail, loadError })
    })()
    return () => {
      alive = false
    }
  }, [known, lower])

  if (!known) notFound()

  if (!state) {
    return (
      <div className="max-w-3xl space-y-6" aria-busy="true">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          All channels
        </div>
        <h1 className="text-base font-semibold capitalize text-slate-900 dark:text-slate-100">
          {lower}
        </h1>
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <ChannelDetailClient
      channelType={lower}
      initial={state.detail}
      initialError={state.loadError}
    />
  )
}

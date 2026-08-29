'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side fetch 401'd and
// everyone saw "Failed to load channel detail (HTTP 401)" in prod. Data MUST
// load client-side where the patched window.fetch adds credentials.

import { useEffect, useState } from 'react'
import { notFound, useParams } from 'next/navigation'
import { Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import ChannelDetailClient from './ChannelDetailClient'
import { CHANNEL_LABEL, PAGE_MAX_WIDTH, type ChannelDetail } from './channelDetail'

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
    // Same width and rhythm as the loaded page (header, then four cards) so nothing jumps.
    return (
      <div
        style={{ maxWidth: PAGE_MAX_WIDTH, display: 'grid', gap: 'var(--nds-space-20)' }}
        aria-busy="true"
        aria-label={`Loading ${CHANNEL_LABEL[lower] ?? lower}`}
      >
        <div style={{ display: 'grid', gap: 'var(--nds-space-8)' }}>
          <Skeleton width={96} height={12} />
          <Skeleton width={200} height={22} />
          <Skeleton width={260} height={14} />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} height={120} radius="var(--nds-radius-lg)" />
        ))}
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

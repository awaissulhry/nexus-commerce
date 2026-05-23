'use client'

// IA.5 — Surfaces ListingImage rows that are stale on the channel
// (master image updated AFTER last successful publish). One-click
// "Re-publish stale" calls the standard publish endpoint with the
// variantIds filter so we don't reflood every ASIN.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { beFetch } from '../api'

interface StaleResponse {
  productId: string
  marketplace: string
  totalStaleRows: number
  staleAsins: string[]
  staleVariantIds: string[]
}

interface Props {
  productId: string
  marketplace: string                // 'IT' | 'DE' | 'FR' | 'ES' | 'UK' (banner hidden on ALL)
  activeAxis: string
  /** Refetch trigger — bump when a publish completes so the banner
   *  clears itself without a hard reload. */
  refreshKey?: number
  onToast?: (msg: string) => void
  /** Fired after a successful publish-stale submission so the parent
   *  can poll feed status or refresh the workspace. */
  onSubmitted?: () => void
}

export default function StaleBanner({
  productId,
  marketplace,
  activeAxis,
  refreshKey,
  onToast,
  onSubmitted,
}: Props) {
  const [data, setData] = useState<StaleResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const fetchStale = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ marketplace })
      const res = await beFetch(`/api/products/${productId}/amazon-images/stale?${qs.toString()}`)
      if (!res.ok) {
        setData(null)
        return
      }
      const body = await res.json() as StaleResponse
      setData(body)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [productId, marketplace])

  useEffect(() => { void fetchStale() }, [fetchStale, refreshKey])

  async function publishStale() {
    if (!data || data.staleVariantIds.length === 0) return
    setSubmitting(true)
    try {
      const res = await beFetch(`/api/products/${productId}/amazon-images/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace,
          activeAxis,
          variantIds: data.staleVariantIds,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // 422 = IA.4 validation hard fails; surface that intelligibly.
        if (res.status === 422 && body?.error === 'VALIDATION_FAILED') {
          onToast?.(body.message ?? 'Validation failed — fix issues then retry')
        } else {
          onToast?.(body?.error ?? `Publish failed: ${res.status}`)
        }
        return
      }
      onToast?.(`Re-publish queued for ${data.staleAsins.length} stale ASIN${data.staleAsins.length === 1 ? '' : 's'}`)
      onSubmitted?.()
      void fetchStale()
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'Publish failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Hide the banner when there's nothing stale OR while we're still
  // figuring it out. No "loading…" flash for the common case (no
  // stale rows) — the operator shouldn't see noise.
  if (loading && !data) return null
  if (!data || data.totalStaleRows === 0) return null

  return (
    <div className="mb-3 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 flex items-center gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
      <div className="flex-1 min-w-0 text-xs">
        <span className="font-medium text-amber-800 dark:text-amber-200">
          {data.staleAsins.length} ASIN{data.staleAsins.length === 1 ? '' : 's'} have stale images on Amazon {marketplace}
        </span>
        <span className="text-amber-700/80 dark:text-amber-300/80 ml-1">
          — master images updated since last publish ({data.totalStaleRows} row{data.totalStaleRows === 1 ? '' : 's'})
        </span>
      </div>
      <Button
        size="sm"
        onClick={() => void publishStale()}
        disabled={submitting}
        className="text-[11px] h-6 gap-1 flex-shrink-0"
      >
        {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Re-publish stale
      </Button>
    </div>
  )
}

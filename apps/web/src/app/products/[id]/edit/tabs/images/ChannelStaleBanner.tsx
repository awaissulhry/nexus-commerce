'use client'

// PB.3d — Stale-detection banner for eBay + Shopify, mirror of
// Amazon's IA.5 StaleBanner.
//
// "Stale" means a ListingImage was successfully published in the past
// (publishStatus = 'PUBLISHED') and its linked master ProductImage
// has been updated since (master.updatedAt > listingImage.publishedAt).
// Nexus is serving the new bytes via IE.6's effective-URL pattern but
// the channel still has the previous version.
//
// Unlike Amazon's banner, this one computes the staleness client-side
// from the workspace fetch — eBay/Shopify don't carry a marketplace
// dimension so the math stays cheap and we skip the round-trip.
//
// Re-publish is just a normal channel publish — there's no per-variant
// filter on eBay/Shopify like Amazon's variantIds (one ReviseItem /
// one product mutation covers the whole product). The banner reuses
// the panel's onPublish prop.

import { useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { ListingImage, ProductImage } from './types'

interface Props {
  channel: 'EBAY' | 'SHOPIFY'
  masterImages: ProductImage[]
  channelImages: ListingImage[]
  /** Re-publish CTA wires straight into the panel's existing handler. */
  onPublish: () => Promise<{ success: boolean; message: string }>
  onToast: (msg: string) => void
  /** Disable the re-publish CTA when the panel is publishing for
   *  some other reason (inline button, modal confirm, global bar). */
  publishingExternally?: boolean
}

export interface StaleSummary {
  total: number
  staleListingIds: string[]
}

export function findStaleListingImages(
  masterImages: ProductImage[],
  channelImages: ListingImage[],
): StaleSummary {
  if (channelImages.length === 0) return { total: 0, staleListingIds: [] }
  const updatedAtById = new Map<string, number>()
  for (const m of masterImages) {
    updatedAtById.set(m.id, new Date(m.updatedAt).getTime())
  }
  const stale: string[] = []
  for (const li of channelImages) {
    if (li.publishStatus !== 'PUBLISHED') continue
    if (!li.sourceProductImageId || !li.publishedAt) continue
    const masterTs = updatedAtById.get(li.sourceProductImageId)
    if (masterTs === undefined) continue
    const publishedTs = new Date(li.publishedAt).getTime()
    if (masterTs > publishedTs) stale.push(li.id)
  }
  return { total: stale.length, staleListingIds: stale }
}

export default function ChannelStaleBanner({
  channel,
  masterImages,
  channelImages,
  onPublish,
  onToast,
  publishingExternally,
}: Props) {
  const [submitting, setSubmitting] = useState(false)

  const { total } = useMemo(
    () => findStaleListingImages(masterImages, channelImages),
    [masterImages, channelImages],
  )

  if (total === 0) return null

  const channelLabel = channel === 'EBAY' ? 'eBay' : 'Shopify'

  async function republish() {
    setSubmitting(true)
    try {
      const result = await onPublish()
      onToast(result.message)
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Re-publish failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-5 mt-3 mb-0 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 flex items-center gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
      <div className="flex-1 min-w-0 text-xs">
        <span className="font-medium text-amber-800 dark:text-amber-200">
          {total} image{total === 1 ? '' : 's'} stale on {channelLabel}
        </span>
        <span className="text-amber-700/80 dark:text-amber-300/80 ml-1">
          — master updated since last publish, channel still serves the previous bytes
        </span>
      </div>
      <Button
        size="sm"
        onClick={() => void republish()}
        disabled={submitting || publishingExternally}
        className="text-[11px] h-6 gap-1 flex-shrink-0"
      >
        {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Re-publish to {channelLabel}
      </Button>
    </div>
  )
}

'use client'
import { useCallback, useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'

// ── Types ─────────────────────────────────────────────────────────────────

interface CuratedImage {
  id: string
  platform: string
  variantGroupKey: string | null
  variantGroupValue: string | null
  position: number
  url: string
  publishStatus?: string
}

interface WorkspaceResponse {
  listing?: CuratedImage[]
  product?: { imageAxisPreference?: string | null; sku?: string }
}

// ── Props ─────────────────────────────────────────────────────────────────

export interface EbayFlatFileImageModalProps {
  open: boolean
  onClose: () => void
  /** productId (familyId) for the family being edited */
  productId: string
}

// ── Component ─────────────────────────────────────────────────────────────

export function EbayFlatFileImageModal({ open, onClose, productId }: EbayFlatFileImageModalProps) {
  const BACKEND = getBackendUrl()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<WorkspaceResponse | null>(null)

  const load = useCallback(() => {
    if (!productId) return
    setLoading(true)
    setError(null)
    fetch(`${BACKEND}/api/products/${productId}/images-workspace`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<WorkspaceResponse>
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [productId, BACKEND])

  useEffect(() => {
    if (open) load()
    else { setData(null); setError(null) }
  }, [open, load])

  // Derive display counts from curated eBay images
  const axis = data?.product?.imageAxisPreference ?? null
  const sku = data?.product?.sku ?? productId
  const ebayImages = (data?.listing ?? []).filter((l) => l.platform === 'EBAY')
  const bucketKeys = new Set(ebayImages.map((l) => l.variantGroupValue ?? '__shared__'))
  const bucketCount = bucketKeys.size
  const totalImages = ebayImages.length

  const subtitleParts = !loading && data
    ? [
        `${bucketCount} bucket${bucketCount !== 1 ? 's' : ''}`,
        `${totalImages} image${totalImages !== 1 ? 's' : ''}`,
        axis ? `Axis: ${axis}` : null,
      ].filter(Boolean).join(' · ')
    : undefined

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`eBay Images · ${sku}`}
      subtitle={subtitleParts}
      size="xl"
    >
      {loading && (
        <div className="space-y-3 py-2">
          <Skeleton height={36} radius={8} />
          <Skeleton height={200} radius={8} />
          <Skeleton height={140} radius={8} />
          <Skeleton height={100} radius={8} />
        </div>
      )}

      {!loading && error && (
        <Banner variant="danger" title="Failed to load images">
          {error}
        </Banner>
      )}

      {!loading && !error && !productId && (
        <Banner variant="warning" title="No product">
          Open this from a product&rsquo;s flat file to manage its eBay images.
        </Banner>
      )}

      {!loading && !error && data && (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <ImageIcon className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-medium text-slate-500">
            {totalImages > 0
              ? `${totalImages} image${totalImages !== 1 ? 's' : ''} curated across ${bucketCount} color bucket${bucketCount !== 1 ? 's' : ''}`
              : 'No eBay images curated yet — image grid coming next'}
          </p>
          {axis && (
            <p className="text-xs mt-1 text-slate-400">Variation axis: {axis}</p>
          )}
        </div>
      )}
    </Modal>
  )
}

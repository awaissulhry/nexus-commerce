'use client'

// IM.4 — Amazon images panel (replaces AmazonPanelStub).
// Marketplace tabs + Color × Slot matrix + publish bar.

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { beFetch } from '../api'
import AmazonMatrix from './AmazonMatrix'
import AmazonPublishBar from './AmazonPublishBar'
import ImagePickerModal from '../ImagePickerModal'
import CrossChannelSyncBar from '../CrossChannelSyncBar'
import {
  useAmazonImages,
  AMAZON_MARKETPLACES,
  type AmazonMarketplace,
  type AmazonSlot,
} from './useAmazonImages'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary, WorkspaceProduct, AmazonJobSummary } from '../types'

interface CopyResult { copied: number; skipped: number }

interface Props {
  productId: string
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  activeAxis: string
  availableAxes: string[]
  onAxisChange: (axis: string) => void
  pendingUpserts: Map<string, PendingUpsert>
  addPendingUpsert: (u: Omit<PendingUpsert, '_tempId'>) => void
  removePendingUpsert: (tempId: string) => void
  amazonJobs: AmazonJobSummary[]
  dirtyCount: number
  onSavePending: () => Promise<boolean>
  onReload: () => void
  onToast: (msg: string) => void
  onCopyToEbayGallery: () => CopyResult
  onCopyToEbayColorSets: () => CopyResult
  onCopyToShopifyPool: () => CopyResult
  onCopyToShopifyAssignments: () => CopyResult
}

const MKT_LABELS: Record<string, string> = {
  ALL: 'All Markets', IT: 'Amazon IT', DE: 'Amazon DE', FR: 'Amazon FR', ES: 'Amazon ES', UK: 'Amazon UK',
}

export default function AmazonPanel({
  productId,
  masterImages,
  listingImages,
  variants,
  activeAxis,
  availableAxes,
  onAxisChange,
  pendingUpserts,
  addPendingUpsert,
  onToast,
  onCopyToEbayGallery,
  onCopyToEbayColorSets,
  onCopyToShopifyPool,
  onCopyToShopifyAssignments,
  removePendingUpsert,
  amazonJobs,
  dirtyCount,
  onSavePending,
  onReload,
}: Props) {
  const noAxisData = variants.length > 0 && availableAxes.length === 0
  const [slotUploading, setSlotUploading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const amazon = useAmazonImages({
    productId,
    variants,
    listingImages,
    masterImages,
    activeAxis,
    pendingUpserts,
    addPendingUpsert,
    amazonJobs,
    onSavePending,
    onReload,
  })

  async function handleExportZip(marketplace: AmazonMarketplace) {
    if (marketplace === 'ALL') return
    setIsExporting(true)
    try {
      const res = await beFetch(`/api/products/${productId}/amazon-images/export-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace }),
      })
      if (!res.ok) return
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `amazon-${marketplace}.zip`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {
      // Non-fatal — user can retry
    } finally {
      setIsExporting(false)
    }
  }

  async function handleCellFileDrop(groupValue: string | null, slot: AmazonSlot, file: File) {
    setSlotUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await beFetch(`/api/products/${productId}/images?type=ALT`, { method: 'POST', body: fd })
      if (!res.ok) return
      const created = await res.json()
      amazon.assignCell(groupValue, slot, created.url, created.id)
    } finally {
      setSlotUploading(false)
    }
  }

  function handleCopyRow(groupValue: string, toMarketplace: string) {
    // Copy all slots for this group to the target marketplace
    const slots = listingImages.filter((img) =>
      img.platform === 'AMAZON' &&
      img.variantGroupKey === activeAxis &&
      img.variantGroupValue === groupValue,
    )
    for (const img of slots) {
      addPendingUpsert({
        scope: 'MARKETPLACE',
        platform: 'AMAZON',
        marketplace: toMarketplace,
        amazonSlot: img.amazonSlot,
        variantGroupKey: img.variantGroupKey,
        variantGroupValue: img.variantGroupValue,
        url: img.url,
        sourceProductImageId: img.id,
        role: img.role,
        position: img.position,
      })
    }
  }

  function handleClearRow(groupValue: string) {
    // Mark all server images for this group as pending deletes
    // For now, remove pending upserts only (server rows cleared on next save via the delete flow)
    for (const [key, u] of pendingUpserts.entries()) {
      if (u.platform === 'AMAZON' && u.variantGroupKey === activeAxis && u.variantGroupValue === groupValue) {
        removePendingUpsert(key)
      }
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      {/* Marketplace tabs + axis selector */}
      <div className="flex items-center border-b border-slate-200 dark:border-slate-700 px-4 overflow-x-auto gap-2">
        <div className="flex items-center flex-1 overflow-x-auto">
          {(['ALL', ...AMAZON_MARKETPLACES] as AmazonMarketplace[]).map((mkt) => {
            const isActive = amazon.activeMarketplace === mkt
            const hasImages = mkt !== 'ALL' && amazon.populatedMarketplaces.has(mkt)
            return (
              <button
                key={mkt}
                type="button"
                onClick={() => amazon.setActiveMarketplace(mkt)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                  isActive
                    ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200',
                )}
              >
                {MKT_LABELS[mkt] ?? mkt}
                {hasImages && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" title="Has marketplace-specific images" />
                )}
              </button>
            )
          })}
        </div>

        {/* Slot-uploading indicator */}
        {slotUploading && (
          <span className="flex items-center gap-1 text-xs text-slate-400 ml-2 py-3 flex-shrink-0">
            <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
          </span>
        )}

        {/* Axis selector — group rows by Color, Size, etc. Free-type + datalist suggestions */}
        {variants.length > 0 && (
          <div className="flex items-center gap-1.5 py-2 pl-3 border-l border-slate-100 dark:border-slate-800 flex-shrink-0">
            <span className="text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">Group by</span>
            <input
              list="amazon-axis-list"
              value={activeAxis}
              onChange={(e) => { if (e.target.value.trim()) onAxisChange(e.target.value.trim()) }}
              placeholder="e.g. Colore"
              className="text-xs border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-orange-400 w-24"
            />
            <datalist id="amazon-axis-list">
              {[...new Set([...availableAxes, 'Colore', 'Taglia', 'Color', 'Size', 'Colour', 'Material', 'Style', 'Gender'])].map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
        )}
      </div>

      {/* Missing axis-data warning */}
      {noAxisData && (
        <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            {variants.length} variant{variants.length !== 1 ? 's' : ''} found but no Color/Size attributes are set.
            Go to <strong>Catalog → Organize</strong> and set the axis values (e.g. Colore, Taglia) for each child product,
            then reload this page. Images will group by color once attributes are in place.
          </span>
        </div>
      )}

      {/* Matrix */}
      <div className="p-4">
        {amazon.variantGroups.length === 0 && variants.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">
            No variants found. Add variants with {activeAxis} attribute to populate the matrix.
          </div>
        ) : (
          <AmazonMatrix
            variantGroups={amazon.variantGroups}
            activeMarketplace={amazon.activeMarketplace}
            activeAxis={activeAxis}
            resolveCell={amazon.resolveCell}
            onCellClick={(groupValue, slot) => amazon.setImagePicker({ groupValue, slot })}
            onCellDrop={(groupValue, slot, url, sourceId) => amazon.assignCell(groupValue, slot, url, sourceId)}
            onColumnHeaderDrop={(slot, url, sourceId) => amazon.assignColumn(slot, url, 'empty', sourceId)}
            onPublishRow={() => amazon.publish(
              amazon.activeMarketplace === 'ALL' ? 'IT' : amazon.activeMarketplace,
            )}
            onCopyRow={handleCopyRow}
            onClearRow={handleClearRow}
            onCellFileDrop={handleCellFileDrop}
          />
        )}
      </div>

      {/* Publish bar */}
      <AmazonPublishBar
        activeMarketplace={amazon.activeMarketplace}
        publishing={amazon.publishing}
        publishingAll={amazon.publishingAll}
        publishError={amazon.publishError}
        feedJobs={amazon.feedJobs}
        dirtyCount={dirtyCount}
        onPublish={amazon.publish}
        onPublishAll={amazon.publishAll}
        onExportZip={handleExportZip}
        isExporting={isExporting}
      />

      {/* IM.7 — Cross-channel sync */}
      <CrossChannelSyncBar
        channel="amazon"
        hasMasterImages={masterImages.length > 0}
        hasAmazonColorSets={listingImages.some((i) => i.platform === 'AMAZON' && i.variantGroupKey)}
        onCopyToEbayGallery={onCopyToEbayGallery}
        onCopyToEbayColorSets={onCopyToEbayColorSets}
        onCopyToShopifyPool={onCopyToShopifyPool}
        onCopyToShopifyAssignments={onCopyToShopifyAssignments}
        onToast={onToast}
      />

      {/* Image picker modal */}
      {amazon.imagePicker && (
        <ImagePickerModal
          productId={productId}
          masterImages={masterImages}
          onSelect={(url, sourceId) => {
            if (!amazon.imagePicker) return
            amazon.assignCell(amazon.imagePicker.groupValue, amazon.imagePicker.slot, url, sourceId)
            amazon.setImagePicker(null)
          }}
          onClose={() => amazon.setImagePicker(null)}
        />
      )}
    </div>
  )
}

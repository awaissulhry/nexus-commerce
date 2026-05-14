'use client'

// IM.5 — eBay images panel.
//
// Two sections:
//   Gallery  — product-level ordered images (up to 24). Position 1 = main
//              listing image shown in search results.
//   Color Sets — per-colour VariationSpecificPictureSet. eBay supports only
//              one variation dimension for images (typically Color).
//              Images here are sent in the <VariationSpecificPictureSet>
//              XML block of ReviseItem.
//
// All mutations create pending upserts (staged, saved via action bar).
// Reordering gallery regenerates positions for all gallery images.

import { useRef, useState, useMemo } from 'react'
import {
  AlertTriangle, GripVertical, Loader2, Plus, ShoppingBag,
  Trash2, Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'
import ImagePickerModal from '../ImagePickerModal'
import CrossChannelSyncBar from '../CrossChannelSyncBar'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary, WorkspaceProduct } from '../types'

interface CopyResult { copied: number; skipped: number }

const EBAY_MAX = 24

interface Props {
  productId: string
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  activeAxis: string
  pendingUpserts: Map<string, PendingUpsert>
  pendingDeletes: Set<string>
  addPendingUpsert: (u: Omit<PendingUpsert, '_tempId'>) => void
  addPendingDelete: (id: string) => void
  onToast: (msg: string) => void
  onCopyFromMaster: () => CopyResult
  onCopyFromAmazonGallery: () => CopyResult
  onCopyFromAmazonColorSets: () => CopyResult
  publishedCount: number
  onPublish: () => Promise<void>
}

interface DisplayItem {
  id: string        // ListingImage.id or _tempId
  url: string
  position: number
  isPending: boolean
  publishStatus?: string
}

export default function EbayPanel({
  productId,
  masterImages,
  listingImages,
  variants,
  activeAxis,
  pendingUpserts,
  pendingDeletes,
  addPendingUpsert,
  addPendingDelete,
  onToast,
  onCopyFromMaster,
  onCopyFromAmazonGallery,
  onCopyFromAmazonColorSets,
  publishedCount,
  onPublish,
}: Props) {
  const [publishing, setPublishing] = useState(false)
  const [pickerTarget, setPickerTarget] = useState<'gallery' | { colorValue: string } | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [dropZoneActive, setDropZoneActive] = useState(false)
  const dragIndexRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  // ── Effective gallery (server + pending overlay) ───────────────────
  const effectiveGallery = useMemo<DisplayItem[]>(() => {
    const pendingMap = new Map<string, PendingUpsert>()
    const pendingNew: PendingUpsert[] = []

    for (const u of pendingUpserts.values()) {
      if (u.platform !== 'EBAY' || u.variantGroupKey || u.variationId) continue
      if (u.id) pendingMap.set(u.id, u)
      else pendingNew.push(u)
    }

    const base = listingImages
      .filter((i) => i.platform === 'EBAY' && !i.variantGroupKey && !i.variationId && !pendingDeletes.has(i.id))
      .map((i) => {
        const p = pendingMap.get(i.id)
        return {
          id: i.id,
          url: p?.url ?? i.url,
          position: p?.position ?? i.position,
          isPending: !!p,
          publishStatus: i.publishStatus,
        }
      })

    const news = pendingNew.map((u, idx) => ({
      id: u._tempId,
      url: u.url,
      position: (base.length + idx) * 10,
      isPending: true,
    }))

    return [...base, ...news].sort((a, b) => a.position - b.position)
  }, [listingImages, pendingUpserts, pendingDeletes])

  // ── Effective color sets ───────────────────────────────────────────
  const variantGroups = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const v of variants) {
      const val = (v.variantAttributes as Record<string, string> | null)?.[activeAxis] ?? '—'
      if (!map.has(val)) map.set(val, [])
    }
    return map
  }, [variants, activeAxis])

  const colorSets = useMemo(() => {
    const result = new Map<string, DisplayItem[]>()

    // Seed all known color groups (even if empty)
    for (const [val] of variantGroups) {
      result.set(val, [])
    }

    // Server images
    for (const img of listingImages) {
      if (img.platform !== 'EBAY' || img.variantGroupKey !== activeAxis || pendingDeletes.has(img.id)) continue
      const val = img.variantGroupValue ?? '—'
      if (!result.has(val)) result.set(val, [])
      result.get(val)!.push({ id: img.id, url: img.url, position: img.position, isPending: false })
    }

    // Pending new color images
    for (const u of pendingUpserts.values()) {
      if (u.platform !== 'EBAY' || u.variantGroupKey !== activeAxis || u.id) continue
      const val = u.variantGroupValue ?? '—'
      if (!result.has(val)) result.set(val, [])
      result.get(val)!.push({ id: u._tempId, url: u.url, position: 999, isPending: true })
    }

    return result
  }, [listingImages, pendingUpserts, pendingDeletes, activeAxis, variantGroups])

  // ── Gallery DnD ────────────────────────────────────────────────────
  function onDragStart(e: React.DragEvent, index: number) {
    if (e.dataTransfer.types.includes('Files')) return
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(e: React.DragEvent, index: number) {
    if (e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOverIndex(index)
  }

  function onDrop(e: React.DragEvent, targetIndex: number) {
    if (e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOverIndex(null)
    const fromIndex = dragIndexRef.current
    dragIndexRef.current = null
    if (fromIndex === null || fromIndex === targetIndex) return

    const reordered = [...effectiveGallery]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(targetIndex, 0, moved)

    // Create pending upserts for all gallery items with new positions
    reordered.forEach((item, idx) => {
      if (!item.id.startsWith('tmp_')) {
        // Existing server row — update position
        addPendingUpsert({
          id: item.id,
          scope: 'PLATFORM',
          platform: 'EBAY',
          marketplace: null,
          url: item.url,
          position: idx,
          role: idx === 0 ? 'MAIN' : 'GALLERY',
        })
      }
    })
  }

  // ── File upload ────────────────────────────────────────────────────
  async function handleFiles(files: File[]) {
    if (!files.length) return
    setUploading(true)
    try {
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await beFetch(`/api/products/${productId}/images?type=ALT`, { method: 'POST', body: fd })
        if (!res.ok) continue
        const created = await res.json()
        handleAddToGallery(created.url, created.id)
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Add to gallery ─────────────────────────────────────────────────
  function handleAddToGallery(url: string, sourceId?: string) {
    addPendingUpsert({
      scope: 'PLATFORM',
      platform: 'EBAY',
      marketplace: null,
      url,
      sourceProductImageId: sourceId,
      role: effectiveGallery.length === 0 ? 'MAIN' : 'GALLERY',
      position: effectiveGallery.length * 10,
    })
  }

  // ── Add to color set ───────────────────────────────────────────────
  function handleAddToColorSet(colorValue: string, url: string, sourceId?: string) {
    const existing = colorSets.get(colorValue) ?? []
    addPendingUpsert({
      scope: 'PLATFORM',
      platform: 'EBAY',
      marketplace: null,
      variantGroupKey: activeAxis,
      variantGroupValue: colorValue,
      url,
      sourceProductImageId: sourceId,
      role: 'GALLERY',
      position: existing.length,
    })
  }

  const atMax = effectiveGallery.length >= EBAY_MAX

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden space-y-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-700">
        <ShoppingBag className="w-4 h-4 text-slate-500" />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">eBay Images</span>
        <div className="ml-auto flex items-center gap-3">
          {/* Usage bar */}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <div className="w-20 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', effectiveGallery.length >= EBAY_MAX ? 'bg-red-500' : 'bg-blue-500')}
                style={{ width: `${Math.min(100, (effectiveGallery.length / EBAY_MAX) * 100)}%` }}
              />
            </div>
            <span className={effectiveGallery.length >= EBAY_MAX ? 'text-red-500' : ''}>
              {effectiveGallery.length}/{EBAY_MAX}
            </span>
          </div>
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={uploading || atMax}>
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload
          </Button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => handleFiles(Array.from(e.target.files ?? []))} />
        </div>
      </div>

      {/* ── Gallery section ─────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Gallery</h3>
          <span className="text-xs text-slate-400">Position 1 = main listing image</span>
        </div>

        {effectiveGallery.length === 0 ? (
          <div
            className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-10 flex flex-col items-center gap-2 text-slate-400 cursor-pointer hover:border-blue-300 transition-colors"
            onClick={() => setPickerTarget('gallery')}
          >
            <Plus className="w-6 h-6" />
            <span className="text-sm">Add gallery images</span>
          </div>
        ) : (
          <div
            className={cn('flex flex-wrap gap-3', dropZoneActive && 'ring-2 ring-blue-300 rounded-lg p-1')}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropZoneActive(true) } }}
            onDragLeave={() => setDropZoneActive(false)}
            onDrop={(e) => { setDropZoneActive(false); if (e.dataTransfer.files.length) { e.preventDefault(); handleFiles(Array.from(e.dataTransfer.files)) } }}
          >
            {effectiveGallery.map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => onDragStart(e, index)}
                onDragOver={(e) => onDragOver(e, index)}
                onDragLeave={() => setDragOverIndex(null)}
                onDrop={(e) => onDrop(e, index)}
                className={cn(
                  'group relative w-20 h-20 rounded-xl border-2 overflow-hidden bg-slate-50 dark:bg-slate-800 transition-all flex-shrink-0',
                  dragOverIndex === index
                    ? 'border-blue-400 ring-2 ring-blue-300'
                    : 'border-slate-200 dark:border-slate-700',
                  item.isPending && 'ring-1 ring-amber-400',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.url} alt="" className="w-full h-full object-contain" loading="lazy" />

                {/* Position badge */}
                <div className={cn(
                  'absolute top-0.5 left-0.5 text-[9px] font-mono rounded px-0.5 leading-tight',
                  index === 0 ? 'bg-blue-500 text-white' : 'bg-black/50 text-white',
                )}>
                  {index === 0 ? '★1' : index + 1}
                </div>

                {/* Pending dot */}
                {item.isPending && (
                  <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                )}

                {/* Drag handle */}
                <div className="absolute bottom-0.5 left-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab">
                  <GripVertical className="w-3 h-3 text-white drop-shadow" />
                </div>

                {/* Delete button */}
                <button
                  type="button"
                  className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 rounded p-0.5"
                  onClick={() => addPendingDelete(item.id)}
                >
                  <Trash2 className="w-2.5 h-2.5 text-white" />
                </button>
              </div>
            ))}

            {/* Add card */}
            {!atMax && (
              <button
                type="button"
                onClick={() => setPickerTarget('gallery')}
                className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-blue-300 transition-colors flex-shrink-0"
              >
                <Plus className="w-5 h-5" />
                <span className="text-[10px]">Add</span>
              </button>
            )}
          </div>
        )}

        {atMax && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            Gallery full (24 max). Remove images to add more.
          </div>
        )}
      </div>

      {/* ── Color Sets section ──────────────────────────────────────── */}
      {variants.length > 0 && (
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Color Sets</h3>
            <span className="text-xs text-slate-400">(VariationSpecificPictureSet — picture dimension: {activeAxis})</span>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">
            eBay shows these images when a buyer selects a specific {activeAxis.toLowerCase()}. Only one variation dimension is supported.
          </p>

          <div className="space-y-3">
            {Array.from(colorSets.entries()).map(([colorValue, images]) => (
              <div key={colorValue} className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                {/* Color label */}
                <div className="w-28 flex-shrink-0 pt-1">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{colorValue}</span>
                </div>

                {/* Images */}
                <div className="flex flex-wrap gap-2 flex-1">
                  {images.map((img) => (
                    <div key={img.id} className="group relative w-16 h-16 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" className="w-full h-full object-contain" loading="lazy" />
                      {img.isPending && (
                        <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                      )}
                      <button
                        type="button"
                        className="absolute inset-0 bg-red-500/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                        onClick={() => addPendingDelete(img.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-white" />
                      </button>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={() => setPickerTarget({ colorValue })}
                    className="w-16 h-16 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-400 hover:border-blue-300 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* IM.7 — Cross-channel sync */}
      <CrossChannelSyncBar
        channel="ebay"
        hasMasterImages={masterImages.length > 0}
        hasAmazonImages={listingImages.some((i) => i.platform === 'AMAZON' && !i.variantGroupKey)}
        hasAmazonColorSets={listingImages.some((i) => i.platform === 'AMAZON' && i.variantGroupKey)}
        onCopyFromMaster={onCopyFromMaster}
        onCopyFromAmazonGallery={onCopyFromAmazonGallery}
        onCopyFromAmazonColorSets={onCopyFromAmazonColorSets}
        onToast={onToast}
      />

      {/* Publish */}
      <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <span className="text-xs text-slate-400">
          ReviseItem · PictureDetails + VariationSpecificPictureSet via Trading API
          {publishedCount > 0 && (
            <span className="ml-2 text-emerald-600 dark:text-emerald-400">· {publishedCount} published</span>
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 border border-slate-200 dark:border-slate-700"
          disabled={publishing}
          onClick={async () => {
            setPublishing(true)
            try { await onPublish() } finally { setPublishing(false) }
          }}
        >
          {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Publish to eBay
        </Button>
      </div>

      {/* Image picker modal */}
      {pickerTarget !== null && (
        <ImagePickerModal
          productId={productId}
          masterImages={masterImages}
          onSelect={(url, sourceId) => {
            if (pickerTarget === 'gallery') {
              handleAddToGallery(url, sourceId)
            } else {
              handleAddToColorSet(pickerTarget.colorValue, url, sourceId)
            }
            setPickerTarget(null)
          }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  )
}

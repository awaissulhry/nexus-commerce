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
  AlertTriangle, CheckCircle2, ChevronDown, Clock, Eye, GripVertical, Link2, Loader2, Plus, ShoppingBag,
  Trash2, Upload,
} from 'lucide-react'
import { PLATFORM_RULES } from '@nexus/shared/image-validation'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'
import ImagePickerModal from '../ImagePickerModal'
import CrossChannelSyncBar from '../CrossChannelSyncBar'
import ChannelPreview from '../ChannelPreview'
import ChannelValidationBanner, { useChannelValidation } from '../ChannelValidationBanner'
import ChannelPublishPreviewModal from '../ChannelPublishPreviewModal'
import ChannelStaleBanner from '../ChannelStaleBanner'
import ImagePublishHistory from '../ImagePublishHistory'
import RecentChannelJobsStrip from '../RecentChannelJobsStrip'
import LiveChannelStrip from '../LiveChannelStrip'
import type { ChannelLiveImage, ListingImage, PendingUpsert, ProductImage, VariantSummary, WorkspaceProduct } from '../types'

interface CopyResult { copied: number; skipped: number }

// Single source of truth — bumping eBay's gallery max means editing
// PLATFORM_RULES in packages/shared/image-validation, not here.
const EBAY_MAX = PLATFORM_RULES.EBAY.maxImages ?? 24

function elapsedTime(from: string): string {
  const m = Math.floor((Date.now() - new Date(from).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

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
  /** IR.3.3 — open lightbox for a clicked image. */
  onOpenLightboxForCell?: (listingImageId: string | undefined, fallbackUrl: string) => void
  onCopyFromMaster: () => CopyResult
  onCopyFromAmazonGallery: () => CopyResult
  onCopyFromAmazonColorSets: () => CopyResult
  publishedCount: number
  onPublish: () => Promise<{ success: boolean; message: string }>
  // PB.8a — live channel strip props (mirrors AmazonPanel).
  channelLiveImages?: ChannelLiveImage[]
  onReload?: () => void
  onAdoptToMaster?: (url: string) => void | Promise<void>
}

interface DisplayItem {
  id: string        // ListingImage.id or _tempId
  url: string
  position: number
  isPending: boolean
  publishStatus?: string
  // IE.3 — preview-only row sourced from MasterPanel when the gallery
  // has nothing real to render. Rendered with a dashed border + chain
  // link badge; converting these to real pending upserts is what the
  // "Copy from master" button already does.
  fromMaster?: boolean
  masterImageId?: string
}

export default function EbayPanel({
  productId,
  product,
  masterImages,
  listingImages,
  variants,
  activeAxis,
  pendingUpserts,
  pendingDeletes,
  addPendingUpsert,
  addPendingDelete,
  onToast,
  onOpenLightboxForCell,
  onCopyFromMaster,
  onCopyFromAmazonGallery,
  onCopyFromAmazonColorSets,
  publishedCount,
  onPublish,
  channelLiveImages = [],
  onReload,
  onAdoptToMaster,
}: Props) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [publishPreviewOpen, setPublishPreviewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  // PB.3c — Increment after a publish so the recent-jobs strip refetches.
  const [jobsRefreshKey, setJobsRefreshKey] = useState(0)
  const [lastPublish, setLastPublish] = useState<{ success: boolean; message: string; ts: string } | null>(null)
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

    const items = [...base, ...news].sort((a, b) => a.position - b.position)
    // IE.3 — when the gallery has nothing real, surface master gallery
    // images as preview-only suggestions so the operator sees what
    // "Copy from master" would write. Up to EBAY_MAX.
    if (items.length === 0 && masterImages.length > 0) {
      return masterImages.slice(0, EBAY_MAX).map((m, idx) => ({
        id: `master:${m.id}`,
        url: m.url,
        position: idx * 10,
        isPending: false,
        fromMaster: true,
        masterImageId: m.id,
      }))
    }
    return items
  }, [listingImages, pendingUpserts, pendingDeletes, masterImages])

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
    // IA.16 — proper-sized drag preview from the inner img.
    const imgEl = e.currentTarget.querySelector('img') as HTMLImageElement | null
    if (imgEl) e.dataTransfer.setDragImage(imgEl, imgEl.width / 2, imgEl.height / 2)
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

  // PB.3a — Validation gate. Pre-filters incoming arrays once and
  // computes blocking + warnings. The Publish button disables when
  // validation.blocking.length > 0; the banner explains why inline.
  const ebayListing = useMemo(() => listingImages.filter((i) => i.platform === 'EBAY'), [listingImages])
  const ebayPending = useMemo(
    () => Array.from(pendingUpserts.values()).filter((u) => u.platform === 'EBAY'),
    [pendingUpserts],
  )
  const validation = useChannelValidation({
    channel: 'EBAY',
    masterImages,
    channelImages: ebayListing,
    pendingForChannel: ebayPending,
    pendingDeletes,
  })

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl space-y-0">
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

      {/* PB.8a — Live channel strip (eBay) */}
      {onReload && (
        <div className="px-5 pt-3">
          <LiveChannelStrip
            productId={productId}
            channel="EBAY"
            marketplaces={['GLOBAL']}
            liveImages={channelLiveImages}
            listingImages={listingImages}
            onRefreshed={onReload}
            {...(onAdoptToMaster
              ? { onAdoptToMaster: (url: string) => { void onAdoptToMaster(url) } }
              : {})}
          />
        </div>
      )}

      {/* PB.3a — Pre-publish validation gate */}
      <ChannelValidationBanner
        channel="EBAY"
        masterImages={masterImages}
        channelImages={ebayListing}
        pendingForChannel={ebayPending}
        pendingDeletes={pendingDeletes}
      />

      {/* PB.3d — Stale-detection banner */}
      <ChannelStaleBanner
        channel="EBAY"
        masterImages={masterImages}
        channelImages={ebayListing}
        onPublish={onPublish}
        onToast={onToast}
        publishingExternally={publishing}
      />

      {/* ── Gallery section ─────────────────────────────────────────── */}
      <section
        aria-labelledby="ebay-gallery-heading"
        className="px-5 py-4 border-b border-slate-100 dark:border-slate-800"
      >
        <div className="flex items-center gap-2 mb-3">
          <h3 id="ebay-gallery-heading" className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Gallery</h3>
          <span className="text-xs text-slate-400">Position 1 = main listing image</span>
        </div>

        {effectiveGallery.length === 0 ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Add gallery images"
            className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-10 flex flex-col items-center gap-2 text-slate-400 cursor-pointer hover:border-blue-300 transition-colors"
            onClick={() => setPickerTarget('gallery')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPickerTarget('gallery') } }}
          >
            <Plus className="w-6 h-6" />
            <span className="text-sm">Add gallery images</span>
          </div>
        ) : (
          <div
            role="listbox"
            aria-labelledby="ebay-gallery-heading"
            aria-orientation="horizontal"
            className={cn('flex flex-wrap gap-3', dropZoneActive && 'ring-2 ring-blue-300 rounded-lg p-1')}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropZoneActive(true) } }}
            onDragLeave={() => setDropZoneActive(false)}
            onDrop={(e) => { setDropZoneActive(false); if (e.dataTransfer.files.length) { e.preventDefault(); handleFiles(Array.from(e.dataTransfer.files)) } }}
          >
            {effectiveGallery.map((item, index) => (
              <div
                key={item.id}
                role="option"
                aria-selected={false}
                aria-label={`Position ${index + 1}${index === 0 ? ' (main listing image)' : ''}${item.isPending ? ', unsaved' : ''}`}
                draggable
                onDragStart={(e) => onDragStart(e, index)}
                onDragOver={(e) => onDragOver(e, index)}
                onDragLeave={() => setDragOverIndex(null)}
                onDrop={(e) => onDrop(e, index)}
                onClick={() => onOpenLightboxForCell?.(
                  item.id.startsWith('tmp_') ? undefined : item.id,
                  item.url,
                )}
                className={cn(
                  'group relative w-20 h-20 rounded-xl border-2 overflow-hidden bg-slate-50 dark:bg-slate-800 transition-all flex-shrink-0',
                  dragOverIndex === index
                    ? 'border-blue-400 ring-2 ring-blue-300'
                    : item.fromMaster
                      ? 'border-dashed border-slate-300 dark:border-slate-600 opacity-75'
                      : 'border-slate-200 dark:border-slate-700',
                  item.isPending && 'ring-1 ring-amber-400',
                  onOpenLightboxForCell && 'cursor-zoom-in',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.url} alt="" draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />

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

                {/* IE.3 — master-inherited preview badge */}
                {item.fromMaster && (
                  <div
                    className="absolute bottom-0.5 right-0.5 bg-slate-700/70 text-white rounded p-0.5 leading-none"
                    title="Inherited from master — click 'Copy from master' to commit"
                  >
                    <Link2 className="w-2.5 h-2.5" />
                  </div>
                )}

                {/* Drag handle — hidden for master previews (no real row to reorder yet) */}
                {!item.fromMaster && (
                  <div className="absolute bottom-0.5 left-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab">
                    <GripVertical className="w-3 h-3 text-white drop-shadow" />
                  </div>
                )}

                {/* Delete button — hidden for master previews; deleting one
                    would have nothing to delete (no ListingImage row exists). */}
                {!item.fromMaster && (
                  <button
                    type="button"
                    aria-label="Remove from gallery"
                    className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 rounded p-0.5"
                    onClick={(e) => { e.stopPropagation(); addPendingDelete(item.id) }}
                  >
                    <Trash2 className="w-2.5 h-2.5 text-white" />
                  </button>
                )}
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
      </section>

      {/* ── Color Sets section ──────────────────────────────────────── */}
      {variants.length > 0 && (
        <section
          aria-labelledby="ebay-colorsets-heading"
          className="px-5 py-4"
        >
          <div className="flex items-center gap-2 mb-3">
            <h3 id="ebay-colorsets-heading" className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Color Sets</h3>
            <span className="text-xs text-slate-400">(VariationSpecificPictureSet — picture dimension: {activeAxis})</span>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">
            eBay shows these images when a buyer selects a specific {activeAxis.toLowerCase()}. Only one variation dimension is supported.
          </p>

          <div className="space-y-3">
            {Array.from(colorSets.entries()).map(([colorValue, images]) => {
              const groupId = `ebay-colorset-${colorValue.replace(/\s+/g, '-').toLowerCase()}`
              return (
                <div
                  key={colorValue}
                  role="group"
                  aria-labelledby={groupId}
                  className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl"
                >
                  {/* Color label */}
                  <div className="w-28 flex-shrink-0 pt-1">
                    <span id={groupId} className="text-sm font-medium text-slate-800 dark:text-slate-200">{colorValue}</span>
                  </div>

                  {/* Images */}
                  <div className="flex flex-wrap gap-2 flex-1">
                    {images.map((img) => (
                      <div
                        key={img.id}
                        role="img"
                        aria-label={`${colorValue} variation image${img.isPending ? ', unsaved' : ''}`}
                        onClick={() => onOpenLightboxForCell?.(
                          img.id.startsWith('tmp_') ? undefined : img.id,
                          img.url,
                        )}
                        className={cn(
                          'group relative w-16 h-16 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900',
                          onOpenLightboxForCell && 'cursor-zoom-in',
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.url} alt="" draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />
                        {img.isPending && (
                          <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                        )}
                        <button
                          type="button"
                          aria-label={`Remove ${colorValue} variation image`}
                          className="absolute inset-0 bg-red-500/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                          onClick={(e) => { e.stopPropagation(); addPendingDelete(img.id) }}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-white" />
                        </button>
                      </div>
                    ))}

                    <button
                      type="button"
                      aria-label={`Add ${colorValue} variation image`}
                      onClick={() => setPickerTarget({ colorValue })}
                      className="w-16 h-16 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-400 hover:border-blue-300 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
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

      {/* IR.5.4 — Buyer preview */}
      <div className="border-t border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setPreviewOpen((p) => !p)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          aria-expanded={previewOpen}
        >
          <Eye className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-medium">Buyer preview</span>
          <span className="text-slate-400 ml-1">— eBay listing card as a buyer would see it</span>
          <ChevronDown className={cn('w-3.5 h-3.5 ml-auto text-slate-400 transition-transform', previewOpen && 'rotate-180')} />
        </button>
        {previewOpen && (
          <div className="px-4 pb-4">
            <ChannelPreview
              platform="EBAY"
              product={product}
              masterImages={masterImages}
              listingImages={listingImages}
              variants={variants}
            />
          </div>
        )}
      </div>

      {/* IR.9.4 — Publish history */}
      <div className="border-t border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setHistoryOpen((p) => !p)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          aria-expanded={historyOpen}
        >
          <Clock className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-medium">Publish history</span>
          <span className="text-slate-400 ml-1">— eBay ReviseItem submissions + retry</span>
          <ChevronDown className={cn('w-3.5 h-3.5 ml-auto text-slate-400 transition-transform', historyOpen && 'rotate-180')} />
        </button>
        {historyOpen && (
          <div className="px-4 pb-4">
            <ImagePublishHistory productId={productId} channel="EBAY" />
          </div>
        )}
      </div>

      {/* PB.3c — Recent jobs strip (compact, last 3) */}
      <RecentChannelJobsStrip productId={productId} channel="EBAY" refreshKey={jobsRefreshKey} />

      {/* PB.4 — sticky publish bar so the Publish button stays in
          reach when the gallery + color sets push it below the fold. */}
      <div
        data-publish-anchor
        className="sticky bottom-0 z-10 bg-white dark:bg-slate-900 rounded-b-xl px-5 py-3 border-t border-slate-100 dark:border-slate-800 shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.5)] flex flex-col gap-1.5"
      >
        <div className="flex items-center justify-between">
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
            onClick={() => setPublishPreviewOpen(true)}
            disabled={publishing}
            title="Open pre-publish preview"
          >
            <Eye className="w-3.5 h-3.5" />
            Preview
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 border border-slate-200 dark:border-slate-700"
            disabled={publishing || validation.blocking.length > 0}
            title={validation.blocking.length > 0
              ? `${validation.blocking.length} blocking issue${validation.blocking.length === 1 ? '' : 's'} — see banner above`
              : undefined}
            onClick={async () => {
              setPublishing(true)
              try {
                const result = await onPublish()
                setLastPublish({ ...result, ts: new Date().toISOString() })
                setJobsRefreshKey((k) => k + 1)
              } finally {
                setPublishing(false)
              }
            }}
          >
            {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Publish to eBay
          </Button>
        </div>
        {lastPublish && (
          <div className={cn('flex items-center gap-1.5 text-xs', lastPublish.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {lastPublish.success
              ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
              : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
            {lastPublish.message} · {elapsedTime(lastPublish.ts)}
          </div>
        )}
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

      {/* PB.3b — Pre-publish preview modal */}
      <ChannelPublishPreviewModal
        open={publishPreviewOpen}
        channel="EBAY"
        masterImages={masterImages}
        listingImages={listingImages}
        pendingUpserts={pendingUpserts}
        pendingDeletes={pendingDeletes}
        variants={variants}
        activeAxis={activeAxis}
        publishing={publishing}
        onClose={() => setPublishPreviewOpen(false)}
        onConfirmPublish={async () => {
          setPublishing(true)
          try {
            const result = await onPublish()
            setLastPublish({ ...result, ts: new Date().toISOString() })
            setJobsRefreshKey((k) => k + 1)
            if (result.success) setPublishPreviewOpen(false)
          } finally {
            setPublishing(false)
          }
        }}
      />
    </div>
  )
}

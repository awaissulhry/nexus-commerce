'use client'

// IM.6 — Shopify images panel.
//
// Two sections:
//   Pool   — product-level image pool (up to 250). Position 0 = featured
//            image shown on the product page. DnD to reorder.
//   Assign — variant image assignment. One image per colour group.
//            Shopify displays the assigned image when a buyer selects
//            that colour variant. Maps to variant.image_id in REST API
//            (productVariantsBulkUpdate mediaId in GraphQL).
//
// All mutations are staged → saved via action bar.

import { useRef, useState, useMemo } from 'react'
import {
  AlertTriangle, CheckCircle2, ChevronDown, Clock, Eye, GripVertical, Link2, Loader2, Plus,
  Star, Store, Trash2, Upload,
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

const SHOPIFY_MAX = PLATFORM_RULES.SHOPIFY.maxImages ?? 250

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
  onCopyFromAmazonPool: () => CopyResult
  onCopyFromAmazonAssignments: () => CopyResult
  publishedCount: number
  onPublish: () => Promise<{ success: boolean; message: string }>
  // PB.8b — live channel strip props (mirrors AmazonPanel + EbayPanel).
  channelLiveImages?: ChannelLiveImage[]
  onReload?: () => void
  onAdoptToMaster?: (url: string) => void | Promise<void>
}

interface PoolItem {
  id: string
  url: string
  alt: string | null
  position: number
  isPending: boolean
  publishStatus?: string
  // IE.3 — preview-only row sourced from MasterPanel when the pool is
  // empty. Rendered with a dashed border + chain link; converting to
  // real pending upserts is what "Copy from master" already does.
  fromMaster?: boolean
  masterImageId?: string
}

export default function ShopifyPanel({
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
  onCopyFromAmazonPool,
  onCopyFromAmazonAssignments,
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
  const [pickerTarget, setPickerTarget] = useState<'pool' | { colorValue: string } | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  // ── Effective pool ─────────────────────────────────────────────────
  const effectivePool = useMemo<PoolItem[]>(() => {
    const pendingMap = new Map<string, PendingUpsert>()
    const pendingNew: PendingUpsert[] = []

    for (const u of pendingUpserts.values()) {
      if (u.platform !== 'SHOPIFY' || u.variantGroupKey || u.variationId) continue
      if (u.id) pendingMap.set(u.id, u)
      else pendingNew.push(u)
    }

    const base = listingImages
      .filter((i) => i.platform === 'SHOPIFY' && !i.variantGroupKey && !i.variationId && !pendingDeletes.has(i.id))
      .map((i) => {
        const p = pendingMap.get(i.id)
        return {
          id: i.id,
          url: p?.url ?? i.url,
          alt: i.filename ?? null,
          position: p?.position ?? i.position,
          isPending: !!p,
          publishStatus: i.publishStatus,
        }
      })

    const news = pendingNew.map((u, idx) => ({
      id: u._tempId,
      url: u.url,
      alt: u.filename ?? null,
      position: (base.length + idx) * 10,
      isPending: true,
    }))

    const items = [...base, ...news].sort((a, b) => a.position - b.position)
    // IE.3 — empty pool surfaces master images as preview-only suggestions
    // so the operator sees what's available before clicking "Copy from
    // master". Shopify caps product images at 250 so we don't need to
    // truncate here for the typical Xavia catalog size.
    if (items.length === 0 && masterImages.length > 0) {
      return masterImages.map((m, idx) => ({
        id: `master:${m.id}`,
        url: m.url,
        alt: m.alt,
        position: idx * 10,
        isPending: false,
        fromMaster: true,
        masterImageId: m.id,
      }))
    }
    return items
  }, [listingImages, pendingUpserts, pendingDeletes, masterImages])

  // ── Variant assignments ────────────────────────────────────────────
  const variantGroups = useMemo(() => {
    const map = new Map<string, { groupValue: string; assignedImage: PoolItem | null }>()

    for (const v of variants) {
      const val = (v.variantAttributes as Record<string, string> | null)?.[activeAxis] ?? '—'
      if (!map.has(val)) map.set(val, { groupValue: val, assignedImage: null })
    }

    // Server assignments
    for (const img of listingImages) {
      if (img.platform !== 'SHOPIFY' || img.variantGroupKey !== activeAxis || pendingDeletes.has(img.id)) continue
      const val = img.variantGroupValue ?? '—'
      if (map.has(val)) {
        map.get(val)!.assignedImage = {
          id: img.id, url: img.url, alt: null, position: img.position, isPending: false,
        }
      }
    }

    // Pending assignments
    for (const u of pendingUpserts.values()) {
      if (u.platform !== 'SHOPIFY' || u.variantGroupKey !== activeAxis) continue
      const val = u.variantGroupValue ?? '—'
      if (map.has(val)) {
        map.get(val)!.assignedImage = {
          id: u._tempId, url: u.url, alt: null, position: 0, isPending: true,
        }
      }
    }

    return Array.from(map.values())
  }, [listingImages, pendingUpserts, pendingDeletes, variants, activeAxis])

  // ── Pool DnD ───────────────────────────────────────────────────────
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

    const reordered = [...effectivePool]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(targetIndex, 0, moved)

    // Create pending upserts for existing rows with new positions
    reordered.forEach((item, idx) => {
      if (!item.id.startsWith('tmp_')) {
        addPendingUpsert({
          id: item.id,
          scope: 'PLATFORM',
          platform: 'SHOPIFY',
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
        handleAddToPool(created.url, created.id)
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function handleAddToPool(url: string, sourceId?: string) {
    addPendingUpsert({
      scope: 'PLATFORM',
      platform: 'SHOPIFY',
      marketplace: null,
      url,
      sourceProductImageId: sourceId,
      role: effectivePool.length === 0 ? 'MAIN' : 'GALLERY',
      position: effectivePool.length * 10,
    })
  }

  function handleAssignVariant(colorValue: string, url: string, sourceId?: string) {
    // Find existing assignment for this color (to update it)
    const existing = listingImages.find((i) =>
      i.platform === 'SHOPIFY' && i.variantGroupKey === activeAxis && i.variantGroupValue === colorValue,
    )
    addPendingUpsert({
      id: existing?.id,
      scope: 'PLATFORM',
      platform: 'SHOPIFY',
      marketplace: null,
      variantGroupKey: activeAxis,
      variantGroupValue: colorValue,
      url,
      sourceProductImageId: sourceId,
      role: 'GALLERY',
      position: 0,
    })
  }

  function handleClearAssignment(colorValue: string) {
    const existing = listingImages.find((i) =>
      i.platform === 'SHOPIFY' && i.variantGroupKey === activeAxis && i.variantGroupValue === colorValue,
    )
    if (existing) addPendingDelete(existing.id)

    // Also remove any pending upsert for this color
    // (handled by addPendingDelete in workspace hook for pending items)
  }

  const atMax = effectivePool.length >= SHOPIFY_MAX
  const usagePct = Math.min(100, (effectivePool.length / SHOPIFY_MAX) * 100)

  // PB.3a — Validation gate. See EbayPanel for full rationale.
  const shopifyListing = useMemo(() => listingImages.filter((i) => i.platform === 'SHOPIFY'), [listingImages])
  const shopifyPending = useMemo(
    () => Array.from(pendingUpserts.values()).filter((u) => u.platform === 'SHOPIFY'),
    [pendingUpserts],
  )
  const validation = useChannelValidation({
    channel: 'SHOPIFY',
    masterImages,
    channelImages: shopifyListing,
    pendingForChannel: shopifyPending,
    pendingDeletes,
  })

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-700">
        <Store className="w-4 h-4 text-slate-500" />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Shopify Images</span>
        <div className="ml-auto flex items-center gap-3">
          {/* 250-limit bar */}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <div className="w-24 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', usagePct > 90 ? 'bg-red-500' : 'bg-emerald-500')}
                style={{ width: `${usagePct}%` }}
              />
            </div>
            <span className={usagePct > 90 ? 'text-red-500' : ''}>{effectivePool.length}/{SHOPIFY_MAX}</span>
          </div>
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={uploading || atMax}>
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload
          </Button>
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setPickerTarget('pool')} disabled={atMax}>
            <Plus className="w-3.5 h-3.5" />
            Add from master
          </Button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => handleFiles(Array.from(e.target.files ?? []))} />
        </div>
      </div>

      {/* PB.8b — Live channel strip (Shopify) */}
      {onReload && (
        <div className="px-5 pt-3">
          <LiveChannelStrip
            productId={productId}
            channel="SHOPIFY"
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
        channel="SHOPIFY"
        masterImages={masterImages}
        channelImages={shopifyListing}
        pendingForChannel={shopifyPending}
        pendingDeletes={pendingDeletes}
      />

      {/* PB.3d — Stale-detection banner */}
      <ChannelStaleBanner
        channel="SHOPIFY"
        masterImages={masterImages}
        channelImages={shopifyListing}
        onPublish={onPublish}
        onToast={onToast}
        publishingExternally={publishing}
      />

      {/* ── Image pool ─────────────────────────────────────────────── */}
      <section
        aria-labelledby="shopify-pool-heading"
        className="px-5 py-4 border-b border-slate-100 dark:border-slate-800"
      >
        <div className="flex items-center gap-2 mb-3">
          <h3 id="shopify-pool-heading" className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Image Pool</h3>
          <span className="text-xs text-slate-400">
            <Star className="w-3 h-3 inline mr-0.5 text-blue-500" />
            Position 1 = featured product image
          </span>
        </div>

        {effectivePool.length === 0 ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Add images to the Shopify pool"
            className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-10 flex flex-col items-center gap-2 text-slate-400 cursor-pointer hover:border-emerald-300 transition-colors"
            onClick={() => setPickerTarget('pool')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPickerTarget('pool') } }}
          >
            <Store className="w-8 h-8" />
            <span className="text-sm">Add images to the Shopify pool</span>
            <span className="text-xs">Position 1 becomes the featured image</span>
          </div>
        ) : (
          <div
            role="listbox"
            aria-labelledby="shopify-pool-heading"
            aria-orientation="horizontal"
            className="flex flex-wrap gap-3"
          >
            {effectivePool.map((item, index) => (
              <div
                key={item.id}
                role="option"
                aria-selected={false}
                aria-label={`Position ${index + 1}${index === 0 ? ' (featured image)' : ''}${item.isPending ? ', unsaved' : ''}`}
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
                  'group relative w-20 h-20 rounded-xl border-2 overflow-hidden bg-slate-50 dark:bg-slate-800 flex-shrink-0 transition-all',
                  dragOverIndex === index
                    ? 'border-emerald-400 ring-2 ring-emerald-300'
                    : item.fromMaster
                      ? 'border-dashed border-slate-300 dark:border-slate-600 opacity-75'
                      : 'border-slate-200 dark:border-slate-700',
                  item.isPending && 'ring-1 ring-amber-400',
                  onOpenLightboxForCell && 'cursor-zoom-in',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.url} alt={item.alt ?? ''} draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />

                {/* Featured / position badge */}
                <div className={cn(
                  'absolute top-0.5 left-0.5 text-[9px] font-mono rounded px-0.5 leading-tight',
                  index === 0 ? 'bg-emerald-500 text-white' : 'bg-black/50 text-white',
                )}>
                  {index === 0 ? <span>★{index + 1}</span> : index + 1}
                </div>

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

                {!item.fromMaster && (
                  <>
                    <div className="absolute bottom-0.5 left-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab">
                      <GripVertical className="w-3 h-3 text-white drop-shadow" />
                    </div>

                    <button
                      type="button"
                      aria-label="Remove from pool"
                      className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 rounded p-0.5"
                      onClick={(e) => { e.stopPropagation(); addPendingDelete(item.id) }}
                    >
                      <Trash2 className="w-2.5 h-2.5 text-white" />
                    </button>
                  </>
                )}
              </div>
            ))}

            {!atMax && (
              <button
                type="button"
                aria-label="Add image to Shopify pool"
                onClick={() => setPickerTarget('pool')}
                className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-emerald-300 transition-colors flex-shrink-0"
              >
                <Plus className="w-5 h-5" />
                <span className="text-[10px]">Add</span>
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── Variant image assignment ────────────────────────────────── */}
      {variantGroups.length > 0 && (
        <section
          aria-labelledby="shopify-variant-heading"
          className="px-5 py-4 border-b border-slate-100 dark:border-slate-800"
        >
          <div className="flex items-center gap-2 mb-3">
            <h3 id="shopify-variant-heading" className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Variant Image Assignment</h3>
            <span className="text-xs text-slate-400">shown when buyer selects that {activeAxis.toLowerCase()}</span>
          </div>

          <ul role="list" className="space-y-2">
            {variantGroups.map(({ groupValue, assignedImage }) => (
              <li
                key={groupValue}
                aria-label={`${groupValue}${assignedImage ? ', image assigned' : ', no image assigned'}${assignedImage?.isPending ? ', unsaved' : ''}`}
                className="flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/50"
              >
                {/* Colour label */}
                <div className="w-24 flex-shrink-0">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{groupValue}</span>
                </div>

                {/* Assigned image or placeholder */}
                {assignedImage ? (
                  <div
                    onClick={() => onOpenLightboxForCell?.(
                      assignedImage.id.startsWith('tmp_') ? undefined : assignedImage.id,
                      assignedImage.url,
                    )}
                    className={cn(
                      'relative w-12 h-12 rounded-lg border overflow-hidden bg-white dark:bg-slate-900 flex-shrink-0',
                      assignedImage.isPending ? 'border-amber-400 ring-1 ring-amber-400' : 'border-slate-200 dark:border-slate-700',
                      onOpenLightboxForCell && 'cursor-zoom-in',
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assignedImage.url} alt="" draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />
                    {assignedImage.isPending && (
                      <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                    )}
                  </div>
                ) : (
                  <div
                    className="w-12 h-12 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-300 flex-shrink-0"
                    aria-hidden="true"
                  >
                    <Plus className="w-4 h-4" />
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 ml-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={assignedImage ? `Change image for ${groupValue}` : `Assign image to ${groupValue}`}
                    className="text-xs h-7 px-2.5"
                    onClick={() => setPickerTarget({ colorValue: groupValue })}
                  >
                    {assignedImage ? 'Change' : 'Assign'}
                  </Button>
                  {assignedImage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Clear image for ${groupValue}`}
                      className="text-xs h-7 px-2.5 text-slate-400 hover:text-red-500"
                      onClick={() => handleClearAssignment(groupValue)}
                    >
                      Clear
                    </Button>
                  )}
                </div>

                {!assignedImage && (
                  <span title={`${groupValue} has no image assigned`} aria-hidden="true">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* IM.7 — Cross-channel sync */}
      <CrossChannelSyncBar
        channel="shopify"
        hasMasterImages={masterImages.length > 0}
        hasAmazonImages={listingImages.some((i) => i.platform === 'AMAZON' && !i.variantGroupKey)}
        hasAmazonAssignments={listingImages.some((i) => i.platform === 'AMAZON' && i.variantGroupKey)}
        onCopyFromMaster={onCopyFromMaster}
        onCopyFromAmazonPool={onCopyFromAmazonPool}
        onCopyFromAmazonAssignments={onCopyFromAmazonAssignments}
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
          <span className="text-slate-400 ml-1">— Shopify product page as a buyer would see it</span>
          <ChevronDown className={cn('w-3.5 h-3.5 ml-auto text-slate-400 transition-transform', previewOpen && 'rotate-180')} />
        </button>
        {previewOpen && (
          <div className="px-4 pb-4">
            <ChannelPreview
              platform="SHOPIFY"
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
          <span className="text-slate-400 ml-1">— Shopify product + variant updates + retry</span>
          <ChevronDown className={cn('w-3.5 h-3.5 ml-auto text-slate-400 transition-transform', historyOpen && 'rotate-180')} />
        </button>
        {historyOpen && (
          <div className="px-4 pb-4">
            <ImagePublishHistory productId={productId} channel="SHOPIFY" />
          </div>
        )}
      </div>

      {/* PB.3c — Recent jobs strip (compact, last 3) */}
      <RecentChannelJobsStrip productId={productId} channel="SHOPIFY" refreshKey={jobsRefreshKey} />

      {/* PB.4 — sticky publish bar so the Publish button stays in
          reach when the pool + variant assignments push it below the
          fold. */}
      <div
        data-publish-anchor
        className="sticky bottom-0 z-10 bg-white dark:bg-slate-900 rounded-b-xl px-5 py-3 border-t border-slate-100 dark:border-slate-800 shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_8px_-2px_rgba(0,0,0,0.5)] flex flex-col gap-1.5"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">
            PUT /products/{'{id}'} · variant image_id assignment via REST
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
            Publish to Shopify
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
            if (pickerTarget === 'pool') {
              handleAddToPool(url, sourceId)
            } else {
              handleAssignVariant(pickerTarget.colorValue, url, sourceId)
            }
            setPickerTarget(null)
          }}
          onClose={() => setPickerTarget(null)}
        />
      )}

      {/* PB.3b — Pre-publish preview modal */}
      <ChannelPublishPreviewModal
        open={publishPreviewOpen}
        channel="SHOPIFY"
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

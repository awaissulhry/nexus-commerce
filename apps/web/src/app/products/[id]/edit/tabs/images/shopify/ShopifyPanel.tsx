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
  AlertTriangle, CheckCircle2, GripVertical, Loader2, Plus,
  Star, Store, Trash2, Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'
import ImagePickerModal from '../ImagePickerModal'
import CrossChannelSyncBar from '../CrossChannelSyncBar'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary, WorkspaceProduct } from '../types'

interface CopyResult { copied: number; skipped: number }

const SHOPIFY_MAX = 250

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
  onCopyFromMaster: () => CopyResult
  onCopyFromAmazonPool: () => CopyResult
  onCopyFromAmazonAssignments: () => CopyResult
  publishedCount: number
  onPublish: () => Promise<{ success: boolean; message: string }>
}

interface PoolItem {
  id: string
  url: string
  alt: string | null
  position: number
  isPending: boolean
  publishStatus?: string
}

export default function ShopifyPanel({
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
  onCopyFromAmazonPool,
  onCopyFromAmazonAssignments,
  publishedCount,
  onPublish,
}: Props) {
  const [publishing, setPublishing] = useState(false)
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

    return [...base, ...news].sort((a, b) => a.position - b.position)
  }, [listingImages, pendingUpserts, pendingDeletes])

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

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
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

      {/* ── Image pool ─────────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Image Pool</h3>
          <span className="text-xs text-slate-400">
            <Star className="w-3 h-3 inline mr-0.5 text-blue-500" />
            Position 1 = featured product image
          </span>
        </div>

        {effectivePool.length === 0 ? (
          <div
            className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-10 flex flex-col items-center gap-2 text-slate-400 cursor-pointer hover:border-emerald-300 transition-colors"
            onClick={() => setPickerTarget('pool')}
          >
            <Store className="w-8 h-8" />
            <span className="text-sm">Add images to the Shopify pool</span>
            <span className="text-xs">Position 1 becomes the featured image</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {effectivePool.map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => onDragStart(e, index)}
                onDragOver={(e) => onDragOver(e, index)}
                onDragLeave={() => setDragOverIndex(null)}
                onDrop={(e) => onDrop(e, index)}
                className={cn(
                  'group relative w-20 h-20 rounded-xl border-2 overflow-hidden bg-slate-50 dark:bg-slate-800 flex-shrink-0 transition-all',
                  dragOverIndex === index
                    ? 'border-emerald-400 ring-2 ring-emerald-300'
                    : 'border-slate-200 dark:border-slate-700',
                  item.isPending && 'ring-1 ring-amber-400',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.url} alt={item.alt ?? ''} className="w-full h-full object-contain" loading="lazy" />

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

                <div className="absolute bottom-0.5 left-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab">
                  <GripVertical className="w-3 h-3 text-white drop-shadow" />
                </div>

                <button
                  type="button"
                  className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 rounded p-0.5"
                  onClick={() => addPendingDelete(item.id)}
                >
                  <Trash2 className="w-2.5 h-2.5 text-white" />
                </button>
              </div>
            ))}

            {!atMax && (
              <button
                type="button"
                onClick={() => setPickerTarget('pool')}
                className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-emerald-300 transition-colors flex-shrink-0"
              >
                <Plus className="w-5 h-5" />
                <span className="text-[10px]">Add</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Variant image assignment ────────────────────────────────── */}
      {variantGroups.length > 0 && (
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Variant Image Assignment</h3>
            <span className="text-xs text-slate-400">shown when buyer selects that {activeAxis.toLowerCase()}</span>
          </div>

          <div className="space-y-2">
            {variantGroups.map(({ groupValue, assignedImage }) => (
              <div key={groupValue} className="flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                {/* Colour label */}
                <div className="w-24 flex-shrink-0">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{groupValue}</span>
                </div>

                {/* Assigned image or placeholder */}
                {assignedImage ? (
                  <div className={cn(
                    'relative w-12 h-12 rounded-lg border overflow-hidden bg-white dark:bg-slate-900 flex-shrink-0',
                    assignedImage.isPending ? 'border-amber-400 ring-1 ring-amber-400' : 'border-slate-200 dark:border-slate-700',
                  )}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assignedImage.url} alt="" className="w-full h-full object-contain" loading="lazy" />
                    {assignedImage.isPending && (
                      <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                    )}
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-300 flex-shrink-0">
                    <Plus className="w-4 h-4" />
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 ml-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7 px-2.5"
                    onClick={() => setPickerTarget({ colorValue: groupValue })}
                  >
                    {assignedImage ? 'Change' : 'Assign'}
                  </Button>
                  {assignedImage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7 px-2.5 text-slate-400 hover:text-red-500"
                      onClick={() => handleClearAssignment(groupValue)}
                    >
                      Clear
                    </Button>
                  )}
                </div>

                {!assignedImage && (
                  <span title={`${groupValue} has no image assigned`}>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
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

      {/* Publish */}
      <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex flex-col gap-1.5">
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
            disabled={publishing}
            onClick={async () => {
              setPublishing(true)
              try {
                const result = await onPublish()
                setLastPublish({ ...result, ts: new Date().toISOString() })
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
    </div>
  )
}

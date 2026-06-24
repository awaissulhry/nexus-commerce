'use client'

// Simplified eBay colour-photo panel.
// ONE job: assign per-colour images, then publish.
// No global pending store — all state is local.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Plus, ShoppingBag, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'
import type { ListingImage, ProductImage, VariantSummary, WorkspaceProduct } from '../types'

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  productId: string
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  onReload?: () => void
  onToast?: (msg: string) => void

  // Old props — accepted but ignored so the parent doesn't need to change.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activeAxis?: string
  pendingUpserts?: unknown
  pendingDeletes?: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addPendingUpsert?: (upsert: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addPendingDelete?: (id: any) => void
  onCopyFromMaster?: () => void
  onCopyFromAmazonGallery?: () => void
  onCopyFromAmazonColorSets?: () => void
  publishedCount?: number
  onPublish?: () => Promise<{ success: boolean; message: string }>
  channelLiveImages?: unknown[]
  onAdoptToMaster?: (url: string) => void | Promise<void>
  onOpenRollback?: () => void
  onOpenLightboxForCell?: (id: string | undefined, url: string) => void
}

interface ListingImageUpsert {
  scope: 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
  platform?: string | null
  marketplace?: string | null
  variantGroupKey?: string | null
  variantGroupValue?: string | null
  variationId?: string | null
  url: string
  position?: number
  role?: string
  sourceProductImageId?: string | null
}

// colour (axis value) → ordered list of URLs
type ColorSets = Map<string, string[]>
// variationId (child product id) → ordered list of URLs — optional per-SKU override
type SkuSets = Map<string, string[]>

// ── Helpers ────────────────────────────────────────────────────────────────

function getAxisValues(variants: VariantSummary[], axis: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of variants) {
    const val = (v.variantAttributes as Record<string, string> | null)?.[axis]
    if (val && !seen.has(val)) { seen.add(val); out.push(val) }
  }
  return out
}

function availableAxes(variants: VariantSummary[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of variants) {
    for (const k of Object.keys(v.variantAttributes ?? {})) {
      if (!seen.has(k)) { seen.add(k); out.push(k) }
    }
  }
  return out
}

function defaultAxis(product: WorkspaceProduct, axes: string[]): string {
  const pref = product.imageAxisPreference
  if (pref) {
    const match = axes.find((a) => a.toLowerCase() === pref.toLowerCase())
    if (match) return match
  }
  return axes.find((a) => a.toLowerCase() === 'color') ?? axes[0] ?? 'Color'
}

function initColorSets(listingImages: ListingImage[], axis: string, colorValues: string[]): ColorSets {
  const map: ColorSets = new Map()
  for (const cv of colorValues) map.set(cv, [])

  for (const img of listingImages) {
    if (img.platform !== 'EBAY' || img.variantGroupKey !== axis) continue
    const cv = img.variantGroupValue ?? '—'
    if (!map.has(cv)) map.set(cv, [])
    const list = map.get(cv)!
    // insert at correct position
    list.push(img.url)
  }
  // sort each bucket by original position
  for (const img of listingImages) {
    if (img.platform !== 'EBAY' || img.variantGroupKey !== axis) continue
  }
  return map
}

function initSkuSets(listingImages: ListingImage[]): SkuSets {
  const map: SkuSets = new Map()
  const rows = listingImages
    .filter((i) => i.platform === 'EBAY' && i.variationId)
    .slice()
    .sort((a, b) => a.position - b.position)
  for (const img of rows) {
    const k = img.variationId as string
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(img.url)
  }
  return map
}

// The non-picture-axis attribute values that distinguish a SKU within a value
// (e.g. the size), falling back to the SKU itself.
function skuLabel(v: VariantSummary, pictureAxis: string): string {
  const attrs = v.variantAttributes ?? {}
  const parts = Object.entries(attrs)
    .filter(([k]) => k.toLowerCase() !== pictureAxis.toLowerCase())
    .map(([, val]) => val)
    .filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : v.sku
}

// ── Mini image picker popover ──────────────────────────────────────────────

interface MasterPickerProps {
  masterImages: ProductImage[]
  onPick: (url: string, id: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

function MasterPicker({ masterImages, onPick, onClose, anchorRef }: MasterPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Pick from master images"
      className="absolute z-50 mt-1 left-0 bg-white dark:bg-slate-900 border border-default rounded-xl shadow-lg p-2 w-56"
    >
      {masterImages.length === 0 ? (
        <p className="text-xs text-tertiary p-2">No master images available.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
          {masterImages.map((img) => (
            <button
              key={img.id}
              type="button"
              onClick={() => { onPick(img.url, img.id); onClose() }}
              className="w-14 h-14 rounded-lg border border-default overflow-hidden bg-slate-50 dark:bg-slate-800 hover:ring-2 hover:ring-blue-400 transition-all flex-shrink-0"
              title={img.alt ?? img.url}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.alt ?? ''} className="w-full h-full object-contain" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Reusable "+ from master" button with popover picker ─────────────────────

function MasterPlusButton({
  masterImages, onPick, label, size = 'lg',
}: {
  masterImages: ProductImage[]
  onPick: (url: string, id: string) => void
  label: string
  size?: 'lg' | 'sm'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const box = size === 'lg' ? 'w-16 h-16' : 'w-10 h-10'
  return (
    <div className="relative">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(box, 'rounded-lg border-2 border-dashed border-default flex items-center justify-center text-tertiary hover:border-blue-300 transition-colors flex-shrink-0')}
      >
        <Plus className={size === 'lg' ? 'w-4 h-4' : 'w-3 h-3'} />
      </button>
      {open && (
        <MasterPicker
          masterImages={masterImages}
          onPick={onPick}
          onClose={() => setOpen(false)}
          anchorRef={ref}
        />
      )}
    </div>
  )
}

// ── Colour bucket row ──────────────────────────────────────────────────────

interface ColorBucketProps {
  colorValue: string
  urls: string[]
  masterImages: ProductImage[]
  variantsForColor: VariantSummary[]
  skuSets: SkuSets
  pictureAxis: string
  onAdd: (url: string, sourceId: string) => void
  onRemove: (index: number) => void
  onReorder: (fromIndex: number, toIndex: number) => void
  onAddSku: (variationId: string, url: string, sourceId: string) => void
  onRemoveSku: (variationId: string, index: number) => void
}

function ColorBucket({
  colorValue, urls, masterImages, variantsForColor, skuSets, pictureAxis,
  onAdd, onRemove, onReorder, onAddSku, onRemoveSku,
}: ColorBucketProps) {
  const dragIndexRef = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [skuOpen, setSkuOpen] = useState(false)

  const groupId = `ebay-bucket-${colorValue.replace(/\s+/g, '-').toLowerCase()}`
  const overrideCount = variantsForColor.filter((v) => (skuSets.get(v.id) ?? []).length > 0).length

  return (
    <div
      role="group"
      aria-labelledby={groupId}
      className="border border-default rounded-xl overflow-hidden"
    >
      {/* Label row */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-subtle">
        <span id={groupId} className="text-sm font-semibold text-slate-800 dark:text-slate-200">{colorValue}</span>
        <span className="text-xs text-tertiary ml-auto">{urls.length} image{urls.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Thumbnails */}
      <div className="flex flex-wrap gap-2 p-3">
        {urls.length === 0 && (
          <div className="w-16 h-16 rounded-lg border-2 border-dashed border-default flex items-center justify-center text-tertiary flex-shrink-0">
            <Plus className="w-4 h-4" />
          </div>
        )}

        {urls.map((url, idx) => (
          <div
            key={`${url}-${idx}`}
            draggable
            onDragStart={(e) => {
              dragIndexRef.current = idx
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(idx)
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(null)
              const from = dragIndexRef.current
              dragIndexRef.current = null
              if (from !== null && from !== idx) onReorder(from, idx)
            }}
            onDragEnd={() => { dragIndexRef.current = null; setDragOver(null) }}
            className={cn(
              'group relative w-16 h-16 rounded-lg border border-default overflow-hidden bg-white dark:bg-slate-900 flex-shrink-0 cursor-grab',
              dragOver === idx && 'ring-2 ring-blue-400',
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />
            <button
              type="button"
              aria-label={`Remove image from ${colorValue}`}
              onClick={() => onRemove(idx)}
              className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 rounded-full p-0.5"
            >
              <X className="w-2.5 h-2.5 text-white" />
            </button>
          </div>
        ))}

        <MasterPlusButton masterImages={masterImages} onPick={onAdd} label={`Add image to ${colorValue}`} size="lg" />
      </div>

      {/* Per-SKU override drill-in (optional — collapsed by default) */}
      {variantsForColor.length > 0 && (
        <div className="border-t border-subtle">
          <button
            type="button"
            onClick={() => setSkuOpen((o) => !o)}
            aria-expanded={skuOpen}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <ChevronDown className={cn('w-3 h-3 transition-transform', skuOpen && 'rotate-180')} />
            Per-size override
            {overrideCount > 0 && <span className="text-blue-600 dark:text-blue-400 font-medium">· {overrideCount} set</span>}
            <span className="text-tertiary ml-auto">optional</span>
          </button>
          {skuOpen && (
            <div className="px-3 pb-3 space-y-1.5">
              {variantsForColor.map((v) => {
                const su = skuSets.get(v.id) ?? []
                return (
                  <div key={v.id} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 dark:text-slate-300 w-14 flex-shrink-0 truncate" title={v.sku}>
                      {skuLabel(v, pictureAxis)}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5 flex-1">
                      {su.length === 0 && <span className="text-[10px] text-tertiary italic">inherits {colorValue}</span>}
                      {su.map((url, idx) => (
                        <div key={`${url}-${idx}`} className="group relative w-10 h-10 rounded border border-default overflow-hidden bg-white dark:bg-slate-900 flex-shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="" className="w-full h-full object-contain" loading="lazy" decoding="async" />
                          <button
                            type="button"
                            aria-label={`Remove override from ${v.sku}`}
                            onClick={() => onRemoveSku(v.id, idx)}
                            className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 rounded-bl p-0.5"
                          >
                            <X className="w-2 h-2 text-white" />
                          </button>
                        </div>
                      ))}
                      <MasterPlusButton
                        masterImages={masterImages}
                        onPick={(url, id) => onAddSku(v.id, url, id)}
                        label={`Add override image to ${v.sku}`}
                        size="sm"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function EbayPanel({
  productId,
  product,
  masterImages,
  listingImages,
  variants,
  onReload,
  onToast,
}: Props) {
  // ── Axis picker ──────────────────────────────────────────────────────
  const axes = useMemo(() => availableAxes(variants), [variants])
  const [axis, setAxis] = useState<string>(() => defaultAxis(product, axes))
  const [axisOpen, setAxisOpen] = useState(false)
  const axisRef = useRef<HTMLButtonElement>(null)
  const axisMenuRef = useRef<HTMLDivElement>(null)

  // Close axis dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        axisMenuRef.current && !axisMenuRef.current.contains(e.target as Node) &&
        axisRef.current && !axisRef.current.contains(e.target as Node)
      ) setAxisOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const colorValues = useMemo(() => getAxisValues(variants, axis), [variants, axis])

  // P4.B — persist the chosen axis so the publish (which reads imageAxisPreference)
  // varies images by the SAME axis the operator picks here.
  const persistAxis = useCallback((a: string) => {
    setAxis(a)
    void beFetch(`/api/products/${productId}/images-workspace/axis`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ axis: a }),
    }).catch(() => { /* non-fatal — local state still reflects the choice */ })
  }, [productId])

  // ── Local color sets state ───────────────────────────────────────────
  const [colorSets, setColorSets] = useState<ColorSets>(() =>
    initColorSets(listingImages, axis, colorValues),
  )

  // Re-initialise when axis changes or listingImages reload
  useEffect(() => {
    setColorSets(initColorSets(listingImages, axis, colorValues))
  }, [listingImages, axis, colorValues])

  // ── Per-SKU overrides (optional) ─────────────────────────────────────
  const [skuSets, setSkuSets] = useState<SkuSets>(() => initSkuSets(listingImages))
  useEffect(() => { setSkuSets(initSkuSets(listingImages)) }, [listingImages])

  const handleAdd = useCallback((colorValue: string, url: string) => {
    setColorSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(colorValue) ?? [])]
      if (!list.includes(url)) list.push(url)
      next.set(colorValue, list)
      return next
    })
  }, [])

  const handleRemove = useCallback((colorValue: string, idx: number) => {
    setColorSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(colorValue) ?? [])]
      list.splice(idx, 1)
      next.set(colorValue, list)
      return next
    })
  }, [])

  const handleReorder = useCallback((colorValue: string, fromIdx: number, toIdx: number) => {
    setColorSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(colorValue) ?? [])]
      const [moved] = list.splice(fromIdx, 1)
      list.splice(toIdx, 0, moved)
      next.set(colorValue, list)
      return next
    })
  }, [])

  const handleAddSku = useCallback((variationId: string, url: string) => {
    setSkuSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(variationId) ?? [])]
      if (!list.includes(url)) list.push(url)
      next.set(variationId, list)
      return next
    })
  }, [])

  const handleRemoveSku = useCallback((variationId: string, idx: number) => {
    setSkuSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(variationId) ?? [])]
      list.splice(idx, 1)
      next.set(variationId, list)
      return next
    })
  }, [])

  // ── Publish ──────────────────────────────────────────────────────────
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ success: boolean; message: string } | null>(null)

  async function handlePublish() {
    setPublishing(true)
    setPublishResult(null)
    try {
      // Build upserts from local colorSets
      const upserts: ListingImageUpsert[] = []
      for (const [colorValue, urls] of colorSets.entries()) {
        urls.forEach((url, position) => {
          upserts.push({
            scope: 'PLATFORM',
            platform: 'EBAY',
            marketplace: null,
            variantGroupKey: axis,
            variantGroupValue: colorValue,
            url,
            position,
            role: 'GALLERY',
          })
        })
      }

      // Per-SKU overrides (optional — pinned to a specific variant)
      for (const [variationId, urls] of skuSets.entries()) {
        urls.forEach((url, position) => {
          upserts.push({
            scope: 'PLATFORM',
            platform: 'EBAY',
            marketplace: null,
            variationId,
            url,
            position,
            role: 'GALLERY',
          })
        })
      }

      // Replace ALL existing eBay variation + per-SKU image rows with the current sets.
      const deletes = listingImages
        .filter((i) => i.platform === 'EBAY' && (i.variantGroupKey !== null || i.variationId !== null))
        .map((i) => i.id)

      // 1. Save
      const saveRes = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upserts, deletes }),
      })
      if (!saveRes.ok) {
        const err = await saveRes.text()
        setPublishResult({ success: false, message: `Save failed: ${err}` })
        return
      }

      // 2. Publish to eBay
      const pubRes = await beFetch(`/api/products/${productId}/ebay-images/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!pubRes.ok) {
        const err = await pubRes.text()
        setPublishResult({ success: false, message: `Publish failed: ${err}` })
        return
      }

      setPublishResult({ success: true, message: 'Published to eBay' })
      onToast?.('eBay colour images published')
      onReload?.()
    } catch (err) {
      setPublishResult({ success: false, message: String(err) })
    } finally {
      setPublishing(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-xl flex flex-col">
      {/* ── Sticky header ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-default bg-white dark:bg-slate-900 rounded-t-xl">
        <ShoppingBag className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">eBay Colour Photos</span>

        {/* Axis picker */}
        {axes.length > 0 && (
          <div className="relative flex items-center gap-1.5 ml-2">
            <span className="text-xs text-tertiary">Vary by:</span>
            <div className="relative">
              <button
                ref={axisRef}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={axisOpen}
                onClick={() => setAxisOpen((o) => !o)}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 border border-default rounded-md px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                {axis}
                <ChevronDown className={cn('w-3 h-3 text-tertiary transition-transform', axisOpen && 'rotate-180')} />
              </button>
              {axisOpen && (
                <div
                  ref={axisMenuRef}
                  role="listbox"
                  aria-label="Variation axis"
                  className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-slate-900 border border-default rounded-lg shadow-md py-1 min-w-[8rem]"
                >
                  {axes.map((a) => (
                    <button
                      key={a}
                      role="option"
                      aria-selected={a === axis}
                      type="button"
                      onClick={() => { persistAxis(a); setAxisOpen(false) }}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors',
                        a === axis ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-slate-700 dark:text-slate-300',
                      )}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            disabled={publishing}
            onClick={handlePublish}
            className="gap-1.5"
          >
            {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* ── Publish result banner ──────────────────────────────────────── */}
      {publishResult && (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-xs border-b border-subtle',
            publishResult.success
              ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300',
          )}
        >
          {publishResult.success
            ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
            : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
          <span>{publishResult.message}</span>
          <button
            type="button"
            onClick={() => setPublishResult(null)}
            className="ml-auto opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ── Master photo strip ─────────────────────────────────────────── */}
      {masterImages.length > 0 && (
        <div className="px-4 py-3 border-b border-subtle">
          <p className="text-xs text-tertiary mb-2">
            Assign from master photos — click "+" on a colour row to add
          </p>
          <div className="flex flex-wrap gap-2">
            {masterImages.map((img) => (
              <div
                key={img.id}
                className="w-16 h-16 rounded-lg border border-default overflow-hidden bg-slate-50 dark:bg-slate-800 flex-shrink-0"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.alt ?? ''} className="w-full h-full object-contain" loading="lazy" decoding="async" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Colour buckets ─────────────────────────────────────────────── */}
      <div className="px-4 py-4 space-y-3 flex-1">
        {colorValues.length === 0 ? (
          <div className="py-10 text-center text-xs text-tertiary">
            No variants found for axis &ldquo;{axis}&rdquo;.
            {axes.length > 1 && ' Try a different variation axis.'}
          </div>
        ) : (
          colorValues.map((cv) => (
            <ColorBucket
              key={cv}
              colorValue={cv}
              urls={colorSets.get(cv) ?? []}
              masterImages={masterImages}
              variantsForColor={variants.filter((v) => (v.variantAttributes as Record<string, string> | null)?.[axis] === cv)}
              skuSets={skuSets}
              pictureAxis={axis}
              onAdd={(url) => handleAdd(cv, url)}
              onRemove={(idx) => handleRemove(cv, idx)}
              onReorder={(from, to) => handleReorder(cv, from, to)}
              onAddSku={(variationId, url) => handleAddSku(variationId, url)}
              onRemoveSku={(variationId, idx) => handleRemoveSku(variationId, idx)}
            />
          ))
        )}
      </div>
    </div>
  )
}

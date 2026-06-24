'use client'

// eBay images — renders the SHARED ChannelImageGrid. Rows = a "Default
// (cover & common)" row + one row per colour; columns = photo positions 1,2,3…
//
// eBay shows the Default/group photos before a buyer picks a colour (position 1 =
// the cover/search thumbnail), then focuses the selected colour's photos. eBay
// does NOT reliably de-dupe, so every photo lives in exactly ONE bucket
// (Default OR a colour) — assigning/moving a photo removes it from the others,
// and the publish de-dupes per-colour against the Default set as a safety net.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, ShoppingBag, X } from 'lucide-react'
import { PLATFORM_RULES } from '@nexus/shared/image-validation'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'
import ImagePickerModal from '../ImagePickerModal'
import ChannelImageGrid, { type ImageGridColumn, type ImageGridRow, type GridCellDisplay } from '../ChannelImageGrid'
import type { ListingImage, ProductImage, VariantSummary, WorkspaceProduct } from '../types'

const EBAY_MAX = PLATFORM_RULES.EBAY.maxImages ?? 24
const MIN_COLS = 12
// Bucket key for the shared "Default (cover & common)" gallery row.
const SHARED = '__shared__'

interface Props {
  productId: string
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  onReload?: () => void
  onToast?: (msg: string) => void
  // Legacy props from the old panel — accepted but ignored so ImagesTab doesn't change.
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
  url: string
  position?: number
  role?: string
}

// bucket key (SHARED or a colour value) → ordered list of URLs
type Buckets = Map<string, string[]>

// ── Helpers ──────────────────────────────────────────────────────────────────

function availableAxes(variants: VariantSummary[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of variants) for (const k of Object.keys(v.variantAttributes ?? {})) if (!seen.has(k)) { seen.add(k); out.push(k) }
  return out
}

function getAxisValues(variants: VariantSummary[], axis: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of variants) {
    const val = (v.variantAttributes as Record<string, string> | null)?.[axis]
    if (val && !seen.has(val)) { seen.add(val); out.push(val) }
  }
  return out
}

function defaultAxis(product: WorkspaceProduct, axes: string[]): string {
  const pref = product.imageAxisPreference
  if (pref) { const m = axes.find((a) => a.toLowerCase() === pref.toLowerCase()); if (m) return m }
  return axes.find((a) => a.toLowerCase() === 'color') ?? axes[0] ?? 'Color'
}

function initBuckets(listingImages: ListingImage[], axis: string, values: string[]): Buckets {
  const map: Buckets = new Map()
  map.set(SHARED, [])
  for (const v of values) map.set(v, [])
  const pairsByBucket = new Map<string, Array<{ position: number; url: string }>>()
  for (const img of listingImages) {
    if (img.platform !== 'EBAY' || img.variationId) continue
    let bucket: string | null = null
    if (img.variantGroupKey == null) bucket = SHARED                       // Default / group images
    else if (img.variantGroupKey === axis) bucket = img.variantGroupValue ?? '—'  // per-colour
    if (bucket == null) continue
    if (!pairsByBucket.has(bucket)) pairsByBucket.set(bucket, [])
    pairsByBucket.get(bucket)!.push({ position: img.position ?? 0, url: img.url })
  }
  for (const [bucket, pairs] of pairsByBucket.entries()) {
    pairs.sort((a, b) => a.position - b.position)
    map.set(bucket, pairs.map((p) => p.url))
  }
  return map
}

// ── Component ────────────────────────────────────────────────────────────────

export default function EbayPanel({ productId, product, masterImages, listingImages, variants, onReload, onToast }: Props) {
  const axes = useMemo(() => availableAxes(variants), [variants])
  const [axis, setAxis] = useState<string>(() => defaultAxis(product, axes))
  const [axisOpen, setAxisOpen] = useState(false)
  const axisRef = useRef<HTMLButtonElement>(null)
  const axisMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (axisMenuRef.current && !axisMenuRef.current.contains(e.target as Node) && axisRef.current && !axisRef.current.contains(e.target as Node)) setAxisOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const colorValues = useMemo(() => getAxisValues(variants, axis), [variants, axis])

  const persistAxis = useCallback((a: string) => {
    setAxis(a)
    void beFetch(`/api/products/${productId}/images-workspace/axis`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ axis: a }),
    }).catch(() => { /* non-fatal */ })
  }, [productId])

  // ── Buckets state (SHARED + per-colour) ──────────────────────────────
  const [buckets, setBuckets] = useState<Buckets>(() => initBuckets(listingImages, axis, colorValues))
  useEffect(() => { setBuckets(initBuckets(listingImages, axis, colorValues)) }, [listingImages, axis, colorValues])

  // Assign a URL to a bucket cell. No-overlap: the photo is removed from every
  // OTHER bucket first, so it can never appear twice.
  const assign = useCallback((bucket: string, replaceIndex: number | null, url: string) => {
    setBuckets((prev) => {
      const next = new Map(prev)
      // No cross-bucket overlap — remove this photo from every OTHER bucket.
      for (const [k, list] of next) if (k !== bucket && list.includes(url)) next.set(k, list.filter((u) => u !== url))
      let list = [...(next.get(bucket) ?? [])]
      if (replaceIndex != null && replaceIndex < list.length) list[replaceIndex] = url
      else list.push(url)
      // In-bucket de-dupe (first occurrence wins) so a photo never repeats in a row.
      const seen = new Set<string>()
      list = list.filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
      next.set(bucket, list)
      return next
    })
  }, [])

  const removeAt = useCallback((bucket: string, position: number) => {
    setBuckets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(bucket) ?? [])]
      list.splice(position - 1, 1)
      next.set(bucket, list)
      return next
    })
  }, [])

  // Move a photo between cells (drag-reorder, incl. dragging a colour photo onto
  // the Default row = "set as cover"). No-overlap kept on cross-bucket moves.
  const move = useCallback((from: { rowKey: string | null; columnKey: string }, to: { rowKey: string | null; columnKey: string }) => {
    const fromB = from.rowKey ?? SHARED
    const toB = to.rowKey ?? SHARED
    setBuckets((prev) => {
      const next = new Map(prev)
      const fromList = [...(next.get(fromB) ?? [])]
      const [moved] = fromList.splice(Number(from.columnKey) - 1, 1)
      if (moved === undefined) return prev
      if (fromB === toB) {
        fromList.splice(Math.min(Number(to.columnKey) - 1, fromList.length), 0, moved)
        next.set(fromB, fromList)
      } else {
        const toList = [...(next.get(toB) ?? [])].filter((u) => u !== moved)
        toList.splice(Math.min(Number(to.columnKey) - 1, toList.length), 0, moved)
        next.set(fromB, fromList)
        next.set(toB, toList)
      }
      return next
    })
  }, [])

  // ── Grid model ───────────────────────────────────────────────────────
  const colCount = useMemo(() => {
    let longest = 0
    for (const list of buckets.values()) longest = Math.max(longest, list.length)
    return Math.min(EBAY_MAX, Math.max(MIN_COLS, longest + 1))
  }, [buckets])

  const columns: ImageGridColumn[] = useMemo(
    () => Array.from({ length: colCount }, (_, i) => ({ key: String(i + 1), label: String(i + 1), sublabel: i === 0 ? 'Main' : undefined, isPrimary: i === 0 })),
    [colCount],
  )

  const gridRows: ImageGridRow[] = useMemo(() => {
    const sharedN = (buckets.get(SHARED) ?? []).length
    return [
      { key: null, label: 'Default', sublabel: `cover + common · ${sharedN} photo${sharedN === 1 ? '' : 's'}` },
      ...colorValues.map((cv) => {
        const n = (buckets.get(cv) ?? []).length
        return { key: cv, label: cv, sublabel: `${n} photo${n === 1 ? '' : 's'}` }
      }),
    ]
  }, [colorValues, buckets])

  const resolveCell = useCallback((rowKey: string | null, colKey: string): GridCellDisplay | null => {
    const url = (buckets.get(rowKey ?? SHARED) ?? [])[Number(colKey) - 1]
    return url ? { url, origin: 'own' } : null
  }, [buckets])

  // ── Picker (shared modal) ────────────────────────────────────────────
  const [pickerTarget, setPickerTarget] = useState<{ bucket: string; replaceIndex: number | null } | null>(null)
  const onCellClick = useCallback((rowKey: string | null, colKey: string) => {
    const bucket = rowKey ?? SHARED
    const list = buckets.get(bucket) ?? []
    const idx = Number(colKey) - 1
    setPickerTarget({ bucket, replaceIndex: idx < list.length ? idx : null })
  }, [buckets])

  // ── Publish ──────────────────────────────────────────────────────────
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ success: boolean; message: string } | null>(null)

  async function handlePublish() {
    setPublishing(true)
    setPublishResult(null)
    try {
      const upserts: ListingImageUpsert[] = []
      for (const [bucket, urls] of buckets.entries()) {
        urls.forEach((url, position) => {
          if (bucket === SHARED) {
            upserts.push({ scope: 'PLATFORM', platform: 'EBAY', marketplace: null, variantGroupKey: null, variantGroupValue: null, url, position, role: position === 0 ? 'MAIN' : 'GALLERY' })
          } else {
            upserts.push({ scope: 'PLATFORM', platform: 'EBAY', marketplace: null, variantGroupKey: axis, variantGroupValue: bucket, url, position, role: 'GALLERY' })
          }
        })
      }
      // Replace the Default + this-axis colour rows; leave per-SKU + other-axis rows alone.
      const deletes = listingImages
        .filter((i) => i.platform === 'EBAY' && !i.variationId && (i.variantGroupKey == null || i.variantGroupKey === axis))
        .map((i) => i.id)

      const saveRes = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upserts, deletes }),
      })
      if (!saveRes.ok) { setPublishResult({ success: false, message: `Save failed: ${await saveRes.text()}` }); return }

      const pubRes = await beFetch(`/api/products/${productId}/ebay-images/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const body = await pubRes.json().catch(() => ({} as { message?: string; success?: boolean }))
      const ok = pubRes.ok && (body as { success?: boolean }).success !== false
      setPublishResult({ success: ok, message: (body as { message?: string }).message ?? (ok ? 'Published to eBay' : `Publish failed (${pubRes.status})`) })
      if (ok) { onToast?.('eBay images published'); onReload?.() }
    } catch (err) {
      setPublishResult({ success: false, message: String(err) })
    } finally {
      setPublishing(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-xl flex flex-col">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-default bg-white dark:bg-slate-900 rounded-t-xl">
        <ShoppingBag className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">eBay Photos</span>

        {axes.length > 0 && (
          <div className="relative flex items-center gap-1.5 ml-2">
            <span className="text-xs text-tertiary">Vary by:</span>
            <div className="relative">
              <button ref={axisRef} type="button" aria-haspopup="listbox" aria-expanded={axisOpen} onClick={() => setAxisOpen((o) => !o)}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300 border border-default rounded-md px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                {axis}
                <ChevronDown className={cn('w-3 h-3 text-tertiary transition-transform', axisOpen && 'rotate-180')} />
              </button>
              {axisOpen && (
                <div ref={axisMenuRef} role="listbox" aria-label="Variation axis" className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-slate-900 border border-default rounded-lg shadow-md py-1 min-w-[8rem]">
                  {axes.map((a) => (
                    <button key={a} role="option" aria-selected={a === axis} type="button" onClick={() => { persistAxis(a); setAxisOpen(false) }}
                      className={cn('w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors', a === axis ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-slate-700 dark:text-slate-300')}>
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="ml-auto">
          <Button size="sm" disabled={publishing} onClick={handlePublish} className="gap-1.5">
            {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* Publish result banner */}
      {publishResult && (
        <div className={cn('flex items-center gap-2 px-4 py-2 text-xs border-b border-subtle', publishResult.success ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300')}>
          {publishResult.success ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
          <span>{publishResult.message}</span>
          <button type="button" onClick={() => setPublishResult(null)} className="ml-auto opacity-60 hover:opacity-100" aria-label="Dismiss"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Master photo strip — drag a photo onto any cell, or click a cell to pick */}
      {masterImages.length > 0 && (
        <div className="px-4 py-3 border-b border-subtle">
          <p className="text-xs text-tertiary mb-2">
            <span className="font-medium text-slate-600 dark:text-slate-300">Default</span> = the cover + colour-neutral photos (size charts, features) shown before a colour is picked.
            Each colour row = that colour&rsquo;s photos. A photo lives in one row only. Drag a photo below onto a cell, or click a cell.
          </p>
          <div className="flex flex-wrap gap-2">
            {masterImages.map((img) => (
              <div
                key={img.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy'
                  e.dataTransfer.setData('application/nexus-image-url', img.url)
                  e.dataTransfer.setData('application/nexus-image-id', img.id)
                }}
                className="w-14 h-14 rounded-lg border border-default overflow-hidden bg-slate-50 dark:bg-slate-800 flex-shrink-0 cursor-grab"
                title={img.alt ?? img.url}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.alt ?? ''} draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The shared grid */}
      <div className="p-4">
        {colorValues.length === 0 ? (
          <div className="py-10 text-center text-xs text-tertiary">
            No variants found for axis &ldquo;{axis}&rdquo;.{axes.length > 1 && ' Try a different variation axis.'}
          </div>
        ) : (
          <ChannelImageGrid
            rows={gridRows}
            columns={columns}
            resolveCell={resolveCell}
            onCellClick={onCellClick}
            onCellDrop={(rowKey, colKey, url) => {
              const bucket = rowKey ?? SHARED
              const idx = Number(colKey) - 1
              assign(bucket, idx < (buckets.get(bucket) ?? []).length ? idx : null, url)
            }}
            onCellMove={move}
            onCellRemove={(rowKey, colKey) => removeAt(rowKey ?? SHARED, Number(colKey))}
            minDimensionPx={PLATFORM_RULES.EBAY.minDimensionPx}
            ariaLabel={`eBay photos grouped by ${axis}`}
            rowHeaderLabel={axis}
          />
        )}
      </div>

      {/* Shared image picker — full overlay, always on top */}
      {pickerTarget && (
        <ImagePickerModal
          productId={productId}
          masterImages={masterImages}
          onSelect={(url) => { assign(pickerTarget.bucket, pickerTarget.replaceIndex, url) }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  )
}

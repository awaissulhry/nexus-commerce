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
import { ChevronDown, Clock, ShoppingBag, Star } from 'lucide-react'
import { PLATFORM_RULES } from '@nexus/shared/image-validation'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from '../api'
import ImagePickerModal from '../ImagePickerModal'
import ImagePublishHistory from '../ImagePublishHistory'
import ChannelImageGrid, { type ImageGridColumn, type ImageGridRow, type GridCellDisplay } from '../ChannelImageGrid'
import type { ListingImage, ProductImage, VariantSummary, WorkspaceProduct } from '../types'

const EBAY_MAX = PLATFORM_RULES.EBAY.maxImages ?? 24
const MIN_COLS = 12
const SHARED = '__shared__'

// Synonym groups kept in sync with VariationValueOrderModal + push service.
const AXIS_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]

function axisSynonymKey(name: string): string {
  const lk = name.toLowerCase().trim()
  for (let i = 0; i < AXIS_SYNONYM_GROUPS.length; i++) {
    if ((AXIS_SYNONYM_GROUPS[i] as string[]).includes(lk)) return `__dim${i}__`
  }
  return lk
}

// Phase-1 — imperative handle the panel hands to ImagesTab so the ONE shared
// bottom action bar (Save / Discard / Publish) drives eBay too. eBay edits live
// in this panel's bucket state, not the shared pendingUpserts registry, so the
// parent calls flush()/discard() instead of savePending()/discardPending().
export interface EbayController {
  /** Persist the current buckets via images-workspace/bulk-save (no publish). */
  flush: () => Promise<boolean>
  /** Revert the working buckets to the saved server baseline. */
  discard: () => void
}

interface Props {
  productId: string
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  onReload?: () => void
  onToast?: (msg: string) => void
  // Phase-1 — feed the shared dirty registry so the bottom bar shows Save/Discard
  // for eBay and the single Publish path covers it.
  onEbayDirtyChange?: (count: number) => void
  registerController?: (ctl: EbayController | null) => void
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

// Deduplicate axes by synonym key so "Colore"/"Color" appear once (first name wins).
function availableAxes(variants: VariantSummary[]): string[] {
  const seenSynonym = new Set<string>()
  const out: string[] = []
  for (const v of variants) {
    for (const k of Object.keys(v.variantAttributes ?? {})) {
      const sk = axisSynonymKey(k)
      if (!seenSynonym.has(sk)) { seenSynonym.add(sk); out.push(k) }
    }
  }
  return out
}

// Collect values for an axis including all synonym aliases (e.g. both 'Colore' and 'Color' rows).
function getAxisValues(variants: VariantSummary[], axis: string): string[] {
  const targetKey = axisSynonymKey(axis)
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of variants) {
    const attrs = v.variantAttributes as Record<string, string> | null
    if (!attrs) continue
    for (const [k, val] of Object.entries(attrs)) {
      if (axisSynonymKey(k) === targetKey && val && !seen.has(val)) { seen.add(val); out.push(val) }
    }
  }
  return out
}

function defaultAxis(product: WorkspaceProduct, axes: string[]): string {
  const pref = product.imageAxisPreference
  if (pref) { const m = axes.find((a) => axisSynonymKey(a) === axisSynonymKey(pref)); if (m) return m }
  // Find the colour axis (dim0) — matches Colore, Color, Couleur, etc.
  return axes.find((a) => axisSynonymKey(a) === '__dim0__') ?? axes[0] ?? 'Color'
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

// Deep-copy buckets so resetting to a baseline never mutates the baseline.
function cloneBuckets(b: Buckets): Buckets {
  const out: Buckets = new Map()
  for (const [k, v] of b) out.set(k, [...v])
  return out
}

// Count cells that differ between the working buckets and the saved baseline.
// Drives the unsaved-changes indicator; reorders count (position matters on eBay).
function bucketsDiff(a: Buckets, b: Buckets): number {
  const keys = new Set<string>([...a.keys(), ...b.keys()])
  let diff = 0
  for (const k of keys) {
    const la = a.get(k) ?? [], lb = b.get(k) ?? []
    const n = Math.max(la.length, lb.length)
    for (let i = 0; i < n; i++) if (la[i] !== lb[i]) diff++
  }
  return diff
}

// ── Component ────────────────────────────────────────────────────────────────

export default function EbayPanel({ productId, product, masterImages, listingImages, variants, onReload, onToast, onEbayDirtyChange, registerController }: Props) {
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
  // `baseline` = the saved server truth; `buckets` = the working copy. Edits
  // diverge the working copy; Save (flush) persists it, Discard resets to
  // baseline. The divergence count feeds the shared dirty registry (Phase 1).
  const baseline = useMemo(() => initBuckets(listingImages, axis, colorValues), [listingImages, axis, colorValues])
  const [buckets, setBuckets] = useState<Buckets>(() => cloneBuckets(baseline))
  useEffect(() => { setBuckets(cloneBuckets(baseline)) }, [baseline])
  const dirtyCount = useMemo(() => bucketsDiff(buckets, baseline), [buckets, baseline])

  // Publish history (shared panel). The signature changes when eBay rows get a
  // new publishStatus/publishedAt (i.e. a publish landed) → history auto-refreshes.
  const [historyOpen, setHistoryOpen] = useState(false)
  const ebayPublishSig = useMemo(
    () => listingImages.filter((i) => i.platform === 'EBAY').map((i) => `${i.id}:${i.publishStatus}:${i.publishedAt ?? ''}`).join('|'),
    [listingImages],
  )

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

  // Promote a photo to the row's lead (position 1 / Main) — the photo buyers see
  // first for that row. Pure in-bucket move-to-front, so no duplication risk.
  const setAsMain = useCallback((bucket: string, position: number) => {
    setBuckets((prev) => {
      const idx = position - 1
      const cur = prev.get(bucket) ?? []
      if (idx <= 0 || idx >= cur.length) return prev // already main / out of range
      const next = new Map(prev)
      const list = [...cur]
      const [moved] = list.splice(idx, 1)
      list.unshift(moved)
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

  // Promote any photo to the lead (Main).
  const onSetPrimary = useCallback((rowKey: string | null, colKey: string) => {
    setAsMain(rowKey ?? SHARED, Number(colKey))
  }, [setAsMain])

  // ── Remove (with a guard on the lead photo) ──────────────────────────
  // Removing the Main when other photos remain would silently promote the next
  // one — and that photo is what buyers see first. So confirm + show the swap.
  const [confirmRemoveMain, setConfirmRemoveMain] = useState<{ bucket: string; rowLabel: string; currentUrl: string; nextUrl: string } | null>(null)
  const handleCellRemove = useCallback((rowKey: string | null, colKey: string) => {
    const bucket = rowKey ?? SHARED
    const list = buckets.get(bucket) ?? []
    if (Number(colKey) === 1 && list.length > 1) {
      setConfirmRemoveMain({ bucket, rowLabel: bucket === SHARED ? 'Default' : bucket, currentUrl: list[0], nextUrl: list[1] })
      return
    }
    removeAt(bucket, Number(colKey))
  }, [buckets, removeAt])

  // ── Save / Discard wiring (Phase 1) ──────────────────────────────────
  // The shared bottom action bar owns Save / Discard / Publish. We hand it an
  // imperative flush()/discard() + report our dirty count. Refs keep those
  // callbacks stable while always reading the latest state.
  const bucketsRef = useRef(buckets)
  useEffect(() => { bucketsRef.current = buckets }, [buckets])
  const axisStateRef = useRef(axis)
  useEffect(() => { axisStateRef.current = axis }, [axis])
  const listingRef = useRef(listingImages)
  useEffect(() => { listingRef.current = listingImages }, [listingImages])
  const baselineRef = useRef(baseline)
  useEffect(() => { baselineRef.current = baseline }, [baseline])

  // flush — persist the working buckets as eBay ListingImage rows (full replace of
  // the Default + this-axis colour rows; per-SKU + other-axis rows untouched).
  // Does NOT publish — publishing is the bottom bar's single Publish action.
  const flush = useCallback(async (): Promise<boolean> => {
    const upserts: ListingImageUpsert[] = []
    for (const [bucket, urls] of bucketsRef.current.entries()) {
      urls.forEach((url, position) => {
        if (bucket === SHARED) upserts.push({ scope: 'PLATFORM', platform: 'EBAY', marketplace: null, variantGroupKey: null, variantGroupValue: null, url, position, role: position === 0 ? 'MAIN' : 'GALLERY' })
        else upserts.push({ scope: 'PLATFORM', platform: 'EBAY', marketplace: null, variantGroupKey: axisStateRef.current, variantGroupValue: bucket, url, position, role: 'GALLERY' })
      })
    }
    const deletes = listingRef.current
      .filter((i) => i.platform === 'EBAY' && !i.variationId && (i.variantGroupKey == null || i.variantGroupKey === axisStateRef.current))
      .map((i) => i.id)
    try {
      const res = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upserts, deletes }),
      })
      if (!res.ok) { onToast?.(`eBay save failed: ${await res.text()}`); return false }
      await onReload?.()  // refresh listingImages → buckets re-init to saved (dirty → 0)
      return true
    } catch (err) {
      onToast?.(`eBay save failed: ${String(err)}`)
      return false
    }
  }, [productId, onReload, onToast])

  // discard — drop local edits, snap back to the saved baseline.
  const discard = useCallback(() => { setBuckets(cloneBuckets(baselineRef.current)) }, [])

  // Report dirty + register the controller with the parent.
  useEffect(() => { onEbayDirtyChange?.(dirtyCount) }, [dirtyCount, onEbayDirtyChange])
  useEffect(() => {
    registerController?.({ flush, discard })
    return () => registerController?.(null)
  }, [registerController, flush, discard])

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

        {/* Phase 1 — no panel Publish button. Save / Discard / Publish all live
            in the shared bottom action bar (one source of truth). */}
        <span className="ml-auto text-[11px] text-tertiary hidden sm:inline">Save &amp; publish from the bar below ↓</span>
      </div>

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
            onCellRemove={handleCellRemove}
            onSetPrimary={onSetPrimary}
            minDimensionPx={PLATFORM_RULES.EBAY.minDimensionPx}
            ariaLabel={`eBay photos grouped by ${axis}`}
            rowHeaderLabel={axis}
          />
        )}
      </div>

      {/* Publish history (shared component) — per-publish status / errors / retry */}
      <div className="border-t border-subtle dark:border-slate-800">
        <button
          type="button"
          onClick={() => setHistoryOpen((p) => !p)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          aria-expanded={historyOpen}
        >
          <Clock className="w-3.5 h-3.5 text-tertiary" />
          <span className="font-medium">Publish history</span>
          <span className="text-tertiary ml-1">— eBay publishes + retry</span>
          <ChevronDown className={cn('w-3.5 h-3.5 ml-auto text-tertiary transition-transform', historyOpen && 'rotate-180')} />
        </button>
        {historyOpen && (
          <div className="px-4 pb-4">
            <ImagePublishHistory productId={productId} channel="EBAY" refreshKey={ebayPublishSig} />
          </div>
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

      {/* Confirm removing the Main (lead) photo — never silently change what
          buyers see first; show exactly which photo takes over. */}
      {confirmRemoveMain && (
        <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label="Confirm removing the main photo">
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-default shadow-2xl max-w-sm w-full p-5">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Remove the main photo?</h3>
            <p className="text-xs text-tertiary mt-1">
              The next photo becomes the new main for{' '}
              <span className="font-medium text-slate-700 dark:text-slate-300">{confirmRemoveMain.rowLabel}</span>
              {' '}— what buyers see first.
            </p>
            <div className="flex items-center justify-center gap-3 my-4">
              <div className="text-center">
                <div className="w-20 h-20 rounded-lg border border-default overflow-hidden bg-slate-50 dark:bg-slate-800 relative opacity-70">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={confirmRemoveMain.currentUrl} alt="" className="w-full h-full object-contain" />
                  <div className="absolute inset-0 bg-red-500/10" />
                </div>
                <span className="text-[10px] text-red-500 mt-1 block">Removing</span>
              </div>
              <span className="text-tertiary text-lg leading-none">→</span>
              <div className="text-center">
                <div className="w-20 h-20 rounded-lg border-2 border-amber-400 overflow-hidden bg-slate-50 dark:bg-slate-800 relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={confirmRemoveMain.nextUrl} alt="" className="w-full h-full object-contain" />
                  <Star className="absolute top-1 left-1 w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                </div>
                <span className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 block">New main</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmRemoveMain(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => { removeAt(confirmRemoveMain.bucket, 1); setConfirmRemoveMain(null) }}>Remove &amp; promote</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

// eBay images — renders the SHARED ChannelImageGrid (the same grid component the
// Amazon panel will migrate onto). Rows = colours (the chosen axis), columns =
// photo positions 1,2,3… Each colour holds an ordered list of photos that eBay
// shows when a buyer selects that colour (VariationSpecificPictureSet).

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
// Starting width of the grid — it still auto-grows to fit each colour's photos
// (up to EBAY_MAX). 12 gives plenty of room visible up front.
const MIN_COLS = 12

interface Props {
  productId: string
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  onReload?: () => void
  onToast?: (msg: string) => void

  // Legacy props from the old panel — accepted but ignored so ImagesTab
  // doesn't need to change.
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

// colour (axis value) → ordered list of URLs
type ColorSets = Map<string, string[]>

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

function initColorSets(listingImages: ListingImage[], axis: string, values: string[]): ColorSets {
  const map: ColorSets = new Map()
  for (const v of values) map.set(v, [])
  // Collect (position, url) per colour, then sort by position so a reload after
  // a reorder reflects the saved order.
  const buckets = new Map<string, Array<{ position: number; url: string }>>()
  for (const img of listingImages) {
    if (img.platform !== 'EBAY' || img.variantGroupKey !== axis || img.variationId) continue
    const v = img.variantGroupValue ?? '—'
    if (!buckets.has(v)) buckets.set(v, [])
    buckets.get(v)!.push({ position: img.position ?? 0, url: img.url })
  }
  for (const [v, pairs] of buckets.entries()) {
    pairs.sort((a, b) => a.position - b.position)
    map.set(v, pairs.map((p) => p.url))
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

  // P4.B — persist the chosen axis so the publish (which reads imageAxisPreference)
  // varies images by the SAME axis shown here.
  const persistAxis = useCallback((a: string) => {
    setAxis(a)
    void beFetch(`/api/products/${productId}/images-workspace/axis`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ axis: a }),
    }).catch(() => { /* non-fatal */ })
  }, [productId])

  // ── Local colour-set state ───────────────────────────────────────────
  const [colorSets, setColorSets] = useState<ColorSets>(() => initColorSets(listingImages, axis, colorValues))
  useEffect(() => { setColorSets(initColorSets(listingImages, axis, colorValues)) }, [listingImages, axis, colorValues])

  const assignColor = useCallback((colour: string, replaceIndex: number | null, url: string) => {
    setColorSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(colour) ?? [])]
      if (replaceIndex != null && replaceIndex < list.length) list[replaceIndex] = url
      else if (!list.includes(url)) list.push(url)
      next.set(colour, list)
      return next
    })
  }, [])

  const removeCell = useCallback((colour: string, position: number) => {
    setColorSets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(colour) ?? [])]
      list.splice(position - 1, 1)
      next.set(colour, list)
      return next
    })
  }, [])

  const moveCell = useCallback((from: { rowKey: string | null; columnKey: string }, to: { rowKey: string | null; columnKey: string }) => {
    if (from.rowKey === null || to.rowKey === null) return
    const fromRow = from.rowKey
    const toRow = to.rowKey
    setColorSets((prev) => {
      const next = new Map(prev)
      const fromList = [...(next.get(fromRow) ?? [])]
      const [moved] = fromList.splice(Number(from.columnKey) - 1, 1)
      if (moved === undefined) return prev
      if (fromRow === toRow) {
        fromList.splice(Math.min(Number(to.columnKey) - 1, fromList.length), 0, moved)
        next.set(fromRow, fromList)
      } else {
        const toList = [...(next.get(toRow) ?? [])]
        if (!toList.includes(moved)) toList.splice(Math.min(Number(to.columnKey) - 1, toList.length), 0, moved)
        next.set(fromRow, fromList)
        next.set(toRow, toList)
      }
      return next
    })
  }, [])

  // ── Grid model (rows = colours, columns = positions) ─────────────────
  const colCount = useMemo(() => {
    const longest = colorValues.reduce((m, cv) => Math.max(m, (colorSets.get(cv) ?? []).length), 0)
    return Math.min(EBAY_MAX, Math.max(MIN_COLS, longest + 1))
  }, [colorValues, colorSets])

  const columns: ImageGridColumn[] = useMemo(
    () => Array.from({ length: colCount }, (_, i) => ({ key: String(i + 1), label: String(i + 1), sublabel: i === 0 ? 'Main' : undefined, isPrimary: i === 0 })),
    [colCount],
  )

  const gridRows: ImageGridRow[] = useMemo(
    () => colorValues.map((cv) => {
      const n = (colorSets.get(cv) ?? []).length
      return { key: cv, label: cv, sublabel: `${n} photo${n === 1 ? '' : 's'}` }
    }),
    [colorValues, colorSets],
  )

  const resolveCell = useCallback((rowKey: string | null, colKey: string): GridCellDisplay | null => {
    if (rowKey === null) return null
    const url = (colorSets.get(rowKey) ?? [])[Number(colKey) - 1]
    return url ? { url, origin: 'own' } : null
  }, [colorSets])

  // ── Picker (shared modal) ────────────────────────────────────────────
  const [pickerTarget, setPickerTarget] = useState<{ colour: string; replaceIndex: number | null } | null>(null)
  const onCellClick = useCallback((rowKey: string | null, colKey: string) => {
    if (rowKey === null) return
    const list = colorSets.get(rowKey) ?? []
    const idx = Number(colKey) - 1
    setPickerTarget({ colour: rowKey, replaceIndex: idx < list.length ? idx : null })
  }, [colorSets])

  // ── Publish ──────────────────────────────────────────────────────────
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ success: boolean; message: string } | null>(null)

  async function handlePublish() {
    setPublishing(true)
    setPublishResult(null)
    try {
      const upserts: ListingImageUpsert[] = []
      for (const [colour, urls] of colorSets.entries()) {
        urls.forEach((url, position) => {
          upserts.push({ scope: 'PLATFORM', platform: 'EBAY', marketplace: null, variantGroupKey: axis, variantGroupValue: colour, url, position, role: 'GALLERY' })
        })
      }
      // Replace existing per-colour rows for this axis; leave per-SKU rows (variationId) alone.
      const deletes = listingImages
        .filter((i) => i.platform === 'EBAY' && i.variantGroupKey !== null && !i.variationId)
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

      {/* Master photo strip — drag a photo onto any grid cell, or click a cell to pick */}
      {masterImages.length > 0 && (
        <div className="px-4 py-3 border-b border-subtle">
          <p className="text-xs text-tertiary mb-2">
            Main listing photo comes from your <span className="font-medium text-slate-600 dark:text-slate-300">Master</span> tab. Drag a photo below onto a cell, or click a cell to pick — per {axis.toLowerCase()}.
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
            onCellDrop={(rowKey, colKey, url) => { if (rowKey) assignColor(rowKey, Number(colKey) - 1 < (colorSets.get(rowKey) ?? []).length ? Number(colKey) - 1 : null, url) }}
            onCellMove={moveCell}
            onCellRemove={(rowKey, colKey) => { if (rowKey) removeCell(rowKey, Number(colKey)) }}
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
          onSelect={(url) => { assignColor(pickerTarget.colour, pickerTarget.replaceIndex, url) }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  )
}

'use client'
import { createRef, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, ImageIcon, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
// [id] is a literal directory name in the filesystem; TypeScript resolves it fine.
import ChannelImageGrid, { type ImageGridColumn, type ImageGridRow } from '@/app/products/[id]/edit/tabs/images/ChannelImageGrid'
import ImagePickerModal from '@/app/products/[id]/edit/tabs/images/ImagePickerModal'
import type { WorkspaceData, ListingImage, VariantSummary, ProductImage } from '@/app/products/[id]/edit/tabs/images/types'
import { Select } from '@/design-system/primitives/Select'
import { axisSynonymKey } from './variationValueOrder.pure'

// ── Constants ──────────────────────────────────────────────────────────────

const EBAY_MAX = 24
const MIN_COLS = 6
const SHARED = '__shared__'

// ── Axis helpers ────────────────────────────────────────────────────────────
// EFX P3 — axisSynonymKey now has ONE client home (variationValueOrder.pure.ts);
// the local copy that used to live here was removed to prevent drift.

function getAxisValues(variants: VariantSummary[], axis: string): string[] {
  const targetKey = axisSynonymKey(axis)
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of variants) {
    const attrs = v.variantAttributes as Record<string, string> | null
    if (!attrs) continue
    for (const [k, val] of Object.entries(attrs)) {
      if (axisSynonymKey(k) === targetKey && val && !seen.has(val)) {
        seen.add(val); out.push(val)
      }
    }
  }
  return out
}

// ── Bucket model ────────────────────────────────────────────────────────────
// Mirrors EbayPanel.tsx initBuckets exactly.

type Buckets = Map<string, string[]>

function initBuckets(listingImages: ListingImage[], axis: string, colorValues: string[]): Buckets {
  const map: Buckets = new Map()
  map.set(SHARED, [])
  for (const v of colorValues) map.set(v, [])
  const pairsByBucket = new Map<string, Array<{ position: number; url: string }>>()
  for (const img of listingImages) {
    if (img.platform !== 'EBAY' || img.variationId) continue
    let bucket: string | null = null
    if (img.variantGroupKey == null) bucket = SHARED
    else if (img.variantGroupKey === axis) bucket = img.variantGroupValue ?? '—'
    if (bucket == null) continue
    if (!pairsByBucket.has(bucket)) pairsByBucket.set(bucket, [])
    pairsByBucket.get(bucket)!.push({ position: img.position ?? 0, url: img.url })
  }
  for (const [bucket, pairs] of pairsByBucket.entries()) {
    pairs.sort((a, b) => a.position - b.position)
    map.set(bucket, pairs.map(p => p.url))
  }
  return map
}

function cloneBuckets(b: Buckets): Buckets {
  const out: Buckets = new Map()
  for (const [k, v] of b) out.set(k, [...v])
  return out
}

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

// ── Backend fetch ────────────────────────────────────────────────────────────

function beFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getBackendUrl()}${path}`, init)
}

// ── Shared types ─────────────────────────────────────────────────────────────

interface ListingImageUpsert {
  scope: 'PLATFORM'
  platform: 'EBAY'
  marketplace: null
  variantGroupKey: string | null
  variantGroupValue: string | null
  url: string
  position: number
  role: 'MAIN' | 'GALLERY'
}

interface PublishResult {
  success: boolean
  message: string
  pictureCount: number
  colorSetCount: number
  markets?: string[]
  results?: Array<{ sku: string; market: string; status: string; message: string }>
}

// ── FamilySection ─────────────────────────────────────────────────────────────
// One self-contained panel per product family — manages its own workspace data,
// buckets, axis preference, save, and publish independently.
//
// Cross-family drag semantics: within-family drags use onCellMove (move,
// removes from source). Cross-family drags only fire onCellDrop on the target
// (the source's ChannelImageGrid never saw the drag end) → copy semantics.

export interface FamilySectionHandle {
  /** Persist dirty buckets. No-op + returns true when already clean. Returns false on error. */
  save: () => Promise<boolean>
  /** Save if dirty, then push images to all eBay markets. */
  publish: () => Promise<void>
}

interface FamilySectionProps {
  productId: string
  /** Active eBay marketplace — image publish targets ONLY this market. */
  marketplace: string
  /** Show collapse chevron + independent Save/Publish per section. */
  collapsible?: boolean
  /** Mirrors modal open prop — triggers workspace load on open, reset on close. */
  open: boolean
  onSyncColumns?: (urls: string[]) => void
}

const FamilySection = forwardRef<FamilySectionHandle, FamilySectionProps>(
  function FamilySection({ productId, marketplace, collapsible = false, open, onSyncColumns }, ref) {
    const { toast } = useToast()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [workspaceData, setWorkspaceData] = useState<WorkspaceData | null>(null)
    const [collapsed, setCollapsed] = useState(false)

    // ── Load ────────────────────────────────────────────────────────────────

    const load = useCallback(() => {
      if (!productId) return
      setLoading(true); setError(null)
      beFetch(`/api/products/${productId}/images-workspace`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json() as Promise<WorkspaceData>
        })
        .then(setWorkspaceData)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    }, [productId])

    useEffect(() => {
      if (open) load()
      else { setWorkspaceData(null); setError(null) }
    }, [open, load])

    // ── Derive workspace fields ──────────────────────────────────────────────

    const product = workspaceData?.product
    const masterImages = workspaceData?.master ?? []
    const listingImages = workspaceData?.listing ?? []
    const variants = workspaceData?.variants ?? []
    const serverAxes = workspaceData?.availableAxes ?? []

    // Server-recommended axis (respects imageAxisPreference, falls back to colour dim).
    const defaultAxis = useMemo(() => {
      const pref = product?.imageAxisPreference
      if (pref) {
        const match = serverAxes.find(a => axisSynonymKey(a) === axisSynonymKey(pref))
        if (match) return match
      }
      return serverAxes.find(a => axisSynonymKey(a) === '__dim0__') ?? serverAxes[0] ?? 'Colore'
    }, [product?.imageAxisPreference, serverAxes])

    // Operator-chosen override — resets to null on each fresh workspace load.
    const [axisOverride, setAxisOverride] = useState<string | null>(null)
    useEffect(() => { setAxisOverride(null) }, [workspaceData])
    const axis = axisOverride ?? defaultAxis

    const colorValues = useMemo(() => getAxisValues(variants, axis), [variants, axis])

    // ── Bucket state ─────────────────────────────────────────────────────────

    const baseline = useMemo(
      () => initBuckets(listingImages, axis, colorValues),
      [listingImages, axis, colorValues],
    )
    const [buckets, setBuckets] = useState<Buckets>(() => cloneBuckets(baseline))
    useEffect(() => { setBuckets(cloneBuckets(baseline)) }, [baseline])
    const hasDirty = useMemo(() => bucketsDiff(buckets, baseline) > 0, [buckets, baseline])

    // ── Picker target ────────────────────────────────────────────────────────

    const [pickerTarget, setPickerTarget] = useState<{ bucket: string; replaceIndex: number | null } | null>(null)

    // ── Edit mutations ────────────────────────────────────────────────────────
    // No cross-bucket overlap within this family. Cross-family drags only fire
    // onCellDrop on the target, so the source family's buckets stay untouched.

    const assign = useCallback((bucket: string, replaceIndex: number | null, url: string) => {
      setBuckets(prev => {
        const next = new Map(prev)
        for (const [k, list] of next) {
          if (k !== bucket && list.includes(url)) next.set(k, list.filter(u => u !== url))
        }
        let list = [...(next.get(bucket) ?? [])]
        if (replaceIndex != null && replaceIndex < list.length) list[replaceIndex] = url
        else list.push(url)
        const seen = new Set<string>()
        list = list.filter(u => seen.has(u) ? false : (seen.add(u), true))
        next.set(bucket, list)
        return next
      })
    }, [])

    const removeAt = useCallback((bucket: string, posOneBased: number) => {
      setBuckets(prev => {
        const next = new Map(prev)
        const list = [...(next.get(bucket) ?? [])]
        list.splice(posOneBased - 1, 1)
        next.set(bucket, list)
        return next
      })
    }, [])

    const handleCellRemove = useCallback((rowKey: string | null, colKey: string) => {
      removeAt(rowKey ?? SHARED, Number(colKey))
    }, [removeAt])

    const move = useCallback((
      from: { rowKey: string | null; columnKey: string; url: string },
      to: { rowKey: string | null; columnKey: string },
    ) => {
      const fromB = from.rowKey ?? SHARED, toB = to.rowKey ?? SHARED
      setBuckets(prev => {
        const next = new Map(prev)
        const fromList = [...(next.get(fromB) ?? [])]
        const [moved] = fromList.splice(Number(from.columnKey) - 1, 1)
        if (moved === undefined) return prev
        if (fromB === toB) {
          fromList.splice(Math.min(Number(to.columnKey) - 1, fromList.length), 0, moved)
          next.set(fromB, fromList)
        } else {
          const toList = [...(next.get(toB) ?? [])].filter(u => u !== moved)
          toList.splice(Math.min(Number(to.columnKey) - 1, toList.length), 0, moved)
          next.set(fromB, fromList); next.set(toB, toList)
        }
        return next
      })
    }, [])

    // ── Grid model ────────────────────────────────────────────────────────────

    const colCount = useMemo(() => {
      let longest = 0
      for (const list of buckets.values()) longest = Math.max(longest, list.length)
      return Math.min(EBAY_MAX, Math.max(MIN_COLS, longest + 1))
    }, [buckets])

    const columns: ImageGridColumn[] = useMemo(
      () => Array.from({ length: colCount }, (_, i) => ({
        key: String(i + 1), label: String(i + 1),
        sublabel: i === 0 ? 'Main' : undefined, isPrimary: i === 0,
      })),
      [colCount],
    )

    const gridRows: ImageGridRow[] = useMemo(() => {
      const sharedN = (buckets.get(SHARED) ?? []).length
      return [
        { key: null, label: 'Default', sublabel: `cover + common · ${sharedN} photo${sharedN === 1 ? '' : 's'}` },
        ...colorValues.map(cv => {
          const n = (buckets.get(cv) ?? []).length
          return { key: cv, label: cv, sublabel: `${n} photo${n === 1 ? '' : 's'}` }
        }),
      ]
    }, [colorValues, buckets])

    const resolveCell = useCallback((rowKey: string | null, colKey: string) => {
      const idx = Number(colKey) - 1
      const ownUrl = (buckets.get(rowKey ?? SHARED) ?? [])[idx]
      if (ownUrl) return { url: ownUrl, origin: 'own' as const }
      // P4 — inherit SHARED image when variant bucket has no own image at this position.
      // Rendered with origin:'inherited' → dimmed + ∀ badge; remove button suppressed.
      // Dropping an image onto the cell calls assign() which adds to the variant bucket,
      // giving that variant its own image that then takes precedence over the inherited one.
      if (rowKey !== null) {
        const sharedUrl = (buckets.get(SHARED) ?? [])[idx]
        if (sharedUrl) return { url: sharedUrl, origin: 'inherited' as const }
      }
      return null
    }, [buckets])

    // ── Save ──────────────────────────────────────────────────────────────────

    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [syncUrls, setSyncUrls] = useState<string[] | null>(null)

    // flush — persist dirty buckets. skipToast=true when publish will show the outcome.
    // Returns true on success or when already clean; false on error.
    const flush = useCallback(async (skipToast = false): Promise<boolean> => {
      if (!productId || !hasDirty) return true
      setSaving(true); setSaveError(null)
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
        const deletes = listingImages
          .filter(i => i.platform === 'EBAY' && !i.variationId && (i.variantGroupKey == null || i.variantGroupKey === axis))
          .map(i => i.id)
        const res = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts, deletes }),
        })
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`Save failed (${res.status}): ${body}`)
        }
        if (!skipToast) toast.success('Images saved')
        const shared = buckets.get(SHARED) ?? []
        if (onSyncColumns && shared.length > 0) setSyncUrls(shared.slice(0, 6))
        load()
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setSaveError(msg)
        return false
      } finally {
        setSaving(false)
      }
    }, [productId, hasDirty, buckets, axis, listingImages, onSyncColumns, load, toast])

    // ── Publish ───────────────────────────────────────────────────────────────

    const [publishState, setPublishState] = useState<'idle' | 'saving' | 'publishing' | 'done' | 'failed'>('idle')
    const [publishResult, setPublishResult] = useState<PublishResult | null>(null)
    const publishing = publishState === 'saving' || publishState === 'publishing'

    const publish = useCallback(async () => {
      if (!productId) return
      setPublishResult(null)
      if (hasDirty) {
        setPublishState('saving')
        const ok = await flush(true)
        if (!ok) { setPublishState('idle'); return }
      }
      setPublishState('publishing')
      try {
        // FFP.7 — send the axis the operator is LOOKING AT. The server used to
        // re-derive it (imageAxisPreference ?? 'Color'), which silently curated
        // against a different axis than the one on screen — on single-axis
        // (Size-only) families that mismatch broke the publish outright.
        const res = await beFetch(`/api/products/${productId}/ebay-images/publish?marketplace=${encodeURIComponent(marketplace)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeAxis: axis }),
        })
        const body: PublishResult = await res.json()
        setPublishResult(body)
        setPublishState(body.success ? 'done' : 'failed')
        if (body.success) toast.success(`Published ${body.pictureCount} image${body.pictureCount !== 1 ? 's' : ''} to eBay`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setPublishResult({ success: false, message: msg, pictureCount: 0, colorSetCount: 0 })
        setPublishState('failed')
      }
    }, [productId, marketplace, axis, hasDirty, flush, toast])

    // ── Imperative handle ─────────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      save: () => flush(false),
      publish,
    }), [flush, publish])

    // ── Render ────────────────────────────────────────────────────────────────

    const sku = product?.sku ?? productId

    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">

        {/* Section header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
          {collapsible && (
            <button
              type="button"
              aria-label={collapsed ? `Expand ${sku}` : `Collapse ${sku}`}
              onClick={() => setCollapsed(c => !c)}
              className="flex-shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 dark:hover:text-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              {collapsed
                ? <ChevronRight className="w-4 h-4" />
                : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex-shrink-0 min-w-0 truncate">{sku}</span>
          {hasDirty && !saving && (
            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium flex-shrink-0">
              unsaved
            </span>
          )}
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 flex-shrink-0" />}
          {!loading && serverAxes.length > 1 && (
            <Select value={axis} onChange={e => setAxisOverride(e.target.value)} className="text-xs ml-1 flex-shrink-0">
              {serverAxes.map(a => <option key={a} value={a}>{a}</option>)}
            </Select>
          )}
          <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
            {hasDirty && (
              <Button
                size="sm" variant="ghost"
                onClick={() => { setBuckets(cloneBuckets(baseline)); setSaveError(null) }}
                disabled={saving || publishing}
              >
                Discard
              </Button>
            )}
            <Button
              size="sm" variant="secondary"
              onClick={() => { void flush(false) }}
              disabled={saving || publishing || !hasDirty}
            >
              {saving
                ? <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>
                : 'Save'}
            </Button>
            <Button size="sm" onClick={() => { void publish() }} disabled={publishing}>
              {publishState === 'saving'
                ? <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>
                : publishState === 'publishing'
                ? <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Publishing…</span>
                : hasDirty ? 'Save & Publish' : 'Publish'}
            </Button>
          </div>
        </div>

        {/* Section body */}
        {!collapsed && (
          <div className="p-4 flex flex-col gap-4">

            {/* Inline error / sync banners */}
            {saveError && (
              <Banner variant="danger" title="Save failed">{saveError}</Banner>
            )}
            {syncUrls && onSyncColumns && (
              <Banner variant="info" title="Sync flat-file columns?">
                Copy the {syncUrls.length} Default image{syncUrls.length !== 1 ? 's' : ''} into image_1–{syncUrls.length} on the rows for this product?
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => {
                    onSyncColumns(syncUrls)
                    setSyncUrls(null)
                    toast.success(`Synced ${syncUrls.length} image column${syncUrls.length !== 1 ? 's' : ''}`)
                  }}>
                    Yes, sync
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSyncUrls(null)}>Skip</Button>
                </div>
              </Banner>
            )}

            {/* Loading skeleton */}
            {loading && (
              <div className="space-y-3">
                <Skeleton height={80} radius={8} />
                <Skeleton height={200} radius={8} />
              </div>
            )}

            {/* Load error */}
            {!loading && error && (
              <Banner variant="danger" title="Failed to load images">{error}</Banner>
            )}

            {/* Content */}
            {!loading && !error && workspaceData && (
              <>
                {/* Master gallery */}
                {masterImages.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                      <span className="font-medium text-slate-700 dark:text-slate-200">Master gallery</span>
                      {' · '}Drag onto a cell or click any cell to pick.
                      Dragging to another product copies the photo (source keeps it).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {masterImages.map(img => (
                        <div
                          key={img.id} draggable
                          onDragStart={e => {
                            e.dataTransfer.effectAllowed = 'copy'
                            e.dataTransfer.setData('application/nexus-image-url', img.url)
                            e.dataTransfer.setData('application/nexus-image-id', img.id)
                          }}
                          className="w-12 h-12 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-800 flex-shrink-0 cursor-grab active:cursor-grabbing"
                          title={img.alt ?? img.url}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={img.url} alt={img.alt ?? ''} draggable={false} className="w-full h-full object-contain" loading="lazy" decoding="async" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-600 px-4 py-5 text-center">
                    <ImageIcon className="w-6 h-6 mx-auto mb-1.5 text-slate-300 dark:text-slate-600" />
                    <p className="text-xs text-slate-400">No master images yet — upload from the product Images tab first.</p>
                  </div>
                )}

                {/* Bucket grid */}
                {colorValues.length > 0 || (buckets.get(SHARED) ?? []).length > 0 ? (
                  <ChannelImageGrid
                    rows={gridRows} columns={columns} resolveCell={resolveCell}
                    onCellClick={(rowKey, colKey) => {
                      const bucket = rowKey ?? SHARED
                      const list = buckets.get(bucket) ?? []
                      const idx = Number(colKey) - 1
                      setPickerTarget({ bucket, replaceIndex: idx < list.length ? idx : null })
                    }}
                    onCellRemove={handleCellRemove}
                    onCellMove={move}
                    onCellDrop={(rowKey, colKey, url) => {
                      const bucket = rowKey ?? SHARED
                      const idx = Number(colKey) - 1
                      assign(bucket, idx < (buckets.get(bucket) ?? []).length ? idx : null, url)
                    }}
                    ariaLabel={`eBay photos for ${sku} grouped by ${axis}`}
                    rowHeaderLabel={axis}
                    minDimensionPx={500}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 gap-2">
                    <ImageIcon className="w-9 h-9 text-slate-200 dark:text-slate-700" />
                    <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No curated images yet</p>
                    <p className="text-xs text-slate-400">
                      {serverAxes.length === 0
                        ? 'This product has no variant attributes — only a Default bucket is available.'
                        : 'Drag a master photo onto a cell or click to pick.'}
                    </p>
                  </div>
                )}

                {/* Publish status */}
                {(publishState !== 'idle' || publishResult) && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 text-xs">
                    {(publishState === 'saving' || publishState === 'publishing') && (
                      <div className="flex items-center gap-2 text-slate-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                        <span>{publishState === 'saving' ? 'Saving images…' : 'Sending to eBay…'}</span>
                      </div>
                    )}
                    {publishResult && publishState !== 'saving' && publishState !== 'publishing' && (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          {publishResult.success
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                            : <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                          <span className={publishResult.success ? 'text-green-700 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
                            {publishResult.success
                              ? `${publishResult.pictureCount} image${publishResult.pictureCount !== 1 ? 's' : ''}, ${publishResult.colorSetCount} colour set${publishResult.colorSetCount !== 1 ? 's' : ''} sent`
                              : publishResult.message}
                          </span>
                          {!publishResult.success && (
                            <button
                              type="button"
                              onClick={() => { void publish() }}
                              className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              <RefreshCw className="w-3 h-3" /> Retry
                            </button>
                          )}
                        </div>
                        {publishResult.results && publishResult.results.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {publishResult.results.map((r, i) => (
                              <span
                                key={i} title={`${r.sku}: ${r.message}`}
                                className={[
                                  'rounded-full px-2 py-0.5 text-[10px] font-medium',
                                  r.status === 'SUCCESS' || r.status === 'success'
                                    ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                    : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                                ].join(' ')}
                              >
                                {r.market}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* FFP.7 — every distinct failure, not just the first */}
                        {!publishResult.success && publishResult.results && (
                          <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                            {[...new Set(
                              publishResult.results
                                .filter((r) => r.status !== 'SUCCESS' && r.status !== 'success' && r.status !== 'PUSHED')
                                .map((r) => r.message),
                            )].slice(0, 5).map((m, i) => (
                              <li key={i} className="text-[10px] text-red-600 dark:text-red-400 truncate" title={m}>{m}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* eBay rules reminder */}
                <p className="text-[11px] text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-2">
                  eBay rules: max {EBAY_MAX} images · min 500 px · JPEG/PNG only
                </p>
              </>
            )}
          </div>
        )}

        {/* Image picker — scoped to this family's master gallery */}
        {pickerTarget !== null && (
          <ImagePickerModal
            productId={productId}
            masterImages={masterImages as ProductImage[]}
            onSelect={url => { assign(pickerTarget.bucket, pickerTarget.replaceIndex, url); setPickerTarget(null) }}
            onClose={() => setPickerTarget(null)}
          />
        )}
      </div>
    )
  },
)

// ── EbayFlatFileImageModal ────────────────────────────────────────────────────
// Shell — renders one FamilySection per loaded product family in a scrollable
// stacked layout. The footer adds "Save All" / "Publish All" when multi-family.

export interface EbayFlatFileImageModalProps {
  open: boolean
  onClose: () => void
  /** Active eBay marketplace — image publish targets ONLY this market. */
  marketplace: string
  /** IDs of all product families currently loaded in the flat-file editor. */
  productIds: string[]
  /**
   * Called after a successful save when a family's Default bucket has ≥1 URL.
   * productId identifies which family was saved; urls are the first 6 Default photos.
   */
  onSyncColumns?: (productId: string, urls: string[]) => void
}

export function EbayFlatFileImageModal({ open, onClose, marketplace, productIds, onSyncColumns }: EbayFlatFileImageModalProps) {
  const { toast } = useToast()

  // Stable ref map keyed by productId — persists across renders without extra deps.
  const refsMap = useRef<Map<string, RefObject<FamilySectionHandle>>>(new Map())
  const getRef = useCallback((pid: string): RefObject<FamilySectionHandle> => {
    if (!refsMap.current.has(pid)) refsMap.current.set(pid, createRef<FamilySectionHandle>())
    return refsMap.current.get(pid)!
  }, [])

  const [busyAll, setBusyAll] = useState(false)

  // FFP.7 — explicit publish-market selector (market-specific by design).
  // Defaults to the flat file's active market; the operator can retarget
  // without leaving the modal.
  const [publishMarket, setPublishMarket] = useState(marketplace)
  useEffect(() => { setPublishMarket(marketplace) }, [marketplace, open])

  const saveAll = useCallback(async () => {
    setBusyAll(true)
    let failed = 0
    for (const pid of productIds) {
      const ok = await refsMap.current.get(pid)?.current?.save() ?? true
      if (!ok) failed++
    }
    setBusyAll(false)
    if (failed === 0) toast.success('All images saved')
    else toast.error(`${failed} product${failed !== 1 ? 's' : ''} failed to save`)
  }, [productIds, toast])

  const publishAll = useCallback(async () => {
    setBusyAll(true)
    for (const pid of productIds) {
      await refsMap.current.get(pid)?.current?.publish()
    }
    setBusyAll(false)
  }, [productIds])

  const hasProducts = productIds.length > 0
  const isMulti = productIds.length > 1

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="eBay Images"
      subtitle={hasProducts
        ? `${productIds.length} product famil${productIds.length !== 1 ? 'ies' : 'y'}`
        : undefined}
      size="xl"
      footer={isMulti ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={saveAll} disabled={busyAll}>
            {busyAll
              ? <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Working…</span>
              : 'Save All'}
          </Button>
          <Button size="sm" onClick={publishAll} disabled={busyAll}>
            {busyAll
              ? <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Working…</span>
              : 'Publish All'}
          </Button>
        </div>
      ) : null}
    >
      {!hasProducts ? (
        <Banner variant="warning" title="No product">
          Open this from a product&rsquo;s flat file to manage its eBay images.
        </Banner>
      ) : (
        <div className="flex flex-col gap-4">
          {/* FFP.7 — publish-market strip */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-500 dark:text-slate-400 font-medium mr-1">Publish to</span>
            {(['IT', 'DE', 'FR', 'ES', 'UK'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPublishMarket(m)}
                className={[
                  'rounded px-2 py-0.5 text-[11px] font-medium border transition-colors',
                  publishMarket === m
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
            <span className="ml-1 text-[10.5px] text-slate-400">images publish to this market only</span>
          </div>
          {productIds.map(pid => (
            <FamilySection
              key={pid}
              ref={getRef(pid)}
              productId={pid}
              marketplace={publishMarket}
              collapsible={isMulti}
              open={open}
              onSyncColumns={onSyncColumns ? urls => onSyncColumns(pid, urls) : undefined}
            />
          ))}
        </div>
      )}
    </Modal>
  )
}

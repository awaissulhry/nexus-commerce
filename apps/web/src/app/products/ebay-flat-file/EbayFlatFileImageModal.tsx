'use client'
import { createRef, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Copy, ImageIcon, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { Drawer } from '@/design-system/components/Drawer'
import { Menu } from '@/design-system/components/Menu'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
// [id] is a literal directory name in the filesystem; TypeScript resolves it fine.
import ChannelImageGrid, { type ImageGridColumn, type ImageGridRow } from '@/app/products/[id]/edit/tabs/images/ChannelImageGrid'
import ImagePickerModal from '@/app/products/[id]/edit/tabs/images/ImagePickerModal'
import type { WorkspaceData, ListingImage, VariantSummary, ProductImage } from '@/app/products/[id]/edit/tabs/images/types'
import { Select } from '@/design-system/primitives/Select'
import { axisSynonymKey, describeResolvedAxis, SHARED_GALLERY_AXIS, type ResolvedAxisFeedback } from './variationValueOrder.pure'
import type { ImageFamilySummary } from './imageFamilies.pure'
// EFX P7 — pure assign/copy/cap semantics (reuse allowed, in-bucket dedup,
// 12-cap rejection). See imageBuckets.vitest.test.ts for the invariants.
import { EBAY_BUCKET_CAP, assignImage, copyImageAt, copySetTo, type Buckets } from './imageBuckets.pure'

// ── Constants ──────────────────────────────────────────────────────────────

// EFX P5 — eBay's REAL limit for this modal's publish path. Per eBay's
// Inventory API "Managing images" doc: "For multiple-variation listings, a
// maximum of 12 pictures may be used per variation" (Trading's
// VariationSpecificPictureSet carries the same 12 cap), and our push also
// slices the group-level "cover & common" gallery to 12
// (ebay-variation-push.service.ts). Single-SKU listings allow 24, but this
// modal publishes variation groups only — the previous 24 here overstated
// what actually reached eBay. Canonical value lives in imageBuckets.pure.ts
// so the pure cap semantics and the UI can never drift apart.
const EBAY_MAX = EBAY_BUCKET_CAP
const MIN_COLS = 6
// Default-bucket key AND the '__shared__' wire value for "one shared gallery"
// (activeAxis / imageAxisPreference) — intentionally the same sentinel.
const SHARED = SHARED_GALLERY_AXIS

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
// Mirrors EbayPanel.tsx initBuckets exactly. The Buckets type + edit
// semantics live in imageBuckets.pure.ts (EFX P7).

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
  // EFX P5 — resolved-axis feedback (additive server fields).
  requestedAxis?: string
  pictureAxis?: string | null
  realAxes?: string[]
  sharedGallery?: boolean
  warnings?: string[]
}

// ── FamilySection ─────────────────────────────────────────────────────────────
// One self-contained panel per product family — manages its own workspace data,
// buckets, axis preference, save, and publish independently.
//
// Cross-family drag semantics: within-family drags use onCellMove — move by
// default, COPY with Alt/Option held at drop (EFX P7). Cross-family drags are
// detected by the grid's gridId stamp and re-routed to onCellDrop on the
// target (the source's ChannelImageGrid never saw the drag end) → copy
// semantics, source keeps the photo.

export interface FamilySectionHandle {
  /** Persist dirty buckets. No-op + returns true when already clean. Returns false on error. */
  save: () => Promise<boolean>
  /** EFX P6 — same as save but without the success toast (bulk Publish All pre-saves silently). */
  saveSilent: () => Promise<boolean>
  /** Save if dirty, then push images to all eBay markets. */
  publish: () => Promise<void>
  /**
   * EFX P6 — the axis pick currently on screen + its distinct-value count,
   * consumed by the drawer's bulk Publish All (per-item activeAxis + P5
   * resolved-axis feedback). loaded=false until the workspace fetch lands —
   * bulk publish then omits activeAxis so the server falls back to the
   * stored imageAxisPreference.
   */
  getAxisInfo: () => { axis: string; valueCount?: number; loaded: boolean }
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
    // EFX P5 — distinct value count per axis; annotates single-valued options.
    const axisValueCounts = workspaceData?.axisValueCounts ?? {}

    // Server-recommended axis (respects imageAxisPreference, falls back to colour dim).
    const defaultAxis = useMemo(() => {
      const pref = product?.imageAxisPreference
      // EFX P5 — '__shared__' stored as the preference = one shared gallery.
      if (pref === SHARED) return SHARED
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

    // EFX P5 — picking an axis persists imageAxisPreference immediately
    // (optimistic, non-blocking) so the scheduled + bulk publish paths — which
    // call the publish service WITHOUT activeAxis and fall back to the stored
    // preference — follow the same pick, '__shared__' included.
    const changeAxis = useCallback((next: string) => {
      setAxisOverride(next)
      void beFetch(`/api/products/${productId}/images-workspace/axis`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axis: next }),
      })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
        .catch(() => toast.error('Could not save the axis preference — this pick still applies to publishes from this modal'))
    }, [productId, toast])

    const colorValues = useMemo(() => getAxisValues(variants, axis), [variants, axis])

    // ── Bucket state ─────────────────────────────────────────────────────────

    const baseline = useMemo(
      () => initBuckets(listingImages, axis, colorValues),
      [listingImages, axis, colorValues],
    )
    const [buckets, setBuckets] = useState<Buckets>(() => cloneBuckets(baseline))
    useEffect(() => { setBuckets(cloneBuckets(baseline)) }, [baseline])
    // EFX P7 — the copy-to picker targets THIS axis's values; close it whenever
    // the bucket model resets (axis flip / fresh load) so it never lists stale values.
    useEffect(() => { setCopySource(null) }, [baseline])
    const hasDirty = useMemo(() => bucketsDiff(buckets, baseline) > 0, [buckets, baseline])

    // ── Picker target ────────────────────────────────────────────────────────

    const [pickerTarget, setPickerTarget] = useState<{ bucket: string; replaceIndex: number | null } | null>(null)

    // EFX P7 — 'Copy this set to…' picker state: the source bucket + the
    // currently ticked target values. Client-state only (Save persists).
    const [copySource, setCopySource] = useState<string | null>(null)
    const [copyPicks, setCopyPicks] = useState<Set<string>>(new Set())

    // ── Edit mutations ────────────────────────────────────────────────────────
    // EFX P7 — the same URL may live in MULTIPLE buckets (eBay + bulk-save both
    // tolerate it; the push dedups per set by URL). Semantics live in
    // imageBuckets.pure.ts: in-bucket dedup kept, 12-cap ops rejected whole
    // with a toast (never silently truncated). Cross-family cell drags land
    // here as plain URL drops (the grid's gridId guard) → copy semantics.

    const bucketLabel = useCallback((b: string) => (b === SHARED ? 'Default' : b), [])

    const assign = useCallback((bucket: string, replaceIndex: number | null, url: string) => {
      const { next, blocked } = assignImage(buckets, bucket, replaceIndex, url)
      if (blocked.length > 0) {
        toast.error(`"${bucketLabel(bucket)}" already has ${EBAY_MAX} images (eBay's max per set) — remove one first`)
        return
      }
      setBuckets(next)
    }, [buckets, toast, bucketLabel])

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

    // Bucket-to-bucket drag: MOVE by default (unchanged); Alt/Option at drop =
    // COPY (source keeps the image; cap-checked like every copy).
    const move = useCallback((
      from: { rowKey: string | null; columnKey: string; url: string },
      to: { rowKey: string | null; columnKey: string },
      mode?: 'move' | 'copy',
    ) => {
      const fromB = from.rowKey ?? SHARED, toB = to.rowKey ?? SHARED
      if (mode === 'copy') {
        const { next, blocked } = copyImageAt(buckets, from.url, toB, Number(to.columnKey) - 1)
        if (blocked.length > 0) {
          toast.error(`"${bucketLabel(toB)}" already has ${EBAY_MAX} images (eBay's max per set) — copy blocked`)
          return
        }
        setBuckets(next)
        return
      }
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
    }, [buckets, toast, bucketLabel])

    // ── EFX P7 — explicit copy-set actions ('Copy this set to…' / 'Duplicate
    // to all values'). Client-state only; persistence stays with Save.

    const applyCopySet = useCallback((fromBucket: string, targets: string[]) => {
      const src = buckets.get(fromBucket) ?? []
      const { next, blocked, applied } = copySetTo(buckets, fromBucket, targets)
      setBuckets(next)
      if (blocked.length > 0) {
        toast.error(
          `Not copied to ${blocked.map(bucketLabel).map(v => `"${v}"`).join(', ')} — ` +
          `would exceed ${EBAY_MAX} images (eBay's max per set); those sets are unchanged`,
        )
      }
      if (applied.length > 0) {
        toast.success(
          `Copied the "${bucketLabel(fromBucket)}" set (${src.length} image${src.length !== 1 ? 's' : ''}) ` +
          `to ${applied.map(bucketLabel).map(v => `"${v}"`).join(', ')}`,
        )
      } else if (blocked.length === 0) {
        toast.info(`Nothing to copy — the selected value${targets.length !== 1 ? 's already have' : ' already has'} every image in this set`)
      }
    }, [buckets, toast, bucketLabel])

    // Per-bucket menu rendered inside the grid's row header. Values only exist
    // off shared-gallery mode; a bucket needs ≥1 other value to copy to.
    const bucketRowActions = useCallback((rowKey: string | null) => {
      if (colorValues.length === 0) return null
      const bucket = rowKey ?? SHARED
      const targets = colorValues.filter(v => v !== bucket)
      if (targets.length === 0) return null
      const count = (buckets.get(bucket) ?? []).length
      const isLastRow = colorValues.length > 0 && bucket === colorValues[colorValues.length - 1]
      return (
        <Menu
          className={`efx-bucket-menu${isLastRow ? ' efx-menu-up' : ''}`}
          label={<span className="inline-flex items-center gap-1"><Copy className="w-3 h-3" />Copy</span>}
          items={[
            {
              id: 'copy-to',
              label: 'Copy this set to…',
              disabled: count === 0,
              onSelect: () => { setCopyPicks(new Set()); setCopySource(bucket) },
            },
            {
              id: 'duplicate-all',
              label: 'Duplicate to all values',
              disabled: count === 0,
              onSelect: () => applyCopySet(bucket, targets),
            },
          ]}
          triggerProps={{ 'aria-label': `Copy the ${bucketLabel(bucket)} image set to other values` }}
        />
      )
    }, [colorValues, buckets, applyCopySet, bucketLabel])

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

    // EFX P5 — per-bucket "n/12" so the operator sees the real eBay ceiling
    // (anything past 12 is clamped at push, with a warning).
    const gridRows: ImageGridRow[] = useMemo(() => {
      const sharedN = (buckets.get(SHARED) ?? []).length
      return [
        { key: null, label: 'Default', sublabel: `cover + common · ${sharedN}/${EBAY_MAX} photos` },
        ...colorValues.map(cv => {
          const n = (buckets.get(cv) ?? []).length
          return { key: cv, label: cv, sublabel: `${n}/${EBAY_MAX} photos` }
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
    // EFX P5 — resolved-axis feedback, snapshotted against the axis that was
    // ACTUALLY sent (the operator may flip the picker after publishing).
    const [axisFeedback, setAxisFeedback] = useState<ResolvedAxisFeedback | null>(null)
    const publishing = publishState === 'saving' || publishState === 'publishing'

    const publish = useCallback(async () => {
      if (!productId) return
      setPublishResult(null)
      setAxisFeedback(null)
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
        // EFX P5 — axis may be '__shared__' (explicit one-shared-gallery mode).
        const res = await beFetch(`/api/products/${productId}/ebay-images/publish?marketplace=${encodeURIComponent(marketplace)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeAxis: axis }),
        })
        const body: PublishResult = await res.json()
        setPublishResult(body)
        setPublishState(body.success ? 'done' : 'failed')
        // EFX P5 — honest feedback: show what eBay actually got ("vary by X" /
        // shared gallery) and WARN visibly when it differs from the pick.
        const fb = describeResolvedAxis(body.requestedAxis ?? axis, axisValueCounts[axis], body)
        setAxisFeedback(fb)
        if (body.success) {
          if (fb?.mismatch && fb.warning) toast.warning(fb.warning)
          else toast.success(`Published ${body.pictureCount} image${body.pictureCount !== 1 ? 's' : ''} to eBay`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setPublishResult({ success: false, message: msg, pictureCount: 0, colorSetCount: 0 })
        setPublishState('failed')
      }
    }, [productId, marketplace, axis, axisValueCounts, hasDirty, flush, toast])

    // ── Imperative handle ─────────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      save: () => flush(false),
      saveSilent: () => flush(true),
      publish,
      getAxisInfo: () => ({ axis, valueCount: axisValueCounts[axis], loaded: workspaceData != null }),
    }), [flush, publish, axis, axisValueCounts, workspaceData])

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
          {/* EFX P5 — the picker shows whenever the family has ANY axis (the
              old >1 gate hid it exactly when operators needed to see/override
              the grouping) and always offers the explicit shared-gallery mode.
              Single-valued axes stay selectable, annotated with their outcome. */}
          {!loading && serverAxes.length > 0 && (
            <>
              <Select
                value={axis}
                onChange={e => changeAxis(e.target.value)}
                className="text-xs ml-1 flex-shrink-0"
                aria-label="Axis eBay images vary by"
              >
                {serverAxes.map(a => (
                  <option key={a} value={a}>
                    {a}{(axisValueCounts[a] ?? 2) <= 1 ? ' (1 value — publishes as shared gallery)' : ''}
                  </option>
                ))}
                <option value={SHARED}>One shared gallery (no per-variant images)</option>
              </Select>
              <span
                className="text-[10px] text-slate-400 flex-shrink-0"
                title="eBay allows a listing's images to vary by exactly ONE aspect (any aspect — not just colour). Pick which one, or publish one shared gallery for the whole listing."
              >
                eBay allows product images to vary by ONE aspect only.
              </span>
            </>
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
                      {' · '}Drag onto a cell or click any cell to pick — the same photo may live in several sets.
                      Dragging between sets moves the photo; hold <kbd className="px-1 rounded border border-slate-300 dark:border-slate-600 text-[10px] font-mono">Alt/⌥</kbd> to copy.
                      Dragging to another product always copies (source keeps it).
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

                {/* Bucket grid — always rendered in shared-gallery mode so the
                    empty Default row stays droppable (EFX P5). */}
                {axis === SHARED || colorValues.length > 0 || (buckets.get(SHARED) ?? []).length > 0 ? (
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
                    ariaLabel={`eBay photos for ${sku} ${axis === SHARED ? 'as one shared gallery' : `grouped by ${axis}`}`}
                    rowHeaderLabel={axis === SHARED ? 'Shared gallery' : axis}
                    minDimensionPx={500}
                    allowCopyDrag
                    rowActions={bucketRowActions}
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
                        {/* EFX P5 — resolved-axis feedback: what eBay actually
                            got, plus a VISIBLE warning when it differs from the
                            operator's pick (never silent). */}
                        {publishResult.success && axisFeedback && (
                          <p className="text-[11px] text-slate-600 dark:text-slate-300">
                            {axisFeedback.label}
                          </p>
                        )}
                        {axisFeedback?.mismatch && axisFeedback.warning && (
                          <Banner variant="warning" title="Published with a different image grouping">
                            {axisFeedback.warning}
                          </Banner>
                        )}
                        {/* EFX P5 — push warnings (e.g. curated set clamped to 12) */}
                        {publishResult.warnings && publishResult.warnings.length > 0 && (
                          <ul className="space-y-0.5">
                            {publishResult.warnings.map((w, i) => (
                              <li key={i} className="text-[10px] text-amber-700 dark:text-amber-400" title={w}>{w}</li>
                            ))}
                          </ul>
                        )}
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

                {/* eBay rules reminder — 12 is eBay's per-variation cap on
                    multi-variation listings (see EBAY_MAX comment). */}
                <p className="text-[11px] text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-2">
                  eBay rules: max {EBAY_MAX} images per set · min 500 px · JPEG/PNG only · images vary by ONE aspect
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

        {/* EFX P7 — 'Copy this set to…' target picker. Rendered inside the
            drawer's stacking context (same fixed-overlay pattern as
            ImagePickerModal) so it always sits above the drawer. */}
        {copySource !== null && (() => {
          const copyTargets = colorValues.filter(v => v !== copySource)
          const srcCount = (buckets.get(copySource) ?? []).length
          const allPicked = copyTargets.length > 0 && copyTargets.every(v => copyPicks.has(v))
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
              role="dialog" aria-modal="true"
              aria-label={`Copy the ${bucketLabel(copySource)} image set to other values`}
              onClick={() => setCopySource(null)}
            >
              <div
                className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl max-w-sm w-full p-5"
                onClick={e => e.stopPropagation()}
              >
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Copy the &ldquo;{bucketLabel(copySource)}&rdquo; set to…
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Adds its {srcCount} image{srcCount !== 1 ? 's' : ''} to each selected value. Existing images are
                  kept; a value that would exceed {EBAY_MAX} images is blocked whole, never trimmed.
                </p>
                <div className="mt-3 max-h-56 overflow-y-auto flex flex-col gap-1.5">
                  <Checkbox
                    label={<span className="font-medium">All values ({copyTargets.length})</span>}
                    checked={allPicked}
                    onChange={() => setCopyPicks(allPicked ? new Set() : new Set(copyTargets))}
                  />
                  <div className="border-t border-slate-100 dark:border-slate-800 my-0.5" />
                  {copyTargets.map(v => {
                    const n = (buckets.get(v) ?? []).length
                    return (
                      <Checkbox
                        key={v}
                        label={<span>{v} <span className="text-slate-400">· {n}/{EBAY_MAX}</span></span>}
                        checked={copyPicks.has(v)}
                        onChange={() => setCopyPicks(prev => {
                          const next = new Set(prev)
                          if (next.has(v)) next.delete(v); else next.add(v)
                          return next
                        })}
                      />
                    )
                  })}
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <Button size="sm" variant="ghost" onClick={() => setCopySource(null)}>Cancel</Button>
                  <Button
                    size="sm"
                    disabled={copyPicks.size === 0 || srcCount === 0}
                    onClick={() => {
                      applyCopySet(copySource, colorValues.filter(v => copyPicks.has(v)))
                      setCopySource(null)
                    }}
                  >
                    Copy to {copyPicks.size} value{copyPicks.size !== 1 ? 's' : ''}
                  </Button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* EFX P7 — compact trigger + open-upward variant for the per-bucket
            copy menu (the grid's last row would otherwise clip the dropdown
            against the scroll container's bottom edge). */}
        <style>{`
          .efx-bucket-menu .h10-ds-btn { font-size: 11px; padding: 2px 8px; gap: 4px; }
          .efx-menu-up .h10-ds-menu { top: auto; bottom: calc(100% + 5px); }
        `}</style>
      </div>
    )
  },
)

// ── EbayFlatFileImageDrawer ───────────────────────────────────────────────────
// EFX P6 — right-side drawer covering EVERY listing family in the sheet.
// Families render as collapsed summary rows (parent SKU + title + variant
// count + bulk-publish chip); expanding one mounts its FamilySection — which
// fetches its workspace — on FIRST expand only, and it stays mounted after
// (collapse/re-expand via the section's own chevron keeps state, no refetch).
// Publish All is ONE bulk request (POST /products/bulk-image-publish items
// shape) carrying each family's chosen axis + the drawer's publish market.

export interface EbayFlatFileImageDrawerProps {
  open: boolean
  onClose: () => void
  /** Active eBay marketplace — image publish targets ONLY this market. */
  marketplace: string
  /**
   * Family list derived from the grid's CURRENT rows at open time
   * (deriveImageFamilies) — not the SSR snapshot.
   */
  families: ImageFamilySummary[]
  /**
   * Called after a successful save when a family's Default bucket has ≥1 URL.
   * productId identifies which family was saved; urls are the first 6 Default photos.
   */
  onSyncColumns?: (productId: string, urls: string[]) => void
}

/** Mirrors the API's MAX_PER_CALL in bulk-image-publish.routes.ts. */
const BULK_MAX = 50

/** One per-family outcome from the bulk publish, plus client-side P5 feedback. */
interface BulkFamilyOutcome {
  productId: string
  ok: boolean
  message?: string
  pictureCount?: number
  colorSetCount?: number
  requestedAxis?: string
  pictureAxis?: string | null
  sharedGallery?: boolean
  warnings?: string[]
  feedback: ResolvedAxisFeedback | null
}

export function EbayFlatFileImageDrawer({ open, onClose, marketplace, families, onSyncColumns }: EbayFlatFileImageDrawerProps) {
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
  // without leaving the drawer.
  const [publishMarket, setPublishMarket] = useState(marketplace)
  useEffect(() => { setPublishMarket(marketplace) }, [marketplace, open])

  // ── Lazy family mounting ──────────────────────────────────────────────────
  // A family's FamilySection (and its N-fetch workspace load) mounts on first
  // expand ONLY and stays mounted. Single-family sheets auto-expand so the
  // old one-family UX is unchanged.
  const [mountedIds, setMountedIds] = useState<Set<string>>(new Set())
  const [bulkResults, setBulkResults] = useState<Map<string, BulkFamilyOutcome> | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    // `families` is snapshotted by the client at open time — initialize on
    // the closed→open transition only (same rationale as shouldInitModal).
    setMountedIds(families.length === 1 ? new Set([families[0].productId]) : new Set())
    setBulkResults(null)
    setBulkError(null)
    refsMap.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const expandFamily = useCallback((pid: string) => {
    setMountedIds(prev => prev.has(pid) ? prev : new Set(prev).add(pid))
  }, [])

  // ── Save All (expanded families only — unexpanded ones can't be dirty) ────

  const saveAll = useCallback(async () => {
    setBusyAll(true)
    let failed = 0
    for (const f of families) {
      const ok = await refsMap.current.get(f.productId)?.current?.save() ?? true
      if (!ok) failed++
    }
    setBusyAll(false)
    if (failed === 0) toast.success('All images saved')
    else toast.error(`${failed} product${failed !== 1 ? 's' : ''} failed to save`)
  }, [families, toast])

  // ── Publish All — ONE bulk request instead of N sequential publishes ──────

  const publishAll = useCallback(async () => {
    if (families.length > BULK_MAX) {
      setBulkError(`Publish All sends at most ${BULK_MAX} families per run — this sheet has ${families.length}. Narrow the sheet's scope (or publish families individually) and retry.`)
      return
    }
    setBusyAll(true)
    setBulkResults(null)
    setBulkError(null)
    try {
      // 1 — silently save every dirty expanded family so the bulk publish
      // pushes the curation the operator is looking at, never stale buckets.
      const saveFailed: string[] = []
      for (const f of families) {
        const ok = await refsMap.current.get(f.productId)?.current?.saveSilent() ?? true
        if (!ok) saveFailed.push(f.parentSku || f.productId)
      }
      if (saveFailed.length > 0) {
        setBulkError(`Save failed for ${saveFailed.join(', ')} — nothing was published.`)
        return
      }
      // 2 — one request. Expanded families send the axis on screen
      // ('__shared__' included); never-expanded ones omit activeAxis so the
      // server falls back to the stored imageAxisPreference (P5 persists
      // every picker change, so the fallback tracks the last pick).
      const items = families.map(f => {
        const info = refsMap.current.get(f.productId)?.current?.getAxisInfo()
        return {
          productId: f.productId,
          ...(info?.loaded ? { activeAxis: info.axis } : {}),
          marketplace: publishMarket,
        }
      })
      const res = await beFetch('/api/products/bulk-image-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'EBAY', marketplace: publishMarket, items }),
      })
      const body = await res.json().catch(() => ({})) as { results?: Array<Omit<BulkFamilyOutcome, 'feedback'>>; message?: string; error?: string }
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`)
      const map = new Map<string, BulkFamilyOutcome>()
      for (const r of body.results ?? []) {
        // P5 resolved-axis feedback per family. For never-expanded families
        // the requested axis's value count is unknown client-side (undefined
        // → treated as multi-valued), so a single-valued pick that resolves
        // to a shared gallery shows an over-cautious warning there — never a
        // silent divergence.
        const sent = items.find(i => i.productId === r.productId)
        const info = refsMap.current.get(r.productId)?.current?.getAxisInfo()
        const requested = r.requestedAxis ?? sent?.activeAxis ?? ''
        const feedback = requested
          ? describeResolvedAxis(requested, info?.loaded ? info.valueCount : undefined, r)
          : null
        map.set(r.productId, { ...r, feedback })
      }
      setBulkResults(map)
      const okN = [...map.values()].filter(r => r.ok).length
      if (okN === families.length) {
        toast.success(`Published images for ${okN === 1 ? 'the family' : `all ${okN} families`} to ${publishMarket}`)
      } else {
        toast.error(`Published ${okN}/${families.length} families to ${publishMarket} — see per-family results`)
      }
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAll(false)
    }
  }, [families, publishMarket, toast])

  const hasProducts = families.length > 0
  const isMulti = families.length > 1

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="eBay Images"
      subtitle={hasProducts
        ? `${families.length} product famil${families.length !== 1 ? 'ies' : 'y'} in this sheet`
        : undefined}
      width={840}
      footer={isMulti ? (
        <div className="flex justify-end gap-2 w-full">
          <Button size="sm" variant="secondary" onClick={saveAll} disabled={busyAll}>
            {busyAll
              ? <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Working…</span>
              : 'Save All'}
          </Button>
          <Button size="sm" onClick={() => { void publishAll() }} disabled={busyAll}>
            {busyAll
              ? <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Working…</span>
              : `Publish All → ${publishMarket}`}
          </Button>
        </div>
      ) : undefined}
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

          {/* EFX P6 — Publish All per-family results */}
          {(bulkError || bulkResults) && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 flex flex-col gap-2">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Publish All — results</p>
              {bulkError && (
                <Banner variant="danger" title="Publish All failed">{bulkError}</Banner>
              )}
              {bulkResults && families.map(f => {
                const r = bulkResults.get(f.productId)
                if (!r) return null
                return (
                  <div key={f.productId} className="flex flex-col gap-1 border-b border-slate-100 dark:border-slate-800 last:border-0 pb-2 last:pb-0">
                    <div className="flex items-center gap-2 text-xs">
                      {r.ok
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                        : <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                      <span className="font-medium text-slate-900 dark:text-slate-100 flex-shrink-0">{f.parentSku || f.productId}</span>
                      <span className={r.ok ? 'text-slate-500 dark:text-slate-400 truncate' : 'text-red-600 dark:text-red-400 truncate'} title={r.message}>
                        {r.ok
                          ? `${r.pictureCount ?? 0} image${(r.pictureCount ?? 0) !== 1 ? 's' : ''}, ${r.colorSetCount ?? 0} set${(r.colorSetCount ?? 0) !== 1 ? 's' : ''} → ${publishMarket}`
                          : (r.message ?? 'Failed')}
                      </span>
                    </div>
                    {r.ok && r.feedback && (
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 pl-5">{r.feedback.label}</p>
                    )}
                    {r.feedback?.mismatch && r.feedback.warning && (
                      <Banner variant="warning" title="Published with a different image grouping">
                        {r.feedback.warning}
                      </Banner>
                    )}
                    {r.warnings && r.warnings.length > 0 && (
                      <ul className="space-y-0.5 pl-5">
                        {r.warnings.map((w, i) => (
                          <li key={i} className="text-[10px] text-amber-700 dark:text-amber-400" title={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Family list — collapsed summary rows; FamilySection mounts on first expand */}
          {families.map(f => {
            const mounted = mountedIds.has(f.productId)
            if (mounted) {
              return (
                <FamilySection
                  key={f.productId}
                  ref={getRef(f.productId)}
                  productId={f.productId}
                  marketplace={publishMarket}
                  collapsible={isMulti}
                  open={open}
                  onSyncColumns={onSyncColumns ? urls => onSyncColumns(f.productId, urls) : undefined}
                />
              )
            }
            const r = bulkResults?.get(f.productId)
            return (
              <button
                key={f.productId}
                type="button"
                onClick={() => expandFamily(f.productId)}
                aria-label={`Expand ${f.parentSku || f.productId} images`}
                className="w-full flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex-shrink-0">{f.parentSku || f.productId}</span>
                {f.title && (
                  <span className="text-xs text-slate-500 dark:text-slate-400 truncate min-w-0">{f.title}</span>
                )}
                <span className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                  {r && (
                    <span className={[
                      'text-[10px] rounded-full px-1.5 py-0.5 font-medium',
                      r.ok
                        ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                    ].join(' ')}>
                      {r.ok ? `published → ${publishMarket}` : 'publish failed'}
                    </span>
                  )}
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-slate-200/70 text-slate-600 dark:bg-slate-700 dark:text-slate-300 font-medium">
                    {f.variantCount} variant{f.variantCount !== 1 ? 's' : ''}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </Drawer>
  )
}

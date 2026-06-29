'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ImageIcon, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
// Reuse the shared images-tab grid and type definitions directly.
// [id] is a literal directory name in the filesystem; TypeScript resolves it fine.
import ChannelImageGrid, { type ImageGridColumn, type ImageGridRow } from '@/app/products/[id]/edit/tabs/images/ChannelImageGrid'
import ImagePickerModal from '@/app/products/[id]/edit/tabs/images/ImagePickerModal'
import type { WorkspaceData, ListingImage, VariantSummary, ProductImage } from '@/app/products/[id]/edit/tabs/images/types'

// ── Constants ─────────────────────────────────────────────────────────────

const EBAY_MAX = 24
const MIN_COLS = 6
const SHARED = '__shared__'

// Axis synonym groups — keep in sync with EbayPanel.tsx + VariationValueOrderModal.
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

// Collect unique values for the selected axis across all variants.
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

// ── Bucket model ──────────────────────────────────────────────────────────
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
    map.set(bucket, pairs.map((p) => p.url))
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

// ── Backend fetch helper ───────────────────────────────────────────────────

function beFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getBackendUrl()}${path}`, init)
}

// ── ListingImageUpsert (mirrors EbayPanel.tsx) ────────────────────────────

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

// ── Props ─────────────────────────────────────────────────────────────────

export interface EbayFlatFileImageModalProps {
  open: boolean
  onClose: () => void
  /** productId (familyId) for the product family being edited */
  productId: string
  /**
   * Called after a successful save when the Default bucket has ≥1 URL.
   * Receives the first 6 URLs from the Default bucket; the caller should
   * write them into image_1..6 on every flat-file row.
   */
  onSyncColumns?: (urls: string[]) => void
}

// ── Component ─────────────────────────────────────────────────────────────

export function EbayFlatFileImageModal({ open, onClose, productId, onSyncColumns }: EbayFlatFileImageModalProps) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData | null>(null)

  const load = useCallback(() => {
    if (!productId) return
    setLoading(true)
    setError(null)
    beFetch(`/api/products/${productId}/images-workspace`)
      .then((r) => {
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

  // ── Derive display state ───────────────────────────────────────────────

  const product = workspaceData?.product
  const masterImages = workspaceData?.master ?? []
  const listingImages = workspaceData?.listing ?? []
  const variants = workspaceData?.variants ?? []
  const serverAxes = workspaceData?.availableAxes ?? []

  // Pick the active axis: respect imageAxisPreference, fall back to colour dim, then first axis.
  const axis = useMemo(() => {
    const pref = product?.imageAxisPreference
    if (pref) {
      const match = serverAxes.find((a) => axisSynonymKey(a) === axisSynonymKey(pref))
      if (match) return match
    }
    return serverAxes.find((a) => axisSynonymKey(a) === '__dim0__') ?? serverAxes[0] ?? 'Colore'
  }, [product?.imageAxisPreference, serverAxes])

  const colorValues = useMemo(() => getAxisValues(variants, axis), [variants, axis])

  // Saved server truth. Recomputed when listing images, axis or colorValues change.
  const baseline = useMemo(
    () => initBuckets(listingImages, axis, colorValues),
    [listingImages, axis, colorValues],
  )

  // Working bucket state — diverges from baseline as the operator edits.
  const [buckets, setBuckets] = useState<Buckets>(() => cloneBuckets(baseline))

  // Which cell was clicked — drives the ImagePickerModal.
  // replaceIndex: null = append, number = replace existing url at that position.
  const [pickerTarget, setPickerTarget] = useState<{ bucket: string; replaceIndex: number | null } | null>(null)

  // Snap to the new baseline whenever it changes (after load / reload).
  useEffect(() => { setBuckets(cloneBuckets(baseline)) }, [baseline])

  const hasDirty = useMemo(() => bucketsDiff(buckets, baseline) > 0, [buckets, baseline])

  // ── Edit mutations ────────────────────────────────────────────────────

  // Assign a URL to a bucket cell. No cross-bucket overlap: remove the photo
  // from every other bucket first so it never appears in two rows at once.
  const assign = useCallback((bucket: string, replaceIndex: number | null, url: string) => {
    setBuckets((prev) => {
      const next = new Map(prev)
      for (const [k, list] of next) {
        if (k !== bucket && list.includes(url)) next.set(k, list.filter((u) => u !== url))
      }
      let list = [...(next.get(bucket) ?? [])]
      if (replaceIndex != null && replaceIndex < list.length) list[replaceIndex] = url
      else list.push(url)
      // In-bucket de-dupe: first occurrence wins.
      const seen = new Set<string>()
      list = list.filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
      next.set(bucket, list)
      return next
    })
  }, [])

  const removeAt = useCallback((bucket: string, positionOneBased: number) => {
    setBuckets((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(bucket) ?? [])]
      list.splice(positionOneBased - 1, 1)
      next.set(bucket, list)
      return next
    })
  }, [])

  const handleCellRemove = useCallback((rowKey: string | null, colKey: string) => {
    removeAt(rowKey ?? SHARED, Number(colKey))
  }, [removeAt])

  // Move a photo between cells (drag-reorder, incl. cross-bucket).
  const move = useCallback((
    from: { rowKey: string | null; columnKey: string; url: string },
    to: { rowKey: string | null; columnKey: string },
  ) => {
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

  // ── Grid model ────────────────────────────────────────────────────────

  const colCount = useMemo(() => {
    let longest = 0
    for (const list of buckets.values()) longest = Math.max(longest, list.length)
    return Math.min(EBAY_MAX, Math.max(MIN_COLS, longest + 1))
  }, [buckets])

  const columns: ImageGridColumn[] = useMemo(
    () => Array.from({ length: colCount }, (_, i) => ({
      key: String(i + 1),
      label: String(i + 1),
      sublabel: i === 0 ? 'Main' : undefined,
      isPrimary: i === 0,
    })),
    [colCount],
  )

  const gridRows: ImageGridRow[] = useMemo(() => {
    const sharedN = (buckets.get(SHARED) ?? []).length
    return [
      {
        key: null,
        label: 'Default',
        sublabel: `cover + common · ${sharedN} photo${sharedN === 1 ? '' : 's'}`,
      },
      ...colorValues.map((cv) => {
        const n = (buckets.get(cv) ?? []).length
        return { key: cv, label: cv, sublabel: `${n} photo${n === 1 ? '' : 's'}` }
      }),
    ]
  }, [colorValues, buckets])

  const resolveCell = useCallback((rowKey: string | null, colKey: string) => {
    const url = (buckets.get(rowKey ?? SHARED) ?? [])[Number(colKey) - 1]
    return url ? { url, origin: 'own' as const } : null
  }, [buckets])

  // ── Save ─────────────────────────────────────────────────────────────

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // URLs to offer for flat-file column sync after a successful save.
  const [syncUrls, setSyncUrls] = useState<string[] | null>(null)

  const flush = useCallback(async () => {
    if (!productId) return
    setSaving(true)
    setSaveError(null)
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
        .filter((i) => i.platform === 'EBAY' && !i.variationId && (i.variantGroupKey == null || i.variantGroupKey === axis))
        .map((i) => i.id)
      const res = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upserts, deletes }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Save failed (${res.status}): ${body}`)
      }
      toast.success('Images saved')
      // Offer to sync image_1..6 columns if the Default bucket has images.
      const shared = buckets.get(SHARED) ?? []
      if (onSyncColumns && shared.length > 0) setSyncUrls(shared.slice(0, 6))
      load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg)
    } finally {
      setSaving(false)
    }
  }, [productId, buckets, axis, listingImages, onSyncColumns, load, toast])

  // ── Publish ───────────────────────────────────────────────────────────

  interface PublishResult {
    success: boolean
    message: string
    pictureCount: number
    colorSetCount: number
    markets?: string[]
    results?: Array<{ sku: string; market: string; status: string; message: string }>
  }

  const [publishState, setPublishState] = useState<'idle' | 'saving' | 'publishing' | 'done' | 'failed'>('idle')
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null)
  const publishing = publishState === 'saving' || publishState === 'publishing'

  const publish = useCallback(async () => {
    if (!productId) return
    setPublishResult(null)
    // 1. Save if dirty
    if (hasDirty) {
      setPublishState('saving')
      setSaving(true)
      setSaveError(null)
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
          .filter((i) => i.platform === 'EBAY' && !i.variationId && (i.variantGroupKey == null || i.variantGroupKey === axis))
          .map((i) => i.id)
        const saveRes = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts, deletes }),
        })
        if (!saveRes.ok) {
          const body = await saveRes.text()
          throw new Error(`Save failed (${saveRes.status}): ${body}`)
        }
        load()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setSaveError(msg)
        setSaving(false)
        setPublishState('idle')
        return
      }
      setSaving(false)
    }
    // 2. Publish
    setPublishState('publishing')
    try {
      const res = await beFetch(`/api/products/${productId}/ebay-images/publish`, { method: 'POST' })
      const body: PublishResult = await res.json()
      setPublishResult(body)
      setPublishState(body.success ? 'done' : 'failed')
      if (body.success) toast.success(`Published ${body.pictureCount} image${body.pictureCount !== 1 ? 's' : ''} to eBay`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setPublishResult({ success: false, message: msg, pictureCount: 0, colorSetCount: 0 })
      setPublishState('failed')
    }
  }, [productId, hasDirty, buckets, axis, listingImages, load, toast])

  // ── Subtitle ──────────────────────────────────────────────────────────

  const sku = product?.sku ?? productId
  const totalImages = useMemo(
    () => [...buckets.values()].reduce((sum, arr) => sum + arr.length, 0),
    [buckets],
  )
  const nonEmptyBuckets = useMemo(
    () => [...buckets.values()].filter((arr) => arr.length > 0).length,
    [buckets],
  )

  const subtitle = !loading && workspaceData
    ? [
        `${nonEmptyBuckets} bucket${nonEmptyBuckets !== 1 ? 's' : ''}`,
        `${totalImages} image${totalImages !== 1 ? 's' : ''}`,
        axis ? `Axis: ${axis}` : null,
      ].filter(Boolean).join(' · ')
    : undefined

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`eBay Images · ${sku}`}
      subtitle={subtitle}
      size="xl"
      footer={hasDirty || saveError || publishResult ? (
        <div className="flex w-full flex-col gap-2">
          {saveError && (
            <Banner variant="danger" title="Save failed" className="w-full">
              {saveError}
            </Banner>
          )}
          {syncUrls && onSyncColumns && (
            <Banner variant="info" title="Sync flat-file columns?" className="w-full">
              <span>Copy the {syncUrls.length} Default image{syncUrls.length !== 1 ? 's' : ''} into image_1–{syncUrls.length} on every flat-file row?</span>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => { onSyncColumns(syncUrls); setSyncUrls(null); toast.success(`Synced ${syncUrls.length} image column${syncUrls.length !== 1 ? 's' : ''}`) }}>
                  Yes, sync
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSyncUrls(null)}>Skip</Button>
              </div>
            </Banner>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setBuckets(cloneBuckets(baseline)); setSaveError(null) }}
              disabled={saving || publishing}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={flush}
              disabled={saving || publishing || !hasDirty}
            >
              {saving ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Saving…
                </span>
              ) : 'Save'}
            </Button>
            <Button
              size="sm"
              onClick={publish}
              disabled={publishing}
            >
              {publishState === 'saving' ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Saving…
                </span>
              ) : publishState === 'publishing' ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Publishing…
                </span>
              ) : hasDirty ? 'Save & Publish' : 'Publish'}
            </Button>
          </div>
        </div>
      ) : workspaceData ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={publish} disabled={publishing}>
            Publish
          </Button>
        </div>
      ) : null}
    >
      {loading && (
        <div className="space-y-3 py-2">
          <Skeleton height={80} radius={8} />
          <Skeleton height={200} radius={8} />
          <Skeleton height={140} radius={8} />
        </div>
      )}

      {!loading && error && (
        <Banner variant="danger" title="Failed to load images">
          {error}
        </Banner>
      )}

      {!loading && !error && !productId && (
        <Banner variant="warning" title="No product">
          Open this from a product&rsquo;s flat file to manage its eBay images.
        </Banner>
      )}

      {!loading && !error && workspaceData && (
        <div className="flex flex-col gap-4">

          {/* Master gallery strip — Phase 4 will make these draggable */}
          {masterImages.length > 0 ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3">
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  Master gallery
                </span>
                {' · '}Drag a photo onto a cell below to assign it, or click any cell to pick.
              </p>
              <p className="text-[11px] text-slate-400 mb-2">
                <strong>Default</strong> = cover + colour-neutral photos (size charts, features) shown
                before a colour is picked. Each colour row = that colour&rsquo;s photos only.
                A photo lives in one row only.
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
                    className="w-12 h-12 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-800 flex-shrink-0 cursor-grab active:cursor-grabbing"
                    title={img.alt ?? img.url}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.alt ?? ''}
                      draggable={false}
                      className="w-full h-full object-contain"
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-600 px-4 py-5 text-center">
              <ImageIcon className="w-6 h-6 mx-auto mb-1.5 text-slate-300 dark:text-slate-600" />
              <p className="text-xs text-slate-400">
                No master images yet — upload some from the product Images tab first.
              </p>
            </div>
          )}

          {/* Color bucket grid */}
          {colorValues.length > 0 || (buckets.get(SHARED) ?? []).length > 0 ? (
            <ChannelImageGrid
              rows={gridRows}
              columns={columns}
              resolveCell={resolveCell}
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
              ariaLabel={`eBay photos grouped by ${axis}`}
              rowHeaderLabel={axis}
              minDimensionPx={500}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <ImageIcon className="w-9 h-9 text-slate-200 dark:text-slate-700" />
              <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                No curated images yet
              </p>
              <p className="text-xs text-slate-400">
                {serverAxes.length === 0
                  ? 'This product has no variant attributes — only a Default bucket is available.'
                  : `Drag a master photo onto a cell to assign it (or click a cell).`}
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
                        onClick={publish}
                        className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Retry
                      </button>
                    )}
                  </div>
                  {publishResult.results && publishResult.results.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {publishResult.results.map((r, i) => (
                        <span
                          key={i}
                          className={[
                            'rounded-full px-2 py-0.5 text-[10px] font-medium',
                            r.status === 'SUCCESS' || r.status === 'success'
                              ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                          ].join(' ')}
                          title={r.message}
                        >
                          {r.market}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* eBay rules reminder */}
          <p className="text-[11px] text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-2">
            eBay rules: max {EBAY_MAX} images · min 500 px · JPEG/PNG only
          </p>
        </div>
      )}
      {/* Image picker — opened when an empty (or occupied) cell is clicked */}
      {pickerTarget !== null && (
        <ImagePickerModal
          productId={productId}
          masterImages={masterImages as ProductImage[]}
          onSelect={(url) => {
            assign(pickerTarget.bucket, pickerTarget.replaceIndex, url)
            setPickerTarget(null)
          }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </Modal>
  )
}

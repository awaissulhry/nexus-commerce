'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
// Reuse the shared images-tab grid and type definitions directly.
// [id] is a literal directory name in the filesystem; TypeScript resolves it fine.
import ChannelImageGrid, { type ImageGridColumn, type ImageGridRow } from '@/app/products/[id]/edit/tabs/images/ChannelImageGrid'
import type { WorkspaceData, ListingImage, VariantSummary } from '@/app/products/[id]/edit/tabs/images/types'

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

// ── Props ─────────────────────────────────────────────────────────────────

export interface EbayFlatFileImageModalProps {
  open: boolean
  onClose: () => void
  /** productId (familyId) for the product family being edited */
  productId: string
}

// ── Component ─────────────────────────────────────────────────────────────

export function EbayFlatFileImageModal({ open, onClose, productId }: EbayFlatFileImageModalProps) {
  const BACKEND = getBackendUrl()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData | null>(null)

  const load = useCallback(() => {
    if (!productId) return
    setLoading(true)
    setError(null)
    fetch(`${BACKEND}/api/products/${productId}/images-workspace`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<WorkspaceData>
      })
      .then(setWorkspaceData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [productId, BACKEND])

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
      footer={hasDirty ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setBuckets(cloneBuckets(baseline))}
          >
            Discard
          </Button>
          <Button size="sm" disabled title="Save coming in next phase">
            Save
          </Button>
        </>
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
              onCellClick={() => { /* Phase 4: open image picker */ }}
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

          {/* eBay rules reminder */}
          <p className="text-[11px] text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-2">
            eBay rules: max {EBAY_MAX} images · min 500 px · JPEG/PNG only
          </p>
        </div>
      )}
    </Modal>
  )
}

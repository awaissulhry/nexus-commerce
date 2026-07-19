/**
 * EB-IMG Phase 2 — "Copy images from another listing" mapping.
 *
 * The multi-listing sheets carry near-identical products (the same family
 * split across several live listings), so a freshly-adopted listing usually
 * wants ANOTHER listing's curated buckets verbatim, with one or two swaps.
 * This maps a SOURCE family's saved eBay ListingImage rows onto a TARGET
 * family's bucket model (Default/shared + per-axis-value), matching the axis
 * via axisSynonymKey ('Color' ↔ 'Colore') and values case-insensitively.
 *
 * Pure — the drawer applies the result as ordinary dirty buckets, so the
 * operator reviews the copy visually and persists it with the normal Save.
 * Nothing is dropped silently: source values with no target bucket and
 * target values the source doesn't cover are both reported.
 */
import { axisSynonymKey, SHARED_GALLERY_AXIS } from './variationValueOrder.pure'
import { EBAY_BUCKET_CAP, type Buckets } from './imageBuckets.pure'

export interface CopySourceListingImage {
  platform: string | null
  variationId?: string | null
  variantGroupKey: string | null
  variantGroupValue: string | null
  url: string
  position: number
}

export interface CopyFromListingResult {
  buckets: Buckets
  copiedImages: number
  copiedSets: number
  /** Source per-value sets that have no matching bucket on the target. */
  unmatchedSourceValues: string[]
  /** Target bucket values the source had no set for (left empty). */
  emptyTargetValues: string[]
}

export function mapSourceToBuckets(opts: {
  sourceListing: CopySourceListingImage[]
  /** The target family's active axis (SHARED_GALLERY_AXIS = one gallery). */
  targetAxis: string
  /** The target family's bucket values for that axis. */
  targetValues: string[]
  cap?: number
}): CopyFromListingResult {
  const cap = opts.cap ?? EBAY_BUCKET_CAP
  const rows = opts.sourceListing
    .filter((r) => r.platform === 'EBAY' && !r.variationId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  const buckets: Buckets = new Map()
  buckets.set(SHARED_GALLERY_AXIS, [])
  for (const v of opts.targetValues) buckets.set(v, [])

  const push = (bucket: string, url: string): void => {
    const list = buckets.get(bucket)
    if (!list || list.includes(url) || list.length >= cap) return
    list.push(url)
  }

  const sharedMode = opts.targetAxis === SHARED_GALLERY_AXIS
  const targetByKey = new Map(opts.targetValues.map((v) => [v.trim().toLowerCase(), v]))
  const targetAxisKey = sharedMode ? null : axisSynonymKey(opts.targetAxis)
  const unmatched = new Set<string>()

  for (const r of rows) {
    if (r.variantGroupKey == null) {
      push(SHARED_GALLERY_AXIS, r.url)
      continue
    }
    if (sharedMode) {
      // Target publishes one gallery — fold every source set into it.
      push(SHARED_GALLERY_AXIS, r.url)
      continue
    }
    if (axisSynonymKey(r.variantGroupKey) !== targetAxisKey) {
      unmatched.add(`${r.variantGroupKey}: ${r.variantGroupValue ?? '—'}`)
      continue
    }
    const target = targetByKey.get(String(r.variantGroupValue ?? '').trim().toLowerCase())
    if (!target) {
      unmatched.add(String(r.variantGroupValue ?? '—'))
      continue
    }
    push(target, r.url)
  }

  let copiedImages = 0
  let copiedSets = 0
  const emptyTargetValues: string[] = []
  for (const [bucket, urls] of buckets) {
    copiedImages += urls.length
    if (urls.length > 0 && bucket !== SHARED_GALLERY_AXIS) copiedSets++
    if (urls.length === 0 && bucket !== SHARED_GALLERY_AXIS) emptyTargetValues.push(bucket)
  }

  return {
    buckets,
    copiedImages,
    copiedSets,
    unmatchedSourceValues: [...unmatched],
    emptyTargetValues,
  }
}

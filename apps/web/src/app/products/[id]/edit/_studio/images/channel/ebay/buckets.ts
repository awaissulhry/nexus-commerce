/**
 * PES.7 — eBay's image buckets. Pure, tested.
 *
 * eBay is not Amazon and the difference is not cosmetic:
 *
 *   • Columns are POSITIONS (1, 2, 3…), not named slots. Position 1 is the cover — the picture a
 *     buyer sees in search results — so the ordering IS the meaning.
 *   • Rows are a "Default (cover & common)" bucket plus one per colour. eBay shows the Default
 *     photos before a buyer picks a variation, then the chosen colour's.
 *   • 🔴 **Every photo lives in EXACTLY ONE bucket.** eBay does not reliably de-duplicate, so the
 *     same picture appearing in Default and in a colour can surface twice in one gallery. Placing a
 *     photo into a bucket therefore REMOVES it from wherever else it was — a move, never a copy.
 *     This is the invariant the whole file exists to keep.
 *   • Twelve per variation is eBay's real cap for this path ("For multiple-variation listings, a
 *     maximum of 12 pictures may be used per variation"), and the group gallery is sliced to 12 too.
 *
 * Buckets are matched on the stored `variantGroupValue`, never on an axis display name — same join
 * rule as the Amazon matrix, and for the same reason (the axis is "Colore", the rows say "Color").
 */

/** The shared bucket has a null value; it is a real bucket, not the absence of one. */
import type { ListingAsset } from '../../types'

export const DEFAULT_BUCKET_ID = '__default__'

/** eBay's per-variation ceiling on this publish path. */
export const EBAY_MAX_PER_BUCKET = 12

/**
 * The subset of a listing row the bucket model reads — DERIVED from `ListingAsset`, not restated.
 * See the note on `CascadeRow`: the hand-written twin was entered through `as unknown as`, so a
 * renamed wire field would have compiled and read `undefined`.
 */
export type EbayRow =
  Pick<
    ListingAsset,
    'id' | 'productId' | 'scope' | 'platform' | 'variantGroupKey' | 'variantGroupValue'
    | 'position' | 'role' | 'url'
  >
  & Partial<Pick<ListingAsset, 'locked' | 'publishStatus'>>

export interface EbayBucket {
  id: string
  label: string
  /** null on the Default bucket. */
  groupValue: string | null
  /** Photos in position order. */
  photos: EbayRow[]
  /** True once the bucket is at eBay's ceiling. */
  full: boolean
}

export function ebayRows(listing: readonly EbayRow[]): EbayRow[] {
  return listing.filter((l) => l.platform === 'EBAY')
}

/** Default first — it is what a buyer sees before choosing — then the axis's declared order. */
export function buildBuckets(args: {
  rows: readonly EbayRow[]
  axisValues: readonly string[]
}): EbayBucket[] {
  const { rows, axisValues } = args
  const inBucket = (v: string | null) =>
    rows
      .filter((r) => (r.variantGroupValue ?? null) === v)
      .sort((a, b) => a.position - b.position)

  const stored = new Set(
    rows.map((r) => r.variantGroupValue).filter((v): v is string => v != null && v !== ''),
  )
  // A bucket that exists in storage but not in the axis is still shown — a photo that is live on
  // eBay must appear somewhere, even when the axis has moved on.
  const orphans = [...stored].filter((v) => !axisValues.includes(v)).sort()

  const make = (id: string, label: string, groupValue: string | null): EbayBucket => {
    const photos = inBucket(groupValue)
    return { id, label, groupValue, photos, full: photos.length >= EBAY_MAX_PER_BUCKET }
  }

  return [
    make(DEFAULT_BUCKET_ID, 'Default (cover & common)', null),
    ...axisValues.map((v) => make(v, v, v)),
    ...orphans.map((v) => make(v, `${v} (not in the current axis)`, v)),
  ]
}

export type PlacementOutcome =
  | { kind: 'move'; upsert: EbayPlacement; removeRowId: string }
  | { kind: 'add'; upsert: EbayPlacement }
  | { kind: 'refused'; reason: string }

export interface EbayPlacement {
  id?: string
  scope: 'PLATFORM'
  platform: 'EBAY'
  marketplace: null
  variantGroupKey: string | null
  variantGroupValue: string | null
  url: string
  position: number
  role: string
}

/**
 * Place a photo into a bucket at a position.
 *
 * If the photo already lives in ANOTHER bucket, this is a MOVE: the row there is removed. Copying
 * it would put the same picture in two buckets, which is the duplicate eBay will not collapse.
 */
export function placeInBucket(args: {
  url: string
  target: EbayBucket
  groupKey: string | null
  /** Every eBay row on the product, so an existing home can be found. */
  allRows: readonly EbayRow[]
  /** Where in the bucket; defaults to the end. */
  position?: number
}): PlacementOutcome {
  const { url, target, groupKey, allRows, position } = args

  const alreadyHere = target.photos.find((p) => p.url === url)
  if (alreadyHere) {
    return { kind: 'refused', reason: 'That photo is already in this bucket.' }
  }
  if (target.full) {
    return {
      kind: 'refused',
      reason: `eBay allows ${EBAY_MAX_PER_BUCKET} pictures per variation and this bucket is full. Remove one first.`,
    }
  }

  const upsert: EbayPlacement = {
    scope: 'PLATFORM',
    platform: 'EBAY',
    marketplace: null,
    variantGroupKey: target.groupValue == null ? null : groupKey,
    variantGroupValue: target.groupValue,
    url,
    position: position ?? target.photos.length,
    role: target.photos.length === 0 && target.groupValue == null ? 'MAIN' : 'GALLERY',
  }

  // The one-bucket invariant: if it lives somewhere else, that row goes.
  const elsewhere = allRows.find(
    (r) => r.url === url && (r.variantGroupValue ?? null) !== target.groupValue,
  )
  if (elsewhere) return { kind: 'move', upsert, removeRowId: elsewhere.id }
  return { kind: 'add', upsert }
}

/**
 * Renumber a bucket after a reorder or a removal.
 *
 * Positions must stay dense and zero-based: eBay reads them as an order, and a gap makes the cover
 * ambiguous. Returns only the rows whose position actually changed, so a reorder does not rewrite
 * every row in the bucket.
 */
export function renumber(photos: readonly EbayRow[]): Array<{ id: string; position: number }> {
  return photos
    .map((p, i) => ({ id: p.id, position: i }))
    .filter((next, i) => photos[i].position !== next.position)
}

/** What a bucket would publish, and what eBay will refuse. Warn, never block. */
export function bucketWarnings(bucket: EbayBucket): string[] {
  const out: string[] = []
  if (bucket.groupValue == null && bucket.photos.length === 0) {
    out.push('No default photos — a buyer sees nothing before choosing a variation, and position 1 is the search thumbnail.')
  }
  if (bucket.photos.length > EBAY_MAX_PER_BUCKET) {
    out.push(`${bucket.photos.length} photos — eBay publishes only the first ${EBAY_MAX_PER_BUCKET}.`)
  }
  return out
}

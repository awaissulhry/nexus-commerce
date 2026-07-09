/**
 * EFX P7 — pure bucket-edit semantics for the eBay images drawer
 * (EbayFlatFileImageModal.tsx).
 *
 * Invariants (P7 changes the first one):
 *   - REUSE ALLOWED: the same URL may live in any number of axis-value
 *     buckets at once. eBay tolerates it (the push dedups per picture set by
 *     URL) and the bulk-save tolerates it — the old client-side
 *     one-bucket-per-URL rule was the only thing blocking reuse.
 *   - IN-bucket dedup: a URL never appears twice in the SAME bucket
 *     (first occurrence wins, matching the pre-P7 assign()).
 *   - CAP: no operation may grow a bucket past `cap` (eBay's 12 images per
 *     variation picture set). Overflow REJECTS the whole per-bucket op and
 *     reports it in `blocked` — the caller toasts; nothing is silently
 *     truncated.
 *
 * Kept in a separate module so vitest can import it without loading the full
 * React client and its JSX / path-alias deps.
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/imageBuckets.vitest.test.ts
 */

/** eBay's per-variation picture-set cap (see EBAY_MAX in the drawer). */
export const EBAY_BUCKET_CAP = 12

/** bucket key (SHARED sentinel or an axis value) → ordered list of URLs */
export type Buckets = Map<string, string[]>

export interface BucketOpResult {
  /** The resulting buckets. `=== input` when nothing changed. */
  next: Buckets
  /** Bucket keys left UNCHANGED because the op would push them past the cap. */
  blocked: string[]
  /** Bucket keys that actually changed. */
  applied: string[]
}

/** In-bucket dedup — first occurrence wins (pre-P7 assign behavior). */
function dedupeFirstWins(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
}

function listsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((u, i) => u === b[i])
}

/**
 * Assign a URL into a bucket (drop from the master gallery / picker pick).
 * `replaceIndex` targets an existing cell; null appends. Other buckets are
 * NOT touched — the same URL may now live in several buckets (P7).
 */
export function assignImage(
  buckets: Buckets,
  bucket: string,
  replaceIndex: number | null,
  url: string,
  cap: number = EBAY_BUCKET_CAP,
): BucketOpResult {
  const cur = buckets.get(bucket) ?? []
  let list = [...cur]
  if (replaceIndex != null && replaceIndex < list.length) list[replaceIndex] = url
  else list.push(url)
  list = dedupeFirstWins(list)
  if (list.length > cap) return { next: buckets, blocked: [bucket], applied: [] }
  if (listsEqual(list, cur)) return { next: buckets, blocked: [], applied: [] }
  const next = new Map(buckets)
  next.set(bucket, list)
  return { next, blocked: [], applied: [bucket] }
}

/**
 * COPY one image into a bucket at an index (Alt/Option-drag between cells).
 * The source bucket is untouched. If the target already contains the URL it
 * is repositioned (in-bucket dedup), which can never overflow the cap.
 */
export function copyImageAt(
  buckets: Buckets,
  url: string,
  toBucket: string,
  toIndex: number,
  cap: number = EBAY_BUCKET_CAP,
): BucketOpResult {
  const cur = buckets.get(toBucket) ?? []
  const without = cur.filter((u) => u !== url)
  const idx = Math.min(Math.max(toIndex, 0), without.length)
  const list = [...without]
  list.splice(idx, 0, url)
  if (list.length > cap) return { next: buckets, blocked: [toBucket], applied: [] }
  if (listsEqual(list, cur)) return { next: buckets, blocked: [], applied: [] }
  const next = new Map(buckets)
  next.set(toBucket, list)
  return { next, blocked: [], applied: [toBucket] }
}

/**
 * Copy a whole set into other buckets ('Copy this set to…' / 'Duplicate to
 * all values'). Non-destructive merge: each target keeps its own images and
 * gains the source's missing ones, appended in source order. A target that
 * would exceed the cap is REJECTED whole (listed in `blocked`, left
 * unchanged) while the other targets still apply — the caller must surface
 * `blocked` to the operator.
 */
export function copySetTo(
  buckets: Buckets,
  fromBucket: string,
  toBuckets: string[],
  cap: number = EBAY_BUCKET_CAP,
): BucketOpResult {
  const src = buckets.get(fromBucket) ?? []
  const blocked: string[] = []
  const applied: string[] = []
  let next: Buckets = buckets
  for (const target of toBuckets) {
    if (target === fromBucket) continue
    const cur = next.get(target) ?? []
    const merged = [...cur]
    for (const u of src) if (!merged.includes(u)) merged.push(u)
    if (merged.length > cap) { blocked.push(target); continue }
    if (merged.length === cur.length) continue // nothing new — unchanged
    if (next === buckets) next = new Map(buckets)
    next.set(target, merged)
    applied.push(target)
  }
  return { next, blocked, applied }
}

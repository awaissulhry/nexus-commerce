/**
 * PES.7 — what Amazon is actually serving, against what Nexus would send. Pure, tested.
 *
 * Two independent questions, deliberately not merged:
 *
 *   STALE  — a row Nexus published, whose master picture has changed since. Nexus is serving new
 *            bytes; Amazon still has the old ones. Answered by the server.
 *   DRIFT  — what Amazon's API says is live at a (sku, slot), against what this matrix resolves.
 *            Answered by comparing the cached read-back with the cascade.
 *
 * A row can be stale without drifting (nobody has looked at Amazon lately) and can drift without
 * being stale (someone edited the listing in Seller Central). Collapsing them into one "out of
 * sync" number would lose which of those it is, and they have different remedies.
 */

/** A row read back from the channel — what Amazon says it is serving. */
export interface LiveImage {
  marketplace: string | null
  externalSku: string | null
  asin: string | null
  slot: string | null
  url: string
  fetchedAt: string
}

export type DriftKind =
  /** Amazon has a picture at this slot; Nexus resolves a DIFFERENT one. */
  | 'different'
  /** Amazon has a picture at this slot; Nexus resolves nothing. */
  | 'onlyOnChannel'
  /** Nexus resolves a picture; Amazon has nothing at that slot. */
  | 'onlyInNexus'

export interface DriftEntry {
  slot: string
  sku: string | null
  kind: DriftKind
  liveUrl: string | null
  nexusUrl: string | null
}

/**
 * Compare a Cloudinary/Amazon URL pair for MEANING rather than for bytes.
 *
 * A URL that differs only by a CDN transform is the SAME picture — `cdnFit` rewrites every URL the
 * matrix renders, so a naive string compare would report drift on every single cell. The comparison
 * is on the stable identity: for Cloudinary the path after the transform segment, for Amazon the
 * asset id with its `._SL123_` size modifier stripped.
 */
export function sameImage(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b
  return imageIdentity(a) === imageIdentity(b)
}

/**
 * The stable identity of a picture, independent of how it is being served.
 *
 * Done by walking SEGMENTS rather than with one clever regex. The first attempt used lazy
 * quantifiers and silently captured the transform block into the identity, which made a sized
 * rendition look like a different picture — and since every cell in the matrix renders through
 * `cdnFit`, that would have reported drift on EVERY cell against a perfectly in-sync channel. The
 * tests caught it; the regex would not have announced itself.
 */
export function imageIdentity(url: string): string {
  const clean = url.split('?')[0]

  if (clean.includes('res.cloudinary.com')) {
    const afterUpload = clean.split('/image/upload/')[1]
    if (afterUpload) {
      const segments = afterUpload.split('/')
      // Drop the leading transform segments (`w_360,c_fit,...`) and the version (`v1780`). Both
      // describe DELIVERY; neither is part of which picture this is.
      let i = 0
      while (i < segments.length && (isTransformSegment(segments[i]) || /^v\d+$/.test(segments[i]))) i++
      return stripExtension(segments.slice(i).join('/'))
    }
  }

  // Amazon puts the size in the filename: `<id>._SL500_.jpg`. The id is the identity.
  const amazon = clean.match(/\/([A-Za-z0-9%+-]+?)(\._[A-Za-z0-9,]+_)?\.(?:jpg|jpeg|png|gif|webp)$/i)
  if (amazon) return amazon[1]

  return clean
}

/** A Cloudinary transform segment: comma-separated `key_value` pairs. */
function isTransformSegment(segment: string): boolean {
  if (!segment) return false
  return segment.split(',').every((part) => /^[a-z]+_[^/]+$/i.test(part))
}

function stripExtension(path: string): string {
  return path.replace(/\.[a-z0-9]+$/i, '')
}

/**
 * Drift for one market.
 *
 * `resolvedBySlot` is what the matrix would publish, keyed by slot. Only slots present in EITHER
 * side are reported — a slot neither has is not drift, it is an empty slot.
 */
export function findDrift(args: {
  live: readonly LiveImage[]
  resolvedBySlot: Readonly<Record<string, string | null>>
  market: string
}): DriftEntry[] {
  const { live, resolvedBySlot, market } = args
  const liveHere = live.filter((l) => (l.marketplace ?? '').toUpperCase() === market.toUpperCase())
  const liveBySlot = new Map<string, LiveImage>()
  for (const l of liveHere) if (l.slot) liveBySlot.set(l.slot, l)

  const slots = new Set<string>([...liveBySlot.keys(), ...Object.keys(resolvedBySlot)])
  const out: DriftEntry[] = []

  for (const slot of slots) {
    const l = liveBySlot.get(slot) ?? null
    const nexusUrl = resolvedBySlot[slot] ?? null
    if (!l && !nexusUrl) continue
    if (l && !nexusUrl) {
      out.push({ slot, sku: l.externalSku, kind: 'onlyOnChannel', liveUrl: l.url, nexusUrl: null })
    } else if (!l && nexusUrl) {
      out.push({ slot, sku: null, kind: 'onlyInNexus', liveUrl: null, nexusUrl })
    } else if (l && nexusUrl && !sameImage(l.url, nexusUrl)) {
      out.push({ slot, sku: l.externalSku, kind: 'different', liveUrl: l.url, nexusUrl })
    }
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot))
}

/**
 * What the stale answer can actually support.
 *
 * 🔴 Measured on GALE-JACKET: the endpoint returns `totalStaleRows: 23` with `staleAsins: []` and
 * `staleVariantIds: []`. A re-publish-stale action needs variant ids to scope the feed, so with an
 * empty list there is nothing to target — offering the action anyway would be a button that cannot
 * do what it says. The count is still worth showing; the ACTION is not offered without targets.
 */
export function staleActionability(stale: {
  totalStaleRows: number
  staleAsins: string[]
  staleVariantIds: string[]
} | null): { count: number; canRepublish: boolean; note: string | null } {
  if (!stale || stale.totalStaleRows === 0) return { count: 0, canRepublish: false, note: null }
  const targets = stale.staleVariantIds.length
  if (targets > 0) return { count: stale.totalStaleRows, canRepublish: true, note: null }
  return {
    count: stale.totalStaleRows,
    canRepublish: false,
    note: 'These rows are family-level, so there are no per-variant targets to re-publish. A full channel publish is the way to refresh them.',
  }
}

/**
 * PES.7 — what an Amazon matrix cell actually resolves to. Pure, tested, no React.
 *
 * A cell is (bucket × slot) at a given market, and the picture it shows can come from four places.
 * The ORDER is the whole contract, and it is the same order the publisher uses — a matrix that
 * resolved differently from the publisher would be a picture of a listing nobody is going to get:
 *
 *   1. this market's own row          scope MARKETPLACE, marketplace = the current market
 *   2. the all-markets row            scope PLATFORM, marketplace null
 *   3. the shared bucket at 1 then 2  a colour with no picture inherits the "all colours" row
 *   4. the master gallery             nothing on the channel at all; publish would send master's
 *
 * ⚠ **Buckets are keyed by the STORED `variantGroupKey`, not by the resolved axis name.** Measured
 * on GALE-JACKET: `resolvedAxes` calls the axis **"Colore"** while every stored row buckets under
 * **`variantGroupKey: 'Color'`** — which is exactly what the server's own axis warning says
 * ("Colore is live on eBay as Color"). Matching rows by the display name finds nothing and paints
 * an empty matrix over 50 real rows. So the axis supplies the VALUES to show and the rows supply
 * their own key; the two are joined on the value, never on the name.
 */

import type { ListingAsset } from '../../types'

export type CascadeOrigin =
  /**
   * A row exists at this coordinate and holds NO picture.
   *
   * Measured on GALE-JACKET: 16 of 65 Amazon rows have an empty `url` and no
   * `sourceProductImageId` — and one of them, the shared MAIN row, says `publishStatus:
   * PUBLISHED`. A row like that publishes nothing, so the cascade must STOP here rather than fall
   * through: showing the inherited picture would paint something that will not be sent, and hide
   * the fact that a slot the channel believes is filled is empty.
   */
  | 'pictureless'
  /** a row of this market's own */
  | 'market'
  /** the all-markets (PLATFORM) row */
  | 'platform'
  /** inherited from the shared bucket — the picture belongs to "all colours" */
  | 'shared'
  /** no channel row at all; the master gallery is what would publish */
  | 'master'
  /** nothing anywhere */
  | 'empty'

/** The subset of a listing row this resolution needs. */
/**
 * The subset of a listing row the cascade reads — DERIVED from `ListingAsset`, never restated.
 *
 * 🔴 It used to be a hand-written interface reached through `as unknown as`, which is two mistakes
 * compounding: the cast disabled the check, and the copy was free to drift from the wire type it
 * claimed to be a view of. Renaming a field on `ListingAsset` would have left this compiling and
 * reading `undefined` at runtime. As a `Pick`, a rename fails on the key literal, and the cast is
 * gone because `ListingAsset` is now assignable to this directly.
 *
 * The four optional members are optional here and required on the wire: fixtures construct rows
 * without them, and widening a REQUIRED field to optional is safe in this direction — every real
 * payload still satisfies it.
 */
export type CascadeRow =
  Pick<
    ListingAsset,
    'id' | 'scope' | 'platform' | 'marketplace' | 'amazonSlot' | 'variantGroupKey'
    | 'variantGroupValue' | 'url'
  >
  & Partial<Pick<ListingAsset, 'locked' | 'publishStatus' | 'publishError' | 'sourceProductImageId'>>

export interface ResolvedCell {
  origin: CascadeOrigin
  url: string | null
  /** The row that won, when a channel row did. */
  row: CascadeRow | null
  /** Names the layer the picture came from, for the tooltip. */
  inheritedFrom: string | null
}

const EMPTY: ResolvedCell = { origin: 'empty', url: null, row: null, inheritedFrom: null }

/** Rows for one bucket at one slot, most specific market first. */
function pick(
  rows: readonly CascadeRow[],
  slot: string,
  market: string | null,
  groupValue: string | null,
): { row: CascadeRow; origin: 'market' | 'platform' } | null {
  const inBucket = rows.filter(
    (r) => r.amazonSlot === slot && (r.variantGroupValue ?? null) === groupValue,
  )
  if (market) {
    const own = inBucket.find((r) => r.scope === 'MARKETPLACE' && r.marketplace === market)
    if (own) return { row: own, origin: 'market' }
  }
  const all = inBucket.find((r) => r.scope === 'PLATFORM' && r.marketplace == null)
  if (all) return { row: all, origin: 'platform' }
  return null
}

/**
 * Resolve one cell.
 *
 * `groupValue` null IS the shared bucket, so resolving it never falls through to itself — the
 * shared row's own miss goes straight to master.
 */
export function resolveCell(args: {
  rows: readonly CascadeRow[]
  slot: string
  market: string | null
  /** The bucket's value (e.g. 'Giallo'), or null for the shared "all colours" row. */
  groupValue: string | null
  /** What the master gallery would publish into this slot, when it has something. */
  masterFallbackUrl?: string | null
}): ResolvedCell {
  const { rows, slot, market, groupValue, masterFallbackUrl = null } = args

  const own = pick(rows, slot, market, groupValue)
  if (own) {
    if (!own.row.url) {
      return { origin: 'pictureless', url: null, row: own.row, inheritedFrom: null }
    }
    return {
      origin: own.origin,
      url: own.row.url,
      row: own.row,
      inheritedFrom: own.origin === 'market' ? `Amazon · ${market}` : 'Amazon · all markets',
    }
  }

  // A colour with nothing of its own shows what "all colours" holds — but the shared row itself
  // has no shared row to inherit from.
  if (groupValue !== null) {
    const shared = pick(rows, slot, market, null)
    if (shared) {
      if (!shared.row.url) {
        return { origin: 'pictureless', url: null, row: shared.row, inheritedFrom: null }
      }
      return {
        origin: 'shared',
        url: shared.row.url,
        row: shared.row,
        inheritedFrom: 'all colours',
      }
    }
  }

  if (masterFallbackUrl) {
    return { origin: 'master', url: masterFallbackUrl, row: null, inheritedFrom: 'master gallery' }
  }
  return EMPTY
}

/**
 * The bucket values to render as rows, in the axis's declared order.
 *
 * Takes the values from the RESOLVED axis (authoritative, deduped, ghost-free) and the rows from
 * storage, then reports any stored bucket the axis does not know about instead of dropping it —
 * a picture that exists on the channel must appear somewhere, even when the axis has moved on.
 */
export function bucketValues(
  axisValues: readonly string[],
  rows: readonly CascadeRow[],
): { values: string[]; orphaned: string[] } {
  const stored = new Set(
    rows.map((r) => r.variantGroupValue).filter((v): v is string => v != null && v !== ''),
  )
  const known = new Set(axisValues)
  const orphaned = [...stored].filter((v) => !known.has(v)).sort()
  return { values: [...axisValues], orphaned }
}

/**
 * The stored bucket key, taken from a row that already uses it — **never** the axis's display name.
 *
 * The axis is called `Colore` on screen and may be stored as `Color`; writing the display name into
 * `variantGroupKey` creates a bucket the cascade cannot match, so the picture lands in a row nothing
 * ever reads. Exported so the matrix and the restore path derive it identically — two copies of this
 * rule would drift, and the drift would be silent.
 */
export function bucketGroupKey(
  rows: readonly { variantGroupKey: string | null }[],
  axisName: string | null,
): string | null {
  return rows.find((r) => r.variantGroupKey)?.variantGroupKey ?? axisName
}

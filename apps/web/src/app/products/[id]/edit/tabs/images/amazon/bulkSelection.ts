// BE — bulk selection classification (pure). Given the resolved cells in the
// current selection, work out which bulk actions apply and the counts shown in
// the action bar. Keeps the matrix UI dumb and the rules unit-testable.
//
// Many cells can resolve to the SAME backing ListingImage (e.g. colour rows
// inherit the shared/All-Colors image), so actions de-duplicate by
// listingImageId — the counts and the work are per unique image, not per cell.

export interface ResolvedSelCell {
  group: string | null
  slot: string
  url?: string
  listingImageId?: string
  locked?: boolean
  origin?: 'own' | 'inherited'
}

export interface BulkBreakdown {
  total: number
  filled: ResolvedSelCell[]
  empty: ResolvedSelCell[]
  /** Unique images selected (deduped by backing row, or group:slot for fallbacks). */
  imageCount: number
  /** Unique unlocked backing rows → can be deleted / locked. */
  deletableIds: string[]
  lockableIds: string[]
  /** Unique locked backing rows → can be unlocked. */
  lockedIds: string[]
  /** Unique own MARKETPLACE rows (specific market only) → reset to shared. */
  overrideIds: string[]
  /** Filled cells skipped by delete/lock: locked, or no backing row (master fallback). */
  skippedCount: number
}

const uniq = (a: Array<string | undefined>): string[] => [...new Set(a.filter((x): x is string => !!x))]

export function classifyBulk(resolved: ResolvedSelCell[], isAllMarkets: boolean): BulkBreakdown {
  const filled = resolved.filter((r) => !!r.url)
  const empty = resolved.filter((r) => !r.url)

  // Any backing row the operator owns or inherits can be acted on; deleting an
  // inherited (shared) row removes it everywhere — the UI confirm spells that out.
  const deletableIds = uniq(filled.filter((r) => !r.locked && r.listingImageId).map((r) => r.listingImageId))
  const lockableIds = deletableIds // same set: unlocked rows can be locked
  const lockedIds = uniq(filled.filter((r) => r.locked && r.listingImageId).map((r) => r.listingImageId))
  const overrideIds = isAllMarkets
    ? []
    : uniq(filled.filter((r) => r.origin === 'own' && r.listingImageId).map((r) => r.listingImageId))
  const imageCount = new Set(filled.map((r) => r.listingImageId ?? `${r.group}::${r.slot}`)).size
  const skippedCount = filled.filter((r) => r.locked || !r.listingImageId).length

  return {
    total: resolved.length,
    filled,
    empty,
    imageCount,
    deletableIds,
    lockableIds,
    lockedIds,
    overrideIds,
    skippedCount,
  }
}

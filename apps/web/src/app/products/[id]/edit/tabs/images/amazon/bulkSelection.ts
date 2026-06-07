// BE — bulk selection classification (pure). Given the resolved cells in the
// current selection, work out which bulk actions apply and the counts shown in
// the action bar. Keeps the matrix UI dumb and the rules unit-testable.

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
  locked: ResolvedSelCell[]
  /** Filled, unlocked, backed by a row the current scope OWNS → safe to delete. */
  deletable: ResolvedSelCell[]
  /** Filled but skipped by delete: locked, no row, or inherited/shared on a market. */
  deleteSkipped: ResolvedSelCell[]
  /** Filled + backed by a row → can be locked / unlocked. */
  lockable: ResolvedSelCell[]
  /** Own MARKETPLACE overrides (specific market only) → can clear back to shared. */
  overrides: ResolvedSelCell[]
}

export function classifyBulk(resolved: ResolvedSelCell[], isAllMarkets: boolean): BulkBreakdown {
  const filled = resolved.filter((r) => !!r.url)
  const empty = resolved.filter((r) => !r.url)
  const locked = filled.filter((r) => !!r.locked)
  // Delete only removes images the current scope OWNS: on a single market that
  // means an own MARKETPLACE row (origin 'own'); on All Markets every row is
  // the shared PLATFORM row. Inherited/master cells and locked cells are skipped.
  const deletable = filled.filter(
    (r) => !r.locked && !!r.listingImageId && (isAllMarkets || r.origin === 'own'),
  )
  const deleteSkipped = filled.filter(
    (r) => r.locked || !r.listingImageId || (!isAllMarkets && r.origin !== 'own'),
  )
  const lockable = filled.filter((r) => !!r.listingImageId)
  const overrides = isAllMarkets
    ? []
    : filled.filter((r) => r.origin === 'own' && !!r.listingImageId)
  return { total: resolved.length, filled, empty, locked, deletable, deleteSkipped, lockable, overrides }
}

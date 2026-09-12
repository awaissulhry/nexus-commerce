import type { PreferencesValue } from '@/design-system/patterns/PreferencesModal'

/**
 * The page's STRUCTURAL columns, in grid order: the identity/tree column and the row actions.
 *
 * They are what the lock contract (2026-09-05) calls the grid's own lead and trail — `product` is
 * frozen at the left of the scrolling band, `actions` at the right — and the operator's own locks
 * form a contiguous frozen block BETWEEN them. The Owner still holds the key to both: unlock either
 * in Customise and it becomes an ordinary column, which is why "structural" is a function of the
 * current lock set rather than a fixed property of the column.
 *
 * ONE list. `DEFAULT_LOCKED_COLUMNS`, the `PrefsBridgeOptions.locked` flags and the pins below all
 * read it, because a second copy of a set like this goes stale in hours.
 */
export const STRUCTURAL_COLUMNS: readonly string[] = ['product', 'actions']
export const [LEAD_COLUMN, TRAIL_COLUMN] = STRUCTURAL_COLUMNS
export const isStructuralColumn = (key: string): boolean => STRUCTURAL_COLUMNS.includes(key)

/**
 * The page's lock set in FROZEN ORDER: the identity column, then the operator's block, then actions.
 *
 * `PreferencesValue.lockedColumns` is one list holding two things on this page — the two structural
 * padlocks and the operator's frozen block — so the order it is written in is the order the dialog
 * draws the block and the order the engine pins it. Keeping the identity column first and actions
 * last means the list reads the way the grid looks, whichever way a lock arrived (the dialog's
 * padlock, a header-menu "Pin left", a drag into the pinned area, a saved view).
 *
 * Duplicates are dropped, and a structural key found in the middle is moved to its end rather than
 * discarded: a hand-pinned identity column IS a lock, and a lock on a structural column is
 * structural again.
 */
export function composeLocks(keys: Iterable<string>): string[] {
  const set = [...new Set(keys)]
  return [
    ...(set.includes(LEAD_COLUMN) ? [LEAD_COLUMN] : []),
    ...set.filter((k) => !isStructuralColumn(k)),
    ...(set.includes(TRAIL_COLUMN) ? [TRAIL_COLUMN] : []),
  ]
}

/**
 * The pins the two STRUCTURAL padlocks imply, as AG column state.
 *
 * The operator's own locks are the ENGINE's to pin (`prefsToColumnState` states `pinned` for every
 * togglable column). These two are the page's, and they need stating separately for one measured
 * reason: AG's state API applies `pinned: null` as its DEFAULT to every column its `columnPinning`
 * slice does not name, so a last-used blob or a saved view written before this contract — every one
 * of them, since nothing left-pinned the identity column until today — silently RELEASES the
 * structural lead the moment it is restored. The page re-asserts them after a restore instead of
 * hoping the blob agrees.
 *
 * `autoColId` is AG's own id for the tree column (`AG_AUTO_COL`); `product` is what the page and
 * the dialog call it.
 */
export function structuralPinState(locks: readonly string[], autoColId: string): Array<{ colId: string; pinned: 'left' | 'right' | null }> {
  return [
    { colId: autoColId, pinned: locks.includes(LEAD_COLUMN) ? 'left' : null },
    { colId: TRAIL_COLUMN, pinned: locks.includes(TRAIL_COLUMN) ? 'right' : null },
  ]
}

/**
 * What the grid just said, in the DIALOG's shape: the lock set, and a row for each structural
 * padlock.
 *
 * `columnStateToPrefs` leaves the structural pair out of `visibleColumns` — to the engine they are
 * its own lead and trail, not entries in the operator's list. The dialog draws "In view" from
 * `visibleColumns` plus the columns its specs mark immutable, and this page's bookends are neither:
 * they are padlocks the Owner can open. Read back unaltered, Product and Actions would simply
 * VANISH from that list the moment the draft was synced from the grid. A lock implies visible, so
 * each locked bookend goes back in at its end.
 */
export function withStructuralLocks(read: PreferencesValue, locks: readonly string[]): PreferencesValue {
  const missing = (key: string) => locks.includes(key) && !read.visibleColumns.includes(key)
  return {
    ...read,
    lockedColumns: [...locks],
    visibleColumns: [
      ...(missing(LEAD_COLUMN) ? [LEAD_COLUMN] : []),
      ...read.visibleColumns,
      ...(missing(TRAIL_COLUMN) ? [TRAIL_COLUMN] : []),
    ],
  }
}


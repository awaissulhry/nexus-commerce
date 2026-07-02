/**
 * moveRows — pure helper for the eBay flat-file "Move to parent" bulk action.
 *
 * Uses a local structural row type to avoid an import cycle with the heavy
 * client component.
 */

// Local structural row type — mirrors the subset of BaseRow + EbayRow that
// the helper needs. Keep in sync with BaseRow / EbayRow field names.
export type MoveableRow = {
  _rowId: string
  _isParent?: boolean
  _readonly?: boolean
  _shared?: boolean
  /** DB product id — used as the canonical identifier for the self-parent guard. */
  _productId?: string | number | null
  /** Group key used by the grid for family nesting. */
  platformProductId?: string | number | null
  _dirty?: boolean
  [key: string]: unknown
}

/**
 * Returns a new rows array where every **selected, moveable variant** row has
 * its `platformProductId` rewritten to `targetParentId`.
 *
 * Rules applied per row:
 * - Unselected → returned as-is (reference preserved)
 * - `_isParent === true` → skipped (can't move the parent itself)
 * - `_readonly === true` OR `_shared === true` → skipped (synthesized view rows)
 * - Self-parent (target equals row `_productId`) → skipped
 * - Already under target (`platformProductId === targetParentId`) → no-op; NOT marked dirty
 * - Otherwise → `{ ...row, platformProductId: targetParentId, _isParent: false, _dirty: true }`
 *
 * The grid regroups by `platformProductId` on next render, so the row visually
 * re-nests under the new parent without any extra work.
 */
export function moveRowsToParent<T extends MoveableRow>(
  rows: T[],
  selectedIds: Set<string>,
  targetParentId: string,
): T[] {
  return rows.map((r) => {
    if (!selectedIds.has(String(r._rowId))) return r
    if (r._isParent === true || r._readonly === true || r._shared === true) return r
    const selfId = String(r._productId ?? r._rowId ?? '')
    if (targetParentId === selfId) return r
    if (String(r.platformProductId ?? '') === targetParentId) return r
    return { ...r, platformProductId: targetParentId, _isParent: false, _dirty: true }
  })
}

/**
 * UFX P7 (item 7) — pure helpers for per-column hide/reorder.
 *
 * The grid already has GROUP-level visibility/order (Bar-3 pills, drag,
 * ColumnGroupModal); these helpers add a per-COLUMN layer on top, persisted
 * per storageKey by the grid:
 *   - `hidden`: a set of column ids removed from the rendered sheet (a view
 *     preference — data, validation, saves and replicate are untouched);
 *   - `orderByGroup`: groupId → saved column-id order WITHIN that group
 *     (columns never move across groups, so the group machinery is intact).
 *
 * Kept free of React/DOM so ordering/move semantics are unit-testable.
 */

/** Reorder `cols` by a saved id order: saved ids first (in saved order),
 *  ids not in the saved order keep their original relative order at the end
 *  (same semantics as the group-order reconcile). No saved order = as-is. */
export function applyColumnOrder<T extends { id: string }>(cols: T[], savedOrder?: string[]): T[] {
  if (!savedOrder || savedOrder.length === 0) return cols
  const pos = new Map(savedOrder.map((id, i) => [id, i]))
  const inOrder = cols.filter((c) => pos.has(c.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  const rest = cols.filter((c) => !pos.has(c.id))
  return [...inOrder, ...rest]
}

/**
 * Move `colId` one step left (-1) or right (+1) WITHIN its group, skipping
 * hidden columns (a move swaps with the adjacent VISIBLE column; hidden
 * neighbours travel implicitly with the reorder). Returns the group's new
 * full id order to persist, or null when the move is impossible (edge of the
 * group, or the column isn't in it).
 */
export function moveColumnInGroup(opts: {
  /** The group's columns in schema order. */
  groupColumnIds: string[]
  savedOrder?: string[]
  hidden: ReadonlySet<string>
  colId: string
  dir: -1 | 1
}): string[] | null {
  const { groupColumnIds, savedOrder, hidden, colId, dir } = opts
  const effective = applyColumnOrder(groupColumnIds.map((id) => ({ id })), savedOrder).map((c) => c.id)
  const from = effective.indexOf(colId)
  if (from === -1) return null
  // Nearest visible neighbour in the direction of travel.
  let to = from + dir
  while (to >= 0 && to < effective.length && hidden.has(effective[to])) to += dir
  if (to < 0 || to >= effective.length) return null
  const next = [...effective]
  const [moved] = next.splice(from, 1)
  // Insert at `to` in the post-removal array: rightward the removal shifted
  // the neighbour to to-1 (so `to` lands just after it); leftward the
  // neighbour is still at `to` (so `to` lands just before it).
  next.splice(to, 0, moved)
  return next
}

/** True when `colId` has a visible neighbour in direction `dir` (menu enable). */
export function canMoveColumn(opts: {
  groupColumnIds: string[]
  savedOrder?: string[]
  hidden: ReadonlySet<string>
  colId: string
  dir: -1 | 1
}): boolean {
  return moveColumnInGroup(opts) !== null
}

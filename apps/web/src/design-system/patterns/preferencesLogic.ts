/**
 * The Customise dialog's LOGIC, pure — what a tick, a lock, a drag and a bulk pick do to a
 * `PreferencesValue`. Extracted from `usePreferencesPanes` (2026-09-05, the lock contract) so the
 * rules are tested in node rather than trusted, and so the modal and the popover cannot drift.
 *
 * Vocabulary (see `PreferencesModal.tsx`):
 *   - STRUCTURAL lock — `PreferencesColumnSpec.locked`: the grid's own pinned column, no control.
 *   - OPERATOR lock — a key in `value.lockedColumns` (falling back to the specs' `defaultLocked` when
 *     the value predates the control): FROZEN at the left of the scrolling band, always visible, in a
 *     block right after the structural leading columns, in the order the operator locked them.
 *   - a lock implies visible: locking a hidden column shows it; a locked column cannot be unticked.
 */
import type { PreferencesColumnSpec, PreferencesValue } from './PreferencesModal'

export interface AttributeGroup {
  key: string
  label: string
  columns: PreferencesColumnSpec[]
}

/** A view may contain fields unavailable on the current product type; an edit must retain them. */
function retainUnavailableColumns(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, liveOrder: string[]): string[] {
  const known = new Set(allColumns.map((c) => c.key))
  return [...new Set([...liveOrder, ...(value.columnOrder ?? []).filter((key) => !known.has(key))])]
}

/** Resolve the complete layout, including hidden attributes. Group IDs belong to the schema. */
export function resolveAttributeGroups(
  allColumns: readonly PreferencesColumnSpec[],
  value: PreferencesValue,
  listLabel = 'Columns',
): AttributeGroup[] {
  const groups = new Map<string, AttributeGroup>()
  const groupOf = (c: PreferencesColumnSpec) => c.groupKey?.trim() || c.group?.trim() || listLabel
  const columns = allColumns.filter((c) => !c.locked)
  for (const c of columns) {
    const key = groupOf(c)
    if (!groups.has(key)) groups.set(key, { key, label: c.group?.trim() || listLabel, columns: [] })
  }
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const order = [...new Set([...(value.columnOrder ?? []), ...value.visibleColumns, ...columns.map((c) => c.key)])]
  for (const key of order) {
    const c = byKey.get(key)
    if (!c) continue
    const override = value.groupOverrides?.[key]
    const group = groups.get(override ?? '') ?? groups.get(groupOf(c))!
    group.columns.push(c)
  }
  return [...new Set([...(value.groupOrder ?? []), ...groups.keys()])]
    .flatMap((key) => { const group = groups.get(key); return group ? [group] : [] })
}

/** Move a set together without changing visibility or pins. Unknown groups/structural keys are refused. */
export function moveAttributesToGroup(
  allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, keys: readonly string[], targetGroup: string,
): PreferencesValue {
  const groups = resolveAttributeGroups(allColumns, value)
  if (!groups.some((g) => g.key === targetGroup)) return value
  const wanted = new Set(keys)
  const moved = groups.flatMap((g) => g.columns).filter((c) => wanted.has(c.key))
  if (!moved.length) return value
  const movedKeys = new Set(moved.map((c) => c.key))
  const groupOverrides = { ...value.groupOverrides }
  for (const c of moved) {
    const original = c.groupKey?.trim() || c.group?.trim() || 'Columns'
    if (original === targetGroup) delete groupOverrides[c.key]
    else groupOverrides[c.key] = targetGroup
  }
  const columnOrder = groups.flatMap((g) => [
    ...g.columns.filter((c) => !movedKeys.has(c.key)).map((c) => c.key),
    ...(g.key === targetGroup ? moved.map((c) => c.key) : []),
  ])
  return { ...value, groupOverrides, columnOrder: retainUnavailableColumns(allColumns, value, columnOrder) }
}

/** Group moves keep their attributes together; before/after is explicit for keyboard controls. */
export function moveAttributeGroup(
  allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, key: string, target: string, after = false,
): PreferencesValue {
  const order = resolveAttributeGroups(allColumns, value).map((g) => g.key)
  if (key === target || !order.includes(key) || !order.includes(target)) return value
  const next = order.filter((k) => k !== key)
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, key)
  return { ...value, groupOrder: [...new Set([...next, ...(value.groupOrder ?? []).filter((id) => !order.includes(id))])] }
}

/** Reorder a scrolling attribute, moving its display group when dropped into another group. */
export function moveAttributeColumn(
  allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, key: string, target: string, after = false,
): PreferencesValue {
  const defaults = allColumns.filter((c) => c.defaultLocked).map((c) => c.key)
  const locks = new Set(effectiveLocks(value, defaults))
  if (key === target || locks.has(key) || locks.has(target)) return value
  const groups = resolveAttributeGroups(allColumns, value)
  const source = groups.find((g) => g.columns.some((c) => c.key === key))
  const destination = groups.find((g) => g.columns.some((c) => c.key === target))
  if (!source || !destination) return value
  const next = source.key === destination.key ? value : moveAttributesToGroup(allColumns, value, [key], destination.key)
  const columnOrder = resolveAttributeGroups(allColumns, next).flatMap((g) => g.columns.map((c) => c.key)).filter((k) => k !== key)
  columnOrder.splice(columnOrder.indexOf(target) + (after ? 1 : 0), 0, key)
  return { ...next, columnOrder: retainUnavailableColumns(allColumns, next, columnOrder) }
}

/** Reset only the selected attributes' group assignment, preserving their values, visibility and pins. */
export function resetAttributeGroups(value: PreferencesValue, keys: readonly string[]): PreferencesValue {
  const groupOverrides = { ...value.groupOverrides }
  for (const key of keys) delete groupOverrides[key]
  return { ...value, groupOverrides }
}

/** The grouped dialog's visual order, flattened for hosts that render ordinary grid columns. */
export function normalizeGroupedPreferences(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, listLabel = 'Columns'): PreferencesValue {
  const groups = resolveAttributeGroups(allColumns, value, listLabel)
  const shown = new Set(value.visibleColumns)
  const defaults = allColumns.filter((c) => c.defaultLocked).map((c) => c.key)
  const locks = new Set(effectiveLocks(value, defaults))
  const grouped = groups.flatMap((g) => g.columns.map((c) => c.key))
  const ordered = orderedForDisplay(allColumns, { ...value, visibleColumns: grouped.filter((key) => shown.has(key)) }, defaults)
  const known = new Set(allColumns.map((c) => c.key))
  return {
    ...value,
    visibleColumns: [...ordered.filter((c) => c.locked || locks.has(c.key) || shown.has(c.key)).map((c) => c.key), ...value.visibleColumns.filter((key) => !known.has(key))],
    columnOrder: [...new Set([...(value.columnOrder ?? value.visibleColumns), ...allColumns.map((c) => c.key)])],
    groupOrder: [...new Set([...(value.groupOrder ?? []), ...groups.map((g) => g.key)])],
    groupOverrides: { ...value.groupOverrides },
  }
}

/** The operator's locks, or where they start if this value predates the control. */
export function effectiveLocks(value: Pick<PreferencesValue, 'lockedColumns'>, defaultLocked: readonly string[]): string[] {
  return value.lockedColumns ?? [...defaultLocked]
}

/** Keys the operator may tick, drag or lock: every spec that is not structurally locked. */
export function togglableKeysOf(allColumns: readonly PreferencesColumnSpec[]): string[] {
  return allColumns.filter((c) => !c.locked).map((c) => c.key)
}

/** Tick or untick one column. A locked column is not unticked — a lock implies visible. */
export function toggleColumn(value: PreferencesValue, key: string, defaultLocked: readonly string[] = []): PreferencesValue {
  if (effectiveLocks(value, defaultLocked).includes(key)) return value
  return {
    ...value,
    visibleColumns: value.visibleColumns.includes(key) ? value.visibleColumns.filter((k) => k !== key) : [...value.visibleColumns, key],
  }
}

/**
 * Add a SET (a group's columns, a quick pick). Only keys in `togglable` and not already visible are
 * appended, in the given order; a set that adds nothing returns the same value (referentially), so
 * a caller can tell "nothing to do" from "done".
 */
export function addColumns(value: PreferencesValue, keys: readonly string[], togglable: ReadonlySet<string>): PreferencesValue {
  const have = new Set(value.visibleColumns)
  const add = keys.filter((k) => togglable.has(k) && !have.has(k))
  return add.length ? { ...value, visibleColumns: [...value.visibleColumns, ...add] } : value
}

/** Remove a SET. Locked columns are never removed — a lock implies visible. */
export function removeColumns(value: PreferencesValue, keys: readonly string[], defaultLocked: readonly string[] = []): PreferencesValue {
  const locks = new Set(effectiveLocks(value, defaultLocked))
  const drop = new Set(keys.filter((k) => !locks.has(k)))
  const next = value.visibleColumns.filter((k) => !drop.has(k))
  return next.length === value.visibleColumns.length ? value : { ...value, visibleColumns: next }
}

/**
 * Is a SET fully in view? Only the keys this grid has and the operator may toggle count, so a pick
 * naming a column this product type lacks still reads "pressed" once every applicable column is in.
 * An empty applicable set is never "pressed" — a control that lights for nothing is lying.
 */
export function setHas(value: PreferencesValue, keys: readonly string[], togglable: ReadonlySet<string>): boolean {
  const applicable = keys.filter((k) => togglable.has(k))
  return applicable.length > 0 && applicable.every((k) => value.visibleColumns.includes(k))
}

/**
 * Lock or unlock one column.
 *
 * LOCK: appended to the lock set (so the frozen block keeps the order the operator locked in) and
 * made visible — a lock implies visible. UNLOCK: removed from the set and moved to the FRONT of the
 * visible order, so it lands right after the frozen block where the operator was looking, rather
 * than jumping back to wherever it sat before it was locked.
 */
export function toggleLock(value: PreferencesValue, key: string, defaultLocked: readonly string[]): PreferencesValue {
  const cur = effectiveLocks(value, defaultLocked)
  if (cur.includes(key)) {
    const visible = [key, ...value.visibleColumns.filter((k) => k !== key)]
    return { ...value, lockedColumns: cur.filter((k) => k !== key), visibleColumns: visible }
  }
  const visible = value.visibleColumns.includes(key) ? value.visibleColumns : [...value.visibleColumns, key]
  return { ...value, lockedColumns: [...cur, key], visibleColumns: visible }
}

/**
 * Drag one row onto another in the "In view" list.
 *
 * Two orders live in one list: the frozen block is `lockedColumns`, the rest is `visibleColumns`.
 * A drop is honoured only WITHIN a block — a locked row may not be dragged out of the frozen block
 * (that is what the padlock is for) and an unlocked row may not be dropped into it. A refused drop
 * returns the same value, so the caller can leave the list exactly as it was.
 */
export function moveVisible(
  value: PreferencesValue,
  dragKey: string,
  targetKey: string,
  defaultLocked: readonly string[],
  /** Which edge a lock freezes a column to (default left); a drop across the two edges is refused. */
  sideOf: (key: string) => 'left' | 'right' = () => 'left',
): PreferencesValue {
  if (dragKey === targetKey) return value
  const locks = effectiveLocks(value, defaultLocked)
  const dragLocked = locks.includes(dragKey)
  const targetLocked = locks.includes(targetKey)
  if (dragLocked !== targetLocked) return value
  if (dragLocked && sideOf(dragKey) !== sideOf(targetKey)) return value
  const list = dragLocked ? [...locks] : [...value.visibleColumns]
  const from = list.indexOf(dragKey)
  const to = list.indexOf(targetKey)
  if (from === -1 || to === -1) return value
  list.splice(from, 1)
  list.splice(to, 0, dragKey)
  return dragLocked ? { ...value, lockedColumns: list } : { ...value, visibleColumns: list }
}

/**
 * The "In view" order the dialog renders: structural leading → the operator's frozen block (in
 * `lockedColumns` order) → visible (draft order, locks excluded) → hidden → the operator's
 * RIGHT-side locks (`lockSide: 'right'`, e.g. an actions bookend) → structural trailing.
 * Structural columns keep their place from `allColumns` (leading = before the first togglable spec,
 * trailing = after the last), exactly as the grid's own lead/trail bridge reads them. The list reads
 * in SCREEN order — measured 2026-09-05 on /products/next: a right-frozen `actions` listed at the TOP
 * with the left locks said the opposite of what the grid showed.
 */
export function orderedForDisplay(
  allColumns: readonly PreferencesColumnSpec[],
  value: PreferencesValue,
  defaultLocked: readonly string[],
): PreferencesColumnSpec[] {
  const firstUnlockedIdx = allColumns.findIndex((c) => !c.locked)
  let lastUnlockedIdx = -1
  for (let i = allColumns.length - 1; i >= 0; i--) {
    if (!allColumns[i].locked) { lastUnlockedIdx = i; break }
  }
  const structuralLeading = allColumns.filter((c, i) => c.locked && (firstUnlockedIdx === -1 || i < firstUnlockedIdx))
  const structuralTrailing = allColumns.filter((c, i) => c.locked && lastUnlockedIdx !== -1 && i > lastUnlockedIdx)
  const byKey = new Map(allColumns.map((c) => [c.key, c]))
  const locks = effectiveLocks(value, defaultLocked).filter((k) => byKey.has(k) && !byKey.get(k)!.locked)
  const lockSet = new Set(locks)
  const frozenLeft = locks.map((k) => byKey.get(k)!).filter((c) => c.lockSide !== 'right')
  const frozenRight = locks.map((k) => byKey.get(k)!).filter((c) => c.lockSide === 'right')
  const visible = value.visibleColumns
    .map((k) => byKey.get(k))
    .filter((c): c is PreferencesColumnSpec => !!c && !c.locked && !lockSet.has(c.key))
  const shown = new Set([...lockSet, ...visible.map((c) => c.key)])
  const hidden = allColumns.filter((c) => !c.locked && !shown.has(c.key))
  return [...structuralLeading, ...frozenLeft, ...visible, ...hidden, ...frozenRight, ...structuralTrailing]
}

/**
 * "In view · n of N": n = every non-structural column on screen (visible OR locked — a lock implies
 * visible), N = every non-structural column the grid has. Locking a column must not shrink either
 * side (measured 2026-09-05: "10 of 12" read "9 of 11" after one lock, because the denominator was
 * the TOGGLABLE set, which a lock leaves).
 */
export function inViewCount(
  allColumns: readonly PreferencesColumnSpec[],
  value: PreferencesValue,
  defaultLocked: readonly string[],
): { shown: number; total: number } {
  const locks = new Set(effectiveLocks(value, defaultLocked))
  const nonStructural = allColumns.filter((c) => !c.locked)
  const shown = nonStructural.filter((c) => locks.has(c.key) || value.visibleColumns.includes(c.key)).length
  return { shown, total: nonStructural.length }
}

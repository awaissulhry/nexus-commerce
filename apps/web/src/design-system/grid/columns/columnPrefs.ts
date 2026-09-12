/**
 * The DS Customise dialog ↔ AG column state, in both directions.
 *
 * The operator's Customise dialog is the DS `PreferencesModal` — the one this product designed,
 * with its grouped column list and drag-reorder. AG's Columns tool panel does the same job in
 * AG's idiom and is not shown. What AG contributes is the ENGINE underneath: `getColumnState()`
 * is one object holding order, visibility, pinning, width and sort, read with one call and
 * applied with one call. These two functions are the whole bridge, and they are pure so the
 * bridge is tested rather than trusted.
 *
 * Reading FROM the grid (not from a copy the page keeps) is what makes the dialog honest: a
 * column dragged in the header shows up in that order when the dialog opens.
 */
import type { ColumnState } from 'ag-grid-community'

import type { PreferencesValue } from '@/design-system/patterns/PreferencesModal'

/** AG's fixed ids for the columns it creates itself. */
export const AG_SELECTION_COL = 'ag-Grid-SelectionColumn'
export const AG_AUTO_COL = 'ag-Grid-AutoColumn'

export interface PrefsColumnMeta {
  /** Column key as the page and the dialog know it. */
  key: string
  /** Held at an end of the dialog and never toggled off (the identity and actions columns). */
  locked?: boolean
}

export interface PrefsBridgeOptions {
  /** Every page column, in the page's declared order. */
  columns: readonly PrefsColumnMeta[]
  /** The page key that is rendered as AG's auto-group (tree) column, if any. */
  treeColumnKey?: string
  /** Dialog sort keys that are not column keys, mapped to the column that carries the sort. */
  sortKeyToColumn?: Readonly<Record<string, string>>
  /**
   * 🔴 Called with any ticked key this bridge has NO column for (#759).
   *
   * Without it such a key is dropped by the `.filter` below and the operator's choice disappears
   * with no entry and no error — measured on the live contract: 99 entries whether or not an
   * unaddressable key is in `visibleColumns`. A dialog that shows a column an `applyColumnState`
   * cannot address has a real disagreement to report, and the one thing it must not do is present
   * the save as done. Unhandled, it is a dev `console.error` rather than silence.
   */
  onUnaddressable?: (keys: readonly string[]) => void
}

const toAgId = (key: string, o: PrefsBridgeOptions) => (key === o.treeColumnKey ? AG_AUTO_COL : key)
const fromAgId = (colId: string, o: PrefsBridgeOptions) => (colId === AG_AUTO_COL && o.treeColumnKey ? o.treeColumnKey : colId)

/**
 * The operator's LOCKS as the grid understands them (the lock contract, 2026-09-05).
 *
 * A locked column is FROZEN at the left of the scrolling band — AG `pinned: 'left'` — always visible,
 * in a contiguous block right after the bridge's structural lead columns, in `lockedColumns` order.
 * `PreferencesValue.lockedColumns` is the ONLY representation of that set; structural locks
 * (`PrefsColumnMeta.locked`) are the grid's own and never appear in it. A key in `lockedColumns` that
 * names a structural or unknown column is not an operator lock and is ignored here.
 */
export function operatorLocks(prefs: Pick<PreferencesValue, 'lockedColumns'>, o: PrefsBridgeOptions): string[] {
  const togglable = new Set(o.columns.filter((c) => !c.locked).map((c) => c.key))
  const out: string[] = []
  for (const k of prefs.lockedColumns ?? []) if (togglable.has(k) && !out.includes(k)) out.push(k)
  return out
}

/**
 * Dialog → grid. Returns the state for `api.applyColumnState({ state, applyOrder: true })`.
 *
 * Order: selection column, then the leading locked columns in declared order, then the OPERATOR's
 * locked block (frozen left, in `lockedColumns` order), then the dialog's visible columns in the
 * operator's order, then the trailing locked columns. A togglable column absent from
 * `visibleColumns` is hidden, never dropped — its width and everything else survive. A locked
 * column is visible whatever `visibleColumns` says: a lock implies visible.
 */
export function prefsToColumnState(prefs: PreferencesValue, o: PrefsBridgeOptions): ColumnState[] {
  const togglable = o.columns.filter((c) => !c.locked)
  const lastMovableIdx = o.columns.reduce((i, c, idx) => (c.locked ? i : idx), -1)
  const lead = o.columns.filter((c, idx) => c.locked && idx < lastMovableIdx)
  const trail = o.columns.filter((c, idx) => c.locked && idx > lastMovableIdx)
  const locks = operatorLocks(prefs, o)
  const lockedSet = new Set(locks)
  const visible = new Set(prefs.visibleColumns)
  const orderedVisible = prefs.visibleColumns
    .map((k) => togglable.find((c) => c.key === k))
    .filter((c): c is PrefsColumnMeta => !!c && !lockedSet.has(c.key))
  /* 🔴 REFUSED, never swallowed (#759). The `.filter` above is correct — an entry cannot be built
     for a column that does not exist — but dropping the key silently makes the dialog and the grid
     disagree with nothing on screen saying so. Same class as a reveal reporting `distance 0` when it
     could not measure: an unanswerable case presented as a completed one. */
  const unaddressable = prefs.visibleColumns.filter((k) => !togglable.some((c) => c.key === k) && !o.columns.some((c) => c.key === k))
  if (unaddressable.length > 0) {
    if (o.onUnaddressable) o.onUnaddressable(unaddressable)
    else if (process.env.NODE_ENV !== 'production') {
      console.error('[columnPrefs] the dialog offered columns this grid cannot address:', unaddressable.join(', '))
    }
  }
  const hidden = togglable.filter((c) => !visible.has(c.key) && !lockedSet.has(c.key))

  const sortCol = prefs.sortBy ? toAgId(o.sortKeyToColumn?.[prefs.sortBy] ?? prefs.sortBy, o) : null
  // Row grouping and aggregation ARE column state in AG: a grouped column carries `rowGroup`
  // (and hides, the way AG hides a grouped column), an aggregated one carries `aggFunc`.
  const rowGroups = prefs.rowGroups ?? []
  const aggregations = prefs.aggregations ?? {}
  /**
   * 🔴 `sort` is OMITTED unless this bridge actually has an opinion — AG.1-c.
   *
   * `applyColumnState` changes only the properties an entry states; an explicit `null` is a
   * decision to CLEAR. Stating `sort: null` on every column made every view application a silent
   * reset of the operator's header sort — measured on the studio sheet: `name:asc` vanished on an
   * Overview → Content switch, and on a view CHIP too, which is not even a view change to an
   * operator. Sort belongs to the header the operator clicked.
   *
   * 🔴 `pinned` IS stated for every togglable column since 2026-09-05 — `'left'` for an operator
   * lock, `null` for the rest — and that is the SAME rule AG.1-c protected, kept a different way.
   * AG.1-c omitted `pinned` because a hand-pin made through the header menu lived nowhere but on
   * the grid, so any statement about pinning could only destroy it. Under the lock contract a pin
   * IS a lock: `columnStateToPrefs` reads `pinned === 'left'` back as `lockedColumns`, and every
   * caller reads the grid's locks before it applies anything (a preset, a saved view, a chip). So
   * the operator's pin is in `lockedColumns` when this runs, and is re-stated rather than cleared;
   * what a `null` clears is exactly the column the operator just UNLOCKED, which omission could
   * never do — the previous rule had no way to release a lock at all. Prevented by construction,
   * not by omission.
   *
   * The lead/trail pins are still stated explicitly — those ARE this bridge's own decision (the
   * structural padlocks). Removing them is what previously let a landing view silently un-pin the
   * identity block: a declaration the very next call overrides is not a declaration.
   */
  const entry = (key: string, hide: boolean, pinned?: 'left' | 'right' | null): ColumnState => {
    const colId = toAgId(key, o)
    const groupIndex = rowGroups.indexOf(key)
    return {
      colId,
      hide: hide || groupIndex >= 0,
      // `undefined` = "no opinion, leave it": omitted from the object entirely.
      ...(pinned === undefined ? {} : { pinned }),
      // Only when the dialog NAMES a sort column. Then the others must be cleared, or AG would
      // add the new sort alongside whatever was there.
      ...(sortCol ? { sort: sortCol === colId ? prefs.sortDir : null, sortIndex: sortCol === colId ? 0 : null } : {}),
      rowGroup: groupIndex >= 0,
      rowGroupIndex: groupIndex >= 0 ? groupIndex : null,
      aggFunc: aggregations[key] ?? null,
    }
  }

  return [
    // The selection column carries no sort and no pin of its own — `NexusGrid.keepSelectionFirst`
    // owns its pinning, and stating it here would fight the engine on every view application.
    { colId: AG_SELECTION_COL, hide: false, rowGroup: false, rowGroupIndex: null, aggFunc: null },
    ...lead.map((c) => entry(c.key, false, prefs.stickyFirstColumn ? 'left' : null)),
    // The operator's frozen block — visible whatever the tick-list says, in the order they locked.
    ...locks.map((k) => entry(k, false, 'left')),
    ...orderedVisible.map((c) => entry(c.key, false, null)),
    ...trail.map((c) => entry(c.key, false, prefs.stickyLastColumn ? 'right' : null)),
    // Hidden ones go last so `applyOrder` never interleaves them with what is shown.
    ...hidden.map((c) => entry(c.key, true, null)),
  ]
}

/**
 * Grid → dialog. Reads what the operator has actually arranged.
 *
 * `visibleColumns` is the togglable columns that are not hidden, in the grid's CURRENT order.
 * The sort is the first-indexed sorted column, mapped back through `sortKeyToColumn` so the
 * dialog's sort select shows the option it offers. `pageSize` is carried through from `previous`.
 *
 * 🔴 `lockedColumns` is DERIVED from the grid, never carried through: the togglable columns pinned
 * left, in displayed order. A pin made from the header menu is therefore a lock the dialog shows
 * and every later apply re-states (the lock contract). Only a caller that never opted into locks
 * (`previous.lockedColumns === undefined`) gets no field back — its shape is unchanged.
 */
export function columnStateToPrefs(state: readonly ColumnState[], previous: PreferencesValue, o: PrefsBridgeOptions): PreferencesValue {
  const togglable = new Set(o.columns.filter((c) => !c.locked).map((c) => c.key))
  // A grouped column is hidden by AG while it groups; it is still one of the operator's columns.
  const shown = (s: ColumnState) => !s.hide || !!s.rowGroup
  const visibleColumns = state.map((s) => fromAgId(s.colId, o)).filter((k) => togglable.has(k) && shown(state.find((s) => fromAgId(s.colId, o) === k)!))
  const lockedColumns = state.filter((s) => s.pinned === 'left').map((s) => fromAgId(s.colId, o)).filter((k) => togglable.has(k))
  const rowGroups = [...state].filter((s) => s.rowGroup).sort((a, b) => (a.rowGroupIndex ?? 0) - (b.rowGroupIndex ?? 0)).map((s) => fromAgId(s.colId, o))
  const aggregations: NonNullable<PreferencesValue['aggregations']> = {}
  for (const s of state) if (typeof s.aggFunc === 'string') aggregations[fromAgId(s.colId, o)] = s.aggFunc as NonNullable<PreferencesValue['aggregations']>[string]

  const sorted = [...state].filter((s) => s.sort).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))[0]
  const sortedKey = sorted ? fromAgId(sorted.colId, o) : ''
  const inverse = Object.entries(o.sortKeyToColumn ?? {}).find(([, col]) => col === sortedKey)?.[0]

  const lead = o.columns.find((c) => c.locked)
  const trail = [...o.columns].reverse().find((c) => c.locked)
  const pinnedOf = (key: string | undefined) => (key ? state.find((s) => fromAgId(s.colId, o) === key)?.pinned ?? null : null)

  return {
    ...previous,
    visibleColumns,
    ...(previous.lockedColumns !== undefined ? { lockedColumns } : {}),
    stickyFirstColumn: pinnedOf(lead?.key) === 'left',
    stickyLastColumn: pinnedOf(trail?.key) === 'right',
    sortBy: sorted ? (inverse ?? sortedKey) : previous.sortBy,
    sortDir: sorted ? (sorted.sort as 'asc' | 'desc') : previous.sortDir,
    ...(previous.rowGroups !== undefined ? { rowGroups } : {}),
    ...(previous.aggregations !== undefined ? { aggregations } : {}),
  }
}

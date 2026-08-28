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
}

const toAgId = (key: string, o: PrefsBridgeOptions) => (key === o.treeColumnKey ? AG_AUTO_COL : key)
const fromAgId = (colId: string, o: PrefsBridgeOptions) => (colId === AG_AUTO_COL && o.treeColumnKey ? o.treeColumnKey : colId)

/**
 * Dialog → grid. Returns the state for `api.applyColumnState({ state, applyOrder: true })`.
 *
 * Order: selection column, then the leading locked columns in declared order, then the dialog's
 * visible columns in the OPERATOR's order, then the trailing locked columns. A togglable column
 * absent from `visibleColumns` is hidden, never dropped — its width and everything else survive.
 */
export function prefsToColumnState(prefs: PreferencesValue, o: PrefsBridgeOptions): ColumnState[] {
  const togglable = o.columns.filter((c) => !c.locked)
  const lastMovableIdx = o.columns.reduce((i, c, idx) => (c.locked ? i : idx), -1)
  const lead = o.columns.filter((c, idx) => c.locked && idx < lastMovableIdx)
  const trail = o.columns.filter((c, idx) => c.locked && idx > lastMovableIdx)
  const visible = new Set(prefs.visibleColumns)
  const orderedVisible = prefs.visibleColumns.map((k) => togglable.find((c) => c.key === k)).filter((c): c is PrefsColumnMeta => !!c)
  const hidden = togglable.filter((c) => !visible.has(c.key))

  const sortCol = prefs.sortBy ? toAgId(o.sortKeyToColumn?.[prefs.sortBy] ?? prefs.sortBy, o) : null
  // Row grouping and aggregation ARE column state in AG: a grouped column carries `rowGroup`
  // (and hides, the way AG hides a grouped column), an aggregated one carries `aggFunc`.
  const rowGroups = prefs.rowGroups ?? []
  const aggregations = prefs.aggregations ?? {}
  const entry = (key: string, hide: boolean, pinned: 'left' | 'right' | null): ColumnState => {
    const colId = toAgId(key, o)
    const groupIndex = rowGroups.indexOf(key)
    return {
      colId,
      hide: hide || groupIndex >= 0,
      pinned,
      sort: sortCol === colId ? prefs.sortDir : null,
      sortIndex: sortCol === colId ? 0 : null,
      rowGroup: groupIndex >= 0,
      rowGroupIndex: groupIndex >= 0 ? groupIndex : null,
      aggFunc: aggregations[key] ?? null,
    }
  }

  return [
    { colId: AG_SELECTION_COL, hide: false, pinned: null, sort: null, sortIndex: null, rowGroup: false, rowGroupIndex: null, aggFunc: null },
    ...lead.map((c) => entry(c.key, false, prefs.stickyFirstColumn ? 'left' : null)),
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
 * dialog's sort select shows the option it offers. Fields the grid does not hold (`lockedColumns`,
 * `pageSize`) are carried through from `previous`.
 */
export function columnStateToPrefs(state: readonly ColumnState[], previous: PreferencesValue, o: PrefsBridgeOptions): PreferencesValue {
  const togglable = new Set(o.columns.filter((c) => !c.locked).map((c) => c.key))
  // A grouped column is hidden by AG while it groups; it is still one of the operator's columns.
  const shown = (s: ColumnState) => !s.hide || !!s.rowGroup
  const visibleColumns = state.map((s) => fromAgId(s.colId, o)).filter((k) => togglable.has(k) && shown(state.find((s) => fromAgId(s.colId, o) === k)!))
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
    stickyFirstColumn: pinnedOf(lead?.key) === 'left',
    stickyLastColumn: pinnedOf(trail?.key) === 'right',
    sortBy: sorted ? (inverse ?? sortedKey) : previous.sortBy,
    sortDir: sorted ? (sorted.sort as 'asc' | 'desc') : previous.sortDir,
    ...(previous.rowGroups !== undefined ? { rowGroups } : {}),
    ...(previous.aggregations !== undefined ? { aggregations } : {}),
  }
}

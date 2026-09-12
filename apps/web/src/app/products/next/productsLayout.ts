import type { ColumnState, GridState } from '@/design-system/grid'

import type { PreferencesColumnSpec, PreferencesValue } from '@/design-system/patterns/PreferencesModal'
import { AG_AUTO_COL, prefsToColumnState, type PrefsBridgeOptions } from '@/design-system/grid/columns/columnPrefs'
import type { GridViewPayload } from '@/design-system/grid/hooks/useGridViews'
import { layoutFromPreferences } from '@/design-system/grid/views/columnLayout'
import { isColumnsViewPayload, type SheetLayoutPayload } from '@/design-system/grid/views/viewPayload'
import { composeLocks, isStructuralColumn, withStructuralLocks } from './columnLocks'

/** Stage the modal's confirmed layout for persistence before changing the running grid. */
export function buildProductsLayout<TPage extends { lockedColumns: string[] }>(
  snapshot: GridViewPayload<TPage>,
  draft: PreferencesValue,
  specs: readonly PreferencesColumnSpec[],
  bridge: PrefsBridgeOptions,
): GridViewPayload<TPage & { columnLayout: SheetLayoutPayload }> {
  const locks = composeLocks(draft.lockedColumns ?? snapshot.page.lockedColumns)
  const preferences = withStructuralLocks({
    ...draft,
    stickyFirstColumn: locks.includes('product'),
    stickyLastColumn: locks.includes('actions'),
  }, locks)
  // These bookends are operator-lockable on /products/next, so retain them in the layout even
  // when the current bridge treats their confirmed pins as structural.
  const layoutSpecs = specs.map((column) => isStructuralColumn(column.key) ? { ...column, locked: false } : column)
  const columnLayout = layoutFromPreferences(layoutSpecs, preferences)
  const known = new Set(bridge.columns.map((column) => column.key))
  const staged = prefsToColumnState({
    ...preferences,
    visibleColumns: columnLayout.columns.filter((key) => known.has(key)),
    rowGroups: preferences.rowGroups ?? snapshot.gridState.rowGroup?.groupColIds.map((id) => id === AG_AUTO_COL && bridge.treeColumnKey ? bridge.treeColumnKey : id),
  }, {
    ...bridge,
    columns: bridge.columns.map((column) => isStructuralColumn(column.key)
      ? { ...column, locked: locks.includes(column.key) }
      : column),
  })
  const ids = new Set(staged.map((column) => column.colId))
  const order = [...staged.map((column) => column.colId), ...(snapshot.gridState.columnOrder?.orderedColIds ?? []).filter((id) => !ids.has(id))]
  const gridState: GridState = {
    ...snapshot.gridState,
    columnOrder: { orderedColIds: order },
    columnVisibility: { hiddenColIds: [
      ...staged.filter((column) => column.hide).map((column) => column.colId),
      ...(snapshot.gridState.columnVisibility?.hiddenColIds ?? []).filter((id) => !ids.has(id)),
    ] },
  }
  // Row selection belongs to the current bulk operation, not to a reusable saved layout.
  delete gridState.rowSelection

  // The bridge leaves the selection column's pin to the grid. Preserve any pin it did not state.
  const pinDecisions = new Map(staged.filter((column) => column.pinned !== undefined).map((column) => [column.colId, column.pinned]))
  const pinned = (side: 'left' | 'right') => {
    const previous = new Set(snapshot.gridState.columnPinning?.[side === 'left' ? 'leftColIds' : 'rightColIds'] ?? [])
    const wanted = new Set([
      ...staged.filter((column) => column.pinned === side).map((column) => column.colId),
      ...[...previous].filter((id) => !pinDecisions.has(id)),
    ])
    return [...new Set([...order, ...wanted])].filter((id) => wanted.has(id))
  }
  gridState.columnPinning = { leftColIds: pinned('left'), rightColIds: pinned('right') }

  if (draft.rowGroups !== undefined) {
    gridState.rowGroup = { groupColIds: [
      ...staged.filter((column) => column.rowGroup).sort((a, b) => (a.rowGroupIndex ?? 0) - (b.rowGroupIndex ?? 0)).map((column) => column.colId),
      ...(snapshot.gridState.rowGroup?.groupColIds ?? []).filter((id) => !ids.has(id)),
    ] }
  }
  if (draft.aggregations !== undefined) {
    gridState.aggregation = { aggregationModel: [
      ...staged.filter((column): column is ColumnState & { aggFunc: string } => typeof column.aggFunc === 'string')
        .map((column) => ({ colId: column.colId, aggFunc: column.aggFunc })),
      ...(snapshot.gridState.aggregation?.aggregationModel ?? []).filter((column) => !ids.has(column.colId)),
    ] }
  }
  if (draft.sortBy) {
    gridState.sort = { sortModel: [
      ...staged.filter((column): column is ColumnState & { sort: 'asc' | 'desc' } => column.sort === 'asc' || column.sort === 'desc')
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((column) => ({ colId: column.colId, sort: column.sort })),
      ...(snapshot.gridState.sort?.sortModel ?? []).filter((column) => !ids.has(column.colId)),
    ] }
  }
  return { ...snapshot, gridState, page: { ...snapshot.page, lockedColumns: locks, columnLayout } }
}

/** Older product views have no group layout; malformed and unrelated payloads stay unsupported. */
export function readProductsLayout(payload: unknown): SheetLayoutPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = payload as { v?: unknown; gridState?: unknown; page?: unknown }
  if (value.v !== 1 || !value.gridState || typeof value.gridState !== 'object' || Array.isArray(value.gridState) ||
    !value.page || typeof value.page !== 'object' || Array.isArray(value.page)) return null
  const columnLayout = (value.page as { columnLayout?: unknown }).columnLayout
  return isColumnsViewPayload(columnLayout) && columnLayout.v === 3 ? columnLayout : null
}

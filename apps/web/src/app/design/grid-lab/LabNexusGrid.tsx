'use client'

/**
 * The parity lab's AG panel, on the DS grid itself.
 *
 * Until GDS Phase 2 this panel was `AgWorkspaceGrid` — AG Grid re-expressed through the legacy
 * `WorkspaceGridProps` contract. That layer is gone (it produced the flat-list sort bug the lab was
 * built to catch), so the lab now does what every rebuilt page does: projects its column registry to
 * AG's own `ColDef[]` and hands them to `NexusGrid`. The fixture (`LAB_COLUMNS`, `LAB_ROWS`,
 * `LAB_FILTERS`) is still shared with the legacy panel, so a difference between the two grids is
 * still the engine's, never the data's.
 *
 * Lab-only: this folder may import `ag-grid-*` (see scripts/check-ag-grid-import-boundary.mjs).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { CellValueChangedEvent, ColDef, GridApi, GridReadyEvent, GridState, ICellRendererParams, RowClickedEvent, SelectionChangedEvent } from 'ag-grid-community'

import { Button } from '@/design-system/primitives'
import { NexusGrid, numericColumn } from '@/design-system/grid/NexusGrid'
import { filterRows } from '@/design-system/patterns/workspace-grid/filterRows'
import { isInteractiveChild } from '@/design-system/patterns/workspace-grid/rowInteraction'
import type { FilterState, GridFilter } from '@/design-system/patterns/workspace-grid/WorkspaceGrid'

import { LAB_COLUMNS, LAB_ROWS, type LabRow } from './fixture'

interface TotalRow extends LabRow {
  __total: true
}
const isTotal = (d: LabRow | undefined): d is TotalRow => !!d && (d as TotalRow).__total === true

function FirstCell({ data }: ICellRendererParams<LabRow>) {
  if (!data) return null
  if (isTotal(data)) return <b>Total</b>
  return (
    <>
      <span className={data.live ? 'dot live' : 'dot'} />
      <span className="t">{data.name}</span>
    </>
  )
}

export interface LabNexusGridProps {
  filters: readonly GridFilter[]
  filterState: FilterState
  onRowClick: (row: LabRow) => void
  /** Enterprise toggles the lab exposes: the Columns/Filters side bar, set filters on every column. */
  sideBar: boolean
  setFilters: boolean
}

export function LabNexusGrid({ filters, filterState, onRowClick, sideBar, setFilters }: LabNexusGridProps) {
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const apiRef = useRef<GridApi<LabRow> | null>(null)
  const onGridReady = useCallback((e: GridReadyEvent<LabRow>) => { apiRef.current = e.api }, [])

  const rows = useMemo(() => filterRows(LAB_ROWS, filters, filterState, LAB_COLUMNS), [filters, filterState])

  const totals = useMemo<TotalRow[]>(() => {
    const t = { __total: true, id: '__total', name: 'Total', kind: 'SP', live: false } as TotalRow
    // The legacy column contract computes totals per column from the VISIBLE rows; hold the
    // rendered strings on the pinned row so the same `total()` prints in both panels.
    for (const c of LAB_COLUMNS) (t as unknown as Record<string, unknown>)[`__total_${c.key}`] = typeof c.total === 'function' ? c.total(rows) : (c.total ?? '')
    return [t]
  }, [rows])

  const columnDefs = useMemo<ColDef<LabRow>[]>(() => {
    const first: ColDef<LabRow> = {
      colId: 'name',
      field: 'name',
      headerName: 'Campaign',
      pinned: 'left',
      width: 300,
      cellClass: ['nds-ag-cell', 'nds-ag-cell-first'],
      cellRenderer: FirstCell,
      editable: (p) => editing && !p.node.rowPinned,
      cellEditor: 'agTextCellEditor',
      ...(setFilters ? { filter: 'agSetColumnFilter' } : {}),
    }
    const rest = LAB_COLUMNS.map<ColDef<LabRow>>((c) => ({
      colId: c.key,
      headerName: c.label,
      width: c.width,
      sortable: !!c.sortable,
      // The fixture's `sortValue` IS the sort key (null = never measured, sinks both ways).
      valueGetter: (p) => (p.data && !isTotal(p.data) ? (c.sortValue ? c.sortValue(p.data) : null) : null),
      cellRenderer: (p: ICellRendererParams<LabRow>) =>
        !p.data ? null : isTotal(p.data) ? (p.data as unknown as Record<string, unknown>)[`__total_${c.key}`] : c.render(p.data),
      pinned: c.freezeRight ? 'right' : undefined,
      ...(c.align === 'left' ? { cellClass: ['nds-ag-cell', 'nds-ag-ed'] } : numericColumn),
      ...(setFilters ? { filter: 'agSetColumnFilter' } : {}),
    }))
    return [first, ...rest]
  }, [editing, setFilters])

  const rowSelection = useMemo(
    () => ({
      mode: 'multiRow' as const,
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: false,
      isRowSelectable: (n: { rowPinned?: string | null }) => !n.rowPinned,
    }),
    [],
  )
  const selectionColumnDef = useMemo(() => ({ width: 43, maxWidth: 43, resizable: false }), [])
  const getRowId = useCallback((p: { data: LabRow }) => p.data.id, [])
  const onSelectionChanged = useCallback((e: SelectionChangedEvent<LabRow>) => setSelected(e.api.getSelectedNodes().map((n) => n.data!.id)), [])
  const onRowClicked = useCallback(
    (e: RowClickedEvent<LabRow>) => {
      if (!e.data || e.node.rowPinned || isInteractiveChild(e.event?.target)) return
      onRowClick(e.data)
    },
    [onRowClick],
  )
  const onCellValueChanged = useCallback((e: CellValueChangedEvent<LabRow>) => {
    // The lab persists nothing — it proves the DIFF, which is the half that can corrupt data.
    // eslint-disable-next-line no-console
    console.log('[grid-lab] edit', JSON.stringify({ id: e.data.id, field: e.colDef.field, from: e.oldValue, to: e.newValue }))
  }, [])
  const initialState = useMemo<GridState>(() => ({ sort: { sortModel: [{ colId: 'spend', sort: 'desc' }] } }), [])
  // Selection is the GRID's (decision 8): clearing means asking the grid, and reading back.
  const clearSelection = useCallback(() => apiRef.current?.deselectAll(), [])

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="nds-ag-selbar">
        <Button variant={editing ? 'primary' : 'secondary'} size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done editing' : 'Edit names'}
        </Button>
        {selected.length > 0 && (
          <Button variant="secondary" size="sm" onClick={clearSelection}>
            Clear {selected.length} selected
          </Button>
        )}
      </div>
      <NexusGrid<LabRow>
        density="cozy"
        height={560}
        rowData={rows}
        getRowId={getRowId}
        columnDefs={columnDefs}
        pinnedBottomRowData={totals}
        rowSelection={rowSelection}
        selectionColumnDef={selectionColumnDef}
        onGridReady={onGridReady}
        onSelectionChanged={onSelectionChanged}
        onRowClicked={onRowClicked}
        onCellValueChanged={onCellValueChanged}
        initialState={initialState}
        rowClass="nds-ag-clickable"
        sideBar={sideBar ? ['columns', 'filters'] : undefined}
        singleClickEdit
      />
    </div>
  )
}

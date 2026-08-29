'use client'

/**
 * The inventory editor's grid — AG Grid, client-side, edited like a spreadsheet.
 *
 * Rows are the products being edited (a family's variations, or one product); columns are the
 * locations, each a group of three: On hand (the number you edit), Reserved (held by open
 * orders), Available (the difference — what the products grid shows). Pending edits live in the
 * modal (`pending`) and sit over the server's numbers through the value getters here; the grid
 * itself holds no stock figure it did not get from one or the other.
 *
 * Editing is AG's own: type into a focused cell or double-click, Enter commits and moves down,
 * Tab moves right, Esc reverts; a cell range with a fill handle; paste from a spreadsheet;
 * undo/redo. Every one of those paths ends in the same `valueSetter`, so a fill, a paste and a
 * keystroke are the same edit — and a locked column refuses all of them in the column
 * definition, not in a renderer.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ColGroupDef, IRowNode, ValueGetterParams, ValueSetterParams } from '@/design-system/grid'

import { Pill } from '@/design-system/primitives'
import { DeltaChip, GridDensityProvider, IdentityCell, NexusGrid, SkuTag, numericColumn, type ColDef, type GridApi, type GridReadyEvent, type ICellRendererParams } from '@/design-system/grid'

import styles from './styles.module.css'
import { gridDensity, gridGeometry } from '@/design-system/tokens/grid'
import type { DensityMode } from './density'
import {
  availableOf, deltaOf, onHandOf, pendingKey, rowSyncStatus, rowTotalAvailable, stockLevelOf, totalsOf,
  type LevelCell, type MatrixModel, type MatrixRow, type PendingEdits,
} from './inventoryEditor.logic'

/** The pinned totals row. Same `cells` shape as a product row so one value getter serves both. */
interface TotalsRow { __total: true; productId: '__total'; sku: string; name: ''; thumbnailUrl: null; lowStockThreshold: number; cells: Record<string, LevelCell>; totalAvailable: number }
type GridRow = MatrixRow | TotalsRow
const isTotals = (d: GridRow | undefined): d is TotalsRow => !!d && (d as TotalsRow).__total === true

// Fits a 962px-tall window (the DS modal is 82vh) with the modal's header, toolbar, hint and footer.
const MAX_GRID_HEIGHT = 480
/** Header height per engine size tier — the engine's own numbers (NexusGrid HEADER_HEIGHT). */
/** The location strip above the header — a band, not a header row (engine CSS, IE.4). */
const STRIP_PX = gridGeometry.stripH
/** Identity column at the Compact thumbnail; wider tiers add the thumbnail's extra width. */
const IDENTITY_BASE_PX = gridGeometry.identityW

/** The columns an operator may hide from the Columns control; `onhand` and the identity never hide. */
export const OPTIONAL_COLUMN_KINDS = ['reserved', 'available', 'totalAvailable', 'sync'] as const
export type OptionalColumnKind = (typeof OPTIONAL_COLUMN_KINDS)[number]
export const OPTIONAL_COLUMN_LABELS: Record<OptionalColumnKind, string> = { reserved: 'Reserved', available: 'Available', totalAvailable: 'Total available', sync: 'Sync state' }

export interface InventoryGridProps {
  model: MatrixModel
  /** The page's density — rows, header and thumbnail follow it, so the editor IS the page's grid. */
  density: DensityMode
  /** Column kinds the operator has hidden (see OPTIONAL_COLUMN_KINDS). */
  hiddenKinds: readonly OptionalColumnKind[]
  pending: PendingEdits
  /** Cells the server refused on the last Apply, with its reason. */
  failed: ReadonlyMap<string, string>
  onEdit: (row: MatrixRow, locationId: string, value: unknown) => void
  onSelectionChanged: (productIds: string[]) => void
  onReady: (api: GridApi<GridRow>) => void
  onHistoryChanged: (h: { undo: number; redo: number }) => void
  quickFilterText: string
  single: boolean
}

/** The page's product cell, SKU first: the same classes the products grid draws its cell with. */
function RowIdentity({ data }: ICellRendererParams<GridRow>) {
  if (!data) return null
  if (isTotals(data)) return <span className={styles.ieTotalsLabel}>{data.sku}</span>
  return <IdentityCell image={data.thumbnailUrl} title={<SkuTag>{data.sku}</SkuTag>} sub={<span className={styles.ieName} title={data.name}>{data.name}</span>} />
}

function SyncCell({ data }: ICellRendererParams<GridRow>) {
  if (!data || isTotals(data)) return null
  const s = rowSyncStatus(data)
  if (!s) return null
  return <Pill tone={s === 'FAILED' ? 'danger' : s === 'PENDING' ? 'warning' : 'success'} size="sm">{s.toLowerCase()}</Pill>
}

export function InventoryGrid({ model, density, hiddenKinds, pending, failed, onEdit, onSelectionChanged, onReady, onHistoryChanged, quickFilterText, single }: InventoryGridProps) {
  // The value getters read these through refs so the column definitions stay STABLE — a new
  // column definition per keystroke would make AG rebuild its columns on every edit. The effect
  // below tells AG to re-read the cells when the pending set changes.
  const pendingRef = useRef(pending); pendingRef.current = pending
  const failedRef = useRef(failed); failedRef.current = failed
  const apiRef = useRef<GridApi<GridRow> | null>(null)

  const totals = useMemo<TotalsRow>(() => {
    const t = totalsOf(model, pending)
    return { __total: true, productId: '__total', sku: single ? 'Total' : 'Family total', name: '', thumbnailUrl: null, lowStockThreshold: 0, cells: t.cells, totalAvailable: t.totalAvailable }
  }, [model, pending, single])

  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.setGridOption('pinnedBottomRowData', [totals])
    api.refreshCells({ force: true })
  }, [pending, failed, totals])

  /** Hidden kinds → column visibility, by colId prefix (`reserved:<loc>`, `totalAvailable`, `sync`). */
  const applyHidden = useCallback((api: GridApi<GridRow>) => {
    const state = api.getColumnState().map((s) => {
      const kind = s.colId.split(':')[0] as OptionalColumnKind
      return OPTIONAL_COLUMN_KINDS.includes(kind) ? { colId: s.colId, hide: hiddenKinds.includes(kind) } : { colId: s.colId }
    })
    api.applyColumnState({ state })
  }, [hiddenKinds])
  useEffect(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed()) applyHidden(api)
  }, [applyHidden])

  const columnDefs = useMemo<(ColDef<GridRow> | ColGroupDef<GridRow>)[]>(() => {
    const identity: ColDef<GridRow> = {
      colId: 'product',
      headerName: single ? 'Product' : 'Variation',
      pinned: 'left',
      lockPosition: 'left',
      lockPinned: true,
      suppressMovable: true,
      // 34-character SKUs are normal in this catalogue; the thumbnail and the mono SKU need 320px
      // at the Compact thumbnail, and the thumbnail's extra width at the wider tiers.
      width: IDENTITY_BASE_PX + (gridDensity[density].thumb - gridDensity.compact.thumb),
      cellRenderer: RowIdentity,
      getQuickFilterText: (p) => `${p.data?.sku ?? ''} ${p.data?.name ?? ''}`,
      cellClass: 'nds-ag-cell',
      sortable: false,
    }
    const groups: ColGroupDef<GridRow>[] = model.columns.map((loc) => {
      const onHand: ColDef<GridRow> = {
        colId: `onhand:${loc.locationId}`,
        headerName: 'On hand',
        width: 88,
        editable: (p) => loc.editable && !p.node.rowPinned,
        cellEditor: 'agNumberCellEditor',
        cellEditorParams: { min: 0, precision: 0, step: 1, showStepperButtons: false },
        valueGetter: (p: ValueGetterParams<GridRow>) => (!p.data ? null : isTotals(p.data) ? (p.data.cells[loc.locationId]?.quantity ?? 0) : onHandOf(p.data, loc.locationId, pendingRef.current)),
        valueSetter: (p: ValueSetterParams<GridRow>) => {
          if (!p.data || isTotals(p.data)) return false
          const n = Number(String(p.newValue ?? '').trim())
          const valid = Number.isFinite(n) && Number.isInteger(n) && n >= 0
          if (valid) onEdit(p.data, loc.locationId, n)
          return valid
        },
        cellRenderer: (p: ICellRendererParams<GridRow>) => {
          if (!p.data) return null
          if (isTotals(p.data)) return <span>{p.value}</span>
          const delta = deltaOf(p.data, loc.locationId, pendingRef.current)
          const err = failedRef.current.get(pendingKey(p.data.productId, loc.locationId))
          return (
            <span className={styles.ieOnHand} title={err ?? undefined}>
              {p.value}
              <DeltaChip delta={delta} />
              {!loc.editable && <span className="nds-cell-lock-glyph" role="img" aria-label="Read-only">🔒</span>}
            </span>
          )
        },
        cellClassRules: {
          'nds-cell-is-pending': (p) => !!p.data && !isTotals(p.data) && deltaOf(p.data, loc.locationId, pendingRef.current) !== 0,
          'nds-cell-is-refused': (p) => !!p.data && !isTotals(p.data) && failedRef.current.has(pendingKey(p.data.productId, loc.locationId)),
          'nds-cell-is-locked': () => !loc.editable,
          'nds-cell-is-editable': (p) => loc.editable && !p.node.rowPinned,
        },
        ...numericColumn,
        sortable: false,
      }
      const reserved: ColDef<GridRow> = {
        colId: `reserved:${loc.locationId}`,
        headerName: 'Reserved',
        width: 84,
        valueGetter: (p) => p.data?.cells[loc.locationId]?.reserved ?? 0,
        cellClass: [...numericColumn.cellClass, 'nds-cell-muted'],
        headerClass: numericColumn.headerClass,
        type: 'rightAligned',
        sortable: false,
      }
      const available: ColDef<GridRow> = {
        colId: `available:${loc.locationId}`,
        headerName: 'Available',
        width: 86,
        valueGetter: (p: ValueGetterParams<GridRow>) => (!p.data ? null : isTotals(p.data) ? (p.data.cells[loc.locationId]?.available ?? 0) : availableOf(p.data, loc.locationId, pendingRef.current)),
        cellClassRules: {
          'nds-cell-stock-out': (p) => !!p.data && !isTotals(p.data) && stockLevelOf(Number(p.value), p.data.lowStockThreshold) === 'out',
          'nds-cell-stock-low': (p) => !!p.data && !isTotals(p.data) && stockLevelOf(Number(p.value), p.data.lowStockThreshold) === 'low',
          'nds-cell-stock-ok': (p) => !!p.data && !isTotals(p.data) && stockLevelOf(Number(p.value), p.data.lowStockThreshold) === 'ok',
        },
        ...numericColumn,
        sortable: false,
      }
      return {
        groupId: loc.locationId,
        headerName: loc.editable ? loc.locationCode : `${loc.locationCode} · locked`,
        headerClass: loc.editable ? undefined : styles.ieGroupLocked,
        marryChildren: true,
        children: [onHand, reserved, available],
      }
    })
    const totalAvailable: ColDef<GridRow> = {
      colId: 'totalAvailable',
      headerName: 'Total avail.',
      width: 96,
      valueGetter: (p: ValueGetterParams<GridRow>) => (!p.data ? null : isTotals(p.data) ? p.data.totalAvailable : rowTotalAvailable(p.data, model.columns, pendingRef.current)),
      cellClass: [...numericColumn.cellClass, 'nds-cell-strong'],
      headerClass: numericColumn.headerClass,
      type: 'rightAligned',
      sortable: false,
    }
    const sync: ColDef<GridRow> = { colId: 'sync', headerName: 'Sync', width: 76, cellRenderer: SyncCell, sortable: false, cellClass: 'nds-ag-cell' }
    return [identity, ...groups, totalAvailable, sync]
    // `onEdit` is stable (the modal memoises it); the columns depend on the locations and density.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.columns, single, density])

  const onGridReady = useCallback((e: GridReadyEvent<GridRow>) => {
    apiRef.current = e.api
    e.api.setGridOption('pinnedBottomRowData', [totals])
    applyHidden(e.api)
    onReady(e.api)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReady, applyHidden])

  const history = useCallback((api: GridApi<GridRow>) => onHistoryChanged({ undo: api.getCurrentUndoSize(), redo: api.getCurrentRedoSize() }), [onHistoryChanged])
  // ONE stable handler for the five edit-history events (GDS decision 12: an inline arrow is a new
  // identity every render, and AG re-runs its column model for each changed option).
  const onHistory = useCallback((e: { api: GridApi<GridRow> }) => history(e.api), [history])

  const rowSelection = useMemo(() => ({
    mode: 'multiRow' as const,
    checkboxes: true,
    headerCheckbox: true,
    enableClickSelection: false,
    isRowSelectable: (n: IRowNode<GridRow>) => !n.rowPinned && !isTotals(n.data),
  }), [])
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false, pinned: 'left' as const }), [])
  const cellSelection = useMemo(() => ({ handle: { mode: 'fill' as const } }), [])
  // No header menus or sorting in the editor — the columns are the locations, fixed. Resizing
  // stays on (it is harmless), and the header partitions are the THEME's, never a per-grid option.
  const defaultColDef = useMemo<ColDef<GridRow>>(() => ({ suppressHeaderMenuButton: true, sortable: false }), [])
  const getRowId = useCallback((p: { data: GridRow }) => p.data.productId, [])
  const onSel = useCallback((e: { api: GridApi<GridRow> }) => onSelectionChanged(e.api.getSelectedNodes().map((n) => n.data!.productId).filter((id) => id !== '__total')), [onSelectionChanged])

  const rowPx = gridDensity[density].rowMedia
  // The location strip, the header, the rows, and a totals row the height of the header — the
  // page's header is shorter than its rows, and the totals row reads as a footer, not a row.
  // The totals row is the HEADER's height (IE.4), never a data row's.
  const totalsPx = gridDensity[density].header
  const height = Math.min(MAX_GRID_HEIGHT, STRIP_PX + totalsPx + model.rows.length * rowPx + totalsPx + 2)

  return (
    <GridDensityProvider value={density}>
      <NexusGrid<GridRow>
        height={height}
        density={density}
        rows="media"
        groupHeaderHeight={STRIP_PX}
        rowData={model.rows}
        getRowId={getRowId}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        quickFilterText={quickFilterText}
        // Spreadsheet behaviour: a focused cell takes keystrokes, Enter walks down the column.
        suppressCellFocus={false}
        enterNavigatesVertically
        enterNavigatesVerticallyAfterEdit
        stopEditingWhenCellsLoseFocus
        undoRedoCellEditing
        undoRedoCellEditingLimit={100}
        cellSelection={cellSelection}
        rowSelection={rowSelection}
        selectionColumnDef={selectionColumnDef}
        onSelectionChanged={onSel}
        // After Apply the model reloads and the rows are replaced; the selection the modal shows
        // must be what the grid holds now, not what it held before.
        onRowDataUpdated={onSel}
        onGridReady={onGridReady}
        onCellValueChanged={onHistory}
        onUndoEnded={onHistory}
        onRedoEnded={onHistory}
        onPasteEnd={onHistory}
        onFillEnd={onHistory}
      />
    </GridDensityProvider>
  )
}

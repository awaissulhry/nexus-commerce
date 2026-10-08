'use client'

/**
 * The inventory editor's grid — AG Grid, client-side, edited like a spreadsheet.
 *
 * Rows are the products being edited (a family's variations, or one product); columns are the
 * locations, each a group of three: On hand (the number you edit), Reserved (held by open
 * orders), Available (the difference — what the products grid shows). A warehouse adds Cases
 * right after On hand when some row has a case size: sealed cases + loose units ("4 + 3"), the
 * sealed count edited like On hand (Tab walks On hand → Cases). Several case sizes in the family
 * (Owner 2026-10-08) give one column per size, biggest first ("12 / case", "6 / case"); a row's
 * loose units sit in its smallest own size column. Pending edits live in the
 * modal (`pending`) and sit over the server's numbers through the value getters here; the grid
 * itself holds no stock figure it did not get from one or the other.
 *
 * Editing is AG's own: type into a focused cell or double-click, Enter commits and moves down,
 * Tab moves right, Esc reverts; a cell range with a fill handle; paste from a spreadsheet;
 * undo/redo. Every one of those paths ends in the same `valueSetter`, so a fill, a paste and a
 * keystroke are the same edit — and a locked column refuses all of them in the column
 * definition, not in a renderer.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ColGroupDef, IRowNode, ValueGetterParams, ValueSetterParams } from '@/design-system/grid'

import { Pill } from '@/design-system/primitives'
import { DeltaChip, GridDensityProvider, IdentityCell, LockGlyph, NexusGrid, SkuTag, composeCellTooltip, numericColumn, type ColDef, type GridApi, type GridReadyEvent, type ICellRendererParams } from '@/design-system/grid'
import { CASE_COPY, type CaseCount } from '@nexus/shared/stock-cases'

import styles from './styles.module.css'
import { gridDensity, gridGeometry } from '@/design-system/tokens/grid'
import type { DensityMode } from './density'
import {
  availableOf, casesFailKey, casesOf, CASES_EDITOR_COPY, countsCases, deltaOf, familyCaseSizes, hasCaseColumns, onHandOf, pendingKey, rowSyncStatus,
  rowTotalAvailable, stockLevelOf, totalsOf,
  type LevelCell, type MatrixModel, type MatrixRow, type PendingCases, type PendingEdits,
} from './inventoryEditor.logic'

/** The pinned totals row. Same `cells` shape as a product row so one value getter serves both. */
interface TotalsRow {
  __total: true; productId: '__total'; sku: string; name: ''; thumbnailUrl: null; lowStockThreshold: number; caseSizes: number[]
  cells: Record<string, LevelCell>; totalAvailable: number
  /** Σ sealed per size + Σ loose per warehouse ("12 + 9"). */
  cases: Record<string, { sealed: CaseCount[]; loose: number } | null>
}
type GridRow = MatrixRow | TotalsRow
const isTotals = (d: GridRow | undefined): d is TotalsRow => !!d && (d as TotalsRow).__total === true

// Fits a 962px-tall window (the DS modal is 82vh) with the modal's header, toolbar, hint and footer.
const MAX_GRID_HEIGHT = 480
/** Header height per engine size tier — the engine's own numbers (NexusGrid HEADER_HEIGHT). */
/** The location strip above the header — a band, not a header row (engine CSS, IE.4). */
const STRIP_PX = gridGeometry.stripH
/** Identity column at the Compact thumbnail; wider tiers add the thumbnail's extra width. */
const IDENTITY_BASE_PX = gridGeometry.identityW
/**
 * A phone — the Matrix's rule (`identityWidthFor` in the Matrix columns): at 390px the grid is ~310px wide and the
 * 320px PINNED identity covered all of it, so no number was ever on screen. The pinned band gives way on a narrow
 * grid, leaving at least 160px for the location columns to scroll in, and never goes under 160px (the SKU truncates).
 * A wide grid keeps its full width.
 */
const IDENTITY_MIN_PX = 160
const IDENTITY_MIN_SCROLL_PX = 160
export function identityWidthFor(room: number, full: number): number {
  if (!Number.isFinite(room) || room <= 0) return full
  return Math.max(IDENTITY_MIN_PX, Math.min(full, Math.floor(room - IDENTITY_MIN_SCROLL_PX)))
}

/** The columns an operator may hide from the Columns control; `onhand` and the identity never hide. */
export const OPTIONAL_COLUMN_KINDS = ['cases', 'reserved', 'available', 'totalAvailable', 'sync'] as const
export type OptionalColumnKind = (typeof OPTIONAL_COLUMN_KINDS)[number]
export const OPTIONAL_COLUMN_LABELS: Record<OptionalColumnKind, string> = { cases: 'Cases', reserved: 'Reserved', available: 'Available', totalAvailable: 'Total available', sync: 'Sync state' }
/** The kinds this model has: Cases only when some row has a case size at a warehouse. */
export const optionalKindsOf = (model: MatrixModel): OptionalColumnKind[] =>
  OPTIONAL_COLUMN_KINDS.filter((k) => k !== 'cases' || hasCaseColumns(model))

export interface InventoryGridProps {
  model: MatrixModel
  /** The page's density — rows, header and thumbnail follow it, so the editor IS the page's grid. */
  density: DensityMode
  /** Column kinds the operator has hidden (see OPTIONAL_COLUMN_KINDS). */
  hiddenKinds: readonly OptionalColumnKind[]
  pending: PendingEdits
  /** Typed sealed counts (Cases), keyed by `casesKey` (product, location, case size). */
  pendingCases: PendingCases
  /** Cells the server refused on the last Apply, with its reason: On hand by `pendingKey`, Cases by `casesFailKey`. */
  failed: ReadonlyMap<string, string>
  /** `unitsPerCase` = the Cases column's case size (kind 'cases'). */
  onEdit: (row: MatrixRow, locationId: string, value: unknown, kind: 'onhand' | 'cases', unitsPerCase?: number) => void
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

export function InventoryGrid({ model, density, hiddenKinds, pending, pendingCases, failed, onEdit, onSelectionChanged, onReady, onHistoryChanged, quickFilterText, single }: InventoryGridProps) {
  // The value getters read these through refs so the column definitions stay STABLE — a new
  // column definition per keystroke would make AG rebuild its columns on every edit. The effect
  // below tells AG to re-read the cells when the pending set changes.
  const pendingRef = useRef(pending); pendingRef.current = pending
  const pendingCasesRef = useRef(pendingCases); pendingCasesRef.current = pendingCases
  const failedRef = useRef(failed); failedRef.current = failed
  const apiRef = useRef<GridApi<GridRow> | null>(null)
  const withCases = hasCaseColumns(model)
  // The identity's full width at this density (the thumbnail's extra width at the wider tiers), then the phone rule.
  const identityFull = IDENTITY_BASE_PX + (gridDensity[density].thumb - gridDensity.compact.thumb)
  const [identityRoom, setIdentityRoom] = useState(0)
  const identityW = identityWidthFor(identityRoom, identityFull)
  const onGridSizeChanged = useCallback((e: { clientWidth: number; api: GridApi<GridRow> }) => {
    const otherPinned = e.api.getDisplayedLeftColumns().filter((c) => c.getColId() !== 'product').reduce((n, c) => n + c.getActualWidth(), 0)
    setIdentityRoom(e.clientWidth - otherPinned)
  }, [])
  const caseSizes = familyCaseSizes(model)
  const caseSizesKey = caseSizes.join(',')

  const totals = useMemo<TotalsRow>(() => {
    const t = totalsOf(model, pending, pendingCases)
    return { __total: true, productId: '__total', sku: single ? 'Total' : 'Family total', name: '', thumbnailUrl: null, lowStockThreshold: 0, caseSizes: [], cells: t.cells, totalAvailable: t.totalAvailable, cases: t.cases }
  }, [model, pending, pendingCases, single])

  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.setGridOption('pinnedBottomRowData', [totals])
    api.refreshCells({ force: true })
  }, [pending, pendingCases, failed, totals])

  /** Hidden kinds → column visibility, by colId prefix (`cases:<loc>:<size>`, `reserved:<loc>`, `totalAvailable`, `sync`). */
  const applyHidden = useCallback((api: GridApi<GridRow>) => {
    const state = api.getColumnState().map((s) => {
      const kind = s.colId.split(':')[0] as OptionalColumnKind
      return OPTIONAL_COLUMN_KINDS.includes(kind) ? { colId: s.colId, hide: hiddenKinds.includes(kind) } : { colId: s.colId }
    })
    api.applyColumnState({ state })
  }, [hiddenKinds])

  const columnDefs = useMemo<(ColDef<GridRow> | ColGroupDef<GridRow>)[]>(() => {
    const identity: ColDef<GridRow> = {
      colId: 'product',
      headerName: single ? 'Product' : 'Variation',
      pinned: 'left',
      lockPosition: 'left',
      lockPinned: true,
      suppressMovable: true,
      // 34-character SKUs are normal in this catalogue; the thumbnail and the mono SKU need 320px
      // at the Compact thumbnail, and the thumbnail's extra width at the wider tiers (less on a phone).
      width: identityW,
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
          if (valid) onEdit(p.data, loc.locationId, n, 'onhand')
          return valid
        },
        cellRenderer: (p: ICellRendererParams<GridRow>) => {
          if (!p.data) return null
          if (isTotals(p.data)) return <span>{p.value}</span>
          const delta = deltaOf(p.data, loc.locationId, pendingRef.current)
          return (
            <span className={styles.ieOnHand}>
              {p.value}
              <DeltaChip delta={delta} />
              {!loc.editable && <LockGlyph />}
            </span>
          )
        },
        // The refusal reason in the grid's one tooltip (never a native `title` on the renderer).
        tooltipValueGetter: (p) =>
          !p.data || isTotals(p.data) ? undefined : failedRef.current.get(pendingKey(p.data.productId, loc.locationId)),
        cellClassRules: {
          'nds-cell-is-pending': (p) => !!p.data && !isTotals(p.data) && deltaOf(p.data, loc.locationId, pendingRef.current) !== 0,
          'nds-cell-is-refused': (p) => !!p.data && !isTotals(p.data) && failedRef.current.has(pendingKey(p.data.productId, loc.locationId)),
          'nds-cell-is-locked': () => !loc.editable,
          'nds-cell-is-editable': (p) => loc.editable && !p.node.rowPinned,
        },
        ...numericColumn,
        sortable: false,
      }
      // Cases — a warehouse only (FBA and Shopify stay units). One column per case size of the family, biggest first:
      // the sealed count of that size, editable where the row has the size; the row's loose units after its smallest.
      const lastSize = caseSizes[caseSizes.length - 1]
      const cases: ColDef<GridRow>[] = withCases && countsCases(loc) ? caseSizes.map((units): ColDef<GridRow> => {
        const view = (row: MatrixRow) => casesOf(row, loc.locationId, units, pendingRef.current, pendingCasesRef.current)
        const has = (d: GridRow | undefined): d is MatrixRow => !!d && !isTotals(d) && d.caseSizes.includes(units)
        return {
          colId: `cases:${loc.locationId}:${units}`,
          headerName: CASES_EDITOR_COPY.header(caseSizes, units),
          headerTooltip: CASES_EDITOR_COPY.headerTooltip(caseSizes),
          width: caseSizes.length > 1 ? 88 : 92,
          editable: (p) => !p.node.rowPinned && has(p.data),
          cellEditor: 'agNumberCellEditor',
          cellEditorParams: { min: 0, precision: 0, step: 1, showStepperButtons: false },
          valueGetter: (p: ValueGetterParams<GridRow>) => {
            if (!p.data) return null
            if (isTotals(p.data)) return p.data.cases[loc.locationId]?.sealed.find((c) => c.unitsPerCase === units)?.cases ?? null
            return has(p.data) ? view(p.data).sealed : null
          },
          valueSetter: (p: ValueSetterParams<GridRow>) => {
            if (!has(p.data)) return false
            const n = Number(String(p.newValue ?? '').trim())
            const valid = Number.isFinite(n) && Number.isInteger(n) && n >= 0
            if (valid) onEdit(p.data, loc.locationId, n, 'cases', units)
            return valid
          },
          cellRenderer: (p: ICellRendererParams<GridRow>) => {
            if (!p.data) return null
            if (isTotals(p.data)) {
              const t = p.data.cases[loc.locationId]
              const sealed = t?.sealed.find((c) => c.unitsPerCase === units)?.cases
              if (!t || sealed === undefined) return null
              return <span className={styles.ieOnHand}>{sealed}{units === lastSize && <span className={styles.ieLoose}>+ {t.loose}</span>}</span>
            }
            if (!has(p.data)) return <span className={styles.ieOnHand}>—</span>
            const v = view(p.data)
            return (
              <span className={styles.ieOnHand}>
                {v.sealed}
                {v.loose !== null && <span className={styles.ieLoose}>+ {v.loose}</span>}
                <DeltaChip delta={v.delta} />
              </span>
            )
          },
          // One tooltip: the refusal first, then a case the pending On hand opens, then the case size (and the loose units).
          tooltipValueGetter: (p) => {
            if (!p.data || isTotals(p.data)) return undefined
            if (!p.data.caseSizes.includes(units)) return p.data.caseSizes.length ? CASE_COPY.noSizeOf(units) : CASE_COPY.noSize
            const v = view(p.data)
            const refused = v.typed ? failedRef.current.get(casesFailKey(p.data.productId, loc.locationId)) : undefined
            const size = v.loose !== null && caseSizes.length > 1 ? `${CASE_COPY.perCase(units)} · ${CASES_EDITOR_COPY.loose(v.loose)}` : CASE_COPY.perCase(units)
            return composeCellTooltip(refused ?? v.problem, v.opens > 0 ? CASES_EDITOR_COPY.opens(v.opens) : null, size)
          },
          cellClassRules: {
            'nds-cell-is-pending': (p) => has(p.data) && view(p.data).typed,
            'nds-cell-is-refused': (p) => {
              if (!has(p.data)) return false
              const v = view(p.data)
              return v.typed && (failedRef.current.has(casesFailKey(p.data.productId, loc.locationId)) || v.problem !== null)
            },
            'nds-cell-is-locked': (p) => !!p.data && !isTotals(p.data) && !p.data.caseSizes.includes(units),
            'nds-cell-is-editable': (p) => !p.node.rowPinned && has(p.data),
          },
          ...numericColumn,
          sortable: false,
        }
      }) : []
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
        children: [onHand, ...cases, reserved, available],
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
    // `onEdit` is stable (the modal memoises it); the columns depend on the locations, density and case sizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.columns, single, density, withCases, caseSizesKey, identityW])
  // After the columns are (re)built — a child's effect, so AG already holds them — hide what the operator hid.
  useEffect(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed()) applyHidden(api)
  }, [applyHidden, columnDefs])

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

  // Esc in a cell editor reverts that cell (AG) — it must not ALSO close the dialog. The DS Modal listens on the
  // document and skips a key already handled, so mark it handled when it arrived while a cell was being edited
  // (read in the capture phase: by the bubble phase AG has already stopped editing). Esc on a cell that is not
  // being edited still closes the dialog (or asks to discard).
  const editingAtEsc = useRef(false)
  const onKeyDownCapture = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') editingAtEsc.current = (apiRef.current?.getEditingCells().length ?? 0) > 0
  }, [])
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && editingAtEsc.current) e.preventDefault()
    editingAtEsc.current = false
  }, [])

  const rowPx = gridDensity[density].rowMedia
  // The location strip, the header, the rows, and a totals row the height of the header — the
  // page's header is shorter than its rows, and the totals row reads as a footer, not a row.
  // The totals row is the HEADER's height (IE.4), never a data row's.
  const totalsPx = gridDensity[density].header
  const height = Math.min(MAX_GRID_HEIGHT, STRIP_PX + totalsPx + model.rows.length * rowPx + totalsPx + 2)

  return (
    <GridDensityProvider value={density}>
      <div className={styles.ieGridKeys} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}>
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
          // A refused cell's reason and the Cases words are tooltips: shown at the sheet's pace, not AG's 2 s.
          tooltipShowDelay={300}
          cellSelection={cellSelection}
          rowSelection={rowSelection}
          selectionColumnDef={selectionColumnDef}
          onSelectionChanged={onSel}
          // After Apply the model reloads and the rows are replaced; the selection the modal shows
          // must be what the grid holds now, not what it held before.
          onRowDataUpdated={onSel}
          onGridReady={onGridReady}
          onGridSizeChanged={onGridSizeChanged}
          onCellValueChanged={onHistory}
          onUndoEnded={onHistory}
          onRedoEnded={onHistory}
          onPasteEnd={onHistory}
          onFillEnd={onHistory}
        />
      </div>
    </GridDensityProvider>
  )
}

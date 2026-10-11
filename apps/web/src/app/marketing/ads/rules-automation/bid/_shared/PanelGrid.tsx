'use client'

/**
 * Bid page, the small tables inside a rule's detail (History, Preview, Runs, the Brain's campaigns, Clashes, Waiting) —
 * the DS `NexusGrid plain` (polish round 2, S11): no header menus, the columns fill the width, the grid is as tall as
 * its rows (no empty band under a short table; the detail scrolls).
 *
 * A column is a label and a `render(row)`; the tables build their columns inline on every render (they close over the
 * detail's state), so the cells read the latest `render` through the grid's context and the grid refreshes its cells
 * after each render — AG's column model is rebuilt only when the column set itself changes.
 *
 * Height: exactly its header and rows (measured after AG sizes the rows), so a table of one or two rows has no empty band
 * (an auto-height AG body keeps 150 px for its overlay).
 *
 * Keyboard: the DS grid keeps cell focus off, so Tab walks the links and buttons inside the cells in reading order, and a
 * control inside a cell keeps its own keys (`rendererOwnsKeyboard`). A tick column (Waiting) is AG's own checkbox,
 * kept in step with the caller's `selected` set.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  NexusGrid, gridSelection, numericColumn, rendererOwnsKeyboard,
  type ColDef, type GridApi, type GridReadyEvent, type ICellRendererParams, type NexusGridProps,
} from '@/design-system/grid'
import styles from '../bid.module.css'

export interface PanelColumn<T> {
  key: string
  label: string
  render(row: T): ReactNode
  /** A number column: right-aligned. */
  numeric?: boolean
  /** Fixed width (px); otherwise the column shares the width by its weight (`flex`, default 1). */
  width?: number
  flex?: number
  minWidth?: number
}

export interface PanelSelection {
  selected: ReadonlySet<string>
  onChange(next: Set<string>): void
}

interface Holder<T> { current: { columns: Map<string, PanelColumn<T>> } }

/** The one cell renderer: the column's latest `render`, read at call time. */
function PanelCell<T>(p: ICellRendererParams<T> & { colKey: string }) {
  const col = (p.context as Holder<T> | undefined)?.current.columns.get(p.colKey)
  if (!col || p.data == null) return null
  return <span className={col.numeric ? `${styles.panelCell} ${styles.panelNum}` : styles.panelCell}>{col.render(p.data)}</span>
}

/** The grid's own border, top and bottom. */
const FRAME = 2

const DEFAULT_COL: ColDef = { sortable: false, suppressKeyboardEvent: rendererOwnsKeyboard, wrapText: true, autoHeight: true }

export function PanelGrid<T>({ ariaLabel, columns, rows, rowId, selection }: {
  ariaLabel: string
  columns: ReadonlyArray<PanelColumn<T>>
  rows: ReadonlyArray<T>
  rowId(row: T): string
  /** Ticks per row (and tick-all), kept in step with this set. */
  selection?: PanelSelection
}) {
  const holder = useRef<Holder<T>['current']>({ columns: new Map() })
  holder.current.columns = new Map(columns.map((c) => [c.key, c]))
  const context = useMemo<Holder<T>>(() => ({ current: holder.current }), [])

  const signature = columns.map((c) => `${c.key}|${c.label}|${c.numeric ? 1 : 0}|${c.width ?? ''}|${c.flex ?? ''}|${c.minWidth ?? ''}`).join('·')
  const columnDefs = useMemo<Array<ColDef<T>>>(
    () => columns.map((c) => ({
      colId: c.key,
      headerName: c.label,
      cellRenderer: PanelCell,
      cellRendererParams: { colKey: c.key },
      // The DS plain grid fits the columns to its width (AG's fitGridWidth, which takes widths, not `flex`): a fixed column
      // keeps its width, the others share the rest by their weight.
      ...(c.width ? { width: c.width, minWidth: c.minWidth ?? c.width, suppressSizeToFit: true } : { width: 160 * (c.flex ?? 1), minWidth: c.minWidth ?? 90 }),
      ...(c.numeric ? numericColumn : {}),
    })),
    [signature], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const apiRef = useRef<GridApi<T> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  /** Header + rows, as AG drew them (rows grow with two-line cells). */
  const measure = useCallback(() => {
    const api = apiRef.current
    const wrap = wrapRef.current
    if (!api || api.isDestroyed() || !wrap) return
    let rowsH = 0
    api.forEachNode((n) => { rowsH += n.rowHeight ?? 0 })
    const head = wrap.querySelector<HTMLElement>('.ag-header')?.offsetHeight ?? 0
    const next = Math.ceil(head + rowsH + FRAME)
    setHeight((h) => (h === next ? h : next))
  }, [])
  const rowData = useMemo(() => [...rows], [rows])
  const getRowId = useCallback<NonNullable<NexusGridProps<T>['getRowId']>>((p) => rowId(p.data), [rowId])

  // The cells read `render` through the context: refresh them after every render so they show the detail's latest state.
  useEffect(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed()) api.refreshCells({ force: true, suppressFlash: true })
  })

  // Ticks: the caller's set is the truth; AG's checkboxes follow it, and a click reports back.
  const syncing = useRef(false)
  const applySelection = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed() || !selection) return
    syncing.current = true
    api.forEachNode((n) => { if (n.id != null && n.isSelected() !== selection.selected.has(n.id)) n.setSelected(selection.selected.has(n.id)) })
    syncing.current = false
  }, [selection])
  useEffect(() => { applySelection() }, [applySelection, rowData])

  const onGridReady = useCallback((e: GridReadyEvent<T>) => { apiRef.current = e.api; applySelection(); measure() }, [applySelection, measure])
  const onRendered = useCallback(() => { applySelection(); measure() }, [applySelection, measure])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<T>['onSelectionChanged']>>((e) => {
    if (syncing.current || !selection || e.source === 'api') return
    selection.onChange(new Set(e.api.getSelectedNodes().map((n) => n.id).filter((id): id is string => id != null)))
  }, [selection])
  const rowSelection = useMemo(() => (selection ? gridSelection<T>({ selectAll: 'all' }) : undefined), [selection != null]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapRef} className={styles.panelGrid} role="group" aria-label={ariaLabel}>
      <NexusGrid<T>
        plain
        domLayout="normal"
        height={height ?? FRAME + 47 + rowData.length * 49}
        rowData={rowData}
        columnDefs={columnDefs}
        getRowId={getRowId}
        context={context}
        defaultColDef={DEFAULT_COL as ColDef<T>}
        rowSelection={rowSelection}
        onGridReady={onGridReady}
        onFirstDataRendered={onRendered}
        onModelUpdated={measure}
        onGridSizeChanged={measure}
        onSelectionChanged={selection ? onSelectionChanged : undefined}
        enableCellTextSelection
        suppressRowHoverHighlight
      />
    </div>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  GridCard,
  GridFooterSpacer,
  GridFooterStrip,
  GridSearchSlot,
  GridSelectionActions,
  GridToolbar,
  gridGeometry,
  LoadedRowsSelectionHeader,
  NexusGrid,
  SelectionLabel,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type GridRowKind,
  type IRowNode,
} from '@nexus/ui/grid'
import { X } from 'lucide-react'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useT } from '../lib/i18n/provider'
import { WithMessages } from '../record-panels/i18n'
import { ListKeysInfo } from './ListKeysInfo'
import { gridLayout, isListKey, listKeys, nextRowIndex, ownsKeys, sameIds, toggleId, type ListKey } from './model'
import './list-frame.css'

/** AG's own selection column (the row checkboxes and the header's select-all). */
const SELECTION_COLUMN = 'ag-Grid-SelectionColumn'

export interface ListFrameSelection {
  /** The selected rows' ids (the page owns them: the bulk actions read them). */
  selected: readonly string[]
  onChange: (ids: string[]) => void
  /**
   * The bulk actions, shown in the toolbar in place of the search while rows are selected (they say their reach). Each
   * button carries an icon and its words in the DS `SelectionLabel`: on a narrow card the DS hides the words first.
   */
  actions: ReactNode
}

export interface ListFrameProps<T> {
  /** The table's name for assistive technology ("Customers"). */
  label: string
  /** The loaded rows; null while the first read runs. */
  rows: readonly T[] | null
  rowId: (row: T) => string
  columns: ColDef<T>[]
  /** The toolbar's count while nothing is selected ("11 of 132"). */
  count: ReactNode
  /** The search field (left of the toolbar while nothing is selected); `/` focuses it. */
  search?: ReactNode
  /** Beside the search: the saved views and filter menus. */
  tools?: ReactNode
  /** The toolbar's right end (the list's ⋯). */
  right?: ReactNode
  /** Multi-select with bulk actions; absent: a read-only list without checkboxes. */
  selection?: ListFrameSelection
  /**
   * A row that may not be selected: the reason in words (shown on its disabled box), or null when it may. The header box
   * and x skip such rows.
   */
  isRowSelectable?: (row: T) => string | null
  /** Live changes waiting behind "N updates · Show" (rows never move under the cursor). */
  updates?: { count: number; onShow: () => void } | null
  /** The footer's "Show N more" (pages of 50 read with a cursor). */
  more?: { label: string; onMore: () => void; held?: string | null } | null
  /** The list's own keys (`c` new …); the frame adds its own after them. */
  keys?: readonly ListKey[]
  /** `?` and the keys panel's "All shortcuts". */
  onHelp?: () => void
  /** Enter on a row (and the list's own main-cell link): open its record. */
  onOpen?: (row: T) => void
  /** Drawn in place of the grid (a failed read, nothing yet, nothing matching); the toolbar stays. */
  state?: ReactNode
  rowKind?: GridRowKind
  /** Design cases: the row that has the focus, the keys panel open. */
  focusRow?: number
  keysOpen?: boolean
}

/**
 * The ONE list frame of the Office (Owner rule 2026-10-29; design 00 §2.1): the DS grid (NexusGrid in a GridCard), a
 * toolbar that shows the count, the search and the list's menus — and, while rows are selected, the bulk actions in
 * their place (GridToolbar ⇄ GridSelectionActions, as Commerce's grids do) — a select-all checkbox in the header (the
 * DS LoadedRowsSelectionHeader: mixed while some loaded rows are selected), shift-click for a range, and a footer with
 * "Show N more" and the information icon that holds the keys (never key hints above the table). Keys: `/` search,
 * j / k (and the arrows) between rows, Enter opens, x selects the focused row, Space too, `?` the full list.
 * The page owns the rows and the selection; the frame draws them and reports what the person did.
 */
export function ListFrame<T>(props: ListFrameProps<T>) {
  return (
    <WithMessages namespaces={['lists']}>
      <Frame {...props} />
    </WithMessages>
  )
}

function Frame<T>({ label, rows, rowId, columns, count, search, tools, right, selection, isRowSelectable, updates, more, keys, onHelp, onOpen, state, rowKind = 'two-line', focusRow, keysOpen }: ListFrameProps<T>) {
  const t = useT('lists')
  const frameRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<GridApi<T> | null>(null)
  const [ready, setReady] = useState(false)
  const selected = useMemo(() => selection?.selected ?? [], [selection?.selected])
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const onChangeRef = useRef(selection?.onChange)
  onChangeRef.current = selection?.onChange

  // The page's selection → the grid's ticks (only the rows that differ; the grid's own event then matches and is ignored).
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed() || !selection) return
    const want = new Set(selected)
    const on: IRowNode<T>[] = []
    const off: IRowNode<T>[] = []
    api.forEachNode((node) => {
      if (!node.data) return
      const should = want.has(rowId(node.data))
      if (should !== node.isSelected()) (should ? on : off).push(node)
    })
    if (on.length) api.setNodesSelected({ nodes: on, newValue: true })
    if (off.length) api.setNodesSelected({ nodes: off, newValue: false })
  }, [selected, rows, ready, rowId, selection])

  // The grid's ticks (a box, shift-click range, the header, Space) → the page.
  const onSelectionChanged = useCallback(
    (event: { api: GridApi<T> }) => {
      const ids = event.api.getSelectedNodes().flatMap((node) => (node.data ? [rowId(node.data)] : []))
      if (!sameIds(ids, selectedRef.current)) onChangeRef.current?.(ids)
    },
    [rowId],
  )

  const onGridReady = useCallback((event: GridReadyEvent<T>) => {
    apiRef.current = event.api
    setReady(true)
  }, [])

  const firstColumn = useCallback((api: GridApi<T>) => api.getAllDisplayedColumns().find((column) => column.getColId() !== SELECTION_COLUMN) ?? null, [])
  const focusRowAt = useCallback(
    (index: number) => {
      const api = apiRef.current
      if (!api || api.isDestroyed()) return
      const column = api.getFocusedCell()?.column ?? firstColumn(api)
      if (!column) return
      api.ensureIndexVisible(index)
      api.setFocusedCell(index, column)
    },
    [firstColumn],
  )

  // A design case's focused row.
  useEffect(() => {
    if (ready && focusRow !== undefined && rows && rows.length > focusRow) focusRowAt(focusRow)
  }, [ready, focusRow, rows, focusRowAt])

  // The list's keys, while the focus is on the page (not typing, not in a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isListKey(event, event.target as HTMLElement | null)) return
      // Two frames on one page: only the one with the focus (else the first) answers the keys.
      const frames = Array.from(document.querySelectorAll('.fw-list'))
      const own = frameRef.current ? frames.indexOf(frameRef.current) : -1
      const holding = frames.findIndex((frame) => frame.contains(document.activeElement))
      if (own < 0 || !ownsKeys(own, holding < 0 ? null : holding)) return
      const api = apiRef.current
      const count = api && !api.isDestroyed() ? api.getDisplayedRowCount() : 0
      const focused = api && !api.isDestroyed() ? (api.getFocusedCell()?.rowIndex ?? null) : null
      if (event.key === '/') {
        const field = frameRef.current?.querySelector<HTMLInputElement>('.nds-toolbar input[type="search"], .nds-toolbar input')
        if (!field) return
        event.preventDefault()
        field.focus()
      } else if (event.key === '?' && onHelp) {
        event.preventDefault()
        onHelp()
      } else if ((event.key === 'j' || event.key === 'k') && count > 0) {
        event.preventDefault()
        const next = nextRowIndex(focused, event.key === 'j' ? 1 : -1, count)
        if (next !== null) focusRowAt(next)
      } else if (event.key === 'x' && selection && api && focused !== null) {
        const node = api.getDisplayedRowAtIndex(focused)
        if (!node?.data || (isRowSelectable && isRowSelectable(node.data) !== null)) return
        event.preventDefault()
        selection.onChange(toggleId(selectedRef.current, rowId(node.data)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusRowAt, isRowSelectable, onHelp, rowId, selection])

  // Enter on a row opens it (not on its checkbox: Space ticks there).
  const onCellKeyDown = useCallback(
    (event: { data?: T; event?: Event | null; column?: { getColId(): string } }) => {
      const key = (event.event as KeyboardEvent | null | undefined)?.key
      if (key === 'Enter' && event.data && event.column?.getColId() !== SELECTION_COLUMN) onOpen?.(event.data)
    },
    [onOpen],
  )

  const getRowId = useCallback((params: { data: T }) => rowId(params.data), [rowId])
  const rowSelection = useMemo(
    () =>
      selection
        ? ({
            mode: 'multiRow',
            checkboxes: true,
            headerCheckbox: false,
            enableClickSelection: false,
            ...(isRowSelectable ? { isRowSelectable: (node: IRowNode<T>) => !node.data || isRowSelectable(node.data) === null } : {}),
          } as const)
        : undefined,
    [selection, isRowSelectable],
  )
  const selectionColumnDef = useMemo(
    () => ({
      width: gridGeometry.selectColW,
      maxWidth: gridGeometry.selectColW,
      resizable: false,
      headerComponent: LoadedRowsSelectionHeader,
      headerName: t('selectAll'),
      // A row that may not be selected says why on its disabled box.
      ...(isRowSelectable ? { tooltipValueGetter: (params: { data?: T }) => (params.data ? isRowSelectable(params.data) : null) } : {}),
    }),
    [t, isRowSelectable],
  )

  const picked = selection ? selected.length : 0
  // Straight into the card (no wrapper): the DS toolbar's wrap rules match only `.nds-grid-card > .nds-toolbar`, so a
  // phone's card takes a second line instead of pushing tools past its clipped edge.
  const toolbar = (
    <GridToolbar
      wrap
      count={picked > 0 ? t('selected', { count: picked }) : count}
      right={
        <>
          {updates && updates.count > 0 && (
            <Button size="sm" variant="tonal" onClick={updates.onShow}>
              {t('updates', { count: updates.count })}
            </Button>
          )}
          {right}
        </>
      }
    >
      {picked > 0 && selection ? (
        <GridSelectionActions>
          {selection.actions}
          <Button size="sm" variant="link" onClick={() => selection.onChange([])} aria-label={t('clear')}>
            <X size={13} aria-hidden /> <SelectionLabel>{t('clear')}</SelectionLabel>
          </Button>
        </GridSelectionActions>
      ) : (
        <>
          {search && <GridSearchSlot>{search}</GridSearchSlot>}
          {tools}
        </>
      )}
    </GridToolbar>
  )
  const footer = (
    <GridFooterStrip>
      {more && (
        <Button size="sm" onClick={more.onMore} heldReason={more.held ?? null}>
          {more.label}
        </Button>
      )}
      <GridFooterSpacer />
      <ListKeysInfo keys={listKeys(keys, !!selection)} onHelp={onHelp} open={keysOpen} />
    </GridFooterStrip>
  )

  let body: ReactNode
  if (state) body = <div className="fw-list-state">{state}</div>
  else if (rows === null)
    body = (
      <div className="fw-list-state" aria-busy="true">
        <p className="fw-list-loading" role="status">
          <Spinner size={14} /> {t('loading')}
        </p>
        <div className="fw-list-skeleton">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </div>
    )
  else {
    const layout = gridLayout(rows.length)
    body = (
      <div className={layout.fit ? 'fw-list-grid fit' : 'fw-list-grid'} role="region" aria-label={label}>
        <NexusGrid<T>
          domLayout={layout.domLayout}
          rows={rowKind}
          rowData={rows as T[]}
          columnDefs={columns}
          getRowId={getRowId}
          onGridReady={onGridReady}
          rowSelection={rowSelection}
          selectionColumnDef={selection ? selectionColumnDef : undefined}
          onSelectionChanged={onSelectionChanged}
          onCellKeyDown={onCellKeyDown}
          suppressCellFocus={false}
        />
      </div>
    )
  }

  return (
    <div className="fw-list" ref={frameRef}>
      <GridCard toolbar={toolbar} footer={footer}>
        {body}
      </GridCard>
    </div>
  )
}

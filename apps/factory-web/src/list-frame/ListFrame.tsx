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
import { Banner, useToast } from '@nexus/ui/components'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { GridCardList, useCardList } from '@nexus/ui/grid/card-list/index'
import { columnText } from '@nexus/ui/grid/card-list/index'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DEFAULT_TIME_ZONE, formatTime } from '../lib/i18n/format'
import { useDsLabels } from '../lib/i18n/ds-labels'
import { useLocale, useT } from '../lib/i18n/provider'
import { WithMessages } from '../record-panels/i18n'
import { usePrintMode } from '../shell/print/print-mode'
import { ListKeysInfo } from './ListKeysInfo'
import { FIT_ROWS, gridLayout, isListKey, listKeys, nextRowIndex, ownsKeys, sameIds, toggleId, type ListKey } from './model'
import { ListToolsBar, type ExportAbout, type ListBuiltInViews, type WithheldColumn } from './tools/ListToolsBar'
import { useListTools } from './tools/useListTools'
import { BulkEditButton, BulkEditFlow, ExportSelected } from './w2b/bulk'
import { useInlineEdit } from './w2b/edit'
import { BoardMode, CalendarMode, ModeSwitch } from './w2b/modes'
import { offeredModes, type ListCards, type ListEdit, type ListModes, type ListQuick } from './w2b/model'
import { QuickChips, QuickMenu } from './w2b/quick'
import { MODE_NAMESPACES, useModeWords } from './w2b/words'
import type { BulkValue } from '@nexus/factory-domain/views/bulk/rules'
// ---- B-TH-241 (threads plan TH-4: custom columns and group rows) ----
import { useListToolsTransport } from './tools/transport'
import { shownCustomIds, withCustomColumns, type ListCustom } from './custom/model'
import { useCustomFields, useCustomValues } from './custom/use-custom-columns'
import { cellValueOf, editFieldOf, fieldLabel } from './custom/model' // B-TH-245
import type { ListEditField } from './w2b/model' // B-TH-245
import { groupedRows, isGroupMarker, markerId, type GroupMarker, type ListGroups } from './groups/model'
import { GroupLine } from './groups/GroupLine'
import './list-frame.css'
import './tools/tools.css'
import './w2b/w2b.css'

/** AG's own selection column (the row checkboxes and the header's select-all). */
const SELECTION_COLUMN = 'ag-Grid-SelectionColumn'
/** The long grid reads its next page this many rows before its end. */
const ENDLESS_AHEAD = 40

export interface ListFrameSelection {
  /** The selected rows' ids (the page owns them: the bulk actions read them). */
  selected: readonly string[]
  onChange: (ids: string[]) => void
  /**
   * The bulk actions, shown in the toolbar in place of the search while rows are selected (they say their reach). Each
   * button carries an icon and its words in the DS `SelectionLabel`: on a narrow card the DS hides the words first.
   */
  actions: ReactNode
  /**
   * B-W2b-13 (the W2a gap Z16:02): the frame adds "Export N" — this view's columns, only the selected rows, through the
   * shared export engine — when the list has an export and the person may export. Off by default (a list keeps its own
   * "Export N" until it opts in).
   */
  exportSelected?: boolean
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
  /**
   * Movements only (Owner answer W2 B): ONE long grid of a fixed height that scrolls inside, its header in view, loading
   * the next page by itself as the reader nears the end (no "Show more", no page numbers). Every other list keeps pages
   * of 50.
   */
  endless?: { onNearEnd: () => void; loading: boolean; done: boolean } | null
  /**
   * The list's saved views and export (B-W2a-23; Columns ▾ and Export ▾ in the toolbar): by default the page's own key
   * (its Office address with dots; a second frame on the page `<page>.2`), so every list has them without work; a key
   * of its own (`sales.orders.lines`) for a list that is not its page's; null: none (a short list inside a dialog).
   * Without the Office's list tools (a test, a design case of another screen) there are none either.
   */
  listKey?: string | null
  /** The list's name for an export's file and sheet ("Ordini di vendita"); default the table's label. */
  title?: string
  /** Design cases: the row that has the focus, the keys panel open. */
  focusRow?: number
  keysOpen?: boolean
  /*
   * B-W2b-13 — the W2b list frame (design shell.lists sec:view-modes, sec:grid, sec:toolbar, pop:bulk-edit). Each part is
   * opt-in: a list without the prop keeps its table exactly as before.
   */
  /** Table · Board · Calendar (· Cards with `cards`): the mode is the list's address term (`?mode=`), so a view keeps it. */
  modes?: ListModes<T> | null
  /**
   * The phone card list below 720 px (and the Cards mode): the list's own columns as DS GridCardList cards. ON for every
   * list (B-W2b-18, the W2a gap Z17:02): leave it out for the defaults, give `fields` / `hrefOf` / `sort` to shape the
   * cards, or `null` for a list that must stay a table on a phone.
   */
  cards?: ListCards<T> | null
  /** Inline edit of simple fields (autosaved per cell with its save mark, version-checked; paste a range) and Edit N. */
  edit?: ListEdit<T> | null
  /** Quick filters with "me" and relative days, their words kept in the list's address. */
  quick?: ListQuick | null
  /** Columns a person's rights leave out, listed in Columns ▾ as "Hidden: …" (design sec:grid). */
  withheld?: readonly WithheldColumn[]
  /** The site's day (YYYY-MM-DD) for the calendar; default today in the site's zone. */
  today?: string
  /** Design cases: the calendar's day open, the bulk edit open at a step with its values. */
  design?: { day?: string | null; bulk?: { values?: Record<string, BulkValue>; review?: boolean } }
  // ── B-TH-225 (threads plan TH-1a: the Orders sheet), each opt-in ──
  /** What Export ▾ says the file holds (whose rows, which view, how many), in the list's words. */
  exportAbout?: ExportAbout | null
  /**
   * A click on a row outside its links, buttons and fields (the rest of the row opens the record, grid-F29); the event says
   * whether ⌘ / Ctrl was held (a new tab). Absent: a click on a row does nothing (Enter opens it, as before).
   */
  onRowClick?: (row: T, event: MouseEvent) => void
  // ── end B-TH-225 ──
  // ── B-TH-057 (threads plan TH-4: Sales › Orders sorts on the server), opt-in ──
  /**
   * A person clicked a column's header sort: the column and the way round it asks (null: the grid's third click, no sort). The
   * page reads the rows again in that order (its columns set `sort` from the address and a comparator that keeps the rows as
   * read, so the grid shows the arrow and never reorders the loaded rows itself). Absent: the grid sorts the loaded rows, as before.
   */
  onSortChanged?: (colId: string | null, direction: 'asc' | 'desc' | null) => void
  // ── end B-TH-057 ──
  // ── B-TH-241 (threads plan TH-4, SHEET-G04, SHEET-G08), each opt-in ──
  /**
   * The record type's custom fields as columns `cf:<code>` (GET /fields in the list's scope; the loaded rows' values while one is
   * in view): hidden until a view shows them, written by Export when shown. A field for one customer shows only on its rows.
   */
  custom?: ListCustom<T> | null
  /**
   * Group rows: a header per group with the list's own figures for the whole group (the server's), its rows under it, "Show more
   * of …", and a grand total pinned under the grid. Never a figure summed from the loaded rows. Absent: no groups, as before.
   */
  groups?: ListGroups<T> | null
  // ── end B-TH-241 ──
  // ── B-TH-243 (threads plan TH-4, ORD-G10; SHEET.brand-view-F01), each opt-in ──
  /** The list's own built-in views on top of Views ▾ (one menu of views; the list's Rows ▾ joins it). */
  builtInViews?: ListBuiltInViews | null
  /** A new saved view's name to start from ("Brand Alpha — tracking" on a customer's sheet). */
  viewName?: string | null
  // ── end B-TH-243 ──
  // ── B-TH-244 (threads plan TH-4: a column that costs a read is read only while shown), opt-in ──
  /** The columns on screen changed (their ids, left to right): a list reads a costly column's data only while it is shown. */
  onShownColumns?: (ids: readonly string[]) => void
  // ── end B-TH-244 ──
}

/** Today in the site's zone (YYYY-MM-DD). */
const todayInZone = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/** The DS toast, or nothing when no provider is mounted. */
function useReceipt(): (message: string, tone?: 'success' | 'danger') => void {
  let api: ReturnType<typeof useToast> | null = null
  try {
    api = useToast()
  } catch {
    api = null
  }
  return (message, tone = 'success') => api?.toast(message, tone)
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
    <WithMessages namespaces={['lists', ...MODE_NAMESPACES]}>
      <Frame {...props} />
    </WithMessages>
  )
}

function Frame<T>({ label, rows, rowId: ownRowId, columns: ownColumns, count, search, tools, right, selection, isRowSelectable, updates, more, keys, onHelp, onOpen, state, rowKind = 'two-line', endless, listKey, title, focusRow, keysOpen, modes, cards, edit, quick, withheld, today, design, exportAbout, onRowClick, onSortChanged, custom, groups, builtInViews, viewName, onShownColumns }: ListFrameProps<T>) {
  const t = useT('lists')
  const locale = useLocale()
  const ds = useDsLabels()
  const modeWords = useModeWords()
  const receipt = useReceipt()
  const phone = useCardList()
  // B-W2b-05 (PLT-171): the print view draws every loaded row for paper, without the list's controls.
  const printing = usePrintMode()
  const frameRef = useRef<HTMLDivElement>(null)
  // B-TH-241: one row id for the frame's own work (a list passes a new function each render).
  const rowIdRef = useRef(ownRowId)
  rowIdRef.current = ownRowId
  const rowId = useCallback((row: T) => rowIdRef.current(row), [])
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  // B-TH-241: the custom columns (hidden until a view shows them) after the list's own, before its trailing ⋯.
  const toolsTransport = useListToolsTransport()
  const [customWanted, setCustomWanted] = useState(false)
  const customValues = useCustomValues(custom, toolsTransport, rows, rowId, customWanted && !state)
  const customColumns = useCustomFields(custom, toolsTransport, customValues.values, customValues.reading, rowId, locale, t)
  const columns = useMemo(() => withCustomColumns(ownColumns, customColumns.columns), [ownColumns, customColumns.columns])
  // Saved views and export: the layout on screen is applied to the columns the grid draws.
  const listTools = useListTools({ frame: frameRef, listKey, columns, title: title ?? label })
  useEffect(() => setCustomWanted(shownCustomIds(listTools.columns as never).length > 0), [listTools.columns])
  // B-TH-244: the columns on screen, told to a list that asks (once per change of what is shown).
  const shownRef = useRef(onShownColumns)
  shownRef.current = onShownColumns
  const shownKey = listTools.columns.filter((column) => !column.hide).map((column) => column.colId ?? (typeof column.field === 'string' ? column.field : '')).join('|')
  useEffect(() => shownRef.current?.(shownKey === '' ? [] : shownKey.split('|')), [shownKey])
  const apiRef = useRef<GridApi<T> | null>(null)
  const [ready, setReady] = useState(false)
  // ── B-TH-245 (threads plan TH-4, SHEET-G09): the custom values edit in their cells beside the list's own fields (one bulk target) ──
  const customFields = customColumns.fields
  const customEdit = custom?.edit
  const partyOfRef = useRef(custom?.partyOf)
  partyOfRef.current = custom?.partyOf
  const valuesRef = useRef(customValues.values)
  valuesRef.current = customValues.values
  const putValues = customValues.put
  const editWithCustom = useMemo<ListEdit<T> | null | undefined>(() => {
    if (!edit || !customEdit || !customFields || customFields.length === 0) return edit
    const fields: Record<string, ListEditField<T>> = {}
    for (const field of customFields) {
      const spec = editFieldOf<T>(
        field,
        {
          valueOf: (row) => cellValueOf(field, valuesRef.current.get(rowId(row))?.[field.code]),
          ...(partyOfRef.current ? { partyOf: (row: T) => partyOfRef.current?.(row) ?? null } : {}),
          ...(customEdit.held ? { held: customEdit.held } : {}),
          label: fieldLabel(field, locale),
          words: { notThisCustomer: t('custom.notThisCustomer'), yes: t('custom.yes'), no: t('custom.no') },
        },
        locale,
      )
      if (spec) fields[field.columnId] = spec
    }
    return {
      ...edit,
      fields: { ...edit.fields, ...fields },
      // A saved cell's custom values go on the row in the frame; the list keeps its own fields and the row's new version.
      onSaved: (savedId, after, version) => {
        putValues(savedId, customFields, after)
        edit.onSaved(savedId, after, version)
      },
    }
  }, [edit, customEdit, customFields, rowId, locale, t, putValues])
  // ── end B-TH-245 ──
  // B-W2b-13: inline edit (the cells save through the list's bulk target), the modes, the bulk edit.
  const inline = useInlineEdit<T>({ edit: printing ? undefined : (editWithCustom ?? undefined), transport: listTools.transport, listKey: listTools.listKey, rowId, api: () => apiRef.current, t, markLabels: ds.cellSaveMark })
  const gridColumns = useMemo(() => inline.columns(listTools.columns), [inline.columns, listTools.columns])
  // B-W2b-18: the phone card list is on unless the list says `cards={null}`.
  const cardsOn = cards !== null
  const offered = offeredModes(modes, cardsOn)
  const mode = printing ? 'table' : modes && offered.includes(modes.mode) ? modes.mode : 'table'
  const asCards = !printing && cardsOn && (mode === 'cards' || (phone && mode === 'table'))
  const [bulkOpen, setBulkOpen] = useState(!!design?.bulk)
  // A card's ⋯: the list's trailing column pinned at the right (its row menu) is the card's actions unless the list says.
  const cardFields = useMemo(() => {
    const last = listTools.columns[listTools.columns.length - 1]
    const id = last ? (last.colId ?? (typeof last.field === 'string' ? last.field : null)) : null
    return { ...(last && id && last.pinned === 'right' ? { [id]: { role: 'actions' as const } } : {}), ...(cards?.fields ?? {}) }
  }, [listTools.columns, cards?.fields])
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
      if (!node.data || isGroupMarker(node.data)) return // B-TH-241: a group's line is no row of the list
      const should = want.has(rowId(node.data))
      if (should !== node.isSelected()) (should ? on : off).push(node)
    })
    if (on.length) api.setNodesSelected({ nodes: on, newValue: true })
    if (off.length) api.setNodesSelected({ nodes: off, newValue: false })
  }, [selected, rows, ready, rowId, selection])

  // The grid's ticks (a box, shift-click range, the header, Space) → the page.
  const onSelectionChanged = useCallback(
    (event: { api: GridApi<T> }) => {
      const ids = event.api.getSelectedNodes().flatMap((node) => (node.data && !isGroupMarker(node.data) ? [rowId(node.data)] : []))
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
        if (!node?.data || isGroupMarker(node.data) || (isRowSelectable && isRowSelectable(node.data) !== null)) return
        event.preventDefault()
        selection.onChange(toggleId(selectedRef.current, rowId(node.data)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusRowAt, isRowSelectable, onHelp, rowId, selection])

  // Enter on a row opens it (not on its checkbox: Space ticks there; not on a cell that edits: Enter edits it).
  const onCellKeyDown = useCallback(
    (event: { data?: T; event?: Event | null; column?: { getColId(): string } }) => {
      const key = (event.event as KeyboardEvent | null | undefined)?.key
      const colId = event.column?.getColId()
      if (key !== 'Enter' || !event.data || colId === SELECTION_COLUMN) return
      // B-TH-241: Enter on a group's header folds or opens it; on its "Show more" reads more.
      if (isGroupMarker(event.data)) {
        const marker = event.data as GroupMarker
        if (marker.fwGroup === 'header') groupsRef.current?.onToggle(marker.key)
        else if (marker.fwGroup === 'more') groupsRef.current?.groups.find((group) => group.key === marker.key)?.more?.onMore()
        return
      }
      if (colId && inline.editableFor(event.data, colId)) return
      onOpen?.(event.data)
    },
    [onOpen, inline],
  )

  // B-TH-241: a group's line has an id of its own (never one of the list's).
  const getRowId = useCallback((params: { data: T }) => (isGroupMarker(params.data) ? markerId(params.data) : rowId(params.data)), [rowId])

  // B-TH-245: the row click reads the cells that edit (they keep their own click).
  const inlineRef = useRef(inline)
  inlineRef.current = inline
  // B-TH-225: the rest of the row opens the record; a link, a button, a box or a field in the cell keeps its own click.
  const rowClickRef = useRef(onRowClick)
  rowClickRef.current = onRowClick
  const onRowClicked = useCallback((event: { data?: T; event?: Event | null }) => {
    const click = event.event as MouseEvent | null | undefined
    const target = click?.target as HTMLElement | null | undefined
    if (!event.data || !click || !rowClickRef.current || isGroupMarker(event.data)) return
    if (target?.closest('a, button, input, select, textarea, label, [role="button"], [role="checkbox"], .ag-selection-checkbox, [contenteditable="true"]')) return
    // B-TH-245 (one rule: door = link, editable cell = its editor, the rest of the row = the record): a click on a cell that edits stays.
    const cellCol = target?.closest('.ag-cell')?.getAttribute('col-id')
    if (cellCol && inlineRef.current?.editableFor(event.data, cellCol)) return
    rowClickRef.current(event.data, click)
  }, [])

  // B-TH-057: a person's header click (never the page's own `sort` from the address) reaches the page.
  const sortRef = useRef(onSortChanged)
  sortRef.current = onSortChanged
  const onGridSortChanged = useCallback((event: { source?: string; api: GridApi<T> }) => {
    if (!sortRef.current || event.source !== 'uiColumnSorted') return
    const sorted = event.api.getColumnState().find((column) => column.sort === 'asc' || column.sort === 'desc')
    sortRef.current(sorted?.colId ?? null, (sorted?.sort as 'asc' | 'desc' | undefined) ?? null)
  }, [])

  // The long grid asks for its next page when the last rows come into view (once per page: `loading` holds it).
  const endlessRef = useRef(endless)
  endlessRef.current = endless
  const onBodyScroll = useCallback(() => {
    const api = apiRef.current
    const wants = endlessRef.current
    if (!api || api.isDestroyed() || !wants || wants.loading || wants.done) return
    if (api.getLastDisplayedRowIndex() >= api.getDisplayedRowCount() - ENDLESS_AHEAD) wants.onNearEnd()
  }, [])
  const rowSelection = useMemo(
    () =>
      selection
        ? ({
            mode: 'multiRow',
            checkboxes: true,
            headerCheckbox: false,
            enableClickSelection: false,
            ...(isRowSelectable || groups ? { isRowSelectable: (node: IRowNode<T>) => !node.data || (!isGroupMarker(node.data) && (!isRowSelectable || isRowSelectable(node.data) === null)) } : {}),
          } as const)
        : undefined,
    [selection, isRowSelectable, !!groups],
  )
  const selectionColumnDef = useMemo(
    () => ({
      width: gridGeometry.selectColW,
      maxWidth: gridGeometry.selectColW,
      resizable: false,
      headerComponent: LoadedRowsSelectionHeader,
      headerName: t('selectAll'),
      // A row that may not be selected says why on its disabled box.
      ...(isRowSelectable ? { tooltipValueGetter: (params: { data?: T }) => (params.data && !isGroupMarker(params.data) ? isRowSelectable(params.data) : null) } : {}),
    }),
    [t, isRowSelectable],
  )

  const picked = selection && !printing ? selected.length : 0
  const exportsOn = !!listTools.answer?.exports && !!listTools.answer?.can.export
  const pickedRows = useMemo(() => (rows ?? []).filter((row) => selected.includes(rowId(row))), [rows, selected, rowId])
  const frameActions =
    selection && !printing ? (
      <>
        {selection.actions}
        {edit?.bulk && (
          <BulkEditButton
            count={picked}
            noun={edit.bulk.noun}
            held={edit.held ?? (!listTools.transport ? t('bulk.heldNoTools') : null)}
            t={t}
            onOpen={() => setBulkOpen(true)}
          />
        )}
        {selection.exportSelected && exportsOn && listTools.transport && listTools.listKey && (
          <ExportSelected ids={selected} columns={listTools.columns} formats={listTools.answer!.exports!.formats} transport={listTools.transport} listKey={listTools.listKey} title={listTools.title} t={t} onReceipt={receipt} />
        )}
      </>
    ) : null
  const frameTools = printing ? null : (
    <>
      {quick && quick.filters.length > 0 && <QuickMenu quick={quick} t={t} />}
      {listTools.transport && <ListToolsBar state={listTools} withheld={withheld} about={exportAbout} builtIns={builtInViews} suggested={viewName} /* B-TH-243 */ />}
      {modes && <ModeSwitch modes={offered} mode={mode} onMode={modes.onMode} t={t} />}
    </>
  )
  const saveStatus =
    inline.active && inline.status.kind !== 'idle' ? (
      <SaveStatus state={inline.status} size="sm" {...(inline.retryable ? { onRetry: inline.retry } : {})} formatTime={(iso) => formatTime(iso, { locale })} labels={ds.saveStatus} />
    ) : null
  // Straight into the card (no wrapper): the DS toolbar's wrap rules match only `.nds-grid-card > .nds-toolbar`, so a
  // phone's card takes a second line instead of pushing tools past its clipped edge.
  const toolbar = printing ? (
    <GridToolbar wrap count={count}>
      {search && <GridSearchSlot>{search}</GridSearchSlot>}
    </GridToolbar>
  ) : (
    <GridToolbar
      wrap
      count={picked > 0 ? t('selected', { count: picked }) : count}
      right={
        <>
          {saveStatus}
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
          {frameActions}
          <Button size="sm" variant="link" onClick={() => selection.onChange([])} aria-label={t('clear')}>
            <X size={13} aria-hidden /> <SelectionLabel>{t('clear')}</SelectionLabel>
          </Button>
        </GridSelectionActions>
      ) : (
        <>
          {search && <GridSearchSlot>{search}</GridSearchSlot>}
          {tools}
          {frameTools}
        </>
      )}
    </GridToolbar>
  )
  const footer = printing ? undefined : (
    <GridFooterStrip>
      {more && (
        <Button size="sm" onClick={more.onMore} heldReason={more.held ?? null}>
          {more.label}
        </Button>
      )}
      <GridFooterSpacer />
      <ListKeysInfo keys={listKeys(inline.active ? [...(keys ?? []), ...EDIT_KEYS] : keys, !!selection)} onHelp={onHelp} open={keysOpen} />
    </GridFooterStrip>
  )

  // ── B-TH-241: group rows (only when the list asks, in the table) ──
  const groupedOn = !!groups && !printing && rows !== null && !state && mode === 'table'
  const grouped = useMemo(() => (groupedOn && groups && rows ? groupedRows(rows, groups) : null), [groupedOn, groups, rows])
  const isGroupLine = useCallback((params: { rowNode: IRowNode<T> }) => isGroupMarker(params.rowNode.data), [])
  const GroupCell = useCallback(
    (params: { data?: unknown }) => {
      const marker = params.data
      const current = groupsRef.current
      if (!isGroupMarker(marker) || !current) return null
      return <GroupLine marker={marker} group={current.groups.find((group) => group.key === marker.key)} folded={current.collapsed.includes(marker.key)} onToggle={current.onToggle} t={t} />
    },
    [t],
  )
  const groupTotal = groupedOn && groups?.total ? <div className="fw-list-total">{groups.total}</div> : null
  // ── end B-TH-241 ──

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
  else if (mode === 'board' && modes?.board) {
    body = <BoardMode label={label} rows={rows} rowId={rowId} columns={listTools.columns} board={modes.board} hrefOf={cards?.hrefOf} onOpen={onOpen} words={modeWords.board} locale={locale} />
  } else if (mode === 'calendar' && modes?.calendar) {
    const first = listTools.columns.find((column) => !column.hide && (column.colId ?? column.field) !== SELECTION_COLUMN)
    body = (
      <CalendarMode
        label={label}
        rows={rows}
        rowId={rowId}
        nameOf={(row) => (first ? columnText(first, row) : '') || (edit ? edit.labelOf(row) : rowId(row))}
        calendar={modes.calendar}
        today={today ?? todayInZone()}
        hrefOf={cards?.hrefOf}
        onOpen={onOpen}
        edit={inline.active ? inline : null}
        words={modeWords.calendar}
        dateWords={ds.dateField}
        locale={locale}
        t={t}
        day={design?.day ?? null}
      />
    )
  } else {
    // B-TH-241: a grouped list's grid holds each group's header, its rows, its "Show more" or reading line.
    const gridRows = grouped ?? rows
    // The long grid keeps its fixed height only while it has more than one page or more to read: a short, complete ledger
    // is as tall as its rows, like every list (no empty band).
    const long = !printing && !!endless && !(endless.done && rows.length <= FIT_ROWS)
    const layout = long ? { domLayout: 'normal' as const, fit: false } : gridLayout(gridRows.length)
    body = (
      <div className={printing ? 'fw-list-grid printing' : long ? 'fw-list-grid endless' : layout.fit ? 'fw-list-grid fit' : 'fw-list-grid'} role="region" aria-label={label}>
        <NexusGrid<T>
          domLayout={printing ? 'print' : layout.domLayout}
          {...(printing ? { height: 'auto' } : {})}
          {...(long ? { onBodyScroll, onModelUpdated: onBodyScroll } : {})}
          rows={rowKind}
          rowData={gridRows as T[]}
          columnDefs={gridColumns}
          {...(listTools.layout.density ? { density: listTools.layout.density } : {})}
          getRowId={getRowId}
          onGridReady={onGridReady}
          rowSelection={printing ? undefined : rowSelection}
          selectionColumnDef={selection && !printing ? selectionColumnDef : undefined}
          onSelectionChanged={onSelectionChanged}
          onCellKeyDown={onCellKeyDown}
          {...(onRowClick ? { onRowClicked } : {}) /* B-TH-225 */}
          {...(onSortChanged ? { onSortChanged: onGridSortChanged } : {}) /* B-TH-057 */}
          {...(grouped ? { isFullWidthRow: isGroupLine, fullWidthCellRenderer: GroupCell } : {}) /* B-TH-241 */}
          suppressCellFocus={false}
          {...(inline.active ? { readOnlyEdit: true, onCellEditRequest: inline.onCellEditRequest, cellSelection: true } : {})}
        />
      </div>
    )
  }

  const chips = quick && !printing ? <QuickChips quick={quick} t={t} /> : null
  const bulk =
    bulkOpen && editWithCustom?.bulk && listTools.transport && listTools.listKey ? (
      <BulkEditFlow<T>
        rows={pickedRows}
        rowId={rowId}
        edit={editWithCustom /* B-TH-245: Edit N offers the custom values too */}
        columns={listTools.columns}
        transport={listTools.transport}
        listKey={listTools.listKey}
        locale={locale}
        t={t}
        words={{ review: ds.review, doneVerb: ds.reviewDoneVerb, modal: ds.modal, dateField: ds.dateField }}
        onClose={() => setBulkOpen(false)}
        onDone={() => selection?.onChange([])}
        start={design?.bulk}
      />
    ) : null

  // The long grid's next page on a phone: the cards have no scroll of their own to read it by, so they get "Show more".
  const endlessMore = endless && !endless.done && rows ? { label: t('morePage'), onMore: endless.onNearEnd, held: endless.loading ? t('loading') : null } : null

  // ── B-TH-241: a grouped list on a phone — each group a section (its header as the section's title, its cards), the total last ──
  if (asCards && groups && groupedOn && rows && groups.groups.length > 0) {
    const byGroup = (key: string) => rows.filter((row) => groups.keyOf(row) === key)
    return (
      <div className="fw-list" ref={frameRef}>
        {chips}
        {groups.groups.map((group, index) => {
          const folded = groups.collapsed.includes(group.key)
          return (
            <section key={group.key} className="fw-list-group-section" aria-label={group.name}>
              <GroupLine marker={{ fwGroup: 'header', key: group.key }} group={group} folded={folded} onToggle={groups.onToggle} t={t} />
              {!folded && (
                <GridCardList<T>
                  label={`${label} · ${group.name}`}
                  rows={byGroup(group.key)}
                  rowId={rowId}
                  columns={listTools.columns}
                  fields={cardFields}
                  className="fw-list-cards"
                  {...(cards?.hrefOf ? { hrefOf: cards.hrefOf } : {})}
                  {...(index === 0 ? { count: picked > 0 ? t('selected', { count: picked }) : count, search, tools: <>{tools}{frameTools}{saveStatus}</> } : {})}
                  {...(selection ? { selection: { selected, onChange: selection.onChange, actions: frameActions } } : {})}
                  {...(isRowSelectable ? { isRowSelectable } : {})}
                  labels={ds.cardList}
                />
              )}
              {!folded && group.state && <GroupLine marker={{ fwGroup: 'state', key: group.key }} group={group} folded={false} onToggle={groups.onToggle} t={t} />}
              {!folded && !group.state && group.more && <GroupLine marker={{ fwGroup: 'more', key: group.key }} group={group} folded={false} onToggle={groups.onToggle} t={t} />}
            </section>
          )
        })}
        {groupTotal}
        {bulk}
      </div>
    )
  }
  // ── end B-TH-241 ──

  if (asCards) {
    // The phone card list (PLT-170) and the Cards mode: the same rows, columns, search, filters and selection as cards
    // (skeleton cards while the first read runs).
    return (
      <div className="fw-list" ref={frameRef}>
        {chips}
        <GridCardList<T>
          label={label}
          rows={state ? [] : rows}
          rowId={rowId}
          columns={listTools.columns}
          fields={cardFields}
          className={mode === 'cards' && !phone ? 'fw-list-cards wide' : 'fw-list-cards'}
          {...(cards?.hrefOf ? { hrefOf: cards.hrefOf } : {})}
          count={picked > 0 ? t('selected', { count: picked }) : count}
          search={search}
          tools={
            <>
              {tools}
              {frameTools}
              {saveStatus}
            </>
          }
          {...(cards?.onSortChange ? { sort: cards.sort ?? null, onSortChange: cards.onSortChange } : {})}
          {...(selection ? { selection: { selected, onChange: selection.onChange, actions: frameActions } } : {})}
          {...(isRowSelectable ? { isRowSelectable } : {})}
          state={state}
          more={more ?? endlessMore}
          labels={ds.cardList}
        />
        {bulk}
      </div>
    )
  }

  return (
    <div className="fw-list" ref={frameRef}>
      {listTools.linkNotice && !printing && (
        <div className="fw-lt-notice">
          <Banner
          tone="warning"
          title={t('tools.linkNotShared')}
          action={
            <Button size="sm" variant="quiet" onClick={listTools.dismissLinkNotice}>
              {t('tools.dismiss')}
            </Button>
          }
          />
        </div>
      )}
      <GridCard toolbar={toolbar} footer={footer}>
        {chips}
        {body}
        {/* B-TH-241: the grand total, pinned under the grid (the list's own figures, from the server). */}
        {groupTotal}
      </GridCard>
      {bulk}
    </div>
  )
}

/** The keys of a list whose cells edit (the footer's information icon adds them). */
const EDIT_KEYS: readonly ListKey[] = Object.freeze([
  { keys: ['F2'], does: 'keys.edit' },
  { keys: ['⌘', 'V'], does: 'keys.paste' },
])

'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  GridFooterSpacer,
  GridFooterStrip,
  GridSelectionActions,
  GridSheet,
  GridToolbar,
  gridGeometry,
  LoadedRowsSelectionHeader,
  NexusGrid,
  SelectionLabel,
  SHEET_GRID_OPTIONS,
  selectEditor,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type IRowNode,
} from '@nexus/ui/grid'
import { Menu } from '@nexus/ui/components'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { CalendarPlus, Clock, Redo2, Undo2 } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListKeysInfo } from '../../../../list-frame/ListKeysInfo'
import type { ListKey } from '../../../../list-frame/model'
import { TIME_ZONE } from '../../_shared/model'
import type { RosterCell, RosterDay, ShiftChoice } from '../api'
import { cellId, cellsOfRange, choiceText, dayShort, OPTION_DEFAULT, OPTION_OFF, optionOf, paperCell, type CellRef, type LineRow, type PersonRow, type SheetRow, type TeamRow } from '../model'
import type { Mark, ShiftsActions, ShiftsModel } from '../view-model'
import { useShiftWords } from './parts'
import { FootCell, ShiftCell } from './ShiftCell'

/**
 * The roster (design people.shifts sec:roster): the DS sheet, people grouped line › team, a column per day. The grid edits
 * in read-only mode: it never changes the rows itself, each edit (a letter on the focused cell or the selected cells, the
 * fill handle, a paste, the cell's list on Enter) comes to the page in one tick as one write. A cell shows "saving" until
 * the server answered. People are ticked in the first column (shift-click a range, x on the focused row); cells are
 * selected by drag or shift + arrows. Keys in the footer's one info icon. The sheet has its own scroll inside a bounded
 * height: the overtime requests stay below it.
 */

const NAME_COLUMN = 'name'
const ROW = { line: 32, team: 28, person: 44, compact: 30, foot: 40 }

export interface SheetContext {
  choices: readonly ShiftChoice[]
  compact: boolean
  marks: Readonly<Record<string, Mark>>
  whyOpen: string | null
  focusCell: (id: string, date: string) => void
  prefix: string
  linkNames: boolean
}

interface GridCellParams extends ICellRendererParams<SheetRow, RosterCell | undefined, SheetContext> {
  date: string
}

const DayCell = memo(function DayCell(params: GridCellParams) {
  const row = params.data
  const { context, date, value } = params
  if (row?.kind === 'foot') return <FootCell day={row.days[date]} choices={context.choices} compact={context.compact} />
  if (row?.kind !== 'person' || !value) return null
  const id = cellId(row.row.employeeId, date)
  return <ShiftCell cell={value} choices={context.choices} compact={context.compact} mark={context.marks[id]} whyId={id} whyOpen={context.whyOpen === id} onReturn={() => context.focusCell(row.id, date)} />
})

function NameCell(params: ICellRendererParams<SheetRow, unknown, SheetContext>) {
  const t = useShiftWords()
  const row = params.data
  if (row?.kind === 'foot') return <span className="fw-rs-foot-name">{t('foot.title')}</span>
  if (row?.kind !== 'person') return null
  const person = row.row
  const name = params.context.linkNames ? <Link href={`${params.context.prefix}/people/employees/${encodeURIComponent(person.employeeId)}`}>{person.name}</Link> : <span>{person.name}</span>
  return (
    <span className="fw-rs-person">
      {name}
      {person.isLead && <Tag tone="info">{t('sheet.lead')}</Tag>}
    </span>
  )
}

function GroupRow(params: ICellRendererParams<SheetRow, unknown, SheetContext>) {
  const t = useShiftWords()
  const row = params.data as LineRow | TeamRow | undefined
  if (!row) return null
  if (row.kind === 'team') return <span className="fw-rs-group is-team">{t('sheet.team', { name: row.team.name, count: row.people })}</span>
  return (
    <span className="fw-rs-group is-line">
      <b>{row.line ? `${row.line.code} · ${row.line.name}` : t('sheet.noLine')}</b>
      <span>{t('sheet.people', { count: row.people })}</span>
    </span>
  )
}

/** The cell's list: every shift, a day off, back to the default. */
export function shiftOptions(choices: readonly ShiftChoice[], t: (key: string) => string): Array<{ value: string; label: string }> {
  return [...choices.map((choice) => ({ value: optionOf(choice), label: `${choice.key ? `${choice.key} · ` : ''}${choiceText(choice)}` })), { value: OPTION_OFF, label: `O · ${t('cell.off')}` }, { value: OPTION_DEFAULT, label: t('cell.backToDefault') }]
}

const isFullWidthRow = ({ rowNode }: { rowNode: IRowNode<SheetRow> }) => rowNode.data?.kind === 'line' || rowNode.data?.kind === 'team'
const getRowId = (params: { data: SheetRow }) => params.data.id

export function RosterSheet({ model, actions, days, onHelp, onCells }: { model: ShiftsModel; actions?: ShiftsActions | undefined; days: readonly RosterDay[]; onHelp: () => void; onCells?: (cells: readonly CellRef[]) => void }) {
  const t = useShiftWords()
  const lists = useT('lists')
  const locale = useLocale()
  const ds = useDsWords()
  const apiRef = useRef<GridApi<SheetRow> | null>(null)
  const compact = model.dates.length > 14
  const editable = model.roster.status === 'ready' && model.roster.value.canEdit !== 'NONE'

  // ---- what is selected ------------------------------------------------------------------------------------------------------
  const rowsRef = useRef(model.rows)
  rowsRef.current = model.rows
  const datesRef = useRef(model.dates)
  datesRef.current = model.dates
  const [cellCount, setCellCount] = useState(0)
  /** The cells a verb acts on: the selected range (or ranges), else the focused cell. */
  const targets = useCallback((): CellRef[] => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return []
    const days = new Set(datesRef.current)
    const ranges = api.getCellRanges() ?? []
    const out = ranges.flatMap((range) =>
      range.startRow && range.endRow && !range.startRow.rowPinned ? cellsOfRange(rowsRef.current, { startRow: range.startRow.rowIndex, endRow: range.endRow.rowIndex, dates: range.columns.map((column) => column.getColId()).filter((id) => days.has(id)) }) : [],
    )
    if (out.length > 0) return out
    const focused = api.getFocusedCell()
    if (!focused || !days.has(focused.column.getColId())) return []
    const row = rowsRef.current[focused.rowIndex]
    return row?.kind === 'person' ? [{ employeeId: row.row.employeeId, date: focused.column.getColId() }] : []
  }, [])
  const targetsRef = useRef(targets)
  targetsRef.current = targets

  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const helpRef = useRef(onHelp)
  helpRef.current = onHelp

  // ---- edits from the grid, gathered per tick -------------------------------------------------------------------------------
  const pending = useRef<Array<CellRef & { value: unknown }>>([])
  const onCellEditRequest = useCallback((event: { data?: SheetRow; column?: { getColId(): string }; newValue?: unknown }) => {
    const date = event.column?.getColId()
    if (event.data?.kind !== 'person' || !date) return
    pending.current.push({ employeeId: event.data.row.employeeId, date, value: event.newValue })
    if (pending.current.length > 1) return
    setTimeout(() => {
      const edits = pending.current
      pending.current = []
      if (edits.length > 0) actionsRef.current?.onEdits(edits)
    }, 0)
  }, [])

  // ---- keys -------------------------------------------------------------------------------------------------------------------
  const suppressKeyboardEvent = useCallback((params: { event: KeyboardEvent; editing: boolean; data?: SheetRow | undefined; node: IRowNode<SheetRow>; column: { getColId(): string } }) => {
    const { event, editing } = params
    if (editing) return false
    const down = event.type === 'keydown'
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return false
      if (down) {
        event.preventDefault()
        if (key === 'y' || event.shiftKey) actionsRef.current?.onRedo()
        else actionsRef.current?.onUndo()
      }
      return true
    }
    if (event.altKey) return false
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (down) actionsRef.current?.onKey('Delete', targetsRef.current())
      return true
    }
    if (event.key.length !== 1 || event.key === ' ') return false
    // A key on the sheet is the sheet's: the list below it never hears it.
    event.stopPropagation()
    if (down) {
      const date = params.column.getColId()
      const key = event.key.toLowerCase()
      if (key === '[' || key === ']') actionsRef.current?.onMove(key === '[' ? -1 : 1)
      else if (key === '?') helpRef.current()
      else if (!(actionsRef.current?.onKey(event.key, targetsRef.current()) ?? false)) {
        if (key === 'x' && params.data?.kind === 'person') params.node.setSelected(!params.node.isSelected())
        if (key === 'w' && params.data?.kind === 'person') document.querySelector<HTMLButtonElement>(`[data-why="${cellId(params.data.row.employeeId, date)}"] button`)?.click()
      }
    }
    return true
  }, [])

  // ---- columns ----------------------------------------------------------------------------------------------------------------
  const options = useMemo(() => shiftOptions(model.choices, t), [model.choices, t])
  const dayOf = useMemo(() => new Map(days.map((day) => [day.date, day])), [days])
  const columns = useMemo<ColDef<SheetRow>[]>(() => {
    const name: ColDef<SheetRow> = {
      colId: NAME_COLUMN,
      headerName: t('sheet.person'),
      pinned: 'left',
      width: compact ? 200 : 230,
      lockPosition: 'left',
      suppressNavigable: false,
      cellRenderer: NameCell,
      valueGetter: (params) => (params.data?.kind === 'person' ? params.data.row.name : ''),
      cellClass: 'fw-rs-name-cell',
      suppressKeyboardEvent: suppressKeyboardEvent as never,
    }
    const site: ColDef<SheetRow> = {
      colId: 'site',
      headerName: t('sheet.site'),
      pinned: 'left',
      width: 120,
      valueGetter: (params) => (params.data?.kind === 'person' ? params.data.row.site.name : ''),
      suppressKeyboardEvent: suppressKeyboardEvent as never,
    }
    const dayColumns = model.dates.map<ColDef<SheetRow>>((date) => {
      const day = dayOf.get(date)
      const closed = day ? !day.open : false
      const head = new Date(`${date}T12:00:00Z`)
      const weekday = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(head)
      return {
        colId: date,
        headerName: compact ? `${weekday.charAt(0).toUpperCase()} ${Number(date.slice(8, 10))}` : `${weekday} ${dayShort(date, locale)}`,
        headerClass: [closed ? 'fw-rs-head-closed' : '', date === model.today ? 'fw-rs-head-today' : '', compact ? 'is-compact' : ''].filter(Boolean).join(' '),
        headerTooltip: [`${weekday} ${dayShort(date, locale)}`, day?.name ?? (closed ? t(`day.${day?.reason ?? 'WEEK'}`) : null)].filter(Boolean).join(' · '),
        minWidth: compact ? 36 : 112,
        flex: 1,
        cellDataType: false,
        valueGetter: (params) => (params.data?.kind === 'person' ? params.data.cells[date] : undefined),
        valueFormatter: (params) => paperCell(params.value as RosterCell | undefined, t('cell.off')),
        cellRenderer: DayCell,
        cellRendererParams: { date },
        cellClass: compact ? 'fw-rs-day is-compact' : 'fw-rs-day',
        cellClassRules: {
          'fw-rs-closed': (params) => params.data?.kind === 'person' && params.value?.open === false,
          'fw-rs-tone-warn': (params) => params.data?.kind === 'person' && (params.value as RosterCell | undefined)?.warnings.some((warning) => warning.level === 'WARN') === true && !(params.value as RosterCell).warnings.some((warning) => warning.level === 'BLOCK'),
          'fw-rs-tone-block': (params) => params.data?.kind === 'person' && (params.value as RosterCell | undefined)?.warnings.some((warning) => warning.level === 'BLOCK') === true,
          'nds-cell-is-saving': (params) => params.data?.kind === 'person' && (params.context as SheetContext).marks[cellId(params.data.row.employeeId, date)]?.state === 'saving',
          'nds-cell-is-saved': (params) => params.data?.kind === 'person' && (params.context as SheetContext).marks[cellId(params.data.row.employeeId, date)]?.state === 'saved',
          'nds-cell-is-refused': (params) => params.data?.kind === 'person' && (params.context as SheetContext).marks[cellId(params.data.row.employeeId, date)]?.state === 'refused',
          'nds-cell-is-unknown': (params) => params.data?.kind === 'person' && (params.context as SheetContext).marks[cellId(params.data.row.employeeId, date)]?.state === 'unknown',
        },
        tooltipValueGetter: (params) => (params.data?.kind === 'person' ? ((params.context as SheetContext).marks[cellId(params.data.row.employeeId, date)]?.reason ?? null) : null),
        editable: (params) => params.data?.kind === 'person' && params.data.row.canEdit,
        ...(editable ? { cellEditor: selectEditor(options).cellEditor, cellEditorParams: { ...selectEditor(options).cellEditorParams, parseValue: (value: string) => value }, cellEditorPopup: true, cellEditorPopupPosition: 'under' as const } : {}),
        suppressKeyboardEvent: suppressKeyboardEvent as never,
      }
    })
    return [name, ...(model.scope.allSites ? [site] : []), ...dayColumns]
  }, [model.dates, model.today, model.scope.allSites, compact, dayOf, locale, t, options, editable, suppressKeyboardEvent])

  const rowSelection = useMemo(
    () =>
      ({
        mode: 'multiRow',
        checkboxes: (params: { data?: SheetRow }) => params.data?.kind === 'person',
        headerCheckbox: false,
        enableClickSelection: false,
        isRowSelectable: (node: IRowNode<SheetRow>) => node.data?.kind === 'person',
      }) as const,
    [],
  )
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false, headerComponent: LoadedRowsSelectionHeader, headerName: lists('selectAll'), pinned: 'left' as const }), [lists])

  const focusCell = useCallback((id: string, date: string) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const index = api.getRowNode(id)?.rowIndex
    if (index !== null && index !== undefined) api.setFocusedCell(index, date)
  }, [])
  const context = useMemo<SheetContext>(
    () => ({ choices: model.choices, compact, marks: model.marks, whyOpen: model.whyOpen ?? null, focusCell, prefix: model.prefix, linkNames: model.can.employees }),
    [model.choices, compact, model.marks, model.whyOpen, focusCell, model.prefix, model.can.employees],
  )
  // A mark changed: the cells read the context again. AG only re-reads it when told.
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.setGridOption('context', context)
    api.refreshCells({ force: true, suppressFlash: true })
  }, [context])

  const onGridReady = useCallback((event: GridReadyEvent<SheetRow>) => {
    apiRef.current = event.api
  }, [])
  const onSelectionChanged = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    actionsRef.current?.onPick(api.getSelectedRows().flatMap((row) => (row.kind === 'person' ? [row.row.employeeId] : [])))
  }, [])
  const onCellsRef = useRef(onCells)
  onCellsRef.current = onCells
  const onCellSelectionChanged = useCallback(() => {
    const cells = targetsRef.current()
    setCellCount(cells.length)
    onCellsRef.current?.(cells)
  }, [])

  // The page cleared the people ticked (Clear, a dialog that finished).
  useEffect(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed() && model.picked.length === 0 && api.getSelectedRows().length > 0) api.deselectAll()
  }, [model.picked])

  const getRowHeight = useCallback(
    (params: { data?: SheetRow }) => {
      switch (params.data?.kind) {
        case 'line':
          return ROW.line
        case 'team':
          return ROW.team
        case 'foot':
          return ROW.foot
        default:
          return compact ? ROW.compact : ROW.person
      }
    },
    [compact],
  )
  const height = useMemo(() => {
    const total = model.rows.reduce((sum, row) => sum + getRowHeight({ data: row }), 0)
    return `min(${total + 108}px, 76vh)`
  }, [model.rows, getRowHeight])

  const people = model.rows.filter((row): row is PersonRow => row.kind === 'person').length
  const setItems = [
    ...model.choices.map((choice) => ({ id: optionOf(choice), label: choiceText(choice), onSelect: () => actions?.onSetOption(optionOf(choice), targets()) })),
    { id: OPTION_OFF, label: t('cell.off'), onSelect: () => actions?.onSetOption(OPTION_OFF, targets()) },
    { id: OPTION_DEFAULT, label: t('cell.backToDefault'), onSelect: () => actions?.onSetOption(OPTION_DEFAULT, targets()) },
  ]
  const keys = useMemo<ListKey[]>(() => shiftKeys(t, model.choices), [t, model.choices])

  const toolbar =
    model.picked.length > 0 ? (
      <GridToolbar count={t('sheet.pickedPeople', { count: model.picked.length })}>
        <GridSelectionActions>
          <Button size="sm" variant="primary" onClick={() => actions?.onAssign(model.picked.flatMap((employeeId) => model.dates.map((date) => ({ employeeId, date }))))}>
            <CalendarPlus size={14} aria-hidden /> <SelectionLabel>{t('sheet.assignTo', { count: model.picked.length })}</SelectionLabel>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => actions?.onOvertime(model.picked)} heldReason={model.can.overtime ? null : t('held.noOvertime')}>
            <Clock size={14} aria-hidden /> <SelectionLabel>{t('sheet.overtimeFor', { count: model.picked.length })}</SelectionLabel>
          </Button>
          <Button size="sm" variant="link" onClick={() => actions?.onPick([])}>
            {lists('clear')}
          </Button>
        </GridSelectionActions>
      </GridToolbar>
    ) : (
      <GridToolbar
        wrap
        count={cellCount > 1 ? t('sheet.cellsSelected', { count: cellCount }) : t('sheet.count', { people, days: model.dates.length })}
        right={
          <>
            {model.save.kind !== 'idle' && <SaveStatus state={model.save} size="sm" {...(model.canRetry && actions ? { onRetry: actions.onRetrySave } : {})} formatTime={(iso) => formatTime(iso, { locale, timeZone: TIME_ZONE })} labels={ds.saveStatus} />}
            <Button size="sm" variant="quiet" aria-label={t('sheet.undo')} onClick={() => actions?.onUndo()} heldReason={model.canUndo ? null : t('held.nothingToUndo')}>
              <Undo2 size={14} aria-hidden />
            </Button>
            <Button size="sm" variant="quiet" aria-label={t('sheet.redo')} onClick={() => actions?.onRedo()} heldReason={model.canRedo ? null : t('held.nothingToRedo')}>
              <Redo2 size={14} aria-hidden />
            </Button>
          </>
        }
      >
        {editable && (
          <Menu label={t('sheet.setShift')} items={cellCount === 0 ? setItems.map((item) => ({ ...item, disabled: true, description: t('held.pickCells'), onSelect: () => undefined })) : setItems} triggerProps={{ 'aria-label': t('sheet.setShift') }} />
        )}
      </GridToolbar>
    )

  return (
    <div className="fw-rs-sheet" role="region" aria-label={t('sheet.label')}>
      <GridSheet
        height={height}
        density="compact"
        gutter={0}
        toolbar={toolbar}
        footer={
          <GridFooterStrip>
            <span className="fw-rs-legend">
              <span className="is-default">{t('legend.default')}</span>
              <span className="is-roster">{t('legend.roster')}</span>
              <span>• {t('legend.draft')}</span>
            </span>
            <GridFooterSpacer />
            <ListKeysInfo keys={keys} onHelp={onHelp} />
          </GridFooterStrip>
        }
      >
        <NexusGrid<SheetRow>
          fill
          {...SHEET_GRID_OPTIONS}
          undoRedoCellEditing={false}
          cellSelection={editable ? SHEET_CELL_SELECTION : true}
          readOnlyEdit
          rowData={model.rows as SheetRow[]}
          columnDefs={columns}
          defaultColDef={DEFAULT_COLUMN}
          getRowId={getRowId}
          getRowHeight={getRowHeight}
          isFullWidthRow={isFullWidthRow}
          fullWidthCellRenderer={GroupRow}
          rowSelection={rowSelection}
          selectionColumnDef={selectionColumnDef}
          context={context}
          emptyCells="blank"
          onGridReady={onGridReady}
          onCellEditRequest={onCellEditRequest}
          onSelectionChanged={onSelectionChanged}
          onCellSelectionChanged={onCellSelectionChanged}
          onCellFocused={onCellSelectionChanged}
        />
      </GridSheet>
    </div>
  )
}

const DEFAULT_COLUMN: ColDef<SheetRow> = { sortable: false, resizable: false, suppressHeaderMenuButton: true, suppressHeaderContextMenu: true, suppressMovable: true, filter: false }
/** Fill across days and down people: a person's day is copied as it is (never a series). */
const SHEET_CELL_SELECTION = { handle: { mode: 'fill' as const, direction: 'xy' as const } }

/** The sheet's keys, in the footer's one icon and behind `?`. */
export function shiftKeys(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, choices: readonly ShiftChoice[]): ListKey[] {
  const letters = choices.flatMap((choice) => (choice.key ? [`${choice.key}`] : []))
  return [
    { keys: ['↑', '↓', '←', '→'], does: t('keys.arrows') },
    { keys: [...new Set(letters), 'O'], does: t('keys.letters') },
    { keys: ['⌫'], does: t('keys.delete') },
    { keys: ['↵'], does: t('keys.enter') },
    { keys: ['⇧', '↑', '↓', '←', '→'], does: t('keys.range') },
    { keys: ['⌘', 'Z'], does: t('keys.undo') },
    { keys: ['⌘', '⇧', 'Z'], does: t('keys.redo') },
    { keys: ['w'], does: t('keys.why') },
    { keys: ['x'], does: t('keys.select') },
    { keys: ['[', ']'], does: t('keys.move') },
    { keys: ['o'], does: t('keys.overtime') },
    { keys: ['?'], does: t('keys.help') },
  ]
}

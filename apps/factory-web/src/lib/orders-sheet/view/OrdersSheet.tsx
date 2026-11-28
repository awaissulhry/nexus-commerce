'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Hourglass, Lock, TriangleAlert } from 'lucide-react'
import { Button, FilterChip } from '@nexus/ui/primitives'
import { Banner, EmptyState, MetricStrip } from '@nexus/ui/components'
import {
  GridFooterSpacer,
  GridFooterStrip,
  GridSelectionActions,
  GridSheet,
  GridToolbar,
  LoadedRowsSelectionHeader,
  NexusGrid,
  SelectionLabel,
  SHEET_GRID_OPTIONS,
  gridGeometry,
  groupToneClasses,
  groupToneHeaderClasses,
  withGroupHeaderClass,
  type ColDef,
  type ColGroupDef,
  type GridApi,
  type GridReadyEvent,
  type IRowNode,
} from '@nexus/ui/grid'
import { WithMessages } from '../../../record-panels/i18n'
import { useLocale, useT } from '../../i18n/provider'
import { formatNumber, formatTime } from '../../i18n/format'
import { ListKeysInfo } from '../../../list-frame/ListKeysInfo'
import type { ListKey } from '../../../list-frame/model'
import { useRoomWidth } from '../../order-cells/use-room-width'
import { ORDER_LIFE_NS } from '../../order-cells/words'
import { fixedDepartments, type Department } from '../../department/model'
import { sheetIconOf } from '../icons'
import type { GridTone, OrdersSheetProps, SheetColumnId } from '../model'
import {
  COLUMN_GROUP,
  COLUMN_WIDTH,
  GROUP_TONE,
  IDENTITY_WIDTH,
  NUMBER_COLUMNS,
  SHEET_KEYS,
  SHEET_NS,
  TOTALS_ROW,
  askOf,
  cellValueOf,
  commitOf,
  groupsOf,
  heldWhyOf,
  isPhoneRoom,
  mayType,
  saveStateOf,
  sheetRowsOf,
  totalsOf,
  type SaveState,
  type SheetGroup,
  type SheetRow,
} from '../rows'
import { IdentityCell, ValueCell, type SheetContext } from './SheetCells'
import { SheetCards } from './SheetCards'
import '../orders-sheet.css'

/**
 * owb-of3 step 1 — THE ORDERS SHEET (design § 5b, § 5c, § 5h, § 5zi, § 5zj A): ONE part for the office (kind `office`) and the
 * customer's portal (kind `portal`, S1 po7), on the design system's NexusGrid like the Product Edit Studio's grid: a coloured strip
 * of column groups · a pinned first column (chevron, P / C, the picture button, the number as a door, the department, + a piece, the
 * bin on a draft) · P rows (the order) and C rows (each line) · the active cell's ring · cells that save themselves (L2) · a totals
 * row · the foot (rows · Live · last change · the lock sentence · ONE ⓘ with the keys). Every column resizes. On a phone (its own room
 * under 640 px): cards, never the grid. The part has no fetch and knows no route: the door maps its read into the props, answers
 * every typed cell (`onCommit`) and opens every door (`onOpen(target)`); the pictures come from `SheetPicturesProvider`.
 */
export function OrdersSheet(props: OrdersSheetProps) {
  return (
    <WithMessages namespaces={[SHEET_NS, ORDER_LIFE_NS, 'lists', 'department', 'record-picture']}>
      <Sheet {...props} />
    </WithMessages>
  )
}

/** A tile's tone as the strip's small dot (the design system's colour of that tone). */
const ACCENT: Readonly<Record<GridTone, string>> = Object.freeze({ neutral: 'var(--nds-text-3)', info: 'var(--nds-info)', success: 'var(--nds-success)', warning: 'var(--nds-warning)', danger: 'var(--nds-danger)' })

/** The totals row, pinned under the rows (one array, so the grid never draws it again for nothing). */
const PINNED_BOTTOM: SheetRow[] = [TOTALS_ROW]

const DEFAULT_COLUMN: ColDef<SheetRow> = { sortable: false, resizable: true, suppressMovable: true, filter: false, suppressHeaderMenuButton: true, suppressHeaderContextMenu: true }

function Sheet(props: OrdersSheetProps) {
  const t = useT(SHEET_NS)
  const lists = useT('lists')
  const say = useT('department')
  const locale = useLocale()
  const { kind, orders, columns } = props
  const withNew = !!props.onNewOrder
  const propsRef = useRef(props)
  propsRef.current = props
  const apiRef = useRef<GridApi<SheetRow> | null>(null)
  const { ref, value: phone } = useRoomWidth(isPhoneRoom, false)

  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<readonly string[]>([])
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const rows = useMemo(() => sheetRowsOf(orders, shut, withNew), [orders, shut, withNew])
  const totals = useMemo(() => totalsOf(orders, selectedSet), [orders, selectedSet])
  const departments = useMemo(() => new Map(fixedDepartments(say).map((dept) => [dept.no, dept])), [say])
  const department = useCallback((no: number): Department | null => departments.get(no) ?? null, [departments])

  // A selected order that left the page leaves the selection too.
  useEffect(() => {
    const keys = new Set(orders.map((order) => order.key))
    setSelected((current) => (current.every((key) => keys.has(key)) ? current : current.filter((key) => keys.has(key))))
  }, [orders])

  const onToggle = useCallback((orderKey: string) => {
    setShut((current) => {
      const next = new Set(current)
      if (next.has(orderKey)) next.delete(orderKey)
      else next.add(orderKey)
      return next
    })
  }, [])
  const onOpen = useCallback((target: string) => propsRef.current.onOpen(target), [])
  const onNewOrderAt = useCallback((column: SheetColumnId) => {
    void propsRef.current.onNewOrder?.({ column, value: '' })
  }, [])

  const context = useMemo<SheetContext>(() => ({ kind, withNew, shut, totals, t, locale, department, onToggle, onOpen, onNewOrder: onNewOrderAt }), [kind, withNew, shut, totals, t, locale, department, onToggle, onOpen, onNewOrderAt])
  // The cells read the context again when it changes (AG re-reads it only when told).
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.setGridOption('context', context)
    api.refreshCells({ force: true, suppressFlash: true })
  }, [context])

  // ---- typing: ONE commit per typed cell, its answer in the autosave state ------------------------------------------------------
  const commit = useCallback(
    async (row: SheetRow, column: SheetColumnId, raw: string) => {
      const current = propsRef.current
      const plan = commitOf(row, column, raw, current.kind, !!current.onNewOrder)
      if (plan.kind === 'none') return
      if (plan.kind === 'refused') {
        setSave({ kind: 'refused', words: t(`part.refused.${plan.why}`) })
        return
      }
      setSave({ kind: 'saving' })
      try {
        if (plan.kind === 'new') {
          await current.onNewOrder?.(plan.seed)
          setSave({ kind: 'saved' })
          return
        }
        setSave(saveStateOf(await current.onCommit(plan.commit)))
      } catch {
        setSave({ kind: 'refused', words: t('part.refused.failed') })
      }
    },
    [t],
  )
  const onCellEditRequest = useCallback(
    (event: { data?: SheetRow; column?: { getColId(): string }; newValue?: unknown }) => {
      const id = event.column?.getColId() as SheetColumnId | undefined
      if (!event.data || !id || !(id in COLUMN_GROUP)) return
      void commit(event.data, id, event.newValue === null || event.newValue === undefined ? '' : String(event.newValue))
    },
    [commit],
  )
  // Enter on a cell that is a door (not one to type in): the door opens.
  const onCellKeyDown = useCallback((event: { data?: SheetRow; column?: { getColId(): string }; event?: Event | null }) => {
    const key = (event.event as KeyboardEvent | undefined)?.key
    const row = event.data
    const id = event.column?.getColId()
    if (key !== 'Enter' || !row) return
    if (row.kind === 'N' && (id === 'identity' || id === 'customer') && propsRef.current.kind === 'office') onNewOrderAt('customer')
    else if (row.kind === 'P' && row.order && (id === 'identity' || id === 'where')) propsRef.current.onOpen(`open:${row.order.key}`)
  }, [onNewOrderAt])

  // ---- the columns: the strip's bands, the pinned first column, one renderer per data column ---------------------------------------
  const columnDefs = useMemo(() => {
    const groupOf = (colId: string): { group: string; tone?: string } | undefined => {
      if (colId === 'identity') return { group: 'identity', tone: 'slate' }
      if (!(colId in COLUMN_GROUP)) return undefined
      const group = COLUMN_GROUP[colId as SheetColumnId]
      return { group, tone: GROUP_TONE[group] ?? undefined }
    }
    const identity: ColDef<SheetRow> = {
      colId: 'identity',
      headerName: t(kind === 'portal' ? 'part.head.yours' : 'part.head.order'),
      pinned: 'left',
      lockPinned: true,
      width: IDENTITY_WIDTH[kind],
      minWidth: 200,
      editable: false,
      cellRenderer: IdentityCell,
      cellClass: 'fw-osh-cell-id',
    }
    const dataColumn = (id: SheetColumnId): ColDef<SheetRow> => ({
      colId: id,
      headerName: id === 'act' ? '' : t(`part.col.${id}`),
      width: COLUMN_WIDTH[id],
      minWidth: 64,
      valueGetter: (params) => (params.data ? cellValueOf(params.data, id) : ''),
      editable: (params) => !!params.data && mayType(params.data, id, kind, withNew),
      cellEditor: 'agTextCellEditor',
      cellRenderer: ValueCell,
      cellRendererParams: { sheetColumn: id },
      tooltipValueGetter: (params) => {
        const why = params.data ? heldWhyOf(params.data, id, kind) : null
        return why ? t(`part.held.${why}`) : undefined
      },
      cellClass: (params) => {
        const row = params.data
        const classes = ['fw-osh-cell']
        if (NUMBER_COLUMNS.has(id)) classes.push('fw-osh-cell-num')
        if (row && mayType(row, id, kind, withNew)) classes.push('fw-osh-cell-ed')
        if (row && askOf(row, id)) classes.push('fw-osh-cell-asked')
        return classes
      },
    })
    const bands: Array<ColGroupDef<SheetRow>> = [
      { groupId: 'identity', headerName: t(kind === 'portal' ? 'part.group.yours' : 'part.group.orders'), headerClass: groupToneClasses('slate'), children: [identity] },
      ...groupsOf(columns).map(({ group, columns: ids }: { group: SheetGroup; columns: SheetColumnId[] }) => ({
        groupId: `${group}:${ids[0]}`,
        headerName: group === 'act' ? '' : t(`part.group.${group}`),
        headerClass: groupToneClasses(GROUP_TONE[group]),
        children: ids.map(dataColumn),
      })),
    ]
    return withGroupHeaderClass<SheetRow>(bands, (params) => groupToneHeaderClasses(params, groupOf))
  }, [columns, kind, t, withNew])

  const rowSelection = useMemo(
    () =>
      ({
        mode: 'multiRow',
        checkboxes: (params: { data?: SheetRow }) => params.data?.kind === 'P',
        headerCheckbox: false,
        enableClickSelection: false,
        isRowSelectable: (node: IRowNode<SheetRow>) => node.data?.kind === 'P',
      }) as const,
    [],
  )
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false, headerComponent: LoadedRowsSelectionHeader, headerName: lists('selectAll'), pinned: 'left' as const }), [lists])

  // ---- a row another person changed flashes (the door names it) --------------------------------------------------------------------
  const flashKeys = props.live?.flashKeys
  const flashRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    flashRef.current = new Set(flashKeys ?? [])
    const api = apiRef.current
    if (!api || api.isDestroyed() || !flashKeys || flashKeys.length === 0) return
    const nodes = flashKeys.flatMap((key) => {
      const node = api.getRowNode(key)
      return node ? [node] : []
    })
    if (nodes.length > 0) api.redrawRows({ rowNodes: nodes })
  }, [flashKeys])
  const rowClassRules = useMemo(() => ({ 'fw-osh-flash': (params: { data?: SheetRow }) => !!params.data && flashRef.current.has(params.data.key) }), [])
  const getRowClass = useCallback((params: { data?: SheetRow }) => {
    const row = params.data
    if (!row) return undefined
    return `fw-osh-row is-${row.kind.toLowerCase()}${row.order?.life === 'WITHDRAWN' ? ' is-gone' : ''}`
  }, [])
  const getRowId = useCallback((params: { data: SheetRow }) => params.data.key, [])

  const onGridReady = useCallback((event: GridReadyEvent<SheetRow>) => {
    apiRef.current = event.api
  }, [])
  const onSelectionChanged = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    setSelected(api.getSelectedRows().flatMap((row) => (row.kind === 'P' ? [row.key] : [])))
  }, [])
  const clear = useCallback(() => {
    apiRef.current?.deselectAll()
    setSelected([])
  }, [])
  const onCardSelect = useCallback((key: string, on: boolean) => setSelected((current) => (on ? [...new Set([...current, key])] : current.filter((entry) => entry !== key))), [])

  const keys = useMemo<ListKey[]>(() => SHEET_KEYS.map((entry) => ({ keys: [...entry.keys], does: t(`part.keys.${entry.id}`) })), [t])
  const lineCount = orders.reduce((sum, order) => sum + order.lines.length, 0)
  const lastChange = props.live?.lastChange ?? null

  const bulkBar =
    selected.length > 0 ? (
      <GridSelectionActions>
        <span className="fw-osh-selcount">{t('part.selected', { count: selected.length })}</span>
        {props.bulk.map((act) => {
          const Icon = sheetIconOf(act.icon)
          return (
            <Button key={act.id} size="sm" variant={act.primary ? 'primary' : 'secondary'} onClick={() => act.run(selected)}>
              {Icon && <Icon size={14} aria-hidden />}
              <SelectionLabel>{act.words}</SelectionLabel>
            </Button>
          )
        })}
        <Button size="sm" variant="link" onClick={clear}>
          {t('part.clear')}
        </Button>
      </GridSelectionActions>
    ) : null

  return (
    <div className="fw-osh" ref={ref}>
      {props.tiles && props.tiles.length > 0 && (
        <MetricStrip
          size="sm"
          metrics={props.tiles.map((tile) => ({ label: tile.words, value: formatNumber(tile.count, locale), accent: ACCENT[tile.tone], onClick: tile.onPick }))}
        />
      )}
      <div className="fw-osh-filters" role="group" aria-label={t('part.filters')}>
        {props.filters.items.map((item) => (
          <FilterChip key={item.id} pressed={item.id === props.filters.active} count={item.count === undefined ? undefined : formatNumber(item.count, locale)} onClick={() => props.filters.onPick(item.id)}>
            {item.words}
          </FilterChip>
        ))}
      </div>
      {props.error && <Banner tone="danger" title={props.error} />}

      {phone ? (
        <>
          {bulkBar && <div className="fw-osh-cards-bar">{bulkBar}</div>}
          <SheetCards orders={orders} kind={kind} t={t} locale={locale} selected={selectedSet} onSelect={onCardSelect} onOpen={onOpen} />
        </>
      ) : (
        <GridSheet
          density="compact"
          gutter={0}
          toolbar={
            <GridToolbar count={`${t('part.countOrders', { count: orders.length })} · ${t('part.countLines', { count: lineCount })}`} right={<SaveWords save={save} t={t} />}>
              {bulkBar}
            </GridToolbar>
          }
          footer={
            <GridFooterStrip>
              <span>{t('part.foot.rows', { count: orders.length + rows.filter((row) => row.kind === 'C').length })}</span>
              {props.live && (
                <span className="fw-osh-live">
                  <i aria-hidden />
                  {lastChange ? t('part.foot.liveAt', { time: formatTime(lastChange, { locale }) }) : t('part.foot.live')}
                </span>
              )}
              <GridFooterSpacer />
              <span className="fw-osh-lock">
                <Lock size={12} aria-hidden />
                {t(`part.lock.${kind}`)}
              </span>
              <ListKeysInfo keys={keys} />
            </GridFooterStrip>
          }
        >
          <NexusGrid<SheetRow>
            fill
            rows="media"
            {...SHEET_GRID_OPTIONS}
            cellSelection={false}
            undoRedoCellEditing={false}
            readOnlyEdit
            rowData={rows}
            columnDefs={columnDefs}
            defaultColDef={DEFAULT_COLUMN}
            pinnedBottomRowData={PINNED_BOTTOM}
            getRowId={getRowId}
            getRowClass={getRowClass}
            rowClassRules={rowClassRules}
            rowSelection={rowSelection}
            selectionColumnDef={selectionColumnDef}
            context={context}
            emptyCells="blank"
            loading={props.loading && orders.length === 0}
            reloading={props.loading && orders.length > 0}
            emptyState={<EmptyState title={t('part.empty')} />}
            onGridReady={onGridReady}
            onCellEditRequest={onCellEditRequest}
            onCellKeyDown={onCellKeyDown}
            onSelectionChanged={onSelectionChanged}
          />
        </GridSheet>
      )}
    </div>
  )
}

/** The autosave's words: "Autosave on" · "Saving…" · "Saved" · "Asked" · a refusal in words (said to a screen reader too). */
function SaveWords({ save, t }: { save: SaveState; t: (key: string) => string }) {
  const icon = save.kind === 'saving' ? <Hourglass size={12} aria-hidden /> : save.kind === 'refused' ? <TriangleAlert size={12} aria-hidden /> : <Check size={12} aria-hidden />
  const words = save.kind === 'refused' ? save.words : t(`part.save.${save.kind}`)
  return (
    <span className={`fw-osh-save is-${save.kind}`} role="status" aria-live="polite">
      {icon}
      {words}
    </span>
  )
}

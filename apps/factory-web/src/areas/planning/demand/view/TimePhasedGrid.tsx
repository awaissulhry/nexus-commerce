'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronsDownUp, ChevronsUpDown, Download, Search } from 'lucide-react'
import { DetailPopover, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, ExpandToggle, FilterChip, Input, Pill, Tooltip } from '@nexus/ui/primitives'
import type { DemandLayer } from '@nexus/factory-domain/planning/demand/rules'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Demand } from '../api'
import {
  barOf,
  bucketLabel,
  bucketSpan,
  busiest,
  cellLabel,
  cellOf,
  cellRefKey,
  columnBuckets,
  GRID_LAYERS,
  gridLines,
  HELD_LAYERS,
  lineName,
  pieces,
  piecesWords,
  shown,
  toggledLayers,
  type CellRef,
  type GridLine,
  type Words,
} from '../model'
import type { DemandActions, DemandModel } from '../view-model'
import { CellPopover } from './CellPopover'

/** The column a focused grid cell belongs to (Enter opens that cell's popover). */
const focusedColumn = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-cell')?.getAttribute('col-id') ?? null))
/** Enter on the cell's own button is the button's (it opens the popover itself). */
const onOwnButton = (): boolean => typeof document !== 'undefined' && (document.activeElement as HTMLElement | null)?.tagName === 'BUTTON'

interface GridContextValue {
  readonly model: DemandModel
  readonly actions?: DemandActions
  readonly words: Words
  readonly demand: Demand
  readonly layers: readonly DemandLayer[]
  readonly max: number
}

/**
 * The cells read the page's state through a context (AG renders them inside this tree), so a popover that loads or a layer that
 * changes re-renders a cell without re-mounting it: the focus and the open popover stay where they are.
 */
const GridContext = createContext<GridContextValue | null>(null)

/**
 * TimePhasedGrid — the design's "NEW TimePhasedGrid" (planning.demand sec:phased), an area part of Planning (W2b-5: one area,
 * so not a DS part; named in the step's notes): style-colour lines that open to their sizes × the horizon's buckets (the late
 * pieces before them, those without a day after), on the shared list frame. A cell is the pieces of the layers switched on,
 * with a stacked mini bar of the layers (its length against the busiest cell); the cell, or the line's total, opens "What
 * makes this number" (DS DetailPopover: the sources with their documents, each a real link, so ⌘-click opens the source in a
 * new tab). Layers are toggles (FilterChip); brand demand and the forecast are held with their reason (they come with W3).
 * Ticked lines: Open sizes N, Close sizes N, Export N. Enter opens the focused cell's popover.
 */
export function TimePhasedGrid({ model, actions, words }: { model: DemandModel; actions?: DemandActions; words: Words }) {
  const { t, locale } = words
  const demand = model.demand.status === 'ready' ? model.demand.value : null
  const layers = model.controls.layers
  const lines = useMemo(() => (demand ? gridLines(demand.rows, model.open) : null), [demand, model.open])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = demand?.rows.map((row) => row.key).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const [query, setQuery] = useState(model.controls.q)
  useEffect(() => setQuery(model.controls.q), [model.controls.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  const buckets = useMemo(() => (demand ? columnBuckets(demand, layers) : []), [demand, layers])
  const max = useMemo(() => (demand ? busiest(demand.rows, layers) : 0), [demand, layers])
  const bucketsKey = buckets.join(',')
  const horizon = demand?.horizon ?? null

  const columns = useMemo<ColDef<GridLine>[]>(() => {
    if (!horizon) return []
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    return [
      { ...plain, colId: 'line', headerName: t('grid.col.line'), minWidth: 230, flex: 1.6, pinned: 'left', cellRenderer: LineCell },
      { ...plain, colId: 'strategy', headerName: t('grid.col.strategy'), minWidth: 132, flex: 0.8, cellRenderer: StrategyCell },
      { ...plain, colId: 'total', headerName: t('grid.col.total'), headerTooltip: t('grid.col.totalTip'), minWidth: 96, flex: 0.6, cellRenderer: TotalCell },
      ...buckets.map(
        (key) =>
          ({
            ...plain,
            colId: `b:${key}`,
            headerName: bucketLabel(key, horizon, words),
            headerTooltip: bucketSpan(key, horizon, words),
            minWidth: horizon.kind === 'MONTH' ? 104 : 96,
            flex: 0.6,
            cellRenderer: BucketCell,
            cellRendererParams: { bucket: key },
          }) satisfies ColDef<GridLine>,
      ),
    ]
    // The cells read everything else through the context; the columns change only with the buckets and the language.
  }, [bucketsKey, horizon, t, locale])

  const keys: ListKey[] = [
    { keys: ['/'], does: t('keys.search') },
    { keys: ['Enter'], does: t('keys.what') },
    { keys: ['o'], does: t('keys.sizes') },
  ]

  // `o` opens or closes the focused line's sizes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'o' || event.metaKey || event.ctrlKey || event.altKey || model.dialog || model.popover) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return
      const rowId = (document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id')
      const line = lines?.find((entry) => entry.id === rowId)
      if (!line || line.kind !== 'row' || line.row.sizes.length === 0) return
      event.preventDefault()
      latest.current?.onToggleOpen?.([line.id], !model.open.includes(line.id))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lines, model.dialog, model.popover, model.open])

  let state: ReactNode = undefined
  if (model.demand.status === 'error') {
    state = (
      <EmptyState
        title={t('grid.error')}
        description={t(model.demand.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.('demand')}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  } else if (demand && demand.rows.length === 0) {
    state = model.controls.q ? (
      <EmptyState
        title={t('grid.noMatch')}
        description={t('grid.noMatchBody', { q: model.controls.q })}
        action={
          <Button size="sm" onClick={() => actions?.onSearch?.('')}>
            {t('common.clearSearch')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('grid.empty')} description={t('grid.emptyBody')} />
    )
  }

  const picked = (demand?.rows ?? []).filter((row) => selected.includes(row.key))
  const pickedOpen = picked.filter((row) => model.open.includes(row.key))
  const totalPieces = demand ? demand.rows.reduce((sum, row) => sum + shown(row.totals, layers), 0) : 0

  const toggles = (
    <span className="fw-dm-layers" role="group" aria-label={t('layers.label')}>
      {GRID_LAYERS.map((layer) => {
        const on = layers.includes(layer)
        const last = on && layers.length === 1
        return (
          <FilterChip
            key={layer}
            pressed={on}
            aria-disabled={last || undefined}
            aria-description={last ? t('layers.lastHeld') : undefined}
            title={last ? t('layers.lastHeld') : layer === 'QUOTES' ? t('layers.quotesNote') : undefined}
            onClick={() => (last ? undefined : actions?.onLayers?.(toggledLayers(layers, layer)))}
          >
            <span className={`fw-dm-swatch ${layer.toLowerCase()}`} aria-hidden />
            {t(`layer.${layer}`)}
          </FilterChip>
        )
      })}
      {HELD_LAYERS.map((layer) => (
        <Tooltip key={layer} label={t(`layers.held.${layer}`)} portal>
          <FilterChip pressed={false} aria-disabled aria-description={t(`layers.held.${layer}`)}>
            {t(`layer.${layer}`)}
          </FilterChip>
        </Tooltip>
      ))}
    </span>
  )

  return (
    <GridContext.Provider value={demand ? { model, actions, words, demand, layers, max } : null}>
      <ListFrame<GridLine>
        label={t('grid.title')}
        listKey="planning.demand"
        title={t('grid.title')}
        rows={state ? [] : lines}
        rowId={(line) => line.id}
        columns={columns}
        count={demand ? t('grid.count', { count: demand.rows.length, pieces: piecesWords(totalPieces, words) }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('grid.search')}
            placeholder={t('grid.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={toggles}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" aria-label={t('bulk.open', { count: picked.length })} heldReason={picked.every((row) => row.sizes.length === 0) ? t('bulk.noSizes') : null} onClick={() => actions?.onToggleOpen?.(picked.map((row) => row.key), true)}>
                <ChevronsUpDown size={13} aria-hidden /> <SelectionLabel>{t('bulk.open', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.close', { count: pickedOpen.length })} heldReason={pickedOpen.length === 0 ? t('bulk.noneOpen') : null} onClick={() => actions?.onToggleOpen?.(pickedOpen.map((row) => row.key), false)}>
                <ChevronsDownUp size={13} aria-hidden /> <SelectionLabel>{t('bulk.close', { count: pickedOpen.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExportGrid?.(picked.map((row) => row.key))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        isRowSelectable={(line) => (line.kind === 'size' ? t('grid.sizeNotSelectable') : null)}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(line) => {
          if (onOwnButton()) return
          const column = focusedColumn()
          if (column?.startsWith('b:')) {
            const bucket = column.slice(2)
            if (shown(cellOf(line, bucket), layers) > 0) actions?.onCell?.({ lineId: line.id, bucket })
            return
          }
          if (shown(line.totals, layers) > 0) actions?.onCell?.({ lineId: line.id, bucket: null })
        }}
        state={state}
        cards={null}
        rowKind="two-line"
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
    </GridContext.Provider>
  )
}

function useGrid(): GridContextValue | null {
  return useContext(GridContext)
}

function LineCell({ data: line }: ICellRendererParams<GridLine>) {
  const grid = useGrid()
  if (!line || !grid) return null
  const { t } = grid.words
  if (line.kind === 'size') {
    return (
      <span className="fw-dm-line size">
        <span className="fw-dm-ellipsis">{lineName(line, t)}</span>
      </span>
    )
  }
  const open = grid.model.open.includes(line.id)
  const name = lineName(line, t)
  return (
    <span className="fw-dm-line">
      {line.row.sizes.length > 0 ? (
        <ExpandToggle expanded={open} label={t(open ? 'grid.closeSizes' : 'grid.openSizes', { line: name })} onClick={() => grid.actions?.onToggleOpen?.([line.id], !open)} />
      ) : (
        <span className="fw-dm-expand-gap" aria-hidden />
      )}
      <span className="fw-dm-line-text">
        <span className="fw-dm-ellipsis" title={name}>
          {name}
        </span>
        <span className="fw-dm-sub fw-dm-ellipsis">{line.row.style.name}</span>
      </span>
    </span>
  )
}

function StrategyCell({ data: line }: ICellRendererParams<GridLine>) {
  const grid = useGrid()
  if (!line || !grid || line.kind !== 'row') return null
  const { t } = grid.words
  const strategy = line.row.strategy
  return (
    <Pill tone={strategy === 'MAKE_TO_STOCK' ? 'info' : strategy === 'MIXED' ? 'warning' : 'neutral'} title={t(`strategy.hint.${strategy}`)}>
      {t(`strategy.${strategy}`)}
    </Pill>
  )
}

function TotalCell({ data: line }: ICellRendererParams<GridLine>) {
  const grid = useGrid()
  if (!line || !grid) return null
  return <NumberCell line={line} bucket={null} counts={line.totals} grid={grid} total />
}

function BucketCell({ data: line, bucket }: ICellRendererParams<GridLine> & { bucket?: string }) {
  const grid = useGrid()
  if (!line || !grid || !bucket) return null
  return <NumberCell line={line} bucket={bucket} counts={cellOf(line, bucket)} grid={grid} />
}

/** A cell's number and mini bar: the trigger of "What makes this number" (nothing drawn for 0). */
function NumberCell({ line, bucket, counts, grid, total = false }: { line: GridLine; bucket: string | null; counts: Parameters<typeof shown>[0]; grid: GridContextValue; total?: boolean }) {
  const { words, layers, demand, model, actions, max } = grid
  const { t, locale } = words
  const value = shown(counts, layers)
  if (value <= 0) return <span className="fw-dm-zero" aria-hidden />
  const ref: CellRef = { lineId: line.id, bucket }
  const key = cellRefKey(ref)
  const open = model.popover !== null && cellRefKey(model.popover.ref) === key
  const bucketName = bucket ? bucketLabel(bucket, demand.horizon, words) : t('grid.wholeHorizon')
  const label = cellLabel(line, bucketName, counts, layers, words)
  const bar = barOf(counts, layers, total ? Math.max(value, max) : max)
  const late = bucket === 'PAST'
  return (
    <DetailPopover
      trigger={
        <span className={`fw-dm-num${late ? ' late' : ''}${total ? ' total' : ''}`}>
          <span className="fw-dm-value">{pieces(value, locale)}</span>
          {!total && (
            <span className="fw-dm-bar" style={{ width: `${bar.length}%` }} aria-hidden>
              {bar.parts.map((part) => (
                <span key={part.layer} className={`fw-dm-part ${part.layer.toLowerCase()}`} style={{ width: `${part.pct}%` }} />
              ))}
            </span>
          )}
        </span>
      }
      triggerLabel={label}
      triggerClassName="fw-dm-trigger"
      panelClassName="nds-detailpop-scroll"
      label={t('popover.title', { what: `${lineName(line, t)} · ${bucketName}` })}
      hoverDelay={0}
      open={open}
      onOpenChange={(next) => actions?.onCell?.(next ? ref : null)}
    >
      {open && model.popover ? <CellPopover model={model} actions={actions} words={words} line={line} bucketName={bucketName} popover={model.popover} /> : null}
    </DetailPopover>
  )
}

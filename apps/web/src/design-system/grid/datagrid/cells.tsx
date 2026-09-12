'use client'

/**
 * AGD — what AG mounts inside its cells and headers. Every consumer's own markup (`column.render`,
 * `column.total`, `emptyState`, `renderExpanded`, a JSX `label`) is rendered UNCHANGED; these
 * components only decide which legacy `<td>` a cell is — a value, the checkbox, a total, the
 * full-width sub row — and put on AG's elements what the legacy put on `<tr>` / `<td>` / `<th>`
 * (`cellProps` / `rowProps` attributes, the `sel` and `rowClassName` classes).
 *
 * Everything that reads a row is reached through `params.context` — a holder whose `current` the
 * grid rewrites on every render — so a consumer that rebuilds its `columns` array (38 of the 47
 * ads sites do) is honoured without AG's column model ever being touched; the grid asks AG to
 * refresh the cells and the header when those identities change.
 */
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import type { ICellRendererParams, IHeaderParams } from 'ag-grid-community'

import type { Column } from '../../components/DataGrid'
import { ROW_RULE } from './geometry'
import { applyTo, clearFrom, splitElementProps } from './rowDom'
import { isSubRow, isTotalRow, type RowMeta, type SubRow } from './rows'

/** What the renderers read. Rewritten by the grid on every render; read at call time. */
export interface DgContext<T> {
  rowKey: (row: T) => string
  columnsByKey: Map<string, Column<T>>
  /** The row's place in the flattened list (kid / sub / top-level) — undefined for the totals row. */
  metaOf: (d: unknown) => RowMeta | undefined
  isSentinel: (d: unknown) => boolean
  selectable: boolean
  selected: ReadonlySet<string> | undefined
  rowSelectable?: (row: T) => boolean
  rowSelectableHint?: string
  selectAllHint?: string
  selectRowHint?: string
  subRowSelectable: boolean
  allSelected: boolean
  someSelected: boolean
  toggleAll: () => void
  toggleRow: (key: string) => void
  rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement>
  cellProps?: (row: T, column: Column<T>, index: number) => HTMLAttributes<HTMLTableCellElement>
  rowClassName?: (row: T) => string | undefined
  /** A column's index among the VISIBLE data columns — the legacy `ci` handed to `cellProps`. */
  indexOf: (key: string) => number
  /** The first / last DATA column on screen (`first` / `last` marks); live getters on the holder. */
  readonly firstColId: string | null
  readonly lastColId: string | null
  /** A full-width sub row measured its content (null: it unmounted). */
  reportSubHeight: (rowId: string, height: number | null) => void
  /** A totals cell measured its content (null: it unmounted). */
  reportTotalsHeight: (colId: string, height: number | null) => void
}

export interface DgContextHolder<T = unknown> { current: DgContext<T> }

const holderOf = <T,>(p: { context?: unknown }): DgContextHolder<T> => p.context as DgContextHolder<T>
const ctxOf = <T,>(p: { context?: unknown }): DgContext<T> => holderOf<T>(p).current

const cellBoxExtra = (cell: HTMLElement): number => {
  const cs = getComputedStyle(cell)
  return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
}

/**
 * The legacy `<td {...cellProps(row, c, ci)}>` and, from the first data cell of a row, the legacy
 * `<tr {...rowProps(row)} className={[sel, rowClassName(row)]}>`. AG owns both elements, so the
 * attributes are applied by hand after every render of this cell and taken back on unmount.
 */
function useElementProps<T>(p: ICellRendererParams, c: Column<T> | undefined, row: T | null, isFirst: boolean, pinned: boolean): void {
  useLayoutEffect(() => {
    if (pinned || row == null || !c) return
    const ctx = ctxOf<T>(p)
    const cell = p.eGridCell
    applyTo(cell, splitElementProps(ctx.cellProps?.(row, c, ctx.indexOf(c.key)) as Record<string, unknown> | undefined))
    const rowEl = isFirst ? (cell.closest('.ag-row') as HTMLElement | null) : null
    if (rowEl) {
      const split = splitElementProps(ctx.rowProps?.(row) as Record<string, unknown> | undefined)
      const classes = [...split.classes]
      // `sel` composes with `rowClassName` and applies whether or not the grid is `selectable` (DataGrid.tsx:602) —
      // on a top-level row; a child row carried `nds-grid-kid` + `rowClassName` only (DataGrid.tsx:631).
      if (ctx.metaOf(row)?.kind !== 'kid' && ctx.selected?.has(ctx.rowKey(row))) classes.push('sel')
      const own = ctx.rowClassName?.(row)
      if (own) classes.push(...own.split(/\s+/).filter(Boolean))
      applyTo(rowEl, { ...split, classes })
    }
    return () => {
      clearFrom(cell)
      if (rowEl) clearFrom(rowEl)
    }
  })
}

/** The totals cell: `column.total`, measured so the pinned row is exactly as tall as its content. */
function TotalCell({ p, total }: { p: ICellRendererParams; total: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const cell = p.eGridCell
    const colId = p.column?.getColId() ?? ''
    const measure = () => holderOf(p).current.reportTotalsHeight(colId, el.offsetHeight + cellBoxExtra(cell))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      holderOf(p).current.reportTotalsHeight(colId, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.eGridCell, p.column])
  return <div ref={ref} className="nds-dg-total">{total}</div>
}

/** A data cell: `column.render(row)` — or the total in the pinned row. */
export function ValueCellRenderer(p: ICellRendererParams) {
  const ctx = ctxOf<unknown>(p)
  const key = p.colDef?.colId ?? ''
  const c = ctx.columnsByKey.get(key)
  const d = p.data
  const pinned = p.node.rowPinned === 'bottom' || isTotalRow(d)
  const row = d != null && !isSubRow(d) && !isTotalRow(d) ? d : null
  useElementProps(p, c, row, key === ctx.firstColId, pinned)
  if (!c) return null
  if (pinned) return <TotalCell p={p} total={c.total} />
  if (row == null) return null
  return <>{c.render(row)}</>
}

/** The checkbox cell — `td.ck` (DataGrid.tsx:603-611, 632-644), the native 15px box the DS styles. */
export function SelectCellRenderer(p: ICellRendererParams) {
  const ctx = ctxOf<unknown>(p)
  const d = p.data
  if (p.node.rowPinned || d == null || isSubRow(d) || isTotalRow(d)) return null
  const k = ctx.rowKey(d)
  if (ctx.metaOf(d)?.kind === 'kid') {
    // A child's checkbox cell is EMPTY unless `subRowSelectable` — an ad group is acted on through its campaign.
    if (!(ctx.subRowSelectable && (!ctx.rowSelectable || ctx.rowSelectable(d)))) return null
    return <input type="checkbox" checked={ctx.selected?.has(k) ?? false} onChange={() => ctx.toggleRow(k)} title={ctx.selectRowHint} aria-label="Select row" />
  }
  if (ctx.rowSelectable && !ctx.rowSelectable(d)) {
    return <input type="checkbox" checked={false} disabled title={ctx.rowSelectableHint} aria-label={ctx.rowSelectableHint ?? 'Selection unavailable'} />
  }
  return <input type="checkbox" checked={!!ctx.selected?.has(k)} onChange={() => ctx.toggleRow(k)} title={ctx.selectRowHint} aria-label="Select row" />
}

/** The select-all header — `th.ck > input` (DataGrid.tsx:543-554), `indeterminate` set through the ref. */
export function SelectAllHeaderRenderer(p: IHeaderParams) {
  const ctx = ctxOf<unknown>(p)
  return (
    <input
      type="checkbox"
      checked={ctx.allSelected}
      ref={(el) => {
        if (el) el.indeterminate = ctx.someSelected
      }}
      onChange={ctx.toggleAll}
      title={ctx.selectAllHint}
      aria-label="Select all rows"
    />
  )
}

/**
 * A JSX `label` inside the engine's header (AG's `innerHeaderComponent`, so the sort indicator and the
 * column menu stay the engine's). A string label is AG's own `headerName`.
 */
export function LabelHeaderRenderer(p: IHeaderParams) {
  const ctx = ctxOf<unknown>(p)
  const c = ctx.columnsByKey.get(p.column.getColId())
  return <>{c?.label ?? null}</>
}

/**
 * The full-width sub row — `tr.nds-grid-sub > td[colSpan]` (DataGrid.tsx:654): the caller's node inside the
 * adapter's cell, measured so the row is exactly as tall as it (plus the row rule AG draws under it).
 */
export function SubRowRenderer(p: ICellRendererParams) {
  const d = p.data as SubRow<unknown>
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const id = p.node.id ?? ''
    const measure = () => holderOf(p).current.reportSubHeight(id, el.offsetHeight + ROW_RULE)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      holderOf(p).current.reportSubHeight(id, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.node.id])
  return <div ref={ref} className="nds-dg-td nds-dg-sub">{d.node}</div>
}

'use client'

/**
 * AGW — what AG mounts inside its cells. Every consumer's own markup (`renderFirst`, `column.render`,
 * `editMode.fields[].render`) is rendered UNCHANGED; these components only decide which of the
 * legacy `<td>` variants a cell is — skeleton, total, group band, editing, hover-editable, tree —
 * and wrap it in exactly the elements the hand-rolled grid wrapped it in (`.h10-ec` + `.h10-editpen`,
 * `.nds-tree-lead` + `.nds-tree-chev` + `.nds-tree-label`), so the CSS that styled those keeps
 * styling them.
 *
 * Everything that reads a row is reached through `params.context` — a holder whose `current` the
 * grid rewrites on every render — so a consumer that rebuilds its render functions each render is
 * honoured without AG's column model ever being touched; the grid asks AG to refresh the cells
 * when those identities change.
 */
import { memo, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, Pencil } from 'lucide-react'
import type { ICellRendererParams, ITooltipParams } from 'ag-grid-community'

import type { DraftStore } from './drafts'
import { pluralize } from './pipeline'
import type { GridColumn, GridEditField, GridHierarchy } from './types'

/** A skeleton row's data: `{ __skeleton: i }`. A totals row's: `{ __total: true }`. */
export interface SkeletonRow { __skeleton: number }
export interface TotalRow { __total: true; v: number }
export const isSkeletonRow = (d: unknown): d is SkeletonRow => typeof d === 'object' && d !== null && '__skeleton' in (d as object)
export const isTotalRow = (d: unknown): d is TotalRow => typeof d === 'object' && d !== null && '__total' in (d as object)

/** What the renderers read. Rewritten by the grid on every render; read at call time. */
export interface WsContext<T> {
  rowId: (row: T) => string
  renderFirst: (row: T) => ReactNode
  firstSortValue?: (row: T) => string
  firstColLabel: string
  columnsByKey: Map<string, GridColumn<T>>
  /** Rows the totals are computed over (the filtered + searched set, never the page). */
  totalRows: T[]
  totalFirst: ReactNode
  noun: string
  hierarchy?: GridHierarchy<T>
  editing: boolean
  editByKey: Map<string, GridEditField<T>>
  hasEditMode: boolean
  drafts: DraftStore
  openInline: (id: string, key: string, init: string, el: HTMLElement) => void
  groupKeyOf?: (row: T) => string
  groupMeta: ReadonlyMap<string, { label: string; order?: number }>
  isSentinel: (d: unknown) => boolean
}

export interface WsContextHolder<T = unknown> { current: WsContext<T> }

const ctxOf = <T,>(p: { context?: unknown }): WsContext<T> => (p.context as WsContextHolder<T>).current

const Skb = memo(function Skb({ width }: { width: number }) {
  return <span className="skb" style={{ width }} />
})

/**
 * One editable cell: subscribes to ITS draft only, so a keystroke re-renders this input and nothing
 * else. `value` is the legacy `draftValue`: the draft if one exists, else the row's initial.
 */
function EditableCell<T>({ ctx, row, field }: { ctx: WsContext<T>; row: T; field: GridEditField<T> }) {
  const id = ctx.rowId(row)
  const store = ctx.drafts
  const draft = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribeCell(id, field.key, cb), [store, id, field.key]),
    () => store.get(id, field.key),
    () => store.get(id, field.key),
  )
  const set = useCallback((v: string) => store.set(id, field.key, v), [store, id, field.key])
  return <>{field.render(draft ?? field.initial(row), set, row)}</>
}

/** The per-cell hover-edit affordance: the value plus the pencil that opens the popover. */
function withPencil<T>(ctx: WsContext<T>, row: T, key: string, content: ReactNode): ReactNode {
  const f = ctx.editByKey.get(key)
  if (!ctx.hasEditMode || ctx.editing || !f) return content
  const label = key === '__first' ? ctx.firstColLabel : ctx.columnsByKey.get(key)?.label ?? ''
  return (
    <span className="h10-ec">
      {content}
      <button type="button" className="h10-editpen" aria-label={`Edit ${label}`} onClick={(e) => ctx.openInline(ctx.rowId(row), key, f.initial(row), e.currentTarget)}>
        <Pencil size={12} />
      </button>
    </span>
  )
}

/** The identity cell: `renderFirst`, or the tree lead around it, or the edit field, or the total label. */
export function IdentityCellRenderer(p: ICellRendererParams) {
  const ctx = ctxOf<unknown>(p)
  const d = p.data
  if (isSkeletonRow(d)) return <Skb width={170} />
  if (p.node.rowPinned === 'top' || isTotalRow(d)) return <b>{ctx.totalFirst}</b>
  if (d == null) return null
  const row = d
  const id = ctx.rowId(row)
  const ef = ctx.editing ? ctx.editByKey.get('__first') : undefined
  const body = ef ? <EditableCell ctx={ctx} row={row} field={ef} /> : withPencil(ctx, row, '__first', ctx.renderFirst(row))
  const h = ctx.hierarchy
  if (!h) return <>{body}</>
  /* The chevron lives INSIDE the identity cell, so the hierarchy travels with the thing it belongs
     to instead of costing a column. The indent is a spacer element rather than padding on the cell. */
  const open = h.expanded.has(id)
  return (
    <span className="nds-tree-lead" style={{ paddingInlineStart: `${h.depthOf(row) * 18}px` }}>
      {h.expandableOf(row) ? (
        <button
          type="button"
          className={`nds-tree-chev${open ? ' on' : ''}${h.loading?.has(id) ? ' busy' : ''}`}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${String(ctx.firstSortValue?.(row) ?? '')}`.trim()}
          onClick={(e) => { e.stopPropagation(); h.onToggle(row, !open) }}
        >
          <ChevronDown size={13} aria-hidden />
        </button>
      ) : (
        /* A leaf keeps the chevron's width so its label lines up with its siblings'. */
        <span className="nds-tree-chev is-leaf" aria-hidden />
      )}
      <span className="nds-tree-label">{body}</span>
    </span>
  )
}

/** A metric / settings cell: `column.render`, or the edit field, or the total. */
export function ValueCellRenderer(p: ICellRendererParams) {
  const ctx = ctxOf<unknown>(p)
  const key = p.colDef?.colId ?? ''
  const c = ctx.columnsByKey.get(key)
  const d = p.data
  if (isSkeletonRow(d)) return <Skb width={52} />
  if (!c) return null
  if (p.node.rowPinned === 'top' || isTotalRow(d)) {
    const t = typeof c.total === 'function' ? (c.total as (rows: unknown[]) => ReactNode)(ctx.totalRows) : c.total
    return <>{t ?? ''}</>
  }
  if (d == null) return null
  const cf = ctx.editing ? ctx.editByKey.get(key) : undefined
  return cf ? <EditableCell ctx={ctx} row={d} field={cf} /> : <>{withPencil(ctx, d, key, c.render(d))}</>
}

/** The skeleton bar in the selection column while loading (the checkbox otherwise — AG's own). */
export function SelectionSkeletonRenderer() {
  return <Skb width={15} />
}

/** The group band — `tr.h10-am-grp > td` — label and count over the WHOLE group, not the page. */
export function GroupBandRenderer(p: ICellRendererParams) {
  const ctx = ctxOf<unknown>(p)
  const key = String(p.node.key ?? '')
  const label = ctx.groupMeta.get(key)?.label ?? key
  const count = p.node.allChildrenCount ?? 0
  return (
    <div className="nds-ws-td nds-ws-grp">
      <span className="gl">{label}</span>
      <span className="gc">{count} {pluralize(ctx.noun, count)}</span>
    </div>
  )
}

/** A header `tip`, drawn as the DS HoverCard's card (the same class, so the same rules paint it). */
export function HeaderTipRenderer(p: ITooltipParams) {
  const text = p.value == null ? '' : String(p.value)
  if (!text) return null
  return (
    <div className="nds-hovercard-card nds-ws-headtip" role="tooltip">
      <div className="r1">{text}</div>
    </div>
  )
}

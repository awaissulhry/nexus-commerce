'use client'

/**
 * Approvals grid — the columns (PLAN §2): ☐ · Status · What · Product · Change · Where · Asked by · Why / result ·
 * Asked · Expires · Approve / Reject ⋯.
 *
 * The definitions are built ONCE per layout (desktop or phone) and read the page through `handlers` (a ref), so a
 * decision, a busy row or a new error never rebuilds the columns — the page asks AG to redraw the affected cells
 * (`refreshCells`) instead. Every renderer is a DS part: `Pill`, `Countdown`, `AsOf`, `ChangeCell`, `ActionsCell`.
 */
import { memo } from 'react'
import type { QueueRow, QueueState } from '@nexus/shared/approval-queue'

import Link from '@/lib/workspaces/Link'
import { Pill } from '@/design-system/primitives'
import { AsOf, Countdown, type MenuItemDef } from '@/design-system/components'
import {
  EmptyValue,
  actionsColumn,
  changeColumn,
  keepFromGrid,
  type ColDef,
  type ICellRendererParams,
  type RowVerb,
  type RowVerbs,
} from '@/design-system/grid'
import type { QueueActions } from './approvalActions'
import { rowName } from './approvalActions'
import {
  QUEUE_STATE_ORDER,
  approveHeldWhy,
  automateOffer,
  groupKey,
  isCountingDown,
  isPending,
  productText,
  rowVerbIds,
  stateMeta,
  statusText,
  targetCountText,
  whatSubline,
  whereText,
  whyText,
  type QueueGroup,
  type RowVerbId,
} from './queueWords'

/** What the cells need from the page, read at click / render time through a ref. */
export interface QueueGridHandlers {
  actions: QueueActions
  open(row: QueueRow): void
}

export interface HandlersRef {
  readonly current: QueueGridHandlers
}

interface CellParams {
  handlers: HandlersRef
  /** The phone layout: shorter words, the product under "What". */
  phone?: boolean
}

type Cell = ICellRendererParams<QueueRow> & CellParams

/** The hidden columns AG groups by — one per Group option. */
export const GROUP_COLUMN: Record<Exclude<QueueGroup, 'none'>, string> = { kind: 'groupKind', product: 'groupProduct', asker: 'groupAsker' }

/** The columns the Customise dialog lists, in order (the hidden group columns are the Group control's, not its). */
export const PREFERENCE_COLUMNS: ReadonlyArray<{ key: string; label: string; locked?: boolean }> = [
  { key: 'status', label: 'Status', locked: true },
  { key: 'what', label: 'What' },
  { key: 'product', label: 'Product' },
  { key: 'change', label: 'Change' },
  { key: 'where', label: 'Where' },
  { key: 'askedBy', label: 'Asked by' },
  { key: 'why', label: 'Why / result' },
  { key: 'asked', label: 'Asked' },
  { key: 'expires', label: 'Expires' },
  { key: 'actions', label: 'Actions', locked: true },
]

/* ── cells ────────────────────────────────────────────────────────────────────────────────── */

const StatusCell = memo(function StatusCell({ data: row, handlers, phone }: Cell) {
  if (!row) return null
  const meta = stateMeta(row.state)
  if (isCountingDown(row)) {
    const label = row.state === 'starting'
      ? (left: string) => `Runs in ${left}`
      : (left: string) => (phone ? `Held · ${left}` : `On hold · runs in ${left}`)
    return (
      <Pill tone={meta.tone} size="sm">
        <Countdown
          to={row.executeAfter as string}
          label={label}
          doneLabel="Starting…"
          // The stop window ended on screen: ask the server to run it now. It refuses an early call, and its 30 s
          // sweep runs the row anyway — the page never decides that it ran.
          onDone={() => handlers.current.actions.commit(row)}
          announce={false}
        />
      </Pill>
    )
  }
  const text = row.state === 'running' && row.plan ? statusText(row, Date.now()) : meta.label
  return <Pill tone={meta.tone} size="sm" dot>{text}</Pill>
})

const WhatCell = memo(function WhatCell({ data: row, phone }: Cell) {
  if (!row) return null
  const sub = whatSubline(row) ?? (phone ? productText(row.target) || null : null)
  return (
    <span className="aqg-two">
      <span className="aqg-title" title={row.title}>{row.title}</span>
      {sub ? <span className="aqg-sub" title={sub}>{sub}</span> : null}
    </span>
  )
})

const ProductCell = memo(function ProductCell({ data: row }: Cell) {
  const target = row?.target
  if (!target) return <EmptyValue />
  const count = targetCountText(target)
  if (count) {
    return <span className="aqg-title" title={target.sku ? `First: ${target.sku}` : undefined}>{count}</span>
  }
  const head = target.sku ?? target.name ?? ''
  const sub = target.sku && target.name ? target.name : null
  return (
    <span className="aqg-two">
      {target.href ? (
        // A click on the link opens the product, never the row's drawer as well.
        <Link href={target.href} className="aqg-link" title={productText(target)} onClickCapture={keepFromGrid}>{head}</Link>
      ) : (
        <span className="aqg-title" title={productText(target)}>{head}</span>
      )}
      {sub ? <span className="aqg-sub" title={sub}>{sub}</span> : null}
    </span>
  )
})

const WhyCell = memo(function WhyCell({ data: row, handlers }: Cell) {
  if (!row) return null
  // A decision that failed on this row says so here, until the person closes it (the banner above the grid).
  const error = handlers.current.actions.errors.get(row.id)
  if (error) return <span className="aqg-error" title={error}>{error}</span>
  const text = whyText(row)
  if (!text) return <EmptyValue />
  return <span className="aqg-why" title={text}>{text}</span>
})

const AskedCell = memo(function AskedCell({ data: row }: Cell) {
  if (!row) return null
  return <AsOf at={row.requestedAt} kind="event" />
})

const ExpiresCell = memo(function ExpiresCell({ data: row }: Cell) {
  if (!row || !isPending(row.state) || !row.expiresAt) return <EmptyValue />
  return <Countdown to={row.expiresAt} label={(left) => `in ${left}`} doneLabel="now" announce={false} />
})

const TextCell = memo(function TextCell({ value }: Cell) {
  if (value === null || value === undefined || value === '') return <EmptyValue />
  return <span className="aqg-why" title={String(value)}>{String(value)}</span>
})

/* ── the definitions ──────────────────────────────────────────────────────────────────────── */

const stateRank = (state: QueueState | undefined) => (state ? QUEUE_STATE_ORDER.indexOf(state) : 99)
const noSearch = () => ''

export function queueColumns(handlers: HandlersRef, phone: boolean): ColDef<QueueRow>[] {
  const params: CellParams = { handlers, phone }
  const busy = (row: QueueRow) => (handlers.current.actions.busyIds.has(row.id) ? 'Working on it…' : null)
  const named = (verb: string) => (row: QueueRow) => `${verb}: ${rowName(row)}`

  const VERBS: Record<RowVerbId, RowVerb<QueueRow>> = {
    approve: {
      id: 'approve', label: 'Approve', tone: 'primary', ariaLabel: named('Approve'),
      onClick: (row) => void handlers.current.actions.approve(row),
      disabled: (row) => busy(row) ?? approveHeldWhy(row),
    },
    reject: {
      id: 'reject', label: 'Reject', tone: 'danger', ariaLabel: named('Reject'),
      onClick: (row) => void handlers.current.actions.reject(row),
      disabled: busy,
    },
    retry: {
      id: 'retry', label: 'Retry', tone: 'primary', ariaLabel: named('Retry'),
      onClick: (row) => void handlers.current.actions.retry(row),
      disabled: (row) => busy(row) ?? approveHeldWhy(row),
    },
    undo: {
      id: 'undo', label: 'Undo', tone: 'default', ariaLabel: named('Undo'),
      onClick: (row) => void handlers.current.actions.undo(row),
      disabled: busy,
    },
  }
  /* A phone shows ONE verb beside the ⋯ (the second one is the menu's first item): two verbs and the ⋯ are 200 px,
     more than half of a 390 px screen. */
  const verbs = (row: QueueRow): RowVerbs<QueueRow> => {
    const ids = rowVerbIds(row.state)
    if (ids.length === 0) return []
    if (phone || ids.length === 1) return [VERBS[ids[0]]]
    return [VERBS[ids[0]], VERBS[ids[1]]]
  }
  const items = (row: QueueRow): MenuItemDef[] => {
    const out: MenuItemDef[] = [{ id: 'open', label: 'Open details', onSelect: () => handlers.current.open(row) }]
    const held = busy(row)
    const second = phone ? rowVerbIds(row.state)[1] : undefined
    if (second) {
      const verb = VERBS[second]
      const why = verb.disabled?.(row) || null
      out.push({ id: second, label: verb.label, tone: second === 'reject' ? 'danger' : undefined, disabled: !!why, description: why ?? undefined, onSelect: () => verb.onClick?.(row) })
    }
    if (row.state === 'starting') {
      out.push({ id: 'hold', label: 'Hold 10 min', disabled: !!held, description: held ?? undefined, onSelect: () => void handlers.current.actions.hold(row) })
    }
    const automate = automateOffer(row)
    if (automate.offered) {
      out.push({
        id: 'automate', label: 'Automate this kind…', disabled: !!automate.heldWhy, description: automate.heldWhy ?? undefined,
        onSelect: () => handlers.current.actions.openAutomate(row),
      })
    }
    return out
  }

  const status: ColDef<QueueRow> = {
    colId: 'status', headerName: 'Status', width: phone ? 112 : 176, cellClass: 'nds-ag-cell',
    cellRenderer: StatusCell, cellRendererParams: params,
    valueGetter: (p) => (p.data ? statusText(p.data, Date.now()) : ''),
    comparator: (_a, _b, nodeA, nodeB) => stateRank(nodeA?.data?.state) - stateRank(nodeB?.data?.state),
  }
  const what: ColDef<QueueRow> = {
    colId: 'what', headerName: 'What', cellClass: 'nds-ag-cell', cellRenderer: WhatCell, cellRendererParams: params,
    ...(phone ? { flex: 1, minWidth: 120 } : { width: 200 }),
    valueGetter: (p) => (p.data ? [p.data.title, whatSubline(p.data)].filter(Boolean).join(' · ') : ''),
    // The phone cell shows the product too, so the search finds it there.
    getQuickFilterText: (p) => (p.data ? [p.data.title, whatSubline(p.data), phone ? productText(p.data.target) : ''].filter(Boolean).join(' ') : ''),
  }
  const actions = actionsColumn<QueueRow>({
    primary: verbs,
    items,
    menuLabel: (row) => `More actions for ${rowName(row)}`,
    width: phone ? 120 : 200,
  })
  const groups: ColDef<QueueRow>[] = (Object.entries(GROUP_COLUMN) as Array<[Exclude<QueueGroup, 'none'>, string]>).map(([group, colId]) => ({
    colId,
    headerName: group === 'kind' ? 'Kind' : group === 'product' ? 'Product' : 'Asked by',
    hide: true,
    lockVisible: true,
    enableRowGroup: true,
    getQuickFilterText: noSearch,
    valueGetter: (p) => (p.data ? groupKey(p.data, group) : ''),
  }))

  if (phone) return [status, what, actions, ...groups]

  return [
    status,
    what,
    {
      colId: 'product', headerName: 'Product', width: 220, cellClass: 'nds-ag-cell', cellRenderer: ProductCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? productText(p.data.target) : ''),
    },
    {
      colId: 'change', headerName: 'Change', width: 220, ...changeColumn<QueueRow>('changes'),
      valueGetter: (p) => (p.data ? { changes: p.data.changes, more: Math.max(0, p.data.changeCount - p.data.changes.length) } : null),
    },
    {
      colId: 'where', headerName: 'Where', width: 116, cellClass: 'nds-ag-cell', cellRenderer: TextCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? whereText(p.data) : null),
    },
    {
      colId: 'askedBy', headerName: 'Asked by', width: 150, cellClass: 'nds-ag-cell', cellRenderer: TextCell, cellRendererParams: params,
      valueGetter: (p) => p.data?.asker.label ?? null,
    },
    {
      colId: 'why', headerName: 'Why / result', flex: 1, minWidth: 240, cellClass: 'nds-ag-cell', cellRenderer: WhyCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? whyText(p.data) : null),
      tooltipValueGetter: (p) => (p.data ? handlers.current.actions.errors.get(p.data.id) ?? whyText(p.data) ?? undefined : undefined),
    },
    {
      colId: 'asked', headerName: 'Asked', width: 120, cellClass: 'nds-ag-cell', cellRenderer: AskedCell, cellRendererParams: params,
      valueGetter: (p) => p.data?.requestedAt ?? null,
      getQuickFilterText: noSearch,
    },
    {
      colId: 'expires', headerName: 'Expires', width: 108, cellClass: 'nds-ag-cell', cellRenderer: ExpiresCell, cellRendererParams: params,
      valueGetter: (p) => (p.data && isPending(p.data.state) ? p.data.expiresAt : null),
      getQuickFilterText: noSearch,
    },
    actions,
    ...groups,
  ]
}

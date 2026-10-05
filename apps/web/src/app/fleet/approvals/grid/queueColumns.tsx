'use client'

/**
 * Approvals grid — the columns (PLAN §2). Desktop: ☐ · Status · What (where, under it) · Product · Change · Why / result
 * · Asked by · Asked · Expires · Approve / Reject ⋯; the key facts fit 1280 px without sideways scrolling, the rest may
 * scroll, and Where is a column of its own only when Customise shows it. Phone (< 640 px): Request · one verb.
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
  ChangeValue,
  EmptyValue,
  actionsColumn,
  asChangeValueData,
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
  changeHidesLabel,
  groupKey,
  isCountingDown,
  isPending,
  productText,
  requestSubline,
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
  /** The phone layout: shorter words. */
  phone?: boolean
}

type Cell = ICellRendererParams<QueueRow> & CellParams

/** The hidden columns AG groups by — one per Group option. */
export const GROUP_COLUMN: Record<Exclude<QueueGroup, 'none'>, string> = { kind: 'groupKind', product: 'groupProduct', asker: 'groupAsker' }

/**
 * The columns the Customise dialog lists, in order (the hidden group columns are the Group control's, not its). `hidden`:
 * off until the person shows it — Where, whose words already sit under What.
 */
export const PREFERENCE_COLUMNS: ReadonlyArray<{ key: string; label: string; locked?: boolean; hidden?: boolean }> = [
  { key: 'status', label: 'Status', locked: true },
  { key: 'what', label: 'What' },
  { key: 'product', label: 'Product' },
  { key: 'change', label: 'Change' },
  { key: 'why', label: 'Why / result' },
  { key: 'askedBy', label: 'Asked by' },
  { key: 'asked', label: 'Asked' },
  { key: 'expires', label: 'Expires' },
  { key: 'where', label: 'Where', hidden: true },
  { key: 'actions', label: 'Actions', locked: true },
]

/**
 * Desktop widths. At 1280 px the card is ~1164 px and the pinned actions take 200, so ☐ (~44) + Status + What + Product
 * + Change (its minimum) + Why fit the ~964 px left without sideways scrolling; Asked by, Asked and Expires may scroll.
 */
export const DESKTOP_WIDTHS = { status: 140, what: 176, product: 192, changeMin: 176, why: 232, actions: 200 } as const
/** Phone: one verb (Approve is the widest, 75 px) and the cell's padding. */
export const PHONE_ACTIONS_WIDTH = 104

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
  // A phone leaves out the dot: its Request cell needs the room for the kind, and the label says the status.
  return <Pill tone={meta.tone} size="sm" dot={!phone}>{text}</Pill>
})

const WhatCell = memo(function WhatCell({ data: row }: Cell) {
  if (!row) return null
  const sub = whatSubline(row)
  return (
    <span className="aqg-two">
      <span className="aqg-title" title={row.title}>{row.title}</span>
      {sub ? <span className="aqg-sub" title={sub}>{sub}</span> : null}
    </span>
  )
})

/** Phone: the status and the kind on one line, the product's SKU (or a plan's progress) under them. */
const RequestCell = memo(function RequestCell(p: Cell) {
  const row = p.data
  if (!row) return null
  const sub = requestSubline(row)
  return (
    <span className="aqg-two">
      <span className="aqg-head">
        <span className="aqg-pill"><StatusCell {...p} /></span>
        <span className="aqg-title" title={row.title}>{row.title}</span>
      </span>
      {sub ? <span className="aqg-sub" title={sub}>{sub}</span> : null}
    </span>
  )
})

/** Before → after; one change line drops its label (What names it), so the values themselves fit the cell. */
const ChangeCellQ = memo(function ChangeCellQ({ data: row, value }: Cell) {
  const data = asChangeValueData(value)
  if (!row || !data || (data.changes.length === 0 && !data.more)) return <EmptyValue />
  return <ChangeValue changes={data.changes} more={data.more} compact hideLabels={changeHidesLabel(row)} />
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
  if (error) return <span className="aqg-error aqg-clamp">{error}</span>
  const text = whyText(row)
  if (!text) return <EmptyValue />
  // Two lines, so a failure reason can be read in the row; the column's tooltip has all of it.
  return <span className="aqg-why aqg-clamp">{text}</span>
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
  /* A phone shows ONE verb and no ⋯: the grid is ~274 px wide there, and a tap on the row opens the drawer, which has
     every verb (Reject, Hold, Automate…). */
  const verbs = (row: QueueRow): RowVerbs<QueueRow> => {
    const ids = rowVerbIds(row.state)
    if (ids.length === 0) return []
    if (phone || ids.length === 1) return [VERBS[ids[0]]]
    return [VERBS[ids[0]], VERBS[ids[1]]]
  }
  const items = (row: QueueRow): MenuItemDef[] => {
    const out: MenuItemDef[] = [{ id: 'open', label: 'Open details', onSelect: () => handlers.current.open(row) }]
    const held = busy(row)
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
    colId: 'status', headerName: 'Status', width: DESKTOP_WIDTHS.status, cellClass: 'nds-ag-cell',
    cellRenderer: StatusCell, cellRendererParams: params,
    valueGetter: (p) => (p.data ? statusText(p.data, Date.now()) : ''),
    comparator: (_a, _b, nodeA, nodeB) => stateRank(nodeA?.data?.state) - stateRank(nodeB?.data?.state),
  }
  const actions = actionsColumn<QueueRow>({
    primary: verbs,
    // No ⋯ on a phone: the row opens the drawer.
    ...(phone ? {} : { items }),
    menuLabel: (row) => `More actions for ${rowName(row)}`,
    width: phone ? PHONE_ACTIONS_WIDTH : DESKTOP_WIDTHS.actions,
  })
  const groups: ColDef<QueueRow>[] = (Object.entries(GROUP_COLUMN) as Array<[Exclude<QueueGroup, 'none'>, string]>).map(([group, colId]) => ({
    colId,
    headerName: group === 'kind' ? 'Kind' : group === 'product' ? 'Product' : 'Asked by',
    hide: true,
    lockVisible: true,
    enableRowGroup: true,
    valueGetter: (p) => (p.data ? groupKey(p.data, group) : ''),
  }))

  if (phone) {
    const request: ColDef<QueueRow> = {
      colId: 'request', headerName: 'Request', flex: 1, minWidth: 0, cellClass: 'nds-ag-cell',
      cellRenderer: RequestCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? [statusText(p.data, Date.now()), p.data.title, requestSubline(p.data)].filter(Boolean).join(' · ') : ''),
      comparator: (_a, _b, nodeA, nodeB) => stateRank(nodeA?.data?.state) - stateRank(nodeB?.data?.state),
    }
    return [request, actions, ...groups]
  }

  return [
    status,
    {
      colId: 'what', headerName: 'What', width: DESKTOP_WIDTHS.what, cellClass: 'nds-ag-cell', cellRenderer: WhatCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? [p.data.title, whatSubline(p.data)].filter(Boolean).join(' · ') : ''),
    },
    {
      colId: 'product', headerName: 'Product', width: DESKTOP_WIDTHS.product, cellClass: 'nds-ag-cell', cellRenderer: ProductCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? productText(p.data.target) : ''),
    },
    {
      colId: 'change', headerName: 'Change', ...changeColumn<QueueRow>('changes'), flex: 1, minWidth: DESKTOP_WIDTHS.changeMin,
      cellRenderer: ChangeCellQ, cellRendererParams: params,
      valueGetter: (p) => (p.data ? { changes: p.data.changes, more: Math.max(0, p.data.changeCount - p.data.changes.length) } : null),
    },
    {
      colId: 'why', headerName: 'Why / result', width: DESKTOP_WIDTHS.why, cellClass: 'nds-ag-cell', cellRenderer: WhyCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? whyText(p.data) : null),
      tooltipValueGetter: (p) => (p.data ? handlers.current.actions.errors.get(p.data.id) ?? whyText(p.data) ?? undefined : undefined),
    },
    {
      colId: 'askedBy', headerName: 'Asked by', width: 150, cellClass: 'nds-ag-cell', cellRenderer: TextCell, cellRendererParams: params,
      valueGetter: (p) => p.data?.asker.label ?? null,
    },
    {
      colId: 'asked', headerName: 'Asked', width: 120, cellClass: 'nds-ag-cell', cellRenderer: AskedCell, cellRendererParams: params,
      valueGetter: (p) => p.data?.requestedAt ?? null,
    },
    {
      colId: 'expires', headerName: 'Expires', width: 108, cellClass: 'nds-ag-cell', cellRenderer: ExpiresCell, cellRendererParams: params,
      valueGetter: (p) => (p.data && isPending(p.data.state) ? p.data.expiresAt : null),
    },
    {
      // Hidden by default: What's second line says where. Customise shows it.
      colId: 'where', headerName: 'Where', width: 116, hide: true, cellClass: 'nds-ag-cell', cellRenderer: TextCell, cellRendererParams: params,
      valueGetter: (p) => (p.data ? whereText(p.data) : null),
    },
    actions,
    ...groups,
  ]
}

'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import type { WorklistRow } from '../api'
import { blocksOf, chaseVerbHeld, DEPTH, laterDays, laterPhrase, type DepthCan, type LineBlocks, type WorklistPart } from '../model'
import { useDay, useDepthSay } from './words'

/** The "Confirmed later than needed" tile (design sec:tiles W2b): the count, "at least" when not every open line was read, '—' when unknown. */
export function confirmedLateTile(part: WorklistPart | null | undefined, words: (key: string, params?: Record<string, string | number>) => string): string {
  if (!part || part.status !== 'ready') return '—'
  return part.complete ? String(part.confirmedLate) : words('tile.atLeast', { count: part.confirmedLate })
}

/**
 * "What it blocks" on the PO list (design sec:grid "What it blocks (W2b): WOs and customer orders"): the customer and work
 * orders the order's late or unconfirmed lines put at risk, the first numbers as links, how many and the most days late;
 * nothing at risk in words; '—' while the worklist is unknown (never "nothing").
 */
export function OrderBlocksCell({ blocks, known, prefix }: { blocks: LineBlocks | undefined; known: boolean; prefix: string }) {
  const t = useT(DEPTH)
  if (!known) return <span className="fw-by-cell-sub">—</span>
  if (!blocks || (blocks.salesOrders.length === 0 && blocks.workOrders.length === 0)) return <span className="fw-by-cell-sub">{t('blocks.nothingAtRisk')}</span>
  const entries = [...blocks.salesOrders.map((entry) => ({ ...entry, href: `${prefix}/sales/orders/${entry.id}` })), ...blocks.workOrders.map((entry) => ({ ...entry, href: `${prefix}/production/work-orders/${entry.id}` }))]
  return (
    <span className="fw-by-cell">
      <span className="fw-pod-blocks">
        {entries.slice(0, 2).map((entry) => (
          <Link key={entry.id} className="fw-by-link" href={entry.href}>
            {entry.number}
          </Link>
        ))}
        {entries.length > 2 && <span className="fw-by-cell-sub">{t('blocks.more', { count: entries.length - 2 })}</span>}
      </span>
      <span className="fw-by-cell-sub fw-by-danger fw-by-ellipsis">
        {t('blocks.atRisk', { what: [blocks.salesOrders.length ? t('blocks.sales', { count: blocks.salesOrders.length }) : null, blocks.workOrders.length ? t('blocks.work', { count: blocks.workOrders.length }) : null].filter(Boolean).join(', '), days: blocks.lateBy })}
      </span>
    </span>
  )
}

/** One worklist row's id: a line, or its next delivery. */
export const lateRowId = (row: WorklistRow): string => `${row.lineId}:${row.nextDelivery?.seq ?? 0}`

/**
 * Rows ▾ / the tile "Confirmed later than needed" (B-W2b-305's worklist, reason CONFIRMED_LATE): each line the supplier
 * confirmed for a day after the one asked — the PO (to its Delivery schedule), supplier, line and material, asked, the
 * supplier's day and how many days later, what it puts at risk — on the list frame (select-all, shift range, x; Export N),
 * the row's ⋯ Open the delivery schedule · Chase. The rest of the list is the PO list (Rows ▾ All).
 */
export function ConfirmedLateSection({ part, more, can, prefix, selected: initial, tools, actions }: { part: { rows: readonly WorklistRow[] | null; problem: string | null }; more: boolean; can: Pick<DepthCan, 'send'>; prefix: string; selected?: readonly string[]; /** The list's Rows ▾ (back to the orders). */ tools?: ReactNode; actions?: { onMore?: () => void; onRetry?: () => void; onExport?: (rows: WorklistRow[]) => void; onChase?: (row: WorklistRow) => void; onOpen?: (row: WorklistRow) => void } }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const day = useDay()
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(initial ?? [])
  const rows = part.rows
  const rowId = lateRowId

  const columns = useMemo<ColDef<WorklistRow>[]>(() => {
    const href = (row: WorklistRow) => `${prefix}/purchasing/orders/${row.purchaseOrderId}?tab=schedule`
    const OrderCell = ({ data }: ICellRendererParams<WorklistRow>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-by-cell-sub">{data.supplierName}</span>
        </span>
      ) : null
    const LineCell = ({ data }: ICellRendererParams<WorklistRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">{`${data.seq} · ${data.item.code} ${data.item.name}`}</span>
          <span className="fw-by-cell-sub">{[data.colour ? `${data.colour.code} ${data.colour.name}` : null, data.nextDelivery ? t('late.next', { n: data.nextDelivery.seq }) : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    // A scheduled line: its next delivery's days when that one is the later; else the later delivery is on its schedule.
    const AskedCell = ({ data }: ICellRendererParams<WorklistRow>) => (data ? <span>{day(laterDays(data).asked)}</span> : null)
    const TheirsCell = ({ data }: ICellRendererParams<WorklistRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{laterDays(data).theirs ? day(laterDays(data).theirs) : t('late.onSchedule')}</span>
          <span>
            <Pill tone="danger">{say(laterPhrase(data.confirmedLaterBy))}</Pill>
          </span>
        </span>
      ) : null
    const OpenCell = ({ data }: ICellRendererParams<WorklistRow>) => (data ? <span className="fw-by-num">{data.baseUom ? `${quantity(data.outstandingBase, locale)} ${tb(`uom.${data.baseUom}`)}` : quantity(data.outstandingBase, locale)}</span> : null)
    const BlocksCell = ({ data }: ICellRendererParams<WorklistRow>) => (data ? <OrderBlocksCell blocks={blocksOf(data.blocks.entries.filter((entry) => entry.lateBy > 0))} known prefix={prefix} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<WorklistRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('late.rowMenu', { number: data.number, seq: data.seq }) }}
          items={[
            { id: 'open', label: t('late.openSchedule'), href: href(data) },
            ...(chaseVerbHeld(data.status, can) === null ? [{ id: 'chase', label: t('chase.open'), onSelect: () => actions?.onChase?.(data) }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'order', headerName: t('late.col.order'), minWidth: 170, flex: 1.1, cellRenderer: OrderCell },
      { colId: 'line', headerName: t('late.col.line'), minWidth: 220, flex: 1.6, cellRenderer: LineCell },
      { colId: 'asked', headerName: t('late.col.asked'), minWidth: 120, flex: 0.8, cellRenderer: AskedCell },
      { colId: 'theirs', headerName: t('late.col.theirs'), minWidth: 170, flex: 1, cellRenderer: TheirsCell },
      { colId: 'open', headerName: t('late.col.open'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: OpenCell },
      { colId: 'blocks', headerName: t('blocks.colList'), minWidth: 200, flex: 1.3, cellRenderer: BlocksCell },
      { colId: 'more', headerName: tb('po.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, tb, locale, prefix, can])

  const picked = (rows ?? []).filter((row) => selected.includes(rowId(row)))
  const state = part.problem ? (
    <EmptyState title={t('late.failed')} description={tb(part.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tb('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('late.empty')} description={t('late.emptyBody')} />
  ) : undefined
  return (
    <ListFrame<WorklistRow>
      label={t('late.tableLabel')}
      rows={state ? [] : rows}
      rowId={rowId}
      columns={columns}
      count={rows ? t('late.count', { count: rows.length }) : '—'}
      listKey={null}
      tools={tools}
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <Button size="sm" aria-label={tb('po.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
            <Download size={13} aria-hidden /> <SelectionLabel>{tb('po.bulk.export', { count: picked.length })}</SelectionLabel>
          </Button>
        ),
      }}
      more={more && rows && rows.length > 0 ? { label: tb('common.more'), onMore: () => actions?.onMore?.() } : null}
      onOpen={(row) => actions?.onOpen?.(row)}
      state={state}
    />
  )
}

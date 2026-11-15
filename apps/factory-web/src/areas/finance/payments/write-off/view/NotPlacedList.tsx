'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../riba/depth'
import type { UnappliedPayment } from '../api'

export interface NotPlacedListModel {
  prefix: string
  price: boolean
  items: UnappliedPayment[] | null
  more: boolean
  problem: string | null
  /** Design cases: the starting selection. */
  selected?: string[]
}

export interface NotPlacedListActions {
  onRetry?: () => void
  onMore?: () => void
  onExport?: (ids: string[]) => void
  onOpen?: (row: UnappliedPayment) => void
}

/**
 * Payments › Rows ▾ Not placed (the tile "Not placed on an invoice", design finance.payments sec:tiles; B-W2b-393's unapplied
 * queue): every payment with money not placed yet, the longest waiting first — the day it came and its bank reference,
 * the customer, what came and what is not placed, how long it waits, how many open items the customer has, whether the
 * difference is within the write-off tolerance, and the bank line it came from — on the shared list frame (select-all,
 * shift range, x; Export N; keys only in the footer's info icon). A row opens the payment, where it is placed, refunded or
 * written off. Amounts only with the price grain.
 */
export function NotPlacedList(props: { model: NotPlacedListModel; actions?: NotPlacedListActions; tools: ReactNode; keys: readonly ListKey[]; onHelp: () => void }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <List {...props} />
    </WithMessages>
  )
}

function List({ model, actions, tools, keys, onHelp }: { model: NotPlacedListModel; actions?: NotPlacedListActions; tools: ReactNode; keys: readonly ListKey[]; onHelp: () => void }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = model.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef(model.prefix)
  latest.current = model.prefix

  const columns = useMemo<ColDef<UnappliedPayment>[]>(() => {
    const day = (value: string) => formatDate(dayInstant(value), { locale })
    const href = (row: UnappliedPayment) => `${latest.current}/finance/payments/${row.id}`
    const DateCell = ({ data }: ICellRendererParams<UnappliedPayment>) =>
      data ? (
        <span className="fw-fin-cell">
          <Link className="fw-fin-link" href={href(data)}>
            {day(data.receivedOn)}
          </Link>
          <span className="fw-fin-cell-sub fw-fin-code">{data.externalRef}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<UnappliedPayment>) => (data ? <span className="fw-fin-ellipsis">{data.party.legalName}</span> : null)
    const amount = (field: 'amount' | 'unplacedAmount') => ({ data }: ICellRendererParams<UnappliedPayment>) => (data ? <span className="fw-fin-num">{money(data[field], data.currency, locale)}</span> : null)
    const WaitCell = ({ data }: ICellRendererParams<UnappliedPayment>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{p('notPlaced.waiting', { count: data.waitingDays })}</span>
          <span className="fw-fin-cell-sub">{data.openItems === 0 ? p('notPlaced.noOpenItems') : p('notPlaced.openItems', { count: data.openItems })}</span>
        </span>
      ) : null
    const WriteOffCell = ({ data }: ICellRendererParams<UnappliedPayment>) => (data ? data.writeOffWithinTolerance ? <Pill tone="info">{p('notPlaced.withinTolerance')}</Pill> : <span>—</span> : null)
    const BankCell = ({ data }: ICellRendererParams<UnappliedPayment>) => (data ? <span>{data.bankLine ? p('notPlaced.bankLine', { date: day(data.bankLine.bookedOn) }) : p('notPlaced.byHand')}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<UnappliedPayment>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': p('notPlaced.rowMenu', { reference: data.externalRef }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
          ]}
        />
      ) : null
    return [
      { colId: 'date', headerName: t('col.receivedOn'), minWidth: 140, flex: 0.9, cellRenderer: DateCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 160, flex: 1.3, cellRenderer: CustomerCell },
      ...(model.price
        ? [
            { colId: 'amount', headerName: t('col.amount'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: amount('amount') },
            { colId: 'unplaced', headerName: t('col.notPlaced'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: amount('unplacedAmount') },
          ]
        : []),
      { colId: 'waiting', headerName: p('notPlaced.col.waiting'), minWidth: 150, flex: 1, cellRenderer: WaitCell },
      { colId: 'writeOff', headerName: p('notPlaced.col.writeOff'), minWidth: 150, flex: 0.9, cellRenderer: WriteOffCell },
      { colId: 'bank', headerName: p('notPlaced.col.bank'), minWidth: 150, flex: 0.9, cellRenderer: BankCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [p, t, locale, model.price])

  const items = model.items
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const state = model.problem ? (
    <EmptyState title={p('notPlaced.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={p('notPlaced.empty.title')} description={p('notPlaced.empty.body')} />
  ) : undefined
  return (
    <ListFrame<UnappliedPayment>
      label={p('notPlaced.title')}
      rows={state ? [] : items}
      rowId={(row) => row.id}
      columns={columns}
      count={items ? p(model.more ? 'notPlaced.countMore' : 'notPlaced.count', { count: items.length }) : '—'}
      tools={tools}
      listKey="finance.payments.not-placed"
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
            <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
          </Button>
        ),
      }}
      more={model.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
      keys={keys}
      onHelp={onHelp}
      onOpen={(row) => actions?.onOpen?.(row)}
      state={state}
    />
  )
}

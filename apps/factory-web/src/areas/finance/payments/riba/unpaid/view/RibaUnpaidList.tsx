'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../../_shared/model'
import type { RibaUnpaidItem } from '../../api'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../depth'

export interface RibaUnpaidListModel {
  prefix: string
  price: boolean
  items: RibaUnpaidItem[] | null
  problem: string | null
  /** Design cases: the starting selection. */
  selected?: string[]
}

export interface RibaUnpaidListActions {
  onRetry?: () => void
  onExport?: (ids: string[]) => void
  /** Enter on a row: its invoice. */
  onOpen?: (row: RibaUnpaidItem) => void
}

/**
 * Payments › Rows ▾ Ri.Ba. unpaid (the tile "Ri.Ba. unpaid", design finance.payments sec:tiles): the instalments the bank
 * reported as come back unpaid whose invoice is still open and not presented again — the customer, the invoice and
 * instalment, its due day, the day it came back (and how long ago), what it asked, the bank's fee and what the invoice
 * still owes — on the shared list frame (select-all, shift range, x; Export N; keys only in the footer's info icon). The
 * fee is the company's to charge: the invoice's ⋯ Debit note… (its VAT is the accountant's). Amounts only with the price
 * grain.
 */
export function RibaUnpaidList(props: { model: RibaUnpaidListModel; actions?: RibaUnpaidListActions; tools: ReactNode; keys: readonly ListKey[]; onHelp: () => void }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <List {...props} />
    </WithMessages>
  )
}

function List({ model, actions, tools, keys, onHelp }: { model: RibaUnpaidListModel; actions?: RibaUnpaidListActions; tools: ReactNode; keys: readonly ListKey[]; onHelp: () => void }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = model.items?.map((row) => row.itemId).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef(model.prefix)
  latest.current = model.prefix

  const columns = useMemo<ColDef<RibaUnpaidItem>[]>(() => {
    const day = (value: string) => formatDate(dayInstant(value), { locale })
    const href = (row: RibaUnpaidItem) => `${latest.current}/finance/invoices/${row.invoice.id}`
    const InvoiceCell = ({ data }: ICellRendererParams<RibaUnpaidItem>) =>
      data ? (
        <span className="fw-fin-cell">
          <Link className="fw-fin-link" href={href(data)}>
            {p('riba.candidates.invoice', { number: data.invoice.number ?? '—', instalment: data.instalment })}
          </Link>
          <span className="fw-fin-cell-sub">{p('riba.candidates.due', { date: day(data.dueDate) })}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<RibaUnpaidItem>) => (data ? <span className="fw-fin-ellipsis">{data.customer.name}</span> : null)
    const BackCell = ({ data }: ICellRendererParams<RibaUnpaidItem>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{day(data.settledOn)}</span>
          <span className="fw-fin-cell-sub">{p('ribaUnpaid.daysSince', { count: data.daysSince })}</span>
        </span>
      ) : null
    const amount = (field: 'amount' | 'unpaidFee' | 'invoiceOpen') => ({ data }: ICellRendererParams<RibaUnpaidItem>) => (data ? <span className="fw-fin-num">{money(data[field], data.currency, locale)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<RibaUnpaidItem>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': p('ribaUnpaid.rowMenu', { invoice: data.invoice.number ?? '—' }) }}
          items={[
            { id: 'invoice', label: p('ribaUnpaid.openInvoice'), href: href(data) },
            { id: 'batch', label: p('ribaUnpaid.openBatch'), href: `${latest.current}/finance/payments?riba=${data.batchId}` },
          ]}
        />
      ) : null
    return [
      { colId: 'invoice', headerName: p('riba.col.invoice'), minWidth: 170, flex: 1.1, cellRenderer: InvoiceCell },
      { colId: 'customer', headerName: p('riba.col.customer'), minWidth: 160, flex: 1.2, cellRenderer: CustomerCell },
      { colId: 'back', headerName: p('ribaUnpaid.col.back'), minWidth: 140, flex: 0.9, cellRenderer: BackCell },
      ...(model.price
        ? [
            { colId: 'amount', headerName: p('riba.col.amount'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: amount('amount') },
            { colId: 'fee', headerName: p('ribaUnpaid.col.fee'), minWidth: 100, flex: 0.7, type: 'rightAligned', cellRenderer: amount('unpaidFee') },
            { colId: 'open', headerName: p('ribaUnpaid.col.open'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: amount('invoiceOpen') },
          ]
        : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [p, t, locale, model.price])

  const items = model.items
  const picked = (items ?? []).filter((row) => selected.includes(row.itemId))
  const state = model.problem ? (
    <EmptyState title={p('ribaUnpaid.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={p('ribaUnpaid.empty.title')} description={p('ribaUnpaid.empty.body')} />
  ) : undefined
  return (
    <>
      <ListFrame<RibaUnpaidItem>
        label={p('ribaUnpaid.title')}
        rows={state ? [] : items}
        rowId={(row) => row.itemId}
        columns={columns}
        count={items ? p('ribaUnpaid.count', { count: items.length }) : '—'}
        tools={tools}
        listKey="finance.payments.riba-unpaid"
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.itemId))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={keys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
      />
      {items && items.length > 0 && <p className="fw-fin-hint">{p('ribaUnpaid.fee')}</p>}
    </>
  )
}

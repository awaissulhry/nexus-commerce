'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayInstant, money } from '../../../_shared/model'
import type { Refund, ToRefund } from '../api'
import { moveHeld, REFUND_ROWS, REFUND_TONE, refundHeld, settlesWords, type RefundAbilities, type RefundMove, type RefundRow, type RefundRows } from '../model'

export interface RefundsListModel {
  prefix: string
  can: RefundAbilities
  rows: RefundRows
  items: RefundRow[] | null
  problem: string | null
  more: boolean
  /** Design cases: the starting selection. */
  selected?: string[]
}

export interface RefundsListActions {
  onRows?: (rows: RefundRows) => void
  onMore?: () => void
  onRetry?: () => void
  onRefund?: (note: ToRefund) => void
  onMove?: (refund: Refund, move: RefundMove) => void
  onExport?: (ids: string[]) => void
}

/**
 * Payments › Rows ▾ Refunds (design finance.payments grid "Rows ▾: … Refunds"; tile "Refunds to make"): what is to refund
 * now — the credit notes with money left to refund (Refund…) and the refunds due (Made… / Cancel…) — then every refund
 * by state (due, paid, closed, all), on the shared list frame (select-all, shift range, x; Export N; keys only in the
 * footer's info icon). A refund is never edited: it is made, cancelled while due, or voided once paid by mistake.
 */
export function RefundsList({ model, actions, tools, keys, onHelp }: { model: RefundsListModel; actions?: RefundsListActions; tools: ReactNode; keys: readonly ListKey[]; onHelp: () => void }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = model.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const latest = useRef({ can: model.can, actions, prefix: model.prefix })
  latest.current = { can: model.can, actions, prefix: model.prefix }

  const columns = useMemo<ColDef<RefundRow>[]>(() => {
    const WhatCell = ({ data }: ICellRendererParams<RefundRow>) => {
      if (!data) return null
      const prefix = latest.current.prefix
      if (data.kind === 'toRefund')
        return (
          <span className="fw-fin-cell">
            <Link className="fw-fin-link" href={`${prefix}/finance/invoices/${data.note.creditNoteId}`}>
              {d('refunds.creditNote', { number: data.note.number ?? '—' })}
            </Link>
            <span className="fw-fin-cell-sub">{d('refunds.ofInvoice', { number: data.note.creditOfNumber ?? '—' })}</span>
          </span>
        )
      const settles = settlesWords(data.refund)
      const note = data.refund.creditNote
      return (
        <span className="fw-fin-cell">
          {note ? (
            <Link className="fw-fin-link" href={`${prefix}/finance/invoices/${note.id}`}>
              {d(settles.key, settles.params)}
            </Link>
          ) : data.refund.payment ? (
            <Link className="fw-fin-link" href={`${prefix}/finance/payments/${data.refund.payment.id}`}>
              {d(settles.key, settles.params)}
            </Link>
          ) : (
            <span>{d(settles.key, settles.params)}</span>
          )}
          <span className="fw-fin-cell-sub">{d('refunds.recordedOn', { date: formatDate(data.refund.createdAt, { locale }) })}</span>
        </span>
      )
    }
    const CustomerCell = ({ data }: ICellRendererParams<RefundRow>) => (data ? <span className="fw-fin-ellipsis">{data.kind === 'refund' ? data.refund.party.legalName : data.note.party.legalName}</span> : null)
    const AmountCell = ({ data }: ICellRendererParams<RefundRow>) => {
      if (!data) return null
      if (data.kind === 'toRefund')
        return (
          <span className="fw-fin-cell fw-fin-num">
            <span>{money(data.note.refundableAmount, data.note.currency, locale)}</span>
            {(data.note.refundedAmount ?? 0) > 0 && <span className="fw-fin-cell-sub">{d('refunds.alreadyRefunded', { amount: money(data.note.refundedAmount, data.note.currency, locale) })}</span>}
          </span>
        )
      return <span className="fw-fin-num">{money(data.refund.amount, data.refund.currency, locale)}</span>
    }
    const WhenCell = ({ data }: ICellRendererParams<RefundRow>) => {
      if (!data) return null
      if (data.kind === 'toRefund') return <span>{d('refunds.notRecorded')}</span>
      const refund = data.refund
      return (
        <span className="fw-fin-cell">
          <span>{refund.status === 'PAID' ? d('refunds.paidOn', { date: day(refund.paidOn) }) : refund.dueDate ? d('refunds.dueOn', { date: day(refund.dueDate) }) : '—'}</span>
          {refund.externalRef && <span className="fw-fin-cell-sub fw-fin-code">{refund.externalRef}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<RefundRow>) => {
      if (!data) return null
      if (data.kind === 'toRefund') return <Pill tone="warning">{d('refunds.state.toRefund')}</Pill>
      return (
        <span className="fw-fin-cell">
          <Pill tone={REFUND_TONE[data.refund.status]}>{d(`refunds.state.${data.refund.status}`)}</Pill>
          {(data.refund.cancelReason || data.refund.voidReason) && <span className="fw-fin-cell-sub">{data.refund.cancelReason ?? data.refund.voidReason}</span>}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<RefundRow>) => {
      if (!data) return null
      const now = latest.current
      if (data.kind === 'toRefund') {
        const wait = refundHeld(now.can)
        return (
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': d('refunds.rowMenu') }}
            items={[
              { id: 'refund', label: d('refund.open'), disabled: !!wait, description: wait ? d(wait.key, wait.params) : undefined, onSelect: () => now.actions?.onRefund?.(data.note) },
              { id: 'open', label: d('refunds.openNote'), href: `${now.prefix}/finance/invoices/${data.note.creditNoteId}` },
            ]}
          />
        )
      }
      const moves: RefundMove[] = ['paid', 'cancel', 'void']
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': d('refunds.rowMenu') }}
          items={moves.map((move) => {
            const wait = moveHeld(data.refund, move, now.can)
            return { id: move, label: d(`refunds.move.${move}.verb`), tone: move === 'paid' ? undefined : ('danger' as const), disabled: !!wait, description: wait ? d(wait.key, wait.params) : undefined, onSelect: () => now.actions?.onMove?.(data.refund, move) }
          })}
        />
      )
    }
    return [
      { colId: 'what', headerName: d('refunds.col.what'), minWidth: 200, flex: 1.4, cellRenderer: WhatCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 160, flex: 1.2, cellRenderer: CustomerCell },
      ...(model.can.price ? [{ colId: 'amount', headerName: t('col.amount'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: AmountCell }] : []),
      { colId: 'when', headerName: d('refunds.col.when'), minWidth: 150, flex: 0.9, cellRenderer: WhenCell },
      { colId: 'state', headerName: t('col.state'), minWidth: 130, flex: 0.8, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the page’s latest state through the ref, so the columns stay the same object between renders.
  }, [t, d, locale, model.can.price])

  const items = model.items
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const state = model.problem ? (
    <EmptyState title={d('refunds.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={d(`refunds.empty.${model.rows}.title`)} description={d(`refunds.empty.${model.rows}.body`)} />
  ) : undefined
  const refundTools = (
    <span className="fw-fin-actions">
      {tools}
      <Select size="sm" aria-label={d('refunds.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as RefundRows)}>
        {REFUND_ROWS.map((view) => (
          <option key={view} value={view}>
            {d(`refunds.rows.${view}`)}
          </option>
        ))}
      </Select>
    </span>
  )
  return (
    <ListFrame<RefundRow>
      label={d('refunds.title')}
      rows={state ? [] : items}
      rowId={(row) => row.id}
      columns={columns}
      count={items ? d(model.more ? 'refunds.countMore' : 'refunds.count', { count: items.length }) : '—'}
      tools={refundTools}
      listKey="finance.payments.refunds"
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
      onOpen={(row) => (row.kind === 'toRefund' ? actions?.onRefund?.(row.note) : row.refund.status === 'DUE' ? actions?.onMove?.(row.refund, 'paid') : undefined)}
      state={state}
    />
  )
}

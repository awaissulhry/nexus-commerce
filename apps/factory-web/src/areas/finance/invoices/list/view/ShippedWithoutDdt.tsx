'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { FilePlus2 } from 'lucide-react'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { QueueCustomer, QueueShipment } from '../../../_shared/api'
import { dayInstant, DEADLINE_TONE, deadlineWords, ddtLeft, money } from '../../../_shared/model'
import type { InvoicesListActions, InvoicesListModel } from '../list-model'

/**
 * B-W2b-GB02 (G148; B-W1-51's gap): the shipments that left WITHOUT a DDT and are not invoiced (their immediate invoice
 * TD01 goes with the goods, due within 12 days of the day they left). Shown under "Shipped, not invoiced" only when
 * there is one (no empty block). A row opens its draft when one holds its goods, else "Invoice" makes the draft
 * (POST /invoicing/invoices/from-shipment) and opens it.
 */

export interface ShipmentRow extends QueueShipment {
  readonly customer: QueueCustomer
}

export const shipmentRowsOf = (model: Pick<InvoicesListModel, 'queue'>): ShipmentRow[] => (model.queue.value?.customers ?? []).flatMap((customer) => (customer.shipments ?? []).map((shipment) => ({ ...shipment, customer })))

export function ShippedWithoutDdt({ model, actions }: { model: InvoicesListModel; actions?: InvoicesListActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const rows = useMemo(() => shipmentRowsOf(model), [model])
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const columns = useMemo<ColDef<ShipmentRow>[]>(() => {
    const ShipmentCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-fin-cell">
          <span className="fw-fin-code">{data.number}</span>
          <span className="fw-fin-cell-sub">
            <Tag tone="info">{t('shipped.noDdt.tag')}</Tag>
          </span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{data.customer.legalName}</span>
          <span className="fw-fin-cell-sub">{data.orders.map((order) => order.number).join(', ') || '—'}</span>
        </span>
      ) : null
    const LeftCell = ({ data }: ICellRendererParams<ShipmentRow>) => (data ? <span>{day(data.shippedOn)}</span> : null)
    const PiecesCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      const left = ddtLeft(data)
      return (
        <span className="fw-fin-cell">
          <span>{t('shipped.pieces', { count: left.toInvoice })}</span>
          <span className="fw-fin-cell-sub">{left.inDraft > 0 ? t('shipped.inDraft', { count: left.inDraft }) : t('shipped.lines', { count: data.lines.length })}</span>
        </span>
      )
    }
    const ValueCell = ({ data }: ICellRendererParams<ShipmentRow>) => (data ? <span className="fw-fin-num">{money(data.valueAmount, 'EUR', locale)}</span> : null)
    const DeadlineCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      const words = deadlineWords(data.deadline)
      return (
        <span className="fw-fin-cell">
          <Pill tone={DEADLINE_TONE[data.deadline.state]}>{t(words.key, words.params)}</Pill>
          <span className="fw-fin-cell-sub">{t('shipped.dueBy', { date: day(data.deadline.dueBy) })}</span>
        </span>
      )
    }
    const ActionCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      if (data.drafts.length > 0)
        return (
          <Link className="fw-fin-link" href={`${model.prefix}/finance/invoices/${data.drafts[0]}`}>
            {t('shipped.openDraft')}
          </Link>
        )
      return (
        <Button size="sm" heldReason={!model.can.manageInvoices ? t('held.noManage') : model.busy ? t('held.busy') : null} onClick={() => actions?.onCreateFromShipment?.(data.shipmentId)} aria-label={`${t('shipped.noDdt.go')} · ${data.number}`}>
          <FilePlus2 size={13} aria-hidden /> {t('shipped.noDdt.invoice')}
        </Button>
      )
    }
    return [
      { colId: 'shipment', headerName: t('shipped.noDdt.shipment'), minWidth: 130, flex: 0.9, cellRenderer: ShipmentCell },
      { colId: 'customer', headerName: t('shipped.noDdt.customer'), minWidth: 170, flex: 1.4, cellRenderer: CustomerCell },
      { colId: 'left', headerName: t('shipped.noDdt.leftOn'), minWidth: 110, flex: 0.7, cellRenderer: LeftCell },
      { colId: 'pieces', headerName: t('shipped.noDdt.pieces'), minWidth: 120, flex: 0.8, cellRenderer: PiecesCell },
      ...(model.can.price ? [{ colId: 'value', headerName: t('shipped.noDdt.value'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: ValueCell }] : []),
      { colId: 'deadline', headerName: t('shipped.noDdt.deadline'), minWidth: 160, flex: 1, cellRenderer: DeadlineCell },
      { colId: 'action', headerName: t('shipped.noDdt.invoice'), minWidth: 140, flex: 0.8, sortable: false, cellRenderer: ActionCell },
    ]
  }, [t, locale, model.prefix, model.can.price, model.can.manageInvoices, model.busy, actions])
  if (rows.length === 0) return null
  return (
    <section className="fw-fin-section" id="fw-fin-shipped-no-ddt" aria-labelledby="fw-fin-shipped-no-ddt-title">
      <div className="fw-fin-section-head">
        <h2 className="fw-fin-h2" id="fw-fin-shipped-no-ddt-title">
          {t('shipped.noDdt.title')}
        </h2>
        <p className="fw-fin-hint">{t('shipped.noDdt.explain')}</p>
      </div>
      <ListFrame<ShipmentRow>
        label={t('shipped.noDdt.title')}
        rows={rows}
        rowId={(row) => row.shipmentId}
        columns={columns}
        count={t('shipped.noDdt.count', { count: rows.length })}
        onOpen={(row) => (row.drafts[0] ? actions?.onOpen?.(row.drafts[0]) : actions?.onCreateFromShipment?.(row.shipmentId))}
      />
    </section>
  )
}

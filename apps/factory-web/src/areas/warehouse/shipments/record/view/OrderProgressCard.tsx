'use client'

import Link from 'next/link'
import { ListChecks } from 'lucide-react'
import { Card, SummaryTable } from '@nexus/ui/components'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Backorder, Shipment } from '../../api'
import { backorderSummary, progressRows } from '../../daily-model'
import { STATUS_TONE } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { PartState } from './ShipmentRecordView'
// F-OP-130 (order page N6, R-5): a card per order the shipment carries.
import { orderWords } from '../../model'
import { DEPTH_NS } from '../../queue/shared/depth'

/**
 * The order on this shipment (design sh-lines "SizeGridProgress with ordered / released / shipped before / this
 * shipment per size"; LOG-004 partial shipments and the backorder): per order line a size grid — ordered, released by
 * quality, shipped before, on other shipments still here, this shipment, still to ship — and in words what this shipment
 * leaves of the order (it completes it, or N stay on backorder: released and ready for the next shipment, or still to be
 * made). The DS has no SizeGridProgress (D25, new): a SummaryTable with a column per size stands in for it.
 */
// F-OP-130 (order page N6, R-5): a shipment of several orders shows this card for each of them, the first first, each titled
// "SO-0150 · Customer PO 4471 on this shipment"; one order: as before.
export function OrderProgressCard({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const backorders = model.backorder.value
  if (!backorders) return <PartState problem={model.backorder.problem} onRetry={() => actions?.onRetryPart?.('backorder')} label={t('backorder.title')} />
  return (
    <>
      {backorders.map((backorder) => (
        <OrderProgress key={backorder.order.salesOrderId} shipment={shipment} model={model} backorder={backorder} several={backorders.length > 1} />
      ))}
    </>
  )
}

function OrderProgress({ shipment, model, backorder, several }: { shipment: Shipment; model: ShipmentRecordModel; backorder: Backorder; several: boolean }) {
  const t = useT('shipments')
  const d = useT(DEPTH_NS)
  const locale = useLocale()
  const summary = backorderSummary(backorder)
  const others = backorder.shipments.filter((entry) => entry.id !== shipment.id)
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        <h2 className="fw-sh-h2">
          <ListChecks size={16} aria-hidden /> {several ? d('shipOrders.progressTitle', { order: orderWords(backorder.order, (ref) => t('record.customerRef', { ref })) }) : t('backorder.title')}
        </h2>
        <Tag tone={backorder.totals.backorder > 0 ? 'warning' : 'success'}>{backorder.totals.backorder > 0 ? t('backorder.partialTag') : t('backorder.completeTag')}</Tag>
      </div>
      <p className="fw-sh-hint">
        {t(summary.key, summary.params)}
        {backorder.order.promiseDate ? ` · ${t('backorder.promise', { date: formatDate(`${backorder.order.promiseDate}T12:00:00Z`, { locale }) })}` : ''}
      </p>
      {backorder.lines.map((line) => {
        const rows = progressRows(line)
        return (
          <section key={line.lineId} className="fw-sh-progress" aria-label={t('backorder.lineLabel', { seq: line.seq, style: line.styleCode })}>
            <h3 className="fw-sh-h3">
              {t('backorder.line', { seq: line.seq })} · {line.styleCode} · {line.colourwayName}
              {line.closedShort && (
                <Tag tone="neutral">{line.closeShortReason ? t('backorder.closedWhy', { reason: line.closeShortReason }) : t('backorder.closed')}</Tag>
              )}
            </h3>
            <SummaryTable
              label={t('backorder.lineLabel', { seq: line.seq, style: line.styleCode })}
              columns={[t('backorder.col.garments'), ...line.sizes.map((size) => size.size), t('backorder.col.total')]}
              align={['left', ...line.sizes.map(() => 'right' as const), 'right']}
              rows={rows.map((row) => ({
                id: row.measure,
                cells: [
                  row.measure === 'thisShipment' || row.measure === 'left' ? <b key="m">{t(`backorder.measure.${row.measure}`)}</b> : t(`backorder.measure.${row.measure}`),
                  ...row.values.map((value) => (row.measure === 'thisShipment' && value > 0 ? <b key={`v${value}`}>{value}</b> : value === 0 ? '—' : String(value))),
                  <b key="t">{row.total}</b>,
                ],
              }))}
              stackOnPhone
            />
          </section>
        )
      })}
      {others.length > 0 && (
        <p className="fw-sh-hint fw-sh-inline">
          {t('backorder.others')}
          {others.map((entry) => (
            <Link key={entry.id} className="fw-sh-link fw-sh-inline" href={`${model.prefix}/warehouse/shipments/${entry.id}`}>
              {entry.number} <Pill tone={STATUS_TONE[entry.status]}>{t(`status.${entry.status}`)}</Pill>
            </Link>
          ))}
        </p>
      )}
    </Card>
  )
}

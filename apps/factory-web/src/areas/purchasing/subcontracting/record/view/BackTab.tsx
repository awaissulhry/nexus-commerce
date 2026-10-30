'use client'

import { PackageCheck } from 'lucide-react'
import { Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { Receipt, SubcontractOrder } from '../../api'
import { actHeld, say } from '../../model'
import type { SubcontractRecordActions, SubcontractRecordModel } from '../record-model'

/**
 * Received back (design rec back): each receipt from the workshop — when the goods came back, the workshop's own DDT,
 * per operation and bundle (its colourway and size) the pieces back good, defective and scrapped there with the reason,
 * and the unused material it returned (lot, quantity, the place it went to). Who recorded it is never listed. The
 * quality inspection of what came back is not linked yet (no API link: a named gap). Receive back opens the dialog.
 */
export function BackTab({ order, model, actions }: { order: SubcontractOrder; model: SubcontractRecordModel; actions?: SubcontractRecordActions }) {
  const t = useT('subcontract-order')
  const sc = useT('subcontracting')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const receiveWords = actHeld(order, 'receive', model.can)
  const held = model.busy ? t('held.busy') : receiveWords ? say(sc, receiveWords) : null
  const open = order.status === 'AT_WORKSHOP' || order.status === 'PARTLY_RECEIVED'
  const totals = order.pieces
  return (
    <div className="fw-by-stack">
      <div className="fw-by-head">
        <span className="fw-by-hint">{t('back.summary', { good: totals.backGood, defective: totals.backDefective, scrapped: totals.scrapped, out: totals.atWorkshop })}</span>
        {open && (
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onOpenReceive?.()}>
            <PackageCheck size={14} aria-hidden /> {t('band.act.receive')}
          </Button>
        )}
      </div>
      {order.receipts.length === 0 ? (
        <Card padded>
          <EmptyState
            title={order.expectedBackDate ? t('back.empty.due', { date: formatDate(dayAt(order.expectedBackDate), place) }) : t('back.empty.title')}
            description={t('back.empty.body')}
            action={
              open ? (
                <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onOpenReceive?.()}>
                  {t('band.act.receive')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="fw-sco-receipts">
          {order.receipts.map((receipt, index) => (
            <ReceiptCard key={receipt.id} receipt={receipt} index={order.receipts.length - index} place={place} />
          ))}
        </div>
      )}
      <p className="fw-by-hint">{t('back.qualityLater')}</p>
    </div>
  )
}

function ReceiptCard({ receipt, index, place }: { receipt: Receipt; index: number; place: { locale: 'it' | 'en'; timeZone: string } }) {
  const t = useT('subcontract-order')
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('back.receipt', { n: index, date: formatDateTime(receipt.receivedAt, place) })}</h3>
        </div>
        <KeyValue
          dense
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('back.workshopDdt'), value: receipt.supplierDdt ? (receipt.supplierDdt.date ? t('back.ddtOn', { number: receipt.supplierDdt.number, date: formatDate(dayAt(receipt.supplierDdt.date), place) }) : receipt.supplierDdt.number) : t('back.noDdt') },
            { label: t('back.recorded'), value: formatDateTime(receipt.recordedAt, place) },
            ...(receipt.note ? [{ label: t('back.note'), value: receipt.note }] : []),
          ]}
        />
        <SummaryTable
          label={t('back.linesLabel', { n: index })}
          columns={[t('back.col.operation'), t('back.col.bundle'), t('back.col.good'), t('back.col.defective'), t('back.col.scrapped'), t('back.col.reason')]}
          align={['left', 'left', 'right', 'right', 'right', 'left']}
          stackOnPhone
          rows={receipt.lines.map((line, row) => ({
            id: `${line.operationId}-${line.bundle?.id ?? 'all'}-${row}`,
            cells: [
              t('back.operation', { line: line.seq, code: line.code }),
              line.bundle ? t('back.bundle', { code: line.bundle.code, colourway: line.bundle.colourway, size: line.bundle.size }) : t('back.noBundle'),
              String(line.good),
              String(line.defective),
              String(line.scrapped),
              line.reason ?? '—',
            ],
          }))}
        />
        {receipt.returns.length > 0 && (
          <SummaryTable
            label={t('back.returnsLabel')}
            columns={[t('back.col.material'), t('back.col.lot'), t('back.col.quantity'), t('back.col.to')]}
            align={['left', 'left', 'right', 'left']}
            stackOnPhone
            rows={receipt.returns.map((entry) => ({
              id: entry.moveId,
              cells: [`${entry.item.code} ${entry.item.name}${entry.colour ? ` · ${entry.colour.code}` : ''}`, entry.lot ? entry.lot.code : entry.hide ? entry.hide.code : '—', `${quantity(entry.quantity, place.locale, 4)} ${t(`uom.${entry.uom}`)}`, `${entry.toLocation.code} · ${entry.toLocation.name}`],
            }))}
          />
        )}
      </div>
    </Card>
  )
}

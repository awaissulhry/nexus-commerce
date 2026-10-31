'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, Eye, FileText, PackageCheck } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { OrderReceipt, PurchaseOrder } from '../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../model'
import { CloseShortCard } from './ChangesSections'
import { PartState } from './OrderRecordView'

const RECEIVING = ['SENT', 'CONFIRMED', 'PARTLY_RECEIVED']

/**
 * Receipts (SCR-059 "Goods received"): the goods receipts Warehouse posted against this order, newest first, each a
 * real link to the receipt with its lots (released of all), hides and quantities; "Receive goods" opens the receiving
 * page with this order (inventory.receive, while the order takes goods). What each line still waits for is on Lines.
 */
export function ReceiptsTab({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const receipts = model.receipts
  const columns = useMemo<ColDef<OrderReceipt>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<OrderReceipt>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={`${model.prefix}/warehouse/receipts/${data.id}`}>
            {data.number}
          </Link>
          <span className="fw-by-cell-sub">{data.supplierDdtNumber ? t('rc.ddt', { number: data.supplierDdtNumber, date: data.supplierDdtDate ? formatDate(dayAt(data.supplierDdtDate), place) : '—' }) : t('rc.noDdt')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<OrderReceipt>) => (data ? <Pill tone={data.status === 'POSTED' ? 'success' : data.status === 'REVERSED' ? 'danger' : 'neutral'}>{t(`rcStatus.${data.status}`)}</Pill> : null)
    const LotsCell = ({ data }: ICellRendererParams<OrderReceipt>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{t('rc.lotsReleased', { released: data.lotsReleased, count: data.lots })}</span>
          <span className="fw-by-cell-sub">{data.hides > 0 ? t('rc.hides', { count: data.hides }) : ''}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<OrderReceipt>) => (data ? <span className="fw-by-num">{data.quantities.map((entry) => `${quantity(entry.baseQuantity, locale)} ${t(`uom.${entry.uom}`)}`).join(' · ') || '—'}</span> : null)
    return [
      { colId: 'number', headerName: t('rc.col.number'), minWidth: 170, flex: 1.2, cellRenderer: NumberCell },
      { colId: 'status', headerName: t('rc.col.status'), minWidth: 110, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'received', headerName: t('rc.col.receivedAt'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? formatDateTime(params.data.receivedAt, place) : '') },
      { colId: 'lines', headerName: t('rc.col.lines'), field: 'lines', minWidth: 70, flex: 0.4, type: 'rightAligned' },
      { colId: 'lots', headerName: t('rc.col.lots'), minWidth: 150, flex: 1, cellRenderer: LotsCell },
      { colId: 'quantity', headerName: t('rc.col.quantity'), minWidth: 150, flex: 1, cellRenderer: QuantityCell },
    ]
  }, [t, locale, model.prefix])

  if (!receipts) return null
  if (!receipts.value) return <PartState problem={receipts.problem} onRetry={() => actions?.onRetryPart?.('receipts')} label={t('po.tab.receipts')} />
  const canTake = RECEIVING.includes(order.status)
  const receive = canTake ? (
    model.can.receive ? (
      <Button size="sm" variant="primary" asChild>
        <Link href={`${model.prefix}/warehouse/receipts/new?order=${order.id}`}>
          <PackageCheck size={14} aria-hidden /> {t('po.step.receive')}
        </Link>
      </Button>
    ) : (
      <Button size="sm" variant="primary" heldReason={t('held.noReceive')}>
        <PackageCheck size={14} aria-hidden /> {t('po.step.receive')}
      </Button>
    )
  ) : null
  return (
    <div className="fw-by-stack">
      <div className="fw-by-head">
        <span className="fw-by-hint">{canTake ? t('po.receipts.takes') : order.status === 'DRAFT' ? t('po.receipts.draft') : order.status === 'CHANGES_PROPOSED' ? t('po.receipts.proposed') : t('po.receipts.closed', { status: t(`poStatus.${order.status}`) })}</span>
        {receive}
      </div>
      <ListFrame<OrderReceipt>
        label={t('po.receipts.tableLabel')}
        rows={receipts.value}
        rowId={(row) => row.id}
        columns={columns}
        count={t('rc.count', { count: receipts.value.length })}
        state={receipts.value.length === 0 ? <EmptyState title={t('po.receipts.empty')} description={canTake ? t('po.receipts.emptyBody') : undefined} action={receive ?? undefined} /> : undefined}
      />
      {/* B-W2a-69: Close short a line — the rest will not come; planning releases it. */}
      <CloseShortCard order={order} model={model} actions={actions} />
    </div>
  )
}

/**
 * Documents (SCR-059): the frozen PDFs of the order (one per send of a revision, kept ten years: FISCAL_ARCHIVE), each
 * downloaded through a link that lives a minute; the confirm links with their state; the mails with theirs.
 */
export function DocumentsTab({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const docs = model.documents.value
  if (!docs) return <PartState problem={model.documents.problem} onRetry={() => actions?.onRetryPart?.('documents')} label={t('po.tab.documents')} />
  return (
    <div className="fw-by-cards">
      <Card padded>
        <div className="fw-by-stack">
          <h3 className="fw-by-h3">{t('po.docs.pdfs')}</h3>
          {docs.documents.length === 0 ? (
            <p className="fw-by-hint">{order.status === 'DRAFT' ? t('po.docs.noneDraft') : t('po.docs.none')}</p>
          ) : null}
          {order.status === 'DRAFT' && model.previewHref ? (
            <div className="fw-by-check fw-by-check-wrap">
              <Eye size={16} className="fw-by-ico" aria-hidden />
              <span className="fw-by-check-body">
                <b>{t('po.docs.preview')}</b>
                <span className="fw-by-hint">{t('po.docs.previewHint')}</span>
              </span>
              <Button size="sm" variant="quiet" asChild>
                <a href={model.previewHref} target="_blank" rel="noopener noreferrer" aria-label={t('po.docs.openPreview')}>
                  <ExternalLink size={13} aria-hidden /> {t('po.docs.openTab')}
                </a>
              </Button>
            </div>
          ) : null}
          {docs.documents.length === 0 ? null : (
            <ul className="fw-by-checks">
              {docs.documents.map((doc) => (
                <li key={doc.fileId} className="fw-by-check">
                  <FileText size={16} className="fw-by-ico" aria-hidden />
                  <span className="fw-by-check-body">
                    <b>{doc.name}</b>
                    <span className="fw-by-hint">{t('po.docs.made', { date: formatDateTime(doc.createdAt, place), size: Math.max(1, Math.round(doc.sizeBytes / 1024)) })}</span>
                  </span>
                  <Button size="sm" variant="quiet" onClick={() => actions?.onDownload?.(doc.fileId)} aria-label={t('po.docs.download', { name: doc.name })}>
                    <Download size={13} aria-hidden /> {t('common.download')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="fw-by-hint">{t('po.docs.priceNote')}</p>
        </div>
      </Card>
      <Card padded>
        <div className="fw-by-stack">
          <h3 className="fw-by-h3">{t('po.docs.mails')}</h3>
          {docs.mails.length === 0 ? (
            <p className="fw-by-hint">{t('po.docs.noMails')}</p>
          ) : (
            <SummaryTable
              label={t('po.docs.mails')}
              density="compact"
              stackOnPhone
              columns={[t('po.docs.to'), t('po.docs.queued'), t('po.docs.state')]}
              align={['left', 'left', 'left']}
              rows={docs.mails.map((mail) => ({
                id: mail.id,
                cells: [mail.to.join(', '), formatDateTime(mail.queuedAt, place), <Tag key="s" tone={mail.failedAt ? 'danger' : mail.deliveredAt || mail.sentAt ? 'success' : 'neutral'}>{t(mail.failedAt ? 'po.docs.mail.failed' : mail.deliveredAt ? 'po.docs.mail.delivered' : mail.sentAt ? 'po.docs.mail.sent' : 'po.docs.mail.queued')}</Tag>],
              }))}
            />
          )}
        </div>
      </Card>
    </div>
  )
}

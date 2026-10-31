'use client'

import Link from 'next/link'
import { FileCode2, FileText, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Invoice } from '../../../_shared/api'
import { dayInstant } from '../../../_shared/model'
import { xmlHref } from '../../daily/model'
import type { InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

/**
 * Documents (design invoice tab "documents"): the legal XML (FatturaPA, what SDI receives), the courtesy PDF (it says
 * it is a copy; viewed here or downloaded), the DDTs the invoice cites, and the copies e-mailed to the customer. The
 * files are made at issue; an issued invoice whose files are still pending says so with "Make the files".
 */
export function DocumentsTab({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const shell = useT('shell')
  const locale = useLocale()
  const related = model.related.value
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const name = invoice.number ?? invoice.docType
  const copies = model.sdi?.value?.courtesyCopies.queued ?? []
  return (
    <div className="fw-fin-stack">
      {invoice.status === 'DRAFT' && (
        <Card padded>
          <EmptyState title={t('docs.draft.title')} description={t('docs.draft.body')} />
        </Card>
      )}
      {invoice.filesPending && (
        <Banner
          tone="warning"
          title={t('docs.filesPending')}
          action={
            <Button size="sm" heldReason={model.can.issueInvoices ? (model.busy ? t('held.busy') : null) : t('held.noIssue')} onClick={() => actions?.onMakeFiles?.()}>
              {t('action.makeFiles')}
            </Button>
          }
        />
      )}
      {invoice.status !== 'DRAFT' && (
        <Card padded className="fw-fin-card">
          <h2 className="fw-fin-h2">{t('docs.title')}</h2>
          <SummaryTable
            label={t('docs.title')}
            columns={[t('docs.col.document'), t('docs.col.what'), t('docs.col.action')]}
            rows={[
              {
                id: 'xml',
                cells: [
                  <span key="n" className="fw-fin-inline">
                    <FileCode2 size={14} aria-hidden /> {t('docs.xml', { number: name })}
                  </span>,
                  t('docs.xmlWhat'),
                  invoice.xmlFileId ? (
                    <span key="a" className="fw-fin-inline">
                      {/* B-W2a-80 (design tab:xml): the legal file shown readable, in a new tab. */}
                      <Link className="fw-fin-link" href={xmlHref(model.prefix, invoice.id)} target="_blank">
                        {d('xml.view')}
                      </Link>
                      <Button size="sm" variant="link" onClick={() => actions?.onDownload?.(invoice.xmlFileId!)}>
                        {t('docs.download')}
                      </Button>
                    </span>
                  ) : (
                    t('docs.notYet')
                  ),
                ],
              },
              {
                id: 'pdf',
                cells: [
                  <span key="n" className="fw-fin-inline">
                    <FileText size={14} aria-hidden /> {t('docs.pdf', { number: name })}
                  </span>,
                  t('docs.pdfWhat'),
                  invoice.pdfFileId ? (
                    <span key="a" className="fw-fin-inline">
                      <Button size="sm" variant="link" onClick={() => actions?.onViewPdf?.()}>
                        {t('docs.view')}
                      </Button>
                      <Button size="sm" variant="link" onClick={() => actions?.onDownload?.(invoice.pdfFileId!)}>
                        {t('docs.download')}
                      </Button>
                    </span>
                  ) : (
                    t('docs.notYet')
                  ),
                ],
              },
              ...(related?.ddts ?? []).map((ddt) => ({
                id: ddt.id,
                cells: [
                  <span key="n" className="fw-fin-inline">
                    <Truck size={14} aria-hidden /> {t('docs.ddt', { number: ddt.number, date: day(ddt.date) })}
                  </span>,
                  t('docs.ddtWhat', { shipment: ddt.shipmentNumber }),
                  hasRecordPage('Shipment', OFFICE_PAGES) ? (
                    <Link key="a" className="fw-fin-link" href={`${model.prefix}${recordAddress({ type: 'Shipment', id: ddt.shipmentId }, OFFICE_PAGES)}`}>
                      {t('docs.openShipment')}
                    </Link>
                  ) : (
                    '—'
                  ),
                ],
              })),
              ...copies.map((copy) => ({
                id: copy.emailId,
                cells: [t('docs.copy'), t('docs.copyWhat', { date: formatDate(copy.queuedAt, { locale }) }), t(`docs.mail.${copy.status === 'SENT' || copy.status === 'DELIVERED' ? 'sent' : 'other'}`)],
              })),
            ]}
            widths={['36%', '44%', '20%']}
            density="roomy"
            stackOnPhone
          />
        </Card>
      )}
      {model.pdf.status === 'loading' && (
        <Card padded aria-busy="true">
          <p className="fw-fin-hint" role="status">
            <Spinner size={14} /> {t('docs.pdfLoading')}
          </p>
        </Card>
      )}
      {model.pdf.status === 'error' && <Banner tone="danger" title={t('docs.pdfFailed')} />}
      {model.pdf.status === 'ready' && model.pdf.src && (
        <div className="fw-fin-pdf">
          <PdfViewer src={model.pdf.src} title={t('docs.pdf', { number: name })} fileName={`${name}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" onDownload={invoice.pdfFileId ? () => actions?.onDownload?.(invoice.pdfFileId!) : undefined} />
        </div>
      )}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { Download, Eye, FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../../_shared/model'
import type { InvoiceXml, SupplierInvoice } from '../../api'
import { invoiceHref, PAYABLES_NAMESPACE, type PayablesCan } from '../../model'
import type { Loaded } from '../../record/record-model'
import '../../payables.css'
import '../../../_shared/finance.css'

/** The new tab "Supplier invoice as received (XML view / PDF)" — its view model (the view fetches nothing). */
export interface XmlViewModel {
  readonly prefix: string
  readonly can: PayablesCan
  readonly invoiceId: string
  readonly invoice: Loaded<SupplierInvoice>
  /** The XML as SDI delivered it and what it names; null: no XML (a typed invoice) or not read yet. */
  readonly xml: { readonly value: InvoiceXml | null; readonly problem: string | null } | null
  readonly pdf: { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly src: Uint8Array | null }
}

export interface XmlViewActions {
  onRetry?: () => void
  onShowPdf?: () => void
  onDownload?: (fileId: string) => void
}

/**
 * The new tab "Supplier invoice as received (XML view / PDF)" (design finance.payables tab:xml, "Check the original
 * beside the match"): what the XML names (supplier and buyer tax ids, document type, number, date, reason, the orders and
 * delivery notes it refers to, attachments), the XML exactly as SDI delivered it (read-only; it holds the prices, so only
 * with the cost grain — said in words otherwise), and the PDF (the supplier's attachment, or a typed invoice's copy) in
 * the DS PdfViewer, read once on request. Nothing here changes the invoice.
 */
export function XmlView({ model, actions }: { model: XmlViewModel; actions?: XmlViewActions }) {
  return (
    <WithMessages namespaces={[PAYABLES_NAMESPACE]}>
      <Xml model={model} actions={actions} />
    </WithMessages>
  )
}

function Xml({ model, actions }: { model: XmlViewModel; actions?: XmlViewActions }) {
  const t = useT(PAYABLES_NAMESPACE)
  const shell = useT('shell')
  const locale = useLocale()
  const back = invoiceHref(model.prefix, model.invoiceId, 'match')
  if (!model.can.view) return <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
  const loaded = model.invoice
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-fpy">
        <div className="fw-fin-band">
          <DetailHeader backAsChild backLabel={<Link href={back}>{t('xml.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('xml.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-fpy-muted" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
          </Card>
        ) : (
          <EmptyState
            icon={<FileX size={24} aria-hidden />}
            title={t(`record.state.${loaded.status}.title`)}
            description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
            action={
              loaded.status === 'error' ? (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    )
  }
  const invoice = loaded.value
  const read = model.xml?.value?.read ?? null
  const document = read?.documents[0] ?? null
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const pdf = invoice.files.pdf
  return (
    <div className="fw-fpy">
      <div className="fw-fin-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={back}>{t('xml.back')}</Link>}
          title={
            <span className="fw-fin-title">
              {t('xml.heading', { number: invoice.number })} <span className="fw-fin-title-sub">· {invoice.supplier.name}</span>
            </span>
          }
        />
        <p className="fw-fpy-muted">{invoice.source === 'SDI' ? t('xml.fromSdi', { file: invoice.sdiFileName ?? '—', id: invoice.sdiIdentifier ?? '—' }) : t('xml.typed')}</p>
      </div>
      <div className="fw-fpy-pair">
        <Card padded>
          <div className="fw-fpy-stack">
            <h2 className="fw-fpy-h2">{t('xml.names')}</h2>
            {model.xml === null ? (
              <p className="fw-fpy-muted">{t('xml.noXml')}</p>
            ) : model.xml.problem ? (
              <EmptyState
                title={t('xml.failed')}
                description={t(model.xml.problem)}
                action={
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                }
              />
            ) : !model.xml.value ? (
              <p className="fw-fpy-muted" role="status">
                <Spinner size={14} /> {t('xml.reading')}
              </p>
            ) : (
              <>
                <KeyValue
                  columns={1}
                  labelCase="sentence"
                  items={[
                    { label: t('xml.supplier'), value: [read?.supplier.name, read?.supplier.vatNumber ?? read?.supplier.fiscalCode].filter(Boolean).join(' · ') || '—' },
                    { label: t('xml.buyer'), value: [read?.buyer.name, read?.buyer.vatNumber ?? read?.buyer.fiscalCode].filter(Boolean).join(' · ') || '—' },
                    { label: t('xml.document'), value: document ? t('xml.documentValue', { type: document.docType, number: document.number, date: day(document.issueDate) }) : '—' },
                    { label: t('xml.reason'), value: document?.causale.join(' ') || '—' },
                    { label: t('xml.format'), value: read?.format ?? '—' },
                  ]}
                />
                {document && (document.orders.length > 0 || document.ddts.length > 0) && (
                  <SummaryTable
                    label={t('xml.refs')}
                    columns={[t('xml.refCol.kind'), t('xml.refCol.number'), t('xml.refCol.lines')]}
                    align={['left', 'left', 'left']}
                    stackOnPhone
                    rows={[
                      ...document.orders.map((order, index) => ({
                        id: `o-${index}`,
                        cells: [t('xml.refOrder'), order.document ?? '—', order.lines.length > 0 ? order.lines.join(', ') : t('xml.allLines')],
                      })),
                      ...document.ddts.map((ddt, index) => ({
                        id: `d-${index}`,
                        cells: [t('xml.refDdt'), `${ddt.number} · ${day(ddt.date)}`, ddt.lines.length > 0 ? ddt.lines.join(', ') : t('xml.allLines')],
                      })),
                    ]}
                  />
                )}
                {document && document.attachments.length > 0 && <p className="fw-fpy-muted">{t('xml.attachments', { names: document.attachments.join(', ') })}</p>}
              </>
            )}
          </div>
        </Card>
        <Card padded>
          <div className="fw-fpy-stack">
            <div className="fw-fpy-head">
              <h2 className="fw-fpy-h2">{t('xml.pdf')}</h2>
              {pdf && (
                <span className="fw-fpy-inline">
                  {model.pdf.status !== 'ready' && (
                    <Button size="sm" heldReason={model.pdf.status === 'loading' ? t('held.busy') : null} onClick={() => actions?.onShowPdf?.()}>
                      <Eye size={14} aria-hidden /> {t('xml.showPdf')}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => actions?.onDownload?.(pdf.id)}>
                    <Download size={14} aria-hidden /> {t('xml.downloadPdf')}
                  </Button>
                </span>
              )}
            </div>
            {!pdf && <p className="fw-fpy-muted">{t('xml.noPdf')}</p>}
            {model.pdf.status === 'loading' && (
              <p className="fw-fpy-muted" role="status">
                <Spinner size={14} /> {t('xml.pdfLoading')}
              </p>
            )}
            {model.pdf.status === 'error' && <Banner tone="danger" title={t('xml.pdfFailed')} />}
            {model.pdf.status === 'ready' && model.pdf.src && (
              <PdfViewer
                src={model.pdf.src}
                title={t('xml.pdfTitle', { number: invoice.number })}
                fileName={`${invoice.number.replace(/[^A-Za-z0-9-]+/g, '_')}.pdf`}
                labels={pdfViewerLabels(shell)}
                height="min(70vh, 760px)"
                onDownload={pdf ? () => actions?.onDownload?.(pdf.id) : undefined}
              />
            )}
          </div>
        </Card>
      </div>
      {model.xml?.value && (
        <section className="fw-fpy-section" aria-labelledby="fw-fpy-xml">
          <div className="fw-fpy-section-head">
            <h2 id="fw-fpy-xml" className="fw-fpy-h2">
              {t('xml.text', { file: model.xml.value.fileName })}
            </h2>
            {typeof model.xml.value.xml === 'string' && (
              <Button size="sm" onClick={() => actions?.onDownload?.(model.xml!.value!.fileId)}>
                <Download size={14} aria-hidden /> {t('xml.downloadXml')}
              </Button>
            )}
          </div>
          {typeof model.xml.value.xml === 'string' ? (
            <pre className="fw-fpy-xml" tabIndex={0} aria-label={t('xml.textLabel')}>
              {model.xml.value.xml}
            </pre>
          ) : (
            <Banner tone="info" title={t('xml.noCost')} />
          )}
        </section>
      )}
    </div>
  )
}

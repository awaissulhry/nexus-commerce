'use client'

import { Printer } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RECEIVABLES_NAMESPACE, type ReceivablesCan, type StatementRef } from '../../model'
import { dayText } from '../../view/parts'
import '../../receivables.css'

export interface StatementPdfEntry {
  readonly ref: StatementRef
  /** The customer's name (from the statement's read), or null before it. */
  readonly name: string | null
  readonly pdf: Uint8Array | null
  readonly problem: string | null
}

/** SCR-151-pdf — the statement PDF tab's view model. */
export interface StatementPdfModel {
  readonly can: ReceivablesCan
  readonly from: string | null
  readonly to: string | null
  readonly entries: readonly StatementPdfEntry[]
}

/**
 * tab:statement-pdf — "Statement (PDF)", a document to print or send (design finance.receivables new tab): one or several
 * customers' statements on the company's letterhead, each in the DS PdfViewer, made on request by the API and stored
 * nowhere; Print prints them all (the browser's print). Needs the price grain (every figure is a price).
 */
export function StatementPdfView({ model, onRetry }: { model: StatementPdfModel; onRetry?: (index: number) => void }) {
  return (
    <WithMessages namespaces={[RECEIVABLES_NAMESPACE]}>
      <StatementPdfPage model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function StatementPdfPage({ model, onRetry }: { model: StatementPdfModel; onRetry?: (index: number) => void }) {
  const t = useT(RECEIVABLES_NAMESPACE)
  const shell = useT('shell')
  const locale = useLocale()
  if (!model.can.view) return <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'receivables.view' })} />
  if (!model.can.price) return <EmptyState title={t('pdf.noPriceTitle')} description={t('held.price', { permission: 'money.price' })} />
  if (model.entries.length === 0) return <EmptyState title={t('pdf.noneTitle')} description={t('pdf.noneBody')} />
  return (
    <div className="fw-frv">
      <div className="fw-frv-band" role="group" aria-label={t('pdf.band')}>
        <span className="fw-frv-inline">
          <span className="fw-frv-h2">{t('pdf.title', { count: model.entries.length })}</span>
          <span className="fw-frv-muted">
            {model.from || model.to
              ? t('pdf.period', { from: model.from ? dayText(model.from, locale) : t('pdf.yearStart'), to: model.to ? dayText(model.to, locale) : t('band.today') })
              : t('pdf.defaultPeriod')}
          </span>
        </span>
        <Button size="sm" variant="primary" heldReason={model.entries.some((entry) => !entry.pdf) ? t('pdf.printHeld') : null} onClick={() => window.print()}>
          <Printer size={13} aria-hidden /> {t('pdf.print')}
        </Button>
      </div>
      <p className="fw-frv-muted fw-frv-noprint">{t('pdf.storedNowhere')}</p>
      <div className="fw-frv-pdfs">
        {model.entries.map((entry, index) => (
          <Card key={`${entry.ref.partyId}-${entry.ref.companyId}-${entry.ref.currency ?? ''}`} padded>
            <div className="fw-frv-card">
              <h3 className="fw-frv-h3">{entry.name ? t('pdf.of', { customer: entry.name }) : t('pdf.ofUnknown', { n: index + 1 })}</h3>
              {entry.problem ? (
                <Banner
                  tone="danger"
                  title={t(entry.problem)}
                  action={
                    <Button size="sm" onClick={() => onRetry?.(index)}>
                      {t('common.retry')}
                    </Button>
                  }
                />
              ) : entry.pdf ? (
                <PdfViewer
                  src={entry.pdf}
                  title={entry.name ? t('pdf.of', { customer: entry.name }) : t('pdf.ofUnknown', { n: index + 1 })}
                  fileName={`${t('pdf.file', { customer: entry.name ?? String(index + 1) })}.pdf`}
                  labels={pdfViewerLabels(shell)}
                  height="min(80vh, 1000px)"
                />
              ) : (
                <p className="fw-frv-muted" role="status">
                  <Spinner size={12} /> {t('pdf.reading')}
                </p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

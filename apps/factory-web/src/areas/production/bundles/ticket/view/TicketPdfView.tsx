'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { BUNDLES_NAMESPACE, BUNDLES_NAMESPACES } from '../../model'
import '../../bundles.css'

/** SCR-259-ticket — the ticket PDF tab's view model. */
export interface TicketPdfModel {
  /** print.labels: the PDF is made for this person. */
  allowed: boolean
  code: string | null
  pdf: Uint8Array | null
  problem: string | null
}

/**
 * tab:bd-tab-ticket — "Ticket PDF" (design production.bundles, printing from the browser): the bundle's current ticket in
 * the DS PdfViewer, made on request by the API and stored nowhere; Print prints it (the browser's print).
 */
export function TicketPdfView({ model, onRetry }: { model: TicketPdfModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={BUNDLES_NAMESPACES}>
      <Page model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Page({ model, onRetry }: { model: TicketPdfModel; onRetry?: () => void }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const shell = useT('shell')
  if (!model.allowed) return <EmptyState title={t('pdf.noRight.title')} description={t('pdf.noRight.body', { permission: 'print.labels' })} />
  const title = model.code ? t('ticket.name', { code: model.code }) : t('pdf.title')
  return (
    <div className="fw-bd-pdf">
      <div className="fw-bd-band fw-bd-noprint">
        <span className="fw-pr-h2">{title}</span>
        <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('pdf.held')} onClick={() => window.print()}>
          <Printer size={13} aria-hidden /> {t('pdf.print')}
        </Button>
      </div>
      <p className="fw-pr-hint fw-bd-noprint">{t('pdf.storedNowhere')}</p>
      {model.problem ? (
        <Banner
          tone="danger"
          title={scoped(model.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.pdf ? (
        <PdfViewer src={model.pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
      ) : (
        <p className="fw-pr-hint" role="status">
          <Spinner size={14} /> {t('pdf.loading')}
        </p>
      )}
    </div>
  )
}

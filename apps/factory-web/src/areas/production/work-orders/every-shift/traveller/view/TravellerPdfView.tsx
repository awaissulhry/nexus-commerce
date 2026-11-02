'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { SHIFT_NAMESPACE } from '../../model'
import '../../every-shift.css'

/** SCR-070-traveller — the traveller tab's view model. */
export interface TravellerModel {
  /** workorders.view. */
  allowed: boolean
  count: number
  pdf: Uint8Array | null
  problem: string | null
}

/**
 * tab:wo-tab-traveller — "Traveller PDF with QR" (design production.workorders, the paper fallback that travels with the
 * work): one or several work orders in the DS PdfViewer, made on request by the API, stored nowhere; Print prints it.
 */
export function TravellerPdfView({ model, onRetry }: { model: TravellerModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[SHIFT_NAMESPACE, 'production']}>
      <Page model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Page({ model, onRetry }: { model: TravellerModel; onRetry?: () => void }) {
  const t = useT(SHIFT_NAMESPACE)
  const tp = useT('production')
  const scoped = useScopedT('production')
  const shell = useT('shell')
  if (!model.allowed) return <EmptyState title={t('traveller.noRight.title')} description={t('traveller.noRight.body', { permission: 'workorders.view' })} />
  if (model.count === 0) return <EmptyState title={t('traveller.none.title')} description={t('traveller.none.body')} />
  const title = t('traveller.title', { count: model.count })
  return (
    <div className="fw-es-pdf">
      <div className="fw-es-band fw-es-noprint">
        <span className="fw-pr-h2">{title}</span>
        <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('traveller.held')} onClick={() => window.print()}>
          <Printer size={13} aria-hidden /> {t('traveller.print')}
        </Button>
      </div>
      <p className="fw-pr-hint fw-es-noprint">{t('traveller.storedNowhere')}</p>
      {model.problem ? (
        <Banner
          tone="danger"
          title={scoped(model.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {tp('common.retry')}
            </Button>
          }
        />
      ) : model.pdf ? (
        <PdfViewer src={model.pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
      ) : (
        <p className="fw-pr-hint" role="status">
          <Spinner size={14} /> {t('traveller.loading')}
        </p>
      )}
    </div>
  )
}

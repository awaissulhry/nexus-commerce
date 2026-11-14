'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { ReturnLabelRow } from '../api'
import { STATUS_TONE } from '../model'
import '../return-label.css'

export type LabelPdfProblem = 'notFound' | 'forbidden' | 'failed'

export interface LabelPdfWindowModel {
  readonly prefix: string
  readonly read: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: LabelPdfProblem } | { readonly status: 'ready'; readonly value: { readonly returnId: string; readonly number: string; readonly label: ReturnLabelRow } }
  /** The PDF's bytes; null: the label has none (offered by link, not booked yet). */
  readonly pdf: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: 'pdf' } | { readonly status: 'ready'; readonly value: Uint8Array } | null
}

export interface LabelPdfWindowActions {
  readonly onRetry?: () => void
}

/**
 * SCR-112-label-pdf — the Return label PDF window (B-W2b-398; LOG-112; design sales.returns tab:returns.label): the return,
 * the label's state and carrier reference, the PDF in the viewer (print, download), back to the return.
 */
export function LabelPdfWindowView({ model, actions }: { model: LabelPdfWindowModel; actions?: LabelPdfWindowActions }) {
  return (
    <WithMessages namespaces={['shipping-delivery']}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: LabelPdfWindowModel; actions?: LabelPdfWindowActions | undefined }) {
  const t = useT('shipping-delivery')
  const shell = useT('shell')
  if (model.read.status === 'loading')
    return (
      <div className="fw-rl-window" aria-busy="true">
        <Skeleton height={32} width="40%" />
        <Skeleton height={480} />
      </div>
    )
  if (model.read.status === 'error')
    return (
      <div className="fw-rl-window">
        <Card padded>
          <Banner tone={model.read.problem === 'failed' ? 'danger' : 'warning'} title={t(`win.problem.${model.read.problem}`)} action={model.read.problem === 'failed' ? <Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rl.retry')}</Button> : undefined} />
        </Card>
      </div>
    )
  const { returnId, number, label } = model.read.value
  return (
    <div className="fw-rl-window">
      <div className="fw-rl-band">
        <span className="fw-rl-actions">
          <h1 className="fw-rl-h1">{t('win.title', { number })}</h1>
          <Pill tone={STATUS_TONE[label.status]}>{t(`rl.status.${label.status}`)}</Pill>
          {label.bookingReference && <span className="fw-rl-code">{t('rl.reference', { reference: label.bookingReference })}</span>}
        </span>
        <Link className="fw-rl-link" href={`${model.prefix}/sales/returns/${encodeURIComponent(returnId)}?tab=shipments`}>
          {t('win.back')}
        </Link>
      </div>
      {!model.pdf ? (
        <Card padded>
          <EmptyState title={t('win.noPdf.title')} description={t(label.status === 'CANCELLED' ? 'win.noPdf.cancelled' : 'win.noPdf.offered')} />
        </Card>
      ) : model.pdf.status === 'loading' ? (
        <p className="fw-rl-hint" role="status">
          <Spinner size={12} /> {t('win.loading')}
        </p>
      ) : model.pdf.status === 'error' ? (
        <Card padded>
          <Banner tone="danger" title={t('win.problem.pdf')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rl.retry')}</Button>} />
        </Card>
      ) : (
        <>
          {label.status === 'CANCELLED' && <Banner tone="warning" title={t('win.cancelled')} />}
          <PdfViewer src={model.pdf.value} title={label.file?.name ?? t('win.title', { number })} height="calc(100vh - 200px)" labels={pdfViewerLabels(shell)} />
        </>
      )}
    </div>
  )
}

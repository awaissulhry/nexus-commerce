'use client'

import Link from 'next/link'
import { Banner, Card } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../pickup/dispatch'
import type { CustomsDocument } from '../api'
import '../../shipments.css'
import '../../pickup/dispatch.css'

export interface PaperWindowModel {
  readonly prefix: string
  readonly read: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: 'notFound' | 'forbidden' | 'failed' | 'noPrice' } | { readonly status: 'ready'; readonly value: { readonly shipmentId: string; readonly shipmentNumber: string; readonly document: CustomsDocument } }
  readonly pdf: { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready'; readonly value: Uint8Array } | null
}

/**
 * SCR-654 — the Commercial invoice PDF window (B-W2b-412 on B-W2b-409; design warehouse.shipments tab sh-tab-ci "a customs
 * document for the broker"; a window page; the CN 22 / CN 23 open here too): the paper, its version and language, whether it
 * is the newest, and its PDF in the viewer (print, download). Values are in the paper: the price grain reads it.
 */
export function PaperWindowView({ model, onRetry }: { model: PaperWindowModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[...DISPATCH_NAMESPACES, 'shell']}>
      <Body model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ model, onRetry }: { model: PaperWindowModel; onRetry?: () => void }) {
  const t = useT(DISPATCH_NS)
  const shell = useT('shell')
  const locale = useLocale()
  if (model.read.status === 'loading')
    return (
      <div className="fw-dsp-window" aria-busy="true">
        <Skeleton height={32} width="40%" />
        <Skeleton height={480} />
      </div>
    )
  if (model.read.status === 'error')
    return (
      <div className="fw-dsp-window">
        <Card padded>
          <Banner tone={model.read.problem === 'failed' ? 'danger' : 'warning'} title={t(`window.problem.${model.read.problem}`)} action={model.read.problem === 'failed' ? <Button size="sm" onClick={() => onRetry?.()}>{t('window.retry')}</Button> : undefined} />
        </Card>
      </div>
    )
  const { shipmentId, shipmentNumber, document } = model.read.value
  const title = t(`paperWindow.title.${document.kind}`, { number: shipmentNumber, version: document.version })
  return (
    <div className="fw-dsp-window">
      <div className="fw-dsp-band">
        <span className="fw-shd-actions">
          <h1 className="fw-dsp-h1">{title}</h1>
          <Pill tone={document.current ? 'success' : 'neutral'}>{t(document.current ? 'export.current' : 'paperWindow.older')}</Pill>
          <span className="fw-sh-hint">{t('export.paperFacts', { language: t(`export.language.${document.language}`), when: formatDateTime(document.createdAt, { locale }) })}</span>
        </span>
        <Link className="fw-sh-link" href={`${model.prefix}/warehouse/shipments/${encodeURIComponent(shipmentId)}?tab=export`}>
          {t('paperWindow.back', { number: shipmentNumber })}
        </Link>
      </div>
      {!document.current && <Banner tone="warning" title={t('paperWindow.notNewest')} />}
      {!model.pdf || model.pdf.status === 'loading' ? (
        <p className="fw-sh-hint" role="status">
          <Spinner size={12} /> {t('paperWindow.loading')}
        </p>
      ) : model.pdf.status === 'error' ? (
        <Card padded>
          <Banner tone="danger" title={t('paperWindow.failed')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('window.retry')}</Button>} />
        </Card>
      ) : (
        <PdfViewer src={model.pdf.value} title={title} fileName={`${shipmentNumber}-${document.kind.toLowerCase()}-v${document.version}.pdf`} height="calc(100vh - 200px)" labels={pdfViewerLabels(shell)} />
      )}
    </div>
  )
}

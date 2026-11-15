'use client'

import Link from 'next/link'
import { Banner, Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../queue/shared/depth'
import { DISPATCH_NAMESPACES, DISPATCH_NS, kilograms } from '../../pickup/dispatch'
import type { Manifest } from '../api'
import '../../shipments.css'
import '../../queue/shared/depth.css'
import '../../pickup/dispatch.css'

export type WindowProblem = 'notFound' | 'forbidden' | 'failed'

export interface ManifestWindowModel {
  readonly prefix: string
  readonly read: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: WindowProblem } | { readonly status: 'ready'; readonly value: Manifest }
  /** The closed sheet's PDF; null: the person cannot read files (files.read), or the sheet is still open. */
  readonly pdf: { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready'; readonly value: Uint8Array; readonly name: string } | null
  readonly readFiles: boolean
}

/**
 * SCR-652 — the End-of-day manifest PDF window (B-W2b-412 on B-W2b-395; design warehouse.shipments tab sh-tab-manifest "the
 * driver signs the paper"; a window page): the carrier, the day, who closed it (a person or the system, never named), the
 * totals, each shipment on it, and the sheet's PDF in the viewer (print, download) — signed by the driver on paper.
 */
export function ManifestWindowView({ model, onRetry }: { model: ManifestWindowModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[...DISPATCH_NAMESPACES, 'shell']}>
      <Body model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ model, onRetry }: { model: ManifestWindowModel; onRetry?: () => void }) {
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
  const sheet = model.read.value
  const title = t('manifest.title', { carrier: sheet.carrierName, date: formatDate(dayInstant(sheet.day), { locale }) })
  return (
    <div className="fw-dsp-window">
      <div className="fw-dsp-band">
        <span className="fw-shd-actions">
          <h1 className="fw-dsp-h1">{title}</h1>
          <Pill tone={sheet.state === 'CLOSED' ? 'success' : 'warning'}>{t(`manifest.state.${sheet.state}`)}</Pill>
        </span>
        <Link className="fw-sh-link" href={`${model.prefix}/warehouse/shipments`}>
          {t('window.back')}
        </Link>
      </div>
      <div className="fw-dsp-window-grid">
        <Card padded>
          <div className="fw-shd-stack">
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('manifest.site'), value: `${sheet.site.code} · ${sheet.site.name}` },
                { label: t('manifest.closed'), value: sheet.closedAt ? t(sheet.closedBy === 'SYSTEM' ? 'manifest.closedBySystem' : 'manifest.closedByPerson', { when: formatDateTime(sheet.closedAt, { locale }) }) : t('manifest.notClosed') },
                { label: t('manifest.totals'), value: t('eod.totals', { shipments: sheet.totals.shipments, parcels: sheet.totals.parcels, weight: kilograms(sheet.totals.weightKg, locale) ?? '0' }) },
              ]}
            />
            <SummaryTable
              label={t('eod.sheetLabel')}
              columns={[t('eod.col.shipment'), t('eod.col.consignee'), t('eod.col.parcels'), t('eod.col.weight'), t('eod.col.ddt')]}
              rows={sheet.shipments.map((row) => ({
                id: row.id,
                cells: [
                  <Link key="n" className="fw-sh-link" href={`${model.prefix}/warehouse/shipments/${row.id}`}>
                    {row.number}
                  </Link>,
                  <span key="c" className="fw-sh-cell">
                    <span>{row.consignee}</span>
                    <span className="fw-sh-cell-sub">{[row.city, row.country].filter(Boolean).join(', ')}</span>
                  </span>,
                  <span key="p">{row.parcels}</span>,
                  <span key="w">{kilograms(row.weightKg, locale) ?? '—'}</span>,
                  <span key="d" className="fw-sh-mono">
                    {row.ddtNumber ?? '—'}
                  </span>,
                ],
              }))}
              density="compact"
              stackOnPhone
              align={['left', 'left', 'right', 'right', 'left']}
            />
            <p className="fw-sh-hint">{t('manifest.sign')}</p>
          </div>
        </Card>
        {sheet.state !== 'CLOSED' ? (
          <Card padded>
            <Banner tone="info" title={t('eod.refusal.NOT_CLOSED')} />
          </Card>
        ) : !model.readFiles ? (
          <Card padded>
            <Banner tone="info" title={t('manifest.noFiles')} />
          </Card>
        ) : !model.pdf || model.pdf.status === 'loading' ? (
          <p className="fw-sh-hint" role="status">
            <Spinner size={12} /> {t('manifest.loading')}
          </p>
        ) : model.pdf.status === 'error' ? (
          <Card padded>
            <Banner tone="danger" title={t('manifest.pdfFailed')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('window.retry')}</Button>} />
          </Card>
        ) : (
          <PdfViewer src={model.pdf.value} title={title} fileName={model.pdf.name} height="calc(100vh - 200px)" labels={pdfViewerLabels(shell)} />
        )}
      </div>
    </div>
  )
}

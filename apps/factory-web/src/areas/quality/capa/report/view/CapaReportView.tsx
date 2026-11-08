'use client'

import { Archive, Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { ReportLanguage } from '../../api'
import { CapaMessages, NoticeLine, useCapaWords, type CapaNotice } from '../../parts'

/** SCR-146-report — the 8D window's view model. */
export interface CapaReportModel {
  /** quality.capa.view. */
  readonly allowed: boolean
  /** quality.capa.manage: Keep a version. */
  readonly canKeep: boolean
  readonly language: ReportLanguage
  readonly capa: { readonly number: string; readonly title: string; readonly type: 'CAPA' | 'EIGHT_D' } | null
  readonly pdf: Uint8Array | null
  readonly problem: string | null
  readonly keeping: boolean
  readonly notice: CapaNotice | null
}

export interface CapaReportActions {
  onLanguage?: (language: ReportLanguage) => void
  onKeep?: () => void
  onRetry?: () => void
}

/**
 * tab:capa-pdf — "8D report (PDF)" (design quality.capa new tab: sent to or uploaded for the customer): the report in the
 * DS PdfViewer, in Italian or English, made by the API from the record (its banner says "preview": stored nowhere); Print
 * prints it; Keep a version keeps it on the CAPA (the same contents give the newest version back).
 */
export function CapaReportView({ model, actions }: { model: CapaReportModel; actions?: CapaReportActions }) {
  return (
    <CapaMessages>
      <Report model={model} actions={actions} />
    </CapaMessages>
  )
}

function Report({ model, actions }: { model: CapaReportModel; actions?: CapaReportActions }) {
  const { t } = useCapaWords()
  const shell = useT('shell')
  if (!model.allowed) return <EmptyState title={t('list.noAccessTitle')} description={t('list.noAccessBody')} />
  const title = model.capa ? t('report.windowTitle', { number: model.capa.number, title: model.capa.title }) : t('report.windowTitlePlain')
  const keepHeld = !model.canKeep ? t('held.noManage') : model.keeping ? t('common.working') : !model.pdf ? t('report.heldReading') : null
  return (
    <div className="fw-capa-pdf">
      <div className="fw-capa-pdf-band fw-capa-noprint">
        <h1 className="fw-capa-h1">{title}</h1>
        <span className="fw-q-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={t('report.language')}
            value={model.language}
            onChange={(value) => actions?.onLanguage?.(value as ReportLanguage)}
            options={[
              { value: 'it', label: t('report.it') },
              { value: 'en', label: t('report.en') },
            ]}
          />
          <Button size="sm" heldReason={keepHeld} onClick={() => actions?.onKeep?.()}>
            {model.keeping ? <Spinner size={12} /> : <Archive size={13} aria-hidden />} {t('report.keep')}
          </Button>
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('report.heldReading')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('report.print')}
          </Button>
        </span>
      </div>
      <p className="fw-capa-hint fw-capa-noprint">{t('report.preview')}</p>
      <NoticeLine notice={model.notice} />
      {model.problem ? (
        <Banner
          tone="danger"
          title={t(model.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.pdf ? (
        <PdfViewer src={model.pdf} title={title} fileName={`${model.capa?.number ?? 'capa'}-8D-${model.language}.pdf`} labels={pdfViewerLabels(shell)} height="min(84vh, 1200px)" />
      ) : (
        <p className="fw-capa-hint" role="status">
          <Spinner size={14} /> {t('report.loading')}
        </p>
      )}
    </div>
  )
}

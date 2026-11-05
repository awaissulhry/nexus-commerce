'use client'

import { Archive, Download, Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CheckResult, KeptReport } from '../../api'
import { machineText, typeLabel, type Problem } from '../../model'
import { PREVENTIVE_NAMESPACES, problemText, useDay, useWords } from '../../view/parts'
import '../../preventive.css'

/** SCR-266-report — the check report window's view model. */
export interface CheckReportModel {
  /** plant.view: the report is read for this person. */
  allowed: boolean
  /** plant.checks.manage: Keep in the register. */
  canKeep: boolean
  language: 'it' | 'en'
  result: CheckResult | null
  pdf: Uint8Array | null
  problem: string | null
  keeping: boolean
  kept: KeptReport | null
  keepProblem: Problem | null
  /** The kept file's fingerprint (files.read), its seal. */
  seal: { sha256: string } | null
  /** Why the seal is not drawn (no files.read, a read that failed): a message key. */
  sealHeld: string | null
}

export interface CheckReportActions {
  onLanguage?: (language: 'it' | 'en') => void
  onKeep?: () => void
  onRetry?: () => void
  onDownload?: () => void
}

/**
 * tab:report — "Check report (PDF)" (design plant.preventive new tab, from a result): the report in the DS PdfViewer, in
 * Italian or English, made by the API (the preview's banner says it is stored nowhere); Print prints it; Keep in the
 * register keeps it as the result's CHECK_REPORT document (the same contents give the same version back), then its seal
 * (the DS DocumentSeal: version, fingerprint, when, the server's clock; Verify a file) and the kept copy's download.
 */
export function CheckReportView({ model, actions }: { model: CheckReportModel; actions?: CheckReportActions }) {
  return (
    <WithMessages namespaces={PREVENTIVE_NAMESPACES}>
      <Report model={model} actions={actions} />
    </WithMessages>
  )
}

function Report({ model, actions }: { model: CheckReportModel; actions?: CheckReportActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  if (!model.allowed) return <EmptyState title={t('access.title')} description={t('access.body')} />
  const result = model.result
  const title = result ? t('report.title', { check: typeLabel(result.checkType, locale), machine: result.machine.assetNumber, date: day(result.performedOn) }) : t('report.titlePlain')
  const keepHeld = !model.canKeep ? t('held.manage') : model.keeping ? t('held.saving') : !model.pdf ? t('report.held') : null

  return (
    <div className="fw-pv-pdf">
      <div className="fw-pv-band fw-pv-noprint">
        <span className="fw-pv-head-title">
          <h1 className="fw-pv-h">{title}</h1>
          {result && <span className="fw-pv-muted">{`${machineText(result.machine)} · ${result.site.name}`}</span>}
        </span>
        <span className="fw-pv-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={t('report.language')}
            value={model.language}
            onChange={(value) => actions?.onLanguage?.(value === 'en' ? 'en' : 'it')}
            options={[
              { value: 'it', label: t('report.it') },
              { value: 'en', label: t('report.en') },
            ]}
          />
          <Button size="sm" heldReason={keepHeld} onClick={() => actions?.onKeep?.()}>
            {model.keeping ? <Spinner size={14} /> : <Archive size={13} aria-hidden />} {t('report.keep')}
          </Button>
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('report.held')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('report.print')}
          </Button>
        </span>
      </div>
      <p className="fw-pv-muted fw-pv-noprint">{t('report.preview')}</p>
      {model.keepProblem && <Banner tone="danger" title={problemText(t, model.keepProblem)} />}
      {model.kept && (
        <div className="fw-pv-stack fw-pv-noprint">
          <Banner tone="success" title={t(model.kept.made ? 'report.kept' : 'report.keptSame', { version: model.kept.document.version, date: formatDateTime(model.kept.document.createdAt, { locale }) })}>
            <Button size="sm" variant="quiet" onClick={() => actions?.onDownload?.()}>
              <Download size={13} aria-hidden /> {t('report.download')}
            </Button>
          </Banner>
          {model.seal ? (
            <DocumentSeal title={title} version={`v${model.kept.document.version}`} sha256={model.seal.sha256} sealedAt={formatDateTime(model.kept.document.createdAt, { locale })} timestampSource={t('report.clock')} labels={ds.documentSeal} />
          ) : model.sealHeld ? (
            <p className="fw-pv-muted">{t(model.sealHeld)}</p>
          ) : null}
        </div>
      )}
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
        <PdfViewer src={model.pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
      ) : (
        <p className="fw-pv-muted" role="status">
          <Spinner size={14} /> {t('report.loading')}
        </p>
      )}
    </div>
  )
}

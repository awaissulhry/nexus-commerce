'use client'

import { ExternalLink, Printer } from 'lucide-react'
import { Banner, EmptyState, FileRow } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { TrainingRecord } from '../../api'
import { courseName } from '../../model'
import { useDay, useTrainingWords } from '../../view/parts'

export const PDF_NAMESPACES = ['people-training', 'people', 'lists', 'shell'] as const

/** The certificate window's view model (design people.skills tab:certificate, "Opened from a cell; printable"). */
export interface CertificateModel {
  /** safety.view: the record is read for this person. */
  allowed: boolean
  language: 'it' | 'en'
  /** The person's name and the record, when the window was opened with the person (their Safety training read). */
  person: string | null
  record: TrainingRecord | null
  pdf: Uint8Array | null
  problem: string | null
  /** A provider's file being opened. */
  opening: string | null
}

export interface CertificateActions {
  onLanguage?: (language: 'it' | 'en') => void
  onRetry?: () => void
  onOpenFile?: (fileId: string) => void
}

/**
 * Certificate (PDF) — one training record as the employer's register keeps it (B-W2b-139's PDF, made now, stored nowhere),
 * in Italian or English, printable; under it the provider's own certificate files of the record, each opened as it is. The
 * record names one person: it opens only in this window, from that person's cell or row.
 */
export function CertificateView({ model, actions }: { model: CertificateModel; actions?: CertificateActions }) {
  return (
    <WithMessages namespaces={PDF_NAMESPACES}>
      <Certificate model={model} actions={actions} />
    </WithMessages>
  )
}

function Certificate({ model, actions }: { model: CertificateModel; actions?: CertificateActions | undefined }) {
  const t = useTrainingWords()
  const shell = useT('shell')
  const locale = useLocale()
  const day = useDay()
  if (!model.allowed) return <EmptyState title={t('access.title')} description={t('access.body')} />
  const record = model.record
  const title = record ? t('certificate.title', { course: courseName(record.course, locale), date: day(record.completedOn) }) : t('certificate.titlePlain')
  return (
    <div className="fw-tr-pdf">
      <div className="fw-tr-band fw-tr-noprint">
        <span className="fw-tr-stack">
          <h1>{title}</h1>
          {model.person && <span className="fw-tr-muted">{model.person}</span>}
        </span>
        <span className="fw-tr-row">
          <SegmentedControl
            size="sm"
            ariaLabel={t('pdf.language')}
            value={model.language}
            onChange={(value) => actions?.onLanguage?.(value === 'en' ? 'en' : 'it')}
            options={[
              { value: 'it', label: t('pdf.it') },
              { value: 'en', label: t('pdf.en') },
            ]}
          />
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('pdf.held')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('pdf.print')}
          </Button>
        </span>
      </div>
      <p className="fw-tr-muted fw-tr-noprint">{t('certificate.preview')}</p>
      {record && record.certificates.length > 0 && (
        <div className="fw-tr-stack fw-tr-noprint">
          <h2 className="fw-tr-muted">{t('certificate.provider')}</h2>
          {record.certificates.map((file) => (
            <FileRow
              key={file.id}
              name={file.originalName}
              size={file.sizeBytes}
              actions={
                <Button size="sm" variant="quiet" heldReason={model.opening === file.id ? t('held.busy') : null} onClick={() => actions?.onOpenFile?.(file.id)}>
                  {model.opening === file.id ? <Spinner size={12} /> : <ExternalLink size={13} aria-hidden />} {t('certificate.open')}
                </Button>
              }
            />
          ))}
        </div>
      )}
      {record && record.certificates.length === 0 && <p className="fw-tr-muted fw-tr-noprint">{t('certificate.noProvider')}</p>}
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
        <p className="fw-tr-muted" role="status">
          <Spinner size={14} /> {t('pdf.loading')}
        </p>
      )}
    </div>
  )
}

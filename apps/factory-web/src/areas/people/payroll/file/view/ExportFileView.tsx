'use client'

import { Download } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { FileRow, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TIME_ZONE } from '../../../_shared/model'
import type { Loaded } from '../../../_shared/parts'
import type { ExportFile, ExportRecord } from '../../api'
import { fileHeld, fileOf, monthWords, type FileKind, type PayrollCan, type Words } from '../../model'
import { LayoutWarning, PAYROLL_NAMESPACES, SectionLoading, usePayrollWords, useSaid } from '../../view/parts'

/** SCR-159-file — a file's new tab: its view model. */
export interface ExportFileModel {
  can: PayrollCan
  kind: FileKind
  loaded: Loaded<ExportRecord>
  /** The summary's bytes (this tab's memory alone). */
  pdf: Uint8Array | null
  problem: Words | null
}

/**
 * Export summary (design tab:summary-pdf, "Totals per employee for the consultant's check") in the DS PdfViewer, and Export file
 * (tab:file, "Download") with its name, size and seal. By employee code, never by name. Without the right or the pay grain each says why.
 */
export function ExportFileView({ model, onRetry, onDownload }: { model: ExportFileModel; onRetry?: () => void; onDownload?: (record: ExportRecord, file: ExportFile) => void }) {
  return (
    <WithMessages namespaces={[...PAYROLL_NAMESPACES, 'shell']}>
      <Page model={model} {...(onRetry ? { onRetry } : {})} {...(onDownload ? { onDownload } : {})} />
    </WithMessages>
  )
}

function Page({ model, onRetry, onDownload }: { model: ExportFileModel; onRetry?: () => void; onDownload?: (record: ExportRecord, file: ExportFile) => void }) {
  const t = usePayrollWords()
  const said = useSaid()
  const shell = useT('shell')
  const locale = useLocale()
  const ds = useDsWords()
  const { loaded, kind } = model
  if (!model.can.view) return <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
  if (loaded.status === 'loading') return <SectionLoading words={t('file.reading')} rows={6} />
  if (loaded.status !== 'ready') {
    return <EmptyState title={t(loaded.status === 'forbidden' ? 'problem.forbidden' : 'file.failed')} description={t(loaded.status === 'error' ? loaded.problem : loaded.status === 'forbidden' ? 'file.forbiddenBody' : 'problem.notFound')} action={loaded.status === 'error' ? <Button size="sm" onClick={() => onRetry?.()}>{t('common.retry')}</Button> : undefined} />
  }
  const record = loaded.value
  const file = fileOf(record, kind)
  const held = fileHeld(record, model.can)
  const month = monthWords(record.month, locale)
  const title = t(kind === 'summary' ? 'file.summaryTitle' : 'file.dataTitle', { month, version: record.revision })
  return (
    <div className="fw-pp fw-pay">
      <h1 className="fw-pp-h3">{title}</h1>
      <LayoutWarning layout={record.layout} />
      {held || !file ? (
        <EmptyState title={t('file.heldTitle')} description={held ? said(held) : t('file.noFile')} />
      ) : kind === 'summary' ? (
        model.problem ? (
          <EmptyState title={t('file.failed')} description={said(model.problem)} action={<Button size="sm" onClick={() => onRetry?.()}>{t('common.retry')}</Button>} />
        ) : model.pdf ? (
          <PdfViewer src={model.pdf} title={title} fileName={file.name} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
        ) : (
          <p className="fw-pp-hint" role="status">
            <Spinner size={14} /> {t('file.opening')}
          </p>
        )
      ) : (
        <Card padded className="fw-pay-card">
          <FileRow
            name={file.name}
            size={file.sizeBytes}
            status={t('file.dataKind', { count: file.rowCount, format: file.format })}
            actions={
              <Button size="sm" variant="primary" onClick={() => onDownload?.(record, file)}>
                <Download size={13} aria-hidden /> {t('file.download')}
              </Button>
            }
          />
          {model.problem && <Banner tone="danger" title={said(model.problem)} />}
          <DocumentSeal title={file.name} version={`v${record.revision}`} sha256={file.sha256} sealedAt={record.exportedAt ? formatDateTime(record.exportedAt, { locale, timeZone: TIME_ZONE }) : '—'} timestampSource={t('file.clock')} {...(record.madeBy?.name ? { sealedBy: record.madeBy.name } : {})} labels={ds.documentSeal} />
          <p className="fw-pp-hint">{t('file.recorded')}</p>
          <p className="fw-pp-hint">{t('file.byCode')}</p>
        </Card>
      )}
    </div>
  )
}

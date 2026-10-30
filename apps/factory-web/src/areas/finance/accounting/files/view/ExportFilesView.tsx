'use client'

import { Download } from 'lucide-react'
import { Banner, Card, EmptyState, FileRow, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CheckList } from '../../../_shared/parts'
import type { ExportFile, ExportRecord } from '../../api'
import { fileHeld, monthWords, type AccountingCan, type WriteProblem } from '../../model'
import '../../../_shared/finance.css'
import '../../accounting.css'

/** SCR-156-files — the Export files tab's view model (nothing fetched here). */
export interface ExportFilesModel {
  readonly can: AccountingCan
  /** The batches asked for, in the address's order. */
  readonly ids: readonly string[]
  readonly batches: Readonly<Record<string, { readonly value: ExportRecord | null; readonly problem: string | null }>>
  /** A download that failed. */
  readonly problem: WriteProblem | null
}

export interface ExportFilesActions {
  onDownload?: (exportId: string, file: ExportFile) => void
}

/**
 * Accounting export › Export files (design finance.accounting tab:files, "files for the accountant's software"): per
 * batch its number, month, what it carried, who made it and when, the layout (Nexus's default, to confirm with the
 * accountant), the checks as they stood with each explanation kept, and its files — CSV in the default layout, and for
 * the year-end pack the signed-off valued list copied byte for byte — each downloaded (its package's grain). Nothing is
 * sent: a person hands the files over.
 */
export function ExportFilesView({ model, actions }: { model: ExportFilesModel; actions?: ExportFilesActions }) {
  return (
    <WithMessages namespaces={['finance-accounting', 'finance']}>
      <ExportFiles model={model} actions={actions} />
    </WithMessages>
  )
}

function ExportFiles({ model, actions }: { model: ExportFilesModel; actions?: ExportFilesActions }) {
  const t = useT('finance-accounting')
  if (!model.can.view) {
    return (
      <div className="fw-fac">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }
  if (model.ids.length === 0) {
    return (
      <div className="fw-fac">
        <EmptyState title={t('files.none.title')} description={t('files.none.body')} />
      </div>
    )
  }
  return (
    <div className="fw-fac">
      <div className="fw-fac-section-head">
        <h2 className="fw-fac-h2">{t('files.title', { count: model.ids.length })}</h2>
        <span className="fw-fac-muted">{t('layout.long')}</span>
      </div>
      {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
      <div className="fw-fac-batches">
        {model.ids.map((id) => (
          <Batch key={id} part={model.batches[id] ?? { value: null, problem: null }} can={model.can} actions={actions} />
        ))}
      </div>
    </div>
  )
}

function Batch({ part, can, actions }: { part: { value: ExportRecord | null; problem: string | null }; can: AccountingCan; actions?: ExportFilesActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  if (part.problem) {
    return (
      <Card padded>
        <EmptyState title={t('files.failed')} description={t(part.problem)} />
      </Card>
    )
  }
  const batch = part.value
  if (!batch) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-fac-muted" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      </Card>
    )
  }
  const month = monthWords(batch.period.month, locale)
  const failing = batch.checks.filter((check) => !check.passed)
  return (
    <Card padded className="fw-fac-card">
      <div className="fw-fac-card-head">
        <h3 className="fw-fac-h3">{t('files.batch', { number: batch.number ?? t(`status.${batch.status}`), month })}</h3>
        <Pill tone={batch.status === 'EXPORTED' ? 'success' : batch.status === 'DRAFT' ? 'warning' : 'neutral'}>{t(`status.${batch.status}`)}</Pill>
      </div>
      <KeyValue
        dense
        items={[
          { label: t('files.carried'), value: batch.packages.map((pkg) => t(`package.${pkg}.title`)).join(', ') || '—' },
          { label: t('files.kind'), value: batch.supersedes ? t('export.reExport', { number: batch.supersedes.number ?? '—' }) : t('export.first') },
          { label: t('files.made'), value: `${batch.exportedBy?.name ?? batch.madeBy?.name ?? t('history.someone')} · ${formatDateTime(batch.exportedAt ?? batch.createdAt, { locale })}` },
          ...(batch.supersededBy ? [{ label: t('files.amended'), value: t('history.amendedBy', { number: batch.supersededBy.number ?? '—' }) }] : []),
          ...(batch.note ? [{ label: t('files.note'), value: batch.note }] : []),
        ]}
      />
      {batch.files.length === 0 ? (
        <p className="fw-fac-muted">{t('history.noFiles')}</p>
      ) : (
        <ul className="fw-fac-files" aria-label={t('export.filesLabel', { number: batch.number ?? '—' })}>
          {batch.files.map((file) => {
            const held = fileHeld(file, can)
            return (
              <li key={file.id} className="fw-fac-file">
                <FileRow name={file.file.name} size={file.file.sizeBytes} status={t('files.status', { package: t(`package.${file.package}.title`), count: file.rowCount, format: file.format })} />
                <Button size="sm" heldReason={held ? t(held.key) : undefined} onClick={() => actions?.onDownload?.(batch.id, file)}>
                  <Download size={13} aria-hidden /> {t('files.download')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {failing.length > 0 && (
        <div className="fw-fac-stack">
          <h4 className="fw-fac-h3">{t('files.explained')}</h4>
          <CheckList
            label={t('files.explained')}
            items={failing.map((check) => ({
              id: check.code,
              ok: false,
              words: (
                <span className="fw-fac-stack">
                  <b>{t(`check.${check.code}.title`)}</b>
                  <span>{check.explanation ?? t('files.noExplanation')}</span>
                </span>
              ),
            }))}
          />
        </div>
      )}
      {batch.checks.length > 0 && failing.length === 0 && <p className="fw-fac-muted">{t('files.allPassed', { count: batch.checks.length })}</p>}
    </Card>
  )
}

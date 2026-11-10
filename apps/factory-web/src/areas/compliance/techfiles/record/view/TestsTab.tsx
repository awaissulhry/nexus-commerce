'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ExternalLink, FileSearch, Link2 } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { recordAddress as recordPage } from '../../../../../lib/records/record-links'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Report } from '../../api'
import { fileWriteHeld, reportKind, RESULT_TONE, shortHash } from '../../model'
import { SectionFailed, SectionHead, SectionLoading, useDay, useWords } from '../../view/parts'
import type { RecordActions, RecordModel } from '../view-model'

/**
 * Technical file › Test reports (design rec tab "tests", sec tf-tests; Annex III (i)): the type tests and other reports of the
 * style, read-only — the production-control tests recorded with their lab report, the files of the certificates that cover the
 * style, and the files linked to points (h) and (i): report number, lab, standard clause, sample, result, day, the file (opens
 * in a new tab) and the certificate it supports. "Link a report" links one to point (i) of the checklist.
 */
export function TestsTab({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const prefix = model.prefix
  const linkHeld = fileWriteHeld(model.record.file.status, model.can, model.online)

  const columns = useMemo<ColDef<Report>[]>(() => {
    const titleOf = (row: Report) => {
      const kind = reportKind(row)
      if (kind) return kind.name ? t('tests.kindNamed', { kind: t(`testKind.${kind.test}`), name: kind.name }) : t(`testKind.${kind.test}`)
      if (row.source === 'CERTIFICATE_FILE' && row.certificate) return row.file?.name ?? t('tests.certificateFile', { number: row.certificate.number })
      return row.file?.name ?? '—'
    }
    const ReportCell = ({ data }: ICellRendererParams<Report>) =>
      data ? (
        <span className="fw-tf-cell">
          <span className="fw-tf-strong">{data.reportNumber ?? titleOf(data)}</span>
          <span className="fw-tf-muted">
            {data.reportNumber ? `${titleOf(data)} · ` : ''}
            {t(`reportSource.${data.source}`)}
            {data.batchNumber ? ` · ${t('tests.batch', { batch: data.batchNumber })}` : ''}
          </span>
        </span>
      ) : null
    const ResultCell = ({ data }: ICellRendererParams<Report>) => (data ? data.result ? <Pill tone={RESULT_TONE[data.result]} dot>{t(`result.${data.result}`)}</Pill> : <span className="fw-tf-muted">—</span> : null)
    const FileCell = ({ data }: ICellRendererParams<Report>) =>
      data?.file ? (
        <span className="fw-tf-cell">
          <Button size="sm" variant="quiet" inline heldReason={model.can.filesRead ? null : t('held.filesRead')} onClick={() => actions?.onOpenFile?.(data.file!.id, data.file!.name)} aria-label={t('tests.openFile', { name: data.file.name })}>
            <ExternalLink size={12} aria-hidden /> {data.file.name}
          </Button>
          <span className="fw-tf-hash" title={data.file.sha256}>
            {shortHash(data.file.sha256)}
          </span>
        </span>
      ) : (
        <span className="fw-tf-muted">{t('tests.noFile')}</span>
      )
    const CertificateCell = ({ data }: ICellRendererParams<Report>) =>
      data?.certificate ? (
        <Link className="fw-tf-link" href={`${prefix}${recordPage({ type: 'Certificate', id: data.certificate.id }, OFFICE_PAGES)}`}>
          {data.certificate.number}
        </Link>
      ) : (
        <span className="fw-tf-muted">—</span>
      )
    return [
      { colId: 'report', headerName: t('tests.col.report'), minWidth: 220, flex: 1.8, valueGetter: (params) => (params.data ? (params.data.reportNumber ?? titleOf(params.data)) : ''), cellRenderer: ReportCell, autoHeight: true },
      { colId: 'lab', headerName: t('tests.col.lab'), minWidth: 130, flex: 1, valueGetter: (params) => params.data?.lab ?? '—' },
      { colId: 'clause', headerName: t('tests.col.clause'), minWidth: 130, flex: 1, valueGetter: (params) => params.data?.standardClause ?? '—' },
      { colId: 'sample', headerName: t('tests.col.sample'), minWidth: 120, flex: 0.9, valueGetter: (params) => params.data?.sample ?? '—' },
      { colId: 'result', headerName: t('tests.col.result'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data?.result ? t(`result.${params.data.result}`) : ''), cellRenderer: ResultCell },
      { colId: 'date', headerName: t('tests.col.date'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? day(params.data.date) : '') },
      { colId: 'file', headerName: t('tests.col.file'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.file?.name ?? '', cellRenderer: FileCell, autoHeight: true },
      { colId: 'certificate', headerName: t('tests.col.certificate'), minWidth: 130, flex: 0.8, valueGetter: (params) => params.data?.certificate?.number ?? '', cellRenderer: CertificateCell },
    ]
  }, [t, day, prefix, model.can.filesRead, actions])

  const head = (
    <SectionHead id="fw-tf-tests" title={t('tests.title')} note={t('tests.note')}>
      <Button size="sm" heldReason={linkHeld ? t(linkHeld) : null} onClick={() => actions?.onEvidence?.('I_TEST_REPORTS', null, 'link')}>
        <Link2 size={13} aria-hidden /> {t('tests.link')}
      </Button>
    </SectionHead>
  )
  if (model.reports === null || model.reports.status === 'loading')
    return (
      <div className="fw-tf-tab">
        {head}
        <SectionLoading rows={5} />
      </div>
    )
  if (model.reports.status === 'error')
    return (
      <div className="fw-tf-tab">
        {head}
        <SectionFailed title={t('tests.failed')} problem={model.reports.problem} onRetry={() => actions?.onRetry?.('reports')} />
      </div>
    )
  const rows = model.reports.value.reports
  return (
    <div className="fw-tf-tab">
      {head}
      <ListFrame<Report>
        label={t('tests.title')}
        listKey={null}
        rows={rows}
        rowId={(row) => `${row.source}:${row.id}`}
        columns={columns}
        count={t('tests.count', { count: rows.length })}
        state={rows.length === 0 ? <EmptyState icon={<FileSearch size={22} aria-hidden />} title={t('tests.emptyTitle')} description={t('tests.empty')} /> : undefined}
        cards={{ fields: { report: { role: 'title' }, result: { role: 'aside' }, date: { role: 'subtitle' } } }}
      />
    </div>
  )
}

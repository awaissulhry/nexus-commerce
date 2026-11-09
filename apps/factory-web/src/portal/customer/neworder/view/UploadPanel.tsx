'use client'

import { useMemo } from 'react'
import { Download, FileSpreadsheet } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { FileDropzone } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { SHEET_MAX_BYTES, type UploadAnswer, type Verdict } from '../api'
import { verdictReason, verdictTone } from '../model'
import { useOrderingWords } from '../words'
import { Loading } from './parts'

/**
 * sec:upload (design portal.customer.neworder "Spreadsheet orders for big size runs, with a dry run", SAL-073): the order
 * template (XLSX, a new tab), the sheet (CSV or Excel, at most about 700 KB), then a verdict per row — ready, or refused with
 * the reason — in the shared list frame (read only), the counts, "Download refused rows" to fix them, and "Add N rows to the
 * order": nothing lands in the draft before that. A file the API cannot read says so in our words.
 */

export type SheetState =
  | { state: 'idle' }
  | { state: 'reading'; fileName: string }
  | { state: 'read'; fileName: string; answer: UploadAnswer; applying: boolean }
  | { state: 'failed'; fileName: string; problem: string }

export interface UploadModel {
  sheet: SheetState
  templateHref: string
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
}

export interface UploadActions {
  onFile?: (file: File) => void
  onApply?: () => void
  onRefusedCsv?: () => void
  onOther?: () => void
}

export function UploadPanel({ model, actions }: { model: UploadModel; actions?: UploadActions }) {
  const words = useOrderingWords()
  const { t, locale } = words
  const sheet = model.sheet

  const columns = useMemo((): ColDef<Verdict>[] => {
    const VerdictCell = ({ data }: ICellRendererParams<Verdict>) => (data ? <Pill tone={verdictTone(data)}>{data.status === 'READY' ? t('upload.ready') : t('upload.refused')}</Pill> : null)
    const ReasonCell = ({ data }: ICellRendererParams<Verdict>) => (data ? <span className="fw-pno-cell-sub">{data.reasons.map((reason) => verdictReason(reason, locale, t)).join(' ') || '—'}</span> : null)
    return [
      { colId: 'row', headerName: t('upload.col.row'), width: 80, minWidth: 70, sortable: false, valueGetter: ({ data }) => (data ? String(data.rowNumber) : '') },
      { colId: 'verdict', headerName: t('upload.col.verdict'), cellRenderer: VerdictCell, width: 130, minWidth: 120, sortable: false, valueGetter: ({ data }) => (data ? data.status : '') },
      { colId: 'style', headerName: t('upload.col.style'), flex: 0.8, minWidth: 110, sortable: false, valueGetter: ({ data }) => data?.style ?? '—' },
      { colId: 'colour', headerName: t('upload.col.colour'), flex: 0.7, minWidth: 100, sortable: false, valueGetter: ({ data }) => data?.colour ?? '—' },
      { colId: 'size', headerName: t('upload.col.size'), flex: 0.4, minWidth: 80, sortable: false, valueGetter: ({ data }) => data?.size ?? '—' },
      { colId: 'quantity', headerName: t('upload.col.quantity'), flex: 0.5, minWidth: 90, sortable: false, valueGetter: ({ data }) => (data?.quantity === null || data?.quantity === undefined ? '—' : words.pieces(data.quantity)) },
      { colId: 'yourCode', headerName: t('upload.col.yourCode'), flex: 0.7, minWidth: 110, sortable: false, valueGetter: ({ data }) => data?.yourCode ?? '—' },
      { colId: 'reason', headerName: t('upload.col.reason'), cellRenderer: ReasonCell, flex: 2, minWidth: 240, sortable: false, autoHeight: true, wrapText: true, valueGetter: ({ data }) => (data ? data.reasons.map((reason) => verdictReason(reason, locale, t)).join(' ') : '') },
    ]
  }, [t, locale, words])

  return (
    <Card padded>
      <section className="fw-pno-section" id="upload" aria-labelledby="upload-title">
        <h2 id="upload-title" className="fw-pno-h2">
          {t('upload.title')}
        </h2>
        <p className="fw-pno-quiet">{t('upload.intro')}</p>
        <div className="fw-pno-buttons">
          <Button size="sm" variant="secondary" asChild>
            <a href={model.templateHref} target="_blank" rel="noopener">
              <Download size={14} aria-hidden /> {t('upload.template')}
            </a>
          </Button>
          <span className="fw-pno-quiet">{t('upload.templateHint')}</span>
        </div>
        {sheet.state === 'idle' || sheet.state === 'failed' ? (
          <>
            {sheet.state === 'failed' ? <Banner tone="danger" title={t('upload.failedTitle', { file: sheet.fileName })}>
                {t(sheet.problem)}
              </Banner> : null}
            <FileDropzone accept=".xlsx,.xls,.csv" maxBytes={SHEET_MAX_BYTES} disabled={model.writeHeld !== null} hint={model.writeHeld ?? t('upload.dropHint')} onFiles={(files) => (files[0] ? actions?.onFile?.(files[0]) : undefined)} />
          </>
        ) : sheet.state === 'reading' ? (
          <Loading rows={2} height={44} label={t('upload.reading', { file: sheet.fileName })} />
        ) : (
          <>
            <div className="fw-pno-headrow">
              <span className="fw-pno-buttons">
                <FileSpreadsheet size={16} aria-hidden />
                <strong>{sheet.fileName}</strong>
              </span>
              <span className="fw-pno-counts">
                <Pill tone="neutral">{t('upload.rows', { count: sheet.answer.dryRun.rows })}</Pill>
                <Pill tone="success">{t('upload.readyN', { count: sheet.answer.dryRun.ready })}</Pill>
                {sheet.answer.dryRun.refused > 0 ? <Pill tone="danger">{t('upload.refusedN', { count: sheet.answer.dryRun.refused })}</Pill> : null}
              </span>
            </div>
            <p className="fw-pno-quiet">{sheet.answer.dryRun.ready > 0 ? t('upload.dryRun', { count: sheet.answer.dryRun.lines.length }) : t('upload.nothingReady')}</p>
            {sheet.answer.dryRun.ignored.length > 0 ? <p className="fw-pno-quiet">{t('upload.ignored', { columns: sheet.answer.dryRun.ignored.join(', ') })}</p> : null}
            <ListFrame<Verdict>
              label={t('upload.verdictsLabel', { file: sheet.fileName })}
              listKey={null}
              rows={sheet.answer.dryRun.verdicts}
              rowId={(row) => String(row.rowNumber)}
              columns={columns}
              count={t('upload.rows', { count: sheet.answer.dryRun.rows })}
              cards={{ hrefOf: () => null }}
            />
            <div className="fw-pno-buttons">
              <Button variant="quiet" onClick={() => actions?.onOther?.()} disabled={sheet.applying}>
                {t('upload.other')}
              </Button>
              {sheet.answer.dryRun.refusedCsv ? (
                <Button variant="secondary" onClick={() => actions?.onRefusedCsv?.()}>
                  <Download size={14} aria-hidden /> {t('upload.refusedCsv')}
                </Button>
              ) : null}
              <Button
                variant="primary"
                heldReason={model.writeHeld ?? (sheet.applying ? t('held.busy') : sheet.answer.dryRun.ready === 0 ? t('upload.held.none') : null)}
                onClick={() => actions?.onApply?.()}
              >
                {t('upload.apply', { count: sheet.answer.dryRun.ready })}
              </Button>
            </div>
          </>
        )}
      </section>
    </Card>
  )
}

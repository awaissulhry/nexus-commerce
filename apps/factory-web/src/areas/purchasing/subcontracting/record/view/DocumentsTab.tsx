'use client'

import Link from 'next/link'
import { Eye, FileText, Printer, RotateCcw, XCircle } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { FileRow } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { dayAt } from '../../../../_shared/buying/model'
import type { SubcontractOrder } from '../../api'
import type { SubcontractRecordActions, SubcontractRecordModel } from '../record-model'

/**
 * Documents (design rec documents; tabs job-sheet and ddt): the job sheet — a print page opened in a new tab, printed (or
 * saved as a PDF by the browser) and sent with the kit, with no price on it — and each kit DDT for work on our behalf
 * (DPR 472/1996: number and date kept 10 years, never changed; a mistake is annulled, its number stays): open its PDF,
 * print it again when the stored PDF is missing, annul it (its number typed). The live DDT shows inline in the DS PDF
 * viewer. The workshop's terms and invoices come with W2b and the supplier invoices (B-W2a-62).
 */
export function DocumentsTab({ order, model, actions }: { order: SubcontractOrder; model: SubcontractRecordModel; actions?: SubcontractRecordActions }) {
  const t = useT('subcontract-order')
  const shell = useT('shell')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const jobSheetHref = `${model.prefix}/purchasing/subcontracting/${order.id}/job-sheet`
  const pdf = model.pdf
  const shown = pdf ? order.ddts.find((ddt) => ddt.id === pdf.ddtId) ?? null : null
  return (
    <div className="fw-by-stack">
      <div className="fw-sco-docs">
        <div className="fw-sco-doc">
          <FileRow name={t('docs.jobSheet.name', { number: order.number })} status={t('docs.jobSheet.status')} />
          <span className="fw-by-actions">
            <Button size="sm" variant="secondary" asChild>
              <Link href={jobSheetHref} target="_blank" rel="noopener">
                <Printer size={13} aria-hidden /> {t('docs.jobSheet.open')}
              </Link>
            </Button>
          </span>
        </div>
        {order.ddts.length === 0 && <p className="fw-by-hint">{t('docs.noDdt')}</p>}
        {order.ddts.map((ddt) => (
          <div key={ddt.id} className="fw-sco-doc">
            <FileRow
              name={t('docs.ddt.name', { number: ddt.number })}
              status={
                <span className="fw-by-inline">
                  <Pill tone={ddt.cancelled ? 'neutral' : 'success'}>{t(ddt.cancelled ? 'docs.annulled' : 'docs.live')}</Pill>
                  {t('docs.ddt.status', { date: formatDate(dayAt(ddt.documentDate), place), count: ddt.kitLineIds.length })}
                </span>
              }
            />
            <span className="fw-by-actions">
              {!ddt.cancelled && model.can.files && pdf?.ddtId !== ddt.id && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onShowPdf?.(ddt.id)}>
                  <Eye size={13} aria-hidden /> {t('docs.show')}
                </Button>
              )}
              <Button size="sm" variant="secondary" heldReason={model.can.files ? null : t('docs.noFiles')} onClick={() => actions?.onOpenDdt?.(ddt.id)}>
                <FileText size={13} aria-hidden /> {t('docs.openPdf')}
              </Button>
              {!ddt.cancelled && (
                <Button size="sm" variant="quiet" tone="danger" heldReason={model.busy ? t('held.busy') : model.can.ddtCancel ? null : t('docs.noCancel')} onClick={() => actions?.onDialog?.({ kind: 'annul', ddtId: ddt.id, reason: '', typed: '' })}>
                  <XCircle size={13} aria-hidden /> {t('docs.annul')}
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
      {pdf && shown && (
        <Card padded>
          <div className="fw-by-stack">
            <div className="fw-by-card-head">
              <h3 className="fw-by-h3">{t('docs.ddt.name', { number: shown.number })}</h3>
              <Pill tone="success">{t('docs.live')}</Pill>
            </div>
            {pdf.problem ? (
              <Banner
                tone={pdf.problem === 'docs.pdf.missing' ? 'warning' : 'danger'}
                title={t(pdf.problem)}
                action={
                  pdf.problem === 'docs.pdf.missing' ? (
                    <Button size="sm" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onPrintAgain?.(pdf.ddtId)}>
                      <RotateCcw size={13} aria-hidden /> {t('docs.printAgain')}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => actions?.onShowPdf?.(pdf.ddtId)}>
                      {t('common.retry')}
                    </Button>
                  )
                }
              />
            ) : pdf.data ? (
              <PdfViewer src={pdf.data} title={t('docs.ddt.name', { number: shown.number })} fileName={`DDT-${shown.number.replace('/', '-')}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
            ) : (
              <p className="fw-by-hint" role="status">
                <Spinner size={14} /> {t('docs.pdfLoading')}
              </p>
            )}
          </div>
        </Card>
      )}
      <p className="fw-by-hint">{t('docs.later')}</p>
    </div>
  )
}

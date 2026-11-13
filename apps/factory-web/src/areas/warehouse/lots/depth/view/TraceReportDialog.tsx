'use client'

import { ExternalLink, FileText } from 'lucide-react'
import { TRACE_REPORT_AUDIENCES } from '@nexus/factory-domain/inventory/lots-depth/trace-report'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { TraceAudience, TraceDirection, TraceFormat } from '../api'
import { reportHeld, reportProblems, type DepthCan } from '../model'
import type { LotDepthActions, LotDepthModel, ReportDialog } from '../view-model'
import '../depth.css'
import { useDepthWords } from './DepthParts'

/**
 * B-W2b-320 — Trace report (design warehouse.lots pop:lt-report, SCM-242; opened from the Trace tab and the lot's ⋯): the
 * direction (backward, forward, both), "as of" (the day the answer speaks for), for whom (a customer, a notified body, an
 * authority) and who asked, their reference and the day they asked, PDF or CSV and its language. "Create report (opens in
 * a new tab)" makes the dated document (tab lt-tab-report) — the lot's split children included — kept as a file of the lot
 * for 10 years; the tab is taken in the click. The reports made are listed on the Trace tab with who made them (inside the
 * lot only). No money in it.
 */

const DIRECTIONS: readonly TraceDirection[] = ['BOTH', 'BACKWARD', 'FORWARD']
const FORMATS: readonly TraceFormat[] = ['PDF', 'CSV']
const day = (value: string) => `${value}T12:00:00Z`

export function TraceReportDialog({ code, model, can, timeZone, actions }: { code: string; model: ReportDialog; can: Pick<DepthCan, 'report' | 'files'>; timeZone: string; actions?: LotDepthActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const draft = model.draft
  const problems = reportProblems(draft, model.today)
  const held = say(reportHeld(draft, model.today, can, model.busy))
  const set = actions?.onReportDraft
  const create = () => {
    if (!held) actions?.onConfirmReport?.()
  }
  const done = model.done
  return (
    <Modal
      open
      onClose={() => actions?.onReport?.(false)}
      title={t('ld.report.title', { code })}
      size="lg"
      footer={
        <>
          <span className="fw-wl-hint">{t('ld.report.kept')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onReport?.(false)}>
            {done ? t('ld.common.close') : t('ld.common.cancel')}
          </Button>
          {!done && (
            <Button size="sm" variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
              {model.busy ? <Spinner size={12} /> : <FileText size={13} aria-hidden />} {t('ld.report.create')}
            </Button>
          )}
        </>
      }
    >
      <form
        className="fw-ld-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={say(model.problem) ?? ''} />}
        {done ? (
          <Banner
            tone="success"
            title={t('ld.report.done', { format: done.report.format, asOf: formatDate(day(done.report.asOf), place) })}
            action={
              can.files ? (
                <Button size="sm" onClick={() => actions?.onOpenFile?.(done.file.id)}>
                  <ExternalLink size={13} aria-hidden /> {t('ld.report.openAgain')}
                </Button>
              ) : undefined
            }
          >
            <div className="fw-wl-stack tight">
              <span>{t('ld.report.counts', { nodes: done.report.counts.nodes, exact: done.report.counts.customersExact, possible: done.report.counts.customersPossible, gaps: done.report.counts.gaps })}</span>
              <span>{t('ld.report.byAsOf', { exact: done.report.counts.customersByAsOfExact, possible: done.report.counts.customersByAsOfPossible })}</span>
              {done.report.includes.length > 0 && <span>{t('ld.report.includes', { codes: done.report.includes.map((entry) => entry.code).join(', ') })}</span>}
              {!can.files && <span>{t('ld.report.noFiles')}</span>}
            </div>
          </Banner>
        ) : (
          <>
            <Field label={t('ld.report.direction')}>
              <SegmentedControl ariaLabel={t('ld.report.direction')} size="sm" value={draft.direction} onChange={(value) => set?.({ direction: value as TraceDirection })} options={DIRECTIONS.map((value) => ({ value, label: t(`ld.report.directions.${value}`) }))} />
            </Field>
            <div className="fw-ld-form">
              <Field label={t('ld.report.audience')} required>
                <Select value={draft.audience} onChange={(event) => set?.({ audience: event.target.value as TraceAudience })}>
                  {TRACE_REPORT_AUDIENCES.map((value) => (
                    <option key={value} value={value}>
                      {t(`ld.report.audiences.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('ld.report.recipient')} required hint={t('ld.report.recipientHint')} error={draft.recipient.trim() && problems.recipient ? say(problems.recipient) : undefined}>
                <Input value={draft.recipient} maxLength={200} onChange={(event) => set?.({ recipient: event.target.value })} />
              </Field>
              <Field label={t('ld.report.reference')} error={problems.reference ? say(problems.reference) : undefined}>
                <Input value={draft.reference} maxLength={100} onChange={(event) => set?.({ reference: event.target.value })} />
              </Field>
              <Field label={t('ld.report.requestedOn')} required error={problems.requestedOn ? say(problems.requestedOn) : undefined}>
                <DateField value={draft.requestedOn} max={model.today} onChange={(value) => set?.({ requestedOn: value })} />
              </Field>
              <Field label={t('ld.report.asOf')} hint={t('ld.report.asOfHint')} error={problems.asOf ? say(problems.asOf) : undefined}>
                <DateField value={draft.asOf} max={model.today} onChange={(value) => set?.({ asOf: value })} />
              </Field>
              <Field label={t('ld.report.format')}>
                <SegmentedControl ariaLabel={t('ld.report.format')} size="sm" value={draft.format} onChange={(value) => set?.({ format: value as TraceFormat })} options={FORMATS.map((value) => ({ value, label: t(`ld.report.formats.${value}`) }))} />
              </Field>
              <Field label={t('ld.report.language')}>
                <Select value={draft.language} onChange={(event) => set?.({ language: event.target.value as 'it' | 'en' })}>
                  <option value="it">{t('ld.report.languages.it')}</option>
                  <option value="en">{t('ld.report.languages.en')}</option>
                </Select>
              </Field>
              <Field label={t('ld.report.note')} className="wide" error={problems.note ? say(problems.note) : undefined}>
                <Textarea value={draft.note} maxLength={1000} rows={2} onChange={(event) => set?.({ note: event.target.value })} />
              </Field>
            </div>
            <p className="fw-wl-hint">{t('ld.report.asOfMeans')}</p>
          </>
        )}
      </form>
    </Modal>
  )
}

/** The reports made for the lot (newest first): when, by whom (inside the lot only), for whom, as of, and its file. */
export function ReportsCard({ model, timeZone, actions }: { model: LotDepthModel; timeZone: string; actions?: LotDepthActions }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const depth = model.depth.value
  const reports = model.reports
  const held = !model.can.report ? t('ld.report.held.noRight') : depth && !depth.may.report ? t('ld.report.held.noRight') : null
  return (
    <Card padded>
      <div className="fw-wl-stack tight">
        <div className="fw-wl-card-head">
          <h3 className="fw-wl-h3">{t('ld.report.madeTitle')}</h3>
          <Button size="sm" heldReason={held} onClick={() => actions?.onReport?.(true)}>
            <FileText size={13} aria-hidden /> {t('ld.report.open')}
          </Button>
        </div>
        <p className="fw-wl-hint">{t('ld.report.intro')}</p>
        {!reports || (!reports.value && !reports.problem) ? (
          <p className="fw-wl-hint" role="status">
            <Spinner size={12} /> {t('ld.common.reading')}
          </p>
        ) : !reports.value ? (
          <p className="fw-wl-hint">
            {t('ld.common.readFailed')}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetryReports?.()}>
              {t('ld.common.retry')}
            </Button>
          </p>
        ) : reports.value.length === 0 ? (
          <p className="fw-wl-hint">{t('ld.report.none')}</p>
        ) : (
          <SummaryTable
            label={t('ld.report.madeTitle')}
            columns={[t('ld.report.col.made'), t('ld.report.col.for'), t('ld.report.col.asked'), t('ld.report.col.asOf'), t('ld.report.col.what'), t('ld.report.col.file')]}
            align={['left', 'left', 'left', 'left', 'left', 'right']}
            stackOnPhone
            rows={reports.value.map((row, index) => ({
              id: `${row.at}-${index}`,
              cells: [
                <span key="m" className="fw-st-cell">
                  <span>{formatDateTime(row.at, place)}</span>
                  <span className="fw-st-sub">{row.madeBy?.name ?? t('ld.report.bySystem')}</span>
                </span>,
                <span key="f" className="fw-st-cell">
                  <span>{row.recipient}</span>
                  <span className="fw-st-sub">{[t(`ld.report.audiences.${row.audience}`), row.reference].filter(Boolean).join(' · ')}</span>
                </span>,
                formatDate(day(row.requestedOn), place),
                formatDate(day(row.asOf), place),
                `${t(`ld.report.directions.${row.direction}`)} · ${t(`ld.report.formats.${row.format}`)}`,
                row.fileId ? (
                  <Button key="o" size="sm" variant="quiet" heldReason={model.can.files ? null : t('ld.report.noFiles')} onClick={() => actions?.onOpenFile?.(row.fileId!)}>
                    <ExternalLink size={13} aria-hidden /> {t('ld.report.openFile')}
                  </Button>
                ) : (
                  '—'
                ),
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}

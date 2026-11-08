'use client'

import { Archive, Download, Printer, Share2 } from 'lucide-react'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Checkbox, Radio, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { Read } from '../../../_shared/model'
import { Section } from '../../../_shared/parts'
import type { Reports } from '../../depth/api'
import { keepHeld, shareHeld } from '../../depth/model'
import { DepthMessages, useDepthT } from '../../depth/parts'

/** SCR-076-report — the inspection report window's view model (design tab:qi-report-pdf, a new tab). */
export interface ReportModel {
  /** quality.inspections.view: the report is read for this person. */
  readonly allowed: boolean
  readonly language: 'it' | 'en'
  readonly reports: Read<Reports>
  readonly pdf: Uint8Array | null
  readonly pdfProblem: string | null
  readonly keeping: boolean
  readonly kept: { readonly version: number; readonly language: string; readonly made: boolean } | null
  readonly keepProblem: string | null
  /** shipping.manage: "and mail the link" (the shipment's own Send link). */
  readonly canSend: boolean
  /** `?share=1`: the window opened on Share report link (the share part first). */
  readonly shareFirst: boolean
  readonly share: { readonly shipmentId: string | null; readonly version: number | null; readonly send: boolean; readonly busy: boolean; readonly problem: string | null; readonly lines: readonly string[]; readonly done: { readonly shipment: string; readonly version: number; readonly sent: boolean; readonly withdrawn: number } | null }
}

export interface ReportActions {
  onLanguage?: (language: 'it' | 'en') => void
  onKeep?: () => void
  onRetry?: () => void
  onDownload?: (fileId: string) => void
  onShareDraft?: (draft: { shipmentId?: string | null; version?: number | null; send?: boolean }) => void
  onShare?: () => void
}

/**
 * tab:qi-report-pdf "Inspection report (PDF)" (design quality.inspections, QHS-055 on B-W2b-123): the report of a signed final
 * inspection in the DS PdfViewer — result, AQL table, checks, measurements, the serial or batch check, defects with photos,
 * signatures and releases, the corrections after signing — in Italian or English, made now and kept nowhere (its banner says
 * so); Keep a version (the same contents give the same version back); the kept versions with Download; Share report link =
 * a copy of a version on a shipment that carries these garments, which its customer opens through the shipment's documents
 * link (a newer version withdraws the older copy, kept as evidence), "and mail the link" with shipping.manage. Print prints.
 */
export function InspectionReportView({ model, actions }: { model: ReportModel; actions?: ReportActions }) {
  return (
    <DepthMessages>
      <Report model={model} actions={actions} />
    </DepthMessages>
  )
}

function Report({ model, actions }: { model: ReportModel; actions?: ReportActions }) {
  const td = useDepthT()
  const t = useT('quality')
  const shell = useT('shell')
  const locale = useLocale()
  if (!model.allowed) return <EmptyState title={td('report.noAccess.title')} description={td('report.noAccess.body')} />
  const reports = model.reports.value
  const number = reports?.inspection.number ?? ''
  const title = number ? td('report.title', { number }) : td('report.titlePlain')
  const keepReason = keepHeld({ canMake: reports?.may.make ?? false, signed: reports?.inspection.signed ?? false, pdf: model.pdf !== null, busy: model.keeping })
  const share = model.share
  const shipment = reports?.shipments.find((entry) => entry.id === share.shipmentId) ?? null
  const shareReason = shareHeld({ canShare: reports?.may.share ?? false, versions: reports?.versions.length ?? 0, shareable: shipment?.shareable ?? false, busy: share.busy })
  const shareHeldWords = shareReason ? td(shareReason) : !share.shipmentId ? td('share.held.pick') : null
  const shareSection = reports && (
    <Section id="share" title={td('share.heading')} sub={td('share.sub')}>
      {share.done && <Banner tone="success" title={td(share.done.sent ? 'share.doneSent' : 'share.done', { shipment: share.done.shipment, version: share.done.version })}>{share.done.withdrawn > 0 ? td('share.withdrewOlder', { count: share.done.withdrawn }) : null}</Banner>}
      {share.problem && (
        <Banner tone="danger" title={td(share.problem.startsWith('share.') ? share.problem : 'share.refused')}>
          {share.lines.length > 0 && (
            <ul className="fw-q-lines">
              {share.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {reports.shipments.length === 0 ? (
        <p className="fw-q-hint">{td('share.noShipment')}</p>
      ) : (
        <fieldset className="fw-q-choices">
          <legend>
            <strong>{td('share.shipments')}</strong>
          </legend>
          {reports.shipments.map((entry) => (
            <Radio
              key={entry.id}
              name="share-shipment"
              checked={share.shipmentId === entry.id}
              onChange={() => actions?.onShareDraft?.({ shipmentId: entry.id })}
              label={
                <span className="fw-q-cell">
                  <span>{td('share.shipment', { number: entry.number, customer: entry.customer ?? '—' })}</span>
                  <span className="fw-q-hint">{entry.shareable ? td(`share.status.${entry.status}`) : td('share.notShareable', { status: td(`share.status.${entry.status}`) })}</span>
                </span>
              }
            />
          ))}
        </fieldset>
      )}
      {reports.versions.length > 0 && (
        <Field label={td('share.version')}>
          <Select size="sm" aria-label={td('share.version')} value={String(share.version ?? reports.versions[0]!.version)} onChange={(event) => actions?.onShareDraft?.({ version: Number(event.target.value) })}>
            {reports.versions.map((entry) => (
              <option key={entry.id} value={entry.version}>
                {td('versions.line', { version: entry.version, language: entry.language.toUpperCase(), date: formatDateTime(entry.createdAt, { locale }) })}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Checkbox checked={share.send} disabled={!model.canSend} onChange={(event) => actions?.onShareDraft?.({ send: event.target.checked })} label={model.canSend ? td('share.send') : td('share.sendHeld')} />
      <span>
        <Button variant="primary" size="sm" onClick={() => actions?.onShare?.()} heldReason={shareHeldWords}>
          <Share2 size={13} aria-hidden /> {td('share.go')}
        </Button>
      </span>
      {reports.shares.length > 0 && (
        <SummaryTable
          label={td('share.where')}
          columns={[td('share.col.shipment'), td('share.col.version'), td('share.col.state'), td('share.col.at')]}
          rows={reports.shares.map((entry) => ({
            id: `${entry.shipmentId}:${entry.fileId}`,
            cells: [
              entry.shipmentNumber ?? '—',
              `v${entry.version}`,
              <Tag key="s" tone={entry.live ? 'success' : 'neutral'}>
                {td(entry.live ? 'share.live' : 'share.withdrawn')}
              </Tag>,
              formatDateTime(entry.sharedAt, { locale }),
            ],
          }))}
          stackOnPhone
        />
      )}
    </Section>
  )
  return (
    <div className="fw-qd-report">
      <div className="fw-qd-band fw-qd-noprint">
        <span className="fw-q-cell">
          <h1 className="fw-qd-h">{title}</h1>
          <span className="fw-q-hint">{td('report.preview')}</span>
        </span>
        <span className="fw-q-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={td('report.language')}
            value={model.language}
            onChange={(value) => actions?.onLanguage?.(value === 'en' ? 'en' : 'it')}
            options={[
              { value: 'it', label: td('report.it') },
              { value: 'en', label: td('report.en') },
            ]}
          />
          <Button size="sm" heldReason={keepReason ? td(keepReason) : null} onClick={() => actions?.onKeep?.()}>
            {model.keeping ? <Spinner size={14} /> : <Archive size={13} aria-hidden />} {td('report.keep')}
          </Button>
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : td('report.held.reading')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {td('report.print')}
          </Button>
        </span>
      </div>
      {model.reports.problem && (
        <Banner
          tone="danger"
          title={td('report.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.reports.problem)}
        </Banner>
      )}
      {reports && !reports.inspection.signed && <Banner tone="info" title={td('report.held.notSigned')} />}
      {model.keepProblem && <Banner tone="danger" title={td('report.keepFailed')}>{t(model.keepProblem)}</Banner>}
      {model.kept && <Banner tone="success" title={td(model.kept.made ? 'report.kept' : 'report.keptSame', { version: model.kept.version, language: model.kept.language.toUpperCase() })} />}
      <div className="fw-qd-report-grid">
        <div className="fw-qd-report-pdf">
          {model.shareFirst && shareSection}
          {model.pdfProblem ? (
            <Banner
              tone="danger"
              title={td('report.pdfFailed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(model.pdfProblem)}
            </Banner>
          ) : model.pdf ? (
            <PdfViewer src={model.pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
          ) : reports && !reports.inspection.signed ? null : (
            <p className="fw-q-hint" role="status">
              <Spinner size={14} /> {td('report.reading')}
            </p>
          )}
        </div>
        <div className="fw-q-stack fw-qd-noprint">
          <Section id="versions" title={td('versions.heading')}>
            {!reports ? (
              <p className="fw-q-hint" role="status">
                <Spinner size={14} /> {t('common.loading')}
              </p>
            ) : reports.versions.length === 0 ? (
              <p className="fw-q-hint">{td('versions.none')}</p>
            ) : (
              <ul className="fw-qd-versions">
                {reports.versions.map((entry) => (
                  <li key={entry.id} className="fw-q-cell-row">
                    <span className="fw-q-cell">
                      <span>{td('versions.line', { version: entry.version, language: entry.language.toUpperCase(), date: formatDateTime(entry.createdAt, { locale }) })}</span>
                      <span className="fw-q-hint">{entry.createdBy?.name ? td('versions.by', { name: entry.createdBy.name }) : td('versions.byUnknown')}</span>
                    </span>
                    <Button size="sm" variant="quiet" onClick={() => actions?.onDownload?.(entry.fileId)} aria-label={td('versions.downloadOne', { version: entry.version })}>
                      <Download size={13} aria-hidden /> {td('versions.download')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {!model.shareFirst && shareSection}
        </div>
      </div>
    </div>
  )
}

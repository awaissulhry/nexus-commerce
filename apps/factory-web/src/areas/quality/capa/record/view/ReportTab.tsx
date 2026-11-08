'use client'

import { Archive, ExternalLink, FileText, Send } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { CapaRecord, ReportLanguage } from '../../api'
import { keepReportHeld, reportHref, shareHeld } from '../../model'
import { personWords, useCapaWords } from '../../parts'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'

/**
 * Report (design rec CAPA › report, capa-8d "8D report"; QHS-094): D8 and the printable report for the customer — the
 * PdfViewer preview in the chosen language (a view of the record, made by the API, stored nowhere; its banner says
 * "preview"), Open in a new tab (tab:capa-pdf, for Print), Keep a version (the same contents give the newest back), the
 * versions kept, and Share with the customer on each complaint the 8D answers (B-W2b-192: the newest kept version copied
 * onto the complaint for the customer's portal). Staged approvals of the plan and the closure are W3 (not drawn).
 */
export function ReportTab({ model, record, actions }: { model: CapaRecordModel; record: CapaRecord; actions?: CapaRecordActions }) {
  const { t, say } = useCapaWords()
  const shell = useT('shell')
  const locale = useLocale()
  const capa = record.capa
  const offline = model.live === 'offline'
  const keepHeld = say(keepReportHeld(record, model.can, offline)) ?? (model.report.keeping ? t('common.working') : null)
  const complaints = record.sources.filter((source) => source.recordType === 'Complaint')
  const title = t('report.title', { number: capa.number })

  return (
    <div className="fw-capa-two is-wide-main">
      <div className="fw-capa-stack">
        <div className="fw-q-head">
          <p className="fw-capa-hint">{t(capa.type === 'EIGHT_D' ? 'report.intro8D' : 'report.introCapa')}</p>
          <div className="fw-q-actions">
            <SegmentedControl
              size="sm"
              ariaLabel={t('report.language')}
              value={model.report.language}
              onChange={(value) => actions?.onLanguage?.(value as ReportLanguage)}
              options={[
                { value: 'it', label: t('report.it') },
                { value: 'en', label: t('report.en') },
              ]}
            />
            <Button size="sm" onClick={() => window.open(reportHref(model.prefix, capa.id, model.report.language), '_blank', 'noopener')}>
              <ExternalLink size={13} aria-hidden /> {t('report.open')}
            </Button>
            <Button size="sm" variant="primary" heldReason={keepHeld} onClick={() => actions?.onKeep?.()}>
              {model.report.keeping ? <Spinner size={12} /> : <Archive size={13} aria-hidden />} {t('report.keep')}
            </Button>
          </div>
        </div>
        <p className="fw-capa-hint">{t('report.preview')}</p>
        {model.report.problem ? (
          <Banner
            tone="danger"
            title={t(model.report.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onLanguage?.(model.report.language)}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : model.report.pdf ? (
          <PdfViewer src={model.report.pdf} title={title} fileName={`${capa.number}-8D-${model.report.language}.pdf`} labels={pdfViewerLabels(shell)} height="min(78vh, 1000px)" />
        ) : (
          <p className="fw-capa-hint" role="status">
            <Spinner size={14} /> {t('report.loading')}
          </p>
        )}
      </div>

      <div className="fw-capa-stack">
        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-versions">
            <h2 id="capa-versions" className="fw-capa-h2">
              {t('report.versions', { count: record.documents.length })}
            </h2>
            {record.documents.length === 0 ? (
              <p className="fw-capa-hint">{t('report.versionsNone')}</p>
            ) : (
              <ul className="fw-capa-list">
                {record.documents.map((document) => (
                  <li key={document.id}>
                    <Button size="xs" variant="quiet" heldReason={model.can.filesRead ? null : t('held.noFiles')} onClick={() => actions?.onOpenFile?.(document.fileId)}>
                      <FileText size={13} aria-hidden /> {t('report.version', { version: document.version, language: t(`report.${document.language === 'en' ? 'en' : 'it'}`) })}
                    </Button>
                    <span className="fw-capa-hint">{`${formatDateTime(document.createdAt, { locale })} · ${personWords(record.people, document.createdById, model.me, t)}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Card>
        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-share">
            <h2 id="capa-share" className="fw-capa-h2">
              {t('report.share')}
            </h2>
            <p className="fw-capa-hint">{t('report.shareHint')}</p>
            {complaints.length === 0 ? (
              <p className="fw-capa-hint">{t('report.shareNone')}</p>
            ) : (
              <ul className="fw-capa-list">
                {complaints.map((source) => {
                  const held = say(shareHeld(source, record, model.can, offline)) ?? (model.report.sharing ? t('common.working') : null)
                  return (
                    <li key={source.id} className="fw-capa-row">
                      <span className="fw-q-code">{source.record?.number ?? t('row.hiddenSource')}</span>
                      <Button size="sm" heldReason={held} onClick={() => actions?.onShare?.(source.recordId)}>
                        {model.report.sharing === source.recordId ? <Spinner size={12} /> : <Send size={13} aria-hidden />} {t('report.shareButton')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </Card>
      </div>
    </div>
  )
}

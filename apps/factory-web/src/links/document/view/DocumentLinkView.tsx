'use client'

import type { ReactNode } from 'react'
import { Clock3, Download, FileCheck2, FileText, Info, Link2Off, ShieldAlert, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, PressableRow } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { LinkDocument, LinkDocuments } from '../api'
import { dayInstant, documentRows, fileNameOf, isPdf, languageName, opensLeftTone, rowOf, shownDocument, type DocumentLinkActions, type DocumentLinkViewModel } from '../model'
import '../document-link.css'

export type { DocumentLinkViewModel, DocumentLinkActions } from '../model'

/**
 * SCR-101 — the shipment's documents by link (design links.document, W1; links.frame; LOG-020, PPE Reg. art. 8(8),
 * COL-051): the link frame (the sender, the language, whom to ask, the privacy notice) around ONE task — the documents
 * the sender shared for this shipment (the DDT, the Declaration of Conformity and the user information per style, each
 * in its languages), what the chosen one is (type, for which shipment and style, number, date, language), the document
 * read in the page (the PDF viewer), its other languages or "available in <language> only", and Download (primary).
 * The link's own state stays in view ("works until … · N opens left"); a link that expires or is withdrawn while the
 * page is open says so and offers "Ask for a new link" (one answer whatever the link was). No price, ever.
 */
export function DocumentLinkView({ model, actions }: { model: DocumentLinkViewModel; actions?: DocumentLinkActions }) {
  return (
    <WithMessages namespaces={['document-link']}>
      <DocumentLinkPage model={model} actions={actions} />
    </WithMessages>
  )
}

function DocumentLinkPage({ model, actions }: { model: DocumentLinkViewModel; actions?: DocumentLinkActions }) {
  const t = useT('document-link')
  const documents = model.documents
  return (
    <LinkFrameView model={{ sender: null, title: documents ? t('title', { number: documents.shipment.number }) : null, body: { kind: 'task' }, timeZone: model.timeZone }}>
      {model.link === 'loading' ? (
        <LoadingBody slow={model.slow} />
      ) : model.link === 'error' ? (
        <Card padded className="fw-link-state tone-danger">
          <EmptyState
            icon={<ShieldAlert size={28} aria-hidden />}
            title={t('state.error.title')}
            description={t('state.error.body')}
            action={
              <Button variant="primary" onClick={() => actions?.onRetry?.()}>
                {t('retry')}
              </Button>
            }
          />
        </Card>
      ) : model.link === 'expired' || model.link === 'unavailable' ? (
        <DeadBody model={model} actions={actions} />
      ) : documents ? (
        <ValidBody documents={documents} model={model} actions={actions} />
      ) : (
        <LoadingBody slow={model.slow} />
      )}
    </LinkFrameView>
  )
}

// ---- loading: the shape of what comes ----------------------------------------------------------------------------------

function LoadingBody({ slow }: { slow: boolean }) {
  const t = useT('document-link')
  return (
    <div className="fw-dl" aria-busy="true">
      <Skeleton width="60%" height={18} />
      <Card padded className="fw-dl-card">
        <Skeleton width="45%" height={20} />
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={48} />
        ))}
      </Card>
      <Skeleton height={320} />
      <p className="fw-dl-hint" role="status">
        {slow ? (
          <>
            <Spinner size={14} /> {t('loading.slow')}
          </>
        ) : (
          t('loading.label')
        )}
      </p>
    </div>
  )
}

// ---- the link died while the page was open ---------------------------------------------------------------------------

function DeadBody({ model, actions }: { model: DocumentLinkViewModel; actions?: DocumentLinkActions }) {
  const t = useT('document-link')
  const locale = useLocale()
  const expired = model.link === 'expired'
  const at = model.expiredAt ?? model.documents?.link.expiresAt ?? null
  return (
    <div className="fw-dl">
      <Card padded className="fw-link-state tone-warning">
        <EmptyState
          icon={expired ? <Clock3 size={28} aria-hidden /> : <Link2Off size={28} aria-hidden />}
          title={expired ? t('state.expired.title') : t('state.withdrawn.title')}
          description={expired ? (at ? t('state.expired.body', { time: formatDateTime(at, { locale, timeZone: model.timeZone }) }) : t('state.expired.bodyNoTime')) : t('state.withdrawn.body')}
          action={<AskButton model={model} actions={actions} />}
        />
      </Card>
      {model.ask === 'done' && (
        <p className="fw-dl-hint" role="status">
          {t('ask.done')}
        </p>
      )}
      {model.ask === 'failed' && <Banner tone="danger" title={t('ask.failed')} />}
      <p className="fw-dl-hint">{t('ask.onlyOnFile')}</p>
    </div>
  )
}

function AskButton({ model, actions }: { model: DocumentLinkViewModel; actions?: DocumentLinkActions }) {
  const t = useT('document-link')
  if (model.ask === 'done') {
    return (
      <Button variant="secondary" heldReason={t('ask.held')}>
        {t('ask.asked')}
      </Button>
    )
  }
  return (
    <Button variant="primary" heldReason={model.ask === 'busy' ? t('ask.busy') : null} onClick={() => actions?.onAskNewLink?.()}>
      {model.ask === 'busy' && <Spinner size={14} />} {model.ask === 'failed' ? t('ask.again') : t('ask.label')}
    </Button>
  )
}

// ---- the documents ---------------------------------------------------------------------------------------------------

/** A document's type in this page's words (the API's title is English). */
function kindWords(t: Translate, document: Pick<LinkDocument, 'kind'>): string {
  return t(`kind.${document.kind}`)
}

/** "DoC · DEMO-JKT-01 · rev. 3" — the type, then what it is of. */
function rowLabel(t: Translate, document: LinkDocument): string {
  if (document.kind === 'DDT') return document.number ? t('row.ddt', { number: document.number }) : kindWords(t, document)
  if (document.kind === 'OTHER') return document.originalName
  return document.style ? t('row.styled', { kind: kindWords(t, document), style: document.style.code }) : kindWords(t, document)
}

const KIND_ICON: Readonly<Record<LinkDocument['kind'], ReactNode>> = {
  DDT: <Truck size={18} aria-hidden />,
  DECLARATION_OF_CONFORMITY: <FileCheck2 size={18} aria-hidden />,
  USER_INFORMATION: <Info size={18} aria-hidden />,
  OTHER: <FileText size={18} aria-hidden />,
}

function ValidBody({ documents, model, actions }: { documents: LinkDocuments; model: DocumentLinkViewModel; actions?: DocumentLinkActions }) {
  const t = useT('document-link')
  const shell = useT('shell')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale, timeZone: model.timeZone })
  const when = (value: string) => formatDate(value, { locale, timeZone: model.timeZone })
  const rows = documentRows(documents.documents, locale)
  const shown = shownDocument(documents.documents, model.chosen)
  const row = shown ? rowOf(rows, shown.fileId) : null
  const versions = row?.versions ?? []
  const { shipment, link } = documents
  const sent = shipment.deliveredAt ? t('shipment.delivered', { date: when(shipment.deliveredAt) }) : shipment.shippedAt ? t('shipment.shipped', { date: when(shipment.shippedAt) }) : t('shipment.notShipped')

  return (
    <div className="fw-dl">
      <p className="fw-dl-status" role="status">
        <span>{t('status.works', { date: formatDate(link.expiresAt, { locale, timeZone: model.timeZone }) })}</span>
        <Pill tone={opensLeftTone(link.usesLeft)}>{t('status.opensLeft', { count: link.usesLeft })}</Pill>
      </p>

      {documents.documents.length === 0 ? (
        <Card padded className="fw-link-state tone-info">
          <EmptyState icon={<FileText size={28} aria-hidden />} title={t('empty.title')} description={t('empty.body', { number: shipment.number })} />
        </Card>
      ) : (
        <>
          <Card padded className="fw-dl-card">
            <h2 className="fw-dl-h2">{t('list.title', { count: rows.length })}</h2>
            <p className="fw-dl-hint">{t('list.for', { number: shipment.number, sent })}</p>
            <div className="fw-dl-rows" role="list" aria-label={t('list.title', { count: rows.length })}>
              {rows.map((entry) => {
                const current = !!shown && entry.versions.some((version) => version.fileId === shown.fileId)
                const languages = entry.versions.flatMap((version) => (version.language ? [languageName(version.language, locale)] : []))
                return (
                  <div key={entry.document.fileId} role="listitem">
                    <PressableRow
                      stacked
                      current={current}
                      leading={<span className="fw-dl-row-icon">{KIND_ICON[entry.document.kind]}</span>}
                      label={rowLabel(t, entry.document)}
                      onClick={() => actions?.onChoose?.(entry.versions.find((version) => version.fileId === shown?.fileId)?.fileId ?? entry.document.fileId)}
                    >
                      <span className="fw-dl-row-sub">
                        {entry.document.kind === 'DDT'
                          ? kindWords(t, entry.document)
                          : entry.document.style
                            ? entry.document.style.revision === null
                              ? entry.document.style.name
                              : t('row.revision', { name: entry.document.style.name, revision: entry.document.style.revision })
                            : t('row.file')}
                        {languages.length > 0 ? ` · ${languages.join(', ')}` : ''}
                      </span>
                    </PressableRow>
                  </div>
                )
              })}
            </div>
          </Card>

          {shown && (
            <Card padded className="fw-dl-card">
              <h2 className="fw-dl-h2">
                {KIND_ICON[shown.kind]} {kindWords(t, shown)}
              </h2>
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  ...(shown.kind === 'OTHER' ? [{ label: t('fact.file'), value: shown.originalName }] : []),
                  { label: t('fact.shipment'), value: `${shipment.number} · ${sent}` },
                  ...(shown.style ? [{ label: t('fact.style'), value: shown.style.revision === null ? `${shown.style.code} · ${shown.style.name}` : t('fact.styleRevision', { code: shown.style.code, name: shown.style.name, revision: shown.style.revision }) }] : []),
                  ...(shown.number ? [{ label: t('fact.number'), value: shown.number }] : []),
                  ...(shown.date ? [{ label: t('fact.date'), value: day(shown.date) }] : []),
                  ...(shown.language ? [{ label: t('fact.language'), value: languageName(shown.language, locale) }] : []),
                ]}
              />
              <LanguageChoice versions={versions} shown={shown} onChoose={(fileId) => actions?.onChoose?.(fileId)} />
              <div className="fw-dl-actions">
                <Button variant="primary" onClick={() => actions?.onDownload?.()}>
                  <Download size={16} aria-hidden /> {t('download')}
                </Button>
              </div>
              <p className="fw-dl-hint">{t('logged')}</p>
            </Card>
          )}

          {shown && isPdf(shown) && model.pdf?.fileId === shown.fileId && (
            <div className="fw-dl-viewer">
              {model.pdf.state === 'ready' && model.pdf.data ? (
                // The viewer's own Download saves these bytes (already read: no second logged download).
                <PdfViewer src={model.pdf.data} title={rowLabel(t, shown)} fileName={fileNameOf(shown)} labels={pdfViewerLabels(shell)} height="min(70vh, 720px)" />
              ) : model.pdf.state === 'failed' ? (
                <Card padded className="fw-link-state tone-warning">
                  <EmptyState
                    icon={<FileText size={28} aria-hidden />}
                    title={t('pdf.failed.title')}
                    description={t('pdf.failed.body')}
                    action={
                      <Button variant="secondary" onClick={() => actions?.onRetryPdf?.()}>
                        {t('retry')}
                      </Button>
                    }
                  />
                </Card>
              ) : (
                <Card padded aria-busy="true" className="fw-dl-card">
                  <p className="fw-dl-hint" role="status">
                    <Spinner size={14} /> {t('pdf.loading')}
                  </p>
                  <Skeleton height={280} />
                </Card>
              )}
            </div>
          )}
          {shown && !isPdf(shown) && <p className="fw-dl-hint">{t('pdf.notPdf')}</p>}
        </>
      )}
    </div>
  )
}

/** The same document in other languages (up to three as a switch, more as a list), or the one language it exists in. */
function LanguageChoice({ versions, shown, onChoose }: { versions: readonly LinkDocument[]; shown: LinkDocument; onChoose: (fileId: string) => void }) {
  const t = useT('document-link')
  const locale = useLocale()
  if (shown.kind === 'DDT' || shown.kind === 'OTHER' || !shown.language) return null
  if (versions.length <= 1) return <p className="fw-dl-hint">{t('languages.only', { language: languageName(shown.language, locale) })}</p>
  const options = versions.map((version) => ({ value: version.fileId, label: <span lang={version.language ?? undefined}>{languageName(version.language ?? '', locale)}</span> }))
  return (
    <div className="fw-dl-languages">
      <span className="fw-dl-hint">{t('languages.label')}</span>
      {versions.length <= 3 ? (
        <SegmentedControl ariaLabel={t('languages.label')} value={shown.fileId} onChange={onChoose} options={options} wrap />
      ) : (
        <Select aria-label={t('languages.label')} value={shown.fileId} onChange={(event) => onChoose(event.target.value)}>
          {versions.map((version) => (
            <option key={version.fileId} value={version.fileId}>
              {languageName(version.language ?? '', locale)}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}

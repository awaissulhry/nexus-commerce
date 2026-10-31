'use client'

import { Download, FileCheck2, FileStack, FileText, Link2, Lock, Paperclip, Printer, Send } from 'lucide-react'
import { Banner, Card, EmptyState, FileRow, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { Ddt, DdtDraft, Shipment, TravelDocument } from '../../api'
import { DOCUMENT_STATE_TONE, ddtProblemGroups, kilos, languageName, LINK_STATE_TONE } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { PartState } from './ShipmentRecordView'

/**
 * Documents (design sh-ddt, sh-doc-conf): the DDT (DPR 472/1996) — while none is live, the draft the server would issue
 * with every field, its problems in words and the number it would take, read as a PDF with the SAMPLE banner (no number
 * used); issued once, it is frozen: its number and date are kept 10 years in the fiscal archive and never change, a
 * mistake is fixed only by annulling it (its number stays, "Annulled", with the reason) and issuing a new one; then the
 * Declaration of Conformity and the user information each style travels with, in the order's language (a fallback says
 * so), the copies attached for the customer, and the customer's document link (send, resend; its state and opens). The
 * packing list travels in the parcels only. B-W2a-71: Other documents (design sh-docs-other: the packing list's versions,
 * each with its number, version and when it was made) and "Print all" — the driver's pack in a new tab.
 */
export function DocumentsTab({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  if (model.ddts.value === null) return <PartState problem={model.ddts.problem} onRetry={() => actions?.onRetryPart?.('ddts')} label={t('docs.ddt.title')} />
  const live = model.ddts.value.find((row) => row.status === 'LIVE') ?? null
  const annulled = model.ddts.value.filter((row) => row.status === 'CANCELLED')
  return (
    <div className="fw-sh-stack">
      <div className="fw-sh-cards fw-sh-cards--wide">
        <DdtCard shipment={shipment} model={model} actions={actions} live={!!live} />
        <div className="fw-sh-stack">
          <TravelCard shipment={shipment} model={model} actions={actions} />
          <OtherDocumentsCard shipment={shipment} model={model} actions={actions} />
          <LinkCard shipment={shipment} model={model} actions={actions} />
        </div>
      </div>
      {annulled.length > 0 && (
        <Card padded>
          <h2 className="fw-sh-h2">{t('docs.annulled.title')}</h2>
          <SummaryTable
            label={t('docs.annulled.title')}
            columns={[t('docs.annulled.col.number'), t('docs.annulled.col.date'), t('docs.annulled.col.when'), t('docs.annulled.col.state')]}
            rows={annulled.map((row) => ({
              id: row.id,
              cells: [<span key="n" className="fw-sh-mono">{row.number}</span>, row.documentDate, row.cancelledAt ? <DateTime key="c" at={row.cancelledAt} /> : '—', <Pill key="s" tone="neutral">{t('docs.annulled.state')}</Pill>],
            }))}
            density="roomy"
            stackOnPhone
          />
          <p className="fw-sh-hint">{t('docs.annulled.note')}</p>
        </Card>
      )}
    </div>
  )
}

function DateTime({ at }: { at: string }) {
  const locale = useLocale()
  return <>{formatDateTime(at, { locale })}</>
}

function DdtCard({ shipment, model, actions, live }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions; live: boolean }) {
  const t = useT('shipments')
  const shell = useT('shell')
  const ddt = live ? (model.ddt?.value ?? null) : null
  const preview = model.preview?.value ?? null
  const groups = ddtProblemGroups(preview)
  const issueHeld = !model.can.issueDdt ? t('held.noIssue') : shipment.status !== 'PACKED' && !(shipment.status === 'SHIPPED' && shipment.ddtRequired) ? t('held.ddtState') : null

  return (
    <Card padded>
      <div className="fw-sh-card-head">
        <h2 className="fw-sh-h2">
          <FileCheck2 size={16} aria-hidden /> {t('docs.ddt.title')}
        </h2>
        {live && ddt ? <Pill tone="success">{t('docs.ddt.issued', { number: ddt.number })}</Pill> : <Pill tone="neutral">{t('docs.ddt.draft')}</Pill>}
      </div>
      {!shipment.ddtRequired ? (
        <p className="fw-sh-hint">{t('docs.ddt.notRequired')}</p>
      ) : live ? (
        model.ddt?.value ? (
          <>
            <p className="fw-sh-frozen">
              <Lock size={14} aria-hidden /> {t('docs.ddt.frozen', { number: model.ddt.value.number })}
            </p>
            <DdtFacts printed={model.ddt.value} number={model.ddt.value.number} />
            <span className="fw-sh-inline">
              {model.can.readFiles && model.ddt.value.fileId && (
                <Button size="sm" onClick={() => actions?.onDownloadDdt?.(model.ddt!.value!.id)}>
                  <Download size={14} aria-hidden /> {t('docs.ddt.download')}
                </Button>
              )}
              {!model.ddt.value.fileId && model.can.issueDdt && (
                <Button size="sm" onClick={() => actions?.onPrintDdtAgain?.(model.ddt!.value!.id)}>
                  <Printer size={14} aria-hidden /> {t('docs.ddt.printAgain')}
                </Button>
              )}
            </span>
          </>
        ) : (
          <PartState problem={model.ddt?.problem ?? null} onRetry={() => actions?.onRetryPart?.('ddts')} label={t('docs.ddt.title')} />
        )
      ) : (
        <>
          {model.preview?.problem ? (
            <Banner tone="warning" title={t('docs.ddt.previewFailed')}>
              {t(model.preview.problem)}
            </Banner>
          ) : !preview ? (
            shipment.status === 'PACKED' || shipment.status === 'DRAFT' ? (
              <p className="fw-sh-hint" role="status">
                <Spinner size={14} /> {t('docs.ddt.previewLoading')}
              </p>
            ) : (
              <p className="fw-sh-hint">{t('docs.ddt.none')}</p>
            )
          ) : (
            <>
              {preview.problems.length > 0 ? (
                <Banner tone={shipment.status === 'DRAFT' ? 'info' : 'warning'} title={t('docs.ddt.checksOpen', { count: preview.problems.length })}>
                  <ul className="fw-sh-list">
                    {[...groups.state, ...groups.company, ...groups.fields.map((entry) => entry.message)].map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </Banner>
              ) : (
                <p className="fw-sh-hint">{t('docs.ddt.readyToIssue', { number: preview.expectedNumber ?? '—' })}</p>
              )}
              <DdtFacts printed={preview.draft} number={null} />
            </>
          )}
          <span className="fw-sh-inline">
            <Button size="sm" variant="primary" heldReason={issueHeld ?? (preview && preview.problems.length > 0 ? t('held.ddtChecks', { count: preview.problems.length }) : null)} onClick={() => actions?.onDialog?.({ kind: 'issueDdt' })}>
              {t('step.issueDdt', { number: preview?.expectedNumber ?? '' })}
            </Button>
          </span>
        </>
      )}
      {shipment.ddtRequired && <DdtPdf model={model} actions={actions} labels={pdfViewerLabels(shell)} title={model.ddt?.value ? t('docs.ddt.pdfTitle', { number: model.ddt.value.number }) : t('docs.ddt.sampleTitle')} fileName={model.ddt?.value ? `DDT-${model.ddt.value.number.replace(/\//g, '-')}.pdf` : `DDT-${shipment.number}-sample.pdf`} />}
    </Card>
  )
}

function DdtPdf({ model, actions, labels, title, fileName }: { model: ShipmentRecordModel; actions?: ShipmentRecordActions; labels: ReturnType<typeof pdfViewerLabels>; title: string; fileName: string }) {
  const t = useT('shipments')
  const pdf = model.pdf
  if (!pdf) return null
  return (
    <div className="fw-sh-pdf">
      {pdf.sample && <p className="fw-sh-hint">{t('docs.ddt.sampleNote')}</p>}
      {pdf.problem ? (
        <Banner
          tone={pdf.problem === 'docs.pdf.draftHeld' ? 'info' : 'warning'}
          title={t(pdf.problem)}
          action={
            pdf.problem !== 'docs.pdf.noFiles' && pdf.problem !== 'docs.pdf.draftHeld' ? (
              <Button size="sm" onClick={() => actions?.onRetryPart?.('pdf')}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      ) : pdf.data ? (
        <PdfViewer src={pdf.data} title={title} fileName={fileName} labels={labels} height="min(70vh, 760px)" />
      ) : (
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('docs.pdf.loading')}
        </p>
      )}
    </div>
  )
}

/** What the DDT says (DPR 472/1996): who sends it, to whom, where, why, the goods, packages and weight, who carries it, when. */
function DdtFacts({ printed, number }: { printed: DdtDraft | Ddt; number: string | null }) {
  const t = useT('shipments')
  const locale = useLocale()
  const party = (value: DdtDraft['sender']) => [value.name, value.address ? [value.address.line1, `${value.address.postalCode} ${value.address.city}${value.address.province ? ` (${value.address.province})` : ''}`, value.address.country].join(', ') : null, value.vatNumber ? t('docs.ddt.vat', { vat: value.vatNumber }) : null].filter(Boolean).join(' · ')
  const weight = kilos(printed.grossWeightKg, locale)
  const net = kilos(printed.netWeightKg, locale)
  const items = [
    { label: t('docs.ddt.field.number'), value: number ?? t('docs.ddt.field.numberLater') },
    { label: t('docs.ddt.field.date'), value: formatDate(`${printed.documentDate}T12:00:00Z`, { locale }) },
    { label: t('docs.ddt.field.sender'), value: party(printed.sender) },
    { label: t('docs.ddt.field.recipient'), value: party(printed.recipient) },
    ...(printed.destination ? [{ label: t('docs.ddt.field.destination'), value: [printed.destination.name, printed.destination.line1, `${printed.destination.postalCode} ${printed.destination.city}`, printed.destination.country].filter(Boolean).join(', ') }] : []),
    { label: t('docs.ddt.field.reason'), value: printed.reason === 'OTHER' && printed.reasonText ? printed.reasonText : t(`reason.${printed.reason}`) },
    { label: t('docs.ddt.field.goods'), value: t('docs.ddt.goods', { count: printed.lines.length, lines: printed.lines.length, pieces: printed.lines.reduce((sum, line) => sum + Number(line.quantity), 0) }) },
    { label: t('docs.ddt.field.packages'), value: String(printed.packages) },
    { label: t('docs.ddt.field.weight'), value: [weight === null ? '—' : t('list.kg', { value: weight }), net ? t('docs.ddt.net', { value: net }) : null].filter(Boolean).join(' · ') },
    { label: t('docs.ddt.field.appearance'), value: printed.appearance },
    { label: t('docs.ddt.field.transportBy'), value: printed.transportBy === 'CARRIER' && printed.carrier ? t('docs.ddt.carrier', { name: printed.carrier.name }) : t(`transportBy.${printed.transportBy}`) },
    { label: t('docs.ddt.field.start'), value: formatDateTime(printed.startAt, { locale }) },
    ...(printed.freight ? [{ label: t('docs.ddt.field.freight'), value: t(`freight.${printed.freight}`) }] : []),
    ...(printed.documentRefs.length > 0 ? [{ label: t('docs.ddt.field.refs'), value: printed.documentRefs.map((ref) => `${t(`ref.${ref.kind}`)} ${ref.number}`).join(' · ') }] : []),
    ...(printed.remarks ? [{ label: t('docs.ddt.field.remarks'), value: printed.remarks }] : []),
  ]
  return (
    <>
      <KeyValue items={items} labelCase="sentence" />
      <details className="fw-sh-details">
        <summary>{t('docs.ddt.lines', { count: printed.lines.length })}</summary>
        <ul className="fw-sh-list">
          {printed.lines.map((line) => (
            <li key={line.seq}>
              {line.quantity} {line.uom} · {line.description}
              {line.batchNumber ? ` · ${t('docs.ddt.batch', { batch: line.batchNumber })}` : ''}
              {line.serials.length > 0 ? ` · ${line.serials.join(', ')}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}

function TravelCard({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  if (!model.documents.value) return <PartState problem={model.documents.problem} onRetry={() => actions?.onRetryPart?.('documents')} label={t('docs.travel.title')} />
  const documents = model.documents.value
  const travelling = documents.documents.filter((entry) => entry.kind === 'DECLARATION_OF_CONFORMITY' || entry.kind === 'USER_INFORMATION')
  const packingList = documents.documents.find((entry) => entry.kind === 'PACKING_LIST') ?? null
  const attachHeld = !model.can.manage ? t('held.noManage') : documents.counts.toAttach === 0 ? t('held.nothingToAttach') : null
  const docLabel = (entry: TravelDocument) => `${t(`docKind.${entry.kind}`)}${entry.style ? ` · ${entry.style.code}${entry.style.revision !== null ? ` rev. ${entry.style.revision}` : ''}` : ''}`
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        <h2 className="fw-sh-h2">
          <FileText size={16} aria-hidden /> {t('docs.travel.title')}
        </h2>
        {documents.counts.toAttach > 0 ? (
          <Button size="sm" heldReason={attachHeld} onClick={() => actions?.onAttach?.()}>
            <Paperclip size={14} aria-hidden /> {t('docs.travel.attach', { count: documents.counts.toAttach })}
          </Button>
        ) : documents.counts.attached > 0 ? (
          <span className="fw-sh-hint">{t('docs.travel.allAttached')}</span>
        ) : null}
      </div>
      <p className="fw-sh-hint">{t('docs.travel.law')}</p>
      {documents.blockers.length > 0 && (
        <Banner tone="danger" title={t('docs.travel.blocked', { count: documents.blockers.length })}>
          <ul className="fw-sh-list">
            {documents.blockers.flatMap((check) => (check.problems.length > 0 ? check.problems.map((problem) => <li key={`${check.code}-${problem.path}`}>{problem.message}</li>) : [<li key={check.code}>{check.message}</li>]))}
          </ul>
        </Banner>
      )}
      {documents.warnings.length > 0 && (
        <Banner tone="warning" title={t('docs.travel.fallback', { count: documents.warnings.length })}>
          <ul className="fw-sh-list">
            {documents.warnings.map((warning) => (
              <li key={warning.path}>{warning.message}</li>
            ))}
          </ul>
        </Banner>
      )}
      {travelling.length === 0 ? (
        <EmptyState title={t('docs.travel.none.title')} description={t('docs.travel.none.body')} />
      ) : (
        <ul className="fw-sh-files">
          {travelling.map((entry) => (
            <li key={entry.key} className="fw-sh-file">
              <span className="fw-sh-file-name">
                <strong>{docLabel(entry)}</strong>
                <span className="fw-sh-cell-sub">
                  {entry.language ? t('docs.travel.language', { language: languageName(entry.language, locale) }) : t('docs.travel.noLanguage')}
                  {entry.fallback && entry.wantedLanguage ? ` · ${t('docs.travel.wanted', { language: languageName(entry.wantedLanguage, locale) })}` : ''}
                  {entry.date ? ` · ${formatDate(/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? `${entry.date}T12:00:00Z` : entry.date, { locale })}` : ''}
                </span>
              </span>
              <span className="fw-sh-inline">
                {entry.fallback && <Tag tone="warning">{t('docs.travel.fallbackTag')}</Tag>}
                <Pill tone={DOCUMENT_STATE_TONE[entry.state] ?? 'neutral'}>{t(`docState.${entry.state}`)}</Pill>
                {model.can.readFiles && (entry.copy ?? entry.source) && (
                  <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.((entry.copy ?? entry.source)!.id)} aria-label={t('docs.travel.open', { document: docLabel(entry) })}>
                    <Download size={14} aria-hidden />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {packingList && (
        <p className="fw-sh-hint">
          {t('docs.travel.packingList')} · {t(`docState.${packingList.state}`)}
        </p>
      )}
      {shipment.status === 'DRAFT' && <p className="fw-sh-hint">{t('docs.travel.whenShipped')}</p>}
    </Card>
  )
}

function LinkCard({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const documents = model.documents.value
  if (!documents) return null
  const sendHeld = !model.can.manage ? t('held.noManage') : documents.recipients.length === 0 ? t('held.noRecipients') : shipment.status === 'CANCELLED' ? t('held.cancelledShipment') : null
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        <h2 className="fw-sh-h2">
          <Link2 size={16} aria-hidden /> {t('docs.link.title')}
        </h2>
        <Button size="sm" variant={documents.links.length === 0 ? 'primary' : 'secondary'} heldReason={sendHeld} onClick={() => actions?.onDialog?.({ kind: 'sendLink' })}>
          <Send size={14} aria-hidden /> {documents.links.length === 0 ? t('docs.link.send') : t('docs.link.resend')}
        </Button>
      </div>
      <p className="fw-sh-hint">{t('docs.link.what')}</p>
      {documents.links.length === 0 ? (
        <p className="fw-sh-hint">{hasLeftOrPacked(shipment) ? t('docs.link.none') : t('docs.link.automatic')}</p>
      ) : (
        <SummaryTable
          label={t('docs.link.title')}
          columns={[t('docs.link.col.to'), t('docs.link.col.state'), t('docs.link.col.opens'), t('docs.link.col.until')]}
          rows={documents.links.map((link) => ({
            id: link.id,
            cells: [
              <span key="t" className="fw-sh-cell">
                <span className="fw-sh-ellipsis">{link.email ?? '—'}</span>
                <span className="fw-sh-cell-sub">{link.automatic ? t('docs.link.byShipping') : t('docs.link.byOffice', { when: formatDate(link.createdAt, { locale }) })}</span>
              </span>,
              <Pill key="s" tone={LINK_STATE_TONE[link.state] ?? 'neutral'}>
                {t(`linkState.${link.state}`)}
              </Pill>,
              <span key="o" className="fw-sh-cell">
                <span>{t('docs.link.opens', { uses: link.uses, max: link.maxUses })}</span>
                {link.lastUsedAt && <span className="fw-sh-cell-sub">{t('docs.link.lastOpen', { when: formatDateTime(link.lastUsedAt, { locale }) })}</span>}
              </span>,
              formatDate(link.expiresAt, { locale }),
            ],
          }))}
          density="roomy"
          stackOnPhone
        />
      )}
    </Card>
  )
}

const hasLeftOrPacked = (shipment: Shipment): boolean => shipment.status !== 'DRAFT'

/** Design sh-docs-other: every packing list printed for the shipment (kind · number · version · created), newest first. */
function OtherDocumentsCard({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const versions = model.packingLists.value
  const packHref = `${model.prefix}/warehouse/shipments/${shipment.id}/pack`
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        <h2 className="fw-sh-h2">
          <FileStack size={16} aria-hidden /> {t('other.title')}
        </h2>
        {shipment.status !== 'CANCELLED' && (
          <Button size="sm" asChild>
            <a href={packHref} target="_blank" rel="noopener">
              <Printer size={14} aria-hidden /> {t('other.printAll')}
            </a>
          </Button>
        )}
      </div>
      {!versions ? (
        <PartState problem={model.packingLists.problem} onRetry={() => actions?.onRetryPart?.('packingLists')} label={t('other.title')} />
      ) : versions.length === 0 ? (
        <p className="fw-sh-hint">{shipment.status === 'CANCELLED' ? t('other.noneCancelled') : t('other.none')}</p>
      ) : (
        <ul className="fw-sh-papers" aria-label={t('other.title')}>
          {versions.map((entry) => (
            <li key={entry.fileId} className="fw-sh-paper">
              <FileRow
                name={t('other.name', { number: entry.number })}
                status={[t('other.version', { version: entry.version }), languageName(entry.language, locale), t('other.contents', { parcels: entry.parcels, count: entry.garments }), formatDateTime(entry.createdAt, { locale })].join(' · ')}
              />
              <span className="fw-sh-inline">
                {entry.current ? <Tag tone="success">{t('other.current')}</Tag> : <Tag tone="neutral">{t('other.older')}</Tag>}
                {model.can.readFiles && (
                  <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(entry.fileId)} aria-label={t('other.download', { number: entry.number })}>
                    <Download size={14} aria-hidden />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="fw-sh-hint">{t('other.note')}</p>
    </Card>
  )
}

'use client'

import Link from 'next/link'
import { Archive, Share2 } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { LAW, packCodeKey, recordHref } from '../../model'
import type { PackWindowActions, PackWindowModel, PdfWindowActions, PdfWindowModel } from '../../view-model'
import { DeclarationsMessages, GateBanner, PartFailed, StatusPill, useDay, useLanguage, useWords } from '../../view/parts'

/**
 * SCR-052-pdf — the Declaration PDF window (design tab:dc-pdf): the document as it prints, one language of the family at a time;
 * a generated draft carries its DRAFT banner on every page and the page says it is not the declaration in force (GATE-PPE-TEXTS).
 */
export function PdfWindowView({ model, actions }: { model: PdfWindowModel; actions?: PdfWindowActions }) {
  return (
    <DeclarationsMessages>
      <PdfBody model={model} actions={actions} />
    </DeclarationsMessages>
  )
}

function PdfBody({ model, actions }: { model: PdfWindowModel; actions?: PdfWindowActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const language = useLanguage()
  if (model.read.status === 'loading')
    return (
      <div className="fw-dc fw-dc-window" aria-busy="true">
        <Skeleton height={32} width="40%" />
        <Skeleton height={480} />
      </div>
    )
  if (model.read.status === 'error')
    return (
      <div className="fw-dc fw-dc-window">
        <Card padded>
          <PartFailed title={t('window.failed')} problem={model.read.problem} onRetry={actions?.onRetry} />
        </Card>
      </div>
    )
  const record = model.read.value
  const shown = record.family.find((entry) => entry.id === model.shownId) ?? null
  return (
    <div className="fw-dc fw-dc-window">
      <div className="fw-dc-band">
        <span className="fw-dc-stack">
          <h1 className="fw-dc-h1">{t('window.pdfTitle', { label: record.row.number ?? record.row.style.code, kind: t(`kindShort.${record.kind}`) })}</h1>
          <span className="fw-dc-row">
            <span className="fw-dc-muted">{`${record.row.style.code} · ${record.row.style.name} · ${t('common.rev', { revision: record.row.revision })}`}</span>
            <StatusPill status={shown?.status ?? record.row.status} />
          </span>
        </span>
        <span className="fw-dc-actions">
          {record.family.length > 1 && (
            <SegmentedControl ariaLabel={t('preview.language')} size="sm" wrap value={model.shownId ?? record.row.id} onChange={(id) => actions?.onShow?.(id)} options={record.family.map((entry) => ({ value: entry.id, label: language(entry.language) }))} />
          )}
          <Link className="fw-dc-link" href={recordHref(model.prefix, model.shownId ?? record.row.id)}>
            {t('window.openRecord')}
          </Link>
        </span>
      </div>
      {(shown ? shown.origin === 'GENERATED' : record.generated) && <GateBanner prefix={model.prefix} styleId={record.row.styleId} compact />}
      {!model.pdf || model.pdf.status === 'loading' ? (
        <p className="fw-dc-muted" role="status">
          <Spinner size={12} /> {t('preview.loading')}
        </p>
      ) : model.pdf.status === 'error' ? (
        <Card padded>
          <EmptyState
            title={t(model.pdf.problem === 'preview.noFile' ? 'preview.noFileTitle' : 'preview.failed')}
            description={t(model.pdf.problem)}
            action={
              model.pdf.problem === 'preview.noFile' ? undefined : (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <PdfViewer src={model.pdf.value} title={`${record.row.number ?? record.row.style.code} ${shown?.language.toUpperCase() ?? ''}`} height="calc(100vh - 220px)" labels={pdfViewerLabels(shell)} />
      )}
    </div>
  )
}

/**
 * SCR-052-pack — the shipment compliance pack window (design tab:dc-pack; PRD-300; Reg. (EU) 2016/425 art. 8(8)): what the pack of
 * one shipment holds, why it cannot be made, its versions with the PDF in the viewer and the ZIP; make a version, or make it and
 * share its PDF with the customer.
 */
export function PackWindowView({ model, actions }: { model: PackWindowModel; actions?: PackWindowActions }) {
  return (
    <DeclarationsMessages>
      <PackBody model={model} actions={actions} />
    </DeclarationsMessages>
  )
}

function PackBody({ model, actions }: { model: PackWindowModel; actions?: PackWindowActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const shell = useT('shell')
  const day = useDay()
  if (!model.shipmentId)
    return (
      <div className="fw-dc fw-dc-window">
        <Card padded>
          <EmptyState title={t('pack.noShipmentTitle')} description={t('pack.noShipment')} />
        </Card>
      </div>
    )
  if (!model.pack || model.pack.status === 'loading')
    return (
      <div className="fw-dc fw-dc-window" aria-busy="true">
        <Skeleton height={32} width="40%" />
        <Skeleton height={160} />
        <Skeleton height={320} />
      </div>
    )
  if (model.pack.status === 'error')
    return (
      <div className="fw-dc fw-dc-window">
        <Card padded>
          <PartFailed title={t('pack.failed')} problem={model.pack.problem === 'problem.forbidden' ? 'pack.forbidden' : model.pack.problem} onRetry={actions?.onRetry} />
        </Card>
      </div>
    )
  const pack = model.pack.value
  const refused = pack.refusals.length > 0
  const makeHeld = !model.can.pack ? t('held.pack') : refused ? t('pack.heldRefused') : !model.online ? t('held.offline') : model.busy ? t('held.busy') : null
  const versions = [...pack.versions].sort((a, b) => b.version - a.version)
  const version = versions.find((entry) => entry.id === model.versionId) ?? null
  return (
    <div className="fw-dc fw-dc-window">
      <div className="fw-dc-band">
        <span className="fw-dc-stack">
          <h1 className="fw-dc-h1">{t('pack.title', { number: pack.shipment.number })}</h1>
          <span className="fw-dc-row">
            <span className="fw-dc-muted">{[pack.customer?.name, pack.order ? t('pack.order', { number: pack.order.number, ref: pack.order.customerRef ?? '—' }) : null, pack.shipment.shippedOn ? t('pack.shippedOn', { date: day(pack.shipment.shippedOn) }) : null].filter(Boolean).join(' · ')}</span>
            <LawRef law={LAW.docWithGoods} plain={t('law.docWithGoods')} href={LAW.href} labels={ds.lawRef} />
          </span>
        </span>
        <span className="fw-dc-actions">
          <Button size="sm" heldReason={makeHeld} onClick={() => actions?.onMake?.(false)}>
            {model.busy === 'make' ? <Spinner size={12} /> : null} {t('pack.make')}
          </Button>
          <Button size="sm" variant="primary" heldReason={makeHeld ?? (pack.customer ? null : t('pack.heldNoCustomer'))} onClick={() => actions?.onMake?.(true)}>
            {model.busy === 'share' ? <Spinner size={12} /> : <Share2 size={13} aria-hidden />} {t('pack.makeShare')}
          </Button>
        </span>
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, { ...(model.notice.params ?? {}) })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.()}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      {model.problem && <Banner tone="danger" title={t(model.problem.key)} />}
      {refused && (
        <Banner tone="danger" title={t('pack.refused', { count: new Set(pack.refusals.map((entry) => entry.code)).size })}>
          <ul className="fw-dc-list">
            {[...new Set(pack.refusals.map((entry) => entry.code))].map((code) => (
              <li key={code}>{t(packCodeKey(code), { code })}</li>
            ))}
          </ul>
        </Banner>
      )}
      {pack.warnings.length > 0 && (
        <Banner tone="warning" title={t('pack.warnings', { count: new Set(pack.warnings.map((entry) => entry.code)).size })}>
          <ul className="fw-dc-list">
            {[...new Set(pack.warnings.map((entry) => entry.code))].map((code) => (
              <li key={code}>{t(packCodeKey(code), { code })}</li>
            ))}
          </ul>
        </Banner>
      )}
      <p className="fw-dc-muted">{t('pack.language', { language: pack.locale.toUpperCase(), wanted: pack.wantedLanguage?.toUpperCase() ?? '—' })}</p>
      <div className="fw-dc-content">
        <div className="fw-dc-stack">
          {pack.styles.map((style) => (
            <Card key={style.styleId} padded>
              <section className="fw-dc-stack" aria-label={`${style.code} · ${style.name}`}>
                <h2 className="fw-dc-h">{`${style.code} · ${style.name}`}</h2>
                <span className="fw-dc-muted">{t('pack.styleFacts', { revision: style.revision ?? '—', category: t(`category.${style.category}`), count: style.garments })}</span>
                {style.documents.length === 0 ? (
                  <p className="fw-dc-muted">{t('pack.noDocuments')}</p>
                ) : (
                  <SummaryTable
                    label={t('pack.documents')}
                    stackOnPhone
                    columns={[t('pack.col.document'), t('pack.col.language'), t('pack.col.revision'), t('pack.col.issued'), t('pack.col.file')]}
                    rows={style.documents.map((document) => ({
                      id: document.documentId,
                      cells: [
                        <Link key="d" className="fw-dc-link" href={recordHref(model.prefix, document.documentId)}>
                          {document.number ?? t(`kindShort.${document.kind}`)}
                        </Link>,
                        document.fallback ? t('pack.fallback', { language: document.language.toUpperCase() }) : document.language.toUpperCase(),
                        String(document.revision),
                        day(document.issuedAt),
                        document.file.originalName,
                      ],
                    }))}
                  />
                )}
                <p className="fw-dc-p">
                  {style.certificate
                    ? t(style.certificate.validOnDay ? 'pack.certificate' : 'pack.certificateNotValid', { number: style.certificate.number, standard: style.certificate.standard, body: style.certificate.bodyName, bodyNumber: style.certificate.bodyNumber, to: day(style.certificate.validTo) })
                    : t('pack.noCertificate')}
                </p>
                {style.batches.length > 0 && (
                  <ul className="fw-dc-list">
                    {style.batches.map((batch) => (
                      <li key={batch.workOrderId} className="fw-dc-row">
                        <span>{t('pack.batch', { number: batch.batchNumber, count: batch.garments })}</span>
                        <a className="fw-dc-link" href={batch.publicDocAddress} target="_blank" rel="noopener">
                          {t('pack.public', { code: batch.publicDocCode })}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </Card>
          ))}
          <Card padded>
            <section className="fw-dc-stack" aria-labelledby="fw-dc-contents">
              <h2 id="fw-dc-contents" className="fw-dc-h">
                {t('pack.contents')}
              </h2>
              <p className="fw-dc-muted">{t('pack.contentsNote')}</p>
              {pack.contents.length === 0 ? (
                <p className="fw-dc-muted">{t('pack.noContents')}</p>
              ) : (
                <SummaryTable label={t('pack.contents')} stackOnPhone columns={[t('pack.col.path'), t('pack.col.sha')]} rows={pack.contents.map((entry) => ({ id: entry.fileId, cells: [entry.path, <code key="s" className="fw-dc-hash">{entry.sha256.slice(0, 16)}…</code>] }))} />
              )}
            </section>
          </Card>
        </div>
        <Card padded className="fw-dc-preview">
          <section className="fw-dc-stack" aria-labelledby="fw-dc-versions">
            <div className="fw-dc-head">
              <h2 id="fw-dc-versions" className="fw-dc-h">
                {t('pack.versions')}
              </h2>
              {version && (
                <Button size="sm" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onZip?.()}>
                  {model.busy === 'zip' ? <Spinner size={12} /> : <Archive size={13} aria-hidden />} {t('pack.zip')}
                </Button>
              )}
            </div>
            {versions.length === 0 ? (
              <EmptyState title={t('pack.noVersionsTitle')} description={t('pack.noVersions')} />
            ) : (
              <>
                <Select size="sm" aria-label={t('pack.versions')} value={model.versionId ?? ''} onChange={(event) => actions?.onVersion?.(event.target.value)}>
                  {versions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {t('pack.versionLine', { version: entry.version, date: day(entry.createdAt), count: entry.documents, by: entry.createdBy?.name ?? '—' })}
                    </option>
                  ))}
                </Select>
                {version && (
                  <span className="fw-dc-row">
                    <Pill tone={version.shared ? 'success' : 'neutral'}>{t(version.shared ? 'pack.shared' : 'pack.notShared')}</Pill>
                    <span className="fw-dc-muted">{t('pack.language', { language: version.language.toUpperCase(), wanted: pack.wantedLanguage?.toUpperCase() ?? '—' })}</span>
                  </span>
                )}
                {!model.pdf || model.pdf.status === 'loading' ? (
                  <p className="fw-dc-muted" role="status">
                    <Spinner size={12} /> {t('preview.loading')}
                  </p>
                ) : model.pdf.status === 'error' ? (
                  <PartFailed title={t('preview.failed')} problem={model.pdf.problem} onRetry={actions?.onRetry} />
                ) : (
                  <PdfViewer src={model.pdf.value} title={t('pack.title', { number: pack.shipment.number })} height="min(72vh, 820px)" labels={pdfViewerLabels(shell)} />
                )}
              </>
            )}
          </section>
        </Card>
      </div>
    </div>
  )
}

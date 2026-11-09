'use client'

import type { ReactNode } from 'react'
import { AlertCircle, Download, Eye, ShieldCheck } from 'lucide-react'
import { Disclosure, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { FileRow } from '../../../../lib/i18n/ds-parts'
import { kindKey, receivedTone, type ConformityDoc, type ConformityStyleRow, type ReceivedRow } from '../model'
import { languageWords } from '../preview/model'
import { useDocumentWords } from '../words'

/**
 * SCR-186 › Conformity per style you received (design portal.customer.documents sec:conformity; SAL-087, SAL-088): for each
 * style shipped, per shipment, the EU declaration of conformity and the user information that travelled (the style revision
 * the work orders froze), the EU type-examination certificate valid on the shipping date (a summary: its number, notified
 * body, standard and class — the certificate's own file is the office's), and the shipment's certificate of conformity,
 * inspection and test reports. Each document as a DS FileRow (Preview, Download — logged); "Download all" of a style (one
 * logged download each; a zip is Later). A row that misses a document says so ("ask us for it").
 */

export interface ConformityModel {
  state: 'loading' | 'error' | 'ready'
  styles: readonly ConformityStyleRow[]
  /** The row whose open runs. */
  busy: string | null
  /** Why nothing may be opened now, a key. */
  held: string | null
  /** The styles open at first (a design case, or the one a link names). */
  open?: readonly string[]
  slow?: boolean
}

export interface ConformityActions {
  onPreview?: (doc: ConformityDoc, ids: readonly string[]) => void
  onDownload?: (doc: ConformityDoc) => void
  onDownloadAll?: (style: ConformityStyleRow) => void
  onAsk?: (row: ReceivedRow) => void
  onRetry?: () => void
}

export function ConformitySection({ model, actions }: { model: ConformityModel; actions?: ConformityActions }) {
  const { t } = useDocumentWords()
  return (
    <section className="fw-pdoc-section fw-pdoc-conformity" aria-labelledby="fw-pdoc-conformity">
      <div className="fw-pdoc-head">
        <div className="fw-pdoc-headtext">
          <h2 id="fw-pdoc-conformity" className="fw-pdoc-h2">
            {t('conformity.title')}
          </h2>
          <p className="fw-pdoc-sub">{t('conformity.hint')}</p>
        </div>
      </div>
      {model.state === 'loading' ? (
        <div className="fw-pdoc-stack" role="status" aria-label={model.slow ? t('state.slow') : t('state.loading')}>
          {model.slow ? <p className="fw-pdoc-sub">{t('state.slow')}</p> : null}
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : model.state === 'error' ? (
        <div className="fw-pdoc-state" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('conformity.failed')}</span>
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('state.retry')}
          </Button>
        </div>
      ) : model.styles.length === 0 ? (
        <EmptyState icon={<ShieldCheck size={24} aria-hidden />} title={t('conformity.empty')} description={t('conformity.emptyBody')} />
      ) : (
        <ul className="fw-pdoc-styles">
          {model.styles.map((style) => (
            <li key={style.code}>
              <StyleCard style={style} model={model} actions={actions} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StyleCard({ style, model, actions }: { style: ConformityStyleRow; model: ConformityModel; actions?: ConformityActions }) {
  const { t, day } = useDocumentWords()
  const ids = style.documents.map((doc) => doc.id)
  const held = model.held ? t(model.held) : null
  const summary = (
    <span className="fw-pdoc-stylehead">
      <span className="fw-pdoc-title">{t('conformity.style', { code: style.code, name: style.name })}</span>
      <span className="fw-pdoc-sub">
        {[
          style.ppe ? (style.ppeClass ? t('conformity.ppeClass', { class: style.ppeClass }) : t('conformity.ppe')) : t('conformity.notPpe'),
          style.standard,
          t('conformity.shipments', { count: style.received.length }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {style.incomplete ? <Pill tone="warning">{t('conformity.missing')}</Pill> : style.ppe ? <Pill tone="success">{t('conformity.complete')}</Pill> : null}
    </span>
  )
  return (
    <Disclosure summary={summary} open={model.open?.includes(style.code) || undefined} className="fw-pdoc-style">
      <div className="fw-pdoc-stylebody">
        {style.documents.length > 0 ? (
          <div className="fw-pdoc-styleacts">
            <Button size="sm" heldReason={held ?? (model.busy === `all:${style.code}` ? t('row.opening') : null)} onClick={() => actions?.onDownloadAll?.(style)}>
              <Download size={14} aria-hidden /> {t('conformity.downloadAll', { count: style.documents.length })}
            </Button>
          </div>
        ) : null}
        <ol className="fw-pdoc-received">
          {style.received.map((row) => (
            <li key={row.key} className="fw-pdoc-shipment">
              <div className="fw-pdoc-shiphead">
                <span className="fw-pdoc-title">{t('conformity.shippedOn', { date: day(row.shippedOn) })}</span>
                <ShippedLine row={row} />
                <Pill tone={receivedTone(row.state)}>{t(`received.${row.state}`)}</Pill>
              </div>
              <CertificateLine style={style} row={row} />
              <ul className="fw-pdoc-files-list">
                <DocLine label={t('conformity.declaration')} doc={row.declaration} missing={style.ppe} ids={ids} model={model} actions={actions} />
                <DocLine label={t('conformity.userInformation')} doc={row.userInformation} missing={style.ppe} ids={ids} model={model} actions={actions} />
                {row.reports.map((doc) => (
                  <DocLine key={doc.id} label={t(kindKey(doc.kind))} doc={doc} missing={false} ids={ids} model={model} actions={actions} />
                ))}
              </ul>
              {row.state === 'INCOMPLETE' ? (
                <p className="fw-pdoc-ask">
                  <span>{t('received.askWhat')}</span>
                  <Button size="sm" variant="link" onClick={() => actions?.onAsk?.(row)}>
                    {t('received.ask')}
                  </Button>
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </Disclosure>
  )
}

function ShippedLine({ row }: { row: ReceivedRow }) {
  const { t } = useDocumentWords()
  return (
    <span className="fw-pdoc-sub">
      {[
        t('conformity.shipment', { number: row.shipment }),
        row.order ? t('row.order', { number: row.order }) : null,
        t('conformity.pieces', { count: row.pieces }),
        row.revision !== null ? t('conformity.revision', { revision: row.revision }) : null,
      ]
        .filter(Boolean)
        .join(' · ')}
    </span>
  )
}

function CertificateLine({ style, row }: { style: ConformityStyleRow; row: ReceivedRow }) {
  const { t, day } = useDocumentWords()
  if (!style.ppe) return null
  const certificate = row.certificate
  let body: ReactNode
  if (!style.certificateRequired && !certificate) body = <span>{t('certificate.notNeeded')}</span>
  else if (!certificate) body = <span className="fw-pdoc-warn">{t('certificate.none')}</span>
  else
    body = (
      <>
        <span>
          {t('certificate.line', { number: certificate.number, body: certificate.notifiedBody.name, nb: certificate.notifiedBody.number, standard: certificate.standard })}
          {certificate.ppeClass ? ` · ${t('conformity.ppeClass', { class: certificate.ppeClass })}` : ''}
        </span>
        <span className={certificate.validOnShippingDate ? 'fw-pdoc-sub' : 'fw-pdoc-warn'}>
          {t(certificate.validOnShippingDate ? 'certificate.valid' : 'certificate.notValid', { from: day(certificate.validFrom), to: day(certificate.validTo) })}
        </span>
      </>
    )
  return (
    <p className="fw-pdoc-cert">
      <span className="fw-pdoc-certlabel">{t('certificate.label')}</span>
      {body}
    </p>
  )
}

function DocLine({ label, doc, missing, ids, model, actions }: { label: string; doc: ConformityDoc | null; missing: boolean; ids: readonly string[]; model: ConformityModel; actions?: ConformityActions }) {
  const { t } = useDocumentWords()
  if (!doc) {
    if (!missing) return null
    return (
      <li>
        <FileRow name={label} tone="danger" status={t('conformity.notShared')} />
      </li>
    )
  }
  const held = model.held ? t(model.held) : model.busy === doc.id ? t('row.opening') : null
  return (
    <li>
      <FileRow
        name={doc.title}
        status={
          <span className="fw-pdoc-filestatus">
            {doc.isNew ? <Pill tone="info">{t('row.new')}</Pill> : null}
            <span>{[label, t('row.version', { version: doc.version, fingerprint: doc.fingerprint }), doc.language ? languageWords(t, doc.language) : null].filter(Boolean).join(' · ')}</span>
          </span>
        }
        actions={
          <>
            <Button size="sm" heldReason={held} aria-haspopup="dialog" aria-label={t('row.previewOf', { title: doc.title })} onClick={() => actions?.onPreview?.(doc, ids)}>
              <Eye size={14} aria-hidden /> <span className="fw-pdoc-btnword">{t('row.preview')}</span>
            </Button>
            <Button size="sm" heldReason={held} aria-label={t('row.downloadOf', { title: doc.title })} onClick={() => actions?.onDownload?.(doc)}>
              <Download size={14} aria-hidden /> <span className="fw-pdoc-btnword">{t('row.download')}</span>
            </Button>
          </>
        }
      />
    </li>
  )
}

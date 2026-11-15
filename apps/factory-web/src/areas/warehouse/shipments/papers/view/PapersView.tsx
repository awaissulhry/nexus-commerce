'use client'

import { Copy, ExternalLink, FileStack, Globe2, Printer, Receipt } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, RadioCard, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import { DOCUMENT_LANGUAGES, type Pack, type Proformas } from '../api'
import { openHeld, packHeld, PART_TONE, partWords, PROFORMA_NOTES_MAX, proformaBlockers, proformaHeld, type PapersActions, type PapersModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/**
 * SCR-596 — Documents in depth (design sh-docs-other "proforma (W2b), generated documents with versions · Print all (one
 * merged PDF in a new tab)", sh-doc-conf "the public DoC link (links.doc, W2b)"; B-W2b-391, B-W2b-166): the driver's pack —
 * each part ready, missing (why) or not needed, TEST labels said, the newest version — made as ONE PDF, printed as one job
 * on the site's A4 printer or opened here (print and download from the viewer); the proforma (its PF number taken once, its
 * versions, the language, the notes; the PDF behind the price grain); and each style's public DoC page (the address the
 * QR on the label holds), copied or opened.
 */
export function PapersView({ model, actions }: { model: PapersModel; actions?: PapersActions }) {
  return (
    <WithMessages namespaces={[...DEPTH_NAMESPACES, 'shell']}>
      <Papers model={model} actions={actions} />
    </WithMessages>
  )
}

function Papers({ model, actions }: { model: PapersModel; actions?: PapersActions }) {
  const { say } = useDepthWords()
  return (
    <div className="fw-shd-stack">
      {model.problem && !model.dialog && <Banner tone="danger" title={say(model.problem) ?? ''} />}
      {model.done && <Banner tone="success" title={say(model.done) ?? ''} />}
      <div className="fw-shd-cards">
        {model.pack && <PackCard pack={model.pack} model={model} actions={actions} />}
        {model.proformas && <ProformaCard proformas={model.proformas} model={model} actions={actions} />}
        <PublicDocCard model={model} actions={actions} />
      </div>
      {model.pdf && <PdfDialog model={model} actions={actions} />}
      {model.dialog && <ProformaDialog model={model} actions={actions} />}
    </div>
  )
}

function PackCard({ pack: read, model, actions }: { pack: NonNullable<PapersModel['pack']>; model: PapersModel; actions?: PapersActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <h2 className="fw-sh-h2">
      <FileStack size={16} aria-hidden /> {t('pack.title')}
    </h2>
  )
  if (read.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={read.state === 'error' ? read.problem : null} onRetry={actions?.onRetry} label={t('pack.title')} />
      </Card>
    )
  }
  const pack: Pack = read.value
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head}
        {pack.test && <Tag tone="warning">{t('pack.test')}</Tag>}
      </div>
      <ul className="fw-shd-hold-list" aria-label={t('pack.parts')}>
        {pack.parts.map((part) => (
          <li key={part.kind} className="fw-shd-part">
            <span className="fw-sh-cell">
              <strong>{t(`pack.part.${part.kind}`)}</strong>
              <span className="fw-sh-cell-sub">{say(partWords(part))}</span>
            </span>
            <Pill tone={PART_TONE[part.state]}>{t(`pack.state.${part.state}`)}</Pill>
          </li>
        ))}
      </ul>
      <p className="fw-sh-hint">{pack.latest ? t(pack.latest.current ? 'pack.latest' : 'pack.latestOld', { version: pack.latest.version, when: formatDateTime(pack.latest.createdAt, { locale }), pages: pack.latest.pages ?? '—' }) : t('pack.notMade')}</p>
      <span className="fw-shd-actions">
        <Button size="sm" variant="primary" heldReason={say(packHeld(model, pack, true))} onClick={() => actions?.onMakePack?.(true)}>
          <Printer size={14} aria-hidden /> {pack.printer ? t('pack.makePrint', { printer: pack.printer.name }) : t('pack.makePrintNone')}
        </Button>
        <Button size="sm" heldReason={say(packHeld(model, pack, false))} onClick={() => actions?.onMakePack?.(false)}>
          {t('pack.makeOnly')}
        </Button>
        <Button size="sm" variant="quiet" heldReason={say(openHeld(pack, model.busy))} onClick={() => actions?.onOpenPdf?.(pack.latest?.version ?? null)}>
          <ExternalLink size={14} aria-hidden /> {t('pack.open')}
        </Button>
      </span>
      <p className="fw-sh-hint">{t('pack.note')}</p>
    </Card>
  )
}

function ProformaCard({ proformas: read, model, actions }: { proformas: NonNullable<PapersModel['proformas']>; model: PapersModel; actions?: PapersActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <h2 className="fw-sh-h2">
      <Receipt size={16} aria-hidden /> {t('proforma.title')}
    </h2>
  )
  if (read.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={read.state === 'error' ? read.problem : null} onRetry={actions?.onRetry} label={t('proforma.title')} />
      </Card>
    )
  }
  const proformas: Proformas = read.value
  const blockers = proformaBlockers(proformas.problems)
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head}
        {proformas.number && <Tag tone="neutral">{proformas.number}</Tag>}
      </div>
      <p className="fw-sh-hint">{t(`proforma.purpose.${proformas.purpose}`)}</p>
      {blockers.length > 0 && (
        <ul className="fw-shd-problems" aria-label={t('proforma.blockers')}>
          {blockers.map((blocker) => (
            <li key={blocker.key}>{say(blocker)}</li>
          ))}
        </ul>
      )}
      {proformas.versions.length === 0 ? (
        <p className="fw-sh-hint">{t('proforma.none')}</p>
      ) : (
        <ul className="fw-shd-hold-list" aria-label={t('proforma.versions')}>
          {proformas.versions.map((version) => (
            <li key={version.documentId} className="fw-shd-part">
              <span className="fw-sh-cell">
                <strong>{t('proforma.version', { number: version.number, version: version.version })}</strong>
                <span className="fw-sh-cell-sub">
                  {version.language.toUpperCase()} · {formatDateTime(version.createdAt, { locale })}
                  {version.createdBy ? ` · ${version.createdBy}` : ''}
                </span>
              </span>
              <span className="fw-sh-inline">
                <Tag tone={version.current ? 'success' : 'neutral'}>{version.current ? t('proforma.current') : t('proforma.older')}</Tag>
                <Button size="sm" variant="quiet" heldReason={model.can.readFiles ? null : t('proforma.held.noFiles')} onClick={() => actions?.onOpenProforma?.(version.fileId)} aria-label={t('proforma.openOf', { number: version.number, version: version.version })}>
                  <ExternalLink size={14} aria-hidden />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <span className="fw-shd-actions">
        <Button size="sm" heldReason={say(proformaHeld(model, proformas))} onClick={() => actions?.onDialog?.({ kind: 'proforma', language: null, notes: '' })}>
          {proformas.versions.length === 0 ? t('proforma.make') : t('proforma.makeAgain')}
        </Button>
      </span>
      <p className="fw-sh-hint">{t('proforma.note')}</p>
    </Card>
  )
}

function PublicDocCard({ model, actions }: { model: PapersModel; actions?: PapersActions }) {
  const { t } = useDepthWords()
  const head = (
    <h2 className="fw-sh-h2">
      <Globe2 size={16} aria-hidden /> {t('publicDoc.title')}
    </h2>
  )
  if (model.docs.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={model.docs.state === 'error' ? model.docs.problem : null} onRetry={actions?.onRetry} label={t('publicDoc.title')} />
      </Card>
    )
  }
  const docs = model.docs.value
  return (
    <Card padded>
      {head}
      <p className="fw-sh-hint">{t('publicDoc.body')}</p>
      {docs.length === 0 ? (
        <p className="fw-sh-hint">{t('publicDoc.none')}</p>
      ) : (
        <ul className="fw-shd-hold-list" aria-label={t('publicDoc.title')}>
          {docs.map((doc) => (
            <li key={doc.styleId} className="fw-shd-part">
              <span className="fw-sh-cell">
                <strong>
                  {doc.styleCode} · {doc.styleName}
                </strong>
                <span className="fw-sh-cell-sub fw-sh-mono fw-shd-break">{doc.address}</span>
                {doc.live !== null && <span className="fw-sh-cell-sub">{doc.live ? t('publicDoc.live') : t('publicDoc.notLive')}</span>}
              </span>
              <span className="fw-sh-inline">
                <Button size="sm" variant="quiet" onClick={() => actions?.onCopy?.(doc.address)} aria-label={t('publicDoc.copyOf', { style: doc.styleCode })}>
                  <Copy size={14} aria-hidden />
                </Button>
                <Button size="sm" variant="quiet" asChild>
                  <a href={doc.address} target="_blank" rel="noopener" aria-label={t('publicDoc.openOf', { style: doc.styleCode })}>
                    <ExternalLink size={14} aria-hidden />
                  </a>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function PdfDialog({ model, actions }: { model: PapersModel; actions?: PapersActions }) {
  const { t, say } = useDepthWords()
  const shell = useT('shell')
  if (!model.pdf) return null
  const pdf = model.pdf
  const title = t('pack.pdfTitle', { number: model.number, version: pdf.version ?? '' })
  return (
    <Modal open onClose={() => actions?.onClosePdf?.()} title={title} size="detail">
      {pdf.problem ? (
        <Banner tone="warning" title={say(pdf.problem) ?? ''} />
      ) : pdf.data ? (
        <PdfViewer src={pdf.data} title={title} fileName={`${model.number}-pack${pdf.version ? `-v${pdf.version}` : ''}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
      ) : (
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('pack.pdfLoading')}
        </p>
      )}
    </Modal>
  )
}

function ProformaDialog({ model, actions }: { model: PapersModel; actions?: PapersActions }) {
  const { t, say } = useDepthWords()
  if (!model.dialog) return null
  const dialog = model.dialog
  return (
    <DepthDialog
      title={t('proforma.dialogTitle', { number: model.number })}
      held={model.busy ? t('proforma.held.busy') : dialog.notes.trim().length > PROFORMA_NOTES_MAX ? t('proforma.notesLong', { max: PROFORMA_NOTES_MAX }) : null}
      onGo={() => actions?.onMakeProforma?.()}
      goLabel={t('proforma.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <p className="fw-sh-hint">{t('proforma.dialogBody')}</p>
      <fieldset className="fw-shd-choices fw-shd-choices--grid">
        <legend className="fw-sh-h3">{t('proforma.language')}</legend>
        <RadioCard name="proforma-language" value="" checked={dialog.language === null} selected={dialog.language === null} onChange={() => actions?.onDialog?.({ ...dialog, language: null })} title={t('proforma.languageDefault')} />
        {DOCUMENT_LANGUAGES.map((language) => (
          <RadioCard key={language} name="proforma-language" value={language} checked={dialog.language === language} selected={dialog.language === language} onChange={() => actions?.onDialog?.({ ...dialog, language })} title={t(`language.${language}`)} />
        ))}
      </fieldset>
      <Field label={t('proforma.notes')} hint={t('proforma.notesHint')}>
        <Textarea rows={3} limit={PROFORMA_NOTES_MAX} value={dialog.notes} onChange={(event) => actions?.onDialog?.({ ...dialog, notes: event.target.value })} />
      </Field>
    </DepthDialog>
  )
}

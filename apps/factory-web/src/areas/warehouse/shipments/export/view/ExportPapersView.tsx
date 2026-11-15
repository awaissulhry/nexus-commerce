'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, FileText, Globe2, Link2, Stamp } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Checkbox, Input, NumberStepper, Pill, Select, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { Countdown, DateTimeField, FileDropzone, FileRow, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, type Words } from '../../queue/shared/depth'
import { DepthDialog, PartRead } from '../../queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../pickup/dispatch'
import type { BrokerPack, CustomsDocument, Declaration, ExportRead } from '../api'
import {
  COMMENTS_MAX,
  dialogProblem,
  documentLabel,
  downloadHeld,
  exitClock,
  exitHeld,
  EXPORT_REASONS,
  exportState,
  invoiceHeld,
  linkHeld,
  mrnHeld,
  nameInvoiceHeld,
  NOTES_MAX,
  openHeld,
  packHeld,
  paperHref,
  postalChoices,
  postalHeld,
  REASON_TEXT_MAX,
  REMOVE_REASON_MAX,
  removeHeld,
  STATE_TONE,
  type ExportDialog,
  type ExportPapersActions,
  type ExportPapersModel,
} from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'
import '../../pickup/dispatch.css'

/** The proof of exit: a PDF or a picture (as the files store takes them), at most 15 MB. */
const PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
const PROOF_MAX_BYTES = 15 * 1024 * 1024

/**
 * SCR-653 — a shipment's Export papers (B-W2b-412 on B-W2b-409; LOG-086 … LOG-089, LOG-095, LOG-097; design warehouse.shipments
 * record › Export, sec sh-export): where the goods go and whether papers are needed (in Italy or the EU: "Not needed"), the
 * Incoterm and place, the company's EORI; the commercial invoice (each version opens in a new tab, sh-tab-ci) and the CN 22 /
 * CN 23 for postal parcels (why a CN 23); the export declaration — the broker or the carrier files it, its MRN, the issued
 * invoice it names, the proof of exit with the countdown to the alert (art. 8 DPR 633/72), the broker's links; the broker's
 * pack (its parts, one merged PDF, a link mailed to the broker or passed on once, while the site's switch is on). Each action
 * held says why; the values stay inside the papers (the price grain).
 */
export function ExportPapersView({ model, actions }: { model: ExportPapersModel; actions?: ExportPapersActions }) {
  return (
    <WithMessages namespaces={[...DISPATCH_NAMESPACES, 'shell']}>
      <Papers model={model} actions={actions} />
    </WithMessages>
  )
}

function useWords() {
  const t = useT(DISPATCH_NS)
  return { t, say: (value: Words | null | undefined) => (value ? t(value.key, value.params) : null) }
}

function Papers({ model, actions }: { model: ExportPapersModel; actions?: ExportPapersActions }) {
  const { t, say } = useWords()
  if (model.read.state !== 'ready') {
    return (
      <Card padded>
        <PartRead problem={model.read.state === 'error' ? model.read.problem : null} onRetry={actions?.onRetry} label={t('export.title')} />
      </Card>
    )
  }
  const read = model.read.value
  const state = exportState(read)
  return (
    <Card padded>
      <section className="fw-shd-stack" aria-labelledby="export-papers">
        <div className="fw-sh-card-head">
          <h2 id="export-papers" className="fw-sh-h2">
            <Globe2 size={16} aria-hidden /> {t('export.title')}
          </h2>
          <Pill tone={STATE_TONE[state]}>{t(`export.state.${state}`)}</Pill>
        </div>
        {model.done && (
          <Banner tone="success" title={say(model.done)} action={actions?.onDismiss ? <Button size="sm" variant="quiet" onClick={actions.onDismiss}>{t('common.dismiss')}</Button> : undefined} />
        )}
        <Facts read={read} model={model} />
        {read.needed ? (
          <>
            <PaperSection read={read} model={model} actions={actions} />
            <DeclarationSection read={read} model={model} actions={actions} />
          </>
        ) : (
          <p className="fw-sh-hint">{t(read.destination.class === null ? 'export.unknownBody' : `export.notNeeded.${read.destination.class}`)}</p>
        )}
      </section>
      {model.dialog && <ExportDialogView read={read} model={model} actions={actions} />}
    </Card>
  )
}

function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

function Facts({ read, model }: { read: ExportRead; model: ExportPapersModel }) {
  const { t } = useWords()
  const locale = useLocale()
  const country = read.destination.country
  return (
    <KeyValue
      labelCase="sentence"
      items={[
        { label: t('export.destination'), value: country ? t(`export.class.${read.destination.class ?? 'unknown'}`, { country: regionName(country, locale) }) : t('export.noCountry') },
        ...(read.needed ? [{ label: t('export.terms'), value: read.deliveryTerms ?? t('export.noTerms') }] : []),
        ...(read.needed
          ? [
              {
                label: t('export.eori'),
                value: read.eori ? (
                  <span className="fw-sh-mono">{read.eori}</span>
                ) : model.can.settingsView ? (
                  <Link className="fw-sh-link" href={`${model.prefix}/warehouse/shipping#eori`}>
                    {t('export.noEori')}
                  </Link>
                ) : (
                  t('export.noEori')
                ),
              },
            ]
          : []),
      ]}
    />
  )
}

function PaperRows({ documents, read, model }: { documents: readonly CustomsDocument[]; read: ExportRead; model: ExportPapersModel }) {
  const { t, say } = useWords()
  const locale = useLocale()
  if (documents.length === 0) return null
  return (
    <ul className="fw-shd-hold-list">
      {documents.map((document) => (
        <li key={document.documentId} className="fw-shd-part">
          <span className="fw-sh-cell">
            <span>
              {say(documentLabel(document))} {document.current && <Tag tone="success">{t('export.current')}</Tag>}
            </span>
            <span className="fw-sh-cell-sub">{t('export.paperFacts', { language: t(`export.language.${document.language}`), when: formatDateTime(document.createdAt, { locale }) })}</span>
          </span>
          {read.seesValues ? (
            <Button size="sm" asChild>
              <Link href={paperHref(model.prefix, read.shipment.id, document.documentId)} target="_blank" rel="noopener">
                <ExternalLink size={13} aria-hidden /> {t('export.openPdf')}
              </Link>
            </Button>
          ) : (
            <Button size="sm" heldReason={t('export.held.noPrice')}>
              <ExternalLink size={13} aria-hidden /> {t('export.openPdf')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

function PaperSection({ read, model, actions }: { read: ExportRead; model: ExportPapersModel; actions?: ExportPapersActions }) {
  const { t, say } = useWords()
  const invoices = read.papers.commercialInvoice
  const postal = read.papers.postalForm
  const ciHeld = say(invoiceHeld(read, model.can, model.busy))
  const cnHeld = say(postalHeld(read, model.can, model.busy))
  const suggested = postal.suggested ?? 'CN23'
  return (
    <section className="fw-shd-check" aria-label={t('export.papers')}>
      <h3 className="fw-dsp-h3">
        <FileText size={14} aria-hidden /> {t('export.papers')}
      </h3>
      <div className="fw-dsp-sub">
        <span className="fw-shd-hold-head">
          <strong>{t('export.invoiceTitle')}</strong>
          <Button size="sm" variant={invoices.length === 0 ? 'primary' : 'secondary'} heldReason={ciHeld} onClick={() => actions?.onDialog?.({ kind: 'invoice', language: '', reason: 'SALE_OF_GOODS', reasonText: '', notes: '' })}>
            {t(invoices.length === 0 ? 'export.makeInvoice' : 'export.makeInvoiceAgain')}
          </Button>
        </span>
        <p className="fw-sh-hint">{t('export.invoiceWhat')}</p>
        {invoices.length === 0 && <p className="fw-sh-hint">{t('export.noInvoiceYet')}</p>}
        <PaperRows documents={invoices} read={read} model={model} />
      </div>
      <div className="fw-dsp-sub">
        <span className="fw-shd-hold-head">
          <strong>{t('export.postalTitle')}</strong>
          <Button size="sm" heldReason={cnHeld} onClick={() => actions?.onDialog?.({ kind: 'postal', form: suggested, language: '', reason: 'SALE_OF_GOODS', reasonText: '', comments: '' })}>
            {t('export.makePostal', { form: t(`export.form.${suggested}`) })}
          </Button>
        </span>
        <p className="fw-sh-hint">
          {t('export.postalWhat')} {postal.suggested ? t('export.suggested', { form: t(`export.form.${postal.suggested}`) }) : null}
        </p>
        {postal.because.length > 0 && (
          <ul className="fw-sh-list">
            {postal.because.map((because) => (
              <li key={because} className="fw-sh-hint">
                {t(`export.because.${because}`)}
              </li>
            ))}
          </ul>
        )}
        <PaperRows documents={postal.versions} read={read} model={model} />
      </div>
    </section>
  )
}

function DeclarationSection({ read, model, actions }: { read: ExportRead; model: ExportPapersModel; actions?: ExportPapersActions }) {
  const { t, say } = useWords()
  const declaration = read.declaration
  const open = say(openHeld(read, model.can, model.busy))
  return (
    <section className="fw-shd-check" aria-label={t('export.declaration')}>
      <span className="fw-shd-hold-head">
        <h3 className="fw-dsp-h3">
          <Stamp size={14} aria-hidden /> {t('export.declaration')}
        </h3>
        {declaration && <Pill tone={declaration.status === 'EXITED' ? 'success' : declaration.overdue ? 'danger' : 'info'}>{t(`export.status.${declaration.status}`)}</Pill>}
      </span>
      {!declaration ? (
        <>
          <p className="fw-sh-hint">{t('export.declarationWhat')}</p>
          <span className="fw-shd-actions">
            <Button size="sm" variant="primary" heldReason={open} onClick={() => actions?.onDialog?.({ kind: 'declaration', brokerPartyId: '', alertAfterDays: read.alertDays.default })}>
              {t('export.openDeclaration')}
            </Button>
          </span>
        </>
      ) : (
        <DeclarationBody declaration={declaration} read={read} model={model} actions={actions} />
      )}
    </section>
  )
}

function DeclarationBody({ declaration, read, model, actions }: { declaration: Declaration; read: ExportRead; model: ExportPapersModel; actions?: ExportPapersActions }) {
  const { t, say } = useWords()
  const locale = useLocale()
  const clock = exitClock(declaration)
  const invoice = declaration.invoice
  return (
    <div className="fw-shd-stack">
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('export.filedBy'), value: declaration.filedBy === 'BROKER' ? t('export.byBroker', { name: declaration.broker?.name ?? '—' }) : t('export.byCarrier') },
          { label: t('export.mrn'), value: declaration.mrn ? <span className="fw-sh-mono">{declaration.mrn}</span> : t('export.noMrn') },
          { label: t('export.invoiceNamed'), value: invoice ? t('export.invoiceOf', { number: invoice.number, date: invoice.date ? formatDate(dayInstant(invoice.date), { locale }) : '—' }) : t('export.noInvoiceNamed') },
          { label: t('export.exit'), value: declaration.exitConfirmedAt ? t('export.exitOn', { when: formatDateTime(declaration.exitConfirmedAt, { locale }) }) : t('export.noExit') },
          ...(declaration.exitFile ? [{ label: t('export.exitFile'), value: declaration.exitFile.name }] : []),
        ]}
      />
      {clock && (
        <p className={clock.tone === 'danger' ? 'fw-dsp-error' : 'fw-sh-hint'}>
          {say(clock.words)}{' '}
          {declaration.exitDueAt && !declaration.overdue && <Countdown to={declaration.exitDueAt} label={(left) => t('export.clock.until', { left })} doneLabel={t('export.clock.due')} />}
        </p>
      )}
      <p className="fw-sh-hint">{t('export.law')}</p>
      <span className="fw-shd-actions">
        <Button size="sm" variant={declaration.mrn ? 'secondary' : 'primary'} heldReason={say(mrnHeld(declaration, read, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'mrn', mrn: '' })}>
          {t('export.recordMrn')}
        </Button>
        <Button size="sm" heldReason={say(nameInvoiceHeld(declaration, read, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'nameInvoice', invoiceId: read.invoices.find((entry) => entry.ofShipment)?.id ?? read.invoices[0]?.id ?? '' })}>
          {t('export.nameInvoice')}
        </Button>
        <Button size="sm" heldReason={say(exitHeld(declaration, read, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'exit', at: new Date().toISOString(), file: null, fileName: null })}>
          {t('export.proveExit')}
        </Button>
        <Button size="sm" heldReason={say(packHeld(read, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'pack', origin: [] })}>
          <Link2 size={13} aria-hidden /> {t('export.sendPack')}
        </Button>
        {declaration.status === 'PACK_SENT' && (
          <Button size="sm" variant="quiet" heldReason={say(removeHeld(declaration, read, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'remove', reason: '' })}>
            {t('export.remove')}
          </Button>
        )}
      </span>
      {declaration.links.length > 0 && (
        <ul className="fw-shd-hold-list" aria-label={t('export.links')}>
          {declaration.links.map((link) => (
            <li key={link.id} className="fw-shd-part">
              <span className="fw-sh-cell">
                {/* The address the link was mailed to: typed by the office, shown inside this one record. */}
                <span>{link.email ?? t('export.linkPassedOn')}</span>
                <span className="fw-sh-cell-sub">
                  {t('export.linkFacts', { until: formatDate(link.expiresAt, { locale }), opened: link.lastOpenedAt ? formatDateTime(link.lastOpenedAt, { locale }) : t('export.linkNotOpened') })}
                </span>
              </span>
              <Tag tone={link.answered ? 'success' : link.revoked ? 'neutral' : 'info'}>{t(link.answered ? 'export.linkAnswered' : link.revoked ? 'export.linkRevoked' : 'export.linkOpen')}</Tag>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- the dialogs -----------------------------------------------------------------------------------------------------------------

function ExportDialogView({ read, model, actions }: { read: ExportRead; model: ExportPapersModel; actions?: ExportPapersActions }) {
  const { t, say } = useWords()
  const dialog = model.dialog!
  const close = () => actions?.onDialog?.(null)
  const set = (next: Partial<Exclude<ExportDialog, null>>) => actions?.onDialog?.({ ...dialog, ...next } as ExportDialog)
  const problem = dialogProblem(dialog, read)
  const held = say(problem) ?? (model.busy ? t('export.held.busy') : null)
  const frame = (title: string, goLabel: string, children: ReactNode, options: { tone?: 'primary' | 'danger'; size?: 'md' | 'lg'; go?: boolean } = {}) => (
    <DepthDialog title={title} subtitle={read.shipment.number} held={held} onGo={() => actions?.onGo?.()} goLabel={goLabel} onClose={close} problem={say(model.problem)} tone={options.tone} size={options.size}>
      {children}
    </DepthDialog>
  )
  switch (dialog.kind) {
    case 'invoice':
    case 'postal':
      return frame(
        dialog.kind === 'invoice' ? t('export.dialog.invoiceTitle') : t('export.dialog.postalTitle'),
        dialog.kind === 'invoice' ? t('export.dialog.invoiceGo') : t('export.dialog.postalGo', { form: t(`export.form.${dialog.form}`) }),
        <>
          <p className="fw-sh-hint">{t(dialog.kind === 'invoice' ? 'export.dialog.invoiceBody' : 'export.dialog.postalBody')}</p>
          <div className="fw-shd-fields">
            {dialog.kind === 'postal' && (
              <Field label={t('export.dialog.form')} hint={postalChoices(read).length === 1 ? t('export.dialog.cn23Only') : undefined}>
                <Select value={dialog.form} onChange={(event) => set({ form: event.target.value as 'CN22' | 'CN23' })}>
                  {postalChoices(read).map((form) => (
                    <option key={form} value={form}>
                      {t(`export.form.${form}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('export.dialog.language')}>
              <Select value={dialog.language} onChange={(event) => set({ language: event.target.value as '' | 'it' | 'en' })}>
                <option value="">{t('export.dialog.languageOrder')}</option>
                <option value="it">{t('export.language.it')}</option>
                <option value="en">{t('export.language.en')}</option>
              </Select>
            </Field>
            <Field label={t('export.dialog.reason')}>
              <Select value={dialog.reason} onChange={(event) => set({ reason: event.target.value as (typeof EXPORT_REASONS)[number] })}>
                {EXPORT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`export.reason.${reason}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {dialog.reason === 'OTHER' && (
              <Field label={t('export.dialog.reasonText')} required>
                <Input value={dialog.reasonText} maxLength={REASON_TEXT_MAX} onChange={(event) => set({ reasonText: event.target.value })} />
              </Field>
            )}
          </div>
          {dialog.kind === 'invoice' ? (
            <Field label={t('export.dialog.notes')}>
              <Textarea rows={3} value={dialog.notes} maxLength={NOTES_MAX} onChange={(event) => set({ notes: event.target.value })} />
            </Field>
          ) : (
            <Field label={t('export.dialog.comments')}>
              <Textarea rows={2} value={dialog.comments} maxLength={COMMENTS_MAX} onChange={(event) => set({ comments: event.target.value })} />
            </Field>
          )}
        </>,
      )
    case 'declaration':
      return frame(
        t('export.dialog.declarationTitle'),
        t('export.dialog.declarationGo'),
        <>
          <p className="fw-sh-hint">{t('export.dialog.declarationBody')}</p>
          <Field label={t('export.dialog.filedBy')} hint={model.can.viewParties ? t('export.dialog.brokerHint') : t('export.dialog.noParties')}>
            <Select value={dialog.brokerPartyId} onChange={(event) => set({ brokerPartyId: event.target.value })}>
              <option value="">{t('export.byCarrier')}</option>
              {model.brokers?.state === 'ready' &&
                model.brokers.value.map((party) => (
                  <option key={party.id} value={party.id}>
                    {t('export.dialog.brokerOption', { code: party.code, name: party.legalName })}
                  </option>
                ))}
            </Select>
          </Field>
          {model.brokers?.state === 'loading' && (
            <p className="fw-sh-hint" role="status">
              <Spinner size={12} /> {t('export.dialog.brokersLoading')}
            </p>
          )}
          {model.brokers?.state === 'error' && <p className="fw-sh-hint">{t('export.dialog.brokersFailed')}</p>}
          <Field label={t('export.dialog.alertAfter')} hint={t('export.dialog.alertHint', { min: read.alertDays.min, max: read.alertDays.max })}>
            <NumberStepper size="sm" min={read.alertDays.min} max={read.alertDays.max} value={dialog.alertAfterDays} onChange={(next) => set({ alertAfterDays: next })} aria-label={t('export.dialog.alertAfter')} suffix={t('export.dialog.days')} decrementLabel={t('pickup.fewer')} incrementLabel={t('pickup.more')} />
          </Field>
        </>,
      )
    case 'mrn':
      return frame(
        t('export.dialog.mrnTitle'),
        t('export.dialog.mrnGo'),
        <>
          <p className="fw-sh-hint">{t('export.dialog.mrnBody')}</p>
          <Field label={t('export.mrn')} error={dialog.mrn.trim() !== '' ? (say(problem) ?? undefined) : undefined} required>
            <Input value={dialog.mrn} maxLength={40} spellCheck={false} autoCapitalize="characters" className="fw-sh-mono" onChange={(event) => set({ mrn: event.target.value.toUpperCase() })} />
          </Field>
        </>,
      )
    case 'nameInvoice':
      return frame(
        t('export.dialog.invoiceNameTitle'),
        t('export.dialog.invoiceNameGo'),
        <>
          <p className="fw-sh-hint">{t('export.dialog.invoiceNameBody')}</p>
          <Field label={t('export.invoiceNamed')}>
            <Select value={dialog.invoiceId} onChange={(event) => set({ invoiceId: event.target.value })}>
              {read.invoices.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {t(invoice.ofShipment ? 'export.dialog.invoiceOfShipment' : 'export.dialog.invoiceOption', { number: invoice.number, type: invoice.docType })}
                </option>
              ))}
            </Select>
          </Field>
        </>,
      )
    case 'exit':
      return frame(
        t('export.dialog.exitTitle'),
        t('export.dialog.exitGo'),
        <ExitFields dialog={dialog} read={read} set={set} />,
        { size: 'lg' },
      )
    case 'remove':
      return frame(
        t('export.dialog.removeTitle'),
        t('export.dialog.removeGo'),
        <>
          <p className="fw-sh-hint">{t('export.dialog.removeBody')}</p>
          <Field label={t('export.dialog.removeReason')} required>
            <Textarea rows={2} value={dialog.reason} maxLength={REMOVE_REASON_MAX} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        </>,
        { tone: 'danger' },
      )
    case 'pack':
      return <PackDialog read={read} model={model} actions={actions} origin={dialog.origin} onOrigin={(origin) => set({ origin })} />
  }
}

function ExitFields({ dialog, read, set }: { dialog: Extract<ExportDialog, { kind: 'exit' }>; read: ExportRead; set: (next: Partial<Extract<ExportDialog, { kind: 'exit' }>>) => void }) {
  const { t } = useWords()
  const locale = useLocale()
  return (
    <>
      <p className="fw-sh-hint">{t('export.dialog.exitBody')}</p>
      <Field label={t('export.dialog.exitAt')} required>
        <DateTimeField value={dialog.at} onChange={(value) => set({ at: value })} min={read.shipment.shippedAt ?? undefined} max={new Date().toISOString()} locale={INTL_LOCALE[locale]} ariaLabel={t('export.dialog.exitAt')} />
      </Field>
      <FileDropzone accept={PROOF_TYPES.join(',')} maxBytes={PROOF_MAX_BYTES} hint={t('export.dialog.exitFileHint')} onFiles={(files) => set({ file: files[0] ?? null, fileName: files[0]?.name ?? null })} />
      {dialog.fileName && <p className="fw-sh-hint">{t('export.dialog.exitPicked', { name: dialog.fileName })}</p>}
    </>
  )
}

function PackDialog({ read, model, actions, origin, onOrigin }: { read: ExportRead; model: ExportPapersModel; actions?: ExportPapersActions; origin: readonly string[]; onOrigin: (origin: string[]) => void }) {
  const { t, say } = useWords()
  const shell = useT('shell')
  const close = () => actions?.onDialog?.(null)
  const pack: BrokerPack | null = model.pack?.state === 'ready' ? model.pack.value : null
  return (
    <>
      <DepthDialog
        title={t('export.pack.title')}
        subtitle={read.shipment.number}
        held={pack ? say(linkHeld(pack, model.can, model.busy)) : t('export.held.reading')}
        onGo={() => actions?.onPackLink?.(true)}
        goLabel={t('export.pack.send')}
        onClose={close}
        problem={say(model.problem)}
        size="lg"
      >
        {!pack ? (
          <PartRead problem={model.pack?.state === 'error' ? model.pack.problem : null} onRetry={actions?.onRetry} label={t('export.pack.title')} />
        ) : (
          <>
            <p className="fw-sh-hint">{t(pack.brokerPackOn ? 'export.pack.bodyOn' : 'export.pack.bodyOff')}</p>
            <ul className="fw-shd-hold-list" aria-label={t('export.pack.parts')}>
              {pack.parts.map((part) => (
                <li key={part.part} className="fw-shd-part">
                  <span className="fw-sh-cell">
                    <span>{t(`export.part.${part.part}`)}</span>
                    {part.files.length > 0 && <span className="fw-sh-cell-sub">{part.files.map((file) => file.name).join(', ')}</span>}
                  </span>
                  <Tag tone={part.state === 'READY' ? 'success' : part.state === 'MISSING' ? 'warning' : 'neutral'}>{t(`export.partState.${part.state}`)}</Tag>
                </li>
              ))}
            </ul>
            {pack.originCandidates.length > 0 && (
              <fieldset className="fw-shd-choices">
                <legend className="fw-sh-hint">{t('export.pack.origin')}</legend>
                {pack.originCandidates.map((file) => (
                  <Checkbox key={file.fileId} checked={origin.includes(file.fileId)} onChange={(event) => onOrigin(event.target.checked ? [...origin, file.fileId] : origin.filter((id) => id !== file.fileId))} label={file.name} />
                ))}
              </fieldset>
            )}
            {model.passOn && (
              <Banner tone="success" title={t('export.pack.passOn')}>
                <span className="fw-sh-mono fw-shd-break">{model.passOn}</span>
              </Banner>
            )}
            <span className="fw-shd-actions">
              <Button size="sm" heldReason={say(downloadHeld(pack, model.can))} onClick={() => actions?.onPackPdf?.(true)}>
                <FileText size={13} aria-hidden /> {t('export.pack.download')}
              </Button>
              <Button size="sm" variant="quiet" heldReason={say(linkHeld(pack, model.can, model.busy))} onClick={() => actions?.onPackLink?.(false)}>
                {t('export.pack.passOnGo')}
              </Button>
            </span>
            {pack.parts.some((part) => part.files.length > 0) && (
              <ul className="fw-sh-papers" aria-label={t('export.pack.files')}>
                {pack.parts.flatMap((part) => part.files).map((file) => (
                  <li key={file.fileId} className="fw-sh-paper">
                    <FileRow name={file.name} size={file.sizeBytes} status={t('export.pack.inPack')} tone="neutral" />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </DepthDialog>
      {model.packPdf && (
        <Modal open size="xl" title={t('export.pack.pdfTitle', { number: read.shipment.number })} onClose={() => actions?.onPackPdf?.(false)}>
          {model.packPdf.state === 'ready' ? (
            <PdfViewer src={model.packPdf.value} title={t('export.pack.pdfTitle', { number: read.shipment.number })} fileName={`${read.shipment.number}-broker-pack.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
          ) : model.packPdf.state === 'error' ? (
            <PartRead problem={model.packPdf.problem} onRetry={() => actions?.onPackPdf?.(true)} label={t('export.pack.pdfTitle', { number: read.shipment.number })} />
          ) : (
            <p className="fw-sh-hint" role="status">
              <Spinner size={12} /> {t('export.pack.pdfLoading')}
            </p>
          )}
        </Modal>
      )}
    </>
  )
}

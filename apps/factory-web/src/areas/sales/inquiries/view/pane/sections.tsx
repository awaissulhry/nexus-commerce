'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, FilePlus2, ImageIcon } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, EditModeBar, FileRow, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { mailDocument, remotePictureCount } from '../../../../home/mail-to-sort/model'
import type { InquiryFile, InquiryView } from '../../api'
import {
  actionHeld,
  amountText,
  CURRENCIES,
  isOpen,
  messageReach,
  todayOf, // B-TH-234: a task's due day must be ahead of the site's today
  priceText,
  quotePreview,
  requestChanges,
  requestDraftOf,
  type Phrase,
  type RequestDraft,
} from '../../model'
import { useWords } from '../../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../../record-model'
import { AssignDialog, DeclineDialog, LostDialog, QuoteDialog } from '../Dialogs'
import { CustomerDialog, TaskDialog } from './CustomerDialogs' // B-TH-234
// B-TH-228: Make order, Make style draft.
import { OrderDialog, StyleDraftDialog } from '../Dialogs'
import { carriableFiles, orderHeld, styleDraftDialogHeld } from '../../model'
import { LinesEditor, LinesRead } from '../LinesEditor'

const INTL = { it: 'it-IT', en: 'en-GB' } as const

/** Who it is from, in one line: the customer (code · name), else the prospect (company, name, e-mail), else the sender. */
export function fromLine(view: InquiryView, t: (key: string) => string): string {
  if (view.party) return `${view.party.code} · ${view.party.name}`
  if (view.prospectDetails?.erased) return t('who.erased')
  return view.fromWords
}

/**
 * B-TH-217 (threads plan TH-1b): the parts of today's request record — the 1160 px modal with its four tabs went; its parts live
 * on in the reading pane and the full page: the closed line, the request editor (who asks, what, the lines, the note, the
 * sender's mail as sent), the tech pack picker (moved from "Files & specs" into Details), what was made from it, the dialogs.
 */

export function Closed({ view }: { view: InquiryView }) {
  const { t, when } = useWords()
  const by = view.closedBy?.name ?? null
  const reason = view.declineReason ? t(`decline.${view.declineReason}`) : null
  const title =
    view.status === 'QUOTED'
      ? t('closed.quoted', { quote: view.quote?.number ?? '—', when: when(view.closedAt) })
      : view.status === 'DECLINED'
        ? t('closed.declined', { reason: reason ?? '—', when: when(view.closedAt) })
        : view.status === 'ORDERED'
          ? t('closed.ordered', { when: when(view.closedAt) })
          : t('closed.lost', { when: when(view.closedAt) })
  return (
    <Banner tone="info" title={title}>
      <p className="fw-inq-text">
        {[by ? t('closed.by', { name: by }) : null, view.closeNote].filter(Boolean).join(' — ') || t('closed.noteOnly')}
      </p>
    </Banner>
  )
}

// ---- Request -----------------------------------------------------------------------------------------------------------

function heldOfEdit(model: InquiryRecordModel, view: InquiryView): Phrase | null {
  if (!model.can.manage) return { key: 'request.viewOnly' }
  if (!view.actions.edit.allowed) return { key: 'request.closedReadOnly', params: { number: view.number } }
  return null
}

/**
 * Request (design inquiry.request; explicit save with the EditModeBar): who asks (the customer and contact, or the prospect —
 * matched once to a customer), how and when it came, what they ask in words and as lines (a style per product asked, its
 * sizes), the target price (a price: absent without it), the wanted day, the note (in any state), and the sender's mail as
 * sent (sanitised, in a sandboxed frame). Read-only it is drawn as text with the reason.
 */
export function RequestEditorBody({ model, view, draft, actions }: { model: InquiryRecordModel; view: InquiryView; draft: RequestDraft; actions?: InquiryRecordActions }) {
  const { t, say, day, when, locale } = useWords()
  const held = heldOfEdit(model, view)
  const editable = held === null
  const set = (patch: Partial<RequestDraft>) => actions?.onDraft?.(patch)
  const party = view.party
  const target = view.targetUnitPrice as string | null | undefined
  const who: { label: string; value: ReactNode }[] = [
    { label: t('who.channel'), value: t(`source.${view.source}`) },
    { label: t('who.received'), value: when(view.receivedAt) },
    { label: t('who.createdBy'), value: view.createdBy ? t('who.createdByOn', { name: view.createdBy.name, when: when(view.createdAt) }) : when(view.createdAt) },
  ]
  return (
    <div className="fw-inq-stack">
      {held && <Banner tone="info" title={t('request.readOnly', { reason: say(held) ?? '' })} />}
      <div className="fw-inq-two">
        <Card padded>
          <div className="fw-inq-card-head">
            <h2 className="fw-inq-h2">{t('who.title')}</h2>
            {!model.can.manage && <span className="fw-inq-hint">{t('request.viewOnly')}</span>}
          </div>
          <div className="fw-inq-stack">
            {party ? (
              <Field label={t('who.customer')}>
                {model.can.parties ? (
                  <Link className="fw-inq-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(party.id)}`}>
                    {party.code} · {party.name}
                  </Link>
                ) : (
                  <span className="fw-inq-value">
                    {party.code} · {party.name}
                  </span>
                )}
              </Field>
            ) : (
              <ProspectFields model={model} view={view} draft={draft} editable={editable} actions={actions} />
            )}
            {party && (
              <Field label={t('who.contact')}>
                {editable && model.contacts ? (
                  model.contacts.items === null && !model.contacts.problem ? (
                    <Skeleton height={32} />
                  ) : (
                    <Select size="sm" value={draft.contactId ?? ''} onChange={(event) => set({ contactId: event.target.value || null })}>
                      <option value="">{t('who.noContact')}</option>
                      {(model.contacts.items ?? []).map((contact) => (
                        <option key={contact.id} value={contact.id}>
                          {contact.email ? `${contact.name} · ${contact.email}` : contact.name}
                        </option>
                      ))}
                      {view.contact && !(model.contacts.items ?? []).some((contact) => contact.id === view.contact!.id) && <option value={view.contact.id}>{view.contact.name}</option>}
                    </Select>
                  )
                ) : (
                  <span className="fw-inq-value">{view.contact ? (view.contact.email ? `${view.contact.name} · ${view.contact.email}` : view.contact.name) : '—'}</span>
                )}
              </Field>
            )}
            <KeyValue items={who} labelCase="sentence" />
          </div>
        </Card>
        <Card padded>
          <h2 className="fw-inq-h2">{t('request.what')}</h2>
          <div className="fw-inq-stack">
            <Field label={t('request.request')} hint={editable ? t('request.requestHint') : undefined}>
              {editable ? <Textarea value={draft.request} rows={6} honourRows maxLength={20000} onChange={(event) => set({ request: event.target.value })} /> : <p className="fw-inq-text">{view.request}</p>}
            </Field>
            <div className="fw-inq-form-grid">
              {model.can.price && (
                <Field label={t('request.target')} hint={t('request.targetHint')}>
                  {editable ? (
                    <span className="fw-inq-row">
                      <Input size="sm" inputMode="decimal" aria-label={t('request.target')} value={draft.targetPrice} onChange={(event) => set({ targetPrice: event.target.value })} />
                      <Select size="sm" aria-label={t('request.currency')} value={draft.currency} onChange={(event) => set({ currency: event.target.value })}>
                        {[...new Set([...CURRENCIES, view.currency])].map((currency) => (
                          <option key={currency} value={currency}>
                            {currency}
                          </option>
                        ))}
                      </Select>
                    </span>
                  ) : (
                    <span className="fw-inq-value">{target ? priceText(target, view.currency, INTL[locale]) : '—'}</span>
                  )}
                </Field>
              )}
              <Field label={t('request.wanted')}>{editable ? <DateField value={draft.wantedDate ?? ''} clearable onChange={(value) => set({ wantedDate: value || null })} /> : <span className="fw-inq-value">{day(view.wantedDate)}</span>}</Field>
            </div>
          </div>
        </Card>
      </div>
      <Card padded>
        <div className="fw-inq-card-head">
          <h2 className="fw-inq-h2">{t('request.lines')}</h2>
          <span className="fw-inq-hint">{editable ? t('request.linesHint') : t('request.pieces', { count: view.pieces })}</span>
        </div>
        {editable ? <LinesEditor model={{ lines: draft.lines, styles: model.styles, details: model.details }} actions={{ onLines: actions?.onLines, onStyle: actions?.onStyle }} /> : <LinesRead lines={view.lines} />}
      </Card>
      <Card padded>
        <h2 className="fw-inq-h2">{t('request.notes')}</h2>
        <Field label={t('request.note')} hint={t('request.noteHint')}>
          {model.can.manage ? <Textarea value={draft.note} rows={3} honourRows maxLength={4000} onChange={(event) => set({ note: event.target.value })} /> : <p className="fw-inq-text">{view.note ?? '—'}</p>}
        </Field>
      </Card>
      {view.mail && <MailCard model={model} view={view} actions={actions} />}
    </div>
  )
}

export function ProspectFields({ model, view, draft, editable, actions }: { model: InquiryRecordModel; view: InquiryView; draft: RequestDraft; editable: boolean; actions?: InquiryRecordActions }) {
  const { t } = useWords()
  const set = (patch: Partial<RequestDraft['prospect']>) => actions?.onDraft?.({ prospect: { ...draft.prospect, ...patch } })
  const details = view.prospectDetails
  if (details?.erased) return <Banner tone="info" title={t('who.erased')} />
  return (
    <div className="fw-inq-stack">
      <Banner tone="warning" title={t('who.unknown')}>
        <p className="fw-inq-text">{t('who.unknownBody')}</p>
      </Banner>
      {/* B-TH-234: one way to give a prospect its customer — the check first ("Make or match the customer"), never a pick here. */}
      {editable && (
        <Field label={t('who.match')} hint={t('who.matchHint')}>
          <Button size="sm" onClick={() => actions?.onVerb?.('customer')}>
            {t('pane.action.match')}
          </Button>
        </Field>
      )}
      <div className="fw-inq-form-grid">
          {/* B-TH-217 (PR-30, GDPR minimisation): a prospect's e-mail and phone only for who answers requests. */}
          {(model.can.manage ? (['name', 'company', 'email', 'phone'] as const) : (['name', 'company'] as const)).map((field) => (
            <Field key={field} label={t(`prospect.${field}`)}>
              {editable ? <Input size="sm" value={draft.prospect[field]} maxLength={field === 'email' ? 254 : field === 'phone' ? 40 : 200} onChange={(event) => set({ [field]: event.target.value })} /> : <span className="fw-inq-value">{details?.[field] ?? '—'}</span>}
            </Field>
          ))}
          <Field label={t('prospect.basis')}>
            <span className="fw-inq-value">{details?.lawfulBasis ? t(`basis.${details.lawfulBasis}`) : t('basis.CONTRACT')}</span>
          </Field>
      </div>
    </div>
  )
}

/** The sender's mail as sent: the sanitised HTML in a sandboxed frame (remote pictures only on Show pictures), else its text. */
export function MailCard({ model, view, actions }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions }) {
  const { t, when } = useWords()
  const mail = view.mail!
  const pictures = remotePictureCount(mail.bodyHtml)
  const document = useMemo(() => (mail.bodyHtml ? mailDocument(mail.bodyHtml, { allowPictures: model.pictures }) : null), [mail.bodyHtml, model.pictures])
  const from = mail.from.name && mail.from.address ? `${mail.from.name} <${mail.from.address}>` : (mail.from.address ?? mail.from.name ?? '—')
  return (
    <Card padded>
      <div className="fw-inq-card-head">
        <h2 className="fw-inq-h2">{t('mail.title')}</h2>
        {pictures > 0 && !model.pictures && (
          <Button size="sm" variant="quiet" onClick={() => actions?.onPictures?.()}>
            <ImageIcon size={14} aria-hidden /> {t('mail.pictures', { count: pictures })}
          </Button>
        )}
      </div>
      <div className="fw-inq-stack">
        <KeyValue
          items={[
            { label: t('mail.from'), value: from },
            { label: t('mail.subject'), value: mail.subject ?? '—' },
            { label: t('mail.received'), value: when(mail.receivedAt) },
          ]}
          labelCase="sentence"
        />
        {document ? <iframe className="fw-inq-mail-frame" title={t('mail.frame')} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={document} /> : <pre className="fw-inq-mail-text">{mail.bodyText ?? t('mail.empty')}</pre>}
        {mail.status !== 'MATCHED' && <p className="fw-inq-hint">{t('mail.waits')}</p>}
      </div>
    </Card>
  )
}

// ---- Files & specs ----------------------------------------------------------------------------------------------------------

/**
 * Files & specs (design inquiry.files): the brand's tech pack — the version the brand names and its files, each with the
 * version in force of its series ("always the version in force", SAL-305) — chosen among the inquiry's files and the mail's
 * kept attachments; the mail's attachments; and the record panels' Files (upload with kind and visibility, PdfViewer, a
 * download is always an attachment).
 */
export function TechPackPicker({ model, view, draft, actions }: { model: InquiryRecordModel; view: InquiryView; draft: RequestDraft; actions?: InquiryRecordActions }) {
  const { t } = useWords()
  const editable = model.can.manage && view.actions.edit.allowed
  const chosen = new Set(draft.techPackFileIds)
  const candidates: { file: InquiryFile; from: 'inquiry' | 'mail' }[] = [...view.files.map((file) => ({ file, from: 'inquiry' as const })), ...view.mailFiles.map((file) => ({ file, from: 'mail' as const }))]
  const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
  const open = (file: InquiryFile) =>
    model.can.files && file.status === 'AVAILABLE' ? (
      <Button size="sm" variant="quiet" aria-label={t('files.download', { name: file.originalName })} onClick={() => actions?.onOpenFile?.(file.id)}>
        <Download size={14} aria-hidden />
      </Button>
    ) : null
  return (
    <div className="fw-inq-stack">
      <div className="fw-inq-two">
        <Card padded>
          <div className="fw-inq-card-head">
            <h2 className="fw-inq-h2">{t('pack.title')}</h2>
            <span className="fw-inq-hint">{t('pack.hint')}</span>
          </div>
          <div className="fw-inq-stack">
            <Field label={t('pack.version')} hint={t('pack.versionHint')}>
              {editable ? <Input size="sm" value={draft.techPackVersion} maxLength={100} onChange={(event) => actions?.onDraft?.({ techPackVersion: event.target.value })} /> : <span className="fw-inq-value">{view.techPack.version ?? '—'}</span>}
            </Field>
            {view.techPack.files.length === 0 ? (
              <p className="fw-inq-hint">{t('pack.none')}</p>
            ) : (
              <div className="fw-inq-files">
                {view.techPack.files.map((file) => (
                  <FileRow
                    key={file.named.id}
                    name={file.named.originalName}
                    size={file.named.sizeBytes}
                    status={file.current === null ? t('pack.gone') : file.newer ? t('pack.newer', { named: file.named.versionNo, current: file.current.versionNo }) : t('pack.inForce', { version: file.named.versionNo })}
                    tone={file.current === null ? 'danger' : 'neutral'}
                    actions={open(file.current ?? file.named)}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>
        <Card padded>
          <div className="fw-inq-card-head">
            <h2 className="fw-inq-h2">{t('pack.choose')}</h2>
            <span className="fw-inq-hint">{editable ? t('pack.chooseHint') : t('pack.chooseReadOnly')}</span>
          </div>
          {candidates.length === 0 ? (
            <p className="fw-inq-hint">{t('files.none')}</p>
          ) : (
            <div className="fw-inq-files">
              {candidates.map(({ file, from }) => (
                <FileRow
                  key={file.id}
                  name={file.originalName}
                  size={file.sizeBytes}
                  status={`${t(from === 'mail' ? 'files.fromMail' : 'files.added')} · ${size(file.sizeBytes)}`}
                  actions={
                    <span className="fw-inq-row">
                      {open(file)}
                      <Checkbox checked={chosen.has(file.id)} disabled={!editable} onChange={(event) => actions?.onTechPack?.(file.id, event.target.checked)} label={t('pack.inPack')} />
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

// ---- Quote -----------------------------------------------------------------------------------------------------------------

/** Quote (design inquiry.quote): the quote this inquiry became (a link, its status, its value: a price), or "Not quoted yet" + Make quote. */
export function MadeFrom({ model, view, actions }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions }) {
  const { t, say, locale } = useWords()
  const offline = model.live === 'offline'
  const held = say(actionHeld(view, 'quote', model.can, offline))
  const preview = quotePreview(view)
  if (!view.quote)
    return (
      <Card padded>
        <EmptyState
          title={t('quote.none')}
          description={view.prospect ? t('quote.noneProspect') : t('quote.noneBody', { lines: preview.copied.length, left: preview.leftOut.length })}
          action={
            isOpen(view.status) ? (
              <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onVerb?.('quote')} aria-keyshortcuts="q">
                <FilePlus2 size={14} aria-hidden /> {t('verb.quote')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  const detail = view.quoteDetail
  const quoteHref = `${model.prefix}/sales/quotes/${encodeURIComponent(view.quote.id)}`
  return (
    <Card padded>
      <h2 className="fw-inq-h2">{t('quote.made')}</h2>
      <SummaryTable
        label={t('quote.made')}
        density="roomy"
        columns={[t('quote.col.quote'), t('quote.col.status'), t('quote.col.revision'), ...(model.can.price ? [t('quote.col.value')] : [])]}
        rows={[
          {
            id: view.quote.id,
            cells: [
              model.can.quotesView ? (
                <Link key="q" className="fw-inq-link" href={quoteHref}>
                  {view.quote.number}
                </Link>
              ) : (
                view.quote.number
              ),
              detail ? t(`quoteStatus.${detail.status}`) : t('quote.noRight'),
              detail ? t('quote.revision', { n: detail.revision }) : '—',
              ...(model.can.price ? [detail && detail.netAmount !== undefined ? <span key="v" className="fw-inq-num">{amountText(detail.netAmount as number, detail.currency, INTL[locale])}</span> : '—'] : []),
            ],
          },
        ]}
      />
      <p className="fw-inq-hint">{t('quote.oneOnly')}</p>
    </Card>
  )
}

// ---- B-TH-228 (pane-facts-F03): the order made straight from it and the style drafts, each with its OWN status; each opens -------

export function MadeThings({ model, view }: { model: InquiryRecordModel; view: InquiryView }) {
  const { t } = useWords()
  const drafts = view.styleDrafts ?? []
  if (!view.order && drafts.length === 0) return null
  return (
    <ul className="fw-inq-made">
      {view.order && (
        <li>
          {model.can.ordersView ? (
            <Link className="fw-inq-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(view.order.id)}`}>
              {t('pane.facts.madeOrder', { order: view.order.number, status: t(`orderStatus.${view.order.status}`) })}
            </Link>
          ) : (
            t('pane.facts.madeOrder', { order: view.order.number, status: t(`orderStatus.${view.order.status}`) })
          )}
        </li>
      )}
      {drafts.map((draft) => (
        <li key={draft.id}>
          {model.can.styles ? (
            <Link className="fw-inq-link" href={`${model.prefix}/products/styles/${encodeURIComponent(draft.id)}`} target="_blank" rel="noopener">
              {t('pane.facts.madeStyle', { code: draft.code, name: draft.name, status: t(`styleStatus.${draft.status}`) })}
            </Link>
          ) : (
            t('pane.facts.madeStyle', { code: draft.code, name: draft.name, status: t(`styleStatus.${draft.status}`) })
          )}
        </li>
      ))}
    </ul>
  )
}

// ---- the dialogs ------------------------------------------------------------------------------------------------------------

export function RecordDialogs({ model, view, actions }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions }) {
  const { t } = useWords()
  const dialog = model.dialog
  if (!dialog) return null
  const offline = model.live === 'offline'
  const subject = { key: 'dialog.subject', params: { number: view.number, from: fromLine(view, t) } }
  const close = actions?.dialog?.onClose
  if (dialog.kind === 'assign')
    return <AssignDialog model={{ subject, current: view.assignee, people: dialog.people, busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onAssign: actions?.dialog?.onAssign, onRetry: actions?.dialog?.onRetryPeople, onClose: close }} />
  if (dialog.kind === 'decline')
    return <DeclineDialog model={{ subject, draft: dialog.draft, message: messageReach(view, model.can), start: dialog.start ?? null /* th-backend-g step 2 */, busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onDraft: actions?.dialog?.onDecline, onSubmit: actions?.dialog?.onSubmit, onClose: close }} />
  // ---- B-TH-234: make or match the customer (the check first), "Ask <customer> for…"
  if (dialog.kind === 'customer')
    return <CustomerDialog model={{ view, check: dialog.check, choice: dialog.choice, confirmed: dialog.confirmed, can: model.can, busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onCustomer: actions?.dialog?.onCustomer, onRetry: actions?.dialog?.onRetryCheck, onSubmit: actions?.dialog?.onSubmit, onClose: close }} />
  if (dialog.kind === 'task')
    return <TaskDialog model={{ view, draft: dialog.draft, can: model.can, today: todayOf(new Date().toISOString()), busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onTask: actions?.dialog?.onTask, onSubmit: actions?.dialog?.onSubmit, onClose: close }} />
  // ---- end B-TH-234
  if (dialog.kind === 'lost') return <LostDialog model={{ subject, note: dialog.note, busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onNote: actions?.dialog?.onLostNote, onSubmit: actions?.dialog?.onSubmit, onClose: close }} />
  // ---- B-TH-228
  if (dialog.kind === 'order')
    return (
      <OrderDialog
        model={{
          subject,
          customer: view.party ? `${view.party.code} · ${view.party.name}` : fromLine(view, t),
          contact: view.contact?.name ?? null,
          lines: view.lines,
          draft: dialog.draft,
          prices: model.can.price,
          currency: view.currency,
          files: carriableFiles(view),
          held: orderHeld(view, dialog.draft, model.can, offline),
          busy: dialog.busy,
          notice: dialog.notice,
        }}
        actions={{ onDraft: actions?.dialog?.onOrderDraft, onSubmit: actions?.dialog?.onSubmit, onClose: close }}
      />
    )
  if (dialog.kind === 'styleDraft')
    return (
      <StyleDraftDialog
        model={{ subject, customer: view.party?.name ?? fromLine(view, t), draft: dialog.draft, scales: dialog.scales, files: carriableFiles(view), held: styleDraftDialogHeld(view, dialog.draft, model.can, offline), busy: dialog.busy, notice: dialog.notice }}
        actions={{ onDraft: actions?.dialog?.onStyleDraft, onSubmit: actions?.dialog?.onSubmit, onClose: close }}
      />
    )
  // ---- end B-TH-228
  return (
    <QuoteDialog
      model={{
        subject,
        customer: view.party ? `${view.party.code} · ${view.party.name}` : fromLine(view, t),
        contact: view.contact?.name ?? null,
        wantedDate: view.wantedDate,
        preview: quotePreview(view),
        customerRef: dialog.customerRef,
        held: actionHeld(view, 'quote', model.can, offline),
        busy: dialog.busy,
        notice: dialog.notice,
      }}
      actions={{ onRef: actions?.dialog?.onRef, onSubmit: actions?.dialog?.onSubmit, onClose: close }}
    />
  )
}

// ---- B-TH-217: Edit the request (a dialog over the pane and the full page) ------------------------------------------------------

/**
 * "Edit the request": who asks (match a prospect to a customer once, the contact), what they ask in our words and as lines, the
 * target price (price grain), the wanted day, the note, and the tech pack (which files, the version in force) — saved as ONE
 * change at the version read with the EditModeBar (⌘S). The customer's own words stay as they came (the first card).
 */
export function RequestEditor({ model, view, actions, onClose }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions; onClose: () => void }) {
  const { t, say } = useWords()
  const draft = model.draft ?? requestDraftOf(view)
  const changes = requestChanges(view, draft, model.can)
  const offline = model.live === 'offline'
  const footer: ReactNode =
    changes.count > 0 && model.can.manage ? (
      <EditModeBar
        count={changes.count}
        busy={model.saving}
        applyHeldReason={model.saving ? t('common.working') : (say(changes.problem) ?? (offline ? t('held.offlineKept') : null))}
        onApply={() => actions?.onSave?.()}
        onDiscard={() => actions?.onDiscard?.()}
        saveShortcut
      />
    ) : (
      <Button onClick={onClose}>{t('pane.edit.close')}</Button>
    )
  return (
    <Modal open onClose={onClose} size="xl" title={t('pane.edit.title', { number: view.number })} subtitle={fromLine(view, t)} footer={footer}>
      <div className="fw-inq-stack">
        {model.stale && <Banner tone="warning" title={t('record.stale', { time: model.stale })} />}
        <RequestEditorBody model={model} view={view} draft={draft} actions={actions} />
        <TechPackPicker model={model} view={view} draft={draft} actions={actions} />
      </div>
    </Modal>
  )
}

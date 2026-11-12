'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, FilePlus2, ImageIcon, MoreHorizontal, UserRound, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { DateField, EditModeBar, FileRow, Textarea } from '../../../../lib/i18n/ds-parts'
import { mailDocument, remotePictureCount } from '../../../home/mail-to-sort/model'
import type { InquiryFile, InquiryView } from '../api'
import {
  actionHeld,
  amountText,
  CURRENCIES,
  isOpen,
  messageReach,
  priceText,
  quotePreview,
  requestChanges,
  requestDraftOf,
  type Phrase,
  type RequestDraft,
} from '../model'
import { useWords } from '../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { AssignDialog, DeclineDialog, LostDialog, QuoteDialog } from './Dialogs'
import { LinesEditor, LinesRead } from './LinesEditor'

/** The record's panels the container mounts (thread, files): the Activity tab and the files part of Files & specs. */
export interface RecordSlots {
  readonly activity?: ReactNode
  readonly files?: ReactNode
}

const INTL = { it: 'it-IT', en: 'en-GB' } as const

/** Who it is from, in one line: the customer (code · name), else the prospect (company, name, e-mail), else the sender. */
export function fromLine(view: InquiryView, t: (key: string) => string): string {
  if (view.party) return `${view.party.code} · ${view.party.name}`
  if (view.prospectDetails?.erased) return t('who.erased')
  return view.fromWords
}

/** The record's verbs as buttons and the ⋯ menu, each held with its reason (the API's own `actions` for this reader). */
export function RecordVerbs({ model, view, actions, extra }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions; extra?: MenuItemDef[] }) {
  const { t, say } = useWords()
  const offline = model.live === 'offline'
  const held = (action: keyof InquiryView['actions']) => (model.busy || model.saving ? t('common.working') : say(actionHeld(view, action, model.can, offline)))
  if (!isOpen(view.status))
    return (
      <span className="fw-inq-actions">
        <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={[...(extra ?? []), { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() }]} />
      </span>
    )
  const menu: MenuItemDef[] = [
    view.status === 'NEED_INFO'
      ? { id: 'resume', label: t('verb.resume'), disabled: !!held('resume'), description: held('resume') ?? undefined, onSelect: () => actions?.onVerb?.('resume') }
      : { id: 'askInfo', label: t('verb.askInfo'), disabled: !!held('askInfo'), description: held('askInfo') ?? t('verb.askInfoHint'), onSelect: () => actions?.onVerb?.('askInfo') },
    ...(view.assigneeId ? [{ id: 'unassign', label: t('verb.unassign'), disabled: !!held('unassign'), description: held('unassign') ?? undefined, onSelect: () => actions?.onVerb?.('unassign') }] : []),
    { id: 'lost', label: t('verb.lost'), tone: 'danger' as const, disabled: !!held('lose'), description: held('lose') ?? undefined, onSelect: () => actions?.onVerb?.('lost') },
    ...(extra ?? []),
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() },
  ]
  return (
    <span className="fw-inq-actions">
      <Button size="sm" variant="danger-outline" heldReason={held('decline')} onClick={() => actions?.onVerb?.('decline')} aria-keyshortcuts="d">
        <XCircle size={14} aria-hidden /> {t('verb.decline')}
      </Button>
      <Button size="sm" heldReason={held('assign')} onClick={() => actions?.onVerb?.('assign')} aria-keyshortcuts="a">
        <UserRound size={14} aria-hidden /> {t('verb.assign')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held('quote')} onClick={() => actions?.onVerb?.('quote')} aria-keyshortcuts="q">
        <FilePlus2 size={14} aria-hidden /> {t('verb.quote')}
      </Button>
      <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={menu} />
    </span>
  )
}

/** The facts under the title: status, source, waiting, who has it (a name inside the one record), a prospect. */
export function RecordMeta({ view }: { view: InquiryView }) {
  const { t, say } = useWords()
  return (
    <span className="fw-inq-row">
      <Tag tone="neutral">{t(`source.${view.source}`)}</Tag>
      {view.prospect && <Tag tone="warning">{t('who.prospectTag')}</Tag>}
      {view.waiting.for && <Tag tone={view.waiting.overdue ? 'danger' : view.waiting.for === 'CUSTOMER' ? 'warning' : 'neutral'}>{say({ key: view.waiting.for === 'CUSTOMER' ? 'waiting.customer' : view.waiting.overdue ? 'waiting.usOverdue' : 'waiting.us' })}</Tag>}
      <span className="fw-inq-hint">{view.assignee ? (view.mine ? t('record.withMe') : t('record.with', { name: view.assignee.name })) : t('record.withNobody')}</span>
    </span>
  )
}

/** The tab the record shows, with its Apply bar and the dialogs. */
export function RecordBody({ model, view, actions, slots }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions; slots?: RecordSlots }) {
  const { t, say } = useWords()
  const draft = model.draft ?? requestDraftOf(view)
  const changes = requestChanges(view, draft, model.can)
  const offline = model.live === 'offline'
  return (
    <div className="fw-inq-stack">
      {model.stale && (
        <Banner
          tone="warning"
          title={t('record.stale', { time: model.stale })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {!isOpen(view.status) && <Closed view={view} />}
      {model.tab === 'request' && <RequestTab model={model} view={view} draft={draft} actions={actions} />}
      {model.tab === 'files' && <FilesTab model={model} view={view} draft={draft} actions={actions} slot={slots?.files} />}
      {model.tab === 'quote' && <QuoteTab model={model} view={view} actions={actions} />}
      {model.tab === 'activity' && (slots?.activity ?? <p className="fw-inq-hint">{model.can.thread ? t('activity.none') : t('activity.noRight')}</p>)}
      {(model.tab === 'request' || model.tab === 'files') && changes.count > 0 && model.can.manage && (
        <EditModeBar
          count={changes.count}
          busy={model.saving}
          applyHeldReason={model.saving ? t('common.working') : (say(changes.problem) ?? (offline ? t('held.offlineKept') : null))}
          onApply={() => actions?.onSave?.()}
          onDiscard={() => actions?.onDiscard?.()}
          saveShortcut
        />
      )}
      <RecordDialogs model={model} view={view} actions={actions} />
    </div>
  )
}

function Closed({ view }: { view: InquiryView }) {
  const { t, when } = useWords()
  const by = view.closedBy?.name ?? null
  const reason = view.declineReason ? t(`decline.${view.declineReason}`) : null
  const title =
    view.status === 'QUOTED'
      ? t('closed.quoted', { quote: view.quote?.number ?? '—', when: when(view.closedAt) })
      : view.status === 'DECLINED'
        ? t('closed.declined', { reason: reason ?? '—', when: when(view.closedAt) })
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
function RequestTab({ model, view, draft, actions }: { model: InquiryRecordModel; view: InquiryView; draft: RequestDraft; actions?: InquiryRecordActions }) {
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
            {(party || draft.matchPartyId) && (
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

function ProspectFields({ model, view, draft, editable, actions }: { model: InquiryRecordModel; view: InquiryView; draft: RequestDraft; editable: boolean; actions?: InquiryRecordActions }) {
  const { t } = useWords()
  const set = (patch: Partial<RequestDraft['prospect']>) => actions?.onDraft?.({ prospect: { ...draft.prospect, ...patch } })
  const details = view.prospectDetails
  if (details?.erased) return <Banner tone="info" title={t('who.erased')} />
  return (
    <div className="fw-inq-stack">
      <Banner tone="warning" title={t('who.unknown')}>
        <p className="fw-inq-text">{t('who.unknownBody')}</p>
      </Banner>
      {editable && model.customers && (
        <Field label={t('who.match')} hint={t('who.matchHint')}>
          {model.customers.items === null && !model.customers.problem ? (
            <Skeleton height={32} />
          ) : (
            <Select size="sm" value={draft.matchPartyId ?? ''} onChange={(event) => actions?.onMatch?.(event.target.value || null)}>
              <option value="">{t('who.matchNone')}</option>
              {(model.customers.items ?? []).map((party) => (
                <option key={party.id} value={party.id}>
                  {party.code} · {party.tradeName ?? party.legalName}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {!draft.matchPartyId && (
        <div className="fw-inq-form-grid">
          {(['name', 'company', 'email', 'phone'] as const).map((field) => (
            <Field key={field} label={t(`prospect.${field}`)}>
              {editable ? <Input size="sm" value={draft.prospect[field]} maxLength={field === 'email' ? 254 : field === 'phone' ? 40 : 200} onChange={(event) => set({ [field]: event.target.value })} /> : <span className="fw-inq-value">{details?.[field] ?? '—'}</span>}
            </Field>
          ))}
          <Field label={t('prospect.basis')}>
            <span className="fw-inq-value">{details?.lawfulBasis ? t(`basis.${details.lawfulBasis}`) : t('basis.CONTRACT')}</span>
          </Field>
        </div>
      )}
    </div>
  )
}

/** The sender's mail as sent: the sanitised HTML in a sandboxed frame (remote pictures only on Show pictures), else its text. */
function MailCard({ model, view, actions }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions }) {
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
function FilesTab({ model, view, draft, actions, slot }: { model: InquiryRecordModel; view: InquiryView; draft: RequestDraft; actions?: InquiryRecordActions; slot?: ReactNode }) {
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
      {slot ?? (model.can.thread ? null : <p className="fw-inq-hint">{t('files.noRight')}</p>)}
    </div>
  )
}

// ---- Quote -----------------------------------------------------------------------------------------------------------------

/** Quote (design inquiry.quote): the quote this inquiry became (a link, its status, its value: a price), or "Not quoted yet" + Make quote. */
function QuoteTab({ model, view, actions }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions }) {
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
    return <DeclineDialog model={{ subject, draft: dialog.draft, message: messageReach(view, model.can), busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onDraft: actions?.dialog?.onDecline, onSubmit: actions?.dialog?.onSubmit, onClose: close }} />
  if (dialog.kind === 'lost') return <LostDialog model={{ subject, note: dialog.note, busy: dialog.busy, notice: dialog.notice, offline }} actions={{ onNote: actions?.dialog?.onLostNote, onSubmit: actions?.dialog?.onSubmit, onClose: close }} />
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

'use client'

import { useEffect, useId, useRef } from 'react'
import Link from 'next/link'
import { Inbox, Plus } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { Combobox, FileDropzone, FileRow, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { COMPOSE_NS, type ComposeField } from '../../../../lib/request-compose/model'
import { RequestCompose, type RequestComposeModel } from '../../../../lib/request-compose/view/RequestCompose'
import { WithMessages } from '../../../../record-panels/i18n'
import type { ContactOption, MailDraft, RequestCustomer, StyleOption } from '../api'
import { CURRENCIES, recordHref, type InquiriesCan, type Loaded, type Notice, type Phrase } from '../model'
import { composeProblems, LAWFUL_BASES, n, NEW_NS, newRequestHeld, OFFICE_VOICE, prospectMatch, stylesFor, TYPED_SOURCES, type NewRequestDraft, type Who } from '../new-request'
import { NoticeLine, useWords } from '../parts'
import { LinesEditor, type StyleRead } from './LinesEditor'
import './new-request.css'

/**
 * SCR-105-new — New request in the office (B-TH-221; threads plan O-SAL-INQ-LIST.band-F02, walls W23 and W37): a phone call, a
 * visit, a fair or a letter written down in the portal's own compose (`lib/request-compose`, B-TH-220: subject, message, the
 * PO, the day wanted, a delivery address), with the office's "From" in the compose's To place — how it came, the customer
 * (only the customers the API says this person may make a request for) and its contact, OR a prospect with the lawful basis
 * of keeping its details (required with any of them; "Use <customer>?" when the prospect already is one of the reader's
 * customers) — the files (office only), and in "Add details" the target price (price grain) and the lines (a style of the
 * open range or of this customer's own label). "Give it to me" and Create request in the footer; ⌘↵ creates; closing with
 * typed text asks first. `?mail=` makes the request from a mail of Mail to sort (its words, its attachments as the tech
 * pack). A full-screen sheet on a phone (the DS window `xxl`). Draws one view model and fetches nothing.
 */

export interface NewRequestModel {
  readonly draft: NewRequestDraft
  /** "Make incoming request" from a mail of Mail to sort: its draft as the API read it; null for a typed one. */
  readonly mail: { readonly id: string; readonly draft: Loaded<MailDraft> } | null
  /** The customers this person may make a request for (GET /sales/inquiries/customers); `none`: their role reads no customer. */
  readonly customers: { readonly state: 'loading' | 'ready' | 'error' | 'none'; readonly items: readonly RequestCustomer[]; readonly total: number; readonly limited: boolean }
  readonly contacts: { readonly items: readonly ContactOption[] | null; readonly problem: string | null } | null
  /** The picked customer's delivery addresses (the compose's "Deliver to"). */
  readonly shipTo: RequestComposeModel['shipTo']
  /** The styles the lines may name (product.styles.view); null without the right. */
  readonly styles: { readonly items: readonly StyleOption[] | null; readonly problem: string | null } | null
  readonly details: Readonly<Record<string, StyleRead>>
  /** Files picked to add once the request is made (names only here; the container keeps the bytes). */
  readonly files: ReadonlyArray<{ readonly key: string; readonly name: string; readonly size: number; readonly problem: Phrase | null }>
  readonly detailsOpen: boolean
  /** The compose's fields whose problem shows: left once, or every one after Create was tried. */
  readonly shown: Partial<Record<ComposeField, true>>
  readonly tried: boolean
  /** The API refused a field of the compose (its words in the box). */
  readonly refused: Partial<Record<ComposeField, string>>
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
  /** The company numbers no request yet (known to who reads the numbering): Create waits with the reason. */
  readonly unnumbered: boolean
  /** Today in the site's zone (`YYYY-MM-DD`). */
  readonly today: string
  /** "Discard this request?" is asked (closing with typed text). */
  readonly leaving: boolean
}

export interface NewRequestActions {
  onDraft?: (patch: Partial<NewRequestDraft>) => void
  onCompose?: (field: ComposeField, value: string) => void
  onLeaveField?: (field: ComposeField) => void
  onDetails?: (open: boolean) => void
  onWho?: (who: Who) => void
  onCustomer?: (partyId: string | null) => void
  onRetryCustomers?: () => void
  onRetryShipTo?: () => void
  onStyle?: (styleId: string) => void
  onFiles?: (files: File[]) => void
  onRemoveFile?: (key: string) => void
  onSubmit?: () => void
  /** Close (asks first when something was typed). */
  onClose?: () => void
  onDiscard?: () => void
  onKeepWriting?: () => void
}

export function NewRequestDialog(props: { model: NewRequestModel; me: string; can: InquiriesCan; prefix: string; actions?: NewRequestActions }) {
  return (
    <WithMessages namespaces={[NEW_NS, COMPOSE_NS, 'ds-words']}>
      <Dialog {...props} />
    </WithMessages>
  )
}

const pick = <T,>(all: Partial<Record<ComposeField, T>>, keys: Partial<Record<ComposeField, true>>, every: boolean): Partial<Record<ComposeField, T>> =>
  Object.fromEntries(Object.entries(all).filter(([field]) => every || keys[field as ComposeField])) as Partial<Record<ComposeField, T>>

function Dialog({ model, me, can, prefix, actions }: { model: NewRequestModel; me: string; can: InquiriesCan; prefix: string; actions?: NewRequestActions }) {
  const { t, say, when, day } = useWords()
  const tn = useT(NEW_NS)
  const sayAny = (phrase: Phrase | null | undefined): string | null => (!phrase ? null : phrase.key.startsWith(`${NEW_NS}:`) ? tn(phrase.key.slice(NEW_NS.length + 1), phrase.params) : say(phrase))
  const draft = model.draft
  const set = (patch: Partial<NewRequestDraft>) => actions?.onDraft?.(patch)
  const mailDraft = model.mail?.draft.status === 'ready' ? model.mail.draft.value : null
  const taken = mailDraft?.refusal ?? null
  const heldPhrase: Phrase | null =
    model.mail && !mailDraft
      ? { key: n('held.mail') }
      : taken
        ? { key: `refusal.${taken.code}`, params: { number: mailDraft?.inquiry?.number ?? '' } }
        : newRequestHeld(draft, { can, offline: model.offline, busy: model.busy, fromMail: !!model.mail, unnumbered: model.unnumbered, today: model.today })
  const held = sayAny(heldPhrase)
  const submit = () => {
    if (!heldPhrase) actions?.onSubmit?.()
  }
  const latest = useRef({ heldPhrase, actions })
  latest.current = { heldPhrase, actions }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The message box sends ⌘↵ itself (and says so with preventDefault).
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.defaultPrevented && !latest.current.heldPhrase) {
        event.preventDefault()
        latest.current.actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showMail = !model.mail || mailDraft
  const compose: RequestComposeModel = {
    goesTo: null,
    draft: draft.compose,
    today: model.today,
    problems: { ...pick(composeProblems(draft, model.today), model.shown, model.tried), ...model.refused },
    shipTo: draft.who === 'customer' && draft.partyId ? model.shipTo : { state: 'none', choices: [] },
    detailsOpen: model.detailsOpen,
    kept: { state: 'none' },
    offline: model.offline,
    readOnly: false,
    sending: model.busy,
    sendHeld: held,
    failed: null,
    same: null,
    filesHeld: '',
    notice: null,
  }
  const voice = (key: string, params?: Readonly<Record<string, string | number>>): string | null => (OFFICE_VOICE.has(key) ? tn(`voice.${key}`, params) : null)

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="xxl"
      title={model.mail ? tn('fromMailTitle') : tn('title')}
      subtitle={model.mail ? (mailDraft ? tn('fromMailSubtitle', { from: mailDraft.mail.from.address ?? mailDraft.mail.from.name ?? '—', when: when(mailDraft.mail.receivedAt) }) : undefined) : tn('subtitle')}
      footer={
        <>
          <Checkbox checked={draft.assignToMe} onChange={(event) => set({ assignToMe: event.target.checked })} label={tn('toMe')} disabled={!me} />
          <span className="grow" />
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            <Plus size={14} aria-hidden /> {model.busy ? tn('working') : tn('go')}
          </Button>
        </>
      }
    >
      <div className="fw-inqn">
        {model.leaving && (
          <Banner
            tone="warning"
            title={tn('leave.title')}
            action={
              <span className="fw-inqn-inline">
                <Button size="sm" variant="secondary" onClick={() => actions?.onKeepWriting?.()} autoFocus>
                  {tn('leave.keep')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => actions?.onDiscard?.()}>
                  {tn('leave.discard')}
                </Button>
              </span>
            }
          >
            {tn('leave.body')}
          </Banner>
        )}
        <NoticeLine notice={model.notice} />
        {model.mail && model.mail.draft.status === 'loading' && <Skeleton height={80} />}
        {model.mail && model.mail.draft.status === 'error' && <Banner tone="danger" title={tn('mail.failed')}>{t(model.mail.draft.problem)}</Banner>}
        {model.mail && (model.mail.draft.status === 'notFound' || model.mail.draft.status === 'forbidden') && <Banner tone="danger" title={tn('mail.gone')} />}
        {taken && mailDraft?.inquiry && (
          <Banner
            tone="info"
            title={t('refusal.MAIL_TAKEN', { number: mailDraft.inquiry.number })}
            action={
              <Button size="sm" variant="quiet" asChild>
                <Link href={recordHref(prefix, mailDraft.inquiry.id)}>{tn('mail.openMade', { number: mailDraft.inquiry.number })}</Link>
              </Button>
            }
          />
        )}
        {mailDraft && (
          <Banner tone="info" title={mailDraft.party ? tn(mailDraft.matchedBy === 'DOMAIN' ? 'mail.domain' : 'mail.contact', { name: `${mailDraft.party.code} · ${mailDraft.party.name}` }) : tn('mail.prospect')}>
            <KeyValue
              items={[
                { label: tn('mail.subject'), value: mailDraft.mail.subject ?? '—' },
                { label: tn('mail.from'), value: mailDraft.mail.from.address ?? '—' },
              ]}
              labelCase="sentence"
            />
          </Banner>
        )}
        {showMail && (
          <RequestCompose
            model={compose}
            words={{ day, label: voice }}
            actions={{
              onChange: (field, value) => actions?.onCompose?.(field, value),
              onLeave: (field) => actions?.onLeaveField?.(field),
              onDetails: (open) => actions?.onDetails?.(open),
              onSend: submit,
              onRetryShipTo: actions?.onRetryShipTo,
            }}
            to={<FromBlock model={model} fromMail={!!model.mail} actions={actions} />}
            slots={{
              plain: true,
              files: <FilesBlock model={model} mail={mailDraft} can={can} actions={actions} />,
              details: <OfficeDetails model={model} can={can} actions={actions} />,
            }}
          />
        )}
      </div>
    </Modal>
  )
}

/** The compose's To place in the office: how it came, and who asks — a customer of the reader's, or a prospect. */
function FromBlock({ model, fromMail, actions }: { model: NewRequestModel; fromMail: boolean; actions?: NewRequestActions }) {
  const { t } = useWords()
  const tn = useT(NEW_NS)
  const draft = model.draft
  const set = (patch: Partial<NewRequestDraft>) => actions?.onDraft?.(patch)
  const pickId = useId()
  const customers = model.customers
  const options = customers.items.map((customer) => ({ value: customer.id, label: `${customer.code} · ${customer.tradeName ?? customer.legalName}` }))
  const pickHint =
    customers.state === 'ready' && customers.items.length === 0
      ? tn('from.pickNone')
      : customers.total > customers.items.length
        ? tn('from.pickMore', { shown: customers.items.length, count: customers.total })
        : customers.limited && customers.state === 'ready'
          ? tn('from.pickLimited', { count: customers.total })
          : null
  const match = draft.who === 'prospect' ? prospectMatch(draft.prospect, customers.items) : null
  const matchName = match ? (match.tradeName ?? match.legalName) : ''

  return (
    <fieldset className="fw-inqn-from">
      <legend className="fw-inqn-legend">{tn('from.label')}</legend>
      <div className="fw-inqn-who">
        {!fromMail && (
          <Field label={tn('from.source')} className="fw-inqn-source">
            <Select value={draft.source} onChange={(event) => set({ source: event.target.value as NewRequestDraft['source'] })}>
              {TYPED_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`source.${source}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="fw-inqn-cards" role="radiogroup" aria-label={tn('from.who')}>
          <RadioCard name="inq-new-who" value="customer" checked={draft.who === 'customer'} selected={draft.who === 'customer'} onChange={() => actions?.onWho?.('customer')} title={tn('from.customer')} description={tn('from.customerHint')} disabled={customers.state === 'none'} />
          <RadioCard name="inq-new-who" value="prospect" checked={draft.who === 'prospect'} selected={draft.who === 'prospect'} onChange={() => actions?.onWho?.('prospect')} title={tn('from.prospect')} description={tn('from.prospectHint')} />
        </div>
      </div>
      {draft.who === 'customer' ? (
        <div className="fw-inqn-grid">
          <div className="nds-field-w">
            <span className="nds-field-lbl" id={pickId}>
              {tn('from.pick')}
              <span className="req" aria-hidden>
                *
              </span>
            </span>
            {customers.state === 'loading' ? (
              <span className="fw-inqn-reading" role="status">
                <Skeleton height={32} />
                <span className="fw-inqn-hint">{tn('from.pickReading')}</span>
              </span>
            ) : customers.state === 'error' ? (
              <span className="fw-inqn-inline" role="alert">
                {tn('from.pickFailed')}
                <Button size="sm" onClick={() => actions?.onRetryCustomers?.()}>
                  {tn('from.pickRetry')}
                </Button>
              </span>
            ) : (
              <Combobox options={options} value={draft.partyId ?? ''} placeholder={tn('from.pickPlaceholder')} labelledBy={pickId} onChange={(value) => actions?.onCustomer?.(value || null)} />
            )}
            {pickHint && <span className="nds-field-hint">{pickHint}</span>}
          </div>
          <Field label={tn('from.contact')} hint={model.contacts?.problem ? tn('from.contactsFailed') : tn('from.contactHint')}>
            {draft.partyId && model.contacts && model.contacts.items === null && !model.contacts.problem ? (
              <Skeleton height={32} />
            ) : (
              <Select value={draft.contactId ?? ''} disabled={!draft.partyId} onChange={(event) => set({ contactId: event.target.value || null })}>
                <option value="">{tn('from.noContact')}</option>
                {(model.contacts?.items ?? []).map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.email ? `${contact.name} · ${contact.email}` : contact.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : (
        <div className="fw-inqn-stack">
          <div className="fw-inqn-grid fw-inqn-grid-4">
            {(['company', 'name', 'email', 'phone'] as const).map((field) => (
              <Field key={field} label={t(`prospect.${field}`)}>
                <Input
                  value={draft.prospect[field]}
                  type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
                  autoComplete="off"
                  maxLength={field === 'email' ? 254 : field === 'phone' ? 40 : 200}
                  onChange={(event) => set({ prospect: { ...draft.prospect, [field]: event.target.value } })}
                />
              </Field>
            ))}
          </div>
          {match && (
            <Banner
              tone="info"
              title={tn('from.match', { name: matchName })}
              action={
                <Button size="sm" onClick={() => actions?.onCustomer?.(match.id)}>
                  {tn('from.matchUse', { name: matchName })}
                </Button>
              }
            >
              {tn('from.matchBody')}
            </Banner>
          )}
          <Field label={tn('from.basis')} hint={tn('from.basisWhy')} required error={draft.lawfulBasis === null && model.tried ? tn('held.basis') : undefined}>
            <Select value={draft.lawfulBasis ?? ''} onChange={(event) => set({ lawfulBasis: (event.target.value || null) as NewRequestDraft['lawfulBasis'] })}>
              <option value="">{tn('from.basisChoose')}</option>
              {LAWFUL_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`basis.${basis}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </fieldset>
  )
}

/** The files: office uploads on a typed request (office only), the mail's attachments as the tech pack on one from a mail. */
function FilesBlock({ model, mail, can, actions }: { model: NewRequestModel; mail: MailDraft | null; can: InquiriesCan; actions?: NewRequestActions }) {
  const { say } = useWords()
  const tn = useT(NEW_NS)
  const draft = model.draft
  const set = (patch: Partial<NewRequestDraft>) => actions?.onDraft?.(patch)
  if (model.mail) {
    if (!mail) return null
    return (
      <div className="fw-inqn-stack" role="group" aria-label={tn('files.fromMail')}>
        <span className="fw-inqn-title">{tn('files.fromMail')}</span>
        {mail.attachments.length > 0 ? (
          <>
            <span className="fw-inqn-hint">{tn('files.fromMailHint')}</span>
            <div className="fw-inqn-files">
              {mail.attachments.map((file) => (
                <FileRow
                  key={file.id}
                  name={file.originalName}
                  size={file.sizeBytes}
                  actions={
                    <Checkbox
                      checked={draft.techPackFileIds.includes(file.id)}
                      onChange={(event) => set({ techPackFileIds: event.target.checked ? [...draft.techPackFileIds, file.id] : draft.techPackFileIds.filter((id) => id !== file.id) })}
                      label={tn('files.inPack')}
                    />
                  }
                />
              ))}
            </div>
            <Field label={tn('files.packVersion')} hint={tn('files.packVersionHint')}>
              <Input value={draft.techPackVersion} maxLength={100} onChange={(event) => set({ techPackVersion: event.target.value })} />
            </Field>
          </>
        ) : null}
        <span className="fw-inqn-hint">
          <Inbox size={13} aria-hidden /> {tn('files.mailStays')}
        </span>
      </div>
    )
  }
  return (
    <div className="fw-inqn-stack" role="group" aria-label={tn('files.title')}>
      <span className="fw-inqn-title">{tn('files.title')}</span>
      {can.upload ? <FileDropzone multiple onFiles={(files) => actions?.onFiles?.(files)} hint={tn('files.hint')} /> : <span className="fw-inqn-hint">{tn('files.noRight')}</span>}
      {model.files.length > 0 && (
        <div className="fw-inqn-files">
          {model.files.map((file) => (
            <FileRow key={file.key} name={file.name} size={file.size} status={file.problem ? (say(file.problem) ?? undefined) : tn('files.later')} tone={file.problem ? 'danger' : 'neutral'} onRemove={() => actions?.onRemoveFile?.(file.key)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Inside "Add details (optional)": the target price (a price: only with the price grain) and the lines asked. */
function OfficeDetails({ model, can, actions }: { model: NewRequestModel; can: InquiriesCan; actions?: NewRequestActions }) {
  const { t } = useWords()
  const tn = useT(NEW_NS)
  const draft = model.draft
  const set = (patch: Partial<NewRequestDraft>) => actions?.onDraft?.(patch)
  const styles = model.styles ? { items: stylesFor(model.styles.items, draft.who, draft.partyId), problem: model.styles.problem } : null
  return (
    <div className="fw-inqn-stack fw-inqn-office" role="group" aria-label={tn('office.title')}>
      <span className="fw-inqn-title">{tn('office.title')}</span>
      {can.price && (
        <Field label={t('request.target')} hint={t('request.targetHint')} className="fw-inqn-target">
          <span className="fw-inqn-inline">
            <Input inputMode="decimal" aria-label={t('request.target')} value={draft.targetPrice} onChange={(event) => set({ targetPrice: event.target.value })} />
            <Select aria-label={t('request.currency')} value={draft.currency} onChange={(event) => set({ currency: event.target.value })}>
              {[...new Set([...CURRENCIES, draft.currency])].map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </Select>
          </span>
        </Field>
      )}
      <span className="fw-inqn-title">{t('request.lines')}</span>
      <span className="fw-inqn-hint">{tn('office.linesHint')}</span>
      <LinesEditor model={{ lines: draft.lines, styles, details: model.details }} actions={{ onLines: (lines) => set({ lines }), onStyle: actions?.onStyle }} />
    </div>
  )
}

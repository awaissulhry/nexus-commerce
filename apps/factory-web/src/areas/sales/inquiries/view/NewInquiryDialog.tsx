'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Inbox, Plus } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, FileDropzone, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { ContactOption, MailDraft, PartyOption, StyleOption } from '../api'
import { CURRENCIES, newDraftHeld, recordHref, TYPED_SOURCES, type InquiriesCan, type Loaded, type NewDraft, type Notice, type Phrase } from '../model'
import { NoticeLine, useWords } from '../parts'
import { LinesEditor, type StyleRead } from './LinesEditor'

export interface NewInquiryModel {
  readonly draft: NewDraft
  /** "Make an inquiry" from a mail of Mail to sort: its draft as the API read it; null for a typed one. */
  readonly mail: { readonly id: string; readonly draft: Loaded<MailDraft> } | null
  readonly customers: { readonly items: readonly PartyOption[] | null; readonly problem: string | null } | null
  readonly contacts: { readonly items: readonly ContactOption[] | null; readonly problem: string | null } | null
  readonly styles: { readonly items: readonly StyleOption[] | null; readonly problem: string | null } | null
  readonly details: Readonly<Record<string, StyleRead>>
  /** Files picked to add once the inquiry is made (names only here; the container keeps the bytes). */
  readonly files: ReadonlyArray<{ readonly key: string; readonly name: string; readonly size: number; readonly problem: Phrase | null }>
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface NewInquiryActions {
  onDraft?: (patch: Partial<NewDraft>) => void
  onCustomer?: (partyId: string | null) => void
  onStyle?: (styleId: string) => void
  onFiles?: (files: File[]) => void
  onRemoveFile?: (key: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * New inquiry (design pop:inquiries.new; the band's button, `c`, `?new=1`): how it came (phone, visit at the office, a fair,
 * a portal request recorded by hand), the customer and contact or a new prospect (lawful basis: a request for a quote), what
 * they ask in words, the styles and quantities by size (optional), the target price (a price) and date, files, and "give it to
 * me". `?mail=<id>` is "Make an inquiry" from a mail: the sender as the customer Nexus knows (or a prospect), the mail's words,
 * its attachments to name as the tech pack; a mail already made into one says so. ⌘↵ creates it.
 */
export function NewInquiryDialog({ model, me, can, prefix, actions }: { model: NewInquiryModel; me: string; can: InquiriesCan; prefix: string; actions?: NewInquiryActions }) {
  const { t, say, when } = useWords()
  const draft = model.draft
  const set = (patch: Partial<NewDraft>) => actions?.onDraft?.(patch)
  const mailDraft = model.mail?.draft.status === 'ready' ? model.mail.draft.value : null
  const taken = mailDraft?.refusal ?? null
  const heldPhrase = model.busy ? { key: 'common.working' } : model.mail && !mailDraft ? { key: 'new.held.mail' } : taken ? { key: `refusal.${taken.code}`, params: { number: mailDraft?.inquiry?.number ?? '' } } : newDraftHeld(draft, can, model.offline, !!model.mail)
  const held = say(heldPhrase)
  const submit = () => {
    if (!heldPhrase) actions?.onSubmit?.()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !heldPhrase) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [heldPhrase, actions])

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="xl"
      title={model.mail ? t('new.fromMailTitle') : t('new.title')}
      subtitle={model.mail ? (mailDraft ? t('new.fromMailSubtitle', { from: mailDraft.mail.from.address ?? mailDraft.mail.from.name ?? '—', when: when(mailDraft.mail.receivedAt) }) : undefined) : t('new.subtitle')}
      footer={
        <span className="fw-inq-buttons">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <Plus size={14} aria-hidden /> {t('new.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        {model.mail && model.mail.draft.status === 'loading' && <Skeleton height={80} />}
        {model.mail && model.mail.draft.status === 'error' && <Banner tone="danger" title={t('new.mailFailed')}>{t(model.mail.draft.problem)}</Banner>}
        {model.mail && (model.mail.draft.status === 'notFound' || model.mail.draft.status === 'forbidden') && <Banner tone="danger" title={t('new.mailGone')} />}
        {taken && mailDraft?.inquiry && (
          <Banner
            tone="info"
            title={t('refusal.MAIL_TAKEN', { number: mailDraft.inquiry.number })}
            action={
              <Button size="sm" variant="quiet" asChild>
                <Link href={recordHref(prefix, mailDraft.inquiry.id)}>{t('new.openMade', { number: mailDraft.inquiry.number })}</Link>
              </Button>
            }
          />
        )}
        {mailDraft && (
          <Banner tone="info" title={mailDraft.party ? t(mailDraft.matchedBy === 'DOMAIN' ? 'new.mailDomain' : 'new.mailContact', { name: `${mailDraft.party.code} · ${mailDraft.party.name}` }) : t('new.mailProspect')}>
            <KeyValue
              items={[
                { label: t('mail.subject'), value: mailDraft.mail.subject ?? '—' },
                { label: t('mail.from'), value: mailDraft.mail.from.address ?? '—' },
              ]}
              labelCase="sentence"
            />
          </Banner>
        )}
        {(!model.mail || mailDraft) && (
          <>
            <div className="fw-inq-two">
              <div className="fw-inq-stack">
                {!model.mail && (
                  <Field label={t('new.source')}>
                    <Select size="sm" value={draft.source} onChange={(event) => set({ source: event.target.value as NewDraft['source'] })}>
                      {TYPED_SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {t(`source.${source}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <fieldset className="fw-inq-stack">
                  <legend className="fw-inq-h3">{t('new.who')}</legend>
                  <div className="fw-inq-form-grid">
                    <RadioCard name="inq-who" value="customer" checked={draft.who === 'customer'} selected={draft.who === 'customer'} onChange={() => set({ who: 'customer' })} title={t('new.whoCustomer')} description={t('new.whoCustomerHint')} disabled={!model.customers} />
                    <RadioCard name="inq-who" value="prospect" checked={draft.who === 'prospect'} selected={draft.who === 'prospect'} onChange={() => set({ who: 'prospect' })} title={t('new.whoProspect')} description={t('new.whoProspectHint')} />
                  </div>
                </fieldset>
                {draft.who === 'customer' ? (
                  <div className="fw-inq-form-grid">
                    <Field label={t('who.customer')} hint={model.customers ? undefined : t('new.noCustomersRight')}>
                      {model.customers && model.customers.items === null && !model.customers.problem ? (
                        <Skeleton height={32} />
                      ) : (
                        <Select size="sm" value={draft.partyId ?? ''} onChange={(event) => actions?.onCustomer?.(event.target.value || null)}>
                          <option value="">{t('new.pickCustomer')}</option>
                          {(model.customers?.items ?? []).map((party) => (
                            <option key={party.id} value={party.id}>
                              {party.code} · {party.tradeName ?? party.legalName}
                            </option>
                          ))}
                          {mailDraft?.party && !(model.customers?.items ?? []).some((party) => party.id === mailDraft.party!.id) && <option value={mailDraft.party.id}>{`${mailDraft.party.code} · ${mailDraft.party.name}`}</option>}
                        </Select>
                      )}
                    </Field>
                    <Field label={t('who.contact')}>
                      {draft.partyId && model.contacts && model.contacts.items === null && !model.contacts.problem ? (
                        <Skeleton height={32} />
                      ) : (
                        <Select size="sm" value={draft.contactId ?? ''} disabled={!draft.partyId} onChange={(event) => set({ contactId: event.target.value || null })}>
                          <option value="">{t('who.noContact')}</option>
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
                  <div className="fw-inq-form-grid">
                    {(['company', 'name', 'email', 'phone'] as const).map((field) => (
                      <Field key={field} label={t(`prospect.${field}`)}>
                        <Input size="sm" value={draft.prospect[field]} maxLength={field === 'email' ? 254 : field === 'phone' ? 40 : 200} onChange={(event) => set({ prospect: { ...draft.prospect, [field]: event.target.value } })} />
                      </Field>
                    ))}
                    <p className="fw-inq-hint fw-inq-wide">{t('new.prospectBasis')}</p>
                  </div>
                )}
              </div>
              <div className="fw-inq-stack">
                <Field label={t('request.request')} hint={model.mail ? t('new.requestFromMail') : t('new.requestHint')}>
                  <Textarea value={draft.request} rows={6} honourRows maxLength={20000} onChange={(event) => set({ request: event.target.value })} />
                </Field>
                <div className="fw-inq-form-grid">
                  {can.price && (
                    <Field label={t('request.target')} hint={t('request.targetHint')}>
                      <span className="fw-inq-row">
                        <Input size="sm" inputMode="decimal" aria-label={t('request.target')} value={draft.targetPrice} onChange={(event) => set({ targetPrice: event.target.value })} />
                        <Select size="sm" aria-label={t('request.currency')} value={draft.currency} onChange={(event) => set({ currency: event.target.value })}>
                          {[...new Set([...CURRENCIES, draft.currency])].map((currency) => (
                            <option key={currency} value={currency}>
                              {currency}
                            </option>
                          ))}
                        </Select>
                      </span>
                    </Field>
                  )}
                  <Field label={t('request.wanted')}>
                    <DateField value={draft.wantedDate ?? ''} clearable onChange={(value) => set({ wantedDate: value || null })} />
                  </Field>
                </div>
                <Checkbox checked={draft.assignToMe} onChange={(event) => set({ assignToMe: event.target.checked })} label={t('new.toMe')} disabled={!me} />
              </div>
            </div>
            <div className="fw-inq-stack">
              <h3 className="fw-inq-h3">{t('request.lines')}</h3>
              <LinesEditor model={{ lines: draft.lines, styles: model.styles, details: model.details }} actions={{ onLines: (lines) => set({ lines }), onStyle: actions?.onStyle }} />
            </div>
            {mailDraft && mailDraft.attachments.length > 0 ? (
              <div className="fw-inq-stack">
                <h3 className="fw-inq-h3">{t('new.attachments')}</h3>
                <div className="fw-inq-files">
                  {mailDraft.attachments.map((file) => (
                    <FileRow
                      key={file.id}
                      name={file.originalName}
                      size={file.sizeBytes}
                      status={t('files.fromMail')}
                      actions={
                        <Checkbox
                          checked={draft.techPackFileIds.includes(file.id)}
                          onChange={(event) => set({ techPackFileIds: event.target.checked ? [...draft.techPackFileIds, file.id] : draft.techPackFileIds.filter((id) => id !== file.id) })}
                          label={t('pack.inPack')}
                        />
                      }
                    />
                  ))}
                </div>
                <Field label={t('pack.version')} hint={t('pack.versionHint')}>
                  <Input size="sm" value={draft.techPackVersion} maxLength={100} onChange={(event) => set({ techPackVersion: event.target.value })} />
                </Field>
              </div>
            ) : null}
            {!model.mail && (
              <div className="fw-inq-stack">
                <h3 className="fw-inq-h3">{t('new.files')}</h3>
                {can.upload ? (
                  <FileDropzone multiple onFiles={(files) => actions?.onFiles?.(files)} hint={t('new.filesHint')} />
                ) : (
                  <p className="fw-inq-hint">{t('new.filesNoRight')}</p>
                )}
                {model.files.length > 0 && (
                  <div className="fw-inq-files">
                    {model.files.map((file) => (
                      <FileRow key={file.key} name={file.name} size={file.size} status={file.problem ? (say(file.problem) ?? undefined) : t('new.fileLater')} tone={file.problem ? 'danger' : 'neutral'} onRemove={() => actions?.onRemoveFile?.(file.key)} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {model.mail && (
              <p className="fw-inq-hint">
                <Inbox size={13} aria-hidden /> {t('new.mailStays')}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

'use client'

import { SHARE_NOTE_MAX } from '@nexus/factory-domain/shares/rules'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { LOCALE_NAMES, LOCALES } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { dayOf, latestUntil, SHARES_NS, type SharesPanelActions, type SharesPanelModel } from '../model'

/**
 * "Share with a partner" (B-W2b-200; COL-061, COL-062): whom — a contact of the record's partner on file, or another
 * address of theirs (an agent, a brand's designer, a lab) —, what they may do (read always; write messages; upload files),
 * until which day (30 days by default, at most 180), a few words for the mail, and how it reaches them: by e-mail, or a link
 * given ONCE to pass on, in their language. They see only this record's shared fields, its shared files and its thread; no
 * account is made. Each field says its problem when Invite is pressed; the API's refusal comes back at its field.
 */
export function InviteDialog({ model, actions }: { model: SharesPanelModel; actions?: SharesPanelActions }) {
  const t = useT(SHARES_NS)
  const locale = useLocale()
  const invite = model.invite!
  const draft = invite.draft
  const data = model.read.status === 'ready' ? model.read.data : null
  const contacts = data?.contacts ?? []
  const now = model.now ?? Date.now()
  const problem = (field: keyof typeof invite.problems) => (invite.problems[field] ? t(invite.problems[field]!, { max: SHARE_NOTE_MAX }) : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onInvite?.(false)}
      title={t('invite.title')}
      subtitle={data ? t('invite.to', { reference: data.record.reference, partner: data.party?.name ?? '' }) : undefined}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onInvite?.(false)}>{t('invite.cancel')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onSend?.()}>
            {t(draft.send ? 'invite.goMail' : 'invite.goLink')}
          </Button>
        </>
      }
    >
      <div className="fw-rsh-dialog">
        {invite.problem && <Banner tone="danger" title={t(invite.problem)} />}
        <p className="fw-rsh-muted">{t('invite.intro')}</p>
        <fieldset className="fw-rsh-fieldset">
          <legend className="fw-rsh-legend">{t('invite.who')}</legend>
          <div className="fw-rsh-choices">
            <RadioCard name="fw-rsh-to" checked={draft.to === 'contact'} selected={draft.to === 'contact'} disabled={contacts.length === 0} onChange={() => actions?.onDraft?.({ to: 'contact' })} title={t('invite.toContact')} description={contacts.length === 0 ? t('invite.noContacts') : t('invite.toContactBody')} />
            <RadioCard name="fw-rsh-to" checked={draft.to === 'email'} selected={draft.to === 'email'} onChange={() => actions?.onDraft?.({ to: 'email' })} title={t('invite.toEmail')} description={t('invite.toEmailBody')} />
          </div>
          {draft.to === 'contact' ? (
            <Field label={t('invite.contact')} error={problem('to')} required>
              <Select value={draft.contactId} onChange={(event) => actions?.onDraft?.({ contactId: event.target.value })}>
                <option value="">{t('invite.contactPick')}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name} · {contact.email}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={t('invite.email')} hint={t('invite.emailHint', { partner: data?.party?.name ?? '' })} error={problem('email')} required>
              <Input type="email" inputMode="email" value={draft.email} onChange={(event) => actions?.onDraft?.({ email: event.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
          )}
        </fieldset>
        <fieldset className="fw-rsh-fieldset">
          <legend className="fw-rsh-legend">{t('invite.may')}</legend>
          <Checkbox label={t('may.VIEW')} checked disabled aria-describedby="fw-rsh-invite-view" />
          <p id="fw-rsh-invite-view" className="fw-rsh-muted">
            {t('invite.viewAlways')}
          </p>
          <Checkbox label={t('may.COMMENT')} checked={draft.comment} onChange={(event) => actions?.onDraft?.({ comment: event.currentTarget.checked })} />
          <Checkbox label={t('may.UPLOAD')} checked={draft.upload} onChange={(event) => actions?.onDraft?.({ upload: event.currentTarget.checked })} />
        </fieldset>
        <Field label={t('invite.until')} hint={t('invite.untilHint')} error={problem('until')} required>
          <DateField value={draft.until} min={dayOf(now)} max={latestUntil(now)} onChange={(value) => actions?.onDraft?.({ until: value })} ariaLabel={t('invite.until')} locale={locale === 'it' ? 'it-IT' : 'en-GB'} />
        </Field>
        <Field label={t('invite.note')} hint={t('invite.noteHint')} error={problem('note')}>
          <Textarea value={draft.note} rows={3} limit={SHARE_NOTE_MAX} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
        <fieldset className="fw-rsh-fieldset">
          <legend className="fw-rsh-legend">{t('invite.how')}</legend>
          <div className="fw-rsh-choices">
            <RadioCard name="fw-rsh-send" checked={draft.send} selected={draft.send} onChange={() => actions?.onDraft?.({ send: true })} title={t('invite.mail')} description={t('invite.mailBody')} />
            <RadioCard name="fw-rsh-send" checked={!draft.send} selected={!draft.send} onChange={() => actions?.onDraft?.({ send: false })} title={t('invite.link')} description={t('invite.linkBody')} />
          </div>
        </fieldset>
        <Field label={t('invite.language')} hint={t('invite.languageHint')}>
          <Select value={draft.language} onChange={(event) => actions?.onDraft?.({ language: event.target.value as '' | 'it' | 'en' })}>
            <option value="">{t('invite.languageParty')}</option>
            {LOCALES.map((option) => (
              <option key={option} value={option} lang={option}>
                {LOCALE_NAMES[option]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

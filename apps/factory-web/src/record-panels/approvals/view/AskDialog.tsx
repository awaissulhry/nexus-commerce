'use client'

import { KIND_RULES, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateTimeField, Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { LOCALE_NAMES, LOCALES } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { ASK_LIMITS, latestDueAt, type ApprovalsPanelActions, type ApprovalsPanelModel } from '../model'

/**
 * "Ask a partner to approve" (B-W2b-188; COL-064): what to approve (the kinds this record takes), the question in our
 * words (the first thing the partner reads), by when (the kind's default; at most its limit), the record's files that go
 * with it (a copy, shared with that partner only; a sample, colour, leather, artwork or proof needs at least one), and
 * how it reaches them — by e-mail to an address, or a link given ONCE to pass on — in their language. Each field says its
 * problem when Ask is pressed; the API's refusal comes back at its field.
 */
export function AskDialog({ model, actions }: { model: ApprovalsPanelModel; actions?: ApprovalsPanelActions }) {
  const t = useT('record-approvals')
  const locale = useLocale()
  const ask = model.ask!
  const draft = ask.draft
  const kinds: readonly ApprovalKind[] = model.read.status === 'ready' ? model.read.kinds : [draft.kind]
  const rule = KIND_RULES[draft.kind]
  const now = model.now ?? Date.now()
  const problem = (field: keyof typeof ask.problems) => (ask.problems[field] ? t(ask.problems[field]!, { days: rule.dueDays.max }) : undefined)
  const files = model.files
  const toggle = (fileId: string, on: boolean) => actions?.onDraft?.({ fileIds: on ? [...draft.fileIds.filter((id) => id !== fileId), fileId] : draft.fileIds.filter((id) => id !== fileId) })
  return (
    <Modal
      open
      onClose={() => actions?.onAsk?.(false)}
      title={t('ask.title')}
      subtitle={model.party ? t('ask.to', { partner: model.party.name }) : undefined}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onAsk?.(false)}>{t('ask.cancel')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onSend?.()}>
            {t(draft.send ? 'ask.goMail' : 'ask.goLink')}
          </Button>
        </>
      }
    >
      <div className="fw-ra-dialog">
        {ask.problem && <Banner tone="danger" title={t(ask.problem)} />}
        <Field label={t('ask.kind')} hint={t(`ask.kindHint.${draft.kind}`)} error={problem('kind')}>
          <Select value={draft.kind} onChange={(event) => actions?.onDraft?.({ kind: event.target.value as ApprovalKind })}>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_RULES[kind].name[locale]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('ask.question')} hint={t('ask.questionHint')} error={problem('question')} required>
          <Textarea value={draft.question} rows={4} limit={ASK_LIMITS.question} onChange={(event) => actions?.onDraft?.({ question: event.target.value })} />
        </Field>
        <Field label={t('ask.due')} hint={t('ask.dueHint', { days: rule.dueDays.max })} error={problem('dueAt')} required>
          <DateTimeField value={draft.dueAt} onChange={(value) => actions?.onDraft?.({ dueAt: value })} min={new Date(now + ASK_LIMITS.minAheadMs).toISOString()} max={latestDueAt(draft.kind, now)} defaultTime="17:00" ariaLabel={t('ask.due')} locale={locale === 'it' ? 'it-IT' : 'en-GB'} />
        </Field>
        <fieldset className="fw-ra-fieldset">
          <legend className="fw-ra-legend">{t(rule.needsFiles ? 'ask.filesNeeded' : 'ask.files')}</legend>
          <p className="fw-ra-muted">{t('ask.filesHint')}</p>
          {files === null ? (
            <p className="fw-ra-muted" role="status">
              {t('ask.filesLoading')}
            </p>
          ) : files.length === 0 ? (
            <p className="fw-ra-muted">{t(rule.needsFiles ? 'ask.filesNoneNeeded' : 'ask.filesNone')}</p>
          ) : (
            <ul className="fw-ra-files">
              {files.map((file) => (
                <li key={file.id}>
                  <Checkbox label={file.name} checked={draft.fileIds.includes(file.id)} onChange={(event) => toggle(file.id, event.currentTarget.checked)} />
                </li>
              ))}
            </ul>
          )}
          {problem('fileIds') && (
            <p className="fw-ra-error" role="alert">
              {problem('fileIds')}
            </p>
          )}
        </fieldset>
        <fieldset className="fw-ra-fieldset">
          <legend className="fw-ra-legend">{t('ask.how')}</legend>
          <div className="fw-ra-choices">
            <RadioCard name="fw-ra-send" checked={draft.send} selected={draft.send} onChange={() => actions?.onDraft?.({ send: true })} title={t('ask.mail')} description={t('ask.mailBody')} />
            <RadioCard name="fw-ra-send" checked={!draft.send} selected={!draft.send} onChange={() => actions?.onDraft?.({ send: false })} title={t('ask.link')} description={t('ask.linkBody')} />
          </div>
          {draft.send && (
            <Field label={t('ask.email')} hint={model.party && model.party.emails.length > 0 ? t('ask.emailKnown', { emails: model.party.emails.join(', ') }) : t('ask.emailHint')} error={problem('email')} required>
              <Input type="email" inputMode="email" value={draft.email} onChange={(event) => actions?.onDraft?.({ email: event.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
          )}
        </fieldset>
        <Field label={t('ask.language')} hint={t('ask.languageHint')}>
          <Select value={draft.language} onChange={(event) => actions?.onDraft?.({ language: event.target.value as '' | 'it' | 'en' })}>
            <option value="">{t('ask.languageParty')}</option>
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

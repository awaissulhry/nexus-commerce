'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Lock, Paperclip, WifiOff } from 'lucide-react'
import { Banner, Card, Disclosure, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../i18n/ds-parts'
import { useT } from '../../i18n/provider'
import { COMPOSE_LIMITS, COMPOSE_NS, counterLimit, detailsSummary, subjectUsed, type ComposeDraft, type ComposeField, type ShipToChoice } from '../model'
import '../request-compose.css'

/**
 * The request written like an e-mail (B-TH-220; threads plan P-CUS-NEW head, message, files, details, send — pictures 18–19
 * drawn to the approved look, "comfortable" density in the portal): ONE fixed line "Goes to: Sales at <company>" (text, no
 * picker, no To field: the portal's session is one company — the office's New request puts its customer picker in `to`),
 * the subject (optional: the first line is used), the message in the writer's own words and language (plain text, a counter
 * near the end), the files' place held with the API's own sentence until the virus scanner runs, "Add details (optional)"
 * folded (their PO, the day wanted, one of their own delivery addresses), and Send at the foot (sticky on a phone) with
 * Discard draft. Draws one view model and fetches nothing; the side column (`aside`) fills the width from 1280 px.
 */

export interface RequestComposeModel {
  /** "Sales at <company>": the fixed recipient line (null when `to` draws the office's picker instead). */
  goesTo: string | null
  draft: ComposeDraft
  /** Today in the site's zone: the earliest day wanted. */
  today: string
  /** Field → a key of `request-compose` (shown after a Send was tried, a field was left, or the API refused it). */
  problems: Partial<Record<ComposeField, string>>
  /** Their delivery addresses: `none` = not part of their access (the field is not drawn). */
  shipTo: { state: 'loading' | 'error' | 'ready' | 'none'; choices: readonly ShipToChoice[] }
  detailsOpen: boolean
  /** The draft on this device: kept (when, written), the device refused it, or nothing kept yet. */
  kept: { state: 'kept'; at: string } | { state: 'failed' } | { state: 'none' }
  offline: boolean
  /** Read-only (an office person previewing the portal): the fields do not change. */
  readOnly: boolean
  sending: boolean
  /** Send's held reason in words, or null. */
  sendHeld: string | null
  /** The last send failed, in words (the text stays). */
  failed: string | null
  /** The same words went from this device a moment ago: when and as which request (P-CUS-NEW.send-F02). */
  same: { at: string; yours: string | null } | null
  /** Where files would go: the API's own sentence while uploads from outside are closed (TH-7 opens them). */
  filesHeld: string
  /** A line about what changed the draft (a style from the catalogue added), or null. */
  notice: string | null
}

export interface RequestComposeActions {
  onChange?: (field: ComposeField, value: string) => void
  onLeave?: (field: ComposeField) => void
  onDetails?: (open: boolean) => void
  onSend?: () => void
  onSendAnyway?: () => void
  onDiscard?: () => void
  onRetryKeep?: () => void
  onRetryShipTo?: () => void
  onDismissNotice?: () => void
}

export interface RequestComposeWords {
  /** A calendar day (`YYYY-MM-DD`) in the page's language. */
  day: (iso: string) => string
}

export function RequestCompose({ model, actions, words, to, aside, below }: { model: RequestComposeModel; actions?: RequestComposeActions; words: RequestComposeWords; to?: ReactNode; aside?: ReactNode; below?: ReactNode }) {
  const t = useT(COMPOSE_NS)
  const draft = model.draft
  const held = model.readOnly
  const change = (field: ComposeField) => (value: string) => actions?.onChange?.(field, value)
  const problem = (field: ComposeField) => (model.problems[field] ? t(model.problems[field]!, { max: field === 'customerRef' ? COMPOSE_LIMITS.customerRef : COMPOSE_LIMITS.message }) : undefined)
  const summary = detailsSummary(draft, model.shipTo.choices, { t, day: words.day })
  const limit = counterLimit(draft)
  const subject = subjectUsed(draft)
  const keptLine =
    model.offline ? (
      <span className="fw-rqc-kept is-warning">
        <WifiOff size={14} aria-hidden /> {t('kept.offline')}
      </span>
    ) : model.kept.state === 'kept' ? (
      <span className="fw-rqc-kept">{t('kept.at', { time: model.kept.at })}</span>
    ) : model.kept.state === 'failed' ? (
      <span className="fw-rqc-kept is-warning">
        <AlertTriangle size={14} aria-hidden /> {t('kept.failed')}
        {actions?.onRetryKeep ? (
          <Button size="sm" variant="quiet" onClick={() => actions.onRetryKeep?.()}>
            {t('kept.retry')}
          </Button>
        ) : null}
      </span>
    ) : null

  return (
    <div className={aside ? 'fw-rqc fw-rqc-with-aside' : 'fw-rqc'}>
      <section className="fw-rqc-main" aria-label={t('compose.label')}>
        {model.notice ? (
          <Banner tone="info" title={model.notice} onDismiss={actions?.onDismissNotice} />
        ) : null}
        <Card padded className="fw-rqc-card">
          {to ?? (
            <div className="fw-rqc-to" role="group" aria-labelledby="fw-rqc-to-label">
              <span id="fw-rqc-to-label" className="fw-rqc-to-label">
                {t('to.label')}
              </span>
              <span className="fw-rqc-to-value">
                <Lock size={14} aria-hidden />
                <span>{model.goesTo}</span>
              </span>
              <span className="fw-rqc-to-why">{t('to.why')}</span>
            </div>
          )}
          <Field label={t('subject.label')} hint={draft.subject.trim() === '' && draft.message.trim() !== '' ? t('subject.used', { subject }) : t('subject.hint')}>
            <Input value={draft.subject} maxLength={COMPOSE_LIMITS.subject} readOnly={held} onChange={(event) => change('subject')(event.target.value)} onBlur={() => actions?.onLeave?.('subject')} autoComplete="off" />
          </Field>
          <Field label={t('message.label')} hint={t('message.hint')} error={problem('message')} required>
            <Textarea
              className="fw-rqc-message"
              value={draft.message}
              rows={12}
              readOnly={held}
              {...(limit !== null ? { limit } : {})}
              onChange={(event) => change('message')(event.target.value)}
              onBlur={() => actions?.onLeave?.('message')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  if (!model.sendHeld) actions?.onSend?.()
                }
              }}
            />
          </Field>
          <div className="fw-rqc-keptrow" role="status" aria-live="polite">
            {keptLine}
          </div>
          <div className="fw-rqc-files" role="group" aria-labelledby="fw-rqc-files-title">
            <Paperclip size={18} aria-hidden />
            <div className="fw-rqc-files-text">
              <span id="fw-rqc-files-title" className="fw-rqc-files-title">
                {t('files.title')}
              </span>
              <span>{model.filesHeld}</span>
            </div>
          </div>
          <Disclosure
            className="fw-rqc-details"
            open={model.detailsOpen}
            onToggle={(event) => {
              const open = (event.currentTarget as HTMLDetailsElement).open
              if (open !== model.detailsOpen) actions?.onDetails?.(open)
            }}
            summary={
              <span className="fw-rqc-details-summary">
                <span>{t('details.title')}</span>
                {summary && !model.detailsOpen ? <span className="fw-rqc-details-sum">{summary}</span> : null}
              </span>
            }
          >
            <div className="fw-rqc-details-body">
              <p className="fw-rqc-quiet">{t('details.none')}</p>
              <div className="fw-rqc-details-grid">
                <Field label={t('details.ref')} hint={t('details.refHint')} error={problem('customerRef')}>
                  <Input value={draft.customerRef} readOnly={held} onChange={(event) => change('customerRef')(event.target.value)} onBlur={() => actions?.onLeave?.('customerRef')} autoComplete="off" />
                </Field>
                <Field label={t('details.date')} hint={t('details.dateHint')} error={problem('wantedDate')}>
                  <DateField
                    value={draft.wantedDate}
                    min={model.today}
                    clearable
                    disabled={held}
                    onChange={(value) => {
                      change('wantedDate')(value)
                      actions?.onLeave?.('wantedDate')
                    }}
                  />
                </Field>
                {model.shipTo.state !== 'none' ? (
                  <Field label={t('details.shipTo')} hint={model.shipTo.choices.find((choice) => choice.id === draft.shipToAddressId)?.waiting ? t('details.shipToWaiting') : t('details.shipToHint')} error={problem('shipToAddressId')}>
                    {model.shipTo.state === 'error' ? (
                      <span className="fw-rqc-inline">
                        {t('details.shipToFailed')}
                        {actions?.onRetryShipTo ? (
                          <Button size="sm" onClick={() => actions.onRetryShipTo?.()}>
                            {t('state.retry')}
                          </Button>
                        ) : null}
                      </span>
                    ) : (
                      <Select value={draft.shipToAddressId} disabled={held || model.shipTo.state === 'loading'} onChange={(event) => change('shipToAddressId')(event.target.value)}>
                        <option value="">{model.shipTo.state === 'loading' ? t('state.loading') : t('details.shipToUsual')}</option>
                        {model.shipTo.choices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.waiting ? t('details.shipToChoiceWaiting', { place: choice.label }) : choice.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
              </div>
            </div>
          </Disclosure>
          {model.same ? (
            <Banner
              tone="warning"
              title={model.same.yours ? t('same.titleAs', { time: model.same.at, yours: model.same.yours }) : t('same.title', { time: model.same.at })}
              action={
                <Button size="sm" onClick={() => actions?.onSendAnyway?.()} heldReason={model.sending ? t('held.sending') : null}>
                  {t('same.anyway')}
                </Button>
              }
            >
              {t('same.body')}
            </Banner>
          ) : null}
          {model.failed ? (
            <p className="fw-rqc-failed" role="alert">
              {model.failed}
            </p>
          ) : null}
          <div className="fw-rqc-send">
            <Button variant="quiet" onClick={() => actions?.onDiscard?.()} heldReason={held ? model.sendHeld : null}>
              {t('send.discard')}
            </Button>
            <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={model.sendHeld}>
              {model.sending ? t('send.sending') : t('send.send')}
            </Button>
          </div>
        </Card>
        {below}
      </section>
      {aside ? <aside className="fw-rqc-aside">{aside}</aside> : null}
    </div>
  )
}

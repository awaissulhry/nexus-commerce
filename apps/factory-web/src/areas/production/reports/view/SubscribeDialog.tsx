'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WEEKDAYS, type Recipient, type Subscription } from '../api'
import { subscribeHeld, type LanguageChoice, type Phrase, type ReportsCan, type SubscribeDraft } from '../model'

/** The "Email me this report" dialog's model (design production.reports pop:prr-subscribe). */
export interface SubscribeModel {
  readonly site: { readonly id: string; readonly code: string; readonly name: string }
  readonly me: { readonly id: string; readonly name: string }
  readonly can: ReportsCan
  readonly draft: SubscribeDraft
  /** My subscription to this site's report (on or off), null: none yet. */
  readonly mine: Subscription | null
  /** The colleagues I made it for, still on. */
  readonly others: readonly Subscription[]
  /** Who may get it at the site (production.reports.subscribe only); null while read or when not allowed. */
  readonly people: { readonly value: readonly Recipient[] | null; readonly problem: string | null }
  readonly busy: boolean
  readonly problem: Phrase | null
}

export interface SubscribeActions {
  onDraft?: (change: Partial<SubscribeDraft>) => void
  onToggleDay?: (day: number) => void
  onToggleRecipient?: (id: string) => void
  onSubscribe?: () => void
  onTurnOff?: (subscription: Subscription) => void
  onCloseSubscribe?: () => void
}

/**
 * Email me this report (SCR-240 pop:prr-subscribe): the time it comes each morning (the site's zone), the weekdays, the
 * language (each person's own, Italian or English) and, for whoever may subscribe colleagues, the people of the site who
 * may read it themselves (who gets it already is said). It brings the site's previous working day per line, style and
 * size, never per person. Subscribe is held with its reason; Turn off keeps the settings. Esc closes; focus returns to
 * the opener (DS Modal).
 */
export function SubscribeDialog({ model, actions }: { model: SubscribeModel; actions?: SubscribeActions }) {
  const t = useT('production-reports')
  const locale = useLocale()
  const heldPhrase = model.busy ? { key: 'subscribe.held.busy' } : subscribeHeld(model.draft, model.can, model.me.id)
  const held = heldPhrase ? t(heldPhrase.key, heldPhrase.params) : null
  const go = () => {
    if (!held) actions?.onSubscribe?.()
  }
  const mineOn = model.mine?.active ? model.mine : null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseSubscribe?.()}
      title={t('subscribe.title')}
      subtitle={t('subscribe.subtitle', { site: `${model.site.code} · ${model.site.name}` })}
      size="md"
      footer={
        <>
          {mineOn && (
            <Button size="sm" tone="danger" onClick={() => actions?.onTurnOff?.(mineOn)} heldReason={model.busy ? t('subscribe.held.busy') : undefined}>
              {t('subscribe.turnOff')}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseSubscribe?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={go}>
            {model.busy ? <Spinner size={12} /> : null} {mineOn ? t('subscribe.save') : t('subscribe.go')}
          </Button>
        </>
      }
    >
      <form
        className="fw-prr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          go()
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <p className="fw-prr-muted">{t('subscribe.what')}</p>
        {model.mine && (
          <p className="fw-prr-muted">
            {model.mine.active ? t('subscribe.nowOn', { time: model.mine.sendTime }) : t('subscribe.nowOff')}
            {model.mine.lastSentAt ? ` · ${t('subscribe.lastSent', { at: formatDateTime(model.mine.lastSentAt, { locale }) })}` : ''}
          </p>
        )}
        <div className="fw-prr-form">
          <Field label={t('subscribe.time')} hint={t('subscribe.timeHint')}>
            <Input type="time" value={model.draft.sendTime} step={900} onChange={(event) => actions?.onDraft?.({ sendTime: event.target.value })} />
          </Field>
          <Field label={t('subscribe.language')}>
            <Select value={model.draft.language} onChange={(event) => actions?.onDraft?.({ language: event.target.value as LanguageChoice })}>
              <option value="own">{t('subscribe.languageOwn')}</option>
              <option value="it">{t('subscribe.languageIt')}</option>
              <option value="en">{t('subscribe.languageEn')}</option>
            </Select>
          </Field>
        </div>
        <fieldset className="fw-prr-fieldset">
          <legend className="fw-prr-legend">{t('subscribe.weekdays')}</legend>
          <div className="fw-prr-days">
            {WEEKDAYS.map((day) => (
              <Checkbox key={day} label={t(`weekday.${day}`)} checked={model.draft.weekdays.includes(day)} onChange={() => actions?.onToggleDay?.(day)} />
            ))}
          </div>
        </fieldset>
        <fieldset className="fw-prr-fieldset">
          <legend className="fw-prr-legend">{t('subscribe.recipients')}</legend>
          {!model.can.subscribe ? (
            <p className="fw-prr-muted">{t('subscribe.onlyMe', { name: model.me.name })}</p>
          ) : model.people.problem ? (
            <p className="fw-prr-muted">{t(model.people.problem)}</p>
          ) : !model.people.value ? (
            <p className="fw-prr-muted" role="status">
              <Spinner size={12} /> {t('common.loading')}
            </p>
          ) : (
            <ul className="fw-prr-people">
              {model.people.value.map((person) => (
                <li key={person.id} className="fw-prr-inline">
                  <Checkbox label={person.me ? t('subscribe.me', { name: person.name }) : person.name} checked={model.draft.recipients.includes(person.id)} onChange={() => actions?.onToggleRecipient?.(person.id)} />
                  {person.subscribed && <Tag tone="info">{t('subscribe.getsIt')}</Tag>}
                </li>
              ))}
            </ul>
          )}
          <p className="fw-prr-muted">{t('subscribe.whoMay')}</p>
        </fieldset>
        {model.others.length > 0 && (
          <div className="fw-prr-others">
            <p className="fw-prr-legend">{t('subscribe.othersTitle')}</p>
            <ul className="fw-prr-people">
              {model.others.map((row) => (
                <li key={row.id} className="fw-prr-inline">
                  <span>{t('subscribe.other', { name: row.user.name, time: row.sendTime })}</span>
                  <Button size="sm" onClick={() => actions?.onTurnOff?.(row)} heldReason={model.busy ? t('subscribe.held.busy') : undefined}>
                    {t('subscribe.turnOffFor', { name: row.user.name })}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  )
}

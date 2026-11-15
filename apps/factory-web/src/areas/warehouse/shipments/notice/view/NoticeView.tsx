'use client'

import { Mail, Send } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import type { Notice } from '../api'
import { automaticWords, MAIL_TONE, mailState, sendHeld, sentWords, type NoticeActions, type NoticeModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/**
 * SCR-598 — Tracking & delivery › Customer notice (design sh-notice "The shipping mail to the customer in their language
 * (LOG-061): sent at, to whom, delivery state · Send again"; B-W2b-398): whether it goes by itself when the goods leave (the
 * site's switch, OFF by default) or why not, each mail with whom it went to, its language, by itself or by hand and its
 * delivery state; Send again picks the customer's orders contacts and mails it by hand — held with why (not left, TEST
 * labels: no customer ever gets a TEST tracking number, no tracking number, nobody to mail).
 */
export function NoticeView({ model, actions }: { model: NoticeModel; actions?: NoticeActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <NoticeCard model={model} actions={actions} />
    </WithMessages>
  )
}

function NoticeCard({ model, actions }: { model: NoticeModel; actions?: NoticeActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <h2 className="fw-sh-h2">
      <Mail size={16} aria-hidden /> {t('notice.title')}
    </h2>
  )
  if (model.notice.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={model.notice.state === 'error' ? model.notice.problem : null} onRetry={actions?.onRetry} label={t('notice.title')} />
      </Card>
    )
  }
  const notice = model.notice.value
  const blocked = sendHeld(notice, model.busy)
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head}
        <Tag tone={notice.switchOn ? 'success' : 'neutral'}>{notice.switchOn ? t('notice.switchOn') : t('notice.switchOff')}</Tag>
      </div>
      <p className="fw-sh-hint">{say(automaticWords(notice))}</p>
      {model.sent && (
        <Banner tone={model.sent.failed > 0 ? 'warning' : 'success'} title={say(sentWords(model.sent)) ?? ''}>
          {model.sent.skipped.length > 0 ? t('notice.outcome.skipped', { addresses: model.sent.skipped.join(', ') }) : null}
        </Banner>
      )}
      {model.problem && !model.dialog && <Banner tone="danger" title={say(model.problem) ?? ''} />}
      {notice.mails.length === 0 ? (
        <p className="fw-sh-hint">{t('notice.noMail')}</p>
      ) : (
        <ul className="fw-shd-hold-list" aria-label={t('notice.mails')}>
          {notice.mails.map((mail) => {
            const state = mailState(mail)
            return (
              <li key={mail.id} className="fw-shd-hold">
                <span className="fw-shd-hold-head">
                  <Pill tone={MAIL_TONE[state.state]}>{t(`mailState.${state.state}`)}</Pill>
                  <span className="fw-sh-cell-sub">{mail.automatic ? t('notice.automatic') : t('notice.byHand')}</span>
                </span>
                <span className="fw-shd-hold-words">{mail.to.join(', ')}</span>
                <span className="fw-sh-cell-sub">
                  {t('notice.mailLine', { when: formatDateTime(state.at, { locale }), language: mail.locale.toUpperCase() })}
                  {mail.sentAt && state.at !== mail.sentAt ? ` · ${t('notice.sentAt', { when: formatDateTime(mail.sentAt, { locale }) })}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <span className="fw-shd-actions">
        <Button size="sm" heldReason={say(blocked)} onClick={() => actions?.onDialog?.({ contactIds: notice.recipients.map((recipient) => recipient.contactId) })}>
          <Send size={14} aria-hidden /> {t('notice.sendAgain')}
        </Button>
      </span>
      {model.dialog && <SendDialog notice={notice} model={model} actions={actions} />}
    </Card>
  )
}

function SendDialog({ notice, model, actions }: { notice: Notice; model: NoticeModel; actions?: NoticeActions }) {
  const { t, say } = useDepthWords()
  if (!model.dialog) return null
  const picked = model.dialog.contactIds
  const toggle = (contactId: string) => actions?.onDialog?.({ contactIds: picked.includes(contactId) ? picked.filter((id) => id !== contactId) : [...picked, contactId] })
  return (
    <DepthDialog
      title={t('notice.sendTitle', { number: notice.shipment.number })}
      held={model.busy ? t('notice.held.busy') : picked.length === 0 ? t('notice.held.pickOne') : say(sendHeld(notice, false))}
      onGo={() => actions?.onSend?.()}
      goLabel={t('notice.sendGo', { count: picked.length })}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <p className="fw-sh-hint">{t('notice.sendBody')}</p>
      <fieldset className="fw-shd-choices">
        <legend className="fw-sh-h3">{t('notice.to')}</legend>
        {notice.recipients.map((recipient) => (
          <Checkbox key={recipient.contactId} checked={picked.includes(recipient.contactId)} onChange={() => toggle(recipient.contactId)} label={`${recipient.name} · ${recipient.email}`} />
        ))}
      </fieldset>
      <p className="fw-sh-hint">{t('notice.fake')}</p>
    </DepthDialog>
  )
}

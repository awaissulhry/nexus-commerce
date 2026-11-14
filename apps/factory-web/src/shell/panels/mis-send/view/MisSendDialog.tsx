'use client'

import { useEffect, useState } from 'react'
import { AtSign, Building2, FileWarning, Mail, Paperclip, Send, ShieldAlert, UserRound, Users } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { needsAcknowledge, RECIPIENT_TONE, recipientWords, sendHeld, sizeWords, titleOf, WARNING_TONE, type MisSendCheck, type MisSendModel, type MisSendWarning } from '../model'
import '../mis-send.css'

export type { MisSendModel } from '../model'

/** What the dialog asks of its host (use-mis-send.tsx). Absent in the design index: the dialog still opens. */
export interface MisSendActions {
  onSend?: () => void
  onBack?: () => void
  onRetry?: () => void
}

const WARNING_ICON: Readonly<Record<MisSendWarning, typeof Mail>> = {
  OTHER_ORGANISATION: Building2,
  UNKNOWN_RECIPIENT: Mail,
  MENTIONS_COST: ShieldAlert,
  NAMES_OTHER_CUSTOMER: Users,
  INTERNAL_MENTION: AtSign,
  OFFICE_FILE: FileWarning,
}

/**
 * SCR-437 — "Send to <party>?" (design shell.panels pop:mis-send; COL-004; B-W2b-397): opened by Send in the record's
 * composer when the mode is the message to the party. Each recipient with its organisation (the party's own, another
 * organisation's, ours, or unknown), the warnings the API found in the text with what it found, the attachments with who
 * sees them, the subject. Send message is held, never disabled, while the check runs or failed, while an attachment is the
 * office's only, and until the warnings are ticked as read. Enter sends · Esc goes back to edit. Fetches nothing.
 */
export function MisSendDialog({ model, actions }: { model: MisSendModel; actions?: MisSendActions }) {
  return (
    <WithMessages namespaces={['mail-depth']}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: MisSendModel; actions?: MisSendActions }) {
  const t = useT('mail-depth')
  const [acknowledged, setAcknowledged] = useState(model.acknowledged ?? false)
  const check = model.state.status === 'ready' ? model.state.check : null
  // A new answer (a retry) asks the tick again.
  useEffect(() => setAcknowledged(model.acknowledged ?? false), [check, model.acknowledged])
  const held = sendHeld(model, acknowledged)
  const heldText = held ? t(held) : null
  const title = titleOf(model)
  const danger = check?.warnings.some((warning) => warning.code === 'OTHER_ORGANISATION') ?? false

  // Enter sends (not on a button, a link or the tick: they keep their own Enter); Esc is the modal's own (back to edit).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || held) return
      const target = event.target as HTMLElement | null
      if (target?.closest('button, a, input, textarea, select, [role="checkbox"]')) return
      event.preventDefault()
      actions?.onSend?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, actions])

  return (
    <Modal
      open
      onClose={() => actions?.onBack?.()}
      title={t(title.key, title.params)}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onBack?.()} aria-keyshortcuts="Escape">
            {t('misSend.back')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} heldReason={heldText} onClick={() => actions?.onSend?.()} aria-keyshortcuts="Enter">
            <Send size={14} aria-hidden /> {t('misSend.send')}
          </Button>
        </>
      }
    >
      <div className="fw-mis">
        {model.state.status === 'checking' ? (
          <p className="fw-mis-muted" role="status">
            <Spinner size={14} /> {t('misSend.checking')}
          </p>
        ) : model.state.status === 'error' ? (
          <Banner
            tone="danger"
            title={t(model.state.problem)}
            action={
              model.state.retry ? (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('misSend.retry')}
                </Button>
              ) : undefined
            }
          >
            {t('misSend.problem.body')}
          </Banner>
        ) : (
          <Found check={model.state.check} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
        )}
        <p className="fw-mis-muted fw-mis-small">
          <Mail size={13} aria-hidden /> {model.draft.subject.trim() ? t('misSend.subject', { subject: model.draft.subject.trim() }) : t('misSend.subjectNone')}
        </p>
        <p className="fw-mis-muted fw-mis-small">{t('misSend.noUndo')}</p>
      </div>
    </Modal>
  )
}

function Found({ check, acknowledged, onAcknowledge }: { check: MisSendCheck; acknowledged: boolean; onAcknowledge: (value: boolean) => void }) {
  const t = useT('mail-depth')
  const locale = useLocale()
  const partyName = check.party?.name ?? t('misSend.theParty')
  return (
    <>
      {check.warnings.length > 0 ? (
        <section className="fw-mis-section" aria-labelledby="fw-mis-warnings">
          <h3 id="fw-mis-warnings" className="fw-mis-h">
            {t('misSend.warnings', { count: check.warnings.length })}
          </h3>
          <ul className="fw-mis-list">
            {check.warnings.map((warning) => {
              const Icon = WARNING_ICON[warning.code]
              return (
                <li key={warning.code} className={`fw-mis-warning is-${WARNING_TONE[warning.code]}`}>
                  <Icon size={15} aria-hidden />
                  <span>
                    <strong>{t(`misSend.warning.${warning.code}.title`, { count: warning.items.length })}</strong> {warning.items.join(', ')}
                    <span className="fw-mis-muted fw-mis-block">{t(`misSend.warning.${warning.code}.body`, { party: partyName })}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : (
        <Banner tone="success" title={t('misSend.clean')} />
      )}

      <section className="fw-mis-section" aria-labelledby="fw-mis-recipients">
        <h3 id="fw-mis-recipients" className="fw-mis-h">
          {t('misSend.recipients', { count: check.recipients.length })}
        </h3>
        <ul className="fw-mis-list">
          {check.recipients.map((recipient) => {
            const words = recipientWords(recipient)
            return (
              <li key={recipient.address} className="fw-mis-recipient">
                <UserRound size={15} aria-hidden />
                <span className="fw-mis-address">
                  {recipient.personName ? <strong>{recipient.personName} </strong> : null}
                  <span className="fw-mis-code">{recipient.address}</span>
                </span>
                <Tag tone={RECIPIENT_TONE[recipient.kind]}>{t(words.key, words.params)}</Tag>
              </li>
            )
          })}
        </ul>
      </section>

      {check.attachments.length > 0 && (
        <section className="fw-mis-section" aria-labelledby="fw-mis-files">
          <h3 id="fw-mis-files" className="fw-mis-h">
            {t('misSend.attachments', { count: check.attachments.length })}
          </h3>
          <ul className="fw-mis-list">
            {check.attachments.map((file) => (
              <li key={file.id} className="fw-mis-recipient">
                <Paperclip size={15} aria-hidden />
                <span className="fw-mis-address">
                  {file.name} <span className="fw-mis-muted">{sizeWords(file.sizeBytes, locale)}</span>
                </span>
                <Tag tone={file.audience === 'PARTY' ? 'info' : 'danger'}>{file.audience === 'PARTY' ? t('misSend.file.party', { party: partyName }) : t('misSend.file.office')}</Tag>
              </li>
            ))}
          </ul>
        </section>
      )}

      {needsAcknowledge(check) && (
        <div className="fw-mis-ack">
          <Checkbox tone="warning" checked={acknowledged} onChange={(event) => onAcknowledge(event.target.checked)} label={t('misSend.acknowledge')} />
        </div>
      )}
    </>
  )
}

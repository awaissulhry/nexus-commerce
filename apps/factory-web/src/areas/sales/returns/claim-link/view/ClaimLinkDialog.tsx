'use client'

import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { claimLinkHeld, OTHER_ADDRESS, type ClaimLinkActions, type ClaimLinkModel } from '../model'

/**
 * F-OS-303 (order SHIPMENTS tab, 10-design §5 / §6) — "Send a claim link for SEED-SH-0012": a centred window (never a drawer). To whom —
 * one of the customer's contacts with an e-mail, or another address typed; what the customer gets (a link to ask for a return or report
 * a quality problem, with photos; for them only); Send. Sent: to whom, whether the mail went, until when it works. Footer: two buttons.
 */
export function ClaimLinkDialog({ model, actions }: { model: ClaimLinkModel; actions?: ClaimLinkActions }) {
  return (
    <WithMessages namespaces={['order-shipments']}>
      <Claim model={model} actions={actions} />
    </WithMessages>
  )
}

function Claim({ model, actions }: { model: ClaimLinkModel; actions?: ClaimLinkActions }) {
  const t = useT('order-shipments')
  const locale = useLocale()
  const close = () => actions?.onClose?.()
  const held = claimLinkHeld(model)
  const title = t('claim.title', { number: model.record.number })
  if (model.sent) {
    const sent = model.sent
    return (
      <Modal open onClose={close} title={title} size="md" footer={<Button size="sm" variant="primary" onClick={close}>{t('claim.close')}</Button>}>
        <p role="status">{t(sent.delivery === 'FAILED' ? 'claim.sent.failed' : sent.delivery === 'QUEUED' ? 'claim.sent.queued' : 'claim.sent.sent', { email: sent.link.email ?? '—' })}</p>
        <p className="fw-os-mu">{t('claim.sent.until', { day: formatDate(sent.link.expiresAt, { locale }) })}</p>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={close}
      title={title}
      size="md"
      footer={
        <>
          <Button size="sm" onClick={close}>
            {t('claim.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSend?.()}>
            {t('claim.go')}
          </Button>
        </>
      }
    >
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      <p>{t('claim.what')}</p>
      <Field label={t('claim.to')} required hint={model.contacts === null ? t('claim.reading') : model.contacts.length === 0 ? t('claim.noContact') : undefined}>
        <Select size="sm" value={model.to} onChange={(event) => actions?.onTo?.(event.target.value)}>
          <option value="">{t('claim.pickTo')}</option>
          {(model.contacts ?? []).map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name} · {contact.email}
            </option>
          ))}
          <option value={OTHER_ADDRESS}>{t('claim.other')}</option>
        </Select>
      </Field>
      {model.to === OTHER_ADDRESS && (
        <Field label={t('claim.email')} required>
          <Input size="sm" type="email" inputMode="email" value={model.email} onChange={(event) => actions?.onEmail?.(event.target.value)} />
        </Field>
      )}
      <p className="fw-os-mu">{t('claim.never')}</p>
    </Modal>
  )
}

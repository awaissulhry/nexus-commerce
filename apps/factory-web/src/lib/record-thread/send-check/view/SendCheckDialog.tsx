'use client'

import type { KeyboardEvent } from 'react'
import { AlertTriangle, Ban, Lock, Mail } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { confirmHeld, warningLines, type CheckState, type Recipient } from '../model'
import '../send-check.css'

export interface SendCheckModel {
  open: boolean
  state: CheckState
  partyName: string
  to: readonly Recipient[]
  cc: readonly Recipient[]
  files: number
  /** "Send outside this customer" ticked (recorded by the API with the send). */
  outside: boolean
  sending: boolean
}

export interface SendCheckActions {
  onBack: () => void
  onRetry: () => void
  onOutside: (ticked: boolean) => void
  onConfirm: () => void
}

/**
 * "Send to <customer>?" (B-TH-207, T7-F02; picture 5): who gets it (each person with their organisation, the files) and that it goes
 * from you with the record's reply address; then every risk the check found, the blocking ones in red — another customer's address
 * waits for the recorded tick "Send outside this customer", an office-only file for Back to the text. Enter confirms. A check
 * that could not run says so and lets the send go (the API refuses another customer's address on its own).
 */
export function SendCheckDialog({ model, actions }: { model: SendCheckModel; actions: SendCheckActions }) {
  const t = useT('record-thread-send')
  const held = confirmHeld(model.state, { outside: model.outside }, model.sending)
  const check = model.state.status === 'ready' ? model.state.check : null
  const outside = check?.outsideCustomer ?? []
  // Another customer's address is said once, with its tick: the "another organisation" warning would repeat it.
  const lines = check ? warningLines(check).filter((line) => !(outside.length > 0 && line.code === 'OTHER_ORGANISATION')) : []
  const count = lines.length + (outside.length > 0 ? 1 : 0)
  const who = (list: readonly Recipient[]) => list.map((item) => (item.organisation ? t('who.person', { name: item.name ?? item.address, org: item.organisation }) : (item.name ?? item.address))).join(', ')

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.key !== 'Enter' || held || target.tagName === 'TEXTAREA' || (target.tagName === 'BUTTON' && !target.dataset.confirm) || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox')) return
    event.preventDefault()
    actions.onConfirm()
  }

  return (
    <Modal
      open={model.open}
      onClose={actions.onBack}
      size="md"
      title={
        <span className="fw-rt-check-title">
          <Mail size={16} aria-hidden /> {t('check.title', { party: model.partyName })}
        </span>
      }
      footer={
        <>
          <Button size="sm" onClick={actions.onBack}>
            {t('check.back')}
          </Button>
          <Button size="sm" variant="primary" data-confirm="1" heldReason={held ? t(held) : null} onClick={actions.onConfirm}>
            {t('check.send', { party: model.partyName })}
          </Button>
        </>
      }
    >
      <div className="fw-rt-check" onKeyDown={onKeyDown}>
        <p className="fw-rt-check-who">
          {t('who.to', { list: who(model.to) })}
          {model.cc.length > 0 && ` · ${t('who.cc', { list: who(model.cc) })}`}
          {model.files > 0 && ` · ${t('who.files', { count: model.files })}`}
          <br />
          {t('who.from')}
        </p>
        {model.state.status === 'checking' && (
          <p className="fw-rt-check-line" role="status">
            <Spinner size={14} /> {t('check.checking')}
          </p>
        )}
        {model.state.status === 'error' && (
          <Banner tone={model.state.retry ? 'warning' : 'danger'} title={t(model.state.retry ? 'check.failed' : 'check.refused')} action={model.state.retry ? <Button size="sm" onClick={actions.onRetry}>{t('check.retry')}</Button> : undefined}>
            {t(model.state.problem)}
          </Banner>
        )}
        {check && count === 0 && <p className="fw-rt-check-line">{t('check.clean')}</p>}
        {check && count > 0 && (
          <>
            <p className="fw-rt-check-line">{t('check.count', { count })}</p>
            <ul className="fw-rt-warns">
              {outside.length > 0 && (
                <li className="is-block">
                  <Ban size={16} aria-hidden />
                  <span>
                    <b>{t('outside.title', { addresses: outside.join(', ') })}</b>
                    {t('outside.body', { party: model.partyName })}
                    <Checkbox className="fw-rt-warns-tick" label={t('outside.tick')} checked={model.outside} onChange={(event) => actions.onOutside(event.target.checked)} />
                  </span>
                </li>
              )}
              {lines.map((line) => (
                <li key={line.code} className={line.blocking ? 'is-block' : ''}>
                  {line.code === 'OFFICE_FILE' ? <Lock size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
                  <span>
                    <b>{t(`${line.key}.title`, line.params)}</b>
                    {t(`${line.key}.body`, { ...line.params, party: model.partyName })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}

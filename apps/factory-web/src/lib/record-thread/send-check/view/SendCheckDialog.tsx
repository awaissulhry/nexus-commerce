'use client'

import type { KeyboardEvent } from 'react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { SendCheckWindow } from '../../popups/view/Confirms'
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
  /** B-TH-236 (B-TH-050): the mail corrects one we sent ("Send the correction to Brand Alpha?"). */
  correction?: boolean
}

export interface SendCheckActions {
  onBack: () => void
  onRetry: () => void
  onOutside: (ticked: boolean) => void
  onConfirm: () => void
}

/**
 * "Send to <customer>?" (B-TH-207, T7-F02; picture 5) in TH-1c's send-check window (popups' SendCheckWindow, B-TH-211): who
 * gets it, each person with their organisation; every risk the check found in words (an office-only file is the blocking one);
 * another customer's address waits for the window's recorded tick "Send outside this customer"; that it goes from you with the
 * record's reply address; checking, and a check that could not run (the send may still go: the API refuses another customer's
 * address on its own). Enter confirms when nothing holds Send.
 */
export function SendCheckDialog({ model, actions }: { model: SendCheckModel; actions: SendCheckActions }) {
  const t = useT('record-thread-send')
  if (!model.open) return null
  const check = model.state.status === 'ready' ? model.state.check : null
  const outside = check?.outsideCustomer ?? []
  // Another customer's address is said once, with its tick: the "another organisation" warning would repeat it.
  const lines = check ? warningLines(check).filter((line) => !(outside.length > 0 && line.code === 'OTHER_ORGANISATION')) : []
  const held = confirmHeld(model.state, { outside: model.outside }, model.sending)
  // The window holds Send on its own for a danger finding and the missing tick; the states it does not know are said here.
  const ownHeld = held === 'check.held.sending' || held === 'check.held.checking' || held === 'check.held.refused' ? t(held) : null
  const who = (list: readonly Recipient[]) => list.map((item) => (item.organisation ? t('who.person', { name: item.name ?? item.address, org: item.organisation }) : (item.name ?? item.address)))
  // While the check runs, or when it could not, the window says so in its list (never "nothing to check" before an answer).
  const status =
    model.state.status === 'checking'
      ? [{ id: 'checking', text: t('check.checking'), tone: 'info' as const }]
      : model.state.status === 'error'
        ? [{ id: 'error', text: `${t(model.state.retry ? 'check.failed' : 'check.refused')}: ${t(model.state.problem)}`, tone: model.state.retry ? ('warning' as const) : ('danger' as const) }]
        : []
  const warnings = [
    ...status,
    ...(outside.length > 0 ? [{ id: 'outside', text: `${t('outside.title', { addresses: outside.join(', ') })} ${t('outside.body', { party: model.partyName })}`, tone: 'warning' as const }] : []),
    ...lines.map((line) => ({ id: line.code, text: `${t(`${line.key}.title`, line.params)} ${t(`${line.key}.body`, { ...line.params, party: model.partyName })}`, tone: line.blocking ? ('danger' as const) : ('warning' as const) })),
  ]
  const blocked = Boolean(held) && !(held === 'check.held.outside' && model.outside)

  // Enter confirms (T7-F02) from anywhere in the window but a field or another button; React carries the key out of the portal.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.key !== 'Enter' || blocked || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'A' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox')) return
    event.preventDefault()
    actions.onConfirm()
  }

  return (
    <div className="fw-rt-contents" onKeyDown={onKeyDown}>
      <SendCheckWindow
        model={{ to: who(model.to), cc: who(model.cc), party: model.partyName || null, warnings, outside: outside.length > 0 ? { ticked: model.outside } : null, sendLabel: t(model.correction ? 'check.sendCorrection' : 'check.send', { party: model.partyName }), held: ownHeld }}
        onTickOutside={actions.onOutside}
        onBack={actions.onBack}
        onSend={actions.onConfirm}
      >
        <p className="fw-rt-check-who">
          {model.files > 0 && `${t('who.files', { count: model.files })} · `}
          {t('who.from')}
        </p>
        {/* B-TH-236 (B-TH-048): the 10 seconds after Send, said before it goes; a correction says the old mail stays. */}
        <p className="fw-rt-check-who">
          {model.correction ? `${t('who.correction')} ` : ''}
          {t('who.undo')}
        </p>
        {model.state.status === 'error' && model.state.retry && (
          <p className="fw-rt-check-line">
            <Button size="sm" onClick={actions.onRetry}>
              {t('check.retry')}
            </Button>
          </p>
        )}
      </SendCheckWindow>
    </div>
  )
}

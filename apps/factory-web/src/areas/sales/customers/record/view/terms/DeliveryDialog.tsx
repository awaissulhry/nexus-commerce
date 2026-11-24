'use client'

import type { KeyboardEvent } from 'react'
import { Info } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { FREIGHT_BILLINGS } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { said } from '../../terms/model'
import type { TermsTabActions, TermsWindowsModel } from '../../terms/tab'
import { carrierChoices, deliveryProblems, type AccountChoice, type DeliveryField, type DeliveryWindow } from '../../terms/windows'
import { useTermsSay } from './say'

/**
 * F-CT-306 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §6.3; 18-lead-settles Z2, Z24) — NEW window "Change the
 * delivery of {customer}" (a centred DS Modal, md): the carrier and its default service ("changing the carrier clears it"), who pays
 * the freight (we · the customer on its own account, porto assegnato · someone else on theirs), the carrier account — write-only: on
 * file it is kept, replaced by a number typed (sealed, the old one deleted) or removed; it is never shown. Cancel · Save delivery —
 * ONE command, PUT /shipping/customer-carrier-accounts/:id at the party's version; a field the server refuses is marked. Draws its model.
 */

export interface DeliveryProps {
  readonly window: DeliveryWindow
  readonly windows: TermsWindowsModel
  readonly actions?: TermsTabActions | undefined
}

export function DeliveryDialog(props: DeliveryProps) {
  const say = useTermsSay()
  const { window, windows, actions } = props
  const account = windows.carrier
  const count = account ? Object.keys(deliveryProblems(window, account)).length : 0
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      actions?.onWindowConfirm?.()
    }
  }
  return (
    <Modal
      open
      size="md"
      busy={window.busy}
      onClose={() => actions?.onWindowClose?.()}
      title={say(said('ct.win.deliv.title', { params: { customer: windows.customer } }))}
      subtitle={say(said('ct.win.deliv.sub'))}
      footer={
        <>
          <span className="fw-ctr-fnote">{say(said('ct.win.deliv.foot'))}</span>
          <span className="grow" />
          <Button onClick={() => actions?.onWindowClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" heldReason={window.busy ? say(said('parties:common.saving')) : window.tried && count > 0 ? say(said('terms.fixFirst', { params: { count } })) : null} onClick={() => actions?.onWindowConfirm?.()}>
            {say(said('ct.win.deliv.save'))}
          </Button>
        </>
      }
    >
      <div onKeyDown={onKey}>
        <DeliveryBody {...props} />
      </div>
    </Modal>
  )
}

/** The window's inside (a design case draws it on a plain card). */
export function DeliveryBody({ window, windows, actions }: DeliveryProps) {
  const say = useTermsSay()
  const account = windows.carrier
  if (!account) return null
  const problems: Partial<Record<DeliveryField, string>> = window.tried ? deliveryProblems(window, account) : {}
  const draft = (next: Partial<DeliveryWindow>) => actions?.onWindowDraft?.({ ...window, ...next, field: null })
  const shown = (field: DeliveryField) => (problems[field] ? say(said(problems[field]!)) : window.field === field && window.problem ? say(said(window.problem)) : undefined)
  const choices = carrierChoices(account.carrierCode)
  const ACCOUNT: readonly AccountChoice[] = ['keep', 'replace', 'remove']
  return (
    <fieldset className="fw-ctr-win" disabled={window.busy}>
      <div className="fw-ctr-fgrid">
        <Field label={say(said('ct.com.carrier'))} hint={say(said('ct.win.deliv.carrierHint'))} error={shown('carrier')}>
          {/* Changing the carrier clears its default service (another carrier, another service). */}
          <Select value={window.carrier} onChange={(event) => draft({ carrier: event.target.value, service: event.target.value === window.carrier ? window.service : '' })}>
            <option value="">{say(said('ct.com.carrierNone'))}</option>
            {choices.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={say(said('ct.win.deliv.service'))} hint={say(said('ct.win.deliv.serviceHint'))} error={shown('service')}>
          <Input value={window.service} maxLength={100} onChange={(event) => draft({ service: event.target.value })} />
        </Field>
      </div>
      <fieldset className="fw-ctr-fs">
        <legend className="fw-ctr-legend">{say(said('ct.win.deliv.who'))}</legend>
        {FREIGHT_BILLINGS.map((freight) => (
          <RadioCard key={freight} name="ct-freight" value={freight} checked={window.freight === freight} selected={window.freight === freight} onChange={() => draft({ freight })} title={say(said(`ct.win.deliv.pays.${freight}`))} description={say(said(`ct.win.deliv.paysSub.${freight}`))} />
        ))}
        {shown('freight') ? <p className="fw-ctr-err">{shown('freight')}</p> : null}
      </fieldset>
      {account.accountOnFile ? (
        <fieldset className="fw-ctr-fs">
          <legend className="fw-ctr-legend">{say(said('ct.com.account'))}</legend>
          {ACCOUNT.map((choice) => (
            <RadioCard key={choice} name="ct-account" value={choice} checked={window.account === choice} selected={window.account === choice} onChange={() => draft({ account: choice, number: choice === 'replace' ? window.number : '' })} title={say(said(`ct.win.deliv.account.${choice}`))} description={say(said(`ct.win.deliv.accountSub.${choice}`))} />
          ))}
          {window.account === 'replace' ? (
            <Field label={say(said('ct.win.deliv.number'))} error={shown('number')}>
              <Input value={window.number} autoComplete="off" spellCheck={false} onChange={(event) => draft({ number: event.target.value })} />
            </Field>
          ) : null}
        </fieldset>
      ) : (
        <Field label={say(said('ct.com.account'))} hint={say(said('ct.win.deliv.numberHint'))} error={shown('number')}>
          <Input value={window.number} autoComplete="off" spellCheck={false} onChange={(event) => draft({ account: 'replace', number: event.target.value })} />
        </Field>
      )}
      <Banner tone="info" icon={<Info size={16} aria-hidden />} title={say(said('ct.win.deliv.another'))} />
      {window.problem && window.field === null ? <Banner tone="danger" title={say(said(window.problem))} /> : null}
    </fieldset>
  )
}

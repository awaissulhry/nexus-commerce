'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { REFUSE_REASON_LIMITS } from '@nexus/factory-domain/parties/address-approval'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { countryName } from '../../../../../parties/_shared/model'
import type { Address } from '../../../../../parties/_shared/api'
import { said } from '../../people/model'
import type { PeopleTabActions, RefuseDialog } from '../../people/tab'
import { usePeopleSay } from './say'

/**
 * F-CA-112 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §6 window 1; 18-lead-settles Z17) — NEW window "Refuse the
 * delivery address" (560): who added it and when, the address, the reason the customer reads (3–500 characters, required; the customer
 * never sees who decided), what a refusal does. Cancel · Refuse the address (danger). The container sends it (orders.manage); a refusal
 * the API refuses says why in the window. `RefuseAddressBody` is its inside (a design case draws it on a plain card).
 */

export interface RefuseAddressProps {
  readonly dialog: RefuseDialog
  readonly address: Address
  readonly customer: string
  readonly actions?: PeopleTabActions | undefined
}

/** Why the reason is not good yet (the domain's limits), or null. */
const reasonProblem = (reason: string): 'refuse.tooShort' | 'refuse.tooLong' | null => {
  const text = reason.trim()
  if (text.length < REFUSE_REASON_LIMITS.min) return 'refuse.tooShort'
  if (text.length > REFUSE_REASON_LIMITS.max) return 'refuse.tooLong'
  return null
}

export function RefuseAddressDialog(props: RefuseAddressProps) {
  const say = usePeopleSay()
  const { dialog, actions } = props
  const problem = reasonProblem(dialog.reason)
  return (
    <Modal
      open
      size="md"
      busy={dialog.busy}
      onClose={() => actions?.onRefuseClose?.()}
      title={say(said('refuse.title'))}
      subtitle={subtitleOf(props, say)}
      footer={
        <>
          <Button onClick={() => actions?.onRefuseClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="danger" heldReason={dialog.busy ? say(said('refuse.sending')) : dialog.tried && problem ? say(said(problem, { params: { max: REFUSE_REASON_LIMITS.max } })) : null} onClick={() => actions?.onRefuseConfirm?.()}>
            {say(said('refuse.confirm'))}
          </Button>
        </>
      }
    >
      <RefuseAddressBody {...props} />
    </Modal>
  )
}

function subtitleOf({ address, customer }: RefuseAddressProps, say: ReturnType<typeof usePeopleSay>): string {
  const approval = address.approval
  return approval?.requestedBy ? say(said('refuse.sub', { params: { customer, name: approval.requestedBy }, days: { date: approval.requestedAt ?? address.createdAt } })) : customer
}

/** The window's inside: the address, the reason, what a refusal does. */
export function RefuseAddressBody({ dialog, address, actions }: RefuseAddressProps) {
  const say = usePeopleSay()
  const locale = useLocale()
  const problem = reasonProblem(dialog.reason)
  return (
    <div className="fw-ca-win">
      <p className="fw-ca-win-addr">
        <b>{address.name ?? address.line1}</b>
        <span>{[address.name ? address.line1 : null, address.line2].filter(Boolean).join(', ')}</span>
        <span>
          {[address.postalCode, address.city, address.province].filter(Boolean).join(' ')} · {countryName(address.country, locale)}
        </span>
      </p>
      <Field label={say(said('refuse.why'))} required error={dialog.tried && problem ? say(said(problem, { params: { max: REFUSE_REASON_LIMITS.max } })) : undefined}>
        <Textarea rows={3} maxLength={REFUSE_REASON_LIMITS.max} value={dialog.reason} onChange={(event) => actions?.onRefuseDraft?.(event.target.value)} />
      </Field>
      <p className="fw-ca-sub">{say(said('refuse.never'))}</p>
      <p className="fw-ca-sub">{say(said('refuse.noOrder'))}</p>
      {dialog.problem ? <Banner tone="danger" title={say(said(`parties:${dialog.problem}`))} /> : null}
    </div>
  )
}

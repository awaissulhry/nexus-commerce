'use client'

import { useState } from 'react'
import { Field } from '@nexus/ui/components'
import { Input, RadioCard, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { Order } from '../../api'
import { addressLineOf, amendHeld } from '../../daily-model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { DialogProblem, Frame } from './Dialogs'

/** The customer PO's limit (factory-domain MAX_TEXT.customerRef). */
const REF_MAX = 100
const REASON_MAX = 1000

/**
 * F-OL-04 (Order LINES lane, pick D7; 11-design-dialogs §1.5) — the order fields that left the Lines tab, as small windows on Overview ›
 * Order facts (and the band's ⋯ Change ship-to…): "Customer PO of {number}" (the PO, Why optional) and "Where {number} ships" (one
 * card per delivery address of THIS customer, the one it ships to now marked). Each is the amendment with no lines (ol-s1, B-OL-020:
 * `{ version, customerRef }` / `{ version, shipToAddressId }`; the address alone writes no amendment), saved at its own button and
 * held by the amendment's own rule. Fetches nothing: the addresses are the split's read (use-lines-acts, parties.view).
 */
export function CustomerRefDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const [value, setValue] = useState(order.customerRef ?? '')
  const [reason, setReason] = useState('')
  const rule = amendHeld(order, model.can)
  const same = (value.trim() || null) === (order.customerRef ?? null)
  const held = model.busy ? t('held.busy') : rule ? t(rule.key, rule.params) : same ? t('orderFacts.ref.same') : null
  return (
    <Frame title={t('orderFacts.ref.title', { number: order.number })} held={held} go={() => actions?.onCustomerRef?.({ value: value.trim(), reason: reason.trim() })} goLabel={model.busy ? t('common.working') : t('orderFacts.ref.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />} size="sm">
      <Field label={t('overview.facts.customerRef')} hint={t('orderFacts.ref.hint')}>
        <Input value={value} maxLength={REF_MAX} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
      </Field>
      <Field label={t('review.why')}>
        <Textarea rows={2} honourRows value={reason} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <p className="fw-so-hint">{t('edit.appliesAtOnce')}</p>
    </Frame>
  )
}

export function ShipToDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const [picked, setPicked] = useState<string | null>(null)
  const part = model.split?.addresses ?? null
  const now = addressLineOf(order.shipTo as Record<string, unknown> | null | undefined)
  const addresses = part?.value ?? []
  const customer = order.party?.legalName ?? ''
  const rule = amendHeld(order, model.can)
  const pickedLine = addresses.find((address) => address.id === picked)
  const same = !!pickedLine && addressLineOf(pickedLine) === now
  const held = model.busy ? t('held.busy') : rule ? t(rule.key, rule.params) : part === null ? t('edit.shipToHeld') : !picked ? t('orderFacts.shipTo.pick') : same ? t('orderFacts.shipTo.same') : null
  return (
    <Frame title={t('orderFacts.shipTo.title', { number: order.number })} held={held} go={() => picked && actions?.onShipTo?.(picked)} goLabel={model.busy ? t('common.working') : t('orderFacts.shipTo.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />} size="sm">
      {part === null ? (
        <p className="fw-so-hint">{t('edit.shipToHeld')}</p>
      ) : part.problem ? (
        <p className="fw-so-hint">{t('edit.shipToFailed')}</p>
      ) : part.value === null ? (
        <p className="fw-so-hint" role="status">
          {t('split.shipToReading')}
        </p>
      ) : addresses.length === 0 ? (
        <p className="fw-so-hint">{t('orderFacts.shipTo.none', { customer })}</p>
      ) : (
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend">{t('orderFacts.shipTo.only', { customer })}</legend>
          {addresses.map((address) => {
            const line = addressLineOf(address) ?? address.id
            return (
              <RadioCard
                key={address.id}
                variant="row"
                name={`fw-so-shipto-${order.id}`}
                value={address.id}
                checked={picked === address.id}
                selected={picked === address.id}
                onChange={() => setPicked(address.id)}
                title={line}
                description={line === now ? <Tag tone="neutral">{t('orderFacts.shipTo.now')}</Tag> : undefined}
              />
            )
          })}
        </fieldset>
      )}
      <p className="fw-so-hint">{t('edit.appliesAtOnce')}</p>
    </Frame>
  )
}

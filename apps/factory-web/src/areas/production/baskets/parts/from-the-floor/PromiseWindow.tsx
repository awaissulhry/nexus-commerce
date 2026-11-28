'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { PROMISE_REASON_CODES, PROMISE_REASON_WORDS, type PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import { DateField } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WindowShell } from '../../../../../lib/window-shell/view/WindowShell'
import { BASKETS_NAMESPACE } from '../../model'

/**
 * owb-fl9 step 4 — **Change the promise…** from a floor's Will be late: the order's own promise command (the office order page's
 * PUT /sales/orders/:id/promise, re-used, not copied): the new date (proposed: the promise moved by the warning's days) and the reason
 * the customer reads (proposed from the floor's reason); then the warning is marked CHANGED. The customer sees the new date only.
 */

export interface PromiseWindowModel {
  readonly current: string | null
  readonly date: string
  readonly reason: PromiseReasonCode
  readonly busy: boolean
  readonly problem: string | null
}

export function PromiseWindow({ model, onDate, onReason, onSave, onClose }: { model: PromiseWindowModel; onDate: (date: string) => void; onReason: (reason: PromiseReasonCode) => void; onSave: () => void; onClose: () => void }) {
  const t = useT(BASKETS_NAMESPACE)
  const locale = useLocale()
  return (
    <WindowShell
      open
      onClose={onClose}
      title={t('promise.title')}
      subtitle={model.current ? t('promise.current', { date: model.current }) : t('promise.none')}
      closeHeld={model.busy ? t('window.busy') : null}
      act={{ words: t('promise.save'), onAct: onSave, busy: model.busy, held: model.date === '' ? t('promise.pickDate') : null }}
    >
      <div className="fw-bb-window">
        <Field label={t('promise.date')} htmlFor="fw-ff-date">
          <DateField id="fw-ff-date" value={model.date} onChange={onDate} />
        </Field>
        <Field label={t('promise.reason')} htmlFor="fw-ff-reason">
          <Select id="fw-ff-reason" value={model.reason} onChange={(event) => onReason(event.target.value as PromiseReasonCode)}>
            {PROMISE_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {PROMISE_REASON_WORDS[code][locale === 'it' ? 'it' : 'en']}
              </option>
            ))}
          </Select>
        </Field>
        <p className="fw-bb-muted">{t('promise.note')}</p>
        {model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      </div>
    </WindowShell>
  )
}

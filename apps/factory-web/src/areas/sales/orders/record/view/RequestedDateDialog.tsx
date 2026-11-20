'use client'

import { useState } from 'react'
import { Field, KeyValue } from '@nexus/ui/components'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Order } from '../../api'
import { dayInstant } from '../../model'
import { requestedHeld, requestedProblem, type OrderRecordActions, type OrderRecordModel } from '../record-model'
import { DialogProblem, Frame } from './Dialogs'

/** The reason's limit (the amendment's reason, factory-domain MAX_TEXT.reason). */
const REASON_MAX = 1000

/**
 * F-OO-144 (order overview 10-design §4.2; review F7) — "Requested by customer": a small dialog instead of the hop to the Lines edit
 * mode. The new date (today or later) and why (required); it is saved as the next amendment and applies at once (no yes is asked).
 * What it sends is ONE amendment built by the Lines edit mode's own builder: every line as it is, the new date, the order's version
 * (record-model requestedBodyOf; use-lines-acts writes it). Held by the amendment's own rule (amendHeld) and while a draft is open on
 * Lines. Fetches nothing.
 */
export function RequestedDateDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const [date, setDate] = useState(model.draft?.date ?? '')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const problem = requestedProblem({ date, reason, today: model.today, current: order.requestedDate })
  const rule = requestedHeld(order, model)
  const held = model.busy ? t('held.busy') : rule ? t(rule.key, rule.params) : problem ? t(problem.key, problem.params) : null
  const dateProblem = date !== '' && problem && problem.key.startsWith('facts.requested.problem.') ? t(problem.key) : undefined
  const revision = (order.amendments.latestRevision ?? 0) + 1
  return (
    <Frame
      title={t('facts.requested.title', { number: order.number })}
      held={held}
      go={() => actions?.onRequestedDate?.({ date, reason: reason.trim() })}
      goLabel={model.busy ? t('common.working') : t('promise.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
      size="sm"
    >
      <KeyValue dense labelCase="sentence" items={[{ label: t('dates.requested'), value: order.requestedDate ? formatDate(dayInstant(order.requestedDate), { locale }) : '—' }]} />
      <Field label={t('facts.requested.date')} hint={t('facts.requested.dateHint', { revision })} error={dateProblem}>
        <DateField value={date} onChange={setDate} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('facts.requested.date')} />
      </Field>
      {/* F-OL-04: Why is optional (ol-s1, B-OL-004: none — the server's automatic words). */}
      <Field label={`${t('promise.reason')} · ${t('lineMenu.optional')}`} hint={t('facts.requested.reasonHint')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={REASON_MAX} />
      </Field>
      <p className="fw-so-hint">{t('edit.appliesAtOnce')}</p>
    </Frame>
  )
}

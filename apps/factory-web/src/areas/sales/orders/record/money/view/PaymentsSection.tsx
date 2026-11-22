'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, History } from 'lucide-react'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OM-101 (L6): the Production kit, in place
import { PAYMENTS_ALIASES } from '../layout'
import { planOf, type EarlierRow } from '../plan'
import { stillToPayOf } from '../totals'
import { PlanRowView } from './PlanRow'
import { lineOf, useSay, type Say } from './say'

/**
 * F-OM-103 (order MONEY tab, 10-design §5) — section 2, Payments (#payments; #deposit and #schedule land here): the ONE payment plan,
 * read. Its head answers "Still open · overdue · next" (amounts with the price grain only); one row per step and per request no step
 * names (PlanRow.tsx); the replaced or removed ones under "Earlier steps (N)". Reading: two skeleton rows; failed: one line with
 * Try again (the rest of the tab still draws). Draws its model (money/plan.ts); reads nothing.
 */
export function PaymentsSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const say = useSay(order.currency)
  const title = t('moneyTab.payments.title')
  const aliases = PAYMENTS_ALIASES.map((alias) => <span key={alias} id={alias} className="fw-om-alias" tabIndex={-1} />)
  const info = (
    <>
      <p>{t('moneyTab.payments.info')}</p>
      <p>{t('moneyTab.payments.keys')}</p>
    </>
  )
  const part = model.schedule
  if (!part?.value) {
    return (
      <Section id="payments" title={title} answer={part?.problem ? null : t('moneyTab.payments.reading')} info={info}>
        {aliases}
        {part?.problem ? <PartFailed part={t('moneyTab.payments.part')} problem={part.problem} onRetry={() => actions?.onRetryPart?.('schedule')} /> : <PartReading rows={2} height={44} />}
      </Section>
    )
  }
  const settlement = model.can.viewInvoices ? (model.settlement?.value ?? null) : null
  const plan = planOf({ order, schedule: part.value, settlement, can: model.can, stepCan: model.scheduleSteps?.can ?? null, today: model.today, stillToPay: stillToPayOf(order, settlement) })
  return (
    <Section id="payments" title={title} answer={lineOf(plan.answer.map(say))} info={info}>
      {aliases}
      {plan.rows.length > 0 ? (
        <div className="fw-om-pl">
          {plan.rows.map((row) => (
            <PlanRowView key={row.anchor} row={row} order={order} model={model} actions={actions} say={say} final={plan.final} />
          ))}
        </div>
      ) : null}
      {plan.earlier.length > 0 ? <EarlierSteps rows={plan.earlier} say={say} currency={order.currency} /> : null}
    </Section>
  )
}

/** "Earlier steps (N)" — replaced or removed; kept with who, when and why (folded). */
function EarlierSteps({ rows, say, currency }: { rows: readonly EarlierRow[]; say: Say; currency: string }) {
  const t = useT('orders')
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  return (
    <div className="fw-om-pl-foot">
      <button type="button" className="fw-om-fold" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t('moneyTab.payments.earlier', { count: rows.length })} <span>· {t('moneyTab.payments.earlierHint')}</span>
      </button>
      {open
        ? rows.map((row) => (
            <p key={row.key} className="fw-om-er">
              <History size={13} aria-hidden />
              <span>{[say(row.title), row.amount !== null ? money(row.amount, currency, locale) : null, say(row.words), row.byHand ? say(row.byHand.word) : null, row.byHand?.reason ? `“${row.byHand.reason}”` : null].filter(Boolean).join(' · ')}</span>
            </p>
          ))
        : null}
    </div>
  )
}

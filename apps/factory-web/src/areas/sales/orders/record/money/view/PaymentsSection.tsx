'use client'

import { useState } from 'react'
import { History } from 'lucide-react'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import type { MenuItemDef } from '@nexus/ui/components'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../../../lib/record-sections/Kit' // F-OM-101 (L6): the Production kit, in place
import { PAYMENTS_ALIASES } from '../layout'
import { planHistoryHref, planOf, type EarlierRow } from '../plan'
import { stillToPayOf } from '../totals'
import { Fold } from './parts' // F-CM-k1: the shared fold
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
  // F-OM-201: the head's ⋯ — Change payment terms… · Add a step… (orders.moneyPlan + the price grain; held when the order is closed).
  const head: MenuItemDef[] = plan.head.map((entry) => ({ id: entry.id, label: say(entry.label), disabled: !!entry.held, description: entry.held ? say(entry.held) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'moneyPlan', act: entry.id, stepId: null, requestId: null }) }))
  // F-OM-fx3 (W-08): History › — the audit of the plan's hand changes (audit.read), for every reader who holds it.
  if (model.can.auditRead) head.push({ id: 'history', label: t('moneyTab.payments.history'), href: planHistoryHref(model.prefix, order.id) })
  return (
    <Section id="payments" title={title} answer={lineOf(plan.answer.map(say))} info={info} more={head.length > 0 ? <LineMenuButton label={t('moneyTab.payments.more')} items={head} /> : undefined}>
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
      <Fold open={open} onToggle={() => setOpen((now) => !now)} label={t('moneyTab.payments.earlier', { count: rows.length })} hint={t('moneyTab.payments.earlierHint')} />
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

'use client'

import { CheckCircle2, Clock, Info, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import type { Order } from '../../../api'
import type { OrderRecordModel } from '../../record-model'
import { moneyHeadOf } from '../head'
import { keepNumbers, sentenceOf, useSay } from './say'

/**
 * F-OM-101 (order MONEY tab, 10-design §3) — the tab's one answer, above the five sections (no card, no h2): a DS Banner in the
 * case's tone ("Deposit € 3,660.00 open, due 25/11/2026 · page sent 20/11/2026 · production waits for it."), and under it, said
 * ONCE for the whole tab, the money wall for this reader ("Amounts are shown to people who see prices.") and a closed order's
 * "its money plan no longer changes". Draws its model (money/head.ts); reads nothing.
 */
export function MoneyHead({ order, model }: { order: Order; model: OrderRecordModel }) {
  const say = useSay(order.currency)
  const head = moneyHeadOf({ order, schedule: model.schedule, settlement: model.settlement?.value ?? null, can: model.can, today: model.today, settlementFailed: model.can.viewInvoices && !!model.settlement?.problem })
  const icon = head.reading ? <RefreshCw size={18} aria-hidden /> : head.tone === 'success' ? <CheckCircle2 size={18} aria-hidden /> : head.tone === 'danger' ? <TriangleAlert size={18} aria-hidden /> : head.tone === 'warning' ? <Clock size={18} aria-hidden /> : <Info size={18} aria-hidden />
  const below = [...head.wall, ...(head.closed ? [head.closed] : [])].map(say)
  return (
    <Banner className="fw-om-head" tone={head.tone} icon={icon} title={keepNumbers(sentenceOf(head.parts.map(say))) /* F-OM-fx6 (N11) */}>
      {below.length > 0 ? (
        <span className="fw-om-head-wall">
          <Lock size={13} aria-hidden /> {below.join(' ')}
        </span>
      ) : null}
    </Banner>
  )
}

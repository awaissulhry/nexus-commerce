'use client'

import type { Order } from '../../../api'
import type { OrderRecordModel } from '../../record-model'
import { moneyHeadOf } from '../head'
import { MoneyAnswer } from './parts' // F-CM-k1: the shared answer line (its look); this file keeps the order's rule
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
  const below = [...head.wall, ...(head.closed ? [head.closed] : [])].map(say)
  return <MoneyAnswer tone={head.tone} reading={head.reading} title={keepNumbers(sentenceOf(head.parts.map(say))) /* F-OM-fx6 (N11) */} below={below} />
}

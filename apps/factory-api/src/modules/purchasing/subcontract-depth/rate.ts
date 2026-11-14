import { businessDate } from '@nexus/factory-domain/core/time'
import type { DayRate } from '@nexus/factory-domain/money/currency/rates'
import type { CommandTx } from '../../../core/command'
import type { FactoryClient } from '@nexus/factory-db'
import { dayRate, noRateWords } from '../../../platform/currency/service'

/**
 * B-W2b-389 (CY1:03; FIN-026): a subcontract order in another currency than its work order's cost posts its fee and its
 * charges in the work order's currency (the company's: euro), at ONE rate per order — the day's rate of the day it was
 * issued (its document day; before the issue, its order date), so every entry of the order converts alike and a later rate
 * never revalues what was posted (revaluation stays the accountant's). 1 <work order currency> = rate <order currency>.
 * None kept for that day: the order waits, in words (nothing posts), as before.
 */
export type OrderRate = { readonly rate: DayRate; readonly words: null } | { readonly rate: null; readonly words: string }

export async function orderRateOf(db: FactoryClient | CommandTx, order: { readonly currency: string; readonly issuedAt: Date | null; readonly orderDate: Date }, workOrderCurrency: string): Promise<OrderRate> {
  const day = order.issuedAt ? businessDate(order.issuedAt) : order.orderDate.toISOString().slice(0, 10)
  const rate = await dayRate(db, workOrderCurrency, order.currency, day)
  return rate ? { rate, words: null } : { rate: null, words: noRateWords(workOrderCurrency, order.currency, day) }
}

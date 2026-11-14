import { ConflictError } from '@nexus/factory-domain/core/errors'
import { companyValueOf, takesRate } from '@nexus/factory-domain/purchasing/po-depth/currency'
import type { CommandTools } from '../../../core/command'
// B-W2b-389 (CY1:01): the day's rate of the rates table.
import { businessDate } from '@nexus/factory-domain/core/time'
import { rateWords } from '@nexus/factory-domain/money/currency/rates'
import { dayRate } from '../../../platform/currency/service'

/**
 * B-W2b-296 (SCM-065): the value in the company's currency of a DRAFT order in another currency, at its rate at order:
 * written again whenever the order's total is (orders.ts refreshTotal: every line write, and the send itself), so it is
 * the sent total's value when the order leaves (then it is frozen with the terms). Nothing when the order has no rate or
 * is no draft. Kept apart from po-depth/currency.ts (the rate's own command) so orders.ts imports no command module.
 */
export async function refreshCompanyValue(tools: Pick<CommandTools, 'tx'>, orderId: string, netAmount: number): Promise<number | null> {
  const row = await tools.tx.purchaseOrder.findUnique({ where: { id: orderId }, select: { status: true, currency: true, companyId: true, rateAtOrder: true, companyNetAmount: true } })
  if (!row || row.status !== 'DRAFT' || row.rateAtOrder === null) return row?.companyNetAmount ?? null
  const company = await tools.tx.company.findUniqueOrThrow({ where: { id: row.companyId }, select: { currency: true } })
  let value: number
  try {
    value = companyValueOf(netAmount, row.currency, row.rateAtOrder.toString(), company.currency)
  } catch {
    throw new ConflictError(`At the rate at order the order is worth more in ${company.currency} than one order can hold: check the rate.`)
  }
  if (value !== row.companyNetAmount) await tools.tx.purchaseOrder.update({ where: { id: orderId }, data: { companyNetAmount: value }, select: { id: true } })
  return value
}

/**
 * B-W2b-389 (CY1:01): a DRAFT order in another currency with no rate typed takes the day's rate of the rates table as its
 * rate at order, in the send's own command (before its total and value are written and frozen): 1 <company currency> =
 * rate <order currency> of the send's day (or the last day before it with a rate), recorded on an audit row with where it
 * came from. A typed rate stays (it is the override). None kept: nothing is written (the send's checks refused it already).
 */
export async function takeDayRate(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, orderId: string): Promise<void> {
  const row = await tools.tx.purchaseOrder.findUnique({ where: { id: orderId }, select: { status: true, currency: true, companyId: true, siteId: true, rateAtOrder: true } })
  if (!row || row.status !== 'DRAFT' || row.rateAtOrder !== null) return
  const company = await tools.tx.company.findUniqueOrThrow({ where: { id: row.companyId }, select: { currency: true } })
  if (!takesRate(row.currency, company.currency)) return
  const rate = await dayRate(tools.tx, company.currency, row.currency, businessDate(tools.now))
  if (!rate) return
  await tools.tx.purchaseOrder.update({ where: { id: orderId }, data: { rateAtOrder: rate.rate, companyNetAmount: 0 }, select: { id: true } })
  tools.audit({ action: 'purchasing.rate', recordType: 'PurchaseOrder', recordId: orderId, companyId: row.companyId, siteId: row.siteId, before: { rateAtOrder: null }, after: { rateAtOrder: rate.rate, rate: rateWords(rate), rateDate: rate.rateDate, source: rate.source, taken: 'DAY_RATE' } })
}

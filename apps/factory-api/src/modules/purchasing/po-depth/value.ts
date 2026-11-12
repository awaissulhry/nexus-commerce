import { ConflictError } from '@nexus/factory-domain/core/errors'
import { companyValueOf } from '@nexus/factory-domain/purchasing/po-depth/currency'
import type { CommandTools } from '../../../core/command'

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

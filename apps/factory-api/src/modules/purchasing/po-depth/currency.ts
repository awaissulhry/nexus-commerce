import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { rateProblem, rateWords, takesRate } from '@nexus/factory-domain/purchasing/po-depth/currency'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { assertDraft, onOrder } from '../orders'
import { officeOrder } from '../store'
import { depthOf, type DepthView } from './read'
import { refreshCompanyValue } from './value'

/**
 * A purchase order in the supplier's currency (B-W2b-296; SCM-065): the buyer types the rate at order on a DRAFT in a
 * currency other than its company's (ONE command on the order, its version guards it); the order's value in the
 * company's currency is worked out at it (factory-domain purchasing/po-depth/currency) and kept current with every line
 * write until the send freezes both. null takes the rate away (the send then asks for one again). The rate table of
 * W2b-6 will fill it; GATE-ACCOUNTANT: the rate at order is the default the books use (the accountant may ask for the
 * rate at the invoice: that is the invoice's own matter).
 *
 *   PUT /purchasing/orders/:purchaseOrderId/rate {version, rateAtOrder | null}    purchasing.manage
 */
export async function putRate(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly rateAtOrder: string | null }, idempotencyKey?: string): Promise<{ depth: DepthView }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.rate', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    assertDraft(current)
    const { tx } = tools
    const company = await tx.company.findUniqueOrThrow({ where: { id: current.companyId }, select: { currency: true } })
    if (!takesRate(current.currency, company.currency)) throw new ConflictError(`The order is in ${current.currency}, the company's own currency: it takes no rate at order.`)
    const before = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: current.id }, select: { rateAtOrder: true, companyNetAmount: true } })
    const typed = body.rateAtOrder === null ? null : body.rateAtOrder.trim()
    if (typed !== null) {
      const problem = rateProblem(typed)
      if (problem) throw new ValidationError(problem, [{ path: 'body/rateAtOrder', message: problem }])
    }
    const rate = typed === null ? null : new Dec(typed).toFixed(8)
    if (rate === null) await tx.purchaseOrder.update({ where: { id: current.id }, data: { rateAtOrder: null, companyNetAmount: null }, select: { id: true } })
    // The value is worked out from the order's total at the new rate (value.ts, as every line write does).
    else await tx.purchaseOrder.update({ where: { id: current.id }, data: { rateAtOrder: rate, companyNetAmount: 0 }, select: { id: true } })
    const value = rate === null ? null : await refreshCompanyValue(tools, current.id, current.netAmount)
    tools.audit({
      action: 'purchasing.rate',
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { rateAtOrder: before.rateAtOrder === null ? null : before.rateAtOrder.toString(), companyNetAmount: markMoney('cost', before.companyNetAmount) },
      after: { rateAtOrder: rate, rate: rate === null ? null : rateWords(rate, current.currency, company.currency), companyNetAmount: markMoney('cost', value) },
    })
    tools.emit({ type: 'purchase_order.updated', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, fields: ['rateAtOrder', 'companyNetAmount'] } })
    return { depth: await depthOf(tx, current.id) }
  })
}

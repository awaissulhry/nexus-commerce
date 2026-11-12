import { asMoney } from '@nexus/factory-domain/money/marked'
import { FEE_CREDIT_AGAINST_BULK } from '@nexus/factory-domain/sales/price-waterfall/rules'
import type { SalesFeeKind, SalesLineKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller } from '../../../core/command'
import { officeOrder } from '../orders/moves'
import { decimal } from '../quotes/store'
import { feesBilledOf } from './fee-invoicing'
import { priceReasonLabels, storedSteps, waterfallView } from './quote-price'

/**
 * GET /sales/orders/:orderId/pricing (orders.view; B-W2b-330, SAL-174, SAL-181; design order › lines): each line's
 * waterfall as the order keeps it (copied from the accepted quote line at make-order; dropped by the database when an
 * amendment changes the price without it) and in words, and for a fee the invoice that bills it (once) — the price grain.
 */
export async function orderPricing(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const lines = await client.salesOrderLine.findMany({
      where: { orderId: order.id },
      select: { id: true, seq: true, kind: true, feeKind: true, quantity: true, unitPrice: true, priceSteps: true, description: true },
      orderBy: { seq: 'asc' },
    })
    const label = await priceReasonLabels(client)
    const fees = await feesBilledOf(client, lines.filter((line) => line.kind === 'FEE').map((line) => line.id))
    return {
      orderId: order.id,
      currency: order.currency,
      lines: lines.map((line) => {
        const unitPrice = decimal(line.unitPrice)!
        const view = waterfallView(storedSteps(line.priceSteps), unitPrice, null, order.currency, label)
        const billed = fees.filter((row) => row.salesOrderLineId === line.id)
        return {
          lineId: line.id,
          seq: line.seq,
          kind: line.kind as SalesLineKind,
          feeKind: (line.feeKind ?? null) as SalesFeeKind | null,
          description: line.description,
          quantity: line.quantity,
          unitPrice: asMoney('price', unitPrice),
          steps: view.steps,
          why: view.why,
          stepsProblem: view.problem,
          fee:
            line.kind === 'FEE'
              ? {
                  invoices: billed.map((row) => ({ invoiceId: row.invoiceId, number: row.number, draft: row.draft })),
                  invoiced: billed.some((row) => !row.draft),
                  creditAgainstBulk: { enabled: FEE_CREDIT_AGAINST_BULK.enabled, words: FEE_CREDIT_AGAINST_BULK.words },
                }
              : null,
        }
      }),
    }
  })
}

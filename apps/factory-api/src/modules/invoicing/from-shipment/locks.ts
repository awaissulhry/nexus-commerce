import type { CommandTx } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { tenantOf } from '../../payments/locks'

/**
 * The invoicing module's own advisory locks (transaction-scoped, like payments/locks.ts; no trigger takes them):
 *
 *   'ddt'    one per DDT: making a draft from DDTs and issuing an invoice whose lines name DDTs take the locks of those
 *            DDTs (id order) before they count what is invoiced, so one DDT is never billed twice by two drafts made at
 *            once, nor by two invoices issued at once. The issue takes them right after its own invoice row, before the
 *            money locks and the series.
 *   'order'  one per sales order: every command that may settle or unsettle an order (a payment allocated or taken
 *            back, an SDI outcome, an issue) takes it at the END of its work, after all of its writes and other locks
 *            (settlement.ts settleOrders), reads whether the order is settled and what was last announced, and announces
 *            a change once. Nothing waits for another lock while holding it.
 * The order: invoice row → 'ddt' → money locks (payment → deposit requests → invoices) → the number series → 'order'.
 */

export type InvoicingLock = 'ddt' | 'order'

export async function lockInvoicing(tx: CommandTx, context: RequestContext, what: InvoicingLock, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', ${`factory.invoicing.${what}`}::text, ${tenantOf(context)}::uuid, ${id}::uuid), 0))`
  }
}

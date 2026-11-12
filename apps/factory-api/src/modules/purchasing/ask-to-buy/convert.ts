import type { CommandTools } from '../../../core/command'
import { StaleVersionError } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import type { Built } from '../requests/build'

/**
 * B-W2b-332: requests asked in the office (kind ASKED of the buyer's queue) become CONVERTED with the purchase order line
 * just drafted for each, inside the conversion's command (requests/convert.ts "Draft POs for n", and "Draft a purchase
 * order now" from a shortage). The caller held each request's row (FOR UPDATE) before it was built; the version read is
 * compared here once more, so a request taken back meanwhile refuses the whole batch. The database writes the conversion
 * once, of a line of the request's own material on its site.
 */
export async function markConverted(tools: CommandTools, context: OfficeContext, asked: readonly Built[], made: readonly { readonly key: string; readonly purchaseOrderId: string; readonly purchaseOrderLineId: string }[]): Promise<void> {
  for (const entry of asked) {
    const line = made.find((item) => item.key === entry.id)
    if (!line || !entry.asked) continue
    const { count } = await tools.tx.purchaseRequest.updateMany({
      where: { id: entry.refId, version: entry.version, status: 'OPEN' },
      data: { status: 'CONVERTED', convertedAt: tools.now, convertedById: context.actorId, purchaseOrderLineId: line.purchaseOrderLineId, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (count !== 1) throw new StaleVersionError('PurchaseRequest', entry.refId, entry.version + 1, entry.version)
    tools.audit({ action: 'purchasing.askToBuy.converted', recordType: 'PurchaseRequest', recordId: entry.refId, companyId: entry.companyId, siteId: entry.siteId, before: { status: 'OPEN' }, after: { status: 'CONVERTED', purchaseOrderId: line.purchaseOrderId, purchaseOrderLineId: line.purchaseOrderLineId } })
    tools.emit({
      type: 'purchase_requests.status_changed',
      subject: entry.refId,
      companyId: entry.companyId,
      siteId: entry.siteId,
      payload: { purchaseRequestId: entry.refId, siteId: entry.siteId, from: 'OPEN', to: 'CONVERTED', purchaseOrderId: line.purchaseOrderId, requestedById: entry.asked.request.requestedById },
    })
  }
}

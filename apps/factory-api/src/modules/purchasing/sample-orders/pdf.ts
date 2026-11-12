import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { notASampleOrder } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import type { CommandCaller } from '../../../core/command'
import { storeCall } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { previewOrderPdf } from '../send'
import { officeContextOf, officeOrder, seesCost } from '../store'
import { readSampleFacts, SampleOrderRefusedError } from './store'

/**
 * GET /purchasing/sample-orders/:purchaseOrderId/pdf (purchasing.view + the cost grain: it prints the prices; design
 * purchasing.sourcing tab "Sample order PDF — the document sent to the supplier", a new tab): once the order was sent, the
 * PDF exactly as the supplier got it (its newest stored copy, FISCAL_ARCHIVE); before, the order as the supplier would get it
 * today — W1's preview (send.ts previewOrderPdf), which a sample order composes as the sample order (sample-orders/document.ts)
 * with the preview banner, in the language asked (default the supplier's). Never a production order: 409 NOT_A_SAMPLE_ORDER.
 */
export async function sampleOrderPdf(caller: CommandCaller, orderId: string, language: 'it' | 'en' | undefined): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  if (!seesCost(context)) throw new ForbiddenError('The sample order’s PDF prints its prices: it needs the cost grain.')
  const sent = await caller.withClient(async (client) => {
    if (!(await readSampleFacts(client, order.id))) throw new SampleOrderRefusedError(notASampleOrder(order.number))
    if (order.sentAt === null) return null
    return client.storedFile.findFirst({
      where: { recordType: 'PurchaseOrder', recordId: order.id, kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE', contentType: 'application/pdf' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { originalName: true, sizeBytes: true, storeAccountId: true, storageKey: true },
    })
  })
  if (sent) {
    const bytes = await storeCall(() => processFiles().storage.read(caller, sent.storeAccountId, sent.storageKey, sent.sizeBytes + 1))
    // A stored copy the store no longer holds: the order as it would be sent today (with the preview banner), never a 500.
    if (bytes) return { pdf: bytes, fileName: sent.originalName }
  }
  return previewOrderPdf(caller, order.id, language)
}

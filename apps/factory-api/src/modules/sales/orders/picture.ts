import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { processFiles } from '../../../platform/files/service'
import { hasSmallPreview, smallPreviewAddress } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import { assertMay, officeContextOf } from './access'

/**
 * The Picture cell of Sales › Orders (B-TH-017 with B-TH-063; feature O-SAL-ORD-LIST.grid-F01): GET
 * /sales/orders/:orderId/picture answers a presigned GET (60 seconds) of the SMALL preview (~320 px) of the main picture of
 * the order's first line's style — the picture the row names — never the original. The order as the list shows it
 * (orders.view over its company and customer, else 404), the file with files.read over its company (else 404, as the row
 * names no file then). `small` is null while the preview does not exist yet (the cell shows its placeholder; the job that
 * makes the stripped copy makes it, platform/files/thumbs/small.ts). The File viewer opens the original through
 * GET /files/:fileId/preview.
 */
export async function orderPicture(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const found = await caller.withClient(async (client) => {
    const order = isUuid(orderId) ? await client.salesOrder.findUnique({ where: { id: orderId }, select: { companyId: true, partyId: true } }) : null
    assertMay(context, ORDERS_VIEW, order)
    const first = await client.salesOrderLine.findFirst({ where: { orderId }, orderBy: { seq: 'asc' }, select: { styleId: true } })
    const thumbnail = first ? (await mainPictureThumbnails(client, actor, [first.styleId])).get(first.styleId) : undefined
    const file = thumbnail ? await client.storedFile.findUnique({ where: { id: thumbnail.fileId }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } }) : null
    return first && file ? { styleId: first.styleId, file } : null
  })
  if (!found) throw new NotFoundError('This order has no picture to show.')
  const { styleId, file } = found
  // The store is called outside the read (the gateway writes its own ledger row).
  const small = hasSmallPreview(file) ? await smallPreviewAddress(processFiles(), caller, { storeAccountId: file.storeAccountId, thumbnailKey: file.thumbnailKey!, contentType: file.contentType, originalName: file.originalName }) : null
  return { picture: { fileId: file.id, styleId, contentType: file.contentType, small } }
}

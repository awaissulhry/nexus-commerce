import type { Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { orderLifeOf } from '@nexus/factory-domain/sales/order-life'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { StillOpenKind } from '@nexus/factory-domain/sales/portal-ordering/still-open'
import type { RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { hasSmallPreview } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import { draftStillOpen, sheetLinesOf, shipToInUseOf } from '../portal-ordering/people'
import { readDraftFiles, readLines, readPeople, readRequest } from '../portal-ordering/store'
import { assertSees, mayOn, officeContextOf } from './access'

/**
 * owb-of1 step 2 (order workflow, plan.md § 5i "the band", settle L3: Draft and Sent orders keep today's office page
 * /sales/orders/new?draft=<id>; web B of5 frames it with the order band): GET /sales/orders/requests/:requestId/band — the band of a
 * Draft or Sent order (a PortalOrderRequest): its number (RQ-…, null while never sent), subject, customer, life word, picture,
 * what is still open, and what the reader may do. Confirm stays today's POST /sales/order-requests/:id/confirm (its body has
 * `promiseDate`): no new command. It reads S1's portal-ordering store and Still-open helpers, never changes them.
 *
 *   who      orders.view over the request's company and customer, or orders.view.own while the person is on it (on-the-order.ts);
 *            else 404 — the same words as an unknown id
 *   open     factory-domain portal-ordering stillOpenOf (PRODUCT · SIZING · COLOUR · PIECES · CHOICE on the lines, DATE · SHIP_TO
 *            on the draft): `count` = what is not decided; `lines` = the lines' open items as the band says them (a colour or a
 *            choice is MATERIAL, a sizing SIZES); `confirmHeld` = the one stop that stays (settle L1, A-5): a line without a product,
 *            or no line at all — Confirm then needs the product picked first
 *   may      confirm: the request is a Draft or Sent and the reader holds orders.manage over it (the confirm route's own right);
 *            picture: the same right (the picture route's, POST /sales/order-requests/:id/picture) while Draft or Sent
 * No price field.
 */

const WHAT_OF: Readonly<Partial<Record<StillOpenKind, 'PRODUCT' | 'MATERIAL' | 'SIZES' | 'PIECES'>>> = Object.freeze({ PRODUCT: 'PRODUCT', COLOUR: 'MATERIAL', CHOICE: 'MATERIAL', SIZING: 'SIZES', PIECES: 'PIECES' })

/** GET /sales/orders/requests/:requestId/band (see the file's head). */
export async function requestBand(caller: CommandCaller, requestId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const row = await readRequest(client, requestId)
    await assertSees(client, context, ORDERS_VIEW, row, { requestId }, 'Order request')
    const request = row!
    const scope = { companyId: request.companyId, partyId: request.partyId }
    const own = await client.portalOrderRequest.findUnique({ where: { id: request.id }, select: { pictureFileId: true, party: { select: { code: true, legalName: true } } } })
    const lines = await readLines(client, [request.id]) // the live lines (a line taken out is left out by S1's readLines)
    const people = await readPeople(client, [request.id])
    const files = await readDraftFiles(client, [request.id], lines.map((line) => line.id))
    const addresses = await client.partyAddress.findMany({ where: { partyId: request.partyId }, select: { id: true, status: true, isDefaultShipTo: true } })
    const open = draftStillOpen(lines, people, request, shipToInUseOf(request, addresses), today, undefined, sheetLinesOf(files))
    const openLines = open.items.flatMap((item) => {
      const what = WHAT_OF[item.kind]
      return item.state !== 'DECIDED' && item.lineId !== null && item.seq !== null && what ? [{ lineId: item.lineId, seq: item.seq, what }] : []
    })
    // The picture: the request's own (one the reader may open), else its first line's design picture.
    let picture: { fileId: string; contentType: string; small: boolean } | null = null
    if (can(actor, FILES_READ, { companyId: request.companyId })) {
      const chosen = own?.pictureFileId
        ? await client.storedFile.findFirst({ where: { AND: [scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as Prisma.StoredFileWhereInput, { id: own.pictureFileId, status: 'AVAILABLE' }] }, select: { id: true, contentType: true, thumbnailKey: true } })
        : null
      const styleId = [...lines].sort((a, b) => a.seq - b.seq).find((line) => line.styleId !== null)?.styleId ?? null
      const thumbnail = !chosen && styleId ? (await mainPictureThumbnails(client, actor, [styleId])).get(styleId) : undefined
      const file = chosen ?? (thumbnail ? await client.storedFile.findUnique({ where: { id: thumbnail.fileId }, select: { id: true, contentType: true, thumbnailKey: true } }) : null)
      if (file) picture = { fileId: file.id, contentType: file.contentType, small: hasSmallPreview(file) }
    }
    const live = request.status === 'DRAFT' || request.status === 'SENT'
    const mayManage = mayOn(context, ORDERS_MANAGE, scope)
    return {
      id: request.id,
      version: request.version,
      number: request.number,
      subject: request.subject,
      party: { id: request.partyId, code: own?.party.code ?? '', name: own?.party.legalName ?? '' },
      life: orderLifeOf({ request: { status: request.status as RequestStatus } }).life,
      picture,
      open: { count: open.openCount, confirmHeld: lines.length === 0 || lines.some((line) => line.styleId === null), lines: openLines },
      may: { confirm: live && mayManage, picture: live && mayManage },
    }
  })
}

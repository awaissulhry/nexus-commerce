import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { systemCallerOf } from '../../../platform/files/files'
import { linePictureKey, PICTURES_MAX, portalLinePictureFiles, smallAddresses, type LinePictureFile, type PresignFile } from '../../product/images/small-pictures'
import { contentWalledFor } from '../../../platform/files/content-wall' // owb- (b3.2)
import { portalReader } from './access'

/**
 * pg-s2 S2.1 (portal grid D4, Z12, H6): POST /portal/sales-orders/pictures {orderIds 1–200, each once} — the small picture of each of
 * the customer's OWN orders among the ids, for the picture column of Portal › Orders (the face of the office's Work tab), in the one
 * answer shape of the office's batch reads (product/images/small-pictures smallPicturesView; the web's lib/record-picture):
 *
 *   which orders   the PARTNER read finds the party's own orders among the ids (row-level security: the party's rows only, in the
 *                  portal's company); an id that is none of them — another customer's, an unknown one — is simply absent: no 404,
 *                  no count, nothing that says it exists
 *   which picture  the order's first goods line (a fee line has none): its colourway's own picture, else its style's main one, read
 *                  in the tenant's scope for those orders' lines only, through the walled helper portalLinePictureFiles (a style
 *                  of the customer's own label or of our own collection only; the content wall: a picture whose content, or its
 *                  source's, names another customer is left out, uncounted); `styleCount` the order's distinct goods styles
 *   which address  only the SMALL preview (~320 px, the stripped copy), presigned as the tenant's system after the reads; `fileId`
 *                  is always null (the portal never gets an id it could open); `small` null while no preview exists
 * Why a POST, not a field of the list's GET: the addresses live 60 seconds; the list is kept for minutes (Show more, live updates,
 * offline) and the web's picture part reads them again near their expiry.
 *
 * owb- po1.1 (order workflow; design § 5zj A "the picture of an order, from the orders page: a draft and a sent order alike"): the
 * body takes `requestIds` too (the party's Draft and Sent orders: its PortalOrderRequests in DRAFT or SENT, by the partner read) —
 * at least one id of either kind, at most PICTURES_MAX in all. A request's picture is its CHOSEN one first (pictureFileId: shared with
 * the party, past the content wall), else its first live line that names a style and colourway; a request whose only lines are in
 * the customer's words has a style of null (its chosen picture, or no entry at all). The order's chosen picture first is the base's
 * (b3.2), kept as it was.
 */

/** One own order's picture (the office's answer shape; never a file id). */
export interface PortalOrderPicture {
  readonly id: string
  /** owb- po1.1: null only for a Draft or Sent order with no line that names a style (its chosen picture shows). */
  readonly styleId: string | null
  readonly styleCode: string | null
  readonly styleName: string | null
  readonly styleCount: number
  readonly fileId: null
  readonly contentType: string | null
  readonly small: { readonly url: string; readonly expiresAt: string } | null
}

type GoodsLine = { readonly orderId: string; readonly styleId: string; readonly colourwayId: string }

/** POST /portal/sales-orders/pictures (see the module's head). */
export async function orderPictures(app: FastifyInstance, request: FastifyRequest, body: { readonly orderIds: readonly string[]; readonly requestIds: readonly string[] }, now: Date): Promise<{ pictures: PortalOrderPicture[]; asOf: string }> {
  const { orderIds, requestIds } = body
  if (new Set(orderIds).size !== orderIds.length) throw new ValidationError('Each id once: the same order was asked twice.', [{ path: 'body/orderIds', message: 'Each id once.' }])
  // owb- po1.1: the Draft and Sent orders too — at least one id in all, at most PICTURES_MAX.
  if (new Set(requestIds).size !== requestIds.length) throw new ValidationError('Each id once: the same order was asked twice.', [{ path: 'body/requestIds', message: 'Each id once.' }])
  if (orderIds.length + requestIds.length === 0 || orderIds.length + requestIds.length > PICTURES_MAX) throw new ValidationError(`Ask for 1 to ${PICTURES_MAX} orders at once.`, [{ path: 'body', message: `1 to ${PICTURES_MAX} ids in all.` }])
  const reader = portalReader(app, request)
  // The partner's own read: the party's orders among the ids, and their lines in order (row-level security walls both).
  // owb- (b3.2): and each order's chosen picture (pictureFileId: the partner reads it; who set it stays hidden).
  const chosen = new Map<string, string>()
  const lines = await request.withClient(async (client) => {
    if (orderIds.length === 0) return []
    const own = await client.salesOrder.findMany({ where: { companyId: reader.session.company.id, id: { in: [...orderIds] } }, select: { id: true, pictureFileId: true } })
    if (own.length === 0) return []
    for (const order of own) if (order.pictureFileId) chosen.set(order.id, order.pictureFileId)
    return client.salesOrderLine.findMany({ where: { orderId: { in: own.map((order) => order.id) } }, select: { orderId: true, seq: true, kind: true, styleId: true, colourwayId: true }, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] })
  })
  const first = new Map<string, GoodsLine>()
  const stylesOf = new Map<string, Set<string>>()
  for (const line of lines) {
    if (line.kind === 'FEE') continue
    if (!first.has(line.orderId)) first.set(line.orderId, line)
    stylesOf.set(line.orderId, (stylesOf.get(line.orderId) ?? new Set<string>()).add(line.styleId))
  }
  // ---- owb- po1.1: the party's Draft and Sent orders among the request ids (the partner read), their chosen picture and first styled line.
  const requests = await request.withClient(async (client) => {
    if (requestIds.length === 0) return { found: [] as { id: string; pictureFileId: string | null }[], lines: [] as { requestId: string; styleId: string | null; colourwayId: string | null }[] }
    const found = await client.portalOrderRequest.findMany({ where: { companyId: reader.session.company.id, id: { in: [...requestIds] }, status: { in: ['DRAFT', 'SENT'] } }, select: { id: true, pictureFileId: true } })
    const lines = found.length === 0 ? [] : await client.portalOrderRequestLine.findMany({ where: { requestId: { in: found.map((row) => row.id) }, removedAt: null }, select: { requestId: true, styleId: true, colourwayId: true }, orderBy: [{ requestId: 'asc' }, { seq: 'asc' }] })
    return { found, lines }
  })
  for (const row of requests.found) if (row.pictureFileId) chosen.set(row.id, row.pictureFileId)
  const requestFirst = new Map<string, GoodsLine>()
  const requestStyles = new Map<string, Set<string>>()
  for (const line of requests.lines) {
    if (!line.styleId) continue
    requestStyles.set(line.requestId, (requestStyles.get(line.requestId) ?? new Set<string>()).add(line.styleId))
    if (line.colourwayId && !requestFirst.has(line.requestId)) requestFirst.set(line.requestId, { orderId: line.requestId, styleId: line.styleId, colourwayId: line.colourwayId })
  }
  // ---- end owb- po1.1
  const firstLines = [...first.values(), ...requestFirst.values()]
  const partyId = reader.session.partyId
  // The tenant's scope, for those orders' first lines only: the walled pictures, and the names of the styles the customer may see.
  const tenant = await reader.inTenant(async (client) => {
    if (firstLines.length === 0 && chosen.size === 0) return { files: new Map<string, LinePictureFile>(), styles: new Map<string, { readonly code: string; readonly name: string }>(), chosenFiles: new Map<string, PresignFile>() }
    const files = await portalLinePictureFiles(client, partyId, firstLines)
    const styles = await client.style.findMany({ where: { id: { in: [...new Set(firstLines.map((line) => line.styleId))] }, OR: [{ brandPartyId: null }, { brandPartyId: partyId }] }, select: { id: true, code: true, name: true } })
    // owb- (b3.2): the chosen pictures the customer may see — shared with its party, AVAILABLE, past the content wall.
    const chosenIds = [...new Set(chosen.values())]
    const shared = chosenIds.length > 0 ? await client.storedFile.findMany({ where: { id: { in: chosenIds }, status: 'AVAILABLE', partyId, visibility: { has: 'PARTNER' } }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } }) : []
    const walled = shared.length > 0 ? await contentWalledFor(client, partyId, shared.map((file) => file.id)) : new Set<string>()
    const chosenFiles = new Map<string, PresignFile>(shared.filter((file) => !walled.has(file.id)).map((file) => [file.id, file]))
    return { files, styles: new Map(styles.map((style) => [style.id, { code: style.code, name: style.name }])), chosenFiles }
  })
  // The store is called after the reads, as the tenant's system (the partner role holds no store account).
  const presign = [...tenant.files.values(), ...tenant.chosenFiles.values()]
  const addresses = presign.length > 0 ? await smallAddresses(systemCallerOf(request)(reader.session.tenantId), presign) : new Map<string, { url: string; expiresAt: string }>()
  const pictures: PortalOrderPicture[] = []
  // In the asked order (the page's); an id that is not the party's own has no first line here: absent.
  for (const orderId of orderIds) {
    const line = first.get(orderId)
    const style = line ? tenant.styles.get(line.styleId) : undefined
    if (!line || !style) continue
    // owb- (b3.2): the order's chosen picture first (one the customer may see), else its first goods line's.
    const own = chosen.get(orderId)
    const file = (own ? tenant.chosenFiles.get(own) : undefined) ?? tenant.files.get(linePictureKey(line))
    pictures.push({
      id: orderId,
      styleId: line.styleId,
      styleCode: style.code,
      styleName: style.name,
      styleCount: stylesOf.get(orderId)?.size ?? 1,
      fileId: null,
      contentType: file?.contentType ?? null,
      small: file ? (addresses.get(file.id) ?? null) : null,
    })
  }
  // owb- po1.1: the Draft and Sent orders, in the asked order: the chosen picture first, else the first styled line's; none: absent.
  const foundRequests = new Set(requests.found.map((row) => row.id))
  for (const requestId of requestIds) {
    if (!foundRequests.has(requestId)) continue
    const line = requestFirst.get(requestId)
    const own = chosen.get(requestId)
    const ownFile = own ? tenant.chosenFiles.get(own) : undefined
    const style = line ? tenant.styles.get(line.styleId) : undefined
    const file = ownFile ?? (line && style ? tenant.files.get(linePictureKey(line)) : undefined)
    if (!ownFile && !style) continue
    pictures.push({
      id: requestId,
      styleId: style ? line!.styleId : null,
      styleCode: style?.code ?? null,
      styleName: style?.name ?? null,
      styleCount: requestStyles.get(requestId)?.size ?? 0,
      fileId: null,
      contentType: file?.contentType ?? null,
      small: file ? (addresses.get(file.id) ?? null) : null,
    })
  }
  return { pictures, asOf: toUtcIso(now) }
}

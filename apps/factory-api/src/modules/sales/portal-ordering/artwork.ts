import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { optionWords } from '@nexus/factory-domain/documents/options-block'
import { dispositionOf, PREVIEW_URL_SECONDS, previewModeOf, type PreviewMode } from '@nexus/factory-domain/files/preview/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { artworkOf } from '../configurator/artwork'
import { orderLinesPrinted } from '../configurator/printed'
import { officeOrder } from '../orders/moves'
import type { OrderRow } from '../orders/store'
import { partnerOrder, portalReader } from '../portal-orders/access'

/**
 * An option's artwork in the customer's portal (B-W2b-374; XF3:04; B-W2b-340's gap: artwork stayed office only). The
 * customer's artwork on an order line (StoredFile category ARTWORK of the SalesOrderLine, or of the quote line it was made from)
 * is shown in the portal once the office shows it there: the file is then shared with the order's party (visibility PARTNER,
 * partyId; files' own rules, COL-050), so the partner role reads it and nothing else.
 *
 *   PUT  /sales/orders/:orderId/lines/:lineId/artwork/:fileId/portal   orders.manage  {shown}: a file of the line's artwork
 *                                                                     shown in (or taken out of) the portal; FLOOR and LINK
 *                                                                     sharing kept; audit orders.shareArtwork
 *   GET  /portal/sales-orders/:orderId/options                         portal.salesOrders.view  each line's options in words
 *                                                                     (Italian and English) and the artwork shown to the party
 *   POST /portal/sales-orders/:orderId/artwork/:fileId/open            portal.salesOrders.view  {mode}: preview or download,
 *                                                                     logged (one command in the party's scope), presigned 60 s;
 *                                                                     a picture outside the office only without location data
 */

const ARTWORK_LIMIT = 60

/** Whether the person may show an order line's artwork in the portal (who manages the order; not a cancelled one). */
export function mayShareArtwork(context: OfficeContext, order: Pick<OrderRow, 'companyId' | 'partyId' | 'status'>): boolean {
  return order.status !== 'CANCELLED' && can(actorOf(context), ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })
}

// ---- contracts -------------------------------------------------------------------------------------------------------------

const words = () => output({ it: z.string(), en: z.string() })
const artworkFile = output({ fileId: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), createdAt: instant(), portal: z.boolean(), from: z.enum(['LINE', 'QUOTE_LINE']) })

export const shareArtworkContract = defineContract({
  params: input({ orderId: id(), lineId: id(), fileId: id() }),
  body: input({ shown: z.boolean() }),
  response: { 200: output({ artwork: z.array(artworkFile) }) },
})

export const portalOptionsContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      orderId: id(),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          /** Each option as printed ("Ricamo: Nome «BIANCHI»"), in both languages. */
          options: z.array(words()),
          artwork: z.array(output({ fileId: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), picture: z.boolean() })),
        }),
      ),
    }),
  },
})

export const openArtworkContract = defineContract({
  params: input({ orderId: id(), fileId: id() }),
  body: input({ mode: z.enum(['download', 'preview']).default('download') }),
  response: {
    200: output({
      file: output({ fileId: id(), name: z.string(), contentType: z.string() }),
      /** A GET that lives 60 seconds: `inline` opens in place (a PDF or a picture), `download` saves it. */
      download: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

// ---- the office --------------------------------------------------------------------------------------------------------------

/** PUT /sales/orders/:orderId/lines/:lineId/artwork/:fileId/portal (orders.manage): see the file's head. */
export async function shareOrderArtwork(caller: CommandCaller, orderId: string, lineId: string, fileId: string, body: { readonly shown: boolean }, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  if (order.status === 'CANCELLED') throw new InvalidStateError('The order is cancelled: its artwork is not shown in the portal.')
  const { result } = await command(caller, { name: 'orders.shareArtwork', idempotencyKey, input: { orderId, lineId, fileId, ...body } }, async (tools) => {
    const { tx } = tools
    const line = isUuid(lineId) ? await tx.salesOrderLine.findFirst({ where: { id: lineId, orderId: order.id }, select: { id: true, quoteLineId: true } }) : null
    if (!line) throw new NotFoundError('Order line not found.')
    const listed = await artworkOf(tx, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } })
    if (!listed.some((file) => file.fileId === fileId)) throw new NotFoundError('Artwork not found on this line.')
    await tx.$queryRaw`SELECT id FROM "StoredFile" WHERE id = ${fileId}::uuid FOR UPDATE`
    const file = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { id: true, companyId: true, status: true, visibility: true, partyId: true, supersededAt: true } })
    if (file.status !== 'AVAILABLE') throw new ConflictError('This file is not ready yet (still being uploaded or checked): show it in the portal once it is.')
    if (file.partyId !== null && file.partyId !== order.partyId) throw new ConflictError('This file is shared with another party: it is not shown in this customer\'s portal.')
    const shown = file.visibility.includes('PARTNER')
    if (shown !== body.shown) {
      if (body.shown && file.supersededAt !== null) throw new ConflictError('This is an earlier version of the file: it is never shared more widely.')
      const visibility = body.shown ? [...file.visibility, 'PARTNER' as const] : file.visibility.filter((audience) => audience !== 'PARTNER')
      const keepsParty = visibility.includes('PARTNER') || visibility.includes('LINK')
      await tx.storedFile.update({ where: { id: fileId }, data: { visibility, partyId: keepsParty ? order.partyId : null }, select: { id: true } })
      tools.audit({ action: 'orders.shareArtwork', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { fileId, lineId: line.id, portal: shown }, after: { fileId, lineId: line.id, portal: body.shown, partyId: order.partyId } })
    } else tools.audit({ action: 'orders.shareArtwork', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: {}, after: {} })
    return { artwork: (await artworkOf(tx, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } })).map((entry) => ({ fileId: entry.fileId, name: entry.name, contentType: entry.contentType, sizeBytes: entry.sizeBytes, createdAt: entry.createdAt, portal: entry.portal, from: entry.from })) }
  })
  return result
}

// ---- the portal ----------------------------------------------------------------------------------------------------------------

/** The order (the party's, read in its scope) and the artwork of its lines shown to the party (their own and their quote lines'). */
async function sharedArtwork(app: FastifyInstance, request: FastifyRequest, orderId: string) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  // The tenant's reads run in the office scope as the person, only after the partner read found the order (B-W2b-175).
  const read = await reader.inTenant(async (client) => {
    const lines = await client.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true, quoteLineId: true }, orderBy: { seq: 'asc' } })
    const quoteLineIds = lines.flatMap((line) => (line.quoteLineId ? [line.quoteLineId] : []))
    const files =
      lines.length === 0
        ? []
        : await client.storedFile.findMany({
            where: {
              category: 'ARTWORK',
              status: 'AVAILABLE',
              visibility: { has: 'PARTNER' },
              partyId: reader.session.partyId,
              OR: [{ recordType: 'SalesOrderLine', recordId: { in: lines.map((line) => line.id) } }, ...(quoteLineIds.length > 0 ? [{ recordType: 'QuoteLine', recordId: { in: quoteLineIds } }] : [])],
            },
            select: { id: true, recordType: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, storeAccountId: true, storageKey: true, thumbnailKey: true, sha256: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: ARTWORK_LIMIT,
          })
    return { lines, files }
  })
  const quoteLineOf = new Map(read.lines.flatMap((line) => (line.quoteLineId ? [[line.quoteLineId, line.id] as const] : [])))
  const lineOfFile = (file: { readonly recordType: string; readonly recordId: string }): string | null => (file.recordType === 'SalesOrderLine' ? file.recordId : (quoteLineOf.get(file.recordId) ?? null))
  return { reader, order, lines: read.lines, files: read.files, lineOfFile }
}

/** GET /portal/sales-orders/:orderId/options (portal.salesOrders.view): see the file's head. */
export async function portalOrderOptions(app: FastifyInstance, request: FastifyRequest, orderId: string) {
  const found = await sharedArtwork(app, request, orderId)
  const lineIds = found.lines.map((line) => line.id)
  const [it, en] = await found.reader.inTenant((client) => Promise.all([orderLinesPrinted(client, lineIds, 'it'), orderLinesPrinted(client, lineIds, 'en')]))
  return {
    orderId: found.order.id,
    lines: found.lines
      .map((line) => ({
        lineId: line.id,
        seq: line.seq,
        options: (it.get(line.id) ?? []).map((option, index) => ({ it: optionWords(option), en: optionWords((en.get(line.id) ?? [])[index] ?? option) })),
        artwork: found.files.filter((file) => found.lineOfFile(file) === line.id).map((file) => ({ fileId: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, picture: file.contentType.startsWith('image/') })),
      }))
      .filter((line) => line.options.length > 0 || line.artwork.length > 0),
  }
}

/** POST /portal/sales-orders/:orderId/artwork/:fileId/open (portal.salesOrders.view): see the file's head. */
export async function openPortalArtwork(app: FastifyInstance, files: FilesRuntime, request: FastifyRequest, orderId: string, fileId: string, body: { readonly mode: 'download' | 'preview' }, idempotencyKey: string | undefined) {
  const found = await sharedArtwork(app, request, orderId)
  const row = found.files.find((file) => file.id === fileId)
  if (!row) throw new NotFoundError('Artwork not found.')
  await commandOn(app, request, { name: 'portal.artwork.open', idempotencyKey, input: { orderId, fileId, mode: body.mode } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: fileId, companyId: found.reader.session.company.id, after: { mode: body.mode, orderId: found.order.id, lineId: found.lineOfFile(row), sha256: row.sha256 } })
    return { fileId }
  })
  const storeCaller = systemCallerOf(request)(found.reader.session.tenantId)
  const key = await keyShownTo(files, requireContext(request), storeCaller, row)
  const mode: PreviewMode = body.mode === 'preview' ? previewModeOf(row.contentType) : 'download'
  const presigned = await storeCall(() =>
    files.storage.presignDownload(storeCaller, row.storeAccountId, { key, contentType: row.contentType, disposition: dispositionOf(mode, row.originalName), expiresInSeconds: PREVIEW_URL_SECONDS, now: files.clock.now() }),
  )
  return { file: { fileId: row.id, name: row.originalName, contentType: row.contentType }, download: { mode, ...presignedView(presigned), method: 'GET' as const } }
}


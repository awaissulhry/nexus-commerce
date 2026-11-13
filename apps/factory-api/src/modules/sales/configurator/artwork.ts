import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { ArtworkBody } from '@nexus/factory-domain/sales/configurator/contracts'
import { artworkKindOf, artworkTypeProblem, CONFIGURATOR_LIMITS } from '@nexus/factory-domain/sales/configurator/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import type { CommandCaller } from '../../../core/command'
import { requestUpload } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { officeOrder } from '../orders/moves'
import { officeQuote, readCurrentVersion, type Reader } from '../quotes/store'

/**
 * The customer's artwork on a line (B-W2b-340; SAL-140): files of the line (StoredFile recordType QuoteLine or
 * SalesOrderLine, category ARTWORK), a PDF or a picture, office only. Announced here (the category is the module's), sent to
 * the store with the presigned PUT, confirmed with W1's POST /files/:fileId/complete, opened with GET /files/:fileId/download
 * (files.read), removed with DELETE /files/:fileId (files.delete).
 *
 *   POST /sales/quotes/:quoteId/lines/:lineId/artwork    quotes.manage (+ files.upload)  a line of the DRAFT version
 *   POST /sales/orders/:orderId/lines/:lineId/artwork    orders.manage (+ files.upload)  a line of an order not closed
 *
 * A quote line's artwork travels without a copy of the bytes: a line shows its own files and those of the same line (seq and
 * style) on the quote's earlier versions; an order line also those of the quote line it was made from (and its earlier
 * versions). At most CONFIGURATOR_LIMITS.artwork files per line.
 */

const LIVE = ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED'] as const

type Target = { readonly kind: 'QUOTE'; readonly quoteId: string; readonly line: { readonly id: string; readonly seq: number; readonly styleId: string } } | { readonly kind: 'ORDER'; readonly line: { readonly id: string; readonly quoteLineId: string | null } }

/** The same line on the quote's earlier versions (seq and style), newest first. */
async function earlierQuoteLines(db: Reader, quoteId: string, line: { readonly id: string; readonly seq: number; readonly styleId: string }): Promise<string[]> {
  const rows = await db.quoteLine.findMany({ where: { quoteVersion: { quoteId }, seq: line.seq, styleId: line.styleId, id: { not: line.id } }, select: { id: true } })
  return rows.map((row) => row.id)
}

/** The artwork a line shows (its own, then what it came from), newest first. */
export async function artworkOf(db: Reader, target: Target) {
  const own = { recordType: target.kind === 'QUOTE' ? 'QuoteLine' : 'SalesOrderLine', ids: [target.line.id] }
  let upstream: string[] = []
  if (target.kind === 'QUOTE') upstream = await earlierQuoteLines(db, target.quoteId, target.line)
  else if (target.line.quoteLineId) {
    const quoteLine = await db.quoteLine.findUnique({ where: { id: target.line.quoteLineId }, select: { id: true, seq: true, styleId: true, quoteVersion: { select: { quoteId: true } } } })
    if (quoteLine) upstream = [quoteLine.id, ...(await earlierQuoteLines(db, quoteLine.quoteVersion.quoteId, quoteLine))]
  }
  const files = await db.storedFile.findMany({
    where: {
      category: 'ARTWORK',
      status: { in: [...LIVE] },
      OR: [{ recordType: own.recordType, recordId: { in: own.ids } }, ...(upstream.length > 0 ? [{ recordType: 'QuoteLine', recordId: { in: upstream } }] : [])],
    },
    select: { id: true, recordType: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, status: true, createdAt: true, visibility: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: CONFIGURATOR_LIMITS.artwork * 3,
  })
  return files.map((file) => ({
    fileId: file.id,
    name: file.originalName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    createdAt: toUtcIso(file.createdAt),
    from: file.recordType === own.recordType && own.ids.includes(file.recordId) ? ('LINE' as const) : ('QUOTE_LINE' as const),
    // B-W2b-374 (XF3:04): shown in the customer's portal.
    portal: file.visibility.includes('PARTNER'),
  }))
}

function bodyProblems(body: ArtworkBody): void {
  const problem = artworkTypeProblem(body.contentType)
  if (problem) throw new ValidationError(problem, [{ path: 'body/contentType', message: problem }])
}

async function assertRoom(db: Reader, recordType: string, recordId: string): Promise<void> {
  const count = await db.storedFile.count({ where: { recordType, recordId, category: 'ARTWORK', status: { in: [...LIVE] } } })
  if (count >= CONFIGURATOR_LIMITS.artwork) throw new ConflictError(`A line holds at most ${CONFIGURATOR_LIMITS.artwork} artwork files: remove one first.`)
}

/** POST /sales/quotes/:quoteId/lines/:lineId/artwork (quotes.manage): a file announced; its presigned PUT. */
export async function announceQuoteArtwork(files: FilesRuntime, caller: CommandCaller, quoteId: string, lineId: string, body: ArtworkBody, idempotencyKey?: string) {
  bodyProblems(body)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  await caller.withClient(async (db) => {
    const version = await readCurrentVersion(db, quote)
    const line = isUuid(lineId) ? await db.quoteLine.findFirst({ where: { id: lineId, versionId: version.id }, select: { id: true, kind: true } }) : null
    if (!line) throw new NotFoundError('Quote line not found.')
    if (version.status !== 'DRAFT') throw new InvalidStateError('The quote is not a draft: its lines take artwork only while it is a draft (make a new version).')
    if (line.kind === 'FEE') throw new InvalidStateError('A fee takes no artwork.')
    await assertRoom(db, 'QuoteLine', line.id)
  })
  return requestUpload(files, caller, { companyId: quote.companyId, recordType: 'QuoteLine', recordId: lineId, kind: artworkKindOf(body.contentType), category: 'ARTWORK', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 }, idempotencyKey)
}

/** POST /sales/orders/:orderId/lines/:lineId/artwork (orders.manage): a file announced; its presigned PUT. */
export async function announceOrderArtwork(files: FilesRuntime, caller: CommandCaller, orderId: string, lineId: string, body: ArtworkBody, idempotencyKey?: string) {
  bodyProblems(body)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  if (order.status === 'CANCELLED' || order.status === 'CLOSED') throw new InvalidStateError(`The order is ${order.status}: its lines take no more artwork.`)
  await caller.withClient(async (db) => {
    const line = isUuid(lineId) ? await db.salesOrderLine.findFirst({ where: { id: lineId, orderId: order.id }, select: { id: true, kind: true } }) : null
    if (!line) throw new NotFoundError('Order line not found.')
    if (line.kind === 'FEE') throw new InvalidStateError('A fee takes no artwork.')
    await assertRoom(db, 'SalesOrderLine', line.id)
  })
  return requestUpload(files, caller, { companyId: order.companyId, recordType: 'SalesOrderLine', recordId: lineId, kind: artworkKindOf(body.contentType), category: 'ARTWORK', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 }, idempotencyKey)
}

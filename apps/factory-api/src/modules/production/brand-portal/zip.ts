import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, isDomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PRODUCTION_ZIP, PRODUCTION_ZIP_WORDS, productionZipFolders, productionZipName, productionZipPaths, productionZipProblem, type ProductionZipRefusal } from '@nexus/factory-domain/production-brand/approve-zip'
import { ORDER_NOT_FOUND_WORDS } from '@nexus/factory-domain/production-brand/words'
import { KIND_RULES as DOCUMENT_KIND_RULES } from '@nexus/factory-domain/sales/portal-documents/library'
import { requireContext } from '../../../core/context'
import { walledForOutside } from '../../../platform/files/content-wall'
import { storeCall, systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { indexCsv, writeZip, type ZipEntry } from '../../accounting/guest/zip'
import { INVOICE_KINDS } from '../../sales/portal-documents/download'
import { DOWNLOAD_ACTION, readLibrary, visibleEntries, type FileRef, type LibraryEntry } from '../../sales/portal-documents/library'
import { STORE_SELECT, type StoreRow } from '../../sales/portal-documents/store'
import { portalReader } from '../../sales/portal-orders/access'
import { partnerOrders, type OwnOrder } from './access'

/**
 * B-PR-46b — "Download files" of N orders on My production (production plan §5 bulk bar "More ▾ … Download files (confirmations
 * only for roles that see prices)"; lead pick L26; review fix R-52; wall test PW-12; the Owner rule 2026-11-16: "One brand must not
 * be able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it
 * all as well.").
 *
 *   POST /portal/production/files/zip {orderIds 1–50}   (portal.customerDocuments.view, never a preview) ONE zip of the files the
 *        portal's document library lists for those orders BY ROLE (modules/sales/portal-documents library: what we shared with the
 *        customer on the order, its lines, its shipments and their papers, its invoices for a finance role; an order confirmation
 *        or a quote only with the price grain — a Production person never gets one), the current version of each, in a folder per
 *        order named as the customer knows it (fix-pr-5, lead decision: its PO, else "Your order 13"; never the office's SO-…
 *        series; the zip's own name and the index the same), with an index.csv first (path, what, order, date, SHA-256, bytes,
 *        whether the bytes were there) — through the
 *        accountant zip's writer (accounting/guest/zip writeZip) and within its limits (400 files, 100 MB, 25 MB a file: 409 in
 *        words). A picture is zipped as the copy without camera or location data (as every portal download: files thumbs/outside).
 *        Each file zipped is logged as a download of the library (customerDocuments.download, mode zip: "downloads logged", and
 *        no longer NEW), and the zip once on the customer (audit portal.productionZip).
 *
 * The wall (PW-12): the orders are read in the PARTNER scope first (./access.ts partnerOrders): an id that is not one of its own
 * orders is neither read nor named, only counted; none of its own: 404 "Order not found.". The library is read in the partner's
 * scope and its rules (its own shared files and invoices only); then every file's content is checked against the customer
 * (platform/files content-wall: a copy of another customer's file never enters the zip, nor its index) — as the tenant's system,
 * outside the customer's own transaction. A file the store cannot read is named in the index as not included; none at all: 409.
 */

export interface ProductionZipBody {
  readonly orderIds: readonly string[]
}

/** A zip refusal in words (`problem/<CODE>`), the accountant zip's shape. */
const zipRefusal = (code: ProductionZipRefusal): DomainError => new DomainError('conflict', PRODUCTION_ZIP_WORDS[code].en, [{ path: `problem/${code}`, message: PRODUCTION_ZIP_WORDS[code].en }])

/** The ids named twice (400: the bulk bar sends each order once). */
function twiceProblems(orderIds: readonly string[]): Issue[] {
  const seen = new Set<string>()
  const issues: Issue[] = []
  orderIds.forEach((orderId, index) => {
    if (seen.has(orderId)) issues.push({ path: `body/orderIds/${index}`, message: 'This order is named twice.' })
    seen.add(orderId)
  })
  return issues
}

/** One file of the zip: the document it is of, the order whose folder holds it. */
interface Picked {
  readonly entry: LibraryEntry
  readonly file: FileRef
  readonly order: OwnOrder
}

/** Each file's bytes (a few at a time) as a portal download serves it; null: not in the store, or not shown outside the office. */
async function readBytes(files: FilesRuntime, request: FastifyRequest, tenantId: string, picked: readonly Picked[], rows: ReadonlyMap<string, StoreRow>): Promise<(Buffer | null)[]> {
  const storeCaller = systemCallerOf(request)(tenantId)
  const context = requireContext(request)
  const out: (Buffer | null)[] = new Array<Buffer | null>(picked.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < picked.length) {
      const at = next++
      const row = rows.get(picked[at]!.file.fileId)
      if (!row || row.status !== 'AVAILABLE') continue
      try {
        const key = await keyShownTo(files, context, storeCaller, row)
        out[at] = await storeCall(() => files.storage.read(storeCaller, row.storeAccountId, key, PRODUCTION_ZIP.fileBytes))
      } catch (error) {
        // A picture that cannot be shown outside the office (or whose bytes are gone): left out, named in the index as not included.
        if (isDomainError(error) && (error.code === 'conflict' || error.code === 'not_found')) continue
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, picked.length) }, worker))
  return out
}

/** POST /portal/production/files/zip: the zip's bytes (an attachment). */
export async function productionZip(app: FastifyInstance, files: FilesRuntime, request: FastifyRequest, reply: FastifyReply, body: ProductionZipBody) {
  const twice = twiceProblems(body.orderIds)
  if (twice.length > 0) throw new ValidationError('Name each order once.', twice)
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  const { orders, notFound } = await partnerOrders(request, reader, body.orderIds)
  if (orders.length === 0) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)
  const now = appClock(app).now()

  // What the library lists for these orders by the person's role: each document's current version, every file of it (an invoice's
  // PDF and XML), in the order's folder (the first picked order it belongs to).
  const library = await readLibrary(app, request, now)
  const listed: Picked[] = visibleEntries(library)
    .filter((entry) => entry.replacedById === null)
    .flatMap((entry) => {
      const order = orders.find((own) => entry.orderIds.includes(own.orderId))
      return order ? entry.files.map((file) => ({ entry, file, order })) : []
    })
    .sort((a, b) => a.order.index - b.order.index || a.entry.date.getTime() - b.entry.date.getTime() || a.file.fileId.localeCompare(b.file.fileId))
  // The wall on the content: a copy whose source is another customer's never enters the zip, nor its index (not counted).
  const walled = await walledForOutside(request, listed.map((pick) => pick.file.fileId))
  const picked = listed.filter((pick) => !walled.has(pick.file.fileId))
  const problem = productionZipProblem(picked.map((pick) => ({ sizeBytes: pick.file.sizeBytes })))
  if (problem) throw zipRefusal(problem)

  // The objects: a shared file in the party's own scope; an invoice's office-only PDF or XML in the tenant's (its invoice was found
  // in the party's scope by the library).
  const sharedIds = picked.filter((pick) => !INVOICE_KINDS.includes(pick.entry.kind)).map((pick) => pick.file.fileId)
  const invoiceIds = picked.filter((pick) => INVOICE_KINDS.includes(pick.entry.kind)).map((pick) => pick.file.fileId)
  const shared = sharedIds.length === 0 ? [] : await request.withClient((client) => client.storedFile.findMany({ where: { id: { in: sharedIds } }, select: STORE_SELECT }))
  const invoices = invoiceIds.length === 0 ? [] : await reader.inTenant((client) => client.storedFile.findMany({ where: { id: { in: invoiceIds } }, select: STORE_SELECT }))
  const rows = new Map([...shared, ...invoices].map((row) => [row.id, row]))
  const bytes = await readBytes(files, request, reader.session.tenantId, picked, rows)
  const included = bytes.map((entry) => entry !== null)
  if (!included.some(Boolean)) throw zipRefusal('FILE_UNAVAILABLE')

  const locale = reader.session.person.locale.toLowerCase().startsWith('en') ? 'en' : 'it'
  // fix-pr-5 (lead decision): each order by its own name (its PO, else "Your order 13"), never the office's series.
  const folders = productionZipFolders(orders, locale)
  const folderOf = new Map(orders.map((order, at) => [order.orderId, folders[at]!]))
  const paths = productionZipPaths(picked.map((pick) => ({ folder: folderOf.get(pick.order.orderId)!, name: pick.file.name })))
  const index = indexCsv(
    picked.map((pick, at) => ({
      path: paths[at]!,
      what: `${DOCUMENT_KIND_RULES[pick.entry.kind].words[locale]} · ${pick.entry.title[locale]}`,
      number: folderOf.get(pick.order.orderId)!,
      date: businessDate(pick.entry.date),
      // The bytes zipped (a picture's copy without location data is not the original's bytes).
      sha256: bytes[at] ? createHash('sha256').update(bytes[at]!).digest('hex') : pick.entry.sha256,
      sizeBytes: bytes[at]?.length ?? pick.file.sizeBytes,
      included: included[at]!,
    })),
  )
  const entries: ZipEntry[] = [{ path: 'index.csv', bytes: index }, ...picked.flatMap((_, at) => (bytes[at] ? [{ path: paths[at]!, bytes: bytes[at]! }] : []))]
  const zip = writeZip(entries, now)
  const name = productionZipName(folders, businessDate(now))
  const companyId = reader.session.company.id
  const zipped = picked.filter((_, at) => included[at])
  // No Idempotency-Key (as the accountant's zip): a read; a second download is logged again.
  await commandOn(app, request, { name: 'portal.productionZip', input: { orderIds: orders.map((order) => order.orderId), fileIds: zipped.map((pick) => pick.file.fileId) } }, async (tools) => {
    // Each file zipped is a download of the library (QHS-111 "downloads logged"; it is no longer NEW for the person).
    for (const pick of zipped) {
      tools.audit({
        action: DOWNLOAD_ACTION,
        recordType: 'StoredFile',
        recordId: pick.file.fileId,
        companyId,
        after: { mode: 'zip', kind: pick.entry.kind, title: pick.entry.title.en, version: pick.entry.version, sha256: pick.entry.sha256, format: pick.file.format, for: pick.entry.for ? { type: pick.entry.for.type, id: pick.entry.for.id } : null },
      })
    }
    tools.audit({
      recordType: 'Party',
      recordId: reader.session.partyId,
      companyId,
      after: { name, orders: orders.map((order) => ({ orderId: order.orderId, number: order.number })), files: picked.length, included: zipped.length, bytes: zip.length, fileIds: zipped.map((pick) => pick.file.fileId), notFound },
    })
    return { files: zipped.length }
  })
  return reply.type('application/zip').header('content-disposition', attachmentDisposition(name)).header('cache-control', 'no-store').send(zip)
}

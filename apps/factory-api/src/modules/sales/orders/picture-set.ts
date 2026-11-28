import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { PICTURE_SET_ACTION } from '@nexus/factory-domain/sales/order-log/faces'
import type { Prisma } from '@nexus/factory-db'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contentWalledFor } from '../../../platform/files/content-wall'
import { partnerLocaleOf } from '@nexus/factory-domain/threads/partner/rules'
import { portalOf } from '../../../platform/auth/portal/service'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { readRequest } from '../portal-ordering/store'
import type { DraftWriter } from '../portal-ordering/writer'
import { partnerOrder, portalReader } from '../portal-orders/access'
import { assertMay, officeContextOf } from './access'
import type { Reader } from './log'

/**
 * The order's picture — the command `orders.picture.set` (owb- order workflow, b3.2; PL-schema § 3; design § 5zi E): the picture
 * every list, the band, the chat and the floor's basket card show for ONE order (null: the default, the first line's design).
 * The same three columns on both records (pictureFileId, pictureSetAt, pictureSetById): a Draft or Sent order is its
 * PortalOrderRequest, a confirmed one its SalesOrder (Confirm copies the request's three: ../portal-ordering/office.ts
 * acceptInCommand).
 *
 *   POST /sales/orders/:orderId/picture              office, orders.manage over the order's company AND customer
 *   POST /sales/order-requests/:requestId/picture    office, orders.manage (through the od- writer: officeDraftWriter)
 *   POST /portal/order-requests/:requestId/picture   portal, portal.orderDrafts.edit (the partner scope, as every draft write)
 *   POST /portal/sales-orders/:orderId/picture       portal, portal.orderDrafts.edit (S1 ask 23:36: one right for the picture
 *                                                    before and after Send; the picture is a look, not a commercial act). The
 *                                                    partner holds SELECT only on SalesOrder: written in the tenant's office
 *                                                    scope as the person, AFTER the party check (as Send does)
 *   body { fileId: string | null, version }  →  { pictureFileId, pictureSetAt, version }
 *
 * Which file: one of the order's own files (the order, its lines, its request and that request's lines; a customer's upload is
 * one of them), AVAILABLE, an image a browser shows or a PDF, never a fiscal archive, a voice note, body data (a measurement
 * sheet, a body, made-to-measure or fitting photo) or a priced file; of the order's company (or the whole factory). The office
 * reads it with files.read over its company; a portal person only one shared with its own party that passes the content wall.
 * The database checks the same (…_order_workflow_guards factory_order_picture_check, G2) and holds a decided request and a
 * CLOSED or CANCELLED order frozen. The audit row: action `orders.picture.set`, before/after { pictureFileId }.
 *
 * Refusals (words EN + IT; the office answers in English, the portal in the person's language):
 *   404 not_found          out of reach (another customer's, unknown): "Sales order not found." · "Order request not found." ·
 *                          "Order not found."
 *   400 validation_failed  not an allowed file (issue path body/fileId) — the API has no 422: see PICTURE_WORDS.FILE
 *   409 conflict           a stale version (issue path body/version) — PICTURE_WORDS.STALE
 *   409 invalid_state      a CLOSED or CANCELLED order, a decided request — PICTURE_WORDS.CLOSED, PICTURE_WORDS.DECIDED
 */

export const PICTURE_WORDS = Object.freeze({
  FILE: {
    en: 'This file cannot be the order’s picture: choose an image or a PDF of this order that everybody on it may see — never a priced file, a measurement sheet or a voice note.',
    it: 'Questo file non può essere l’immagine dell’ordine: scegli un’immagine o un PDF di questo ordine che tutti possono vedere — mai un file con prezzi, un foglio misure o un messaggio vocale.',
  },
  STALE: {
    en: 'This order changed since you read it: read it again, then choose the picture.',
    it: 'Questo ordine è cambiato da quando l’hai letto: rileggilo, poi scegli l’immagine.',
  },
  CLOSED: {
    en: 'This order is closed or cancelled: its picture no longer changes.',
    it: 'Questo ordine è chiuso o annullato: la sua immagine non cambia più.',
  },
  DECIDED: {
    en: 'This order was confirmed, refused or withdrawn: change the picture on the confirmed order.',
    it: 'Questo ordine è stato confermato, rifiutato o ritirato: cambia l’immagine sull’ordine confermato.',
  },
})
/** The portal says "voi" (factory-web messages: the portal's words are in voi). */
const PORTAL_IT: Readonly<Record<keyof typeof PICTURE_WORDS, string>> = Object.freeze({
  FILE: 'Questo file non può essere l’immagine dell’ordine: scegliete un’immagine o un PDF di questo ordine che tutti possono vedere — mai un file con prezzi, un foglio misure o un messaggio vocale.',
  STALE: 'Questo ordine è cambiato da quando l’avete letto: rileggetelo, poi scegliete l’immagine.',
  CLOSED: 'Questo ordine è chiuso o annullato: la sua immagine non cambia più.',
  DECIDED: 'Questo ordine è stato confermato, rifiutato o ritirato: cambiate l’immagine sull’ordine confermato.',
})
type Locale = 'it' | 'en'
const said = (key: keyof typeof PICTURE_WORDS, locale: Locale, portal: boolean): string => (locale === 'it' ? (portal ? PORTAL_IT[key] : PICTURE_WORDS[key].it) : PICTURE_WORDS[key].en)

export interface PictureBody {
  readonly fileId: string | null
  readonly version: number
}
export interface PictureAnswer {
  readonly pictureFileId: string | null
  readonly pictureSetAt: string | null
  readonly version: number
}

/** The categories that are body data (never a picture). */
const BODY_DATA: readonly string[] = ['MEASUREMENTS', 'BODY_PHOTO', 'MTM_PHOTO', 'FITTING_PHOTO']

const FILE_FACTS = { id: true, companyId: true, partyId: true, recordType: true, recordId: true, kind: true, category: true, contentType: true, status: true, priced: true, visibility: true } as const
type FileFacts = Prisma.StoredFileGetPayload<{ select: typeof FILE_FACTS }>

/** Why this file cannot be the picture of a record of `companyId` whose own records are `recordIds` (null: it can). Pure. */
export function pictureFileProblem(file: FileFacts | null, target: { readonly companyId: string; readonly recordIds: ReadonlySet<string> }): 'FILE' | null {
  if (!file) return 'FILE'
  if (file.status !== 'AVAILABLE') return 'FILE'
  if (!(isPictureType(file.contentType) || file.contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf')) return 'FILE'
  if (file.kind === 'FISCAL_ARCHIVE' || file.kind === 'AUDIO') return 'FILE'
  if (file.category !== null && BODY_DATA.includes(file.category)) return 'FILE'
  if (file.priced) return 'FILE'
  if (file.companyId !== null && file.companyId !== target.companyId) return 'FILE'
  if (!target.recordIds.has(file.recordId)) return 'FILE'
  return null
}

/** The records whose files may be an order's picture: the order, its lines, its request(s) and their lines. */
async function orderOwnRecords(db: Reader, orderId: string): Promise<Set<string>> {
  const lines = await db.salesOrderLine.findMany({ where: { orderId }, select: { id: true } })
  const requests = await db.portalOrderRequest.findMany({ where: { salesOrderId: orderId }, select: { id: true } })
  const requestLines = requests.length > 0 ? await db.portalOrderRequestLine.findMany({ where: { requestId: { in: requests.map((row) => row.id) } }, select: { id: true } }) : []
  return new Set([orderId, ...lines.map((row) => row.id), ...requests.map((row) => row.id), ...requestLines.map((row) => row.id)])
}

/** The records whose files may be a request's picture: the request and its lines. */
async function requestOwnRecords(db: Reader, requestId: string): Promise<Set<string>> {
  const lines = await db.portalOrderRequestLine.findMany({ where: { requestId }, select: { id: true } })
  return new Set([requestId, ...lines.map((row) => row.id)])
}

/** The office's check: files.read over the file's company, then the rule. */
async function officeFileProblem(db: Reader, actor: Actor, fileId: string, target: { readonly companyId: string; readonly recordIds: ReadonlySet<string> }): Promise<'FILE' | null> {
  if (!holds(actor, FILES_READ) || !isUuid(fileId)) return 'FILE'
  const file = await db.storedFile.findFirst({ where: { AND: [scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as Prisma.StoredFileWhereInput, { id: fileId }] }, select: FILE_FACTS })
  return pictureFileProblem(file, target)
}

/** The portal's check (read in the tenant's scope): shared with the party (PARTNER), past the content wall, then the rule. */
async function portalFileProblem(db: Reader, partyId: string, fileId: string, target: { readonly companyId: string; readonly recordIds: ReadonlySet<string> }): Promise<'FILE' | null> {
  if (!isUuid(fileId)) return 'FILE'
  const file = await db.storedFile.findFirst({ where: { id: fileId, partyId, visibility: { has: 'PARTNER' } }, select: FILE_FACTS })
  if (!file || (await contentWalledFor(db, partyId, [file.id])).has(file.id)) return 'FILE'
  return pictureFileProblem(file, target)
}

const fileRefusal = (locale: Locale, portal: boolean): ValidationError => new ValidationError(said('FILE', locale, portal), [{ path: 'body/fileId', message: said('FILE', locale, portal) }])
const staleRefusal = (locale: Locale, portal: boolean): DomainError => new DomainError('conflict', said('STALE', locale, portal), [{ path: 'body/version', message: said('STALE', locale, portal) }])
/** A stale version said in the person's words (the record guard's own message names only the version). */
async function inWords<T>(locale: Locale, portal: boolean, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw error instanceof StaleVersionError ? staleRefusal(locale, portal) : error
  }
}

/** The three columns written: the file, now and who; or all three cleared (back to the default). */
const columnsOf = (fileId: string | null, now: Date, userId: string) => (fileId === null ? { pictureFileId: null, pictureSetAt: null, pictureSetById: null } : { pictureFileId: fileId, pictureSetAt: now, pictureSetById: userId })

// ---- a confirmed order ----------------------------------------------------------------------------------------------------------

/** POST /sales/orders/:orderId/picture (the office). */
export async function setOrderPicture(caller: CommandCaller, orderId: string, body: PictureBody, idempotencyKey?: string): Promise<PictureAnswer> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: { companyId: true, partyId: true, status: true } })) : null
  assertMay(context, ORDERS_MANAGE, order, 'Sales order')
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') throw new InvalidStateError(PICTURE_WORDS.CLOSED.en)
  if (body.fileId !== null) {
    const fileId = body.fileId
    const problem = await caller.withClient(async (client) => officeFileProblem(client, actor, fileId, { companyId: order.companyId, recordIds: await orderOwnRecords(client, orderId) }))
    if (problem) throw fileRefusal('en', false)
  }
  const { result } = await inWords('en', false, () =>
    command(caller, { name: PICTURE_SET_ACTION, idempotencyKey, input: { orderId, ...body }, record: { type: 'SalesOrder', id: orderId, expectedVersion: body.version } }, async (tools) =>
      writeOrderPicture(tools, orderId, body.fileId, context.actorId),
    ),
  )
  return result
}

/** The order's three columns written in a command (the office's, or the portal person's in the tenant's office scope). */
async function writeOrderPicture(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'record'>, orderId: string, fileId: string | null, userId: string): Promise<PictureAnswer> {
  const before = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { companyId: true, status: true, pictureFileId: true } })
  if (before.status === 'CLOSED' || before.status === 'CANCELLED') throw new InvalidStateError(PICTURE_WORDS.CLOSED.en)
  const columns = columnsOf(fileId, tools.now, userId)
  const after = await tools.tx.salesOrder.update({ where: { id: orderId }, data: columns, select: { pictureFileId: true, pictureSetAt: true, version: true } })
  tools.audit({ action: PICTURE_SET_ACTION, recordType: 'SalesOrder', recordId: orderId, companyId: before.companyId, before: { pictureFileId: before.pictureFileId }, after: { pictureFileId: fileId } })
  return { pictureFileId: after.pictureFileId, pictureSetAt: after.pictureSetAt ? toUtcIso(after.pictureSetAt) : null, version: tools.record?.version ?? after.version }
}

/** POST /portal/sales-orders/:orderId/picture (the customer; written in the tenant's office scope as the person, after the party check). */
export async function setPortalOrderPicture(app: FastifyInstance, request: FastifyRequest, orderId: string, body: PictureBody, idempotencyKey?: string): Promise<PictureAnswer> {
  const reader = portalReader(app, request)
  const { session } = reader
  const locale: Locale = partnerLocaleOf(session.person.locale)
  const order = await partnerOrder(request, reader, orderId) // the party's own order in the portal's company, else 404
  const facts = await reader.inTenant((client) => client.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { companyId: true, partyId: true, status: true } }))
  if (facts.partyId !== session.partyId) throw new NotFoundError('Order not found.')
  if (facts.status === 'CLOSED' || facts.status === 'CANCELLED') throw new InvalidStateError(said('CLOSED', locale, true))
  if (body.fileId !== null) {
    const fileId = body.fileId
    const problem = await reader.inTenant(async (client) => portalFileProblem(client, session.partyId, fileId, { companyId: facts.companyId, recordIds: await orderOwnRecords(client, order.id) }))
    if (problem) throw fileRefusal(locale, true)
  }
  const p = portalOf(app)
  const outcome = await inWords(locale, true, () =>
    p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: PICTURE_SET_ACTION, idempotencyKey, input: { orderId, ...body, sessionId: session.id }, record: { type: 'SalesOrder', id: order.id, expectedVersion: body.version } }, async (tools) => {
      const again = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { partyId: true } })
      if (again.partyId !== session.partyId) throw new NotFoundError('Order not found.')
      return writeOrderPicture(tools, order.id, body.fileId, session.userId)
    }),
  )
  return outcome.result
}

// ---- a Draft or Sent order (its request) ------------------------------------------------------------------------------------------

/** POST /sales/order-requests/:requestId/picture (the office's writer) and POST /portal/order-requests/:requestId/picture (the portal's). */
export async function setRequestPicture(writer: DraftWriter, requestId: string, body: PictureBody, idempotencyKey?: string): Promise<PictureAnswer> {
  const portal = writer.door === 'portal'
  const row = await writer.scoped((client) => readRequest(client, requestId))
  if (!row || row.companyId !== writer.companyId || row.partyId !== writer.partyId) throw new NotFoundError('Order request not found.')
  if (row.status !== 'DRAFT' && row.status !== 'SENT') throw new InvalidStateError(said('DECIDED', writer.locale, portal))
  if (body.fileId !== null) {
    const fileId = body.fileId
    const target = { companyId: row.companyId, recordIds: await writer.inTenant((client) => requestOwnRecords(client, row.id)) }
    const problem = portal ? await writer.inTenant((client) => portalFileProblem(client, writer.partyId, fileId, target)) : await writer.scoped((client) => officeFileProblem(client, writer.actor, fileId, target))
    if (problem) throw fileRefusal(writer.locale, portal)
  }
  const outcome = await inWords(writer.locale, portal, () =>
    commandOn(writer.app, writer.request, { name: PICTURE_SET_ACTION, idempotencyKey, input: { requestId, ...body }, record: { type: 'PortalOrderRequest', id: row.id, expectedVersion: body.version } }, async (tools) => {
      const current = await readRequest(tools.tx, row.id)
      if (!current || current.partyId !== writer.partyId) throw new NotFoundError('Order request not found.')
      if (current.status !== 'DRAFT' && current.status !== 'SENT') throw new InvalidStateError(said('DECIDED', writer.locale, portal))
      const before = await tools.tx.portalOrderRequest.findUniqueOrThrow({ where: { id: row.id }, select: { pictureFileId: true } })
      const after = await tools.tx.portalOrderRequest.update({ where: { id: row.id }, data: columnsOf(body.fileId, tools.now, writer.userId), select: { pictureFileId: true, pictureSetAt: true, version: true } })
      tools.audit({ action: PICTURE_SET_ACTION, recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { pictureFileId: before.pictureFileId }, after: { pictureFileId: body.fileId } })
      return { pictureFileId: after.pictureFileId, pictureSetAt: after.pictureSetAt ? toUtcIso(after.pictureSetAt) : null, version: tools.record?.version ?? after.version }
    }),
  )
  return outcome.result
}

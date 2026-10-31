import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { FILES_MANAGE, FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { Balance } from '@nexus/factory-domain/inventory/ledger/moves'
import { PURCHASING_SUBCONTRACT_KIT, PURCHASING_SUBCONTRACT_RECEIVE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import type { SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type FloorContext, type SystemContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { asTenantSystem } from '../../production/bundles/codes'
import { balancesAt } from '../../inventory/counts/ledger-at'
import { heldByQualityHolds } from '../../quality/holds/stock'
import { pdfFileIdsOf } from '../../shipping/ddt/store'
import { quantityText, type Reader } from '../store'
import { sendKitAs } from './kit'
import { bundlesSentOf } from './receive-back'
import { receiveBackAs, type ReceiveInput } from './receive'
import { ORDER_COLUMNS, readOrder, type OrderRow } from './store'
import { orderDetailOf, storedReceipts } from './views'

/**
 * Subcontract kits on the floor (B-W2a-76; SCM-140, SCM-142; design floor.kits SCR-181): the warehouse tablet sends a
 * subcontract order's kit with its DDT for work on our behalf (conto lavorazione) and receives the goods back bundle by
 * bundle. The floor's role reads no subcontract order (no grant on those tables, B-W2a-25): after the floor's own checks
 * — a floor session, purchasing.subcontract.kit or .receive at the device's site, an order OF that site — the reads and
 * the commands run as the tenant's system caller (production/bundles/codes.ts asTenantSystem, as receiving's PO move),
 * through the office's own command bodies (kit.ts sendKitAs, receive.ts receiveBackAs: one rule for both paths). The
 * audit rows name the tablet and its worker inside the one record. Never a fee, a price or a value on the floor.
 *
 *   list     GET  /purchasing/subcontracting/kits?mode=send|receive[&code=]   the site's orders to send or to receive,
 *                                                                              or the one a scanned number names (`found`)
 *   read     GET  /purchasing/subcontracting/kits/:id                          the kit: lines with where they lie, the
 *                                                                              bundles out and back, what is at the workshop
 *   send     POST /purchasing/subcontracting/kits/:id/send                     the planned lines and bundles ticked + the
 *                                                                              DDT (always issued from the floor)
 *   receive  POST /purchasing/subcontracting/kits/:id/receive                  bundles back (good, rejected, scrapped) and
 *                                                                              the material returned
 *   pdf      GET  /purchasing/subcontracting/kits/:id/ddts/:ddtId/pdf          the kit DDT's PDF (a presigned GET)
 */

const SEND_STATUSES: readonly SubcontractOrderStatus[] = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED']
const RECEIVE_STATUSES: readonly SubcontractOrderStatus[] = ['AT_WORKSHOP', 'PARTLY_RECEIVED']
const SEND_ACTION = 'purchasing.subcontract.sendKit'
const LIST_LIMIT = 50
const SOURCES_PER_LINE = 6

export type KitMode = 'send' | 'receive'

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const today = () => businessDate(serverClock.now())
const scopeOf = (order: Pick<OrderRow, 'companyId' | 'siteId' | 'partyId'>) => ({ companyId: order.companyId, siteId: order.siteId, partyId: order.partyId })

function floorOf(caller: CommandCaller): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** The floor may send kits or receive goods back at its site (either opens the task; each act asks its own). */
function mayAtSite(context: FloorContext, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(actorOf(context), permission, { siteId: context.siteId }))
}

/** The order a floor caller reaches: of its device's site, with one of `permissions` over it (else not found). */
async function floorOrder(caller: CommandCaller, orderId: string, permissions: readonly Permission[]) {
  const context = floorOf(caller)
  const system = asTenantSystem(caller, context)
  const order = await system.withClient((client) => readOrder(client, orderId))
  if (!order || order.siteId !== context.siteId || !permissions.some((permission) => can(actorOf(context), permission, scopeOf(order)))) throw new NotFoundError('Subcontract order not found at this site.')
  return { context, system, order }
}

/**
 * The tablet's site acting as the system with exactly the file grants the kit DDT's PDF needs, over the order's company and
 * site (as the dock's photos, sales/returns/photos.ts): it stores the PDF (shared with the site's floor) and reads it back.
 */
function siteFiles(request: FastifyRequest, context: FloorContext, order: Pick<OrderRow, 'companyId' | 'siteId'>): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_READ, FILES_UPLOAD, FILES_MANAGE], companies: [order.companyId], sites: [order.siteId], parties: 'all' }
  const system: SystemContext = Object.freeze({ audience: 'system', tenantId: context.tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = system
  return view
}

// ---- list ---------------------------------------------------------------------------------------------------------------

export interface KitsQuery {
  readonly mode: KitMode
  readonly code?: string | undefined
}

/** GET /purchasing/subcontracting/kits: the site's orders to send (kit planned or pieces left) or to receive, newest due first. */
export async function floorKits(caller: CommandCaller, query: KitsQuery) {
  const context = floorOf(caller)
  const permission = query.mode === 'send' ? PURCHASING_SUBCONTRACT_KIT : PURCHASING_SUBCONTRACT_RECEIVE
  if (!mayAtSite(context, [permission])) throw new ForbiddenError()
  const code = query.code?.trim() ?? ''
  if (code.length > 60) throw new ValidationError('Scan or type the subcontract order number.', [{ path: 'querystring/code', message: 'At most 60 characters.' }])
  const statuses = query.mode === 'send' ? SEND_STATUSES : RECEIVE_STATUSES
  return asTenantSystem(caller, context).withClient(async (client) => {
    const where: Prisma.SubcontractOrderWhereInput = code ? { siteId: context.siteId, number: { equals: code, mode: 'insensitive' } } : { siteId: context.siteId, status: { in: [...statuses] } }
    // The office list's own query shape (orders.ts listOrders), then the soonest due first.
    const read = await client.subcontractOrder.findMany({ where, orderBy: { id: 'desc' }, take: code ? 2 : LIST_LIMIT * 2, select: ORDER_COLUMNS })
    const orders = read.filter((order) => can(actorOf(context), permission, scopeOf(order))).sort((a, b) => (a.expectedBackDate?.getTime() ?? Infinity) - (b.expectedBackDate?.getTime() ?? Infinity) || a.number.localeCompare(b.number))
    const found = code ? (orders.length === 1 ? { id: orders[0]!.id, number: orders[0]!.number, status: orders[0]!.status } : null) : null
    const day = today()
    const rows = []
    for (const order of orders) {
      if (!(statuses as readonly string[]).includes(order.status)) continue
      const detail = await orderDetailOf(client, order, day)
      const planned = detail.kitLines.filter((line) => line.status === 'PLANNED').length
      const toSend = detail.operations.reduce((sum, operation) => sum + Math.max(0, operation.pieces - operation.piecesSent), 0)
      const atWorkshop = detail.operations.reduce((sum, operation) => sum + operation.atWorkshop, 0)
      // To send: a kit line still planned or pieces still to go; to receive: something out at the workshop.
      if (!code && query.mode === 'send' && planned === 0 && toSend === 0) continue
      if (!code && query.mode === 'receive' && atWorkshop === 0 && !detail.kitLines.some((line) => line.status === 'SENT')) continue
      rows.push({
        id: detail.id,
        number: detail.number,
        status: detail.status,
        workshop: { code: detail.workshop.code, name: detail.workshop.name },
        workOrder: { number: detail.workOrder.number, style: { code: detail.workOrder.style.code, name: detail.workOrder.style.name } },
        expectedBackDate: detail.expectedBackDate,
        late: detail.late,
        pieces: { ordered: detail.pieces.ordered, sent: detail.pieces.sent, atWorkshop: detail.pieces.atWorkshop, back: detail.pieces.backGood + detail.pieces.backDefective + detail.pieces.scrapped },
        kit: { planned, sent: detail.kitLines.filter((line) => line.status === 'SENT').length },
      })
      if (rows.length >= LIST_LIMIT) break
    }
    return { serverTime: toUtcIso(serverClock.now()), orders: rows, found }
  })
}

// ---- read ---------------------------------------------------------------------------------------------------------------

/**
 * The site's ledger balances of these materials at these places (counts/ledger-at.ts balancesAt, one material after another
 * on one client: a reader may be a transaction's one connection), on hand above zero.
 */
async function balancesOf(db: Reader, siteId: string, itemIds: readonly string[], locationIds: readonly string[]): Promise<Balance[]> {
  if (itemIds.length === 0 || locationIds.length === 0) return []
  const found: Balance[] = []
  const now = serverClock.now()
  for (const itemId of itemIds) found.push(...(await balancesAt(db, { siteId, locationIds: new Set(locationIds), itemId }, now)))
  return found.filter((balance) => balance.onHand.greaterThan(0))
}

/** Bundles the order's sends named, each once: W2b's SubcontractBundle rows (B-W2b-10), and the send's audit rows before them. */
async function bundlesSent(db: Reader, orderId: string): Promise<Set<string>> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'SubcontractOrder', recordId: orderId, action: SEND_ACTION }, select: { after: true } })
  const sent = await bundlesSentOf(db, orderId)
  for (const row of rows) {
    const after = row.after as { bundles?: unknown } | null
    for (const entry of Array.isArray(after?.bundles) ? after.bundles : []) {
      const id = (entry as { bundleId?: unknown } | null)?.bundleId
      if (typeof id === 'string') sent.add(id)
    }
  }
  return sent
}

async function kitView(db: Reader, order: OrderRow) {
  const detail = await orderDetailOf(db, order, today())
  const allCells = detail.operations.some((operation) => operation.sizes.length === 0)
  const cellIds = unique(detail.operations.flatMap((operation) => operation.sizes.map((size) => size.workOrderSizeId)))
  const bundleRows = await db.bundle.findMany({
    where: { workOrderId: order.workOrderId, status: 'ACTIVE', ...(allCells ? {} : { workOrderSizeId: { in: cellIds } }) },
    select: { id: true, code: true, replacedCodes: true, workOrderSizeId: true, quantity: true, part: true },
    orderBy: { code: 'asc' },
    take: 500,
  })
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: order.workOrderId }, select: { id: true, size: true, colourwayId: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const cellOf = new Map(cells.map((cell) => [cell.id, { colourway: colourways.get(cell.colourwayId) ?? '', size: cell.size }]))
  const sent = await bundlesSent(db, order.id)
  const back = new Map<string, { operationId: string; good: number; defective: number; scrapped: number }[]>()
  for (const receipt of await storedReceipts(db, order.id)) {
    for (const line of receipt.lines) {
      if (!line.bundleId) continue
      const rows = back.get(line.bundleId) ?? []
      const row = rows.find((entry) => entry.operationId === line.operationId)
      if (row) Object.assign(row, { good: row.good + line.good, defective: row.defective + line.defective, scrapped: row.scrapped + line.scrapped })
      else rows.push({ operationId: line.operationId, good: line.good, defective: line.defective, scrapped: line.scrapped })
      back.set(line.bundleId, rows)
    }
  }

  // Where each planned kit line may leave from: the site's places (not a workshop's) holding its material, colour and lot,
  // a released lot only, nothing a quality hold holds; the most first.
  const places = await db.location.findMany({ where: { siteId: order.siteId, status: 'ACTIVE', kind: { not: 'SUBCONTRACTOR' } }, select: { id: true, code: true, name: true, kind: true }, orderBy: { code: 'asc' } })
  const placeOf = new Map(places.map((place) => [place.id, place]))
  const planned = detail.kitLines.filter((line) => line.status === 'PLANNED')
  const stock = await balancesOf(db, order.siteId, unique(planned.map((line) => line.item.id)), places.map((place) => place.id))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(stock.map((row) => row.lotId)) } }, select: { id: true, code: true, qualityStatus: true } })).map((row) => [row.id, row]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(stock.map((row) => row.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const quality = await heldByQualityHolds(db, { lotIds: stock.map((row) => row.lotId), hideIds: stock.map((row) => row.hideId) })
  const sourcesFor = (line: (typeof detail.kitLines)[number]) =>
    stock
      .filter((row) => row.itemId === line.item.id && (line.colour === null || row.itemColourId === line.colour.id) && (line.lot === null || row.lotId === line.lot.id) && (line.hide === null || row.hideId === line.hide.id))
      .filter((row) => (line.item.tracking === 'NONE' || row.lotId !== null) && (line.item.tracking !== 'HIDE' || row.hideId !== null))
      .filter((row) => (row.lotId === null || lots.get(row.lotId)?.qualityStatus === 'RELEASED') && !quality.holds(row))
      .sort((a, b) => b.onHand.comparedTo(a.onHand))
      .slice(0, SOURCES_PER_LINE)
      .map((row) => {
        const place = placeOf.get(row.locationId)!
        return {
          location: { id: place.id, code: place.code, name: place.name },
          lot: row.lotId ? { id: row.lotId, code: lots.get(row.lotId)?.code ?? '' } : null,
          hide: row.hideId ? { id: row.hideId, code: hides.get(row.hideId) ?? '' } : null,
          available: quantityText(row.onHand),
          covers: row.onHand.greaterThanOrEqualTo(new Dec(line.baseQuantity)),
        }
      })

  // What is at the workshop of each sent line (its material, colour, lot and hide at the order's place), and where it left from.
  const sentLines = detail.kitLines.filter((line) => line.status === 'SENT')
  const atWorkshop = await balancesOf(db, order.siteId, unique(sentLines.map((line) => line.item.id)), [order.locationId])
  const moves = new Map((await db.stockMove.findMany({ where: { id: { in: unique(sentLines.map((line) => line.moveId)) } }, select: { id: true, fromLocationId: true } })).map((row) => [row.id, row.fromLocationId]))
  const fromPlaces = new Map((await db.location.findMany({ where: { id: { in: unique([...moves.values()]) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const withPdf = await pdfFileIdsOf(db, detail.ddts.map((ddt) => ddt.id))

  return {
    id: detail.id,
    number: detail.number,
    status: detail.status,
    version: detail.version,
    site: detail.site,
    workshop: { code: detail.workshop.code, name: detail.workshop.name },
    location: { code: detail.location.code, name: detail.location.name },
    workOrder: { number: detail.workOrder.number, style: { code: detail.workOrder.style.code, name: detail.workOrder.style.name } },
    expectedBackDate: detail.expectedBackDate,
    late: detail.late,
    operations: detail.operations.map((operation) => ({
      id: operation.id,
      seq: operation.seq,
      code: operation.workOrderOperation.code,
      name: operation.workOrderOperation.name,
      pieces: operation.pieces,
      sent: operation.piecesSent,
      backGood: operation.piecesBackGood,
      backDefective: operation.piecesBackDefective,
      scrapped: operation.piecesScrapped,
      atWorkshop: operation.atWorkshop,
      cells: operation.sizes.map((size) => size.workOrderSizeId),
    })),
    kitLines: detail.kitLines
      .filter((line) => line.status !== 'CANCELLED')
      .map((line) => {
        const from = line.moveId ? moves.get(line.moveId) : null
        const place = from ? fromPlaces.get(from) : undefined
        const there = line.status === 'SENT' ? atWorkshop.find((row) => row.itemId === line.item.id && row.itemColourId === (line.colour?.id ?? null) && row.lotId === (line.lot?.id ?? null) && row.hideId === (line.hide?.id ?? null)) : undefined
        return {
          id: line.id,
          seq: line.seq,
          item: line.item,
          colour: line.colour ? { id: line.colour.id, code: line.colour.code, name: line.colour.name } : null,
          lot: line.lot ? { id: line.lot.id, code: line.lot.code } : null,
          hide: line.hide ? { id: line.hide.id, code: line.hide.code } : null,
          quantity: line.quantity,
          uom: line.uom,
          baseQuantity: line.baseQuantity,
          status: line.status,
          sentAt: line.sentAt,
          ddtNumber: line.ddt?.number ?? null,
          sources: line.status === 'PLANNED' ? sourcesFor(line) : [],
          from: place ? { id: place.id, code: place.code, name: place.name } : null,
          atWorkshop: there ? quantityText(there.onHand) : line.status === 'SENT' ? '0.0000' : null,
        }
      }),
    bundles: bundleRows.map((bundle) => {
      const cell = cellOf.get(bundle.workOrderSizeId)
      return {
        id: bundle.id,
        code: bundle.code,
        replacedCodes: bundle.replacedCodes,
        workOrderSizeId: bundle.workOrderSizeId,
        colourway: cell?.colourway ?? '',
        size: cell?.size ?? '',
        part: bundle.part,
        quantity: bundle.quantity,
        sent: sent.has(bundle.id),
        back: back.get(bundle.id) ?? [],
      }
    }),
    places: places.filter((place) => place.kind !== 'SHIPPING').map((place) => ({ id: place.id, code: place.code, name: place.name, kind: place.kind })),
    ddts: detail.ddts.map((ddt) => ({ id: ddt.id, number: ddt.number, documentDate: ddt.documentDate, cancelled: ddt.cancelled, pdf: withPdf.has(ddt.id) })),
    actions: { send: detail.actions.send, receive: detail.actions.receive },
  }
}

export type FloorKitView = Awaited<ReturnType<typeof kitView>>

/** GET /purchasing/subcontracting/kits/:id */
export async function floorKit(caller: CommandCaller, orderId: string): Promise<{ serverTime: string; order: FloorKitView }> {
  const { system, order } = await floorOrder(caller, orderId, [PURCHASING_SUBCONTRACT_KIT, PURCHASING_SUBCONTRACT_RECEIVE])
  return { serverTime: toUtcIso(serverClock.now()), order: await system.withClient((client) => kitView(client, order)) }
}

// ---- send ---------------------------------------------------------------------------------------------------------------

export interface FloorSendBody {
  readonly version: number
  readonly lines: readonly { readonly lineId: string; readonly fromLocationId: string; readonly lotId?: string | null | undefined; readonly hideId?: string | null | undefined }[]
  readonly bundles: readonly { readonly bundleId: string }[]
  readonly ddt: { readonly transportBy: 'SENDER' | 'RECIPIENT'; readonly packages: number; readonly grossWeightKg: string; readonly appearance?: string | null | undefined }
}

function requireKey(idempotencyKey: string | undefined): string {
  if (!idempotencyKey) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  return idempotencyKey
}

/**
 * POST …/kits/:id/send — purchasing.subcontract.kit at the site: the planned lines (each from the place picked, its lot and
 * hide) and the bundles ticked go out in ONE command (kit.ts sendKitAs: the moves into the workshop's place, the pieces from
 * the whole-garment bundles, the order AT_WORKSHOP), then the DDT for work on our behalf (always: the goods travel with it)
 * and its PDF, shared with the site's floor.
 */
export async function floorSendKit(request: FastifyRequest, orderId: string, body: FloorSendBody, idempotencyKey?: string) {
  const key = requireKey(idempotencyKey)
  const { context, system, order } = await floorOrder(request, orderId, [PURCHASING_SUBCONTRACT_KIT])
  if (!can(actorOf(context), PURCHASING_SUBCONTRACT_KIT, scopeOf(order))) throw new ForbiddenError()
  const answer = await sendKitAs(
    processFiles(),
    { caller: system, printer: siteFiles(request, context, order) },
    order,
    {
      version: body.version,
      lines: body.lines.map((line) => ({ lineId: line.lineId, fromLocationId: line.fromLocationId, ...(line.lotId !== undefined ? { lotId: line.lotId } : {}), ...(line.hideId !== undefined ? { hideId: line.hideId } : {}) })),
      pieces: [],
      bundles: body.bundles,
      ddt: { reason: 'WORK_ON_ACCOUNT', transportBy: body.ddt.transportBy, packages: body.ddt.packages, grossWeightKg: body.ddt.grossWeightKg, ...(body.ddt.appearance ? { appearance: body.ddt.appearance } : {}) },
    },
    key,
    (error) => request.log.error({ err: error }, 'the kit DDT is issued; its PDF was not stored'),
    { deviceId: context.deviceId, operatorId: context.actorId },
  )
  const fresh = (await system.withClient((client) => readOrder(client, order.id)))!
  return {
    order: await system.withClient((client) => kitView(client, fresh)),
    ddt: answer.ddt ? { id: answer.ddt.id, number: answer.ddt.number, pdf: answer.ddt.file !== null, pdfProblem: answer.ddt.pdfProblem === null ? null : 'The DDT is issued; its PDF could not be stored now. The office prints it again.' } : null,
  }
}

// ---- receive ------------------------------------------------------------------------------------------------------------

export type FloorReceiveBody = Pick<ReceiveInput, 'version' | 'lines' | 'returns' | 'supplierDdt' | 'note'>

/** POST …/kits/:id/receive — purchasing.subcontract.receive at the site: ONE receipt (receive.ts receiveBackAs). */
export async function floorReceiveBack(request: FastifyRequest, orderId: string, body: FloorReceiveBody, idempotencyKey?: string) {
  const key = requireKey(idempotencyKey)
  const { context, system, order } = await floorOrder(request, orderId, [PURCHASING_SUBCONTRACT_RECEIVE])
  if (!can(actorOf(context), PURCHASING_SUBCONTRACT_RECEIVE, scopeOf(order))) throw new ForbiddenError()
  const answer = await receiveBackAs(system, order.id, body, key, { deviceId: context.deviceId, operatorId: context.actorId })
  const fresh = (await system.withClient((client) => readOrder(client, order.id)))!
  const totals = answer.receipt.lines.reduce((sum, line) => ({ good: sum.good + line.good, defective: sum.defective + line.defective, scrapped: sum.scrapped + line.scrapped }), { good: 0, defective: 0, scrapped: 0 })
  return {
    order: await system.withClient((client) => kitView(client, fresh)),
    receipt: { id: answer.receipt.id, receivedAt: answer.receipt.receivedAt, ...totals, bundles: unique(answer.receipt.lines.map((line) => line.bundle?.id)).length, returned: answer.receipt.returns.length },
  }
}

// ---- the DDT's PDF ------------------------------------------------------------------------------------------------------

/** GET …/kits/:id/ddts/:ddtId/pdf — a kit DDT of this order: its stored PDF as a presigned GET (60 seconds). */
export async function floorKitDdtPdf(request: FastifyRequest, orderId: string, ddtId: string) {
  const { context, system, order } = await floorOrder(request, orderId, [PURCHASING_SUBCONTRACT_KIT, PURCHASING_SUBCONTRACT_RECEIVE])
  const fileId = await system.withClient(async (client) => {
    const ddt = await client.ddt.findFirst({ where: { id: ddtId, sourceType: 'SubcontractOrder', sourceId: order.id }, select: { id: true } })
    return ddt ? ((await pdfFileIdsOf(client, [ddt.id])).get(ddt.id) ?? null) : null
  })
  if (!fileId) throw new NotFoundError("This DDT's PDF is not stored yet: the office prints it again.")
  return { download: await downloadFile(processFiles(), { caller: siteFiles(request, context, order), system: systemCallerOf(request) }, fileId) }
}

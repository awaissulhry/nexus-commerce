import type { FactoryClient, Uom } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_RECEIVE } from '@nexus/factory-domain/inventory/permissions'
import { expectedBaseOf, HIDE_AREA_UNITS, lineDifference, lotStart, receivingProblem, type HoldReason } from '@nexus/factory-domain/inventory/receipts/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { asTenantSystem } from '../../production/bundles/codes'
import { stationPrinterOf } from '../../production/bundles/store'
import { stockContextOf } from '../ledger/access'
import { byId, dec, HIDE_COLUMNS, ids, LOT_COLUMNS, readColours, readEarlierLots, readItems, readOrderLines, RECEIPT_COLUMNS, RECEIPT_LINE_COLUMNS, type Reader } from '../receipts/store'

/**
 * What a goods-in tablet reads (B-W1-33; A2 SCR-092): the orders its site expects goods against, one order with what is
 * still to come per line, and a receipt it posted with its lots, hides and the hides' tags on the printer. Read in the
 * floor's own scope (row-level security: its site; column grants: never a price or the order's internal note), except
 * the supplier's name, which the floor role may not read: that one column comes from the tenant's system scope for the
 * orders the floor found itself. Nothing here is money.
 */

const RECEIVING = ['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'] as const
const day = (value: Date | null): string | null => (value === null ? null : businessDate(value, 'UTC'))

/** The floor session, with inventory.receive at its own site (else 403: the tile is not shown without it). */
export function receiverOf(caller: CommandCaller): FloorContext {
  const context = stockContextOf(caller)
  if (context.audience !== 'floor') throw new ForbiddenError()
  if (!can(actorOf(context), INVENTORY_RECEIVE, { siteId: context.siteId })) throw new ForbiddenError('Receiving goods needs inventory.receive at this site.')
  return context
}

/** The supplier's names, from the tenant's system scope (the floor role reads no party). */
export async function supplierNames(caller: CommandCaller, context: FloorContext, partyIds: readonly string[]): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map()
  const rows = await asTenantSystem(caller, context).withClient((client) => client.party.findMany({ where: { id: { in: ids(partyIds) } }, select: { id: true, legalName: true, tradeName: true } }))
  return new Map(rows.map((row) => [row.id, row.tradeName ?? row.legalName]))
}

/** One line still expected: what was ordered, what came, what is open, the most taken without a reason. */
function openOf(line: { quantity: { toString(): string }; baseQuantity: { toString(): string }; confirmedQuantity: { toString(): string } | null; areaTolerancePct: { toString(): string } | null }, received: Decimal) {
  const expected = expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null })
  const difference = lineDifference({ expected, receivedBefore: received, receiving: '0', tolerancePct: line.areaTolerancePct?.toString() ?? null })
  return { expected, open: Dec.max(ZERO, expected.minus(received)), upTo: Dec.max(ZERO, new Dec(difference.upTo).minus(received)), complete: difference.complete && received.greaterThan(0) }
}

// ---- the orders the site expects -----------------------------------------------------------------------------------------------

/** GET /inventory/receiving/orders[?code=]: what the site expects, earliest due first; a scanned number finds its order. */
export async function listExpected(caller: CommandCaller, query: { readonly code?: string | undefined; readonly limit?: number | undefined }) {
  const context = receiverOf(caller)
  const code = query.code?.trim() ?? null
  const read = await caller.withClient(async (client) => {
    const found = code ? await client.purchaseOrder.findFirst({ where: { number: { equals: code, mode: 'insensitive' } }, select: { id: true, number: true, status: true } }) : null
    // A scanned number names one order (or none); without it, every order of the site that takes goods.
    const orders =
      code && !found
        ? []
        : await client.purchaseOrder.findMany({
            where: { status: { in: [...RECEIVING] }, ...(found ? { id: found.id } : {}) },
            select: { id: true, number: true, status: true, partyId: true, requestedDate: true },
            orderBy: { number: 'asc' },
            take: 200,
          })
    const rows = []
    for (const order of orders) {
      const { lines, received } = await readOrderLines(client, order.id)
      const open = lines.filter((line) => !openOf(line, received.get(line.id) ?? ZERO).complete && !expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null }).isZero())
      const dates = open.map((line) => day(line.confirmedDate ?? line.needDate)!).sort()
      rows.push({ order, lines: lines.length, openLines: open.length, due: dates[0] ?? day(order.requestedDate), receivedBefore: [...received.values()].some((value) => value.greaterThan(0)) })
    }
    return { found, rows }
  })
  const names = await supplierNames(caller, context, read.rows.map((row) => row.order.partyId))
  const orders = read.rows
    .filter((row) => row.openLines > 0)
    .sort((a, b) => (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31') || a.order.number.localeCompare(b.order.number))
    .slice(0, query.limit ?? 50)
    .map((row) => ({ id: row.order.id, number: row.order.number, status: row.order.status, supplier: { id: row.order.partyId, name: names.get(row.order.partyId) ?? '' }, due: row.due, openLines: row.openLines, lines: row.lines, receivedBefore: row.receivedBefore }))
  return { serverTime: toUtcIso(serverClock.now()), orders, found: read.found }
}

// ---- one order -----------------------------------------------------------------------------------------------------------------

/** The site's one active place of a kind (the dock, the quality-hold rack), or null (none, or several: the office names one). */
async function onlyPlace(client: Reader, siteId: string, kind: 'RECEIVING' | 'QUARANTINE') {
  const rows = await client.location.findMany({ where: { siteId, kind, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' }, take: 2 })
  return rows.length === 1 ? rows[0]! : null
}

/** The label printer the tags go to: the device's station's, else the site's only active label printer. */
export async function tagPrinterOf(client: FactoryClient, context: FloorContext) {
  const stationPrinter = await stationPrinterOf(client, context.deviceId)
  const rows = await client.printer.findMany({
    where: stationPrinter ? { id: stationPrinter, kind: 'LABEL_ZPL', status: 'ACTIVE' } : { siteId: context.siteId, kind: 'LABEL_ZPL', status: 'ACTIVE' },
    select: { id: true, code: true, name: true },
    take: 2,
  })
  return rows.length === 1 ? rows[0]! : null
}

/** GET /inventory/receiving/orders/:orderId: the order without prices, each line's open quantity, where the goods go. */
export async function expectedOrder(caller: CommandCaller, orderId: string) {
  const context = receiverOf(caller)
  const read = await caller.withClient(async (client) => {
    const order = isUuid(orderId)
      ? await client.purchaseOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, siteId: true, number: true, status: true, version: true, partyId: true, requestedDate: true } })
      : null
    if (!order) return null
    const { lines, received } = await readOrderLines(client, order.id)
    const items = await readItems(client, lines.map((line) => line.itemId))
    const colours = await readColours(client, lines.map((line) => line.itemColourId))
    const earlier = await readEarlierLots(client, lines.map((line) => line.id))
    return { order, lines, received, items, colours, earlier, dock: await onlyPlace(client, order.siteId, 'RECEIVING'), hold: await onlyPlace(client, order.siteId, 'QUARANTINE'), printer: await tagPrinterOf(client, context) }
  })
  if (!read || !can(actorOf(context), INVENTORY_RECEIVE, { companyId: read.order.companyId, siteId: read.order.siteId })) throw new NotFoundError('Purchase order not found.')
  const names = await supplierNames(caller, context, [read.order.partyId])
  const problem = receivingProblem(read.order.status)
  return {
    serverTime: toUtcIso(serverClock.now()),
    order: { id: read.order.id, number: read.order.number, status: read.order.status, version: read.order.version, supplier: { id: read.order.partyId, name: names.get(read.order.partyId) ?? '' }, requestedDate: day(read.order.requestedDate) },
    refusal: problem ? { code: 'NOT_RECEIVING' as const, message: problem } : null,
    lines: read.lines.map((line) => {
      const item = read.items.get(line.itemId)!
      const colour = line.itemColourId ? read.colours.get(line.itemColourId) : undefined
      const got = read.received.get(line.id) ?? ZERO
      const open = openOf(line, got)
      const holds: HoldReason[] = [...lotStart({ itemRequiresCrViTest: item.requiresCrViTest, itemCrViLimitMgKg: item.crViLimitMgKg?.toString() ?? null, lineRequiresCrViTest: line.requiresCrViTest, isPpeComponent: item.isPpeComponent }).holds]
      const areaUnits: Uom[] = item.tracking === 'HIDE' ? [...new Set<Uom>([HIDE_AREA_UNITS.includes(line.uom) ? line.uom : item.baseUom, ...HIDE_AREA_UNITS])] : []
      return {
        id: line.id,
        seq: line.seq,
        item: { id: item.id, code: item.code, name: item.name, tracking: item.tracking, baseUom: item.baseUom, isPpeComponent: item.isPpeComponent },
        colour: colour ? { code: colour.code, name: colour.name } : null,
        quantity: quantityText(line.quantity.toString()),
        uom: line.uom,
        expected: quantityText(open.expected),
        received: quantityText(got),
        open: quantityText(open.open),
        tolerancePct: line.areaTolerancePct === null ? null : line.areaTolerancePct.toString(),
        upTo: quantityText(open.upTo),
        needDate: day(line.needDate)!,
        confirmedDate: day(line.confirmedDate),
        estimatedHides: line.estimatedHides,
        hidesReceived: read.earlier.get(line.id)?.hides ?? 0,
        grade: line.grade,
        thicknessMinMm: line.thicknessMinMm === null ? null : line.thicknessMinMm.toFixed(2),
        thicknessMaxMm: line.thicknessMaxMm === null ? null : line.thicknessMaxMm.toFixed(2),
        oneDyeBatch: line.oneDyeBatch,
        holds,
        areaUnits,
      }
    }),
    dock: read.dock,
    hold: read.hold,
    printer: read.printer,
  }
}

// ---- a receipt the floor posted ------------------------------------------------------------------------------------------------

/** The receipt as the floor sees it (no value, no person): its lines, lots with where they lie, hides and their tags. */
export async function floorReceipt(
  caller: CommandCaller,
  context: FloorContext,
  receiptId: string,
  printing: { readonly printer?: { readonly id: string; readonly code: string; readonly name: string } | null; readonly problems?: ReadonlyMap<string, string> } = {},
) {
  const read = await caller.withClient(async (client) => {
    const receipt = isUuid(receiptId) ? await client.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS }) : null
    if (!receipt) return null
    const lines = await client.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: RECEIPT_LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const items = await readItems(client, lines.map((line) => line.itemId))
    const colours = await readColours(client, lines.map((line) => line.itemColourId))
    const order = receipt.purchaseOrderId
      ? await client.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId }, select: { id: true, number: true, status: true, version: true, partyId: true, requestedDate: true } })
      : null
    const orderLines = order ? await readOrderLines(client, order.id) : null
    const lots = await client.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: LOT_COLUMNS, orderBy: { code: 'asc' } })
    const hides = await client.hide.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) } }, select: HIDE_COLUMNS, orderBy: { code: 'asc' } })
    const moves = await client.stockMove.findMany({ where: { reason: 'RECEIPT', reversalOfId: null, receiptLineId: { in: lines.map((line) => line.id) } }, select: { lotId: true, toLocationId: true, baseQuantity: true } })
    const places = byId(await client.location.findMany({ where: { id: { in: ids(moves.map((move) => move.toLocationId)) } }, select: { id: true, code: true, name: true } }))
    const jobs = hides.length === 0 ? [] : await client.printJob.findMany({ where: { recordType: 'Hide', recordId: { in: hides.map((hide) => hide.id) } }, select: { id: true, recordId: true, printerId: true, status: true, version: true, lastError: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const printers = byId(await client.printer.findMany({ where: { id: { in: ids(jobs.map((job) => job.printerId)) } }, select: { id: true, code: true, name: true } }))
    return { receipt, lines, items, colours, order, orderLines, lots, hides, moves, places, jobs, printers }
  })
  if (!read) throw new NotFoundError('Goods receipt not found.')
  const names = read.order ? await supplierNames(caller, context, [read.order.partyId]) : new Map<string, string>()
  const lotById = byId(read.lots)
  const newest = new Map<string, (typeof read.jobs)[number]>()
  for (const job of read.jobs) if (!newest.has(job.recordId)) newest.set(job.recordId, job)
  const lastPrinter = printing.printer !== undefined ? printing.printer : read.jobs[0] ? (read.printers.get(read.jobs[0].printerId) ?? null) : null
  const { receipt } = read
  return {
    id: receipt.id,
    number: receipt.number,
    status: receipt.status,
    receivedAt: toUtcIso(receipt.receivedAt),
    supplierDdtNumber: receipt.supplierDdtNumber,
    supplierDdtDate: day(receipt.supplierDdtDate),
    order: read.order
      ? { id: read.order.id, number: read.order.number, status: read.order.status, version: read.order.version, supplier: { id: read.order.partyId, name: names.get(read.order.partyId) ?? '' }, requestedDate: day(read.order.requestedDate) }
      : { id: receipt.purchaseOrderId!, number: '', status: 'SENT' as const, version: 1, supplier: { id: receipt.supplierId, name: '' }, requestedDate: null },
    lines: read.lines.map((line) => {
      const item = read.items.get(line.itemId)!
      const colour = line.itemColourId ? read.colours.get(line.itemColourId) : undefined
      const orderLine = line.purchaseOrderLineId ? read.orderLines?.lines.find((entry) => entry.id === line.purchaseOrderLineId) : undefined
      const received = orderLine ? (read.orderLines!.received.get(orderLine.id) ?? ZERO) : ZERO
      const before = receipt.status === 'POSTED' ? received.minus(dec(line.baseQuantity)) : received
      const difference = orderLine
        ? lineDifference({
            expected: expectedBaseOf({ quantity: orderLine.quantity.toString(), baseQuantity: orderLine.baseQuantity.toString(), confirmedQuantity: orderLine.confirmedQuantity?.toString() ?? null }),
            receivedBefore: before,
            receiving: line.baseQuantity.toString(),
            tolerancePct: orderLine.areaTolerancePct?.toString() ?? null,
          })
        : null
      return {
        seq: line.seq,
        purchaseOrderLineId: line.purchaseOrderLineId,
        item: { code: item.code, name: item.name, tracking: item.tracking },
        colour: colour ? { code: colour.code, name: colour.name } : null,
        quantity: quantityText(line.quantity.toString()),
        uom: line.uom,
        baseQuantity: quantityText(line.baseQuantity.toString()),
        hideCount: line.hideCount,
        difference: difference ? { kind: difference.kind, expected: difference.expected, after: difference.after, open: difference.open, difference: difference.difference, upTo: difference.upTo } : null,
      }
    }),
    lots: read.lots.map((lot) => {
      const line = read.lines.find((entry) => entry.id === lot.receiptLineId)!
      const item = read.items.get(line.itemId)!
      const lotMoves = read.moves.filter((move) => move.lotId === lot.id)
      const place = lotMoves[0]?.toLocationId ? read.places.get(lotMoves[0].toLocationId) ?? null : null
      const holds: HoldReason[] = []
      if (lot.qualityStatus === 'QUARANTINE') {
        if (lot.requiresCrViTest && lot.crViStatus !== 'PASS') holds.push('CR_VI_TEST')
        if (item.isPpeComponent) holds.push('PPE_CERTIFICATE')
        if (lot.qualityNote) holds.push('QUALITY_HOLD')
      }
      return {
        id: lot.id,
        code: lot.code,
        lineSeq: line.seq,
        supplierLotRef: lot.supplierLotRef,
        dyeBatch: lot.dyeBatch,
        qualityStatus: lot.qualityStatus,
        holds,
        requiresCrViTest: lot.requiresCrViTest,
        crViStatus: lot.crViStatus,
        baseQuantity: quantityText(lotMoves.reduce((sum, move) => sum.plus(dec(move.baseQuantity)), ZERO)),
        hideCount: read.hides.filter((hide) => hide.lotId === lot.id).length,
        location: place,
      }
    }),
    hides: read.hides.map((hide) => ({
      id: hide.id,
      code: hide.code,
      lotId: hide.lotId,
      lotCode: lotById.get(hide.lotId)?.code ?? '',
      supplierCode: hide.supplierCode,
      area: quantityText(hide.area.toString()),
      areaUom: hide.areaUom,
      grade: hide.grade,
      shade: hide.shade,
      thicknessMm: hide.thicknessMm === null ? null : hide.thicknessMm.toFixed(2),
    })),
    tags: {
      printer: lastPrinter,
      jobs: read.hides.map((hide) => {
        const job = newest.get(hide.id)
        const problem = printing.problems?.get(hide.id) ?? (job?.status === 'FAILED' ? (job.lastError ?? 'The printer could not print it.') : null)
        return { hideId: hide.id, code: hide.code, jobId: job?.id ?? null, status: job?.status ?? null, version: job?.version ?? null, problem }
      }),
    },
  }
}

/** GET /inventory/receiving/receipts/:receiptId (the floor's own site; a receipt of another site is not found). */
export async function getFloorReceipt(caller: CommandCaller, receiptId: string) {
  const context = receiverOf(caller)
  return { receipt: await floorReceipt(caller, context, receiptId) }
}

import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { expectedBaseOf, RECEIVING_ORDER_STATUSES } from '@nexus/factory-domain/inventory/receipts/rules'
import { INVENTORY_UNPLANNED_DECIDE } from '@nexus/factory-domain/inventory/unplanned/permissions'
import { candidateLines, hideAreasOf, namingProblems, sendBackProblem, sentBackNote, unplannedStateOf } from '@nexus/factory-domain/inventory/unplanned/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { OrderForReceipt } from '../../purchasing/receiving'
import { officeContextOf } from '../ledger/access'
import { recordReceiptInCommand, type LineBody, type LotBody } from '../receipts/record'
import { byId, DDT_PHOTO_WHERE, ids, readColours, readOrderLines, type Reader } from '../receipts/store'
import { askBuyerInCommand, closeBuyerTaskInCommand } from './buyer'
import { lineLabel, lockUnplanned, readUnplanned, readUnplannedLines, UNPLANNED_ITEM_COLUMNS, type UnplannedLineRow, type UnplannedRow } from './store'

/**
 * Goods without a purchase order in the office (B-W2b-300; SCM-122 "a buyer task asks for the PO or a return; nothing is used
 * until a PO names them"). Office only; reading is inventory.stock.view over the receipt's site, deciding
 * inventory.unplanned.decide (the buyer and the warehouse templates).
 *
 *   GET  /inventory/unplanned/:receiptId         the goods as they wait: lines, holding place, the DDT and its photos, the buyer's
 *                                                task, and the supplier's open orders at the site with the lines each waiting line
 *                                                could go to (same material and colour, not ended)
 *   POST /inventory/unplanned/:receiptId/order   ONE command: the receipt locked at the version read, the order named (the
 *                                                supplier's, SENT, CONFIRMED or PARTLY_RECEIVED, to this site), every waiting line
 *                                                to one of its lines, then posted as W1 posts (receipts/record.ts
 *                                                recordReceiptInCommand: the order's lock, tolerances, lots and hides with our
 *                                                numbers, RECEIPT moves into the holding place valued at the order's price, POSTED,
 *                                                the order moved on, inventory.receipt_posted), the buyer's task done
 *   POST /inventory/unplanned/:receiptId/return  the goods go back to the supplier: CANCELLED with why, the buyer's task done
 *   POST /inventory/unplanned/:receiptId/buyer   ask the buyer again when the system could not (a task named once)
 */

const day = (value: Date | null): string | null => (value === null ? null : businessDate(value, 'UTC'))

async function visibleUnplanned(caller: CommandCaller, receiptId: string) {
  const context = officeContextOf(caller)
  const receipt = isUuid(receiptId) ? await caller.withClient((client) => readUnplanned(client, receiptId)) : null
  if (!receipt || !can(actorOf(context), INVENTORY_STOCK_VIEW, { companyId: receipt.companyId, siteId: receipt.siteId })) throw new NotFoundError('Goods without a purchase order not found.')
  return { context, receipt }
}

function deciding(context: OfficeContext, receipt: Pick<UnplannedRow, 'companyId' | 'siteId'>) {
  if (!can(actorOf(context), INVENTORY_UNPLANNED_DECIDE, { companyId: receipt.companyId, siteId: receipt.siteId })) throw new ForbiddenError(`Deciding on goods without a PO needs ${INVENTORY_UNPLANNED_DECIDE} over the company.`)
}

/** The supplier's orders at the site that take goods now, with their open lines. */
async function openOrdersOf(db: Reader, receipt: Pick<UnplannedRow, 'siteId' | 'supplierId'>) {
  const orders = await db.purchaseOrder.findMany({ where: { siteId: receipt.siteId, partyId: receipt.supplierId, status: { in: [...RECEIVING_ORDER_STATUSES] } }, orderBy: [{ number: 'asc' }, { id: 'asc' }], take: 50, select: { id: true, number: true, status: true, version: true, requestedDate: true } })
  const out = []
  for (const order of orders) {
    const { lines, received } = await readOrderLines(db, order.id)
    out.push({ order, lines, received })
  }
  return out
}

const hideCountOf = (line: UnplannedLineRow) => line.hideCount

/** GET /inventory/unplanned/:receiptId */
export async function unplannedDetail(caller: CommandCaller, receiptId: string) {
  const { context, receipt } = await visibleUnplanned(caller, receiptId)
  const read = await caller.withClient(async (client) => {
    const lines = await readUnplannedLines(client, receipt.id)
    const orders = receipt.status === 'OPEN' ? await openOrdersOf(client, receipt) : []
    const itemIds = [...lines.map((line) => line.itemId), ...orders.flatMap((entry) => entry.lines.map((line) => line.itemId))]
    const items = byId(await client.item.findMany({ where: { id: { in: ids(itemIds) } }, select: UNPLANNED_ITEM_COLUMNS }))
    const colours = await readColours(client, [...lines.map((line) => line.itemColourId), ...orders.flatMap((entry) => entry.lines.map((line) => line.itemColourId))])
    const place = receipt.holdingLocationId ? await client.location.findUnique({ where: { id: receipt.holdingLocationId }, select: { id: true, code: true, name: true } }) : null
    const supplier = await client.party.findUnique({ where: { id: receipt.supplierId }, select: { id: true, code: true, legalName: true, tradeName: true } })
    const site = await client.site.findUnique({ where: { id: receipt.siteId }, select: { id: true, code: true, name: true } })
    const photos = await client.storedFile.findMany({ where: { ...DDT_PHOTO_WHERE(receipt.id), status: 'AVAILABLE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, originalName: true } })
    const task = receipt.buyerTaskId ? await client.task.findUnique({ where: { id: receipt.buyerTaskId }, select: { id: true, title: true, status: true, dueDate: true, assigneeId: true } }) : null
    const assignee = task?.assigneeId ? await client.user.findUnique({ where: { id: task.assigneeId }, select: { id: true, displayName: true } }) : null
    const posted = receipt.purchaseOrderId ? await client.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId }, select: { id: true, number: true } }) : null
    return { lines, orders, items, colours, place, supplier, site, photos, task, assignee, posted }
  })
  const actor = actorOf(context)
  const waiting = read.lines.map((line) => ({ id: line.id, seq: line.seq, itemId: line.itemId, itemColourId: line.itemColourId, label: lineLabel(line.seq, read.items.get(line.itemId)!, line.itemColourId ? read.colours.get(line.itemColourId) : null) }))
  const colourView = (id: string | null) => {
    const colour = id ? read.colours.get(id) : undefined
    return colour ? { id: colour.id, code: colour.code, name: colour.name } : null
  }
  const itemView = (id: string) => {
    const item = read.items.get(id)!
    return { id: item.id, code: item.code, name: item.name, tracking: item.tracking as 'NONE' | 'LOT' | 'HIDE', baseUom: item.baseUom }
  }
  const decide = can(actor, INVENTORY_UNPLANNED_DECIDE, { companyId: receipt.companyId, siteId: receipt.siteId })
  return {
    receipt: {
      id: receipt.id,
      number: receipt.number,
      status: receipt.status,
      state: unplannedStateOf(receipt.status),
      version: receipt.version,
      companyId: receipt.companyId,
      site: read.site!,
      supplier: { id: receipt.supplierId, code: read.supplier?.code ?? '', name: read.supplier?.tradeName ?? read.supplier?.legalName ?? '' },
      holding: read.place,
      supplierDdtNumber: receipt.supplierDdtNumber,
      supplierDdtDate: day(receipt.supplierDdtDate),
      receivedAt: toUtcIso(receipt.receivedAt),
      note: receipt.note,
      purchaseOrder: read.posted,
      ddtPhotos: read.photos,
    },
    lines: read.lines.map((line) => ({ id: line.id, seq: line.seq, item: itemView(line.itemId), colour: colourView(line.itemColourId), quantity: quantityText(line.quantity.toString()), uom: line.uom, baseQuantity: quantityText(line.baseQuantity.toString()), hideCount: hideCountOf(line), note: line.note })),
    buyerTask: read.task ? { id: read.task.id, title: read.task.title, status: read.task.status, dueDate: day(read.task.dueDate), assignee: read.assignee ? { id: read.assignee.id, name: read.assignee.displayName } : null } : null,
    orders: read.orders.map(({ order, lines, received }) => {
      const facts = lines.map((line) => ({ id: line.id, seq: line.seq, itemId: line.itemId, itemColourId: line.itemColourId, ended: line.cancelledAt !== null || line.closedShortAt !== null }))
      const candidates = candidateLines(waiting, facts)
      return {
        id: order.id,
        number: order.number,
        status: order.status,
        version: order.version,
        requestedDate: day(order.requestedDate),
        lines: lines
          .filter((line) => line.cancelledAt === null && line.closedShortAt === null)
          .map((line) => {
            const expected = expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null })
            const came = received.get(line.id) ?? ZERO
            return { id: line.id, seq: line.seq, item: itemView(line.itemId), colour: colourView(line.itemColourId), quantity: quantityText(line.quantity.toString()), uom: line.uom, openBase: quantityText(Dec.max(ZERO, expected.minus(came)).toString()), tolerancePct: line.areaTolerancePct === null ? null : line.areaTolerancePct.toString() }
          }),
        /** Per waiting line (its id), the lines of this order it could go to. */
        fits: waiting.map((line) => ({ receiptLineId: line.id, purchaseOrderLineIds: candidates.get(line.id) ?? [] })),
      }
    }),
    can: { decide: decide && receipt.status === 'OPEN', askBuyer: decide && receipt.status === 'OPEN' && receipt.buyerTaskId === null },
  }
}

// ---- name the order --------------------------------------------------------------------------------------------------------------

export interface NameLineBody {
  readonly receiptLineId: string
  readonly purchaseOrderLineId: string
  /** A lot-tracked line: the supplier's lot and dye batch (one lot of the whole line). */
  readonly supplierLotRef?: string | null | undefined
  readonly dyeBatch?: string | null | undefined
  /** Leather: each hide's area, in `areaUom` (default the order line's unit when it is an area, else the base unit). */
  readonly hideAreas?: readonly string[] | undefined
  readonly differenceReason?: string | undefined
}

export interface NameOrderBody {
  readonly version: number
  readonly purchaseOrderId: string
  readonly lines: readonly NameLineBody[]
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

/** The waiting line as a W1 receipt line against its order line (the posting's own rules check it again). */
function lineBodyOf(line: UnplannedLineRow, named: NameLineBody, tracking: string): { body: LineBody; problem: Issue | null } {
  const base = { purchaseOrderLineId: named.purchaseOrderLineId, ...(named.differenceReason ? { differenceReason: named.differenceReason } : {}), note: line.note }
  if (tracking === 'HIDE') {
    const typed = hideAreasOf((named.hideAreas ?? []).join(' '))
    if (typed.problem) return { body: base, problem: { path: 'hideAreas', message: typed.problem } }
    const lot: LotBody = { supplierLotRef: named.supplierLotRef ?? null, dyeBatch: named.dyeBatch ?? null, hides: typed.areas.map((area) => ({ area, areaUom: line.uom })) }
    return { body: { ...base, lots: [lot] }, problem: null }
  }
  if (tracking === 'LOT') return { body: { ...base, uom: line.uom, lots: [{ supplierLotRef: named.supplierLotRef ?? null, dyeBatch: named.dyeBatch ?? null, quantity: quantityText(line.quantity.toString()) }] }, problem: null }
  return { body: { ...base, quantity: quantityText(line.quantity.toString()), uom: line.uom }, problem: null }
}

/** POST /inventory/unplanned/:receiptId/order */
export async function nameOrder(caller: CommandCaller, receiptId: string, body: NameOrderBody, idempotencyKey?: string) {
  const { context, receipt: seen } = await visibleUnplanned(caller, receiptId)
  deciding(context, seen)
  const { result } = await command(caller, { name: 'inventory.nameUnplannedOrder', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    const { tx } = tools
    const receipt = await lockUnplanned(tx, receiptId)
    if (!receipt) throw new NotFoundError('Goods without a purchase order not found.')
    if (receipt.status !== 'OPEN') throw new InvalidStateError(`${receipt.number} is ${receipt.status === 'CANCELLED' ? 'sent back' : 'posted'} already: it waits for no order.`)
    if (receipt.version !== body.version) throw new StaleVersionError('GoodsReceipt', receipt.id, receipt.version, body.version)
    const order = isUuid(body.purchaseOrderId) ? await tx.purchaseOrder.findUnique({ where: { id: body.purchaseOrderId }, select: { id: true, number: true, siteId: true, partyId: true, status: true } }) : null
    if (!order || order.siteId !== receipt.siteId) throw new ValidationError('Not a purchase order delivered to this site.', [{ path: 'body/purchaseOrderId', message: 'An order of this site.' }])
    if (order.partyId !== receipt.supplierId) throw new ValidationError(`${order.number} is another supplier's order: the goods came from the receipt's supplier.`, [{ path: 'body/purchaseOrderId', message: "The supplier's order." }])
    if (!RECEIVING_ORDER_STATUSES.includes(order.status)) throw new InvalidStateError(`${order.number} is ${order.status.toLowerCase().replace(/_/g, ' ')}: goods are received against a sent, confirmed or partly received order (send it first).`)
    if ((await tx.receiptDiscrepancy.count({ where: { receiptId: receipt.id } })) > 0) throw new ConflictError(`${receipt.number} has discrepancies recorded: settle them on the receipt's Discrepancies tab, or send the goods back.`)

    const waitingRows = await readUnplannedLines(tx, receipt.id)
    const items = byId(await tx.item.findMany({ where: { id: { in: ids(waitingRows.map((line) => line.itemId)) } }, select: UNPLANNED_ITEM_COLUMNS }))
    const colours = await readColours(tx, waitingRows.map((line) => line.itemColourId))
    const waiting = waitingRows.map((line) => ({ id: line.id, seq: line.seq, itemId: line.itemId, itemColourId: line.itemColourId, label: lineLabel(line.seq, items.get(line.itemId)!, line.itemColourId ? colours.get(line.itemColourId) : null) }))
    const { lines: orderLines } = await readOrderLines(tx, order.id)
    const facts = orderLines.map((line) => ({ id: line.id, seq: line.seq, itemId: line.itemId, itemColourId: line.itemColourId, ended: line.cancelledAt !== null || line.closedShortAt !== null }))
    const naming = namingProblems(waiting, facts, body.lines)
    if (naming.length > 0) throw new ValidationError(naming.length === 1 ? naming[0]!.message : 'The lines cannot go to this order as they are.', naming.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))

    // The waiting lines as W1 receipt lines, in the body's order (the posting's issue paths body/lines/<i> stay the body's).
    const problems: Issue[] = []
    const lines: LineBody[] = body.lines.map((named, index) => {
      const row = waitingRows.find((line) => line.id === named.receiptLineId)!
      const { body: line, problem } = lineBodyOf(row, named, items.get(row.itemId)!.tracking)
      if (problem) problems.push({ path: `body/lines/${index}/${problem.path}`, message: `${waiting.find((entry) => entry.id === row.id)!.label}: ${problem.message}` })
      return line
    })
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The lines cannot be posted as they are.', problems)

    const name = async (inner: CommandTools, named: OrderForReceipt) => {
      // The order on the receipt first (the line guard checks each new line against it), then the waiting lines go: the
      // posting writes the receipt's lines as received against the order.
      await inner.tx.goodsReceipt.update({ where: { id: receipt.id }, data: { purchaseOrderId: named.id, version: { increment: 1 }, updatedAt: inner.now }, select: { id: true } })
      await inner.tx.goodsReceiptLine.deleteMany({ where: { receiptId: receipt.id } })
    }
    const recorded = await recordReceiptInCommand(
      tools,
      {
        purchaseOrderId: order.id,
        locationId: receipt.holdingLocationId!,
        supplierDdtNumber: receipt.supplierDdtNumber,
        supplierDdtDate: day(receipt.supplierDdtDate),
        note: receipt.note,
        lines,
        ...(body.periodLockOverride ? { periodLockOverride: body.periodLockOverride } : {}),
      },
      `inventory.nameUnplannedOrder:${idempotencyKey ?? receipt.id}`,
      { unplanned: { receiptId: receipt.id, number: receipt.number, name } },
    )
    const by = context.actorId
    await closeBuyerTaskInCommand(tools, receipt, by)
    const scope = { companyId: receipt.companyId, siteId: receipt.siteId }
    tools.audit({ action: 'inventory.nameUnplannedOrder', recordType: 'GoodsReceipt', recordId: receipt.id, ...scope, before: { status: 'OPEN', purchaseOrderId: null }, after: { status: 'POSTED', purchaseOrderId: order.id, purchaseOrderStatus: recorded.orderStatus, lines: body.lines.map((line) => ({ receiptLineId: line.receiptLineId, purchaseOrderLineId: line.purchaseOrderLineId })), moves: recorded.moves.length } })
    tools.emit({ type: 'inventory.unplanned_changed', subject: receipt.id, ...scope, payload: { receiptId: receipt.id, number: receipt.number, change: 'ORDER_NAMED', supplierId: receipt.supplierId, holdingLocationId: receipt.holdingLocationId!, purchaseOrderId: order.id, buyerTaskId: receipt.buyerTaskId, lines: lines.length } })
    return { receiptId: receipt.id, number: receipt.number, purchaseOrder: { id: order.id, number: order.number, status: recorded.orderStatus }, notes: recorded.notes, moves: recorded.moves.length }
  })
  return result
}

// ---- send back -------------------------------------------------------------------------------------------------------------------

/** POST /inventory/unplanned/:receiptId/return */
export async function sendBack(caller: CommandCaller, receiptId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, receipt: seen } = await visibleUnplanned(caller, receiptId)
  deciding(context, seen)
  const problem = sendBackProblem(body.reason)
  if (problem) throw new ValidationError(problem, [{ path: 'body/reason', message: problem }])
  const { result } = await command(caller, { name: 'inventory.sendUnplannedBack', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const receipt = await lockUnplanned(tx, receiptId)
    if (!receipt) throw new NotFoundError('Goods without a purchase order not found.')
    if (receipt.status !== 'OPEN') throw new InvalidStateError(`${receipt.number} is ${receipt.status === 'CANCELLED' ? 'sent back' : 'posted'} already.`)
    if (receipt.version !== body.version) throw new StaleVersionError('GoodsReceipt', receipt.id, receipt.version, body.version)
    const note = [receipt.note, sentBackNote(body.reason)].filter(Boolean).join('\n')
    await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { status: 'CANCELLED', cancelledAt: now, note, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await closeBuyerTaskInCommand(tools, receipt, context.actorId)
    const scope = { companyId: receipt.companyId, siteId: receipt.siteId }
    tools.audit({ action: 'inventory.sendUnplannedBack', recordType: 'GoodsReceipt', recordId: receipt.id, ...scope, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason: body.reason.trim() })
    const lines = (await readUnplannedLines(tx, receipt.id)).length
    tools.emit({ type: 'inventory.unplanned_changed', subject: receipt.id, ...scope, payload: { receiptId: receipt.id, number: receipt.number, change: 'SENT_BACK', supplierId: receipt.supplierId, holdingLocationId: receipt.holdingLocationId!, purchaseOrderId: null, buyerTaskId: receipt.buyerTaskId, lines } })
    return { receiptId: receipt.id, number: receipt.number, status: 'CANCELLED' as const }
  })
  return result
}

/** POST /inventory/unplanned/:receiptId/buyer */
export async function askBuyerAgain(caller: CommandCaller, receiptId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context, receipt: seen } = await visibleUnplanned(caller, receiptId)
  deciding(context, seen)
  const { result } = await command(caller, { name: 'inventory.askBuyer', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    const receipt = await lockUnplanned(tools.tx, receiptId)
    if (!receipt) throw new NotFoundError('Goods without a purchase order not found.')
    if (receipt.status !== 'OPEN') throw new InvalidStateError(`${receipt.number} waits for no buyer any more.`)
    if (receipt.version !== body.version) throw new StaleVersionError('GoodsReceipt', receipt.id, receipt.version, body.version)
    if (receipt.buyerTaskId) throw new ConflictError(`${receipt.number} has its buyer's task already: reassign it on the task.`)
    return { buyerTaskId: await askBuyerInCommand(tools, receipt.id, context.actorId) }
  })
  return result
}


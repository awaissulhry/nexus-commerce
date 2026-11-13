import type { Uom } from '@nexus/factory-db'
import { z } from 'zod'
import { businessDate as businessDay, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant, type BusinessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_RECEIVE } from '@nexus/factory-domain/inventory/permissions'
import { CUSTOMER_MATERIAL_LIMITS, quantityProblem } from '@nexus/factory-domain/sales/customer-materials/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { planInCommand, recountInCommand } from '../../sales/customer-materials/store'
import { officeContextOf } from '../ledger/access'
import { postMoves, type MoveDraft } from '../ledger/post-moves'
import { lotNumber, receiptNumber } from './numbers'

/**
 * Goods a customer sends for its own orders (B-W2b-309; SAL-306; follow-up SO2:01 "received from the customer into stock the
 * customer owns (never valued, bought or used for another order)"): the office records them as a CUSTOMER_SUPPLIED goods
 * receipt (B-W2b-281: no purchase order, no ship notice; the sender a CUSTOMER or BRAND party; LOT-tracked materials), each
 * line one lot owned by the sender (Lot.ownerPartyId), RELEASED as it arrives (the brand's own material), with its RECEIPT
 * move — never valued (the ledger's valuation skips owned lots; the database refuses a value for them) and never matched to a
 * supplier invoice. W1's `inventory.receipt_posted` follows (no purchase order: the put-away task, the search, the incoming
 * checks). What goes back to the customer is a SUPPLIER_RETURN move of its own lot, named after the order it was for.
 * Afterwards the customer's materials on its orders are counted again (modules/sales/customer-materials).
 *
 *   POST /inventory/receipts/customer           inventory.receive over the site: {siteId, partyId, orderId?, locationId,
 *                                               supplierDdtNumber?, supplierDdtDate?, receivedAt?, note?, lines[{itemId,
 *                                               itemColourId?, quantity, uom?, supplierLotRef?}]}
 *   POST /inventory/receipts/customer/returns   inventory.receive over the site: {siteId, partyId, orderId?, note?, lines[{lotId,
 *                                               fromLocationId, quantity}]}
 *
 * HIDE-tracked leather is not received here hide by hide (W1's hide tags and measures are a purchase receipt's): receive it as
 * a LOT-tracked material, or by the purchase route.
 */

export interface CustomerReceiptBody {
  readonly siteId: string
  readonly partyId: string
  readonly orderId?: string | null | undefined
  readonly locationId: string
  readonly supplierDdtNumber?: string | null | undefined
  readonly supplierDdtDate?: BusinessDate | null | undefined
  readonly receivedAt?: string | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly { readonly itemId: string; readonly itemColourId?: string | null | undefined; readonly quantity: string; readonly uom?: Uom | undefined; readonly supplierLotRef?: string | null | undefined }[]
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())
const invalid = (issues: Issue[]) => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The goods cannot be recorded like this.', issues)

async function siteScope(caller: CommandCaller, siteId: string) {
  const context = officeContextOf(caller)
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }))
  if (!site) throw new NotFoundError('Site not found.')
  if (!can(actorOf(context), INVENTORY_RECEIVE, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError("Recording the customer's goods at this site needs inventory.receive.")
  return { context, site }
}

async function customerOf(tools: CommandTools, partyId: string) {
  const party = await tools.tx.party.findUnique({ where: { id: partyId }, select: { id: true, roles: true, legalName: true } })
  if (!party) throw new NotFoundError('Customer not found.')
  if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) throw new DomainError('validation_failed', `${party.legalName} is not a customer or a brand: goods it sends are bought, not its own.`, [{ path: 'body/partyId', message: 'A CUSTOMER or BRAND party.' }])
  return party
}

async function orderOf(tools: CommandTools, input: { readonly orderId: string | null | undefined; readonly partyId: string; readonly companyId: string }) {
  if (!input.orderId) return null
  const order = await tools.tx.salesOrder.findUnique({ where: { id: input.orderId }, select: { id: true, number: true, partyId: true, companyId: true, status: true } })
  if (!order || order.partyId !== input.partyId || order.companyId !== input.companyId) throw new DomainError('validation_failed', "The order is not one of this customer's with this site's company.", [{ path: 'body/orderId', message: "One of the customer's orders." }])
  return order
}

/** POST /inventory/receipts/customer */
export async function recordCustomerReceipt(caller: CommandCaller, body: CustomerReceiptBody, idempotencyKey?: string) {
  const { context, site } = await siteScope(caller, body.siteId)
  const issues: Issue[] = []
  if (body.lines.length === 0 || body.lines.length > CUSTOMER_MATERIAL_LIMITS.receiptLines) issues.push({ path: 'body/lines', message: `1 to ${CUSTOMER_MATERIAL_LIMITS.receiptLines} lines.` })
  body.lines.forEach((line, index) => {
    const problem = quantityProblem(line.quantity, `body/lines/${index}/quantity`)
    if (problem) issues.push(problem)
  })
  const receivedAt = body.receivedAt ? parseInstant(body.receivedAt) : null
  if (body.receivedAt && !receivedAt) issues.push({ path: 'body/receivedAt', message: 'An instant (ISO 8601 with a zone).' })
  if (issues.length > 0) throw invalid(issues)
  const { result } = await command(caller, { name: 'inventory.receiveFromCustomer', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const party = await customerOf(tools, body.partyId)
    const order = await orderOf(tools, { orderId: body.orderId, partyId: party.id, companyId: site.companyId })
    const at = receivedAt ?? now
    if (at > now) throw invalid([{ path: 'body/receivedAt', message: 'Not in the future.' }])
    const items = await tx.item.findMany({ where: { id: { in: [...new Set(body.lines.map((line) => line.itemId))] } }, select: { id: true, code: true, tracking: true, baseUom: true } })
    const lineIssues: Issue[] = []
    body.lines.forEach((line, index) => {
      const item = items.find((entry) => entry.id === line.itemId)
      if (!item) lineIssues.push({ path: `body/lines/${index}/itemId`, message: 'Material not found.' })
      else if (item.tracking !== 'LOT') lineIssues.push({ path: `body/lines/${index}/itemId`, message: `${item.code} is ${item.tracking === 'HIDE' ? 'tracked hide by hide' : 'not tracked by lot'}: a customer's own material is received as lots (the lot carries its owner).` })
    })
    if (lineIssues.length > 0) throw invalid(lineIssues)
    const receiptId = newId()
    const number = await receiptNumber(tools, { companyId: site.companyId, receiptId, date: businessDate(at) })
    const actorId = context.actorId
    await tx.goodsReceipt.create({
      data: { id: receiptId, companyId: site.companyId, siteId: site.id, number, supplierId: party.id, purchaseOrderId: null, kind: 'CUSTOMER_SUPPLIED', supplierDdtNumber: blank(body.supplierDdtNumber), supplierDdtDate: body.supplierDdtDate ? new Date(`${body.supplierDdtDate}T00:00:00.000Z`) : null, receivedAt: at, note: blank(body.note), createdAt: now, updatedAt: now, createdById: actorId },
      select: { id: true },
    })
    const drafts: MoveDraft[] = []
    const lotIds: string[] = []
    for (const [index, line] of body.lines.entries()) {
      const item = items.find((entry) => entry.id === line.itemId)!
      const lineId = newId()
      const uom = line.uom ?? item.baseUom
      await tx.goodsReceiptLine.create({ data: { id: lineId, siteId: site.id, receiptId, seq: (index + 1) * 10, purchaseOrderLineId: null, itemId: item.id, itemColourId: line.itemColourId ?? null, quantity: line.quantity, uom, baseQuantity: line.quantity, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
      const lotId = newId()
      const code = await lotNumber(tools, { companyId: site.companyId, lotId, date: businessDate(at) })
      await tx.lot.create({
        data: { id: lotId, companyId: site.companyId, siteId: site.id, itemId: item.id, itemColourId: line.itemColourId ?? null, code, ownerPartyId: party.id, supplierLotRef: blank(line.supplierLotRef), receiptLineId: lineId, receivedAt: at, qualityStatus: 'RELEASED', qualityNote: "The customer's own material, received as sent.", qualityDecidedAt: now, qualityDecidedById: actorId, createdAt: now, updatedAt: now, createdById: actorId },
        select: { id: true },
      })
      lotIds.push(lotId)
      drafts.push({ siteId: site.id, reason: 'RECEIPT', itemId: item.id, itemColourId: line.itemColourId ?? null, lotId, toLocationId: body.locationId, receiptLineId: lineId, reference: blank(body.supplierDdtNumber) ?? number, occurredAt: at, quantity: line.quantity, uom, cost: null })
    }
    const moves = await postMoves(tools, drafts, { key: `inventory.receiveFromCustomer:${idempotencyKey ?? receiptId}`, issuePath: (index) => `body/lines/${index}` })
    // The receipt line keeps the base quantity the ledger worked out (a unit the item converts).
    for (const [index, move] of moves.entries()) if (move.baseQuantity !== body.lines[index]!.quantity) await tx.goodsReceiptLine.update({ where: { id: move.receiptLineId! }, data: { baseQuantity: move.baseQuantity }, select: { id: true } })
    await tx.goodsReceipt.update({ where: { id: receiptId }, data: { status: 'POSTED', postedAt: now, postedById: actorId }, select: { id: true } })
    tools.audit({
      action: 'inventory.receiveFromCustomer',
      recordType: 'GoodsReceipt',
      recordId: receiptId,
      companyId: site.companyId,
      siteId: site.id,
      after: { number, status: 'POSTED', kind: 'CUSTOMER_SUPPLIED', partyId: party.id, orderId: order?.id ?? null, locationId: body.locationId, lines: body.lines.map((line, index) => ({ seq: (index + 1) * 10, itemId: line.itemId, quantity: line.quantity, uom: line.uom ?? null })), lotIds },
    })
    tools.emit({
      type: 'inventory.receipt_posted',
      subject: receiptId,
      companyId: site.companyId,
      siteId: site.id,
      payload: { receiptId, number, purchaseOrderId: null, purchaseOrderStatus: null, lotIds, quarantinedLotIds: [], hides: 0, moveIds: moves.map((move) => move.id), postedBy: 'OFFICE' },
    })
    // The customer's materials: the named order planned when it keeps none yet, then every row of these materials counted.
    if (order && (await tx.customerMaterial.count({ where: { orderId: order.id } })) === 0) await planInCommand(tools, order)
    const counted = await recountInCommand(tools, party.id, body.lines.map((line) => ({ itemId: line.itemId, itemColourId: line.itemColourId ?? null })))
    for (const changed of counted.orders) tools.emit({ type: 'customer_material.changed', subject: changed.id, companyId: changed.companyId, payload: { orderId: changed.id, number: changed.number, change: 'RECOUNTED', rows: changed.rows } })
    return { receiptId, number, lotIds }
  })
  return customerReceiptView(caller, result.receiptId)
}

export async function customerReceiptView(caller: CommandCaller, receiptId: string) {
  return caller.withClient(async (client) => {
    const receipt = await client.goodsReceipt.findUniqueOrThrow({ where: { id: receiptId }, select: { id: true, number: true, kind: true, status: true, siteId: true, companyId: true, supplierId: true, supplierDdtNumber: true, receivedAt: true } })
    const lines = await client.goodsReceiptLine.findMany({ where: { receiptId }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, itemId: true, itemColourId: true, quantity: true, uom: true, baseQuantity: true } })
    const lots = await client.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: { id: true, code: true, receiptLineId: true, ownerPartyId: true } })
    return {
      receipt: {
        id: receipt.id,
        number: receipt.number,
        kind: receipt.kind,
        status: receipt.status,
        siteId: receipt.siteId,
        partyId: receipt.supplierId,
        supplierDdtNumber: receipt.supplierDdtNumber,
        receivedAt: receipt.receivedAt.toISOString(),
        lines: lines.map((line) => {
          const lot = lots.find((entry) => entry.receiptLineId === line.id)
          return { id: line.id, seq: line.seq, itemId: line.itemId, itemColourId: line.itemColourId, quantity: new Dec(line.quantity.toString()).toFixed(4), uom: line.uom, baseQuantity: new Dec(line.baseQuantity.toString()).toFixed(4), lotId: lot?.id ?? null, lotCode: lot?.code ?? null, ownerPartyId: lot?.ownerPartyId ?? null }
        }),
      },
    }
  })
}

export interface CustomerReturnBody {
  readonly siteId: string
  readonly partyId: string
  readonly orderId?: string | null | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly { readonly lotId: string; readonly fromLocationId: string; readonly quantity: string }[]
}

/** POST /inventory/receipts/customer/returns */
export async function returnToCustomer(caller: CommandCaller, body: CustomerReturnBody, idempotencyKey?: string) {
  const { site } = await siteScope(caller, body.siteId)
  const issues: Issue[] = []
  if (body.lines.length === 0 || body.lines.length > CUSTOMER_MATERIAL_LIMITS.returnLines) issues.push({ path: 'body/lines', message: `1 to ${CUSTOMER_MATERIAL_LIMITS.returnLines} lines.` })
  body.lines.forEach((line, index) => {
    const problem = quantityProblem(line.quantity, `body/lines/${index}/quantity`)
    if (problem) issues.push(problem)
  })
  if (issues.length > 0) throw invalid(issues)
  const { result } = await command(caller, { name: 'inventory.returnToCustomer', idempotencyKey, input: body }, async (tools) => {
    const party = await customerOf(tools, body.partyId)
    const order = await orderOf(tools, { orderId: body.orderId, partyId: party.id, companyId: site.companyId })
    const lots = await tools.tx.lot.findMany({ where: { id: { in: body.lines.map((line) => line.lotId) } }, select: { id: true, code: true, itemId: true, itemColourId: true, siteId: true, ownerPartyId: true } })
    const lineIssues: Issue[] = []
    body.lines.forEach((line, index) => {
      const lot = lots.find((entry) => entry.id === line.lotId)
      if (!lot || lot.siteId !== site.id) lineIssues.push({ path: `body/lines/${index}/lotId`, message: 'A lot of this site.' })
      else if (lot.ownerPartyId !== party.id) lineIssues.push({ path: `body/lines/${index}/lotId`, message: `Lot ${lot.code} is not ${party.legalName}'s own material: only its own lots go back to it.` })
    })
    if (lineIssues.length > 0) throw invalid(lineIssues)
    const reference = order?.number ?? null
    const drafts: MoveDraft[] = body.lines.map((line) => {
      const lot = lots.find((entry) => entry.id === line.lotId)!
      return { siteId: site.id, reason: 'SUPPLIER_RETURN', itemId: lot.itemId, itemColourId: lot.itemColourId, lotId: lot.id, fromLocationId: line.fromLocationId, quantity: line.quantity, reference, note: blank(body.note), cost: null }
    })
    const moves = await postMoves(tools, drafts, { key: `inventory.returnToCustomer:${idempotencyKey ?? newId()}`, issuePath: (index) => `body/lines/${index}` })
    tools.audit({ action: 'inventory.returnToCustomer', recordType: 'Party', recordId: party.id, companyId: site.companyId, siteId: site.id, after: { orderId: order?.id ?? null, moves: moves.map((move) => ({ id: move.id, lotId: move.lotId, quantity: move.quantity, uom: move.uom })) }, ...(blank(body.note) ? { reason: blank(body.note)! } : {}) })
    const counted = await recountInCommand(tools, party.id, lots.map((lot) => ({ itemId: lot.itemId, itemColourId: lot.itemColourId })))
    for (const changed of counted.orders) tools.emit({ type: 'customer_material.changed', subject: changed.id, companyId: changed.companyId, payload: { orderId: changed.id, number: changed.number, change: 'RECOUNTED', rows: changed.rows } })
    return { moveIds: moves.map((move) => move.id) }
  })
  return { moveIds: result.moveIds }
}

// ---- contracts (B-W2b-309: kept beside the commands, W1's contract.ts unchanged) --------------------------------------------

const uom = z.enum(UOMS)
const text = (max: number) => z.string().trim().max(max)

export const recordCustomerReceiptContract = defineContract({
  body: input({
    siteId: id(),
    partyId: id(),
    orderId: id().nullish(),
    locationId: id(),
    supplierDdtNumber: text(60).nullish(),
    supplierDdtDate: businessDay().nullish(),
    receivedAt: instant().optional(),
    note: text(2000).nullish(),
    lines: z.array(input({ itemId: id(), itemColourId: id().nullish(), quantity: z.string().trim().min(1).max(20), uom: uom.optional(), supplierLotRef: text(80).nullish() })).min(1).max(CUSTOMER_MATERIAL_LIMITS.receiptLines),
  }),
  response: {
    201: output({
      receipt: output({
        id: id(),
        number: z.string(),
        kind: z.string(),
        status: z.string(),
        siteId: id(),
        partyId: id(),
        supplierDdtNumber: z.string().nullable(),
        receivedAt: instant(),
        lines: z.array(output({ id: id(), seq: z.number().int(), itemId: id(), itemColourId: id().nullable(), quantity: z.string(), uom: z.string(), baseQuantity: z.string(), lotId: id().nullable(), lotCode: z.string().nullable(), ownerPartyId: id().nullable() })),
      }),
    }),
  },
})

export const returnToCustomerContract = defineContract({
  body: input({
    siteId: id(),
    partyId: id(),
    orderId: id().nullish(),
    note: text(2000).nullish(),
    lines: z.array(input({ lotId: id(), fromLocationId: id(), quantity: z.string().trim().min(1).max(20) })).min(1).max(CUSTOMER_MATERIAL_LIMITS.returnLines),
  }),
  response: { 201: output({ moveIds: z.array(id()) }) },
})

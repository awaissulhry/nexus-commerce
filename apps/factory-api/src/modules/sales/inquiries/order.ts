import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { OrderBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import { orderMadeWords, orderRefusal, sizesOf, type OrderableLine, type OrderWaitsFor } from '@nexus/factory-domain/sales/inquiries/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { makeManualOrderInCommand, type ManualOrderBody } from '../orders/manual'
import { carryFiles, requestFiles, type CarriedFiles } from './carry'
import { emitClosed, lockForChange, viewInCommand, writeInquiry } from './inquiries'
import { databaseRefusal, dayOrNull, factsOf, LINE_COLUMNS, officeInquiry, readInquiryRow, refuse, type InquiryData, type LineData } from './store'

/**
 * B-TH-025 (threads plan TH-2, G3, N8, L2-G06; design O-SAL-INQ-LIST.pane-actions-F02 "Make order"; wall W37): the order made
 * straight from a request.
 *
 *   POST /sales/inquiries/:inquiryId/order   sales.inquiries.manage and orders.manage over the request's company and customer
 *
 * In ONE command: the request locked at the version read; every line ready (a style, its colourway, pieces by size — else
 * refused in words, line by line: "make the style draft first"); the order made by the office's own manual entry
 * (orders/manual `makeManualOrderInCommand`: the SALES_ORDER number, the customer on hold or blocked refused, its PO number
 * where its terms want one, the minimum quantities, the deposit, the payment schedule, the credit limit and an approval rule,
 * so it is CONFIRMED or PENDING_APPROVAL, `sales_order.created`); the request ORDERED naming it (`salesOrderId`, the database:
 * the order is of the request's own company AND customer) with `inquiry.closed` ORDERED. Then the request's files are carried
 * to the order (Use on…, ./carry.ts). The answer says the order's own state in words: made and confirmed, or made and waiting
 * for approval and why (never "confirmed" while it waits: the customer's notice says the same, B-TH-006).
 *
 * The brand wall (W37): the order's customer, company, contact and delivery address are the REQUEST's, never the body's (the
 * body names prices, a promise date and a PO only). The order made from brand A's request is brand A's.
 */

/** The manual order's line problems name the request's lines by their seq ("Line 20: …"), not the order body's index. */
function byRequestLine(issues: readonly Issue[], lines: readonly LineData[]): Issue[] {
  return issues.map((issue) => {
    const found = /^body\/lines\/(\d+)(\/.*)?$/.exec(issue.path)
    const line = found ? lines[Number(found[1])] : undefined
    return line ? { path: `inquiry/lines/${line.seq}${found![2] ?? ''}`, message: `Line ${line.seq}: ${issue.message}` } : issue
  })
}

const orderable = (lines: readonly LineData[]): OrderableLine[] => lines.map((line) => ({ seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, description: line.description, note: line.note, sizes: sizesOf(line.sizes) }))

/** The manual order the request becomes: the request's customer, contact, delivery address and lines; the body's prices, date and PO. */
function orderOf(row: InquiryData, lines: readonly LineData[], body: OrderBody, today: BusinessDate): ManualOrderBody {
  const prices = new Map((body.prices ?? []).map((entry) => [entry.seq, entry.unitPrice as unknown as string]))
  const wanted = dayOrNull(row.wantedDate) as BusinessDate | null
  const ahead = wanted !== null && wanted >= today ? wanted : null
  return {
    companyId: row.companyId,
    partyId: row.partyId!,
    ...(row.contactId ? { contactId: row.contactId } : {}),
    ...(body.customerRef ? { customerRef: body.customerRef } : row.customerRef ? { customerRef: row.customerRef } : {}),
    requestedDate: ahead,
    promiseDate: body.promiseDate === undefined ? ahead : body.promiseDate,
    ...(row.shipToAddressId ? { shipToAddressId: row.shipToAddressId } : {}),
    lines: lines.map((line) => ({
      styleId: line.styleId!,
      colourwayId: line.colourwayId!,
      sizes: Object.entries(sizesOf(line.sizes)).map(([size, quantity]) => ({ size, quantity })),
      ...(prices.has(line.seq) ? { unitPrice: prices.get(line.seq)! } : {}),
    })),
  }
}

/** Why the order made waits, read in the command that made it: its credit check held it, else an approval rule did. */
async function waitsForOf(tools: CommandTools, orderId: string): Promise<OrderWaitsFor | null> {
  const order = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })
  if (order.status !== 'PENDING_APPROVAL') return null
  const held = await tools.tx.creditCheck.findFirst({ where: { recordType: 'SalesOrder', recordId: orderId, result: 'HOLD' }, select: { id: true } })
  return held ? 'CREDIT' : 'APPROVAL'
}

/** POST /sales/inquiries/:inquiryId/order: "Make order". */
export async function orderInquiry(caller: CommandCaller, inquiryId: string, body: OrderBody, idempotencyKey?: string) {
  const { context, inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_MANAGE)
  const lines = await caller.withClient((db) => db.inquiryLine.findMany({ where: { inquiryId: inquiry.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } }))
  // The request's own refusals are said inside the command (after its lock): a repeat of a call that made the order (the same
  // Idempotency-Key) answers the stored order instead of "it is ordered".
  if (inquiry.partyId !== null && !can(actorOf(context), ORDERS_MANAGE, { companyId: inquiry.companyId, partyId: inquiry.partyId })) throw new ForbiddenError('Making the order needs the right to make orders for this company and customer.')
  const unknown = (body.prices ?? []).filter((entry) => !lines.some((line) => line.seq === entry.seq))
  if (unknown.length > 0) throw new ValidationError(`The request has no line ${unknown.map((entry) => entry.seq).join(', ')}.`, unknown.map((entry) => ({ path: `body/prices/${entry.seq}`, message: `The request has no line ${entry.seq}.` })))

  const { result } = await command(caller, { name: 'sales.inquiries.order', idempotencyKey, input: { inquiryId, ...body } }, async (tools) => {
    // Locked first, then the request's own refusal (an ordered request says so whatever version was read), then the version.
    await tools.tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${inquiry.id}::uuid FOR UPDATE`
    const locked = await tools.tx.inquiryLine.findMany({ where: { inquiryId: inquiry.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const current = await readInquiryRow(tools.tx, inquiry.id)
    if (current) refuse(orderRefusal(factsOf(current), orderable(locked)))
    const row = await lockForChange(tools, context, inquiryId, body.version)
    let made: { orderId: string; number: string }
    try {
      made = await makeManualOrderInCommand(tools, orderOf(row, locked, body, businessDate(tools.now)), null, 'ORDER')
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      const issues = byRequestLine(error.issues ?? [], locked)
      throw new ValidationError(issues.length === 1 ? issues[0]!.message : `${row.number} cannot become an order like this.`, issues)
    }
    const waitsFor = await waitsForOf(tools, made.orderId)
    const status: 'CONFIRMED' | 'PENDING_APPROVAL' = waitsFor === null ? 'CONFIRMED' : 'PENDING_APPROVAL'
    await writeInquiry(tools, row, { status: 'ORDERED', salesOrderId: made.orderId, closedAt: tools.now, closedById: context.actorId })
    tools.audit({ action: 'sales.inquiries.order', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'ORDERED', salesOrderId: made.orderId, orderNumber: made.number, orderStatus: status } })
    emitClosed(tools, row, 'ORDERED', null, null, made.orderId)
    return { inquiry: await viewInCommand(tools, row.id), order: { id: made.orderId, number: made.number, status, waitsFor }, said: orderMadeWords(made.number, row.number, waitsFor) }
  }).catch(databaseRefusal)

  // The request's files go with it (Use on…), as the person who made the order.
  const files: CarriedFiles = body.carryFiles === false ? { carried: [], notCarried: [] } : await carryFiles(caller, await requestFiles(caller, inquiry), { recordType: 'SalesOrder', recordId: result.order.id }, idempotencyKey)
  return { ...result, files }
}

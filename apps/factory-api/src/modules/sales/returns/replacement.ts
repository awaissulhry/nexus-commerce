import { ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_RETURNS_DECIDE } from '@nexus/factory-domain/sales/returns/permissions'
import { RETURN_LIMITS } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller } from '../../../core/command'
import { makeManualOrderInCommand } from '../orders/manual'
import { mayOn, officeReturn } from './access'
import { lockReturn, recordOf, touchReturn } from './rma'
import { lineKeyOf, readLines, soldFactsOf, type ReturnView } from './store'

/**
 * The replacement order (B-W2a-43; SAL-352 "Replacement order from the RMA"; design rma.credit "Replacement order (link)
 * with the RMA number", "Make replacement order"). sales.returns.decide on the RMA and orders.manage over its company and
 * customer. ONE command: the RMA row locked at the version read (RECEIVED or INSPECTED, no replacement order yet), every
 * received line decided Replace and not yet replaced becomes a line of ONE new sales order of the same company and
 * customer (B-W2a-30's manual order, made in this command: its number, CONFIRMED, the customer's addresses and terms),
 * one order line per return line: the same style and colourway, the received pieces of the same size, at no price (a
 * garment replaced under the guarantee is not sold again: the accountant confirms how it is invoiced, if at all), its
 * description naming the RMA. Then ReturnAuthorisation.replacementOrderId and each ReturnLine.replacementLineId. The
 * order then runs as any order (stock or production, its shipment, its DDT); events return.replacement_ordered and the
 * order's own sales_order.created.
 */

export interface ReplacementBody {
  readonly version: number
  readonly promiseDate?: BusinessDate | null | undefined
  readonly customerRef?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

export async function makeReplacementOrder(caller: CommandCaller, returnId: string, body: ReplacementBody, idempotencyKey?: string): Promise<{ return: ReturnView; order: { id: string; number: string } }> {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  if (!mayOn(context, ORDERS_MANAGE, seen)) throw new ForbiddenError(`Making the replacement order needs ${ORDERS_MANAGE} over the customer.`)
  if ((body.customerRef ?? '').trim().length > RETURN_LIMITS.customerRef) throw new ValidationError(`At most ${RETURN_LIMITS.customerRef} characters.`, [{ path: 'body/customerRef', message: `At most ${RETURN_LIMITS.customerRef} characters.` }])
  const { result } = await command(caller, { name: 'returns.makeReplacement', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, ['RECEIVED', 'INSPECTED'], 'its replacement order is made')
    if (rma.replacementOrderId) throw new InvalidStateError(`Return ${rma.number} has its replacement order already.`)
    const lines = (await readLines(tx, rma.id)).filter((line) => line.disposition === 'REPLACE' && line.replacementLineId === null)
    if (lines.length === 0) throw new InvalidStateError(`No line of return ${rma.number} is decided Replace.`)
    const sold = await soldFactsOf(tx, lines)
    const problems: Issue[] = []
    const orderLines = lines.flatMap((line) => {
      const facts = sold.get(lineKeyOf(line))
      if (!facts?.orderLine || !line.size) {
        problems.push({ path: `lines/${line.seq}`, message: `Line ${line.seq} names no style, colour and size: replace it by a typed order instead.` })
        return []
      }
      return [{ seq: line.seq, lineId: line.id, input: { styleId: facts.orderLine.styleId, colourwayId: facts.orderLine.colourwayId, sizes: [{ size: line.size, quantity: line.receivedQuantity }], unitPrice: '0', description: `Replacement for ${rma.number} line ${line.seq}: ${line.description}`.slice(0, 300) } }]
    })
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some lines cannot be replaced on an order.', problems)
    if (body.promiseDate && body.promiseDate < businessDate(now)) throw new ValidationError('The promise date is today or later.', [{ path: 'body/promiseDate', message: 'Today or later.' }])
    const made = await makeManualOrderInCommand(
      tools,
      {
        companyId: rma.companyId,
        partyId: rma.partyId,
        ...(rma.contactId ? { contactId: rma.contactId } : {}),
        customerRef: (body.customerRef ?? '').trim() || rma.number,
        promiseDate: body.promiseDate ?? null,
        paymentTermsId: null,
        depositPct: null,
        internalNote: (body.internalNote ?? '').trim() || `Replacement for return ${rma.number}.`,
        lines: orderLines.map((line) => line.input),
      },
      null,
    )
    const madeLines = await tx.salesOrderLine.findMany({ where: { orderId: made.orderId }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } })
    for (const [index, line] of orderLines.entries()) {
      const target = madeLines[index]!
      await tx.returnLine.update({ where: { id: line.lineId }, data: { replacementLineId: target.id, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'returns.replaceLine', recordType: 'ReturnLine', recordId: line.lineId, companyId: rma.companyId, siteId: rma.siteId, before: { replacementLineId: null }, after: { replacementLineId: target.id, orderId: made.orderId, orderLineSeq: target.seq } })
    }
    await touchReturn(tools, rma, { replacementOrderId: made.orderId })
    tools.audit({ recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { replacementOrderId: null }, after: { replacementOrderId: made.orderId, replacementOrderNumber: made.number } })
    tools.emit({ type: 'return.replacement_ordered', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, orderId: made.orderId, orderNumber: made.number, lineIds: orderLines.map((line) => line.lineId) } })
    return { order: { id: made.orderId, number: made.number } }
  })
  return { return: await recordOf(caller, seen.id), order: result.order }
}

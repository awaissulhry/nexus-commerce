import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { PRINTED_AGAIN, printAgainProblems, smallChangeNote, type PrintAgainAsk } from '@nexus/factory-domain/production/print-start/prints'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { stepInCommand } from '../calls/station'
import { goodsLinesOf, printOrder, printsOf, workOrdersOf } from '../print-start/store'

/**
 * POST /production/orders/:orderId/prints (production.print.start; owb- order workflow, S3 ss2 step 2.3; settle L7; design § 5zj B,
 * prototype reprint.js). "Print again" starts nothing: no basket, no step, no promise moves. ONE command (the order's row locked,
 * its version NOT bumped — printing changes nothing of the order):
 *
 *   - refused before the FIRST print; the ticked pages (a line of the order and a page) and basket cards (a basket made at print
 *     of the order, ACTIVE, its garments not gone, its work order not closed or cancelled) checked in words (400)
 *   - ONE OrderPrint AGAIN row (reason; the words of a small change, ≤ 140) — the SAME codes: never a new code, never a
 *     BundleReprint (the bench's MES-073 reprint stays as it is)
 *   - A small change: ONE "for the floor" note per open work order of the pieces ticked ("The design changed: …"), with today's
 *     production.floor_note_posted (change DESIGN); the floor's "I saw the new design" is S5's
 *   - every open PAPER help call ("Page lost or damaged") of a ticked basket SOLVED (today's call step, code PRINTED_AGAIN, "The
 *     office printed it again"); a basket not ticked keeps its call open
 *   - ONE audit row on the SalesOrder (who, when, why, how many)
 * The answer: the print's id, its number among the order's prints (FIRST = 1), the calls solved.
 */

export interface PrintAgainInput extends PrintAgainAsk {}

/** The order's baskets made at print, with what "Print again" checks of each (its work order, whether its garments left). */
export async function printBasketsOf(db: CommandTx, workOrderIds: readonly string[]) {
  if (workOrderIds.length === 0) return []
  const rows = await db.bundle.findMany({
    where: { workOrderId: { in: [...workOrderIds] }, madeAtPrint: true },
    select: { id: true, code: true, status: true, quantity: true, workOrderId: true, workOrderSizeId: true, workOrder: { select: { status: true, siteId: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const cellIds = [...new Set(rows.map((row) => row.workOrderSizeId))]
  const cells = cellIds.length > 0 ? await db.workOrderSize.findMany({ where: { id: { in: cellIds } }, select: { id: true, quantity: true } }) : []
  const left = cellIds.length > 0 ? await db.shipmentLine.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } }, _sum: { quantity: true } }) : []
  const leftOf = new Map(left.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const gone = new Set(cells.filter((cell) => (leftOf.get(cell.id) ?? 0) >= cell.quantity).map((cell) => cell.id))
  return rows.map((row) => ({ ...row, workOrderStatus: row.workOrder.status as string, shipped: gone.has(row.workOrderSizeId) }))
}

export async function printAgain(caller: CommandCaller, orderId: string, body: PrintAgainInput, idempotencyKey?: string): Promise<{ printId: string; printNo: number; solvedCalls: number }> {
  const { order, context } = await printOrder(caller, orderId)
  const note = body.note?.trim() ? body.note.trim() : null
  const { result } = await command(caller, { name: 'production.printAgain', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`
    const prints = await printsOf(tx, order.id)
    if (!prints.some((row) => row.kind === 'FIRST')) {
      const words = 'Nothing was printed yet: Print and start the work first.'
      throw new DomainError('conflict', words, [{ path: 'refusal/NOT_PRINTED', message: words }])
    }
    const lines = await goodsLinesOf(tx, order.id)
    const workOrders = await workOrdersOf(tx, lines.map((line) => line.id))
    const baskets = await printBasketsOf(tx, workOrders.map((workOrder) => workOrder.id))
    const problems = printAgainProblems(body, { lineIds: new Set(lines.map((line) => line.id)), baskets: new Map(baskets.map((basket) => [basket.id, { workOrderStatus: basket.workOrderStatus, status: basket.status, code: basket.code, shipped: basket.shipped }])) })
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'This print again does not hold together.', problems)

    const printId = newId()
    await tx.orderPrint.create({
      data: { id: printId, companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, kind: 'AGAIN', reason: body.reason, note, pages: body.pages.map((page) => ({ salesOrderLineId: page.salesOrderLineId, page: page.page })), cards: body.cards.map((card) => ({ bundleId: card.bundleId })), createdById: context.actorId },
      select: { id: true },
    })
    const printNo = prints.length + 1

    // A small change: one note for the floor per open work order of the pieces ticked.
    const floorNotes: { workOrderId: string; messageId: string }[] = []
    if (body.reason === 'SMALL_CHANGE' && note) {
      const tickedLines = new Set(body.pages.map((page) => page.salesOrderLineId))
      const basketOf = new Map(baskets.map((basket) => [basket.id, basket]))
      const tickedWorkOrders = new Set(body.cards.map((card) => basketOf.get(card.bundleId)?.workOrderId).filter((id): id is string => id !== undefined))
      for (const workOrder of workOrders) {
        const touched = tickedWorkOrders.has(workOrder.id) || workOrder.cells.some((cell) => cell.salesOrderLineId !== null && tickedLines.has(cell.salesOrderLineId))
        if (!touched || workOrder.status === 'CLOSED' || workOrder.status === 'CANCELLED' || workOrder.status === 'DRAFT') continue
        const { thread } = await ensureThread(tools, { type: 'WorkOrder', id: workOrder.id }, null)
        const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(smallChangeNote(note)), forFloor: true })
        floorNotes.push({ workOrderId: workOrder.id, messageId: message.id })
        tools.emit({
          type: 'production.floor_note_posted',
          subject: workOrder.id,
          companyId: workOrder.companyId,
          siteId: workOrder.siteId,
          payload: { workOrderId: workOrder.id, number: workOrder.number, siteId: workOrder.siteId, partyId: workOrder.partyId, messageId: message.id, salesOrderId: order.id, changes: ['DESIGN'] },
        })
      }
    }

    // The open "Page lost or damaged" calls of the ticked baskets: solved by this print.
    const ticked = body.cards.map((card) => card.bundleId)
    const calls = ticked.length > 0 ? await tx.helpCall.findMany({ where: { bundleId: { in: ticked }, status: { in: ['SENT', 'SEEN', 'ON_THE_WAY'] }, type: { code: 'PAPER' } }, select: { id: true }, orderBy: { id: 'asc' } }) : []
    for (const call of calls) await stepInCommand(tools, call.id, 'SOLVED', { at: tools.now, takerId: context.actorId, actor: 'RESPONDER', resolutionCode: PRINTED_AGAIN.resolutionCode, resolutionNote: PRINTED_AGAIN.resolutionNote })

    tools.audit({
      action: 'production.printAgain',
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      after: { printId, printNo, reason: body.reason, note, pages: body.pages.length, cards: body.cards.length, solvedCalls: calls.map((call) => call.id), floorNotes },
      ...(note ? { reason: note } : {}),
    })
    return { printId, printNo, solvedCalls: calls.length }
  })
  return result
}

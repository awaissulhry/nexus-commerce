import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { closeShortPlan, reopenPlan, type ShortLine } from '@nexus/factory-domain/sales/orders/daily'
import { MAX_REASON } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { reasonFor } from '../../../platform/reasons/service'
import { lockOrderLines } from '../../production/work-orders/store'
import { officeContextOf } from './access'
import { officeOrder, recordAfter } from './moves'
import { lockOrder, readOrderFacts, type OrderFacts, type OrderRow } from './store'
import type { OrderView } from './views'

/**
 * Close remaining lines and reopen them (B-W2a-30; SAL-210; the design's band overflow "Close remaining lines": "Lines
 * and sizes that will not be made or shipped", reversal "Reopen lines"). Each is ONE command on the order (orders.manage;
 * a reason): the lines' work-order locks, then the order's row (FOR UPDATE, at the version read), the facts read again;
 * then every chosen line's four short-close columns (factory-db SalesOrderLine closedShortQuantity = what is left of it
 * after what shipped, closedShortAt, closedShortById, closeShortReason; the …_sales_w2a_guards trigger takes that change
 * also while PARTLY_SHIPPED). B-W2b-16: the close may name a code of the CANCEL reason list (closedShortReasonCode, an
 * active code; its words still required), and the reopen clears it with the four columns.
 *
 *   close    the APPROVED REDUCE replacements of the lines' work-order cells become DONE (B-W2a-13: a reduction waits
 *            for the order line to be lowered); a PARTLY_SHIPPED order with nothing left becomes SHIPPED in the same
 *            command (its settlement then closes it as usual)
 *   reopen   the columns cleared; a SHIPPED order whose closed lines are reopened goes back to PARTLY_SHIPPED first (the
 *            line trigger takes the change only then). A REDUCE made DONE stays DONE (final)
 *
 * What work orders still make of a closed line is answered (`stillInWorkOrders`): Production decides about it. Shipping a
 * closed line is not refused by the database (named as a gap for the shipping step).
 */

const reasonOf = (value: string): string => value.trim()

function invalid(issues: Issue[]): ValidationError {
  return new ValidationError(issues.length === 1 ? issues[0]!.message : 'The lines cannot be closed like this.', issues)
}

const shortLinesOf = (facts: OrderFacts): ShortLine[] =>
  facts.lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, shipped: facts.progress.lines.find((entry) => entry.lineId === line.id)?.shipped ?? 0, closedShort: line.closedShortQuantity !== null }))

function statusChanged(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId'>, from: string, to: string): void {
  tools.emit({ type: 'sales_order.status_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from: from as never, to: to as never, by: 'person' } })
}

export interface LinesBody {
  readonly version?: number | undefined
  readonly reason: string
  /** The lines; none: every open line with something left (close), every closed line (reopen). */
  readonly lineIds?: readonly string[] | undefined
}

/** B-W2b-16: a close names why with a code of the CANCEL reason list too (the words stay beside it). */
export interface CloseLinesBody extends LinesBody {
  readonly reasonCode?: string | undefined
}

/** The close's code: an active code of the CANCEL list, its note when the code asks for detail (400 in words). */
async function checkReasonCode(tools: Pick<CommandTools, 'tx'>, code: string | undefined, reason: string): Promise<string | null> {
  if (code === undefined) return null
  const found = await reasonFor(tools.tx, 'CANCEL', code)
  if (!found || !found.active) throw invalid([{ path: 'body/reasonCode', message: 'Pick an active reason of the cancel list.' }])
  if (found.needsDetail && reason.trim().length < 3) throw invalid([{ path: 'body/reason', message: 'This reason asks for detail: say more in the words.' }])
  return found.code
}

/** orders.manage: close what is left of the lines named (or of every open line). */
export async function closeLines(caller: CommandCaller, orderId: string, body: CloseLinesBody, idempotencyKey?: string): Promise<{ order: OrderView; closed: { lineId: string; seq: number; closedShortQuantity: number }[]; reducesDone: string[]; stillInWorkOrders: { lineId: string; pieces: number }[] }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const reason = reasonOf(body.reason)
  if (reason === '' || reason.length > MAX_REASON) throw invalid([{ path: 'body/reason', message: 'Say why the lines are closed (it stays on each line).' }])
  const { result } = await command(caller, { name: 'orders.closeLines', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const lineIds = (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    await lockOrderLines(tx, context.tenantId, lineIds)
    const locked = await lockOrder(tx, order.id, body.version)
    const facts = await readOrderFacts(tx, order)
    const reasonCode = await checkReasonCode(tools, body.reasonCode, reason)
    const plan = closeShortPlan(locked.status, shortLinesOf(facts), [...(body.lineIds ?? [])])
    if (Array.isArray(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      throw invalid(plan)
    }
    for (const line of plan.close) {
      await tx.salesOrderLine.update({ where: { id: line.id }, data: { closedShortQuantity: line.closedShortQuantity, closedShortAt: now, closedShortById: context.actorId, closeShortReason: reason, closedShortReasonCode: reasonCode, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    // B-W2a-13: an APPROVED REDUCE of these lines' cells is done once the order line is lowered.
    const closedIds = plan.close.map((line) => line.id)
    const cells = await tx.workOrderSize.findMany({ where: { salesOrderLineId: { in: closedIds } }, select: { id: true } })
    const reduces = cells.length > 0 ? await tx.replacementRequest.findMany({ where: { workOrderSizeId: { in: cells.map((cell) => cell.id) }, kind: 'REDUCE', status: 'APPROVED' }, select: { id: true, companyId: true, workOrderId: true, quantity: true }, orderBy: { id: 'asc' } }) : []
    const reducesDone: string[] = []
    for (const reduce of reduces) {
      const { count } = await tx.replacementRequest.updateMany({ where: { id: reduce.id, status: 'APPROVED' }, data: { status: 'DONE', doneAt: now, updatedAt: now, version: { increment: 1 } } })
      if (count !== 1) continue
      reducesDone.push(reduce.id)
      tools.audit({ action: 'orders.reduceDone', recordType: 'ReplacementRequest', recordId: reduce.id, companyId: reduce.companyId, before: { status: 'APPROVED' }, after: { status: 'DONE', doneAt: toUtcIso(now), orderId: order.id, quantity: reduce.quantity } })
    }
    let status = locked.status
    if (plan.done && locked.status === 'PARTLY_SHIPPED') {
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'SHIPPED', updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: 'PARTLY_SHIPPED' }, after: { status: 'SHIPPED', closedLines: closedIds }, reason: `Remaining lines closed: ${reason}` })
      statusChanged(tools, order, 'PARTLY_SHIPPED', 'SHIPPED')
      status = 'SHIPPED'
    } else {
      await tx.salesOrder.update({ where: { id: order.id }, data: { updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    const inWork = new Map<string, number>()
    for (const row of facts.progress.lines) if (closedIds.includes(row.lineId)) inWork.set(row.lineId, Math.max(0, row.inWorkOrders - row.shipped))
    tools.audit({
      action: 'orders.closeLines',
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      before: { status: locked.status, lines: plan.close.map((line) => ({ lineId: line.id, closedShortQuantity: null })) },
      after: { status, lines: plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity })), reducesDone, reasonCode },
      reason,
    })
    tools.emit({ type: 'sales_order.lines_closed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'CLOSED', lineIds: closedIds } })
    return {
      closed: plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity })),
      reducesDone,
      stillInWorkOrders: [...inWork].filter(([, pieces]) => pieces > 0).map(([lineId, pieces]) => ({ lineId, pieces })),
    }
  })
  return { order: await recordAfter(caller, order.id), ...result }
}

/** orders.manage: reopen closed lines (the close's reversal). */
export async function reopenLines(caller: CommandCaller, orderId: string, body: LinesBody, idempotencyKey?: string): Promise<{ order: OrderView; reopened: string[] }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const reason = reasonOf(body.reason)
  if (reason === '' || reason.length > MAX_REASON) throw invalid([{ path: 'body/reason', message: 'Say why the lines are reopened (it stays in the order history).' }])
  const { result } = await command(caller, { name: 'orders.reopenLines', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const lineIds = (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    await lockOrderLines(tx, context.tenantId, lineIds)
    const locked = await lockOrder(tx, order.id, body.version)
    const facts = await readOrderFacts(tx, order)
    const plan = reopenPlan(locked.status, shortLinesOf(facts), [...(body.lineIds ?? [])])
    if (Array.isArray(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      throw invalid(plan)
    }
    let status = locked.status
    if (locked.status === 'SHIPPED') {
      // The line trigger takes a short-close change only while PARTLY_SHIPPED: the order goes back first.
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'PARTLY_SHIPPED', updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: 'SHIPPED' }, after: { status: 'PARTLY_SHIPPED', reopenedLines: plan.reopen }, reason: `Closed lines reopened: ${reason}` })
      statusChanged(tools, order, 'SHIPPED', 'PARTLY_SHIPPED')
      status = 'PARTLY_SHIPPED'
    } else {
      await tx.salesOrder.update({ where: { id: order.id }, data: { updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    const before = facts.lines.filter((line) => plan.reopen.includes(line.id)).map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity, closeShortReason: line.closeShortReason, closedShortReasonCode: line.closedShortReasonCode }))
    for (const lineId of plan.reopen) {
      // B-W2b-16: the code goes with the close (the database refuses a code on a line that is not closed short).
      await tx.salesOrderLine.update({ where: { id: lineId }, data: { closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    tools.audit({ action: 'orders.reopenLines', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: locked.status, lines: before }, after: { status, lines: plan.reopen.map((lineId) => ({ lineId, closedShortQuantity: null })) }, reason })
    tools.emit({ type: 'sales_order.lines_closed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'REOPENED', lineIds: [...plan.reopen] } })
    return { reopened: [...plan.reopen] }
  })
  return { order: await recordAfter(caller, order.id), ...result }
}

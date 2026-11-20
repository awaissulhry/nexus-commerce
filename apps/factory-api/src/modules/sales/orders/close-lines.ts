import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { closeShortPlan, reopenPlan, type ShortLine } from '@nexus/factory-domain/sales/orders/daily'
import { MAX_REASON } from '@nexus/factory-domain/sales/orders/orders'
import { reasonOr } from '@nexus/factory-domain/sales/amendments/reasons' // B-OL-004
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { reasonFor } from '../../../platform/reasons/service'
import { lockOrderLines } from '../../production/work-orders/store'
import { officeContextOf } from './access'
import { officeOrder, recordAfter } from './moves'
import { lockOrder, readOrderFacts, type OrderFacts, type OrderRow } from './store'
import type { OrderView } from './views'
// B-SA-042: a close proposes the gap to the work orders.
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
import { proposeGapsInCommand, storedGapLines } from '../../production/work-order-changes/propose'
// B-OP-012 (order page plan N2, D1): the work orders follow the close in its command where the person may.
import { withAutoApply, type AutoApply, type FollowedWorkOrders } from '../../production/work-order-changes/auto'
// B-OP-013: the close's preview says what each work order will do, read as the command reads it.
import { plannedChangesOf, workOrderPreviewOf } from './work-order-plan'

/**
 * Close remaining lines and reopen them (B-W2a-30; SAL-210; the design's band overflow "Close remaining lines": "Lines
 * and sizes that will not be made or shipped", reversal "Reopen lines"). Each is ONE command on the order (orders.manage;
 * a reason, B-OL-004: else the automatic words): the lines' work-order locks, then the order's row (FOR UPDATE, at the version read), the facts read again;
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

const reasonOf = (value: string | undefined): string => (value ?? '').trim()

function invalid(issues: Issue[]): ValidationError {
  return new ValidationError(issues.length === 1 ? issues[0]!.message : 'The lines cannot be closed like this.', issues)
}

/** The lines as the close's plan reads them (B-W2b-183's change requests preview a cancel of lines with it). */
export const shortLinesOf = (facts: OrderFacts): ShortLine[] =>
  facts.lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, shipped: facts.progress.lines.find((entry) => entry.lineId === line.id)?.shipped ?? 0, closedShort: line.closedShortQuantity !== null }))

// B-SA-001: the payloads name the order's customer, the order row's own (read on the server), never a caller's value.
function statusChanged(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId'>, from: string, to: string): void {
  tools.emit({ type: 'sales_order.status_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from: from as never, to: to as never, by: 'person', partyId: order.partyId } })
}

export interface LinesBody {
  readonly version?: number | undefined
  /** B-OL-004 (order lines plan D2): optional — none stores the automatic words (amendments/reasons AUTOMATIC_REASONS). */
  readonly reason?: string | undefined
  /** The lines; none: every open line with something left (close), every closed line (reopen). */
  readonly lineIds?: readonly string[] | undefined
}

/** B-W2b-16: a close names why with a code of the CANCEL reason list too (the words stay beside it). */
export interface CloseLinesBody extends LinesBody {
  readonly reasonCode?: string | undefined
  /** B-SA-042 (R1): what happens to pieces already cut beyond what the closed lines still want (none: left to production). */
  readonly extraOutcome?: ExtraOutcome | null | undefined
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
export async function closeLines(caller: CommandCaller, orderId: string, body: CloseLinesBody, idempotencyKey?: string): Promise<{ order: OrderView; closed: { lineId: string; seq: number; closedShortQuantity: number }[]; reducesDone: string[]; stillInWorkOrders: { lineId: string; pieces: number }[]; /* B-OP-012 */ workOrders: FollowedWorkOrders }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  // B-OL-004 (order lines plan D2): words are optional (none: the automatic words); typed, they fit the column.
  if (reasonOf(body.reason).length > MAX_REASON) throw invalid([{ path: 'body/reason', message: `At most ${MAX_REASON} characters.` }])
  const { result } = await withAutoApply((autoApply) => command(caller, { name: 'orders.closeLines', idempotencyKey, input: { orderId, ...body } }, (tools) => closeLinesInCommand(tools, context, order, body, { autoApply })))
  return { order: await recordAfter(caller, order.id), ...result }
}

/**
 * The close's work inside a command that is already open: closeLines' own command, and B-W2b-183's accepted cancel of some
 * lines (modules/sales/change-requests) in the same command that answers the request. The caller checked orders.manage
 * over `order` and the reason's words.
 */
export async function closeLinesInCommand(
  tools: CommandTools,
  context: { readonly tenantId: string; readonly actorId: string },
  order: OrderRow,
  body: CloseLinesBody,
  /** B-SA-042: `later` — the caller proposes the gap to the work orders once at its end (Accept of a customer's cancel). B-OP-012: `autoApply`. */
  options: { readonly workOrders?: 'now' | 'later'; readonly autoApply?: AutoApply } = {},
): Promise<{ closed: { lineId: string; seq: number; closedShortQuantity: number }[]; reducesDone: string[]; stillInWorkOrders: { lineId: string; pieces: number }[]; /* B-OP-012 */ workOrders: FollowedWorkOrders }> {
  const { tx, now } = tools
  // B-OL-004: a code that asks for detail still wants the typed words (checkReasonCode); stored: the words, else the automatic ones.
  const typed = reasonOf(body.reason)
  const reason = reasonOr('close', typed)
  const lineIds = (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
  await lockOrderLines(tx, context.tenantId, lineIds)
  const locked = await lockOrder(tx, order.id, body.version)
  const facts = await readOrderFacts(tx, order)
  const reasonCode = await checkReasonCode(tools, body.reasonCode, typed)
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
  const reducesDone = await reducesDoneInCommand(tools, order, closedIds)
  let status = locked.status
  if (plan.done && locked.status === 'PARTLY_SHIPPED') {
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'SHIPPED', updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: 'PARTLY_SHIPPED' }, after: { status: 'SHIPPED', closedLines: closedIds }, reason: `Remaining lines closed: ${reason}` })
    statusChanged(tools, order, 'PARTLY_SHIPPED', 'SHIPPED')
    status = 'SHIPPED'
  } else {
    await tx.salesOrder.update({ where: { id: order.id }, data: { updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  }
  tools.audit({
    action: 'orders.closeLines',
    recordType: 'SalesOrder',
    recordId: order.id,
    companyId: order.companyId,
    before: { status: locked.status, lines: plan.close.map((line) => ({ lineId: line.id, closedShortQuantity: null })) },
    after: { status, lines: plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity })), reducesDone, reasonCode },
    reason,
  })
  tools.emit({ type: 'sales_order.lines_closed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'CLOSED', lineIds: closedIds, partyId: order.partyId /* B-SA-001 */ } })
  // B-SA-042 (P6', R1): what work orders still make of the closed lines is proposed to them (lowered to what shipped, never below
  // cut); the pieces cut beyond get the outcome named, else stay production's to decide (stillInWorkOrders, as before).
  // B-OP-012: and carried out where the person may.
  const gap = options.workOrders !== 'later' ? await proposeGapsInCommand(tools, { order: { ...order, status }, requestId: null, amendmentId: null, reason, extraOutcome: body.extraOutcome ?? null, requireOutcome: false, lineIds: closedIds }, options.autoApply) : null
  return {
    closed: plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity })),
    reducesDone,
    stillInWorkOrders: stillInWorkOrdersOf(facts, closedIds),
    workOrders: { applied: gap?.applied ?? [], waiting: gap?.waiting ?? [] },
  }
}

/**
 * B-W2a-13: the APPROVED REDUCE replacements of the closed lines' cells, DONE once the order line is lowered (a close of lines; B-OP-014:
 * an amendment that closes a line it leaves out), each audited. Returns their ids.
 */
export async function reducesDoneInCommand(tools: CommandTools, order: Pick<OrderRow, 'id'>, closedIds: readonly string[]): Promise<string[]> {
  const { tx, now } = tools
  if (closedIds.length === 0) return []
  const cells = await tx.workOrderSize.findMany({ where: { salesOrderLineId: { in: [...closedIds] } }, select: { id: true } })
  const reduces = cells.length > 0 ? await tx.replacementRequest.findMany({ where: { workOrderSizeId: { in: cells.map((cell) => cell.id) }, kind: 'REDUCE', status: 'APPROVED' }, select: { id: true, companyId: true, workOrderId: true, quantity: true }, orderBy: { id: 'asc' } }) : []
  const done: string[] = []
  for (const reduce of reduces) {
    const { count } = await tx.replacementRequest.updateMany({ where: { id: reduce.id, status: 'APPROVED' }, data: { status: 'DONE', doneAt: now, updatedAt: now, version: { increment: 1 } } })
    if (count !== 1) continue
    done.push(reduce.id)
    tools.audit({ action: 'orders.reduceDone', recordType: 'ReplacementRequest', recordId: reduce.id, companyId: reduce.companyId, before: { status: 'APPROVED' }, after: { status: 'DONE', doneAt: toUtcIso(now), orderId: order.id, quantity: reduce.quantity } })
  }
  return done
}

/** What work orders still make of the closed lines (beyond what shipped of them): Production decides about it. */
function stillInWorkOrdersOf(facts: OrderFacts, closedIds: readonly string[]): { lineId: string; pieces: number }[] {
  const inWork = new Map<string, number>()
  for (const row of facts.progress.lines) if (closedIds.includes(row.lineId)) inWork.set(row.lineId, Math.max(0, row.inWorkOrders - row.shipped))
  return [...inWork].filter(([, pieces]) => pieces > 0).map(([lineId, pieces]) => ({ lineId, pieces }))
}

// ── B-OP-013 (order page plan N2, D1; 13-backend §1.3; B2): the close's preview ──
export interface CloseLinesPreviewBody {
  /** The lines; none: every open line with something left. */
  readonly lineIds?: readonly string[] | undefined
  /** The extra pieces' outcome the office would name (none: they stay production's to decide). */
  readonly extraOutcome?: ExtraOutcome | null | undefined
}

/**
 * orders.manage: POST /sales/orders/:orderId/close-lines/preview — what closing the lines would do, nothing written: the lines and
 * what is left of each (closeShortPlan, as the close reads it), what work orders still make of them, and the work orders' part —
 * the pieces already cut beyond what the lines still want (the close takes their outcome; none: production decides) and what each
 * work order will do, in the same click or waiting with why (the close's own command reads the same, ./work-order-plan.ts).
 * Problems come back as `problems` with `ok` false; a state that takes no close is a 409 (as the close).
 */
export async function previewCloseLines(caller: CommandCaller, orderId: string, body: CloseLinesPreviewBody) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  return caller.withClient(async (client) => {
    const facts = await readOrderFacts(client, order)
    const plan = closeShortPlan(order.status, shortLinesOf(facts), [...(body.lineIds ?? [])])
    if (Array.isArray(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      return { ok: false, version: order.version, problems: plan, closed: [], stillInWorkOrders: [], workOrders: null }
    }
    const closedIds = plan.close.map((line) => line.id)
    const planned = await plannedChangesOf(client, context.tenantId, order, await storedGapLines(client, order, closedIds, new Set(closedIds)))
    return {
      ok: true,
      version: order.version,
      problems: [] as Issue[],
      closed: plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity })),
      stillInWorkOrders: stillInWorkOrdersOf(facts, closedIds),
      workOrders: await workOrderPreviewOf(client, context, order, planned, { requireOutcome: false, outcomeChosen: Boolean(body.extraOutcome) }),
    }
  })
}
// ── end B-OP-013 ──

/** orders.manage: reopen closed lines (the close's reversal). */
export async function reopenLines(caller: CommandCaller, orderId: string, body: LinesBody, idempotencyKey?: string): Promise<{ order: OrderView; reopened: string[] }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  // B-OL-004 (order lines plan D2): words are optional (none: the automatic words); typed, they fit the column.
  if (reasonOf(body.reason).length > MAX_REASON) throw invalid([{ path: 'body/reason', message: `At most ${MAX_REASON} characters.` }])
  const reason = reasonOr('reopen', body.reason)
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
    tools.emit({ type: 'sales_order.lines_closed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'REOPENED', lineIds: [...plan.reopen], partyId: order.partyId /* B-SA-001 */ } })
    return { reopened: [...plan.reopen] }
  })
  return { order: await recordAfter(caller, order.id), ...result }
}

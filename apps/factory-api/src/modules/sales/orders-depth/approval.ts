import type { Prisma } from '@nexus/factory-db'
import { chooseRules } from '@nexus/factory-domain/approvals/rules'
import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ORDER_STEPS, type CreditStep } from '@nexus/factory-domain/sales/credit/credit'
import { SALES_ORDER_CHANGES, SALES_ORDER_FIELDS, salesOrderFacts, WAIT_WORDS, type OrderShape, type SalesOrderPriorityLevel, type WaitReason } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
import type { TaskRef } from '../../../platform/approvals/kinds/kind'
import { newestCheck } from '../credit/check'
import { officeContextOf } from '../orders/access'
import { cancelOrderInCommand } from '../orders/moves'
import { officeOrder } from '../orders/moves'
import { readOrder, type Reader } from '../orders/store'
// B-W2b-358 (SAL-292): a made-to-measure unit's measures are confirmed before the order goes on.
import { waitsForMeasures } from '../mtm/order-gate'

/**
 * Orders waiting for a yes (B-W2b-303; SAL-205 "pending approval status"; plan "An order that breaks a SALES_ORDER rule waits
 * as PENDING_APPROVAL and goes on with the yes"). The SALES_ORDER kind is platform/approvals/kinds/sales-order.ts; this file
 * is what the order does with it.
 *
 *   planOrderApproval(tools, …)   BEFORE the order row (nothing moves INTO PENDING_APPROVAL later: B-W2b-281's guard): the
 *                                 company's SALES_ORDER rules switched on and in force, tested on the order's facts as they
 *                                 will be written (factory-domain salesOrderFacts, the same function the request's re-read
 *                                 uses) — a rule that holds makes the order wait. No rule on: the order goes on as today.
 *   askOrderApproval(tools, …)    AFTER the order row, in the same command: the request (platform/approvals askApproval),
 *                                 asked by the person making the order — at an acceptance (the system's command) by the
 *                                 person who sent the quote. Nobody to ask (every rule that holds names that person, or
 *                                 no person): the order waits without a request; another office person asks for it.
 *   approvedInCommand             the yes (in the approver's command): CONFIRMED and W1's sales_order.status_changed
 *                                 {PENDING_APPROVAL → CONFIRMED} (B-W2b-294's handler carries the delivery schedule then),
 *                                 unless the order's credit HOLD still stands (B-W2b-304): it keeps waiting for that.
 *   rejectedInCommand             the no: CANCELLED with the approver's reason (W1's cancel: deposit requests and payment
 *                                 steps cancelled with it); the credit override asked on it is withdrawn.
 *   approvalState / askAgain / withdraw
 *                                 GET /sales/orders/:orderId/approval (why it waits and who decides), POST …/approval (ask
 *                                 again after a no-longer-standing request), POST …/approval/withdraw (the asker takes it
 *                                 back: the order keeps waiting, or is cancelled by W1's route).
 */

const RULE_COLUMNS = { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true } as const

const officeActor = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export interface OrderApprovalPlan {
  /** A SALES_ORDER rule holds: the order is made PENDING_APPROVAL. */
  readonly waits: boolean
  /** Someone other than the asker may decide (a request can be asked now). */
  readonly askable: boolean
  readonly requesterId: string | null
}

/** The SALES_ORDER rules on the order as it will be made (see the file's head). `requesterId`: who asks (default: the person acting). */
export async function planOrderApproval(tools: CommandTools, input: { readonly companyId: string; readonly shape: OrderShape; readonly requesterId?: string | null }): Promise<OrderApprovalPlan> {
  const requesterId = input.requesterId !== undefined ? input.requesterId : officeActor(tools)
  const rules = await tools.tx.approvalRule.findMany({ where: { kind: 'SALES_ORDER', active: true, OR: [{ companyId: null }, { companyId: input.companyId }] }, select: RULE_COLUMNS })
  if (rules.length === 0) return { waits: false, askable: false, requesterId }
  const askers = [...new Set([requesterId, officeActor(tools)].filter((id): id is string => id !== null))]
  const choice = chooseRules(rules, { companyId: input.companyId, facts: salesOrderFacts(input.shape), askers }, SALES_ORDER_FIELDS, tools.now)
  return { waits: choice.matched.length > 0, askable: choice.deciding !== null && requesterId !== null, requesterId }
}

/** The request after the order row (see the file's head): the task's id, or null when nobody could ask. */
export async function askOrderApproval(tools: CommandTools, orderId: string, plan: OrderApprovalPlan | null): Promise<string | null> {
  if (!plan?.waits || !plan.askable || plan.requesterId === null) return null
  const outcome = await askApproval(tools, { kind: 'SALES_ORDER', recordId: orderId, requester: { userId: plan.requesterId }, changes: SALES_ORDER_CHANGES })
  return outcome.asked ? outcome.taskId : null
}

/** The order's shape from its rows (the request's re-read, the record's read): the same facts the plan saw. */
export async function orderShapeOf(db: Reader, order: { readonly id: string; readonly partyId: string; readonly currency: string; readonly netAmount: number; readonly priorityLevel: string; readonly quoteVersionId: string | null }): Promise<OrderShape> {
  const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { kind: true, quantity: true, unitPrice: true, priceSteps: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true } })
  return {
    currency: order.currency,
    netAmount: order.netAmount,
    customerCode: party?.code ?? null,
    priorityLevel: order.priorityLevel as SalesOrderPriorityLevel,
    fromQuote: order.quoteVersionId !== null,
    lines: lines.map((line) => ({ kind: line.kind, quantity: line.quantity, unitPrice: line.unitPrice.toString(), priceSteps: line.priceSteps as unknown })),
  }
}

/** The order's credit HOLD that still stands (its newest ORDER / PORTAL / API check, no override row), or null. */
export async function creditHoldOf(db: Reader, orderId: string): Promise<{ checkId: string; pendingTaskId: string | null } | null> {
  const step = (await db.creditCheck.findFirst({ where: { recordType: 'SalesOrder', recordId: orderId, step: { in: [...ORDER_STEPS] } }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], select: { step: true } }))?.step
  if (!step) return null
  const last = await newestCheck(db, { step: step as CreditStep, recordType: 'SalesOrder', recordId: orderId })
  return last?.held ? { checkId: last.id, pendingTaskId: last.pendingTaskId } : null
}

const lockRow = (tx: CommandTx, orderId: string) => tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = ${orderId}::uuid FOR UPDATE`

/** SALES_ORDER's yes (platform/approvals/kinds/sales-order.ts onApproved), in the approver's command. */
export async function approvedInCommand(tools: CommandTools, task: TaskRef): Promise<void> {
  const { tx, now } = tools
  await lockRow(tx, task.recordId)
  const order = await tx.salesOrder.findUnique({ where: { id: task.recordId }, select: { id: true, number: true, status: true, companyId: true } })
  if (!order || order.status !== 'PENDING_APPROVAL') throw new InvalidStateError('The order this yes is about does not wait any more: nothing to let go on.')
  const hold = await creditHoldOf(tx, order.id)
  if (hold) {
    tools.audit({ action: 'orders.approvalYes', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { taskId: task.id, status: 'PENDING_APPROVAL', stillWaitsFor: 'CREDIT', creditCheckId: hold.checkId } })
    return
  }
  // B-W2b-358: the yes is kept; the order waits for the factory review of a made-to-measure unit (the CONFIRM lets it go on).
  if (await waitsForMeasures(tx, order.id)) {
    tools.audit({ action: 'orders.approvalYes', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { taskId: task.id, status: 'PENDING_APPROVAL', stillWaitsFor: 'MEASUREMENTS' } })
    return
  }
  await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CONFIRMED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'orders.approvalYes', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: 'PENDING_APPROVAL' }, after: { status: 'CONFIRMED', taskId: task.id, decidedById: task.decidedById } })
  // B-W2b-294: the schedule of an order that waited follows this event (worker handler sales.orderSchedule).
  tools.emit({ type: 'sales_order.status_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' } })
}

/** SALES_ORDER's no (onRejected), in the approver's command: the waiting order is cancelled with the reason. */
export async function rejectedInCommand(tools: CommandTools, task: TaskRef): Promise<void> {
  const row = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { rejectReason: true } })
  const order = await readOrder(tools.tx, task.recordId)
  if (!order || order.status !== 'PENDING_APPROVAL') return
  const reason = `Turned down (sales order request): ${row?.rejectReason?.trim() || 'no reason given'}`.slice(0, 500)
  const hold = await creditHoldOf(tools.tx, order.id)
  if (hold?.pendingTaskId) await withdrawPending(tools, { kind: 'CREDIT_OVERRIDE', recordId: hold.checkId, byId: officeActor(tools), words: 'The order was turned down.' })
  await cancelOrderInCommand(tools, tenantOf(tools), order, { reason })
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => (tools.context as { tenantId: string }).tenantId

// ---- the routes ---------------------------------------------------------------------------------------------------------

async function waitOf(db: Reader, orderId: string) {
  const tasks = await db.approvalTask.findMany({
    where: { kind: 'SALES_ORDER', recordType: 'SalesOrder', recordId: orderId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: 10,
    select: { id: true, status: true, requestedAt: true, requestedById: true, approverRoleId: true, approverUserId: true, dueAt: true, decidedAt: true, decidedById: true, rejectReason: true, version: true },
  })
  const pending = tasks.find((task) => task.status === 'PENDING') ?? null
  const hold = await creditHoldOf(db, orderId)
  const reasons: WaitReason[] = [...(pending ? (['REQUEST_PENDING'] as const) : []), ...(hold ? (['CREDIT_HOLD'] as const) : [])]
  return { tasks, pending, hold, reasons }
}

async function namesOf(db: Reader, userIds: readonly (string | null)[], roleIds: readonly (string | null)[]) {
  const users = [...new Set(userIds.filter((id): id is string => id !== null))]
  const roles = [...new Set(roleIds.filter((id): id is string => id !== null))]
  return {
    users: new Map((users.length > 0 ? await db.user.findMany({ where: { id: { in: users } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName])),
    roles: new Map((roles.length > 0 ? await db.role.findMany({ where: { id: { in: roles } }, select: { id: true, name: true } }) : []).map((row) => [row.id, row.name])),
  }
}

/** GET /sales/orders/:orderId/approval (orders.view): why the order waits, its requests, who decides, what the caller may do. */
export async function approvalState(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (db) => {
    const { tasks, pending, hold, reasons } = await waitOf(db, order.id)
    const waiting = order.status === 'PENDING_APPROVAL'
    const all = waiting && reasons.length === 0 ? (['NO_REQUEST'] as WaitReason[]) : reasons
    const names = await namesOf(db, tasks.flatMap((task) => [task.requestedById, task.approverUserId, task.decidedById]), tasks.map((task) => task.approverRoleId))
    return {
      orderId: order.id,
      number: order.number,
      status: order.status,
      waiting,
      reasons: waiting ? all.map((reason) => ({ reason, words: WAIT_WORDS[reason] })) : [],
      creditHold: hold ? { checkId: hold.checkId, requestTaskId: hold.pendingTaskId } : null,
      requests: tasks.map((task) => ({
        id: task.id,
        status: task.status,
        requestedAt: toUtcIso(task.requestedAt),
        requestedBy: task.requestedById ? (names.users.get(task.requestedById) ?? null) : null,
        approver: task.approverUserId ? (names.users.get(task.approverUserId) ?? null) : task.approverRoleId ? (names.roles.get(task.approverRoleId) ?? null) : null,
        dueAt: task.dueAt ? toUtcIso(task.dueAt) : null,
        decidedAt: task.decidedAt ? toUtcIso(task.decidedAt) : null,
        decidedBy: task.decidedById ? (names.users.get(task.decidedById) ?? null) : null,
        reason: task.rejectReason,
        mine: task.requestedById === context.actorId,
      })),
      may: {
        ask: waiting && pending === null && !hold,
        withdraw: pending !== null && pending.requestedById === context.actorId,
      },
    }
  })
}

const noteOf = (note: string | null | undefined): string | null => {
  const words = note?.trim() ? note.trim() : null
  if (words && words.length > 4000) throw new ValidationError('At most 4000 characters.', [{ path: 'body/note', message: 'At most 4000 characters.' }])
  return words
}

/** POST /sales/orders/:orderId/approval (orders.manage): a yes asked for a waiting order that has no request standing. */
export async function askAgain(caller: CommandCaller, orderId: string, body: { readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const note = noteOf(body.note)
  const { result } = await command(caller, { name: 'orders.askApproval', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    await lockRow(tools.tx, order.id)
    const fresh = await tools.tx.salesOrder.findUnique({ where: { id: order.id }, select: { status: true, companyId: true, partyId: true, currency: true, netAmount: true, priorityLevel: true, quoteVersionId: true } })
    if (!fresh || fresh.status !== 'PENDING_APPROVAL') throw new InvalidStateError(`${order.number} does not wait for a yes.`)
    const { pending } = await waitOf(tools.tx, order.id)
    if (pending) throw new DomainError('conflict', 'A yes is asked on this order already.', [{ path: 'approval', message: 'Asked already.' }])
    const plan = await planOrderApproval(tools, { companyId: fresh.companyId, shape: await orderShapeOf(tools.tx, { id: order.id, ...fresh }), requesterId: context.actorId })
    if (!plan.waits) throw new DomainError('conflict', 'No sales order rule asks a yes for this order any more: ask the Owner to check the rules, or cancel the order.', [{ path: 'approval', message: 'No rule holds.' }])
    if (!plan.askable) throw new DomainError('conflict', 'The rule names you to approve this order, and nobody approves their own request: another office person asks for the yes.', [{ path: 'approval', message: 'Nobody else to decide.' }])
    const outcome = await askApproval(tools, { kind: 'SALES_ORDER', recordId: order.id, requester: { userId: context.actorId }, note, changes: SALES_ORDER_CHANGES })
    if (!outcome.asked) throw new DomainError('conflict', 'No sales order rule asks a yes for this order any more.', [{ path: 'approval', message: 'No rule holds.' }])
    tools.audit({ action: 'orders.askApproval', recordType: 'SalesOrder', recordId: order.id, companyId: fresh.companyId, after: { taskId: outcome.taskId } })
    return { taskId: outcome.taskId }
  })
  return result
}

/** POST /sales/orders/:orderId/approval/withdraw (orders.manage): the person who asked takes the request back. */
export async function withdrawApproval(caller: CommandCaller, orderId: string, body: { readonly words?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const words = body.words?.trim() ? body.words.trim().slice(0, 2000) : null
  const { result } = await command(caller, { name: 'orders.withdrawApproval', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { pending } = await waitOf(tools.tx, order.id)
    if (!pending) throw new NotFoundError('No request for a yes waits on this order.')
    if (pending.requestedById !== context.actorId) throw new DomainError('forbidden', 'Only the person who asked for this request takes it back.', [{ path: 'approval', message: 'Not your request.' }])
    const count = await withdrawPending(tools, { kind: 'SALES_ORDER', recordId: order.id, byId: context.actorId, words })
    tools.audit({ action: 'orders.withdrawApproval', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { taskId: pending.id, withdrawn: count } })
    return { withdrawn: count }
  })
  return result
}

/** The SALES_ORDER kind's subject columns (the request's re-read). */
export const SUBJECT_COLUMNS = {
  id: true,
  number: true,
  status: true,
  companyId: true,
  partyId: true,
  currency: true,
  netAmount: true,
  grossAmount: true,
  priorityLevel: true,
  urgentReason: true,
  quoteVersionId: true,
  customerRef: true,
  promiseDate: true,
  shipTo: true,
  seasonId: true,
} as const satisfies Prisma.SalesOrderSelect

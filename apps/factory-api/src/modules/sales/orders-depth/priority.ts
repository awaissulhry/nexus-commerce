import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { ORDERS_DEPTH_LIMITS, priorityOf, type SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMay, mayOn, officeContextOf } from '../orders/access'
import { officeOrder } from '../orders/moves'
import { lockOrder } from '../orders/store'

/**
 * Priority and the urgent flag (B-W2b-303; SAL-207 "rush flags for daily priorities"; design sales.orders "Priority (W2b)"
 * column, "Set priority (W2b)" on a selection, "Inline edit: priority and site only"). orders.manage over the order's company
 * and customer; an order that is not CLOSED or CANCELLED. The board and the backlog read SalesOrder.priorityLevel (B-W2b-317's
 * rank: the level first, then W1's number within it); the partner never reads either.
 *
 *   PUT  /sales/orders/:orderId/priority   {version, priorityLevel, urgentReason? (with URGENT only), priority? (W1's number)}
 *   POST /sales/orders/priority            {orderIds (1-200), priorityLevel, urgentReason?}: one command for the selection; an
 *                                          order the caller may not change, or a closed one, is named in `skipped` with why
 */

const CLOSED = new Set(['CLOSED', 'CANCELLED'])

export interface PriorityBody {
  readonly version: number
  readonly priorityLevel: SalesOrderPriorityLevel
  readonly urgentReason?: string | null | undefined
  readonly priority?: number | undefined
}

const invalid = (issues: Issue[]) => new ValidationError(issues[0]!.message, issues)

async function setInCommand(tools: CommandTools, order: { id: string; number: string; companyId: string }, wanted: { priorityLevel: SalesOrderPriorityLevel; urgentReason: string | null; priority?: number | undefined }): Promise<boolean> {
  const before = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { priorityLevel: true, urgentReason: true, priority: true } })
  const priority = wanted.priority ?? before.priority
  if (before.priorityLevel === wanted.priorityLevel && before.urgentReason === wanted.urgentReason && before.priority === priority) return false
  await tools.tx.salesOrder.update({ where: { id: order.id }, data: { priorityLevel: wanted.priorityLevel, urgentReason: wanted.urgentReason, priority, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'orders.priority', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { ...before }, after: { priorityLevel: wanted.priorityLevel, urgentReason: wanted.urgentReason, priority } })
  tools.emit({ type: 'sales_order.priority_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from: before.priorityLevel as SalesOrderPriorityLevel, to: wanted.priorityLevel, priority, urgent: wanted.priorityLevel === 'URGENT' } })
  return true
}

/** PUT /sales/orders/:orderId/priority */
export async function setPriority(caller: CommandCaller, orderId: string, body: PriorityBody, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const wanted = priorityOf(body)
  if (Array.isArray(wanted)) throw invalid(wanted)
  if (body.priority !== undefined && (!Number.isSafeInteger(body.priority) || body.priority < ORDERS_DEPTH_LIMITS.priorityMin || body.priority > ORDERS_DEPTH_LIMITS.priorityMax)) {
    throw invalid([{ path: 'body/priority', message: `A whole number from ${ORDERS_DEPTH_LIMITS.priorityMin} to ${ORDERS_DEPTH_LIMITS.priorityMax} (higher first within the level).` }])
  }
  const { result } = await command(caller, { name: 'orders.priority', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const locked = await lockOrder(tools.tx, order.id, body.version)
    if (CLOSED.has(locked.status)) throw new InvalidStateError(`${order.number} is ${locked.status}: its priority stays as it was.`)
    const changed = await setInCommand(tools, order, { ...wanted, priority: body.priority })
    if (!changed) tools.audit({ action: 'orders.priority', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { unchanged: true } })
    const row = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { priorityLevel: true, urgentReason: true, priority: true, version: true } })
    return { orderId: order.id, number: order.number, changed, ...row }
  })
  return { priority: result }
}

/** POST /sales/orders/priority: "Set priority" on a selection (see the file's head). */
export async function setPriorities(caller: CommandCaller, body: { readonly orderIds: readonly string[]; readonly priorityLevel: SalesOrderPriorityLevel; readonly urgentReason?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const ids = [...new Set(body.orderIds)]
  if (ids.length === 0 || ids.length > ORDERS_DEPTH_LIMITS.bulkPriority) throw invalid([{ path: 'body/orderIds', message: `Choose 1 to ${ORDERS_DEPTH_LIMITS.bulkPriority} orders.` }])
  if (ids.some((id) => !isUuid(id))) throw invalid([{ path: 'body/orderIds', message: 'Order ids only.' }])
  const wanted = priorityOf(body)
  if (Array.isArray(wanted)) throw invalid(wanted)
  const rows = await caller.withClient((db) => db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, companyId: true, partyId: true, status: true }, orderBy: [{ number: 'asc' }, { id: 'asc' }] }))
  const visible = rows.filter((row) => mayOn(context, ORDERS_MANAGE, row) || mayOn(context, 'orders.view', row))
  if (visible.length === 0) assertMay(context, ORDERS_MANAGE, null)
  const { result } = await command(caller, { name: 'orders.prioritySelection', idempotencyKey, input: body }, async (tools) => {
    const changed: string[] = []
    const unchanged: string[] = []
    const skipped: { orderId: string; number: string; why: string }[] = []
    for (const row of visible) {
      if (!mayOn(context, ORDERS_MANAGE, row)) {
        skipped.push({ orderId: row.id, number: row.number, why: 'You may not change this order.' })
        continue
      }
      const locked = await lockOrder(tools.tx, row.id)
      if (CLOSED.has(locked.status)) {
        skipped.push({ orderId: row.id, number: row.number, why: `${row.number} is ${locked.status}.` })
        continue
      }
      if (await setInCommand(tools, row, wanted)) changed.push(row.id)
      else unchanged.push(row.id)
    }
    // Ids the caller cannot see are not named (they may not know the orders exist).
    if (changed.length === 0) tools.audit({ action: 'orders.prioritySelection', recordType: 'SalesOrder', recordId: visible[0]!.id, companyId: visible[0]!.companyId, after: { changed: 0, unchanged: unchanged.length, skipped: skipped.length } })
    return { priorityLevel: wanted.priorityLevel, changed, unchanged, skipped, unknown: ids.length - visible.length }
  })
  return result
}

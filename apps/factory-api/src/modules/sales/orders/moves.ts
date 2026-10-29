import { DomainError, ForbiddenError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { followMoves, promiseProblems, promiseStateProblem, salesOrderMachine, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_CLOSE, ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { lockOrderLines } from '../../production/work-orders/store'
import { assertMay, mayOn, officeContextOf } from './access'
import { orderSettlement } from './settlement'
import { asDay, dayOrNull, lockOrder, moveFactsOf, readLines, readOrder, readOrderFacts, type OrderRow } from './store'
import { orderView, type OrderView } from './views'

/**
 * The sales order's moves (B-W1-25; SAL-204: one writer per move; factory-domain sales/orders salesOrderMachine), each
 * ONE command on the order: its row locked first (store `lockOrder`, FOR UPDATE, at the version the caller read), the
 * machine's check on the facts read under that lock, then the status with its time in one row update (the
 * …_sales_guards trigger refuses a CLOSED or CANCELLED one without closedAt, a CANCELLED one without its reason), an
 * audit row per move and `sales_order.status_changed`.
 *
 *   a person (office)   promise date (orders.manage; a reason; the first promise stays), ready by hand (orders.manage; a
 *                       reason, while quality release is not in use), cancel (orders.manage; a reason; CONFIRMED with no
 *                       released or draft work order: the lines' work-order locks are taken first, so no work order is
 *                       made for them meanwhile; its OPEN deposit requests are cancelled with it), close (settled:
 *                       orders.manage or orders.close; not settled: a reason AND orders.close)
 *   the system          `followOrder`: the moves the facts ask (production started, quality released everything, the
 *                       shipped quantities, a settled order that left in full closes), from the worker's handlers
 */

const today = (tools: Pick<CommandTools, 'now'>): BusinessDate => businessDate(tools.now)

/** The order the office may see (else 404) and act on with `permission` (else 403). */
export async function officeOrder(caller: CommandCaller, orderId: string, permission: Permission = ORDERS_VIEW): Promise<OrderRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readOrder(client, orderId))
  assertMay(context, permission, row)
  return row!
}

/**
 * The record as it is after a write (every write route answers it), read once the command committed: its history (the
 * promise changes) is made of the command's own audit rows, which command() writes after the work. A replayed request
 * answers the record as it is now.
 */
export async function recordAfter(caller: CommandCaller, orderId: string): Promise<OrderView> {
  return caller.withClient(async (client) => {
    const order = (await readOrder(client, orderId))!
    return orderView(client, order, businessDate(serverClock.now()), await orderSettlement().settlementOf(client, order))
  })
}

function statusChanged(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId'>, from: SalesOrderStatus, to: SalesOrderStatus, by: 'person' | 'system'): void {
  tools.emit({ type: 'sales_order.status_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from, to, by } })
}

const reasonOf = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

// ---- the promise date --------------------------------------------------------------------------------------------------

export interface PromiseInput {
  readonly version?: number | undefined
  readonly promiseDate: BusinessDate
  readonly reason: string
  /** Only these lines get the new promise (their own date); none: the whole order. */
  readonly lineIds?: readonly string[] | undefined
}

/**
 * orders.manage: a new promise date with a reason (SAL-206; the design's "Change promise date"), for the order or for
 * some of its lines. The first promise (originalPromiseDate) is never overwritten: an order promised for the first time
 * gets it set to this date, once (the trigger holds it too). Lines change only before anything shipped.
 */
export async function changePromise(caller: CommandCaller, orderId: string, body: PromiseInput, idempotencyKey?: string): Promise<{ order: OrderView }> {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const lineIds = [...(body.lineIds ?? [])]
  await command(caller, { name: 'orders.changePromise', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockOrder(tx, order.id, body.version)
    const stateProblem = promiseStateProblem(locked.status, lineIds.length > 0)
    if (stateProblem) throw new InvalidStateError(stateProblem)
    const current = (await readOrder(tx, order.id))!
    const lines = await readLines(tx, order.id)
    const problems = promiseProblems({ status: locked.status, current: dayOrNull(current.promiseDate), promiseDate: body.promiseDate, reason: body.reason, lineIds, knownLineIds: lines.map((line) => line.id), today: today(tools) })
    if (problems.length > 0) throw new ValidationError('The promise date cannot change like this.', problems)
    const reason = body.reason.trim()
    const original = dayOrNull(current.originalPromiseDate)
    if (lineIds.length === 0) {
      const previous = dayOrNull(current.promiseDate)
      const originalPromiseDate = original ?? body.promiseDate
      await tx.salesOrder.update({ where: { id: order.id }, data: { promiseDate: asDay(body.promiseDate), ...(original === null ? { originalPromiseDate: asDay(originalPromiseDate) } : {}), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { promiseDate: previous, originalPromiseDate: original }, after: { promiseDate: body.promiseDate, previous, originalPromiseDate, lineIds: [] }, reason })
      tools.emit({ type: 'sales_order.promise_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, promiseDate: body.promiseDate, previous, lineIds: [] } })
    } else {
      const chosen = lines.filter((line) => lineIds.includes(line.id))
      const before = Object.fromEntries(chosen.map((line) => [line.id, dayOrNull(line.promiseDate) ?? dayOrNull(current.promiseDate)]))
      await tx.salesOrderLine.updateMany({ where: { id: { in: lineIds }, orderId: order.id }, data: { promiseDate: asDay(body.promiseDate), updatedAt: now, version: { increment: 1 } } })
      await tx.salesOrder.update({ where: { id: order.id }, data: { updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      const previous = new Set(Object.values(before)).size === 1 ? (Object.values(before)[0] ?? null) : null
      tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { lines: before, originalPromiseDate: original }, after: { promiseDate: body.promiseDate, previous, originalPromiseDate: original, lineIds }, reason })
      tools.emit({ type: 'sales_order.promise_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, promiseDate: body.promiseDate, previous, lineIds } })
    }
    return { orderId: order.id, promiseDate: body.promiseDate, lineIds }
  })
  return { order: await recordAfter(caller, order.id) }
}

// ---- ready by hand -------------------------------------------------------------------------------------------------------

/**
 * orders.manage: IN_PRODUCTION → READY by hand, with a reason (quality release, B-W1-45, moves it by itself once every
 * ordered piece is released; until then a person says so).
 */
export async function markReady(caller: CommandCaller, orderId: string, body: { readonly version?: number | undefined; readonly reason: string }, idempotencyKey?: string): Promise<{ order: OrderView }> {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  await command(caller, { name: 'orders.markReady', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockOrder(tx, order.id, body.version)
    const facts = moveFactsOf(await readOrderFacts(tx, order))
    const reason = reasonOf(body.reason)
    assertTransition(salesOrderMachine, locked.status, 'READY', { ...facts, reason })
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'READY', updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: locked.status }, after: { status: 'READY', releasedByQuality: facts.released === true }, ...(reason ? { reason } : {}) })
    statusChanged(tools, order, locked.status, 'READY', 'person')
    return { orderId: order.id, status: 'READY' }
  })
  return { order: await recordAfter(caller, order.id) }
}

// ---- cancel ----------------------------------------------------------------------------------------------------------------

/**
 * orders.manage: CONFIRMED → CANCELLED with a reason, only before any work order of its lines is released and with no
 * draft left (cancel those first). The lines' work-order locks (modules/production/work-orders `lockOrderLines`, the lock
 * a new work order takes on them) come first, then the order's row, then the work orders of its lines FOR SHARE (a
 * release in flight finishes first and is seen): no work order is made, or released unseen, for a cancelled order. Its
 * OPEN deposit requests are cancelled with it; a PAID one stays (a refund is the money module's) and is named in the
 * answer.
 */
export async function cancelOrder(caller: CommandCaller, orderId: string, body: { readonly version?: number | undefined; readonly reason: string }, idempotencyKey?: string): Promise<{ order: OrderView; paidDepositRequestIds: string[] }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.cancel', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const lineIds = (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    await lockOrderLines(tx, context.tenantId, lineIds)
    const locked = await lockOrder(tx, order.id, body.version)
    if (lineIds.length > 0) await tx.$queryRaw`SELECT w.id FROM "WorkOrder" w WHERE w.id IN (SELECT c."workOrderId" FROM "WorkOrderSize" c WHERE c."salesOrderLineId" = ANY(${lineIds}::uuid[])) ORDER BY w.id FOR SHARE`
    const facts = moveFactsOf(await readOrderFacts(tx, order))
    const reason = reasonOf(body.reason)
    assertTransition(salesOrderMachine, locked.status, 'CANCELLED', { ...facts, reason })
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelReason: reason!, closedAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const requests = await tx.depositRequest.findMany({ where: { OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] }, select: { id: true, status: true }, orderBy: { id: 'asc' } })
    for (const request of requests.filter((row) => row.status === 'OPEN')) {
      const { count } = await tx.depositRequest.updateMany({ where: { id: request.id, status: 'OPEN' }, data: { status: 'CANCELLED', statusNote: `Order ${order.number} cancelled: ${reason}`, updatedAt: now, version: { increment: 1 } } })
      if (count === 1) tools.audit({ action: 'orders.cancelDeposit', recordType: 'DepositRequest', recordId: request.id, companyId: order.companyId, before: { status: 'OPEN' }, after: { status: 'CANCELLED', orderId: order.id }, reason: reason! })
    }
    const paid = requests.filter((row) => row.status === 'PAID').map((row) => row.id)
    tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: locked.status }, after: { status: 'CANCELLED', cancelReason: reason, closedAt: toUtcIso(now), paidDepositRequestIds: paid }, reason: reason! })
    statusChanged(tools, order, locked.status, 'CANCELLED', 'person')
    return { orderId: order.id, status: 'CANCELLED', paidDepositRequestIds: paid }
  })
  return { order: await recordAfter(caller, order.id), paidDepositRequestIds: result.paidDepositRequestIds }
}

// ---- close -----------------------------------------------------------------------------------------------------------------

/**
 * SHIPPED → CLOSED by a person (PLAN §4.7: the close command whose guard asks the settlement port). Settled (every line
 * shipped, invoiced and paid): orders.manage or orders.close, no reason needed. Not settled: a reason (409 with what is
 * missing otherwise) AND orders.close (403 otherwise); the reason and what was missing stay on the audit row.
 */
export async function closeOrder(caller: CommandCaller, orderId: string, body: { readonly version?: number | undefined; readonly reason?: string | null | undefined }, idempotencyKey?: string): Promise<{ order: OrderView }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_VIEW)
  const mayManage = mayOn(context, ORDERS_MANAGE, order)
  const mayClose = mayOn(context, ORDERS_CLOSE, order)
  if (!mayManage && !mayClose) throw new ForbiddenError()
  await command(caller, { name: 'orders.close', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockOrder(tx, order.id, body.version)
    const settlement = await orderSettlement().settlementOf(tx, order)
    const reason = reasonOf(body.reason)
    assertTransition(salesOrderMachine, locked.status, 'CLOSED', { settlement, reason })
    if (!settlement.settled && !mayClose) throw new ForbiddenError('Closing an order that is not settled needs the right to close unsettled orders (orders.close).')
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CLOSED', closedAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      before: { status: locked.status },
      after: { status: 'CLOSED', closedAt: toUtcIso(now), settled: settlement.settled, missing: settlement.missing.map((entry) => entry.code), settlementSource: settlement.source },
      ...(reason ? { reason } : {}),
    })
    statusChanged(tools, order, locked.status, 'CLOSED', 'person')
    return { orderId: order.id, status: 'CLOSED', settled: settlement.settled }
  })
  return { order: await recordAfter(caller, order.id) }
}

// ---- the system follows the facts ------------------------------------------------------------------------------------------

class NothingToFollow extends DomainError {
  constructor() {
    super('invalid_state', 'Nothing to follow.')
  }
}

/**
 * The moves the facts ask for now (factory-domain `followMoves`): CONFIRMED → IN_PRODUCTION when a work order of its lines
 * was released; → READY when quality released every ordered piece (and nothing left yet); → PARTLY_SHIPPED / SHIPPED from
 * the shipped quantities (SHIPPED back to PARTLY_SHIPPED when a shipment came back); a SHIPPED order the settlement port
 * calls settled → CLOSED. As the system (the worker's handlers) or the office; ONE command on the order (its row locked,
 * the facts read again under the lock), one audit row and one `sales_order.status_changed` (by: system) per move. Nothing
 * to do: no command at all. Safe to repeat: it moves on facts, never on the event.
 */
export async function followOrder(caller: CommandCaller, orderId: string, cause: { readonly what: string; readonly causationId?: string }): Promise<{ moved: SalesOrderStatus[] }> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'system' && context.audience !== 'office')) throw new ForbiddenError()
  const planned = await caller.withClient(async (client) => {
    const order = await readOrder(client, orderId)
    if (!order) return []
    return followMoves(order.status, moveFactsOf(await readOrderFacts(client, order), await orderSettlement().settlementOf(client, order)))
  })
  if (planned.length === 0) return { moved: [] }
  try {
    const { result } = await command(caller, { name: 'orders.follow', input: { orderId, cause: cause.what }, ...(cause.causationId ? { causationId: cause.causationId } : {}) }, async (tools) => {
      const { tx, now } = tools
      const locked = await lockOrder(tx, orderId)
      const order = (await readOrder(tx, orderId))!
      const facts = moveFactsOf(await readOrderFacts(tx, order), await orderSettlement().settlementOf(tx, order))
      const moves = followMoves(locked.status, facts)
      if (moves.length === 0) throw new NothingToFollow()
      let from = locked.status
      for (const to of moves) {
        assertTransition(salesOrderMachine, from, to, { ...facts, reason: null })
        await tx.salesOrder.update({ where: { id: orderId }, data: { status: to, ...(to === 'CLOSED' ? { closedAt: now } : {}), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
        tools.audit({
          recordType: 'SalesOrder',
          recordId: orderId,
          companyId: order.companyId,
          before: { status: from },
          after: { status: to, ...(to === 'CLOSED' ? { closedAt: toUtcIso(now), settled: true, settlementSource: facts.settlement?.source ?? null } : {}) },
          reason: `Followed: ${cause.what}.`,
        })
        statusChanged(tools, order, from, to, 'system')
        from = to
      }
      return { moved: moves }
    })
    return result
  } catch (error) {
    if (error instanceof NothingToFollow) return { moved: [] }
    throw error
  }
}

/**
 * The money module says a CLOSED order is not settled any more (a credit note, a payment taken back): a closed order
 * never changes (the trigger), so its history gets an audit row that says so, once per event. An order not closed yet
 * needs nothing: its close asks the port again.
 */
export async function noteSettlementLost(caller: CommandCaller, orderId: string, event: { readonly eventId: string; readonly missing: readonly string[] }): Promise<{ noted: boolean }> {
  const order = await caller.withClient((client) => readOrder(client, orderId))
  if (!order || order.status !== 'CLOSED') return { noted: false }
  await command(caller, { name: 'orders.settlementLost', idempotencyKey: `orders-unsettled.${event.eventId}`, input: { orderId, missing: event.missing }, causationId: event.eventId }, async (tools) => {
    tools.audit({ recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { settled: false, missing: [...event.missing] }, reason: 'The money module says the closed order is not settled any more.' })
    return { noted: true }
  })
  return { noted: true }
}

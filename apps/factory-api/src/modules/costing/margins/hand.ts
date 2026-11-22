import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { HAND_MARGIN_WORDS, MARGIN_TARGET_ACTION, ORDER_COST_LINE_ACTION, ORDER_COST_LINE_REMOVED_ACTION, targetPctOf, type HandMarginRefusal, type OrderCostLineKind } from '@nexus/factory-domain/costing/margins/hand-lines'
import { COSTING_LEDGER_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import { lockOrder } from '../../sales/orders/store'
import { orderMargin } from './margins'

/**
 * B-OM-021 (order money tab; lead L2, L4; design order-money-2026-11-22 13-backend §5): an order's margin set by hand — the Owner
 * and Finance (costing.ledger.manage over the order's company and customer, and the cost grain; the target also the margin grain):
 *
 *   POST /costing/margins/orders/:orderId/cost-lines                  { kind, amount, reason }: a cost the ledger does not know ADDED
 *                                                                     (FREIGHT_ESTIMATE, COMMISSION, BANK_CHARGES, OTHER), in the
 *                                                                     order's currency; counted now and so far
 *   POST /costing/margins/orders/:orderId/cost-lines/:lineId/remove   { reason }: the line no longer counted (never deleted)
 *   PUT  /costing/margins/orders/:orderId/target                      { targetPct | null, reason }: the order's own target margin;
 *                                                                     the flag is judged on it, else the floor (./floor flagOf)
 *
 * The brand wall: an order the caller does not see with costing.view (another company, another customer) answers as an unknown one.
 * Never on a CLOSED or CANCELLED order (409; the DB guards too). ONE command each, under the order's row: the row, its audit
 * (`costing.orderCostLine` / `costing.orderCostLineRemoved` on the line; `orders.marginTarget` on the order, the percent marked
 * margin), the event order_margin.changed (ids only). A margin is never typed. Answers the order's profitability.
 */

const COST = grainPermission('cost') as Permission
const MARGIN = grainPermission('margin') as Permission
const NOT_A_COST_HOLDER = 'Shown to people who see costs.'
const NOT_A_MARGIN_HOLDER = 'Shown to people who see margins.'
const NOT_FOUND = 'Sales order not found.'

const refused = (code: HandMarginRefusal): DomainError => new DomainError('conflict', HAND_MARGIN_WORDS[code].en, [{ path: `handMargin/${code}`, message: HAND_MARGIN_WORDS[code].en }])
const isFinal = (status: string): boolean => status === 'CLOSED' || status === 'CANCELLED'
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string => (tools.context.audience === 'office' ? tools.context.actorId : SYSTEM_ACTOR_ID)
const missing = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])

const ORDER = { id: true, companyId: true, partyId: true, status: true, currency: true, targetMarginPct: true } as const

/** The order as a hand command reads it, with the caller's rights over it (the brand wall first). */
async function handOrder(caller: CommandCaller, orderId: string, grains: readonly Permission[]) {
  const actor = actorOf(contextOf(caller))
  const order = isUuid(orderId) ? await caller.withClient((db) => db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER })) : null
  const scope = order ? { companyId: order.companyId, partyId: order.partyId } : null
  if (!order || !scope || !can(actor, COSTING_VIEW, scope)) throw new NotFoundError(NOT_FOUND)
  if (!can(actor, COSTING_LEDGER_MANAGE, scope)) throw new ForbiddenError()
  if (!can(actor, COST, scope)) throw new ForbiddenError(NOT_A_COST_HOLDER)
  if (grains.includes(MARGIN) && !can(actor, MARGIN, scope)) throw new ForbiddenError(NOT_A_MARGIN_HOLDER)
  if (isFinal(order.status)) throw refused('CLOSED')
  return order
}

/** The order locked and still open (inside the command). */
async function lockOpen(tools: CommandTools, orderId: string): Promise<void> {
  const { status } = await lockOrder(tools.tx, orderId)
  if (isFinal(status)) throw refused('CLOSED')
}

const announce = (tools: Pick<CommandTools, 'emit'>, order: { readonly id: string; readonly companyId: string; readonly partyId: string }): void =>
  tools.emit({ type: 'order_margin.changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId } })

export interface AddCostLineBody {
  readonly kind: OrderCostLineKind
  readonly amount?: number | undefined
  readonly reason?: string | undefined
}

/** POST /costing/margins/orders/:orderId/cost-lines */
export async function addOrderCostLine(caller: CommandCaller, orderId: string, body: AddCostLineBody, idempotencyKey?: string) {
  const order = await handOrder(caller, orderId, [COST])
  if (body.amount === undefined) throw missing('amount', 'Name the amount, in the order’s currency.')
  if (body.reason === undefined) throw missing('reason', 'Say why (3 to 500 characters): it is kept in the history.')
  const amount = body.amount
  const reason = body.reason.trim()
  await command(caller, { name: ORDER_COST_LINE_ACTION, idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    await lockOpen(tools, order.id)
    const id = newId()
    await tools.tx.orderCostLine.create({
      data: { id, companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, kind: body.kind, amount, currency: order.currency, reason, createdById: actorIdOf(tools), createdAt: tools.now },
      select: { id: true },
    })
    tools.audit({ action: ORDER_COST_LINE_ACTION, recordType: 'OrderCostLine', recordId: id, companyId: order.companyId, after: { orderId: order.id, kind: body.kind, amount: markMoney('cost', amount), currency: order.currency, reason: markMoney('cost', reason) } })
    announce(tools, order)
    return { lineId: id }
  })
  return orderMargin(caller, order.id)
}

/** POST /costing/margins/orders/:orderId/cost-lines/:lineId/remove */
export async function removeOrderCostLine(caller: CommandCaller, orderId: string, lineId: string, body: { readonly reason?: string | undefined }, idempotencyKey?: string) {
  const order = await handOrder(caller, orderId, [COST])
  if (body.reason === undefined) throw missing('reason', 'Say why (3 to 500 characters): it is kept in the history.')
  const reason = body.reason.trim()
  const seen = isUuid(lineId) ? await caller.withClient((db) => db.orderCostLine.findFirst({ where: { id: lineId, salesOrderId: order.id }, select: { id: true } })) : null
  if (!seen) throw new NotFoundError('Cost line not found.')
  await command(caller, { name: ORDER_COST_LINE_REMOVED_ACTION, idempotencyKey, input: { orderId, lineId, ...body } }, async (tools) => {
    await lockOpen(tools, order.id)
    const line = await tools.tx.orderCostLine.findUniqueOrThrow({ where: { id: lineId }, select: { id: true, kind: true, amount: true, currency: true, reason: true, removedAt: true } })
    if (line.removedAt !== null) throw refused('REMOVED_ALREADY')
    await tools.tx.orderCostLine.update({ where: { id: line.id }, data: { removedAt: tools.now, removedById: actorIdOf(tools), removeReason: reason }, select: { id: true } })
    tools.audit({
      action: ORDER_COST_LINE_REMOVED_ACTION,
      recordType: 'OrderCostLine',
      recordId: line.id,
      companyId: order.companyId,
      before: { orderId: order.id, kind: line.kind, amount: markMoney('cost', line.amount), currency: line.currency, reason: markMoney('cost', line.reason) },
      after: { orderId: order.id, removedAt: toUtcIso(tools.now), removeReason: markMoney('cost', reason) },
    })
    announce(tools, order)
    return { lineId: line.id }
  })
  return orderMargin(caller, order.id)
}

/** PUT /costing/margins/orders/:orderId/target */
export async function setOrderMarginTarget(caller: CommandCaller, orderId: string, body: { readonly targetPct?: string | null | undefined; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const order = await handOrder(caller, orderId, [COST, MARGIN])
  if (body.targetPct === undefined) throw missing('targetPct', 'Name the target margin %, or null for the floor.')
  if (body.reason === undefined) throw missing('reason', 'Say why (3 to 500 characters): it is kept in the history.')
  const target = body.targetPct === null ? null : targetPctOf(body.targetPct)
  if (body.targetPct !== null && target === null) throw new ValidationError(HAND_MARGIN_WORDS.TARGET_RANGE.en, [{ path: 'body/targetPct', message: HAND_MARGIN_WORDS.TARGET_RANGE.en }])
  const reason = body.reason.trim()
  const before = order.targetMarginPct === null ? null : order.targetMarginPct.toString()
  // The same target again: nothing to write (no history row, no event).
  if (before === target) return orderMargin(caller, order.id)
  await command(caller, { name: MARGIN_TARGET_ACTION, idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    await lockOpen(tools, order.id)
    const now = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { targetMarginPct: true } })
    await tools.tx.salesOrder.update({ where: { id: order.id }, data: { targetMarginPct: target, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: MARGIN_TARGET_ACTION,
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      before: { targetMarginPct: markMoney('margin', now.targetMarginPct === null ? null : now.targetMarginPct.toString()) },
      after: { targetMarginPct: markMoney('margin', target) },
      reason,
    })
    announce(tools, order)
    return { orderId: order.id }
  })
  return orderMargin(caller, order.id)
}

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { BrandUrgency } from '@nexus/factory-domain/production-brand/urgency'
import { ORDER_NOT_FOUND_WORDS } from '@nexus/factory-domain/production-brand/words'
import { systemCallerOf } from '../../../platform/files/files'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { markInCommand, undoInCommand, urgentOrderInCommand, type NamedOrder } from '../brand/urgency'

/**
 * B-PR-22a — the customer's urgency from its portal (production plan §3 "Customer urgency", §5 Portal › My production; lead picks
 * L17, L18, L20, L25; review fixes R-48, R-49, R-61, R-65; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."). It
 * replaces the old portal rank (`PUT /portal/production/rank` was never built: the urgency is the only way).
 *
 *   POST /portal/production/urgency        {orderIds 1–50, urgency URGENT|REGULAR}: one result per own order — done, or refused
 *                                          in words (over the quota or from Cutting: "Ask us" until B-PR-46a; locked by us; not
 *                                          open; the same already); an id that is not one of its own orders is neither acted on
 *                                          nor named, only counted (`notFound`)
 *   PUT  /portal/production/urgent-order   {orderIds: its WHOLE Urgent list in the new order, asOf?}: the drag and "Move to top"
 *                                          (the list with the order first); a Regular order: "Mark urgent first"
 *   POST /portal/production/urgency/undo   {batchId}: puts one of its own batches back (rows changed since are left as they are);
 *                                          another customer's batch id, ours, or none: "not found"
 *
 * Each is a portal person's act with portal.production.urgency over the session's party (manifest; never a preview), only while
 * its urgency switch is on. The partner read comes first (its own orders, in the portal's company: row-level security by party);
 * then ONE command in the tenant's system scope (BrandOrderProduction is the office's table: the partner role only reads it) on
 * exactly those orders and the session's own party — ../brand/urgency.ts. The command's input names the party and the person, so
 * a receipt answers only the same customer's same request.
 */

export interface MarkBody {
  readonly orderIds: readonly string[]
  readonly urgency: BrandUrgency
}

export interface UrgentOrderBody {
  readonly orderIds: readonly string[]
  readonly asOf?: string | undefined
}

/** The ids named twice (400: the bulk bar sends each order once). */
function twiceProblems(orderIds: readonly string[]): Issue[] {
  const seen = new Set<string>()
  const issues: Issue[] = []
  orderIds.forEach((orderId, index) => {
    if (seen.has(orderId)) issues.push({ path: `body/orderIds/${index}`, message: 'This order is named twice.' })
    seen.add(orderId)
  })
  return issues
}

/** The writer: a portal person of the customer (an office preview reads only). */
function writer(app: FastifyInstance, request: FastifyRequest): PortalReader {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  return reader
}

/** Its own orders among these ids, in the portal's company (the partner scope: another customer's order is not found here). */
async function ownOrders(request: FastifyRequest, reader: PortalReader, orderIds: readonly string[]): Promise<NamedOrder[]> {
  if (orderIds.length === 0) return []
  const rows = await request.withClient((client) =>
    client.salesOrder.findMany({ where: { id: { in: [...orderIds] }, companyId: reader.session.company.id }, select: { id: true, number: true, customerRef: true, status: true } }),
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return orderIds.flatMap((orderId, index) => {
    const row = byId.get(orderId)
    return row ? [{ orderId, number: row.number, customerRef: row.customerRef, status: row.status, index }] : []
  })
}

const scopeOf = (reader: PortalReader) => ({ partyId: reader.session.partyId, companyId: reader.session.company.id, userId: reader.session.userId })

/** POST /portal/production/urgency */
export async function markUrgency(app: FastifyInstance, request: FastifyRequest, body: MarkBody, idempotencyKey: string | undefined) {
  const twice = twiceProblems(body.orderIds)
  if (twice.length > 0) throw new ValidationError('Name each order once.', twice)
  const reader = writer(app, request)
  const orders = await ownOrders(request, reader, body.orderIds)
  // A foreign id is neither acted on nor named: only counted; none of its own → the words of an unknown order.
  const notFound = body.orderIds.length - orders.length
  if (orders.length === 0) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)
  const scope = scopeOf(reader)
  const system = systemCallerOf(request)(reader.session.tenantId)
  const { result, replayed } = await commandOn(
    app,
    system,
    { name: 'portal.production.urgency', idempotencyKey, input: { ...scope, urgency: body.urgency, orderIds: orders.map((order) => order.orderId) } },
    (tools) => markInCommand(tools, { ...scope, urgency: body.urgency, orders }),
  )
  // End-check fix: the contract's arrays are mutable; the command's view is readonly (a copy, same rows).
  return { ...result, results: [...result.results], notFound, replayed }
}

/** PUT /portal/production/urgent-order */
export async function orderUrgent(app: FastifyInstance, request: FastifyRequest, body: UrgentOrderBody, idempotencyKey: string | undefined) {
  const twice = twiceProblems(body.orderIds)
  if (twice.length > 0) throw new ValidationError('Name each order once.', twice)
  const reader = writer(app, request)
  const orders = await ownOrders(request, reader, body.orderIds)
  const own = new Set(orders.map((order) => order.orderId))
  // Another customer's id (or none) at its place: "Order not found.", never named.
  const foreign: Issue[] = body.orderIds.flatMap((orderId, index) => (own.has(orderId) ? [] : [{ path: `body/orderIds/${index}`, message: ORDER_NOT_FOUND_WORDS.en }]))
  if (foreign.length > 0) throw new DomainError('conflict', ORDER_NOT_FOUND_WORDS.en, foreign)
  const scope = scopeOf(reader)
  const asOf = body.asOf ? new Date(body.asOf) : null
  const system = systemCallerOf(request)(reader.session.tenantId)
  const { result, replayed } = await commandOn(
    app,
    system,
    { name: 'portal.production.urgentOrder', idempotencyKey, input: { ...scope, orderIds: body.orderIds, asOf: body.asOf ?? null } },
    (tools) => urgentOrderInCommand(tools, { ...scope, orderIds: body.orderIds, asOf }),
  )
  return { ...result, results: [...result.results], notFound: 0, replayed }
}

/** POST /portal/production/urgency/undo */
export async function undoUrgency(app: FastifyInstance, request: FastifyRequest, body: { readonly batchId: string }, idempotencyKey: string | undefined) {
  const reader = writer(app, request)
  const scope = scopeOf(reader)
  const system = systemCallerOf(request)(reader.session.tenantId)
  const { result, replayed } = await commandOn(
    app,
    system,
    { name: 'portal.production.urgencyUndo', idempotencyKey, input: { ...scope, batchId: body.batchId } },
    (tools) => undoInCommand(tools, { ...scope, batchId: body.batchId }),
  )
  return { ...result, results: [...result.results], skipped: [...result.skipped], notFound: 0, replayed }
}

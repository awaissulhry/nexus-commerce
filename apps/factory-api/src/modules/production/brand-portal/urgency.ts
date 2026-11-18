import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { BrandUrgency } from '@nexus/factory-domain/production-brand/urgency'
import { ORDER_NOT_FOUND_WORDS } from '@nexus/factory-domain/production-brand/words'
import { systemCallerOf } from '../../../platform/files/files'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { isAskOutcome /* B-PR-46a */, markInCommand, OnlyAsked /* B-PR-46a */, undoInCommand, urgentOrderInCommand, type NamedOrder, type UrgencyOutcomeView, type UrgencyResult } from '../brand/urgency'
// B-PR-46a: the marks over the quota or from Cutting become "Urgent – asked" (one batch); the partner read of many orders.
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { askedUrgentWords, ASKED_WORDS, NONE_ASKED_WORDS } from '@nexus/factory-domain/production-brand/bulk'
import { PORTAL_SALES_ORDERS_ASK } from '@nexus/factory-domain/sales/change-requests/permissions'
import { can } from '@nexus/factory-domain/core/permissions'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { partnerOrders } from './access'
import { askUrgentRows } from './bulk'

/**
 * B-PR-22a — the customer's urgency from its portal (production plan §3 "Customer urgency", §5 Portal › My production; lead picks
 * L17, L18, L20, L25; review fixes R-48, R-49, R-61, R-65; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."). It
 * replaces the old portal rank (`PUT /portal/production/rank` was never built: the urgency is the only way).
 *
 *   POST /portal/production/urgency        {orderIds 1–50, urgency URGENT|REGULAR, requestedDate?}: one result per own order —
 *                                          done, or refused in words (locked by us; not open; the same already); over the quota
 *                                          or from Cutting the order becomes an "Urgent – asked" (B-PR-46a: a RUSH request of one
 *                                          batch for every such order, with the need-by date when given; `asked` on its row,
 *                                          `askBatchId` for Undo); an id that is not one of its own orders is neither acted on
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
  /** B-PR-46a: the need-by date of the orders that become "Urgent – asked" (none: asked without a date). */
  readonly requestedDate?: BusinessDate | undefined
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

/**
 * Its own orders among these ids, in the portal's company (the partner scope: another customer's order is not found here).
 * B-PR-46a: the set form of partnerOrder, shared by every bulk action (./access.ts partnerOrders).
 */
async function ownOrders(request: FastifyRequest, reader: PortalReader, orderIds: readonly string[]): Promise<NamedOrder[]> {
  return (await partnerOrders(request, reader, orderIds)).orders
}

const scopeOf = (reader: PortalReader) => ({ partyId: reader.session.partyId, companyId: reader.session.company.id, userId: reader.session.userId })

/** B-PR-46a: a row of the mark's answer — the command's result and, over the quota or from Cutting, its "Urgent – asked". */
export interface MarkResult extends UrgencyResult {
  /** The RUSH request this order became (null: it was not asked). */
  readonly asked: { readonly requestId: string; readonly words: Words } | null
}

/** POST /portal/production/urgency */
export async function markUrgency(app: FastifyInstance, request: FastifyRequest, body: MarkBody, idempotencyKey: string | undefined) {
  const twice = twiceProblems(body.orderIds)
  if (twice.length > 0) throw new ValidationError('Name each order once.', twice)
  const reader = writer(app, request)
  // B-PR-46a: the partner read of many orders (./access.ts partnerOrders).
  const { orders, notFound } = await partnerOrders(request, reader, body.orderIds)
  // A foreign id is neither acted on nor named: only counted; none of its own → the words of an unknown order.
  if (orders.length === 0) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)
  const scope = scopeOf(reader)
  const system = systemCallerOf(request)(reader.session.tenantId)
  // B-PR-46a: a mark of which nothing changes at once but some orders become "Urgent – asked" writes nothing (OnlyAsked).
  const { view, replayed } = await commandOn(
    app,
    system,
    { name: 'portal.production.urgency', idempotencyKey, input: { ...scope, urgency: body.urgency, orderIds: orders.map((order) => order.orderId) } },
    (tools) => markInCommand(tools, { ...scope, urgency: body.urgency, orders }),
  ).then(
    (outcome): { view: UrgencyOutcomeView; replayed: boolean } => ({ view: outcome.result, replayed: outcome.replayed }),
    (error: unknown): { view: UrgencyOutcomeView; replayed: boolean } => {
      if (error instanceof OnlyAsked) return { view: error.view, replayed: false }
      throw error
    },
  )
  // ── B-PR-46a: the orders over the quota or from Cutting become "Urgent – asked": one RUSH request each, one batch, in the
  // customer's own scope (each the single ask's path: its rules, impact and the need-by date). A person who may not ask (no
  // portal.salesOrders.ask) keeps "Ask us".
  const mayAsk = can(reader.actor, PORTAL_SALES_ORDERS_ASK, { companyId: reader.session.company.id, partyId: reader.session.partyId })
  const askRows = mayAsk ? orders.filter((order) => view.results.some((result) => result.orderId === order.orderId && isAskOutcome(result.outcome))) : []
  const asks = askRows.length > 0 ? await askUrgentRows(app, request, reader, askRows, body.requestedDate ?? null, idempotencyKey) : null
  const max = view.use?.max ?? 0
  const results: MarkResult[] = view.results.map((result) => {
    const asked = asks?.results.get(result.orderId)
    if (!asked || !isAskOutcome(result.outcome)) return { ...result, asked: null }
    if (asked.requestId) return { ...result, words: askedUrgentWords(result.outcome === 'ASK_CUT' ? 'CUT' : 'OVER_QUOTA', max), ask: null, asked: { requestId: asked.requestId, words: ASKED_WORDS } }
    // The ask itself was refused (one waits already, locked, ready …): its words, nothing more to ask.
    return { ...result, words: asked.words, ask: null, asked: null }
  })
  if (view.batchId === null && !results.some((result) => result.asked !== null)) {
    // Nothing changed at once and nothing was asked: each order's words at its place (409, as a mark that changed nothing).
    const issues: Issue[] = results.flatMap((result) => {
      const index = orders.find((order) => order.orderId === result.orderId)?.index ?? 0
      const code = asks?.results.get(result.orderId)?.code ?? result.outcome
      return result.words ? [{ path: `body/orderIds/${index}/${code}`, message: result.words.en }] : []
    })
    throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : NONE_ASKED_WORDS.en, issues)
  }
  // ── end B-PR-46a
  // End-check fix: the contract's arrays are mutable; the command's view is readonly (a copy, same rows).
  return { ...view, results, notFound, askBatchId: asks?.batchId ?? null, replayed: replayed && (asks?.replayed ?? true) }
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

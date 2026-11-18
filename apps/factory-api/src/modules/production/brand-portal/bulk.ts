import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, isDomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import {
  ASKED_WORDS,
  BATCH_NOT_FOUND_WORDS,
  bulkAskProblems,
  NONE_ASKED_WORDS,
  NOTHING_WITHDRAWN_WORDS,
  refusalCodeOf,
  WITHDRAW_WORDS,
  withdrawOutcomeOf,
  wordsOfMessage,
  type BatchAskKind,
  type BulkAskKind,
  type WithdrawOutcome,
} from '@nexus/factory-domain/production-brand/bulk'
import { ORDER_NOT_FOUND_WORDS } from '@nexus/factory-domain/production-brand/words'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import type { OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import { systemCallerOf } from '../../../platform/files/files'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { askInBatch, BatchAskRefused, withdrawOpenInCommand, type AskBody } from '../../sales/change-requests/portal'
import { lockRequest, readCancelReasons } from '../../sales/change-requests/store'
import { portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { partnerOrders } from './access'

/**
 * B-PR-46a — a customer's bulk asks on My production (production plan §1 "Bulk", §3 "Bulk asks: one request per order, one batch;
 * one kind per batch; Approvals shows the batch as one group"; lead picks L25, L26; review fixes R-50, R-51; wall test PW-12; the
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well."). Rules and words: factory-domain production-brand/bulk.
 *
 *   POST /portal/production/asks                    {orderIds 1–50, kind HOLD|RESUME|CANCEL, reasonCode?, reason?}
 *                                                   (portal.salesOrders.ask, never a preview): Ask N — one request per own order,
 *                                                   all of ONE batch and ONE kind; "urgent" is never asked here (R-50: Mark urgent
 *                                                   asks it, ../urgency.ts). The fields are checked once for every order (400); each
 *                                                   order is then asked through the single ask's own path (sales/change-requests
 *                                                   askInBatch: its rules — the kinds its limits open, cut-offs, one that waits per
 *                                                   order and kind —, its impact kept at Send, its own command with an
 *                                                   Idempotency-Key derived from the request's and the order), one result per order
 *                                                   (asked, or why not in its words). Nothing asked at all: 409 with each order's words
 *   POST /portal/production/asks/:batchId/withdraw  (portal.salesOrders.ask, never a preview): Undo — ONE command in the customer's
 *                                                   own scope: the batch's requests that still wait for our answer are withdrawn
 *                                                   (the single withdraw's writes), the ones we answered or countered stay (in
 *                                                   words); another customer's batch, or none: "not found"
 *   Mark urgent's asks                              (../urgency.ts, askUrgentRows) the orders over the quota or from Cutting become
 *                                                   one RUSH request each, of their own batch, with the need-by date when given
 *
 * The wall (PW-12): each id is checked in the partner scope first (./access.ts partnerOrders, the set form of partnerOrder); an id
 * that is not one of its own orders is neither acted on nor named, only counted (`notFound`); none of its own: 404 "Order not
 * found."; every request is written in the customer's own scope, and the database keeps a batch to one customer and one kind
 * (factory_order_change_request_batch_ok, B-PR-23). The batch is told ONCE, to the office only: `order_change_request.batch_asked`
 * {batchId, partyId, kind, count} (B-PR-32's notice; each request's own `asked` names the batch, so its notice is skipped), with one
 * audit row on the customer, in the tenant's system scope. A retry with the same Idempotency-Key joins the same batch (its id is
 * derived from the key) and asks no order twice.
 */

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A UUID (version 8, RFC variant) from a text: the batch of a request, known again on a retry with the same key. */
function uuidOf(text: string): string {
  const hex = sha(text)
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The batch of one bulk action: from the request's Idempotency-Key and the person (a retry joins the same batch), else new. */
const batchIdOf = (key: string | undefined, what: string, reader: PortalReader): string =>
  key ? uuidOf(`factory.portal-ask-batch|${what}|${reader.session.partyId}|${reader.session.userId}|${key}`) : newId()

/** One order's own Idempotency-Key, derived from the request's (the same request asks each order once). */
const rowKeyOf = (key: string | undefined, what: string, orderId: string): string | undefined => (key ? `${what}-${sha(`${key}|${orderId}`).slice(0, 48)}` : undefined)

/** The writer: a portal person of the customer (an office preview reads only). */
function writer(app: FastifyInstance, request: FastifyRequest): PortalReader {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  return reader
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

const blank = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** One order of a batch: the request it became, or why not (its code when the rule names one, and its words). */
export interface BatchRowOutcome {
  readonly requestId: string | null
  readonly code: string | null
  readonly words: Words
}

interface BatchRun {
  readonly results: Map<string, BatchRowOutcome>
  /** The requests made (or replayed), in the body's order. */
  readonly asked: string[]
  /** Every order's ask answered from its receipt (a retry of the same request). */
  readonly replayed: boolean
}

/**
 * Each order of the batch through the single ask's own path (sales/change-requests askInBatch), one after the other, each in
 * its own command and key. A refusal of one order is that order's result (in its words); the others go on.
 */
async function askEach(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, orders: readonly { readonly orderId: string }[], input: { readonly batchId: string; readonly body: AskBody; readonly keyName: string }, idempotencyKey: string | undefined): Promise<BatchRun> {
  const results = new Map<string, BatchRowOutcome>()
  const asked: string[] = []
  let replayed = true
  for (const order of orders) {
    try {
      const made = await askInBatch(app, request, reader, { orderId: order.orderId, batchId: input.batchId, body: input.body }, rowKeyOf(idempotencyKey, input.keyName, order.orderId))
      results.set(order.orderId, { requestId: made.requestId, code: null, words: ASKED_WORDS })
      asked.push(made.requestId)
      replayed = replayed && made.replayed
    } catch (error) {
      if (error instanceof BatchAskRefused) {
        results.set(order.orderId, { requestId: null, code: error.refusal, words: error.words })
        continue
      }
      if (!isDomainError(error)) throw error
      // Another rule of the single ask (a date, the impact, one that waits): its own words, which never name another customer.
      results.set(order.orderId, { requestId: null, code: refusalCodeOf(error.issues), words: wordsOfMessage(error.message) })
    }
  }
  return { results, asked, replayed: asked.length > 0 && replayed }
}

/**
 * The batch told once, to the office (B-PR-32's notice): ONE command in the tenant's system scope keyed by the batch and its
 * requests (the same requests are never told twice): the requests read again — the batch's, of the customer, at the portal's
 * company —, one audit row on the customer, one `order_change_request.batch_asked`.
 */
async function tellBatch(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, input: { readonly batchId: string; readonly kind: BatchAskKind; readonly requestIds: readonly string[] }): Promise<void> {
  const { session } = reader
  const scope = { partyId: session.partyId, companyId: session.company.id, userId: session.userId }
  const system = systemCallerOf(request)(session.tenantId)
  const key = `bulk-ask-told-${sha(`${input.batchId}|${[...input.requestIds].sort().join('|')}`).slice(0, 48)}`
  await commandOn(app, system, { name: 'portal.production.askBatch', idempotencyKey: key, input: { ...scope, batchId: input.batchId, kind: input.kind, requestIds: [...input.requestIds] } }, async (tools) => {
    const rows = await tools.tx.orderChangeRequest.findMany({
      where: { id: { in: [...input.requestIds] }, batchId: input.batchId, partyId: scope.partyId, companyId: scope.companyId, kind: input.kind },
      select: { id: true, orderId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    if (rows.length === 0) throw new NotFoundError(BATCH_NOT_FOUND_WORDS.en)
    tools.audit({
      action: 'portal.production.askBatch',
      recordType: 'Party',
      recordId: scope.partyId,
      companyId: scope.companyId,
      after: { batchId: input.batchId, kind: input.kind, count: rows.length, byId: scope.userId, requests: rows.map((row) => ({ requestId: row.id, orderId: row.orderId })) },
    })
    tools.emit({ type: 'order_change_request.batch_asked', subject: input.batchId, companyId: scope.companyId, payload: { batchId: input.batchId, partyId: scope.partyId, kind: input.kind, count: rows.length } })
    return { count: rows.length }
  })
}

/** Nothing of the batch was asked: 409 with each order's words at its place (`body/orderIds/<index>/<code>`). */
function noneAsked(orders: readonly { readonly orderId: string; readonly index: number }[], results: ReadonlyMap<string, BatchRowOutcome>): DomainError {
  const issues: Issue[] = orders.flatMap((order) => {
    const result = results.get(order.orderId)
    return result ? [{ path: `body/orderIds/${order.index}${result.code ? `/${result.code}` : ''}`, message: result.words.en }] : []
  })
  return new DomainError('conflict', issues.length === 1 ? issues[0]!.message : NONE_ASKED_WORDS.en, issues)
}

// ---- Mark urgent's "Urgent – asked" (../urgency.ts) ---------------------------------------------------------------------------

/**
 * The orders of a mark over the quota or from Cutting, each asked as "Urgent – asked" (RUSH, the need-by date when given), all of
 * one batch, then the batch told once. Called after the mark's own command; the orders are the partner read's (its own).
 */
export async function askUrgentRows(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, orders: readonly { readonly orderId: string }[], requestedDate: BusinessDate | null, idempotencyKey: string | undefined): Promise<{ readonly batchId: string | null; readonly results: ReadonlyMap<string, BatchRowOutcome>; readonly replayed: boolean }> {
  const batchId = batchIdOf(idempotencyKey, 'urgency', reader)
  const body: AskBody = requestedDate ? { kind: 'RUSH', requestedDate } : { kind: 'RUSH' }
  const run = await askEach(app, request, reader, orders, { batchId, body, keyName: 'urgent-ask' }, idempotencyKey)
  if (run.asked.length > 0) await tellBatch(app, request, reader, { batchId, kind: 'RUSH', requestIds: run.asked })
  return { batchId: run.asked.length > 0 ? batchId : null, results: run.results, replayed: run.replayed }
}

// ---- Ask N (POST /portal/production/asks) -------------------------------------------------------------------------------------

export interface AskManyBody {
  readonly orderIds: readonly string[]
  readonly kind: BulkAskKind
  readonly reasonCode?: string | undefined
  readonly reason?: string | undefined
}

/** POST /portal/production/asks */
export async function askMany(app: FastifyInstance, request: FastifyRequest, body: AskManyBody, idempotencyKey: string | undefined) {
  const twice = twiceProblems(body.orderIds)
  if (twice.length > 0) throw new ValidationError('Name each order once.', twice)
  const reader = writer(app, request)
  // The fields, once for every order (a cancel's reason against the tenant's list, read as the person).
  const reasons = body.kind === 'CANCEL' ? new Map((await reader.inTenant((client) => readCancelReasons(client))).map((reason) => [reason.code, { needsNote: reason.needsNote }])) : new Map<string, { needsNote: boolean }>()
  const problems = bulkAskProblems(body, reasons)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'This ask cannot be sent like this.', problems)
  const { orders, notFound } = await partnerOrders(request, reader, body.orderIds)
  // A foreign id is neither acted on nor named: only counted; none of its own → the words of an unknown order.
  if (orders.length === 0) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)
  const batchId = batchIdOf(idempotencyKey, `ask-${body.kind}`, reader)
  const note = blank(body.reason)
  const askBody: AskBody = body.kind === 'CANCEL' ? { kind: 'CANCEL', reasonCode: body.reasonCode!.trim(), note } : { kind: body.kind, note }
  const run = await askEach(app, request, reader, orders, { batchId, body: askBody, keyName: 'bulk-ask' }, idempotencyKey)
  if (run.asked.length === 0) throw noneAsked(orders, run.results)
  await tellBatch(app, request, reader, { batchId, kind: body.kind, requestIds: run.asked })
  return {
    batchId,
    kind: body.kind,
    results: orders.map((order) => {
      const result = run.results.get(order.orderId)!
      return { orderId: order.orderId, number: order.number, customerRef: order.customerRef, done: result.requestId !== null, requestId: result.requestId, code: result.code, words: result.words }
    }),
    notFound,
    replayed: run.replayed,
  }
}

// ---- Undo (POST /portal/production/asks/:batchId/withdraw) --------------------------------------------------------------------

interface WithdrawRow {
  readonly requestId: string
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly kind: string
  readonly done: boolean
  readonly outcome: WithdrawOutcome
  readonly words: Words
}

/** POST /portal/production/asks/:batchId/withdraw */
export async function withdrawAskBatch(app: FastifyInstance, request: FastifyRequest, batchId: string, idempotencyKey: string | undefined) {
  const reader = writer(app, request)
  const { session } = reader
  const { result, replayed } = await commandOn(app, request, { name: 'portal.withdrawAskBatch', idempotencyKey, input: { batchId } }, async (tools) => {
    const { tx } = tools
    // The batch's requests in the customer's own scope (row-level security by party), at the portal's company; checked again.
    const found = (await tx.orderChangeRequest.findMany({ where: { batchId, companyId: session.company.id }, select: { id: true, partyId: true }, orderBy: { id: 'asc' } })).filter((row) => row.partyId === session.partyId)
    if (found.length === 0) throw new NotFoundError(BATCH_NOT_FOUND_WORDS.en)
    // Each request's row lock in id order (the single withdraw and our answers take the same lock), then each as it is now.
    for (const row of found) await lockRequest(tx, row.id)
    const rows = await tx.orderChangeRequest.findMany({ where: { id: { in: found.map((row) => row.id) } }, select: { id: true, orderId: true, companyId: true, partyId: true, kind: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const orders = new Map((await tx.salesOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.orderId))] } }, select: { id: true, number: true, customerRef: true } })).map((order) => [order.id, order]))
    const results: WithdrawRow[] = []
    for (const row of rows) {
      const outcome = withdrawOutcomeOf(row.status as string)
      if (outcome === 'WITHDRAWN') await withdrawOpenInCommand(tools, { id: row.id, orderId: row.orderId, companyId: row.companyId, partyId: row.partyId, kind: row.kind as OrderRequestKind, batchId })
      const order = orders.get(row.orderId)
      results.push({ requestId: row.id, orderId: row.orderId, number: order?.number ?? '', customerRef: order?.customerRef ?? null, kind: row.kind as string, done: outcome === 'WITHDRAWN', outcome, words: WITHDRAW_WORDS[outcome] })
    }
    // Nothing still waited for our answer: nothing written (409), each request's words at its place.
    if (!results.some((entry) => entry.done)) throw new DomainError('conflict', NOTHING_WITHDRAWN_WORDS.en, results.map((entry, index) => ({ path: `batch/${index}/${entry.outcome}`, message: entry.words.en })))
    return { results }
  })
  return { batchId, results: [...result.results], replayed }
}

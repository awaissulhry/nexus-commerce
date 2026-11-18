import { dueAtFor } from '@nexus/factory-domain/approvals-out/rules'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError, ForbiddenError, isDomainError /* B-PR-46a */, NotFoundError /* B-PR-46a */, ValidationError, type Issue /* B-PR-46a */ } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { counterOf, counterProblems, officeAnswerProblem } from '@nexus/factory-domain/sales/change-requests/counter'
import { answerProblems, ASK_RULES, ORDER_REQUEST_KIND_WORDS, type OrderRequestKind, type RequestStatus } from '@nexus/factory-domain/sales/change-requests/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { localeOf } from '../../../platform/approvals-out/store'
import { answerableIn, counterInCommand, counterStateIn } from '../../sales/change-requests/counter'
import type { OfficeRequestRow } from '../../sales/change-requests/store'
import { officeContextOf } from '../work-orders/access'
import { brandRequestViews, brandRequestWhere, readableBatch /* B-PR-46a */, readableRequest } from './read'
// B-PR-46a: a customer's batch answered as one group.
import { createHash } from 'node:crypto'
import { BATCH_ANSWER_WORDS, OFFICE_BATCH_NOT_FOUND, refusalCodeOf } from '@nexus/factory-domain/production-brand/bulk'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'

/**
 * B-PR-26 — the office answers a customer's request with words it reads (production plan §3 "We accept, counter or refuse with
 * words it reads", "Who answers / sets", "Money"; lead pick L4; review fixes R-05, R-32). Accepting does the work, so it is the
 * kind's own route (Sales' accept for a change, a cancel, ship what is ready; B-PR-27a/b's for the production asks); here:
 *
 *   refuse   POST /production/brand-requests/:requestId/refuse {version, answer}: an OPEN request — or a COUNTERED one whose
 *            counter lapsed — REFUSED with the words the customer reads; audit rows on the request and the order;
 *            order_change_request.answered (REFUSED)
 *   counter  POST …/:requestId/counter {version, date?, fee?, note?}: an OPEN request of a kind we counter (every kind but a
 *            resume) answered with what we offer instead — a date from today on, a fee (a price: only by a person with the price
 *            grain), words; at least one (factory-domain counterProblems). ONE command: the COUNTER_OFFER approval the customer
 *            answers in its portal (sales/change-requests/counter counterInCommand), the request COUNTERED. Its yes comes back
 *            here to be accepted (carried out with the counter); its no withdraws the request (the approvals' settle).
 * Who: the request read through the brand wall (./read: workorders.view or orders.view over its company and customer, else
 * "Change request not found."), then the kind's permission over the order (ASK_RULES answeredWith: CHANGE, CANCEL,
 * SPLIT_SHIPMENT orders.manage; RUSH, HOLD, RESUME production.brand.manage; SAMPLE_ROUND sales.samples.manage), else 403 in
 * words. A batch is answered request by request (B-PR-46a: refuseBatch here and acceptBatch in ./accept.ts loop the single path
 * per row, each its own command and key — answerEach).
 */

/** The kind's permission over the order, or 403 in words (the request was found through the wall already). B-PR-27a: the accept's too. */
export function assertAnswers(actor: Actor, row: Pick<OfficeRequestRow, 'kind' | 'companyId' | 'partyId'>): void {
  const kind = row.kind as OrderRequestKind
  const permission = ASK_RULES[kind].answeredWith
  if (!can(actor, permission, { companyId: row.companyId, partyId: row.partyId })) {
    throw new ForbiddenError(`Answering a customer's "${ORDER_REQUEST_KIND_WORDS[kind].en}" needs ${permission} over this customer's orders.`)
  }
}

/** The request's office view after an answer (B-PR-27a: the accept's too). */
export async function viewAfter(caller: CommandCaller, requestId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const row = await readableRequest(client, actorOf(context), requestId)
    return (await brandRequestViews(client, context, [row]))[0]!
  })
}

const blank = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

export interface RefuseBody {
  readonly version: number
  readonly answer: string
}

export async function refuseBrandRequest(caller: CommandCaller, requestId: string, body: RefuseBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  const found = await caller.withClient((client) => readableRequest(client, actor, requestId))
  assertAnswers(actor, found)
  const problems = answerProblems('REFUSED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await runCommand(caller, { name: 'orders.refuseCustomerRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { row } = await answerableIn(tools, requestId, body.version, 'REFUSED')
    const answer = body.answer.trim()
    await tools.tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'REFUSED', answer, answeredAt: tools.now, answeredById: context.actorId, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'orders.refuseChangeRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: row.status }, after: { status: 'REFUSED', answer } })
    tools.audit({ action: 'orders.changeRequestRefused', recordType: 'SalesOrder', recordId: row.orderId, companyId: row.companyId, after: { requestId, kind: row.kind } })
    tools.emit({ type: 'order_change_request.answered', subject: requestId, companyId: row.companyId, payload: { requestId, orderId: row.orderId, partyId: row.partyId, kind: row.kind as OrderRequestKind, answer: 'REFUSED', amendmentId: null, orderCancelled: false } })
    return null
  }, { ...COMMAND_SETTINGS, clock })
  return { request: await viewAfter(caller, requestId) }
}

export interface CounterBody {
  readonly version: number
  readonly date?: BusinessDate | null | undefined
  /** A price in minor units (money.price in the contract: refused without the grain). */
  readonly fee?: number | null | undefined
  readonly note?: string | null | undefined
}

export async function counterBrandRequest(caller: CommandCaller, requestId: string, body: CounterBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  const found = await caller.withClient((client) => readableRequest(client, actor, requestId))
  assertAnswers(actor, found)
  const kind = found.kind as OrderRequestKind
  const status = found.status as RequestStatus
  const draft = { date: body.date ?? null, fee: body.fee ?? null, note: blank(body.note) }
  // A price is set only by a person who sees prices (the fee is a price: money.price).
  if (draft.fee !== null && !heldGrains(actor).has('price')) throw new ForbiddenError('A counter-offer with a price needs the right to see prices.')
  // Where the request stands first (it waits for the customer, is answered, or was countered once already), then the offer.
  const now = clock.now()
  const stands = officeAnswerProblem('COUNTERED', { kind, status }, await caller.withClient((client) => counterStateIn(client, found)))
  if (stands) throw new DomainError('invalid_state', stands.message, [stands])
  const problems = counterProblems({ kind, status }, draft, businessDate(now))
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The counter-offer is not complete.', problems)
  const counter = counterOf(draft)
  // The approval's id, its link's token and its due time made outside the command (the engine's own ask does the same). The
  // question is in the customer's language: the person who asked, else the customer's.
  const approvalRequestId = newId()
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: found.partyId, linkId })
  const dueAt = dueAtFor('COUNTER_OFFER', null, now)
  const facts = await caller.withClient(async (client) => ({
    asker: found.createdById ? await client.user.findUnique({ where: { id: found.createdById }, select: { locale: true } }) : null,
    party: await client.party.findUnique({ where: { id: found.partyId }, select: { language: true } }),
    order: await client.salesOrder.findUnique({ where: { id: found.orderId }, select: { number: true } }),
    me: await client.user.findUnique({ where: { id: context.actorId }, select: { id: true, displayName: true } }),
  }))
  const locale = localeOf(facts.asker?.locale ?? facts.party?.language)
  const { result } = await runCommand(caller, { name: 'orders.counterCustomerRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { row } = await answerableIn(tools, requestId, body.version, 'COUNTERED')
    return counterInCommand(tools, {
      row,
      orderNumber: facts.order?.number ?? '',
      counter,
      approvalRequestId,
      linkId,
      tokenHash: linkTokenHash(token.value),
      dueAt,
      locale,
      actorId: context.actorId,
      askedBy: facts.me ? { id: facts.me.id, name: facts.me.displayName } : null,
    })
  }, { ...COMMAND_SETTINGS, clock })
  return { request: await viewAfter(caller, requestId), approvalRequestId: result.approvalRequestId }
}

// ── B-PR-46a: a customer's batch answered as one group (Home › Approvals "Accept all" / "Refuse all") ──────────────────────────

/** One request of the batch as the office saw it (its version: each is re-checked at it). */
export interface BatchItem {
  readonly requestId: string
  readonly version: number
}

/** What a batch answer did to one request: done (and what it did, in words), or why not (the office's real reason). */
export interface BatchRowResult {
  readonly requestId: string
  readonly orderId: string
  readonly orderNumber: string
  readonly done: boolean
  readonly words: Words | null
  readonly problem: { readonly code: string; readonly message: string } | null
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** One request's own Idempotency-Key, derived from the batch call's (a retry answers each request once). */
const rowKeyOf = (key: string | undefined, what: string, requestId: string): string | undefined => (key ? `${what}-${sha(`${key}|${requestId}`).slice(0, 48)}` : undefined)

/** The requests named twice (400: the window sends each once). */
function twiceProblems(items: readonly BatchItem[]): Issue[] {
  const seen = new Set<string>()
  return items.flatMap((item, index) => {
    const twice = seen.has(item.requestId)
    seen.add(item.requestId)
    return twice ? [{ path: `body/items/${index}`, message: 'This request is named twice.' }] : []
  })
}

/**
 * A batch answered request by request through the single path of each (each its own command and key: answerOne), at the version
 * the office read. The batch is read through the wall first (./read readableBatch: another customer's, or none, "not found"); the
 * kind's permission over the customer is asked once (all of one customer and one kind), else 403 in words. A request named that
 * is not of this batch (or not reached) is only counted (`notFound`), never named; none of the batch: "not found". A request
 * refused is that row's result (the reason, the office's words); nothing done at all: 409 with each row's reason at
 * `body/items/<index>/<code>`. The answer: one result per row, and the batch as it stands now.
 */
export async function answerEach(caller: CommandCaller, input: { readonly batchId: string; readonly rows: readonly OfficeRequestRow[]; readonly items: readonly BatchItem[]; readonly keyName: string }, idempotencyKey: string | undefined, answerOne: (row: OfficeRequestRow, version: number, key: string | undefined) => Promise<Words>) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const twice = twiceProblems(input.items)
  if (twice.length > 0) throw new ValidationError('Name each request once.', twice)
  const byId = new Map(input.rows.map((row) => [row.id, row]))
  const named = input.items.flatMap((item, index) => {
    const row = byId.get(item.requestId)
    return row ? [{ row, version: item.version, index }] : []
  })
  if (named.length === 0) throw new NotFoundError(OFFICE_BATCH_NOT_FOUND)
  assertAnswers(actor, named[0]!.row)
  const numbers = new Map((await caller.withClient((client) => client.salesOrder.findMany({ where: { id: { in: [...new Set(named.map((entry) => entry.row.orderId))] } }, select: { id: true, number: true } }))).map((order) => [order.id, order.number]))
  const results: BatchRowResult[] = []
  const issues: Issue[] = []
  for (const { row, version, index } of named) {
    const base = { requestId: row.id, orderId: row.orderId, orderNumber: numbers.get(row.orderId) ?? '' }
    try {
      const words = await answerOne(row, version, rowKeyOf(idempotencyKey, input.keyName, row.id))
      results.push({ ...base, done: true, words, problem: null })
    } catch (error) {
      if (!isDomainError(error)) throw error
      const code = refusalCodeOf(error.issues) ?? error.code
      results.push({ ...base, done: false, words: null, problem: { code, message: error.message } })
      issues.push({ path: `body/items/${index}/${code}`, message: error.message })
    }
  }
  if (!results.some((result) => result.done)) throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'Nothing was answered: see each request.', issues)
  const requests = await caller.withClient(async (client) => brandRequestViews(client, context, await readableBatch(client, actor, input.batchId)))
  return { batchId: input.batchId, results, notFound: input.items.length - named.length, requests }
}

export interface BatchRefuseBody {
  readonly items: readonly BatchItem[]
  readonly answer: string
}

/** POST /production/brand-requests/batches/:batchId/refuse — every request named refused with the same words (each its own path). */
export async function refuseBatch(caller: CommandCaller, batchId: string, body: BatchRefuseBody, idempotencyKey: string | undefined, clock: Clock) {
  const actor = actorOf(officeContextOf(caller))
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  const rows = await caller.withClient((client) => readableBatch(client, actor, batchId))
  const problems = answerProblems('REFUSED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return answerEach(caller, { batchId, rows, items: body.items, keyName: 'batch-refuse' }, idempotencyKey, async (row, version, key) => {
    await refuseBrandRequest(caller, row.id, { version, answer: body.answer }, key, clock)
    return BATCH_ANSWER_WORDS.REFUSED
  })
}
// ── end B-PR-46a ──

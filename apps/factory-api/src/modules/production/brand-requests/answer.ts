import { dueAtFor } from '@nexus/factory-domain/approvals-out/rules'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
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
import { brandRequestViews, brandRequestWhere, readableRequest } from './read'

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
 * words. A batch is answered request by request (B-PR-46a loops these per row).
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

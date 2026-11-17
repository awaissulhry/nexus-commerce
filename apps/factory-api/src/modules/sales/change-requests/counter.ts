import type { Prisma } from '@nexus/factory-db'
import { COUNTER_OFFER_RECORD, KIND_RULES, type ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import {
  acceptedWithCounter, // B-PR-27b
  ASKED_ONLY_FROM_COUNTER,
  counterAnswererHeld,
  counterFactsOf,
  counterGoneWords,
  counterPriced,
  counterQuestion,
  counterStateOf,
  officeAnswerProblem,
  type Counter,
  type CounterState,
  type OfficeAnswer,
} from '@nexus/factory-domain/sales/change-requests/counter'
import type { OrderRequestKind, RequestStatus } from '@nexus/factory-domain/sales/change-requests/rules'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { StaleVersionError, type CommandTools } from '../../../core/command'
import type { AnswererFacts, ApprovalRecord, RecordAdapter, RequestRef } from '../../../platform/approvals-out/adapter'
import { RECORD, sourceKeyOf } from '../../../platform/approvals-out/store'
import { openTaskInCommand } from '../../../platform/portal/tasks/store'
import { asDay, dayOrNull, lockRequest, OFFICE_REQUEST_COLUMNS, type OfficeRequestRow, type Reader } from './store'

/**
 * B-PR-26 (production plan §3 "We accept, counter or refuse with words it reads", "Money: a priced counter-offer is answered
 * only by the brand's Buyer or Admin"; 08-backend §4.2 Counter; Appendix C "Counter → COUNTER_OFFER approval"; lead pick L4;
 * review fixes R-05, R-32; rules factory-domain sales/change-requests/counter): our counter-offer to a customer's request, through
 * the ONE approvals engine.
 *
 *   ask      `counterInCommand`, in the office's counter command (production/brand-requests/answer.ts): a COUNTER_OFFER approval
 *            request about the change request (record OrderChangeRequest; its question in the customer's language: the kind asked,
 *            the date we offer, that a price applies — never the amount), its APPROVAL link (one use, expires at the due time; never
 *            handed: a counter-offer is answered in the portal, Waiting for you) and the partner's APPROVE task — as the engine's own
 *            ask makes them — then the request OPEN → COUNTERED with the counter (date, fee as a price, words), audit rows on the
 *            request and the order, approval_request.asked and order_change_request.countered
 *   adapter  record type OrderChangeRequest (platform/approvals-out/records.ts, one line): COUNTER_OFFER is a kind only its own
 *            command asks (`commandKinds`): "Ask for approval" never offers it, the generic ask is refused in words. Content: the
 *            order, the request, the dates, whether a price applies, our words (factory-domain counterFactsOf: never the amount).
 *            Held: the request no longer waits for this counter. The answerer (`answererHeld`): in the portal only, and a priced
 *            counter only by a role with the price grain (the Buyer, the Admin). The answer is kept on the order's thread.
 *   settle   in the tenant's system scope, after the customer's answer: no → the request WITHDRAWN (the customer's words stay on
 *            the approval); yes → it stays COUNTERED and comes back to the office (Home › Approvals, "accept the request to carry
 *            it out"): the accept that does the work carries it out with the counter (Sales' accept for a change or a cancel,
 *            B-PR-27a/b's for the production asks; the database makes COUNTERED → ACCEPTED exactly when the counter was approved).
 *            Either way order_change_request.counter_answered and audit rows on the request and the order.
 *   answers  `answerableIn`: the request locked (FOR UPDATE) at the version read, and whether the office may answer it so now
 *            (factory-domain officeAnswerProblem) — Sales' accept and refuse and the production routes share it.
 */

const COUNTERED_ACTION = 'orders.counterChangeRequest'
const AGREED_ACTION = 'orders.counterAgreed'
const DECLINED_ACTION = 'orders.counterDeclined'

/** The counter on a request row (its columns; nothing said → null). */
export const counterOfRow = (row: Pick<OfficeRequestRow, 'counterDate' | 'counterFee' | 'counterNote'>): Counter => ({ date: dayOrNull(row.counterDate), fee: row.counterFee, note: row.counterNote })

/** Where the request's counter stands now (null: never countered). */
export async function counterStateIn(db: Reader, row: Pick<OfficeRequestRow, 'counterApprovalId'>): Promise<CounterState | null> {
  if (!row.counterApprovalId) return null
  const approval = await db.approvalRequest.findUnique({ where: { id: row.counterApprovalId }, select: { status: true } })
  return counterStateOf(approval?.status ?? null) ?? 'LAPSED'
}

/**
 * Inside an office answer's command: the request locked (FOR UPDATE: the customer's withdrawal and another answer wait), at the
 * version read, and whether it takes this answer now (an OPEN request; a COUNTERED one once the customer said yes — to accept —
 * or once the counter lapsed — to refuse); refused in words (409 `request/<STATUS>` or `request/COUNTER_<STATE>`).
 */
export async function answerableIn(tools: CommandTools, requestId: string, version: number, answer: OfficeAnswer): Promise<{ readonly row: OfficeRequestRow; readonly counter: CounterState | null }> {
  await lockRequest(tools.tx, requestId)
  const row = await tools.tx.orderChangeRequest.findUnique({ where: { id: requestId }, select: OFFICE_REQUEST_COLUMNS })
  if (!row) throw new NotFoundError('Change request not found.')
  const counter = await counterStateIn(tools.tx, row)
  const problem = officeAnswerProblem(answer, { kind: row.kind as OrderRequestKind, status: row.status as RequestStatus }, counter)
  if (problem) throw new DomainError('invalid_state', problem.message, [problem])
  if (row.version !== version) throw new StaleVersionError('OrderChangeRequest', requestId, row.version, version)
  return { row, counter }
}

// ---- the ask, in the office's counter command ----------------------------------------------------------------------------

export interface CounterAsk {
  readonly row: OfficeRequestRow
  readonly orderNumber: string
  readonly counter: Counter
  readonly approvalRequestId: string
  readonly linkId: string
  readonly tokenHash: string
  readonly dueAt: Date
  readonly locale: ApprovalLocale
  readonly actorId: string
  readonly askedBy: { readonly id: string; readonly name: string } | null
}

/** The COUNTER_OFFER request, its link and the partner's task, then the request COUNTERED with the counter (one command). */
export async function counterInCommand(tools: CommandTools, input: CounterAsk): Promise<{ readonly approvalRequestId: string; readonly taskId: string }> {
  const { tx, now } = tools
  const { row, counter } = input
  const kind = row.kind as OrderRequestKind
  // The approval first: the request's guard checks it counters with an OPEN COUNTER_OFFER about itself.
  await tx.approvalRequest.create({
    data: { id: input.approvalRequestId, companyId: row.companyId, recordType: COUNTER_OFFER_RECORD, recordId: row.id, partyId: row.partyId, contactId: null, kind: 'COUNTER_OFFER', question: counterQuestion(kind, counter, input.locale), dueAt: input.dueAt, createdAt: now, updatedAt: now, createdById: input.actorId },
    select: { id: true },
  })
  // Every approval request has its APPROVAL link (one use, until the due time); a counter-offer's is never handed out: the
  // customer answers it in its portal, where its role decides who may (the money rule).
  await tx.oneOffLink.createMany({
    data: [{ id: input.linkId, companyId: row.companyId, partyId: row.partyId, purpose: 'APPROVAL', recordType: RECORD, recordId: input.approvalRequestId, tokenHash: input.tokenHash, email: null, expiresAt: input.dueAt, maxUses: 1, contactId: null, createdAt: now, updatedAt: now, createdById: input.actorId }],
  })
  tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: input.linkId, companyId: row.companyId, after: { purpose: 'APPROVAL', recordType: RECORD, recordId: input.approvalRequestId, partyId: row.partyId, email: null, expiresAt: toUtcIso(input.dueAt), maxUses: 1 } })
  const label = `${KIND_RULES.COUNTER_OFFER.name[input.locale]} · ${input.orderNumber}`
  const { task } = await openTaskInCommand(tools, { companyId: row.companyId, partyId: row.partyId, kind: KIND_RULES.COUNTER_OFFER.task, record: { type: RECORD, id: input.approvalRequestId, label }, sourceKey: sourceKeyOf(input.approvalRequestId), dueAt: input.dueAt, askedBy: input.askedBy })
  await tx.orderChangeRequest.update({
    where: { id: row.id },
    data: {
      status: 'COUNTERED',
      counterApprovalId: input.approvalRequestId,
      counteredAt: now,
      counteredById: input.actorId,
      counterDate: counter.date ? asDay(counter.date) : null,
      counterFee: counter.fee,
      counterNote: counter.note,
      updatedAt: now,
      version: { increment: 1 },
    },
    select: { id: true },
  })
  // The fee is a price: kept on the audit rows as marked money (the history drops it for a reader without the grain).
  const offered = { date: counter.date, fee: counter.fee === null ? null : markMoney('price', counter.fee), note: counter.note, priced: counterPriced(counter) }
  tools.audit({ action: COUNTERED_ACTION, recordType: 'OrderChangeRequest', recordId: row.id, companyId: row.companyId, before: { status: 'OPEN' }, after: { status: 'COUNTERED', approvalRequestId: input.approvalRequestId, ...offered } })
  tools.audit({ action: 'orders.changeRequestCountered', recordType: 'SalesOrder', recordId: row.orderId, companyId: row.companyId, after: { requestId: row.id, kind, approvalRequestId: input.approvalRequestId, ...offered } })
  tools.emit({ type: 'approval_request.asked', subject: input.approvalRequestId, companyId: row.companyId, payload: { requestId: input.approvalRequestId, kind: 'COUNTER_OFFER', recordType: COUNTER_OFFER_RECORD, recordId: row.id, partyId: row.partyId, dueAt: toUtcIso(input.dueAt), linkId: input.linkId, taskId: task.id, files: 0 } })
  tools.emit({ type: 'order_change_request.countered', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, orderId: row.orderId, partyId: row.partyId, kind, approvalRequestId: input.approvalRequestId } })
  return { approvalRequestId: input.approvalRequestId, taskId: task.id }
}

// ---- the adapter -------------------------------------------------------------------------------------------------------------

/** The request a COUNTER_OFFER is about, with its order's number (null: not one of ours). */
async function counteredRequest(client: Reader, request: Pick<RequestRef, 'id' | 'recordId'>): Promise<{ row: OfficeRequestRow; orderNumber: string } | null> {
  const row = await client.orderChangeRequest.findUnique({ where: { id: request.recordId }, select: OFFICE_REQUEST_COLUMNS })
  if (!row || row.counterApprovalId !== request.id) return null
  const order = await client.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true } })
  return { row, orderNumber: order?.number ?? '' }
}

async function counterRead(client: Reader, recordId: string): Promise<ApprovalRecord | null> {
  const row = await client.orderChangeRequest.findUnique({ where: { id: recordId }, select: { companyId: true, partyId: true, orderId: true } })
  if (!row) return null
  const order = await client.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true } })
  const number = order?.number ?? ''
  // Held: a counter-offer is made only from the customer's request (the generic ask is refused in words). The answer is kept on
  // the order's thread (the customer's own).
  return { companyId: row.companyId, siteId: null, partyId: row.partyId, label: { it: `${number} · controproposta`, en: `${number} · counter-offer` }, held: ASKED_ONLY_FROM_COUNTER, thread: { type: 'SalesOrder', id: row.orderId } }
}

/**
 * The customer's no: the request WITHDRAWN (their words stay on the approval). Their yes: the request stays COUNTERED and waits
 * for the office's accept, which carries it out with the counter. Audit rows and order_change_request.counter_answered either way.
 */
async function counterSettle(tools: CommandTools, request: RequestRef): Promise<Prisma.InputJsonObject | null> {
  const { tx, now } = tools
  const found = await counteredRequest(tx, request)
  if (!found) return null
  await lockRequest(tx, found.row.id)
  const row = (await tx.orderChangeRequest.findUnique({ where: { id: found.row.id }, select: OFFICE_REQUEST_COLUMNS }))!
  if (row.status !== 'COUNTERED' || row.counterApprovalId !== request.id) return null
  const kind = row.kind as OrderRequestKind
  const refused = request.status === 'REFUSED'
  if (refused) {
    await tx.orderChangeRequest.update({ where: { id: row.id }, data: { status: 'WITHDRAWN', withdrawnAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: DECLINED_ACTION, recordType: 'OrderChangeRequest', recordId: row.id, companyId: row.companyId, before: { status: 'COUNTERED' }, after: { status: 'WITHDRAWN', approvalRequestId: request.id } })
  } else {
    tools.audit({ action: AGREED_ACTION, recordType: 'OrderChangeRequest', recordId: row.id, companyId: row.companyId, after: { status: 'COUNTERED', approvalRequestId: request.id, carriedOutBy: 'ACCEPT' } })
  }
  tools.audit({ action: refused ? 'orders.changeRequestCounterDeclined' : 'orders.changeRequestCounterAgreed', recordType: 'SalesOrder', recordId: row.orderId, companyId: row.companyId, after: { requestId: row.id, kind, approvalRequestId: request.id } })
  tools.emit({ type: 'order_change_request.counter_answered', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, orderId: row.orderId, partyId: row.partyId, kind, answer: refused ? 'REFUSED' : 'ACCEPTED' } })
  return refused ? { withdrawn: true, requestId: row.id } : { agreed: true, requestId: row.id }
}

/**
 * The adapter of record type OrderChangeRequest (platform/approvals-out/records.ts): only COUNTER_OFFER, a kind only the counter
 * command asks (`kinds` is empty: "Ask for approval" offers nothing on a request).
 */
export const COUNTER_OFFER_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: COUNTER_OFFER_RECORD,
  kinds: Object.freeze([]),
  commandKinds: Object.freeze(['COUNTER_OFFER' as const]),
  view: ORDERS_VIEW,
  ask: ORDERS_MANAGE,
  read: (client, recordId) => counterRead(client, recordId),
  async fileRecords() {
    return []
  },
  async content(client, request, locale) {
    const found = await counteredRequest(client, request)
    if (!found) return { facts: [], revisedOrder: null }
    const { row, orderNumber } = found
    const facts = counterFactsOf({ kind: row.kind as OrderRequestKind, orderNumber, askedOn: businessDate(row.createdAt), requestedDate: dayOrNull(row.requestedDate), counter: counterOfRow(row) }, locale)
    return { facts: facts.map((fact) => ({ label: fact.label, value: fact.value })), revisedOrder: null }
  },
  async answerHeld(client, request, locale) {
    const found = await counteredRequest(client, request)
    return found && found.row.status === 'COUNTERED' ? null : counterGoneWords(locale)
  },
  async answererHeld(client, request, who: AnswererFacts, locale) {
    const found = await counteredRequest(client, request)
    return counterAnswererHeld({ priced: found ? counterPriced(counterOfRow(found.row)) : false, via: who.via, seesPrices: who.seesPrices }, locale)
  },
  settle: (tools, request) => counterSettle(tools, request),
})

// ── B-PR-27b: the date an accept carries out ─────────────────────────────────────────────────────────────────────────────────────
/** The date a request carries out: the one asked, or our counter's when the customer agreed it (factory-domain acceptedWithCounter). */
export const agreedDateOf = (row: OfficeRequestRow): BusinessDate | null =>
  row.status === 'COUNTERED' ? acceptedWithCounter({ requestedDate: dayOrNull(row.requestedDate) }, counterOfRow(row)).date : dayOrNull(row.requestedDate)
// ── end B-PR-27b ──

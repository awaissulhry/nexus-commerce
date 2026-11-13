import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import type { SendCheck } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SEND, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { decisionWordsOf, OVERRIDE_REFUSALS, overrideReasonOf, type GateAnswer } from '@nexus/factory-domain/purchasing/qualification/gate'
import { PURCHASING_COMPLIANCE_OVERRIDE } from '@nexus/factory-domain/purchasing/qualification/permissions'
import { events as qualificationEvents } from '@nexus/factory-domain/supplier-qualification/events'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { actorOf } from '../../../core/context'
import type { FastifyRequest } from 'fastify'
import { officeSessionOf } from '../../../platform/auth/sessions/authenticator'
// B-W2b-377: the override is a PURCHASE_ORDER_COMPLIANCE request of the approval engine.
import { askComplianceYes, decideComplianceYes, isTaskApprover, withdrawComplianceYes } from '../compliance-override/requests'
import { APPROVAL_REFUSALS } from '@nexus/factory-domain/approvals/rules'
import { officeContextOf, officeOrder, readOrder, type OrderRow, type Reader } from '../store'
import { ASK_ACTION, gateAnswerOf, lockOrder, namesOf, todayOf, type OverrideRequest } from './store'

/**
 * The compliance gate on a purchase order (B-W2b-315; SCM-022; domain purchasing/qualification/gate): what holds an order at
 * its Send, and the override with a reason and a second person's yes.
 *
 *   send.ts (B-W1-30's send)      `complianceChecksOf` adds the gate's checks to the send check (the Send dialog's "documents
 *                                 valid"), `assertCompliant` refuses a held send before anything is made and again in the
 *                                 send's command
 *   GET  /purchasing/orders/:id/compliance             what each line needs and has, the held marks, the request
 *   POST /purchasing/orders/:id/compliance-override    "Send without a valid document?": the reason (purchasing.send)
 *   POST …/compliance-override/decide                  yes (step-up) or no with words, by a second person
 *                                                      (purchasing.compliance.override; never the one who asked, the Owner
 *                                                      included: the database refuses it too)
 *   POST …/compliance-override/withdraw                the one who asked takes it back
 *   GET  /purchasing/compliance-overrides              the requests waiting for a yes (the decider's list)
 *
 * B-W2b-377: the request is a PURCHASE_ORDER_COMPLIANCE request of the approval engine (../compliance-override): listed in
 * Home › Approvals, decided there or here by its approver (a rule's, else the office role that decides overrides), never by
 * who asked. Requests asked before it (domain lines of the engine on the PurchaseOrder) are still read. What a request covers
 * (the fingerprint of what held the order) is on its ask's audit row. The order's own version does not move (a pending
 * purchase-order approval of B-W2b-305 stays current).
 */

const [, , , , , , askedEvent] = qualificationEvents

const OVERRIDABLE: readonly string[] = ['DRAFT', 'PENDING_APPROVAL']

/** The send's checks with the gate's (B-W1-30's are first; ready only when none of either blocks). */
export function withCompliance(checks: { readonly ready: boolean; readonly checks: readonly SendCheck[] }, gate: GateAnswer): { ready: boolean; checks: SendCheck[] } {
  const all = [...checks.checks, ...gate.checks] as SendCheck[]
  return { ready: checks.ready && gate.ready, checks: all }
}

/** The gate's answer for the send check (in the reader's scope). */
export async function complianceChecksOf(db: Reader, order: Pick<OrderRow, 'id' | 'partyId' | 'companyId'>, today: string): Promise<GateAnswer> {
  return (await gateAnswerOf(db, order, today)).answer
}

const heldRefusal = (gate: GateAnswer): DomainError => {
  const blocking = gate.checks.filter((check) => check.severity === 'BLOCKS')
  return new DomainError('conflict', `The order cannot be sent yet. ${blocking.map((check) => check.message).join(' ')}`, blocking.map((check): Issue => ({ path: check.path, message: check.message })))
}

/** Refuses a send the gate holds (409 in words, each held line named); answers the gate's warnings. */
export async function assertCompliant(db: Reader, order: Pick<OrderRow, 'id' | 'partyId' | 'companyId'>, today: string): Promise<GateAnswer> {
  const gate = await complianceChecksOf(db, order, today)
  if (!gate.ready) throw heldRefusal(gate)
  return gate
}

function requestView(request: OverrideRequest | undefined, gate: GateAnswer, names: ReadonlyMap<string, string>, me: string) {
  if (!request) return null
  const state: 'WAITING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' = request.decision === null ? 'WAITING' : request.decision.action
  return {
    lineId: request.lineId,
    // B-W2b-377: the engine's request (Home › Approvals `?open=<taskId>`), null for one asked before it.
    taskId: request.taskId,
    state,
    reason: request.reason,
    askedBy: { id: request.askedById, name: names.get(request.askedById) ?? null, me: request.askedById === me },
    askedAt: toUtcIso(request.askedAt),
    decidedBy: request.decision?.byId ? { id: request.decision.byId, name: names.get(request.decision.byId) ?? null } : null,
    decidedAt: request.decision ? toUtcIso(request.decision.at) : null,
    words: request.decision?.words ?? null,
    /** Whether it covers exactly what holds the order now (a new line or another missing document needs a new request). */
    current: request.fingerprint !== null && request.fingerprint === gate.fingerprint,
  }
}

/** The order as the gate shows it to the person: its requirements, held marks, checks and request, and what they may do. */
async function complianceView(caller: CommandCaller, order: OrderRow) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { answer, requests, names } = await caller.withClient((client) => gateAnswerOf(client, order, todayOf(serverClock.now())))
  const newest = requests[0]
  const waiting = newest?.decision === null
  const place = { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId }
  const mayAsk = can(actor, PURCHASING_SEND, place) && OVERRIDABLE.includes(order.status) && answer.blocks.length > 0 && !answer.overridden && !(waiting && newest?.fingerprint === answer.fingerprint)
  // B-W2b-377: an engine request is decided by its approver (a rule's, or the role that decides overrides) only.
  const notApprover = waiting === true && newest!.taskId !== null && !(await caller.withClient((client) => isTaskApprover(client, newest!.taskId!, context.actorId, serverClock.now())))
  const mayDecide = can(actor, PURCHASING_COMPLIANCE_OVERRIDE, place) && waiting === true && newest!.askedById !== context.actorId && !notApprover
  return {
    order: { id: order.id, number: order.number, status: order.status, partyId: order.partyId, version: order.version },
    requirements: answer.requirements.map((entry) => ({ ...entry, lineIds: [...entry.lineIds], seqs: [...entry.seqs], itemIds: [...entry.itemIds], itemCodes: [...entry.itemCodes] })),
    lines: answer.lines.map((entry) => ({ ...entry, kinds: [...entry.kinds], words: [...entry.words] })),
    checks: answer.checks.map((check) => ({ ...check })),
    ready: answer.ready,
    overridden: answer.overridden,
    notChecked: answer.notChecked,
    request: requestView(newest, answer, names, context.actorId),
    may: { ask: mayAsk, decide: mayDecide, withdraw: waiting === true && newest!.askedById === context.actorId },
    heldWhy: {
      decide: !waiting ? OVERRIDE_REFUSALS.notWaiting : newest!.askedById === context.actorId ? OVERRIDE_REFUSALS.own : !can(actor, PURCHASING_COMPLIANCE_OVERRIDE, place) ? 'You need purchasing.compliance.override.' : notApprover ? APPROVAL_REFUSALS.NOT_APPROVER : null,
    },
  }
}

/** The order a decider may see: purchasing.view, or the override permission over its place (a quality person). */
async function decidableOrder(caller: CommandCaller, orderId: string): Promise<OrderRow> {
  const context = officeContextOf(caller)
  const order = await caller.withClient((client) => readOrder(client, orderId))
  if (!order) throw new NotFoundError('Purchase order not found.')
  const place = { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId }
  if (!can(actorOf(context), PURCHASING_VIEW, place) && !can(actorOf(context), PURCHASING_COMPLIANCE_OVERRIDE, place)) throw new NotFoundError('Purchase order not found.')
  return order
}

/** GET /purchasing/orders/:purchaseOrderId/compliance (purchasing.view, or the override permission over the order). */
export async function getCompliance(caller: CommandCaller, orderId: string) {
  return complianceView(caller, await decidableOrder(caller, orderId))
}

const party = (order: OrderRow) => ({ purchaseOrderId: order.id, number: order.number, partyId: order.partyId })

/** POST /purchasing/orders/:purchaseOrderId/compliance-override (purchasing.send): asked of a second person, with why. */
export async function askOverride(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await officeOrder(caller, orderId, PURCHASING_SEND)
  const reason = overrideReasonOf(body.reason)
  if ('issue' in reason) throw new ValidationError(reason.issue.message, [reason.issue])
  await command(caller, { name: 'purchasing.compliance.overrideAsk', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    await lockOrder(tools.tx, seen.id)
    const order = (await readOrder(tools.tx, seen.id))!
    if (order.version !== body.version) throw new DomainError('conflict', 'The order changed since you read it: reload it.', [{ path: 'body/version', message: `The order is at version ${order.version}.` }])
    if (!OVERRIDABLE.includes(order.status)) throw new DomainError('conflict', OVERRIDE_REFUSALS.notDraft, [{ path: 'status', message: OVERRIDE_REFUSALS.notDraft }])
    const { answer, requests } = await gateAnswerOf(tools.tx, order, todayOf(tools.now))
    if (answer.blocks.length === 0 || answer.overridden) throw new DomainError('conflict', OVERRIDE_REFUSALS.nothingHeld, [{ path: 'compliance', message: OVERRIDE_REFUSALS.nothingHeld }])
    const newest = requests[0]
    if (newest && newest.decision === null && newest.fingerprint === answer.fingerprint) throw new DomainError('conflict', OVERRIDE_REFUSALS.waiting, [{ path: 'compliance/override', message: OVERRIDE_REFUSALS.waiting }])
    // B-W2b-377: a PURCHASE_ORDER_COMPLIANCE request of the approval engine (Home › Approvals), not a domain line.
    const taskId = await askComplianceYes(tools, order, context.actorId, reason.reason)
    tools.audit({
      action: ASK_ACTION,
      recordType: 'PurchaseOrder',
      recordId: order.id,
      companyId: order.companyId,
      siteId: order.siteId,
      after: { taskId, fingerprint: answer.fingerprint, reason: reason.reason, held: answer.blocks.map((entry) => ({ kind: entry.kind, seqs: [...entry.seqs], itemCodes: [...entry.itemCodes], ruleId: entry.ruleId, state: entry.state })) },
    })
    tools.emit(eventFor(askedEvent, { subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { ...party(order), held: answer.blocks.length } }))
    return { taskId }
  })
  return getCompliance(caller, orderId)
}

/**
 * POST …/compliance-override/decide (purchasing.compliance.override; a yes needs a fresh step-up): the newest request
 * waiting, decided by someone who did not ask it; a yes only while it covers exactly what holds the order.
 */
export async function decideOverride(caller: CommandCaller, orderId: string, body: { readonly decision: 'APPROVED' | 'REJECTED'; readonly words?: string | null | undefined; readonly reasonCode?: string | undefined }, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await decidableOrder(caller, orderId)
  if (!can(actorOf(context), PURCHASING_COMPLIANCE_OVERRIDE, { companyId: seen.companyId, siteId: seen.siteId, partyId: seen.partyId })) throw new ForbiddenError('Deciding a send without a valid document needs purchasing.compliance.override.')
  const words = decisionWordsOf(body.decision, body.words)
  if ('issue' in words) throw new ValidationError(words.issue.message, [words.issue])
  // B-W2b-377: the engine decides it (never the asker, only its approver, re-read first: what holds the order changed → STALE).
  const stepUpAt = (): Date => {
    stepUp()
    try {
      return officeSessionOf(caller as FastifyRequest).stepUpAt ?? serverClock.now()
    } catch {
      return serverClock.now()
    }
  }
  await decideComplianceYes(caller, orderId, { decision: body.decision, words: words.words, reasonCode: body.reasonCode }, stepUpAt, OVERRIDE_REFUSALS.notWaiting, idempotencyKey)
  return getCompliance(caller, orderId)
}

/** POST …/compliance-override/withdraw (purchasing.send): the one who asked takes the request back. */
export async function withdrawOverride(caller: CommandCaller, orderId: string, idempotencyKey?: string) {
  await officeOrder(caller, orderId, PURCHASING_SEND)
  // B-W2b-377: the engine's withdraw (only who asked: 403 refusal/NOT_REQUESTER).
  await withdrawComplianceYes(caller, orderId, OVERRIDE_REFUSALS.notWaiting, idempotencyKey)
  return getCompliance(caller, orderId)
}

/**
 * GET /purchasing/compliance-overrides (purchasing.compliance.override): the requests waiting for a yes on orders of the
 * places the person decides for, oldest first, each with what holds the order now (no money).
 */
export async function listOverrides(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const asked = await client.approvalEvent.findMany({
      where: { recordType: 'PurchaseOrder', taskId: null, action: 'REQUESTED', ...(query.companyId ? { companyId: query.companyId } : {}) },
      select: { recordId: true },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 500,
    })
    // B-W2b-377: the engine's waiting PURCHASE_ORDER_COMPLIANCE requests (the domain lines above are the ones asked before it).
    const tasks = await client.approvalTask.findMany({ where: { kind: 'PURCHASE_ORDER_COMPLIANCE', status: 'PENDING', ...(query.companyId ? { companyId: query.companyId } : {}) }, select: { recordId: true }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 500 })
    const rows = []
    for (const orderId of [...new Set([...tasks.map((row) => row.recordId), ...asked.map((row) => row.recordId)])]) {
      const order = await readOrder(client, orderId)
      if (!order || !OVERRIDABLE.includes(order.status)) continue
      if (!can(actor, PURCHASING_COMPLIANCE_OVERRIDE, { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId })) continue
      const { answer, requests, names } = await gateAnswerOf(client, order, todayOf(serverClock.now()))
      const newest = requests[0]
      if (!newest || newest.decision !== null) continue
      const supplier = await client.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true, tradeName: true } })
      rows.push({
        order: { id: order.id, number: order.number, status: order.status, partyId: order.partyId },
        supplier: supplier ? { code: supplier.code, name: supplier.tradeName ?? supplier.legalName } : null,
        request: requestView(newest, answer, names, context.actorId)!,
        held: answer.blocks.map((entry) => entry.words),
        mayDecide: newest.askedById !== context.actorId,
      })
      if (rows.length >= 100) break
    }
    rows.sort((a, b) => (a.request.askedAt < b.request.askedAt ? -1 : a.request.askedAt > b.request.askedAt ? 1 : a.order.id < b.order.id ? -1 : 1))
    return { requests: rows }
  })
}

export { namesOf }

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { AnswerOutcome } from '@nexus/factory-domain/purchasing/confirm/answer'
import {
  planPortalAnswer,
  portalDeclineText,
  portalDoneMessage,
  portalLineText,
  portalProposalColumnsOf,
  type PortalAnswerInput,
  type PortalAnswerPlan,
  type PortalAskedLine,
  type PortalDeclineReason,
} from '@nexus/factory-domain/purchasing/portal-orders/answer'
import { portalAnswerProblem } from '@nexus/factory-domain/purchasing/portal-orders/views'
import type { CommandTools } from '../../../core/command'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { dayOf, dayValue, quantityText } from '../store'
import { choiceIdsOf, heldLines, heldOrder, mayAnswer, portalOrder } from './read'
import { closeConfirmTasks } from './tasks'
import { confirmScheduleAsAsked } from '../po-depth/hooks'

/**
 * The supplier answers a purchase order in the portal (B-W2b-174; SCM-085, SCM-086; design portal.supplier.orders ›
 * Confirm or propose; Owner answer P2: the buyer decides on every change). The person needs the page (portal.purchaseOrders
 * .view, the route's) AND the capability to approve (portal.approve, checked here: B-W2b-162); an office preview never
 * answers. Each answer is ONE command in the session's own scope (factory_partner_runtime: the party's wall, no price,
 * and the …_supply_guards triggers that let a partner session only answer its SENT order) naming the PurchaseOrder with the
 * version the page showed (command()'s record guard: an answer and the office's cancel, change or new link never both
 * commit; the second gets 409 and, read again, the order refuses it in words):
 *
 *   1. the order as the supplier holds it, only while SENT (portalAnswerProblem); its open lines, those an earlier answer
 *      confirmed locked;
 *   2. the answer checked (factory-domain purchasing/portal-orders planPortalAnswer; a substitute only among the articles
 *      the page offered, read before the command in the system scope);
 *   3. the change, as W1's link writes it:
 *        CONFIRMED  each line's confirmation (what was asked), then the order SENT → CONFIRMED with the person's name,
 *                   the supplier's reference and note; purchase_order.confirmed
 *        DECLINED   the order SENT → DECLINED with the reasons in words; purchase_order.declined
 *        PROPOSED   each line's proposal (W1's columns, the substitute and the buyer's yes), the lines as asked confirmed
 *                   at once (design: "Lines answered 'as asked' are confirmed at once; changes wait for the buyer"), then
 *                   the order SENT → CHANGES_PROPOSED with the person's name, reference and note;
 *                   purchase_order.changes_proposed
 *      Since the wave-23 schema (B-W2b-F12/F13a) a portal answer is stored as what it is: a confirmation is channel
 *      PORTAL with the person (confirmedByUserId, no link), a proposal names the person (proposedByUserId) and no link
 *      (proposalLinkId cleared: an earlier link proposal may still be on the row); the buyer's accept (../confirm/
 *      decide.ts) confirms a portal proposal PORTAL by that person. The emailed link stays as it is (it shows the order
 *      answered). The audit row says `via` from the stored channel and who.
 *   4. the CONFIRM_PO request done by the person (./tasks.ts), and the audit row of the whole answer.
 *
 * The worker's handler tells the buyer on the order's thread (../confirm/handler.ts: "in the portal"). The answer is the
 * order again with the end state's words.
 */

export interface PortalConfirmBody extends PortalAnswerInput {
  readonly version: number
}

export interface PortalDeclineBody {
  readonly version: number
  readonly reason: PortalDeclineReason
  readonly note?: string | null | undefined
}

/** The person may answer: the capability, never an office preview (403 in words). */
function assertMayAnswer(request: FastifyRequest, session: PortalSession, order: { readonly companyId: string; readonly partyId: string }): void {
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never answers for the supplier.')
  if (!mayAnswer(request, session, order)) throw new ForbiddenError('Your access lets you read our orders, not answer them: ask your admin for the right to approve.')
}

function assertAnswerable(status: string): void {
  const problem = portalAnswerProblem(status)
  if (problem) throw new InvalidStateError(problem)
}

const linesOfPlan = (plan: PortalAnswerPlan) =>
  plan.lines.map((line) => ({
    lineId: line.lineId,
    seq: line.seq,
    kind: line.kind,
    quantity: line.quantity,
    date: line.date,
    deliveries: line.deliveries.map((part) => ({ ...part })),
    reason: line.reason,
    changes: [...line.changes],
    substitute: line.substitute ? { ...line.substitute } : null,
    needsBuyer: line.needsBuyer,
    confirmedNow: plan.confirmNow.includes(line.lineId),
  }))

type Held = Awaited<ReturnType<typeof heldOrder>>

async function confirmLines(tools: CommandTools, orderId: string, plan: PortalAnswerPlan, ids: readonly string[]): Promise<void> {
  for (const line of plan.lines) {
    if (!ids.includes(line.lineId)) continue
    await tools.tx.purchaseOrderLine.updateMany({
      where: { id: line.lineId, purchaseOrderId: orderId, confirmedQuantity: null },
      data: { confirmedQuantity: line.quantity, confirmedDate: line.date === null ? null : dayValue(line.date), version: { increment: 1 } },
    })
  }
  // B-W2b-296: a line confirmed as asked confirms its deliveries, each on its own day.
  await confirmScheduleAsAsked(tools, orderId, ids)
}

async function writeConfirmation(tools: CommandTools, order: Held, plan: PortalAnswerPlan, person: { id: string; name: string }) {
  await confirmLines(tools, order.id, plan, plan.confirmNow)
  const stored = await tools.tx.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'CONFIRMED', confirmedAt: tools.now, confirmedVia: 'PORTAL', confirmedByUserId: person.id, confirmedByName: person.name, supplierRef: plan.supplierRef, confirmNote: plan.note },
    select: { confirmedVia: true },
  })
  tools.audit({
    action: 'purchasing.portalConfirm',
    recordType: 'PurchaseOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { status: 'SENT' },
    after: { status: 'CONFIRMED', via: stored.confirmedVia, byPartner: true, personId: person.id, byName: person.name, supplierRef: plan.supplierRef, note: plan.note, summary: plan.summary, lines: linesOfPlan(plan) },
  })
  tools.emit({
    type: 'purchase_order.confirmed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { purchaseOrderId: order.id, number: order.number, partyId: order.partyId, channel: 'PORTAL', linkId: null, lines: plan.lines.length, proposalAccepted: false },
  })
}

async function writeProposal(tools: CommandTools, order: Held, plan: PortalAnswerPlan, person: { id: string; name: string }) {
  // The lines first (a partner session writes them only while the order is SENT): the proposals, then the lines as asked.
  for (const line of plan.lines) {
    const columns = portalProposalColumnsOf(line)
    await tools.tx.purchaseOrderLine.updateMany({
      where: { id: line.lineId, purchaseOrderId: order.id },
      data: {
        proposedQuantity: columns.proposedQuantity,
        proposedDate: columns.proposedDate === null ? null : dayValue(columns.proposedDate),
        proposedSplitQuantity: columns.proposedSplitQuantity,
        proposedSplitDate: columns.proposedSplitDate === null ? null : dayValue(columns.proposedSplitDate),
        proposalReason: columns.proposalReason,
        proposedSubstituteItemId: columns.proposedSubstituteItemId,
        proposedSubstituteNote: columns.proposedSubstituteNote,
        proposalNeedsBuyer: columns.proposalNeedsBuyer,
        version: { increment: 1 },
      },
    })
  }
  await confirmLines(tools, order.id, plan, plan.confirmNow)
  await tools.tx.purchaseOrder.update({
    where: { id: order.id },
    // The person, never a link (a proposal names exactly one: an earlier link proposal's link is cleared).
    data: { status: 'CHANGES_PROPOSED', proposedAt: tools.now, proposalLinkId: null, proposedByUserId: person.id, proposedByName: person.name, proposalSupplierRef: plan.supplierRef, proposalNote: plan.note },
    select: { id: true },
  })
  const changed = plan.lines.filter((line) => line.needsBuyer).length
  tools.audit({
    action: 'purchasing.portalPropose',
    recordType: 'PurchaseOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { status: 'SENT' },
    after: { status: 'CHANGES_PROPOSED', via: 'PORTAL', byPartner: true, personId: person.id, byName: person.name, supplierRef: plan.supplierRef, note: plan.note, summary: plan.summary, lines: linesOfPlan(plan) },
  })
  tools.emit({
    type: 'purchase_order.changes_proposed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { purchaseOrderId: order.id, number: order.number, partyId: order.partyId, linkId: null, lines: plan.lines.length, changed },
  })
}

async function writeDecline(tools: CommandTools, order: Held, reasonText: string, person: { id: string; name: string }, details: Record<string, unknown>) {
  await tools.tx.purchaseOrder.update({ where: { id: order.id }, data: { status: 'DECLINED', declinedAt: tools.now, declineReason: reasonText }, select: { id: true } })
  tools.audit({
    action: 'purchasing.portalDecline',
    recordType: 'PurchaseOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    reason: reasonText,
    before: { status: 'SENT' },
    after: { status: 'DECLINED', via: 'PORTAL', byPartner: true, personId: person.id, byName: person.name, ...details },
  })
  tools.emit({ type: 'purchase_order.declined', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, partyId: order.partyId, linkId: null } })
}

const askedOf = (lines: Awaited<ReturnType<typeof heldLines>>): PortalAskedLine[] =>
  lines
    .filter((line) => line.cancelledAt === null && line.closedShortAt === null)
    .map((line) => ({ id: line.id, seq: line.seq, quantity: quantityText(line.quantity), uom: line.uom, needDate: dayOf(line.needDate)!, confirmed: line.confirmedQuantity !== null }))

async function endState(request: FastifyRequest, orderId: string, outcome: AnswerOutcome, summary: string | null, confirmedNow: number) {
  const view = await portalOrder(request, orderId)
  return { ...view, outcome, summary, done: portalDoneMessage(outcome, view.from.buyerName, confirmedNow) }
}

/** POST /portal/purchase-orders/:purchaseOrderId/confirm: confirm all as asked, or answer line by line. */
export async function confirmInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: PortalConfirmBody, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  const person = { id: session.userId, name: session.person.displayName }
  const before = await request.withClient(async (client) => {
    const order = await heldOrder(client, session, orderId)
    return { order, lines: await heldLines(client, order.id) }
  })
  assertMayAnswer(request, session, before.order)
  // The articles the page offered as substitutes (our items: read in the system scope, never their price).
  const choices = body.mode === 'BY_LINE' && (body.lines ?? []).some((line) => line.answer === 'SUBSTITUTE') ? await choiceIdsOf(request, session, before.lines) : new Set<string>()
  const { result } = await commandOn(
    app,
    request,
    { name: 'purchasing.portalConfirm', idempotencyKey, input: { orderId, ...body }, record: { type: 'PurchaseOrder', id: before.order.id, expectedVersion: body.version } },
    async (tools) => {
      const order = await heldOrder(tools.tx, session, before.order.id)
      assertAnswerable(order.status)
      const plan = planPortalAnswer(askedOf(await heldLines(tools.tx, order.id)), body, choices, businessDate(tools.now))
      if (plan.outcome === 'CONFIRMED') await writeConfirmation(tools, order, plan, person)
      else if (plan.outcome === 'DECLINED') await writeDecline(tools, order, plan.declineReason!, person, { answer: 'BY_LINE', summary: plan.summary, lines: linesOfPlan(plan), note: plan.note })
      else await writeProposal(tools, order, plan, person)
      await closeConfirmTasks(tools, order.id, 'DONE', session.userId)
      return { outcome: plan.outcome, summary: plan.summary, confirmedNow: plan.confirmNow.length, at: toUtcIso(tools.now), lines: plan.lines.map((line) => portalLineText(line)) }
    },
  )
  return endState(request, before.order.id, result.outcome, result.summary, result.outcome === 'PROPOSED' ? result.confirmedNow : 0)
}

/** POST /portal/purchase-orders/:purchaseOrderId/decline: the whole order, with a reason. */
export async function declineInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: PortalDeclineBody, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  const person = { id: session.userId, name: session.person.displayName }
  const order = await request.withClient((client) => heldOrder(client, session, orderId))
  assertMayAnswer(request, session, order)
  const reasonText = portalDeclineText(body)
  await commandOn(
    app,
    request,
    { name: 'purchasing.portalDecline', idempotencyKey, input: { orderId, ...body }, record: { type: 'PurchaseOrder', id: order.id, expectedVersion: body.version } },
    async (tools) => {
      const current = await heldOrder(tools.tx, session, order.id)
      assertAnswerable(current.status)
      await writeDecline(tools, current, reasonText, person, { answer: 'DECLINE', reasonCode: body.reason })
      await closeConfirmTasks(tools, current.id, 'DONE', session.userId)
      return { outcome: 'DECLINED' as const }
    },
  )
  return endState(request, order.id, 'DECLINED', null, 0)
}

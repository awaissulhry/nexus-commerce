import type { FastifyRequest } from 'fastify'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { answerProblem, declineText, planAnswer, type AnswerOutcome, type AnswerPlan, type ConfirmInput, type DeclineReason } from '@nexus/factory-domain/purchasing/confirm/answer'
import { doneMessage } from '@nexus/factory-domain/purchasing/confirm/notes'
import { idempotencyKeyFrom, type CommandTools } from '../../../core/command'
import { linkCommand, useLink, type LinkUse } from '../../../platform/links/use'
import { dayValue } from '../store'
import { answerFacts, buyerNameOf, confirmLinkOf, linkView } from './read'
import { recordProposal } from './proposal'

/**
 * The supplier's answer through its PO_CONFIRM link (B-W1-31; SCM-085, SCM-086; design links.po; PLAN §4.7 08-buy).
 * Each answer is ONE link command that names the PurchaseOrder with the version the page showed: command()'s record guard
 * compares and sets the order's version first (it locks the row), so an answer and the office's cancel (or its new link,
 * or a receipt) of the same order never both commit: the second finds a newer version (409), and read again the order
 * refuses it in words. Inside the command, in the link's own scope (factory_partner_runtime):
 *
 *   1. the order and its lines as the supplier sees them; only a SENT order is answered (answerProblem);
 *   2. the answer checked against those lines and what it comes to (factory-domain purchasing/confirm/answer planAnswer);
 *   3. the link used (platform/links useLink: one counted use, the evidence row with the typed name when given, the
 *      server time, the hashed client address and the user agent; an audit row; link.used);
 *   4. the change, which the …_supply_guards triggers hold for a partner session:
 *        CONFIRMED  every line's confirmed quantity and date (= what was asked), written while the order is still SENT,
 *                   then the order SENT → CONFIRMED with confirmedAt, channel LINK, the link, the typed name, the
 *                   supplier's reference and note; purchase_order.confirmed
 *        DECLINED   (the decline, or every line one it cannot deliver) the order SENT → DECLINED with its time and the
 *                   reasons in words; the lines stay unconfirmed (a declined order is changed and sent again);
 *                   purchase_order.declined
 *        PROPOSED   any other mix: recordProposal (./proposal.ts), the buyer decides;
 *   5. the audit row of the answer on the order (the whole answer, line by line, and the evidence id).
 *
 * The answer is the page again (read after the command) with the end state's words. The worker's handler tells the buyer
 * on the order's thread (./handler.ts): a link session writes no message.
 */

export interface ConfirmBody extends ConfirmInput {
  readonly version: number
  readonly typedName?: string | null | undefined
}

export interface DeclineBody {
  readonly version: number
  readonly reason: DeclineReason
  readonly note?: string | null | undefined
  readonly typedName?: string | null | undefined
}

const lineDays = (plan: AnswerPlan) =>
  plan.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, kind: line.kind, quantity: line.quantity, date: line.date, deliveries: line.deliveries.map((part) => ({ ...part })), reason: line.reason, changes: [...line.changes] }))

type Facts = Awaited<ReturnType<typeof answerFacts>>

/** CONFIRMED: the lines first (the trigger lets a partner confirm a line only while its order is SENT), then the order. */
async function writeConfirmation(tools: CommandTools, facts: Facts, plan: AnswerPlan, use: LinkUse, linkId: string) {
  const { tx, now } = tools
  for (const line of plan.lines) {
    await tx.purchaseOrderLine.updateMany({
      where: { id: line.lineId, purchaseOrderId: facts.order.id, confirmedQuantity: null },
      data: { confirmedQuantity: line.quantity, confirmedDate: line.date === null ? null : dayValue(line.date), version: { increment: 1 } },
    })
  }
  await tx.purchaseOrder.update({
    where: { id: facts.order.id },
    data: { status: 'CONFIRMED', confirmedAt: now, confirmedVia: 'LINK', confirmLinkId: linkId, confirmedByName: use.typedName, supplierRef: plan.supplierRef, confirmNote: plan.note },
    select: { id: true },
  })
  tools.audit({
    action: 'purchasing.confirmByLink',
    recordType: 'PurchaseOrder',
    recordId: facts.order.id,
    companyId: facts.order.companyId,
    siteId: facts.order.siteId,
    before: { status: 'SENT' },
    after: { status: 'CONFIRMED', channel: 'LINK', linkId, evidenceId: use.evidenceId, typedName: use.typedName, supplierRef: plan.supplierRef, note: plan.note, summary: plan.summary, lines: lineDays(plan) },
  })
  tools.emit({
    type: 'purchase_order.confirmed',
    subject: facts.order.id,
    companyId: facts.order.companyId,
    siteId: facts.order.siteId,
    payload: { purchaseOrderId: facts.order.id, number: facts.order.number, partyId: facts.order.partyId, channel: 'LINK', linkId, lines: plan.lines.length, proposalAccepted: false },
  })
}

/** DECLINED: the order only (its lines stay unconfirmed: the confirmation of a line is set once, for good). */
async function writeDecline(tools: CommandTools, facts: Facts, reasonText: string, use: LinkUse, linkId: string, details: Record<string, unknown>) {
  await tools.tx.purchaseOrder.update({ where: { id: facts.order.id }, data: { status: 'DECLINED', declinedAt: tools.now, declineReason: reasonText }, select: { id: true } })
  tools.audit({
    action: 'purchasing.declineByLink',
    recordType: 'PurchaseOrder',
    recordId: facts.order.id,
    companyId: facts.order.companyId,
    siteId: facts.order.siteId,
    reason: reasonText,
    before: { status: 'SENT' },
    after: { status: 'DECLINED', linkId, evidenceId: use.evidenceId, typedName: use.typedName, ...details },
  })
  tools.emit({ type: 'purchase_order.declined', subject: facts.order.id, companyId: facts.order.companyId, siteId: facts.order.siteId, payload: { purchaseOrderId: facts.order.id, number: facts.order.number, partyId: facts.order.partyId, linkId } })
}

const assertAnswerable = (status: string): void => {
  const problem = answerProblem(status)
  if (problem) throw new InvalidStateError(problem)
}

async function endState(request: FastifyRequest, outcome: AnswerOutcome, summary: string | null) {
  const link = confirmLinkOf(request)
  return { ...(await linkView(request)), outcome, summary, done: doneMessage(outcome, await buyerNameOf(request, link)) }
}

/** POST /link/purchase-order/confirm (links.confirm): confirm all as asked, or answer line by line. */
export async function confirmByLink(request: FastifyRequest, body: ConfirmBody) {
  const link = confirmLinkOf(request)
  const { result } = await linkCommand(
    request,
    { name: 'purchasing.confirmByLink', idempotencyKey: idempotencyKeyFrom(request), input: body, record: { type: 'PurchaseOrder', id: link.record.id, expectedVersion: body.version } },
    async (tools) => {
      const facts = await answerFacts(tools.tx, link.record.id)
      assertAnswerable(facts.order.status)
      const plan = planAnswer(facts.asked, body, businessDate(tools.now))
      // Every line one the supplier cannot deliver is its decline (the evidence says so).
      const use = await useLink(tools, request, { action: plan.outcome === 'DECLINED' ? 'decline' : 'confirm', typedName: body.typedName })
      if (plan.outcome === 'CONFIRMED') await writeConfirmation(tools, facts, plan, use, link.id)
      else if (plan.outcome === 'DECLINED') await writeDecline(tools, facts, plan.declineReason!, use, link.id, { answer: 'BY_LINE', summary: plan.summary, lines: lineDays(plan), note: plan.note })
      else await recordProposal(tools, { order: facts.order, plan, use, linkId: link.id })
      return { outcome: plan.outcome, summary: plan.summary, at: toUtcIso(tools.now) }
    },
  )
  return endState(request, result.outcome, result.summary)
}

/** POST /link/purchase-order/decline (links.decline): the whole order, with a reason. */
export async function declineByLink(request: FastifyRequest, body: DeclineBody) {
  const link = confirmLinkOf(request)
  await linkCommand(
    request,
    { name: 'purchasing.declineByLink', idempotencyKey: idempotencyKeyFrom(request), input: body, record: { type: 'PurchaseOrder', id: link.record.id, expectedVersion: body.version } },
    async (tools) => {
      const facts = await answerFacts(tools.tx, link.record.id)
      assertAnswerable(facts.order.status)
      const reasonText = declineText(body)
      const use = await useLink(tools, request, { action: 'decline', typedName: body.typedName })
      await writeDecline(tools, facts, reasonText, use, link.id, { answer: 'DECLINE', reasonCode: body.reason })
      return { outcome: 'DECLINED' as const }
    },
  )
  return endState(request, 'DECLINED', null)
}

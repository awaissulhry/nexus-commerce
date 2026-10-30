import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { orderStatusAfter } from '@nexus/factory-domain/inventory/receipts/rules'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { MAX_TEXT, supplierLanguageOf, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { cancelLinesProblems, cancelOrderProblem, closeShortProblems, lineEndMail, mailsSupplier, supplierHolds, type ReachAction } from '@nexus/factory-domain/purchasing/orders/changes'
import { PURCHASING_MANAGE, PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { detailInCommand, onOrder, refreshTotal, reopenPlanLines } from '../orders'
import { lockOrderReceiving } from '../receiving'
import { mayOn, officeContextOf, officeOrder, senderOf, type OrderRow } from '../store'
import type { OrderDetail } from '../views'
import { endLineFactsOf, reachOf, type LineFacts, type Reach } from './reach'

/**
 * Cancel lines and close lines short (B-W2a-52; SCM-059, SCM-060; design purchasing.orders pop "Cancel PO-0093?", record ›
 * Receipts "Close short a line (W2a): the rest will not come; planning releases it"). purchasing.manage, and
 * purchasing.send when the supplier is told (the order is sent: its supplier mail goes now). ONE command on the order
 * with the version the buyer read (a receipt, a send or the supplier's answer that committed meanwhile makes it a 409):
 *
 *   1. the receiving lock after the version bump (a floor receipt cannot move the order's state; an OPEN receipt naming a
 *      line stops it), then the lines' facts: what came (posted receipts), what is at the dock, what an earlier revision
 *      sent (factory-domain purchasing/orders/changes: cancelLinesProblems | closeShortProblems; refusals in words);
 *   2. the reach before (./reach.ts: what is still expected, the plan lines bought, the demand pegged on the lines);
 *   3. the plan lines they bought open again (planning's hook: the plan shows them to buy; the latest plan only);
 *   4. each line ended (cancelledAt | closedShortAt, who, why: the …_supply_w2a_guards trigger keeps it for good);
 *      a draft's total again (a cancelled line is not sent);
 *   5. the order's state from its receipts with the ended lines complete (inventory/receipts orderStatusAfter): a partly
 *      received order whose other lines all came is RECEIVED;
 *   6. the supplier's mail on the order's thread (the worker sends it: no link in it), when it holds the order now;
 *   7. the audit row with the reach, and purchase_order.lines_cancelled | lines_closed_short.
 */

export interface EndBody {
  readonly version: number
  readonly lineIds: readonly string[]
  readonly reason: string
  /** The office's own words for the supplier, after the standard text. */
  readonly message?: string | null | undefined
}

type Kind = 'CANCELLED' | 'CLOSED_SHORT'

const refusal = (problems: readonly string[], path: string): DomainError =>
  new DomainError('conflict', problems.join(' '), problems.map((message): Issue => ({ path, message })))

/** The order's state from its receipts with these lines ended too (an ended line counts as complete). */
function statusAfter(current: OrderRow, facts: readonly LineFacts[], ending: ReadonlySet<string>): PurchaseOrderStatus {
  return orderStatusAfter(
    { status: current.status as PurchaseOrderStatus, confirmed: current.confirmedAt !== null },
    facts.map((line) => ({ expected: line.expectedBase, received: line.receivedBase, tolerancePct: line.tolerancePct, ended: line.cancelled || line.closedShort || ending.has(line.id) })),
  )
}

async function tellSupplier(tools: CommandTools, context: OfficeContext, current: OrderRow, kind: Kind, lines: readonly string[], message: string | null): Promise<string | null> {
  const { tx } = tools
  if (!current.contactId) return null
  const contact = await tx.partyContact.findUnique({ where: { id: current.contactId }, select: { name: true, email: true, language: true, status: true } })
  if (!contact?.email || contact.status !== 'ACTIVE') return null
  const party = await tx.party.findUniqueOrThrow({ where: { id: current.partyId }, select: { language: true } })
  const language = supplierLanguageOf(contact.language, party.language)
  const mail = lineEndMail({ kind, language, number: purchaseOrderDocumentNumber(current.number, current.revision), recipientName: contact.name, lines, message })
  const sent = await sendEmail(tools, { record: { type: 'PurchaseOrder', id: current.id }, sender: await senderOf(tx, context), to: [contact.email], subject: mail.subject, body: mail.body, locale: language })
  return sent.outbound.id
}

async function endLines(caller: CommandCaller, orderId: string, body: EndBody, kind: Kind, idempotencyKey: string | undefined): Promise<{ order: OrderDetail; reach: Reach; supplierTold: boolean }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  const reason = body.reason.trim()
  if (reason === '') throw new ValidationError(kind === 'CANCELLED' ? 'Say why the lines are cancelled.' : 'Say why the rest will not come.', [{ path: 'body/reason', message: 'Required.' }])
  const message = body.message?.trim() ? body.message.trim() : null
  if (message !== null && message.length > MAX_TEXT.message) throw new ValidationError('The message is too long.', [{ path: 'body/message', message: `At most ${MAX_TEXT.message} characters.` }])
  const wanted = [...new Set(body.lineIds)]
  const name = kind === 'CANCELLED' ? 'purchasing.cancelLines' : 'purchasing.closeShort'
  return onOrder(caller, order, { name, idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const { tx, now } = tools
    const from = current.status as PurchaseOrderStatus
    await lockOrderReceiving(tx, context.tenantId, current.id)
    const facts = await endLineFactsOf(tx, current)
    const selected = wanted.map((id) => facts.find((line) => line.id === id))
    if (selected.some((line) => !line)) throw new NotFoundError('Line not found.')
    const lines = selected as LineFacts[]
    const others = facts.filter((line) => !wanted.includes(line.id))
    const problems = kind === 'CANCELLED' ? cancelLinesProblems({ status: from, revision: current.revision }, lines, others) : closeShortProblems({ status: from }, lines)
    if (problems.length > 0) throw refusal(problems, 'body/lineIds')
    const tells = mailsSupplier(from)
    if (tells && !mayOn(context, PURCHASING_SEND, current)) throw new ForbiddenError('The supplier holds this order: telling it of the change needs the right to send purchase orders.')
    const reach = await reachOf(tx, current, lines)
    const reopened = await reopenPlanLines(tools, current.id, wanted)
    const ending = new Set(wanted)
    for (const line of lines) {
      const data = kind === 'CANCELLED' ? { cancelledAt: now, cancelledById: context.actorId, cancelReason: reason } : { closedShortAt: now, closedShortById: context.actorId, closeShortReason: reason }
      await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    }
    if (from === 'DRAFT') await refreshTotal(tools, current.id)
    const to = statusAfter(current, facts, ending)
    if (to !== from) await tx.purchaseOrder.update({ where: { id: current.id }, data: { status: to }, select: { id: true } })
    const outboundId = tells ? await tellSupplier(tools, context, current, kind, lines.map((line) => line.label), message) : null
    tools.audit({
      action: name,
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      reason,
      before: { status: from },
      after: {
        status: to,
        lines: lines.map((line) => ({ lineId: line.id, seq: line.seq, receivedBase: line.receivedBase, outstandingBase: reach.lines.find((row) => row.lineId === line.id)?.outstandingBase ?? '0.0000' })),
        reopenedRequirementIds: reopened,
        workOrders: reach.workOrders.map((row) => row.number),
        salesOrders: reach.salesOrders.map((row) => row.number),
        outboundId,
      },
    })
    const payload = { purchaseOrderId: current.id, number: current.number, lineIds: wanted, from, to, reopenedRequirementIds: reopened, outboundId }
    if (kind === 'CANCELLED') tools.emit({ type: 'purchase_order.lines_cancelled', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload })
    else tools.emit({ type: 'purchase_order.lines_closed_short', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload })
    return { ...(await detailInCommand(tools, current.id)), reach, supplierTold: outboundId !== null }
  })
}

/** POST /purchasing/orders/:purchaseOrderId/lines/cancel: nothing more of these lines is wanted. */
export const cancelLines = (caller: CommandCaller, orderId: string, body: EndBody, idempotencyKey?: string) => endLines(caller, orderId, body, 'CANCELLED', idempotencyKey)

/** POST /purchasing/orders/:purchaseOrderId/lines/close-short: these lines came in part; the rest will not come. */
export const closeShort = (caller: CommandCaller, orderId: string, body: EndBody, idempotencyKey?: string) => endLines(caller, orderId, body, 'CLOSED_SHORT', idempotencyKey)

// ---- the reach before a decision (the dialogs) ------------------------------------------------------------------------------

/**
 * GET /purchasing/orders/:purchaseOrderId/reach?action=&lineIds= (purchasing.view): what the cancel of the order, or the
 * cancel or close short of these lines, would reach, and whether it may be done now (in words; nothing written).
 */
export async function reachOfAction(caller: CommandCaller, orderId: string, query: { readonly action: ReachAction; readonly lineIds?: readonly string[] | undefined }) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const facts = await endLineFactsOf(client, order)
    const status = order.status as PurchaseOrderStatus
    const ids = query.action === 'CANCEL_ORDER' ? facts.filter((line) => !line.cancelled && !line.closedShort).map((line) => line.id) : [...new Set(query.lineIds ?? [])]
    const lines = ids.map((id) => facts.find((line) => line.id === id))
    if (lines.some((line) => !line)) throw new NotFoundError('Line not found.')
    const chosen = lines as LineFacts[]
    const others = facts.filter((line) => !ids.includes(line.id))
    const problems =
      query.action === 'CANCEL_ORDER'
        ? [cancelOrderProblem(status)].filter((problem): problem is string => problem !== null)
        : query.action === 'CANCEL_LINES'
          ? cancelLinesProblems({ status, revision: order.revision }, chosen, others)
          : closeShortProblems({ status }, chosen)
    if (query.action !== 'CANCEL_ORDER' && chosen.length === 0) problems.push('Choose the lines.')
    const tells = query.action === 'CANCEL_ORDER' ? supplierHolds(status, order.revision) : mailsSupplier(status)
    const needs: Permission[] = tells ? [PURCHASING_MANAGE, PURCHASING_SEND] : [PURCHASING_MANAGE]
    const reach = await reachOf(client, order, chosen)
    return {
      action: query.action,
      status,
      allowed: problems.length === 0,
      problems,
      mayDo: needs.every((permission) => mayOn(context, permission, order)),
      supplierTold: tells,
      confirmed: order.confirmedAt !== null && (status === 'CONFIRMED' || status === 'PARTLY_RECEIVED'),
      ...reach,
    }
  })
}

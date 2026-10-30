import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { MAX_TEXT, supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { acceptedConfirmationOf, decisionProblem, proposalAcceptedMail, proposedLineOf, type StoredProposalLine } from '@nexus/factory-domain/purchasing/confirm/proposal'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { sendEmail } from '../../../platform/email-out/outbound'
import { detailInCommand, onOrder } from '../orders'
import { dayOf, dayValue, officeContextOf, officeOrder, quantityText, senderOf } from '../store'

/**
 * The buyer's decision on a supplier's proposed changes (B-W1-31; SCM-086; Owner question P2, answer A: the buyer always
 * decides in W1, automatic acceptance within tolerances is W2b; design plan-buy-pay "Review proposed changes", without the
 * late-order impact, which is W2b). purchasing.send over the order's company, site and supplier (the decision binds the
 * order with the supplier, as its send does). Each is ONE command on the PurchaseOrder with the version the buyer read
 * (the record guard: a second decision, or a cancel, finds a newer version):
 *
 *   accept   CHANGES_PROPOSED → CONFIRMED: every line's confirmation = its proposal (the whole quantity by its last
 *            delivery's date; 0 for a line the supplier cannot deliver), written while the order is CHANGES_PROPOSED; then
 *            the order's confirmation from the proposal (channel LINK, the proposal's link, the typed name, the
 *            supplier's reference and note) and the decision ACCEPTED (who, when). The supplier is told by mail (the
 *            worker sends it; no link in it). purchase_order.confirmed (proposalAccepted).
 *   refuse   CHANGES_PROPOSED → SENT with the decision REFUSED (who, when, the buyer's note for the office). Nothing is
 *            confirmed; the buyer then sends a new link (the supplier answers again, in the office's own words) or cancels
 *            the order (the supplier is told). purchase_order.proposal_refused.
 *
 * The proposal itself stays on the order (the record shows what was accepted or refused); a new proposal replaces it.
 */

export interface AcceptBody {
  readonly version: number
  /** The buyer's own words to the supplier, after the standard text. */
  readonly message?: string | null | undefined
}

export interface RefuseBody {
  readonly version: number
  /** Why the buyer refuses, for the office (the supplier hears from the office's new link or its cancellation). */
  readonly note?: string | null | undefined
}

export const PROPOSAL_LINE_COLUMNS = {
  id: true,
  seq: true,
  quantity: true,
  uom: true,
  needDate: true,
  confirmedQuantity: true,
  proposedQuantity: true,
  proposedDate: true,
  proposedSplitQuantity: true,
  proposedSplitDate: true,
  proposalReason: true,
} as const

export const PROPOSAL_ORDER_COLUMNS = {
  proposedAt: true,
  proposalLinkId: true,
  proposedByName: true,
  proposalSupplierRef: true,
  proposalNote: true,
  proposalDecision: true,
  proposalDecidedAt: true,
  proposalDecidedById: true,
  proposalDecisionNote: true,
} as const

/**
 * The lines with their proposals, as factory-domain purchasing/confirm/proposal reads them. B-W2a-52: the open lines only
 * (a cancelled or closed-short line holds no proposal: the supplier answers the open ones).
 */
export async function proposalLinesOf(db: Pick<CommandTx, 'purchaseOrderLine'>, orderId: string): Promise<StoredProposalLine[]> {
  const rows = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: orderId, cancelledAt: null, closedShortAt: null }, orderBy: { seq: 'asc' }, select: PROPOSAL_LINE_COLUMNS })
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    quantity: quantityText(row.quantity),
    uom: row.uom,
    needDate: dayOf(row.needDate)!,
    proposedQuantity: row.proposedQuantity === null ? null : quantityText(row.proposedQuantity),
    proposedDate: dayOf(row.proposedDate),
    proposedSplitQuantity: row.proposedSplitQuantity === null ? null : quantityText(row.proposedSplitQuantity),
    proposedSplitDate: dayOf(row.proposedSplitDate),
    proposalReason: row.proposalReason,
  }))
}

const assertDecidable = (status: string): void => {
  const problem = decisionProblem(status)
  if (problem) throw new InvalidStateError(problem)
}

/** POST /purchasing/orders/:id/proposal/accept (purchasing.send): the proposal becomes the confirmation. */
export async function acceptProposal(caller: CommandCaller, orderId: string, body: AcceptBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  return onOrder(caller, order, { name: 'purchasing.acceptProposal', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    assertDecidable(current.status)
    const message = body.message?.trim() ? body.message.trim() : null
    if (message !== null && message.length > MAX_TEXT.message) throw new ValidationError('The message is too long.', [{ path: 'body/message', message: `At most ${MAX_TEXT.message} characters.` }])
    const { tx, now } = tools
    const proposal = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: current.id }, select: PROPOSAL_ORDER_COLUMNS })
    const lines = await proposalLinesOf(tx, current.id)
    const accepted = lines.map((line) => {
      const proposed = proposedLineOf(line)
      if (!proposed) throw new InvalidStateError(`Line ${line.seq} holds no proposal: refuse the proposal and send a new link.`)
      return { line, proposed, confirmation: acceptedConfirmationOf(proposed) }
    })
    for (const { line, confirmation } of accepted) {
      await tx.purchaseOrderLine.updateMany({
        where: { id: line.id, purchaseOrderId: current.id, confirmedQuantity: null },
        data: { confirmedQuantity: confirmation.confirmedQuantity, confirmedDate: confirmation.confirmedDate === null ? null : dayValue(confirmation.confirmedDate), version: { increment: 1 } },
      })
    }
    await tx.purchaseOrder.update({
      where: { id: current.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: now,
        confirmedVia: 'LINK',
        confirmLinkId: proposal.proposalLinkId,
        confirmedByName: proposal.proposedByName,
        supplierRef: proposal.proposalSupplierRef,
        confirmNote: proposal.proposalNote,
        proposalDecision: 'ACCEPTED',
        proposalDecidedAt: now,
        proposalDecidedById: context.actorId,
      },
      select: { id: true },
    })
    // The supplier hears of it (the worker sends this mail: it holds no link).
    let outboundId: string | null = null
    const contact = current.contactId ? await tx.partyContact.findUnique({ where: { id: current.contactId }, select: { name: true, email: true, language: true, status: true } }) : null
    if (contact?.email && contact.status === 'ACTIVE') {
      const party = await tx.party.findUniqueOrThrow({ where: { id: current.partyId }, select: { language: true } })
      const language = supplierLanguageOf(contact.language, party.language)
      const mail = proposalAcceptedMail({ language, number: purchaseOrderDocumentNumber(current.number, current.revision), recipientName: contact.name, message })
      outboundId = (await sendEmail(tools, { record: { type: 'PurchaseOrder', id: current.id }, sender: await senderOf(tx, context), to: [contact.email], subject: mail.subject, body: mail.body, locale: language })).outbound.id
    }
    tools.audit({
      action: 'purchasing.acceptProposal',
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { status: 'CHANGES_PROPOSED' },
      after: {
        status: 'CONFIRMED',
        decision: 'ACCEPTED',
        proposedAt: proposal.proposedAt ? toUtcIso(proposal.proposedAt) : null,
        linkId: proposal.proposalLinkId,
        lines: accepted.map(({ line, confirmation }) => ({ lineId: line.id, seq: line.seq, ...confirmation })),
        outboundId,
      },
    })
    tools.emit({
      type: 'purchase_order.confirmed',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { purchaseOrderId: current.id, number: current.number, partyId: current.partyId, channel: 'LINK', linkId: proposal.proposalLinkId, lines: lines.length, proposalAccepted: true },
    })
    return { ...(await detailInCommand(tools, current.id)), supplierTold: outboundId !== null }
  })
}

/** POST /purchasing/orders/:id/proposal/refuse (purchasing.send): back to SENT; nothing is confirmed. */
export async function refuseProposal(caller: CommandCaller, orderId: string, body: RefuseBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  return onOrder(caller, order, { name: 'purchasing.refuseProposal', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    assertDecidable(current.status)
    const note = body.note?.trim() ? body.note.trim() : null
    if (note !== null && note.length > MAX_TEXT.reason) throw new ValidationError('The note is too long.', [{ path: 'body/note', message: `At most ${MAX_TEXT.reason} characters.` }])
    const { tx, now } = tools
    const proposal = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: current.id }, select: PROPOSAL_ORDER_COLUMNS })
    await tx.purchaseOrder.update({
      where: { id: current.id },
      data: { status: 'SENT', proposalDecision: 'REFUSED', proposalDecidedAt: now, proposalDecidedById: context.actorId, proposalDecisionNote: note },
      select: { id: true },
    })
    tools.audit({
      action: 'purchasing.refuseProposal',
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      ...(note ? { reason: note } : {}),
      before: { status: 'CHANGES_PROPOSED' },
      after: { status: 'SENT', decision: 'REFUSED', proposedAt: proposal.proposedAt ? toUtcIso(proposal.proposedAt) : null, linkId: proposal.proposalLinkId },
    })
    tools.emit({ type: 'purchase_order.proposal_refused', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, partyId: current.partyId } })
    return { ...(await detailInCommand(tools, current.id)), next: 'Nothing is confirmed. Send the supplier a new link with your words, or cancel the order: the supplier is told either way.' }
  })
}

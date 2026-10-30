import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { isMarkedJson, markMoney } from '@nexus/factory-domain/money/marked'
import { revisionPricesOf, revisionStateOf, type RevisionLine, type RevisionPrices, type RevisionState } from '@nexus/factory-domain/purchasing/revisions/revisions'
import type { CommandTools } from '../../../core/command'
import { dayOf, decimal, quantityText, type Reader } from '../store'

/**
 * A purchase order's revisions in the database (B-W2a-52; SCM-058; factory-db sourcing.prisma PurchaseOrderRevision,
 * append-only): the order's state as factory-domain purchasing/revisions keeps it (`stateOf`: no price, no internal note;
 * the supplier's answer with it), its prices apart (`pricesOf`, the cost grain), the state kept when the buyer starts the
 * next revision (in the audit row of that change: the answer is cleared from the order and its lines right after, and a
 * revision row is written only at a send), and the revision row of a send (`writeRevisionInCommand`, inside the send's
 * command, once the order is SENT).
 */

/** The audit actions that start a revision: their `after` keeps the state the next revision is compared with. */
export const REVISION_START_ACTIONS = ['purchasing.change', 'purchasing.counterPropose'] as const

export const STATE_ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  number: true,
  status: true,
  revision: true,
  currency: true,
  requestedDate: true,
  incoterms: true,
  paymentTerms: true,
  note: true,
  sentAt: true,
  confirmedAt: true,
  confirmedVia: true,
  confirmedByName: true,
  supplierRef: true,
  declinedAt: true,
  declineReason: true,
  proposedAt: true,
  proposedByName: true,
  proposalSupplierRef: true,
  proposalNote: true,
  proposalDecision: true,
} as const satisfies Prisma.PurchaseOrderSelect

export const STATE_LINE_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  description: true,
  supplierArticleCode: true,
  supplierColourCode: true,
  quantity: true,
  uom: true,
  needDate: true,
  grade: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  oneDyeBatch: true,
  areaTolerancePct: true,
  note: true,
  confirmedQuantity: true,
  confirmedDate: true,
  proposedQuantity: true,
  proposedDate: true,
  proposedSplitQuantity: true,
  proposedSplitDate: true,
  proposalReason: true,
  cancelledAt: true,
  closedShortAt: true,
  unitPrice: true,
  netAmount: true,
} as const satisfies Prisma.PurchaseOrderLineSelect

type StateOrder = Prisma.PurchaseOrderGetPayload<{ select: typeof STATE_ORDER_COLUMNS }>
type StateLine = Prisma.PurchaseOrderLineGetPayload<{ select: typeof STATE_LINE_COLUMNS }>

function lineOf(line: StateLine): RevisionLine {
  const proposed = line.proposedQuantity !== null || line.proposedDate !== null || line.proposalReason !== null
  return {
    id: line.id,
    seq: line.seq,
    itemId: line.itemId,
    itemColourId: line.itemColourId,
    description: line.description,
    supplierArticleCode: line.supplierArticleCode,
    supplierColourCode: line.supplierColourCode,
    quantity: quantityText(line.quantity),
    uom: line.uom,
    needDate: dayOf(line.needDate)!,
    grade: line.grade,
    thicknessMinMm: decimal(line.thicknessMinMm),
    thicknessMaxMm: decimal(line.thicknessMaxMm),
    oneDyeBatch: line.oneDyeBatch,
    areaTolerancePct: decimal(line.areaTolerancePct),
    note: line.note,
    confirmedQuantity: line.confirmedQuantity === null ? null : quantityText(line.confirmedQuantity),
    confirmedDate: dayOf(line.confirmedDate),
    proposal: proposed
      ? {
          quantity: line.proposedQuantity === null ? null : quantityText(line.proposedQuantity),
          date: dayOf(line.proposedDate),
          splitQuantity: line.proposedSplitQuantity === null ? null : quantityText(line.proposedSplitQuantity),
          splitDate: dayOf(line.proposedSplitDate),
          reason: line.proposalReason,
        }
      : null,
    cancelled: line.cancelledAt !== null,
    closedShort: line.closedShortAt !== null,
  }
}

/** The order's state as a revision keeps it (no price; `status` as the caller says it will be, default as it is). */
export function stateOf(order: StateOrder, lines: readonly StateLine[], status: string = order.status): RevisionState {
  return revisionStateOf({
    requestedDate: dayOf(order.requestedDate),
    incoterms: order.incoterms,
    paymentTerms: order.paymentTerms,
    note: order.note,
    status,
    confirmation: order.confirmedAt && order.confirmedVia ? { at: toUtcIso(order.confirmedAt), via: order.confirmedVia, byName: order.confirmedByName, supplierRef: order.supplierRef } : null,
    decline: order.declinedAt ? { at: toUtcIso(order.declinedAt), reason: order.declineReason } : null,
    proposal: order.proposedAt ? { at: toUtcIso(order.proposedAt), byName: order.proposedByName, supplierRef: order.proposalSupplierRef, note: order.proposalNote, decision: order.proposalDecision } : null,
    lines: lines.map(lineOf),
  })
}

/** The prices of the order's open lines (the cost grain). */
export const pricesOf = (order: Pick<StateOrder, 'currency'>, lines: readonly StateLine[]): RevisionPrices =>
  revisionPricesOf(order.currency, lines.map((line) => ({ id: line.id, seq: line.seq, unitPrice: line.unitPrice.toFixed(6), netAmount: line.netAmount, cancelled: line.cancelledAt !== null })))

/** The order and its lines as a revision reads them. */
export async function readState(db: Reader, orderId: string): Promise<{ order: StateOrder; lines: StateLine[] }> {
  const order = await db.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, select: STATE_ORDER_COLUMNS })
  const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: orderId }, orderBy: { seq: 'asc' }, select: STATE_LINE_COLUMNS })
  return { order, lines }
}

/** The state (and prices) the buyer's change into `revision` kept, from the audit row of that change; null when none is. */
export async function keptStateOf(db: Reader, orderId: string, revision: number): Promise<{ state: RevisionState; prices: RevisionPrices | null } | null> {
  const rows = await db.auditLog.findMany({
    where: { recordType: 'PurchaseOrder', recordId: orderId, action: { in: [...REVISION_START_ACTIONS] } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: 20,
    select: { after: true },
  })
  for (const row of rows) {
    const after = row.after as { revision?: unknown; kept?: unknown; keptPrices?: unknown } | null
    if (after?.revision !== revision || !after.kept || typeof after.kept !== 'object') continue
    const prices = isMarkedJson(after.keptPrices) ? (after.keptPrices.value as RevisionPrices) : null
    return { state: after.kept as RevisionState, prices }
  }
  return null
}

/** What the audit row of a change keeps: the state with its answer, and its prices marked as costs. */
export const keptForAudit = (state: RevisionState, prices: RevisionPrices) => ({ kept: state, keptPrices: markMoney('cost', prices) })

/** The previous revision's row (its state as sent), when there is one. */
export async function revisionRowOf(db: Reader, orderId: string, revision: number) {
  return db.purchaseOrderRevision.findFirst({
    where: { purchaseOrderId: orderId, revision },
    select: { id: true, revision: true, sentAt: true, after: true, afterPrices: true, documentFileId: true },
  })
}

/** What revision N is compared with: the state kept at the change into it, else the previous revision as sent; null for revision 1. */
export async function previousOf(db: Reader, orderId: string, revision: number): Promise<{ state: RevisionState; prices: RevisionPrices } | null> {
  if (revision <= 1) return null
  const kept = await keptStateOf(db, orderId, revision)
  const row = await revisionRowOf(db, orderId, revision - 1)
  const rowPrices = row ? (row.afterPrices as unknown as RevisionPrices) : null
  if (kept) return { state: kept.state, prices: kept.prices ?? rowPrices ?? { currency: '', netAmount: 0, lines: [] } }
  if (row) return { state: row.after as unknown as RevisionState, prices: rowPrices! }
  return null
}

/**
 * Inside the send's command, once the order is SENT: the revision row of this send (its number, when and by whom, the
 * state as sent and the state it replaces, both prices, the buyer's change note, the PDF). Returns the row's id.
 */
export async function writeRevisionInCommand(tools: CommandTools, input: { readonly orderId: string; readonly documentFileId: string; readonly changeNote: string | null; readonly sentById: string | null }): Promise<{ id: string; revision: number }> {
  const { tx } = tools
  const { order, lines } = await readState(tx, input.orderId)
  const previous = await previousOf(tx, order.id, order.revision)
  const id = newId()
  await tx.purchaseOrderRevision.create({
    data: {
      id,
      purchaseOrderId: order.id,
      partyId: order.partyId,
      siteId: order.siteId,
      revision: order.revision,
      sentAt: order.sentAt ?? tools.now,
      sentById: input.sentById,
      before: previous ? (previous.state as unknown as Prisma.InputJsonValue) : undefined,
      after: stateOf(order, lines) as unknown as Prisma.InputJsonValue,
      beforePrices: previous ? (previous.prices as unknown as Prisma.InputJsonValue) : undefined,
      afterPrices: pricesOf(order, lines) as unknown as Prisma.InputJsonValue,
      changeNote: order.revision > 1 && input.changeNote?.trim() ? input.changeNote.trim() : null,
      documentFileId: input.documentFileId,
      createdById: input.sentById,
    },
    select: { id: true },
  })
  return { id, revision: order.revision }
}

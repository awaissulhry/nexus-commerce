import type { Prisma } from '@nexus/factory-db'
import type { Facts } from '@nexus/factory-domain/approvals/rules'
import { amendmentDiff, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments'
import { furthestStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import { salesOrderChangeChanges, salesOrderChangeFacts, type PricedPart } from '@nexus/factory-domain/sales/order-changes/priced'
import type { CommandTools } from '../../../core/command'
import type { ApprovalSubject, TaskRef } from '../../../platform/approvals/kinds/kind'
import type { Reader } from '../orders/store'
import { readStages, stageOfLine } from './stages'

/**
 * The yes after an edit (B-W2b-309; SAL-190 "re-approval after editing an approved order"): the SALES_ORDER_CHANGE kind's
 * subject is the order (recordType SalesOrder, the database's rule for SalesOrderAmendment.reapprovalTaskId), about its
 * latest change. The yes is kept on the order (audit, event); a no leaves the change written and the order says so — "Put
 * back" (./changes.ts) writes the order as it was, by a person. Nobody approves their own request (the engine), the Owner
 * included.
 *
 * B-OP-010 (order page plan N2, decision D2; review R-3): an office change applies at once — no change asks this yes any more
 * (the amendment, the priced change and the accepted request write `reapprovalTaskId` null). The kind stays registered for the
 * requests asked before: one still PENDING is read here (the order's latest amendment: the fingerprint covers its revision,
 * lines old → new, money, priced parts, fee and extra deposit, so a newer change makes it STALE), still holds the order's next
 * change until it is decided or taken back in place (./apply.ts), and its yes or no is kept on the order.
 */

/** A change as the kind reads it: the amendment's own columns. */
export interface ChangeFacts {
  readonly amendmentId: string
  readonly revision: number
  readonly reason: string
  readonly before: OrderSnapshot
  readonly after: OrderSnapshot
  readonly netAmountBefore: number
  readonly netAmountAfter: number
  readonly grossAmountBefore: number
  readonly grossAmountAfter: number
  readonly priceDeltaLines: readonly PricedPart[] | null
  readonly feeAmount: number | null
  readonly depositRequestId: string | null
}

export const AMENDMENT_CHANGE_COLUMNS = {
  id: true,
  revision: true,
  reason: true,
  before: true,
  after: true,
  netAmountBefore: true,
  netAmountAfter: true,
  grossAmountBefore: true,
  grossAmountAfter: true,
  priceDeltaLines: true,
  feeAmount: true,
  depositRequestId: true,
  reapprovalTaskId: true,
  reacceptanceNeeded: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SalesOrderAmendmentSelect
export type AmendmentChangeRow = Prisma.SalesOrderAmendmentGetPayload<{ select: typeof AMENDMENT_CHANGE_COLUMNS }>

export const changeFactsOf = (row: AmendmentChangeRow): ChangeFacts => ({
  amendmentId: row.id,
  revision: row.revision,
  reason: row.reason,
  before: row.before as unknown as OrderSnapshot,
  after: row.after as unknown as OrderSnapshot,
  netAmountBefore: row.netAmountBefore,
  netAmountAfter: row.netAmountAfter,
  grossAmountBefore: row.grossAmountBefore,
  grossAmountAfter: row.grossAmountAfter,
  priceDeltaLines: (row.priceDeltaLines as unknown as PricedPart[] | null) ?? null,
  feeAmount: row.feeAmount,
  depositRequestId: row.depositRequestId,
})

/** The order's latest change (its newest amendment), or null. */
async function latestChange(db: Reader, orderId: string): Promise<ChangeFacts | null> {
  const row = await db.salesOrderAmendment.findFirst({ where: { orderId }, orderBy: { revision: 'desc' }, select: AMENDMENT_CHANGE_COLUMNS })
  return row ? changeFactsOf(row) : null
}

const ORDER_COLUMNS = { id: true, number: true, status: true, companyId: true, partyId: true, currency: true } as const

/** The facts of a change on its order (the request's read): the furthest production stage of a changed line read now. */
async function changeFactsFor(db: Reader, order: { readonly id: string; readonly partyId: string; readonly currency: string }, change: ChangeFacts): Promise<Facts> {
  const diff = amendmentDiff(change.before, change.after)
  const changed = diff.lines.filter((line) => line.change !== 'ADDED').map((line) => line.lineId)
  const stages = await readStages(db, changed)
  const stage = furthestStage(changed.map((lineId) => stageOfLine(stages, lineId).stage))
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true } })
  const approved = await db.approvalTask.findFirst({ where: { kind: 'SALES_ORDER', recordType: 'SalesOrder', recordId: order.id, status: 'APPROVED' }, select: { id: true } })
  return salesOrderChangeFacts({
    currency: order.currency,
    netBefore: change.netAmountBefore,
    netAfter: change.netAmountAfter,
    feeAmount: change.feeAmount,
    lines: diff.lines,
    priced: change.priceDeltaLines !== null || change.feeAmount !== null,
    stage,
    customerCode: party?.code ?? null,
    wasApproved: approved !== null,
  })
}

/** The kind's read (platform/approvals/kinds/sales-order-change.ts). */
export async function readChangeSubject(db: Reader, orderId: string): Promise<ApprovalSubject | null> {
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_COLUMNS })
  if (!order) return null
  const change = await latestChange(db, orderId)
  const customer = (await db.party.findUnique({ where: { id: order.partyId }, select: { legalName: true } }))?.legalName ?? 'customer'
  if (!change) {
    return { companyId: order.companyId, siteId: null, label: `${order.number} · ${customer}`, summary: `${order.number} for ${customer}: not changed since it was confirmed`, facts: {}, snapshot: { orderId, revision: 0 }, changes: [], held: `${order.number} was not changed since it was confirmed: nothing to say yes to.` }
  }
  const diff = amendmentDiff(change.before, change.after)
  const pieces = diff.lines.reduce((sum, line) => sum + line.piecesAfter - line.piecesBefore, 0)
  const lines = diff.lines.length === 1 ? '1 line' : `${diff.lines.length} lines`
  const priced = change.priceDeltaLines !== null || change.feeAmount !== null
  const held = order.status === 'CLOSED' || order.status === 'CANCELLED' ? `${order.number} is ${order.status.toLowerCase()}: its changes need no yes any more.` : null
  return {
    companyId: order.companyId,
    siteId: null,
    label: `${order.number} · revision ${change.revision}`,
    summary: `${order.number} for ${customer}: revision ${change.revision} changed ${lines} (${pieces >= 0 ? '+' : ''}${pieces} pieces)${priced ? ', priced' : ''}, asks a yes again`.slice(0, 500),
    facts: await changeFactsFor(db, order, change),
    snapshot: {
      orderId,
      amendmentId: change.amendmentId,
      revision: change.revision,
      netAmountBefore: change.netAmountBefore,
      netAmountAfter: change.netAmountAfter,
      grossAmountAfter: change.grossAmountAfter,
      priceDeltaLines: change.priceDeltaLines,
      feeAmount: change.feeAmount,
      depositRequestId: change.depositRequestId,
      lines: change.after.lines.map((line) => ({ id: line.id, unitPrice: line.unitPrice, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice })) })),
    },
    changes: salesOrderChangeChanges({ revision: change.revision, netBefore: change.netAmountBefore, netAfter: change.netAmountAfter, feeAmount: change.feeAmount }),
    held,
  }
}

/** The request asked before B-OP-010 still waiting on the order, if any: it holds the next change until it is decided. */
export const pendingChangeYes = (db: Reader, orderId: string) => db.approvalTask.findFirst({ where: { kind: 'SALES_ORDER_CHANGE', recordType: 'SalesOrder', recordId: orderId, status: 'PENDING' }, select: { id: true, requestedAt: true } })

async function decided(tools: CommandTools, task: TaskRef, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const order = await tools.tx.salesOrder.findUnique({ where: { id: task.recordId }, select: { id: true, number: true, companyId: true, /* B-SA-001 */ partyId: true } })
  if (!order) return
  const change = await tools.tx.salesOrderAmendment.findFirst({ where: { orderId: order.id }, orderBy: { revision: 'desc' }, select: { id: true, revision: true } })
  const row = decision === 'REJECTED' ? await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { rejectReason: true } }) : null
  tools.audit({
    action: decision === 'APPROVED' ? 'orders.changeApproved' : 'orders.changeTurnedDown',
    recordType: 'SalesOrder',
    recordId: order.id,
    companyId: order.companyId,
    after: { taskId: task.id, amendmentId: change?.id ?? null, revision: change?.revision ?? null, decidedById: task.decidedById, ...(row ? { reason: row.rejectReason, putBack: 'POST /sales/orders/:orderId/changes/:amendmentId/put-back' } : {}) },
  })
  tools.emit({ type: 'sales_order.change_decided', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, amendmentId: change?.id ?? null, revision: change?.revision ?? null, taskId: task.id, decision, partyId: order.partyId /* B-SA-001 */ } })
}

/** The yes (onApproved), in the approver's command: kept on the order. */
export const changeApprovedInCommand = (tools: CommandTools, task: TaskRef): Promise<void> => decided(tools, task, 'APPROVED')
/** The no (onRejected): the change stays written; the order says so, and a person puts it back (./put-back.ts). */
export const changeRejectedInCommand = (tools: CommandTools, task: TaskRef): Promise<void> => decided(tools, task, 'REJECTED')

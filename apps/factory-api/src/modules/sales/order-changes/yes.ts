import type { Prisma } from '@nexus/factory-db'
import { chooseRules, type Facts } from '@nexus/factory-domain/approvals/rules'
import { amendmentDiff, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments'
import { furthestStage, type OrderFreezeStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import { SALES_ORDER_CHANGE_FIELDS, salesOrderChangeChanges, salesOrderChangeFacts, type PricedPart } from '@nexus/factory-domain/sales/order-changes/priced'
import type { CommandTools } from '../../../core/command'
import { askApproval } from '../../../platform/approvals/engine'
import type { ApprovalSubject, TaskRef } from '../../../platform/approvals/kinds/kind'
import type { Reader } from '../orders/store'
import { readStages, stageOfLine } from './stages'

/**
 * The new yes after an edit (B-W2b-309; SAL-190 "re-approval after editing an approved order"): the SALES_ORDER_CHANGE kind's
 * subject is the order (recordType SalesOrder, the database's rule for SalesOrderAmendment.reapprovalTaskId), about its
 * latest change. The change is written as the amendment it is (W2a's, append-only); in the same command, when one of the
 * company's SALES_ORDER_CHANGE rules holds on its facts, the yes is asked and the amendment names the request. While it waits
 * no other change of the order is taken (one change at a time); the yes is kept on the order (audit, event); a no leaves the
 * change written and the order says so — "Put back" (./put-back.ts) writes the order as it was, by a person. No rule: nothing
 * is asked, the change goes on as today. Nobody approves their own request (the engine), the Owner included.
 *
 * The request is asked BEFORE the amendment row exists (the row names the request, and is never changed after): the change
 * about to be written is handed to the kind's read for that one command (`withPendingChange`), as B-W2b-341's
 * CREDIT_WITHOUT_RETURN does. Afterwards the read takes the order's latest amendment: the fingerprint covers the change (its
 * revision, lines old → new, money, priced parts, fee and extra deposit), so a newer change makes the request STALE.
 */

/** A change as the kind reads it: the amendment's own columns (stored, or about to be written). */
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
  /** The furthest stage of a changed line when it was written (null: not in production); read again when unknown. */
  readonly stage?: OrderFreezeStage | null
}

const PENDING = new Map<string, ChangeFacts>()

/** The change about to be written, for the kind's read inside the amendment's command (the row does not exist yet). */
export async function withPendingChange<Result>(orderId: string, change: ChangeFacts, work: () => Promise<Result>): Promise<Result> {
  PENDING.set(orderId, change)
  try {
    return await work()
  } finally {
    PENDING.delete(orderId)
  }
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

/** The order's latest change (the one being written in this command, else the newest amendment), or null. */
export async function latestChange(db: Reader, orderId: string): Promise<ChangeFacts | null> {
  const pending = PENDING.get(orderId)
  if (pending) return pending
  const row = await db.salesOrderAmendment.findFirst({ where: { orderId }, orderBy: { revision: 'desc' }, select: AMENDMENT_CHANGE_COLUMNS })
  return row ? changeFactsOf(row) : null
}

const ORDER_COLUMNS = { id: true, number: true, status: true, companyId: true, partyId: true, currency: true } as const

/** The facts of a change on its order (the rule's test at the ask, the request's read after). */
export async function changeFactsFor(db: Reader, order: { readonly id: string; readonly partyId: string; readonly currency: string }, change: ChangeFacts): Promise<Facts> {
  const diff = amendmentDiff(change.before, change.after)
  let stage = change.stage
  if (stage === undefined) {
    const changed = diff.lines.filter((line) => line.change !== 'ADDED').map((line) => line.lineId)
    const stages = await readStages(db, changed)
    stage = furthestStage(changed.map((lineId) => stageOfLine(stages, lineId).stage))
  }
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

const RULE_COLUMNS = { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true } as const

const officeActor = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export type ChangeYes = { readonly taskId: string } | { readonly taskId: null; readonly held: 'NO_RULE' | 'NOBODY_TO_ASK' }

/**
 * Inside the amendment's command, before its row: the company's SALES_ORDER_CHANGE rules on the change's facts; when one
 * holds and someone other than the person changing may decide, the request (asked by that person). No rule: nothing asked.
 * A rule that holds with nobody else to decide: nothing asked now (another office person asks from Home › Approvals).
 */
export async function askChangeYes(tools: CommandTools, order: { readonly id: string; readonly companyId: string; readonly partyId: string; readonly currency: string }, change: ChangeFacts): Promise<ChangeYes> {
  const rules = await tools.tx.approvalRule.findMany({ where: { kind: 'SALES_ORDER_CHANGE', active: true, OR: [{ companyId: null }, { companyId: order.companyId }] }, select: RULE_COLUMNS })
  if (rules.length === 0) return { taskId: null, held: 'NO_RULE' }
  const requesterId = officeActor(tools)
  const facts = await changeFactsFor(tools.tx, order, change)
  const choice = chooseRules(rules, { companyId: order.companyId, facts, askers: requesterId ? [requesterId] : [] }, SALES_ORDER_CHANGE_FIELDS, tools.now)
  if (choice.matched.length === 0) return { taskId: null, held: 'NO_RULE' }
  if (choice.deciding === null || requesterId === null) return { taskId: null, held: 'NOBODY_TO_ASK' }
  const outcome = await withPendingChange(order.id, change, () =>
    askApproval(tools, { kind: 'SALES_ORDER_CHANGE', recordId: order.id, requester: { userId: requesterId }, note: change.reason.slice(0, 4000), changes: salesOrderChangeChanges({ revision: change.revision, netBefore: change.netAmountBefore, netAfter: change.netAmountAfter, feeAmount: change.feeAmount }) }),
  )
  return outcome.asked ? { taskId: outcome.taskId } : { taskId: null, held: 'NO_RULE' }
}

/** The request waiting on the order, if any (one change at a time). */
export const pendingChangeYes = (db: Reader, orderId: string) => db.approvalTask.findFirst({ where: { kind: 'SALES_ORDER_CHANGE', recordType: 'SalesOrder', recordId: orderId, status: 'PENDING' }, select: { id: true, requestedAt: true } })

async function decided(tools: CommandTools, task: TaskRef, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const order = await tools.tx.salesOrder.findUnique({ where: { id: task.recordId }, select: { id: true, number: true, companyId: true } })
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
  tools.emit({ type: 'sales_order.change_decided', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, amendmentId: change?.id ?? null, revision: change?.revision ?? null, taskId: task.id, decision } })
}

/** The yes (onApproved), in the approver's command: kept on the order. */
export const changeApprovedInCommand = (tools: CommandTools, task: TaskRef): Promise<void> => decided(tools, task, 'APPROVED')
/** The no (onRejected): the change stays written; the order says so, and a person puts it back (./put-back.ts). */
export const changeRejectedInCommand = (tools: CommandTools, task: TaskRef): Promise<void> => decided(tools, task, 'REJECTED')

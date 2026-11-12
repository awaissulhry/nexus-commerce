import { chooseRules } from '@nexus/factory-domain/approvals/rules'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { askChanges, PO_APPROVAL_WORDS, valueText, type SendOptions } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import type { CommandTools } from '../../../core/command'
import { askApproval, recheck } from '../../../platform/approvals/engine'
import { kindOf } from '../../../platform/approvals/kinds'
import { peopleNames, roleNames, TASK_COLUMNS } from '../../../platform/approvals/store'
import type { OrderRow, Reader } from '../store'
import { previousSentValue } from './hooks'

/**
 * The approval gate of a purchase order's send (B-W2b-305; SCM-078 "a PO that matches a PURCHASE_ORDER rule waits as
 * PENDING_APPROVAL and is sent with the yes"; SCM-080 "a change to an approved PO above the rule asks again"). Every send
 * of every revision passes it (modules/purchasing/send.ts), in this order:
 *
 *   a draft that a request approved as it is now (its fingerprint still current)  → sent, naming that request
 *   a draft that a switched-on PURCHASE_ORDER rule holds for                      → asked: the request (the engine's, with
 *        the change it shows: DRAFT → SENT, from revision 2 the revision and the value since the revision sent before,
 *        the send's words) and the order DRAFT → PENDING_APPROVAL naming it, in ONE command; nothing is sent
 *   an order waiting for its yes: approved and still current                      → sent (the yes's own send, or the
 *        buyer's Send after that one was held)
 *   an order waiting for its yes still pending                                    → 409 in words (who it waits for)
 *   otherwise                                                                     → the send as before (no rule: as W1)
 *
 * A request asked by a person whose every matching rule names themselves is refused by the engine (409 `approver`).
 */

const PO = 'PURCHASE_ORDER'

export type Gate = { readonly mode: 'SEND'; readonly approvedTaskId: string | null } | { readonly mode: 'ASK' }

export interface Waiting {
  readonly taskId: string
  readonly approver: { readonly kind: 'ROLE' | 'PERSON'; readonly id: string; readonly name: string } | null
  readonly dueAt: string | null
}

async function approvalTaskIdOf(db: Reader, orderId: string): Promise<string | null> {
  return (await db.purchaseOrder.findUnique({ where: { id: orderId }, select: { approvalTaskId: true } }))?.approvalTaskId ?? null
}

/** The order's newest approved request that still holds for the order as it is now (null: none). */
export async function approvedCurrent(db: Reader, orderId: string): Promise<string | null> {
  const task = await db.approvalTask.findFirst({ where: { kind: PO, recordType: 'PurchaseOrder', recordId: orderId, status: 'APPROVED' }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], select: TASK_COLUMNS })
  if (!task) return null
  return (await recheck(db, task)).state === 'CURRENT' ? task.id : null
}

/** Who a request waits for, by name (a role or a person). */
export async function approverOf(db: Reader, task: { readonly approverRoleId: string | null; readonly approverUserId: string | null }): Promise<Waiting['approver']> {
  if (task.approverUserId) return { kind: 'PERSON', id: task.approverUserId, name: (await peopleNames(db, [task.approverUserId])).get(task.approverUserId) ?? '' }
  if (task.approverRoleId) return { kind: 'ROLE', id: task.approverRoleId, name: (await roleNames(db, [task.approverRoleId])).get(task.approverRoleId) ?? '' }
  return null
}

/** What a switched-on rule would ask for this order now, the person asking being `askerId` (null: no rule holds). */
export async function wouldAsk(db: Reader, orderId: string, askerId: string, now: Date) {
  const kind = kindOf(PO)
  const subject = kind ? await kind.read(db, orderId) : null
  if (!kind || !subject) return null
  const rules = await db.approvalRule.findMany({
    where: { kind: PO, active: true, OR: [{ companyId: null }, { companyId: subject.companyId }] },
    select: { id: true, name: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true },
  })
  const choice = chooseRules(rules, { companyId: subject.companyId, facts: subject.facts, askers: [askerId] }, kind.fields, now)
  if (choice.matched.length === 0) return null
  return { rule: choice.deciding ? { id: choice.deciding.id, name: choice.deciding.name } : null, approver: choice.deciding ? await approverOf(db, choice.deciding) : null, namesYou: choice.deciding === null }
}

/** 409 in words: the order waits for its yes (or its request no longer holds). */
async function waitingRefusal(db: Reader, taskId: string | null): Promise<never> {
  const task = taskId ? await db.approvalTask.findUnique({ where: { id: taskId }, select: { status: true, approverRoleId: true, approverUserId: true } }) : null
  if (task?.status === 'PENDING') {
    const words = PO_APPROVAL_WORDS.waiting((await approverOf(db, task))?.name ?? null)
    throw new DomainError('conflict', words, [{ path: 'refusal/WAITING_FOR_YES', message: words }])
  }
  throw new DomainError('conflict', PO_APPROVAL_WORDS.notCurrent, [{ path: 'refusal/NOT_CURRENT', message: PO_APPROVAL_WORDS.notCurrent }])
}

/** Before the send's command (outside any transaction): whether it would send or ask. Throws 409 while it waits. */
export async function sendGate(db: Reader, order: Pick<OrderRow, 'id' | 'status'>, askerId: string, now: Date): Promise<Gate> {
  if (order.status === 'DRAFT') {
    const approved = await approvedCurrent(db, order.id)
    if (approved) return { mode: 'SEND', approvedTaskId: approved }
    return (await wouldAsk(db, order.id, askerId, now)) ? { mode: 'ASK' } : { mode: 'SEND', approvedTaskId: null }
  }
  if (order.status === 'PENDING_APPROVAL') {
    const taskId = await approvalTaskIdOf(db, order.id)
    const approved = taskId ? await db.approvalTask.findUnique({ where: { id: taskId }, select: TASK_COLUMNS }) : null
    if (approved?.status === 'APPROVED' && (await recheck(db, approved)).state === 'CURRENT') return { mode: 'SEND', approvedTaskId: approved.id }
    return waitingRefusal(db, taskId)
  }
  return { mode: 'SEND', approvedTaskId: null }
}

/** An order waiting for its yes that has it (approved and still current): its send checks are a draft's. */
export async function approvedWaiting(db: Reader, order: Pick<OrderRow, 'id' | 'status'>): Promise<boolean> {
  if (order.status !== 'PENDING_APPROVAL') return false
  const taskId = await approvalTaskIdOf(db, order.id)
  const task = taskId ? await db.approvalTask.findUnique({ where: { id: taskId }, select: TASK_COLUMNS }) : null
  return task?.status === 'APPROVED' && (await recheck(db, task)).state === 'CURRENT'
}

export type InCommand ={ readonly mode: 'SEND'; readonly approvedTaskId: string | null } | { readonly mode: 'WAITING'; readonly waiting: Waiting }

/**
 * Inside the send's command (the order's row locked by its version guard): the gate again, as it stands at the commit.
 * A draft no approved request covers is asked (askApproval): no rule holds → sent; else it waits (PENDING_APPROVAL).
 */
export async function gateInCommand(tools: CommandTools, current: OrderRow, input: { readonly askerId: string; readonly options: SendOptions }): Promise<InCommand> {
  const { tx } = tools
  if (current.status === 'PENDING_APPROVAL') {
    const gate = await sendGate(tx, current, input.askerId, tools.now)
    return gate.mode === 'SEND' ? gate : waitingRefusal(tx, await approvalTaskIdOf(tx, current.id))
  }
  if (current.status !== 'DRAFT') return { mode: 'SEND', approvedTaskId: null }
  const approved = await approvedCurrent(tx, current.id)
  if (approved) return { mode: 'SEND', approvedTaskId: approved }
  const previous = current.revision > 1 ? await previousSentValue(tx, current.id, current.revision) : null
  const changes = askChanges({
    revision: current.revision,
    previous: previous === null ? null : { revision: current.revision - 1, value: valueText(previous, current.currency) },
    value: valueText(current.netAmount, current.currency),
    options: input.options,
  })
  const outcome = await askApproval(tools, { kind: PO, recordId: current.id, requester: { userId: input.askerId }, changes })
  if (!outcome.asked) return { mode: 'SEND', approvedTaskId: null }
  await tx.purchaseOrder.update({ where: { id: current.id }, data: { status: 'PENDING_APPROVAL', approvalTaskId: outcome.taskId }, select: { id: true } })
  tools.audit({
    action: 'purchasing.askApproval',
    recordType: 'PurchaseOrder',
    recordId: current.id,
    companyId: current.companyId,
    siteId: current.siteId,
    before: { status: 'DRAFT' },
    after: { status: 'PENDING_APPROVAL', approvalTaskId: outcome.taskId, revision: current.revision, ruleIds: [...outcome.ruleIds], approverRoleId: outcome.approverRoleId, approverUserId: outcome.approverUserId },
  })
  tools.emit({ type: 'purchase_order.approval_asked', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, taskId: outcome.taskId, revision: current.revision } })
  const approver = await approverOf(tx, { approverRoleId: outcome.approverRoleId, approverUserId: outcome.approverUserId })
  return { mode: 'WAITING', waiting: { taskId: outcome.taskId, approver, dueAt: outcome.dueAt } }
}

/** The send's words as a request keeps them (the body of POST …/send, checked by its contract). */
export function sendOptionsFrom(body: { readonly confirmBy?: string | null | undefined; readonly subject?: string | null | undefined; readonly message?: string | null | undefined; readonly cc?: readonly string[] | undefined; readonly changeNote?: string | null | undefined }): SendOptions {
  const text = (value: string | null | undefined) => (value?.trim() ? value.trim() : null)
  return { confirmBy: body.confirmBy ? toUtcIso(new Date(body.confirmBy)) : null, subject: text(body.subject), message: text(body.message), cc: body.cc ? [...body.cc] : null, changeNote: text(body.changeNote) }
}

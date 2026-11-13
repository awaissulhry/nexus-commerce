import { APPROVALS_DECIDE } from '@nexus/factory-domain/approvals/permissions'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { PURCHASING_COMPLIANCE_OVERRIDE } from '@nexus/factory-domain/purchasing/qualification/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
import { approverRolesOf, decidersOf, isApprover, type Reader } from '../../../platform/approvals/store'
import { approveTask, rejectTask, withdrawTask } from '../../../platform/approvals/tasks'
import { COMPLIANCE_KIND } from './kind'

/**
 * "Send without a valid document?" through the approval engine (B-W2b-377; follow-up XF5:02): B-W2b-315's routes keep their
 * paths and answers (modules/purchasing/qualification/gate.ts calls these), and the request is a PURCHASE_ORDER_COMPLIANCE
 * ApprovalTask:
 *
 *   ask        in the ask's command: the engine's `askApproval` (a switched-on rule names who decides); no rule holds → the
 *              office role that decides overrides (`deciderRoleOf`), with a fresh step-up for the yes, as B-W2b-315's yes asked
 *   decide     the engine's own yes and no (`approveTask` / `rejectTask`): never the person who asked, only the request's
 *              approver, re-read first (what holds the order changed → STALE, 409 in words); a no takes a reason code of the
 *              APPROVAL_REJECT list (OTHER when the order's screen sends none) and its words
 *   withdraw   the engine's withdraw (only who asked)
 *
 * What a request covers (the gate's fingerprint when asked) and its reason stay on the ask's audit row
 * (purchasing.compliance.overrideAsk, `taskId`), so the gate reads the newest request as before (qualification/store.ts).
 */

export const COMPLIANCE_REFUSALS = Object.freeze({
  noDecider: 'No office role decides a send without a valid document: give a role purchasing.compliance.override and approvals.decide (Admin › Roles), or switch on an approval rule for it.',
})

/** Whether the person is the request's approver (named, or a holder of its role over the order's place). */
export async function isTaskApprover(db: Reader, taskId: string, userId: string, now: Date): Promise<boolean> {
  const task = await db.approvalTask.findUnique({ where: { id: taskId }, select: { approverUserId: true, approverRoleId: true, companyId: true, siteId: true } })
  return task !== null && isApprover(task, userId, await approverRolesOf(db, userId, now))
}

/** The pending request of an order, or null. */
export async function pendingTaskOf(db: Reader, orderId: string) {
  return db.approvalTask.findFirst({ where: { kind: COMPLIANCE_KIND, recordType: 'PurchaseOrder', recordId: orderId, status: 'PENDING' }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, version: true, requestedById: true, createdById: true } })
}

/**
 * The office role that decides overrides when no rule names one: a role holding purchasing.compliance.override and
 * approvals.decide (the quality inspector's template; the Owner's role last), the first with someone other than the person
 * asking who may decide over the order's place; else the first such role (the request waits, "nobody else can approve it
 * yet"); none → null.
 */
export async function deciderRoleOf(tools: CommandTools, place: { readonly companyId: string; readonly siteId: string | null }, askers: readonly string[]): Promise<string | null> {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) return null
  const roles = await tools.tx.role.findMany({
    where: { audience: 'OFFICE', permissions: { hasEvery: [PURCHASING_COMPLIANCE_OVERRIDE, APPROVALS_DECIDE] } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, key: true },
  })
  const ordered = [...roles.filter((role) => role.key !== 'owner'), ...roles.filter((role) => role.key === 'owner')]
  for (const role of ordered) {
    if ((await decidersOf(tools.tx, tenantId, { approverRoleId: role.id, approverUserId: null }, place, askers, tools.now)).length > 0) return role.id
  }
  return ordered[0]?.id ?? null
}

/** Asks the yes inside the ask's command; the task's id. */
export async function askComplianceYes(tools: CommandTools, order: { readonly id: string; readonly companyId: string; readonly siteId: string }, askerId: string, reason: string): Promise<string> {
  // A request still waiting covers what held the order before (the same one is refused earlier): the new one replaces it.
  await withdrawPending(tools, { kind: COMPLIANCE_KIND, recordId: order.id, byId: askerId, words: 'What holds the order changed: asked again.' })
  const roleId = await deciderRoleOf(tools, order, [askerId])
  const outcome = await askApproval(tools, { kind: COMPLIANCE_KIND, recordId: order.id, requester: { userId: askerId }, note: reason, ...(roleId ? { whenNoRule: { approverRoleId: roleId, requireStepUp: true } } : {}) })
  if (!outcome.asked) throw new DomainError('conflict', COMPLIANCE_REFUSALS.noDecider, [{ path: 'refusal/NO_APPROVER', message: COMPLIANCE_REFUSALS.noDecider }])
  return outcome.taskId
}

/** The order's waiting request, or 409 in B-W2b-315's words. */
async function waitingTask(caller: CommandCaller, orderId: string, notWaiting: string) {
  const task = await caller.withClient((client) => pendingTaskOf(client, orderId))
  if (!task) throw new DomainError('conflict', notWaiting, [{ path: 'compliance/override', message: notWaiting }])
  return task
}

/** The engine's yes or no on the order's waiting request (a yes takes the session's fresh step-up when the request asks one). */
export async function decideComplianceYes(caller: CommandCaller, orderId: string, body: { readonly decision: 'APPROVED' | 'REJECTED'; readonly words: string | null; readonly reasonCode?: string | undefined }, stepUpAt: () => Date, notWaiting: string, idempotencyKey?: string): Promise<void> {
  const task = await waitingTask(caller, orderId, notWaiting)
  if (body.decision === 'APPROVED') await approveTask(caller, task.id, { version: task.version, comment: body.words }, stepUpAt, idempotencyKey)
  else await rejectTask(caller, task.id, { version: task.version, reasonCode: body.reasonCode ?? 'OTHER', reason: body.words ?? '' }, idempotencyKey)
}

/** The engine's withdraw of the order's waiting request (only who asked). */
export async function withdrawComplianceYes(caller: CommandCaller, orderId: string, notWaiting: string, idempotencyKey?: string): Promise<void> {
  const task = await waitingTask(caller, orderId, notWaiting)
  await withdrawTask(caller, task.id, { version: task.version, note: null }, idempotencyKey)
}

import { businessDayStart } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTools } from '../../../core/command'
import { closeTasksInCommand, openTaskInCommand, tasksOfRecord } from '../../../platform/portal/tasks/store'
import { dayOf } from '../store'

/**
 * The workshop's requests on a job (B-W2b-176 with B-W2b-167's one task list; platform/portal/tasks/sources/subcontract-jobs.ts):
 *
 *   CONFIRM_KIT      opened when kit lines go out (the kit send, ../subcontracting/kit.ts), one per send
 *                    (`SubcontractJob:<order>:kit:<first line>`); done when the workshop confirms what came; withdrawn when no
 *                    line waits for its check any more (a line taken back unsent) or the job ends.
 *   REPORT_PROGRESS  opened with the first kit that goes out (`SubcontractJob:<order>:progress`, once per job); done at the
 *                    workshop's first report or send-back; withdrawn when everything is back or the job ends. The office asks
 *                    for more by hand (B-W2b-167's Ask).
 *
 * A partner or link session only answers (DONE); opening and withdrawing run in the office's or the system's commands.
 * `settleJobInCommand` is the one call the W2a commands make after they move an order (send, take back, receive, back to
 * draft, cancel): it withdraws what no longer applies, and stops the job's live links once the order is back in draft or
 * cancelled (the job is no longer the one the link shows).
 */

export const JOB_TASK_PREFIX = 'SubcontractJob'
const RECORD = 'SubcontractOrder'
const DAY_MS = 86_400_000

interface Order {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly number: string
  readonly expectedBackDate: Date | null
}

/** In the kit send's command (office or the floor's system caller): the kit to confirm and, once, the progress to report. */
export async function openJobTasksInCommand(tools: CommandTools, order: Order, sentLineIds: readonly string[]): Promise<void> {
  if (sentLineIds.length > 0) {
    await openTaskInCommand(tools, {
      companyId: order.companyId,
      partyId: order.partyId,
      kind: 'CONFIRM_KIT',
      record: { type: RECORD, id: order.id, label: order.number },
      sourceKey: `${JOB_TASK_PREFIX}:${order.id}:kit:${sentLineIds[0]}`,
      dueAt: new Date(tools.now.getTime() + 2 * DAY_MS),
      askedBy: null,
    })
  }
  await openTaskInCommand(tools, {
    companyId: order.companyId,
    partyId: order.partyId,
    kind: 'REPORT_PROGRESS',
    record: { type: RECORD, id: order.id, label: order.number },
    sourceKey: `${JOB_TASK_PREFIX}:${order.id}:progress`,
    dueAt: order.expectedBackDate ? businessDayStart(dayOf(order.expectedBackDate)!) : null,
    askedBy: null,
  })
}

/** In an answering command (the workshop's, or the office's for it): its requests of a kind done. */
export async function doneJobTasksInCommand(tools: CommandTools, orderId: string, kind: 'CONFIRM_KIT' | 'REPORT_PROGRESS', doneById: string | null): Promise<number> {
  return closeTasksInCommand(tools, { recordType: RECORD, recordId: orderId, kinds: [kind], status: 'DONE', doneById })
}

/**
 * In an office or system command that moved the order: withdraws the kit request when no SENT line waits for its check, the
 * progress request when nothing is at the workshop any more (all back, or the job ended); and stops its live JOB_ACCEPT
 * links when the order is back in draft or cancelled.
 */
export async function settleJobInCommand(tools: CommandTools, orderId: string): Promise<void> {
  const order = await tools.tx.subcontractOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, siteId: true, status: true } })
  if (!order) return
  const open = await tasksOfRecord(tools.tx, RECORD, orderId, { status: 'OPEN' })
  if (open.length > 0) {
    const waiting = await tools.tx.subcontractKitLine.count({ where: { subcontractOrderId: orderId, status: 'SENT', receivedByWorkshopAt: null } })
    const out = order.status === 'AT_WORKSHOP' || order.status === 'PARTLY_RECEIVED'
    if (waiting === 0) await closeTasksInCommand(tools, { recordType: RECORD, recordId: orderId, kinds: ['CONFIRM_KIT'], status: 'CANCELLED', doneById: null })
    if (!out) await closeTasksInCommand(tools, { recordType: RECORD, recordId: orderId, kinds: ['REPORT_PROGRESS'], status: 'CANCELLED', doneById: null })
  }
  if (order.status === 'DRAFT' || order.status === 'CANCELLED') await revokeJobLinksInCommand(tools, order, tools.context.audience === 'office' ? tools.context.actorId : null)
}

/** Every live JOB_ACCEPT link of the order stops working (revoked; its evidence stays). Returns their ids. */
export async function revokeJobLinksInCommand(tools: CommandTools, order: { readonly id: string; readonly companyId: string; readonly siteId: string }, actorId: string | null): Promise<string[]> {
  const rows = await tools.tx.oneOffLink.findMany({ where: { recordType: RECORD, recordId: order.id, purpose: 'JOB_ACCEPT', revokedAt: null }, select: { id: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true } })
  const ids = rows.filter((link) => linkState(link, tools.now) === 'LIVE').map((link) => link.id)
  if (ids.length === 0) return []
  await tools.tx.oneOffLink.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: tools.now, revokedById: actorId } })
  for (const id of ids) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: id, companyId: order.companyId, siteId: order.siteId, after: { revokedAt: toUtcIso(tools.now) } })
  return ids
}

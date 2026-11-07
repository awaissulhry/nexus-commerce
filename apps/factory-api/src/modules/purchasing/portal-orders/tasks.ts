import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { confirmTaskKey, PO_RECORD_TYPE } from '@nexus/factory-domain/purchasing/portal-orders/views'
import type { CommandTools } from '../../../core/command'
import { closeTasksInCommand, openTaskInCommand, reopenInCommand, tasksOfRecord } from '../../../platform/portal/tasks/store'

/**
 * The supplier's CONFIRM_PO request (B-W2b-174; B-W2b-167 "A CONFIRM_PO task opens when a PO is sent and closes on the
 * answer"; plan W2b-3 "Sources"): one task per revision of an order (sourceKey `PurchaseOrder:<id>:r<revision>`, the source
 * `purchase-orders` of platform/portal/tasks/sources), opened in the send's own command and closed in the command that
 * answers it, so the order, its request and their events commit together. The seams below are called from purchasing's
 * own commands:
 *
 *   opened     the send (../send.ts): due by the order's confirm-by time, asked by the person who sent it
 *   done       the supplier's answer, in the portal (./answer.ts, done by the person) or through its link (../confirm/answer.ts)
 *   cancelled  the order cancelled (../orders.ts), changed into a new revision (../revisions/change.ts: the new send asks
 *              again), or goods received while it still waited (../receiving.ts): nothing is left to confirm
 *   reopened   the buyer refused the supplier's proposal (../confirm/decide.ts): the order waits for the supplier again
 *
 * The notification, the instant mail, the reminder and the summary follow the task by themselves (platform/portal).
 */

export interface ConfirmTaskOrder {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly number: string
  readonly revision: number
}

/** Inside the send's command: the request to confirm this revision. */
export async function openConfirmTask(tools: CommandTools, order: ConfirmTaskOrder, input: { readonly dueAt: Date | null; readonly askedBy: { readonly id: string; readonly name: string } | null }): Promise<void> {
  await openTaskInCommand(tools, {
    companyId: order.companyId,
    partyId: order.partyId,
    kind: 'CONFIRM_PO',
    record: { type: PO_RECORD_TYPE, id: order.id, label: purchaseOrderDocumentNumber(order.number, order.revision) },
    sourceKey: confirmTaskKey(order.id, order.revision),
    dueAt: input.dueAt,
    askedBy: input.askedBy,
  })
}

/**
 * Inside the command that answers the order (DONE; `doneById` the portal person, null for a link) or makes the request moot
 * (CANCELLED: the office, the system). Every open CONFIRM_PO request of the order closes (an older revision's included).
 */
export async function closeConfirmTasks(tools: CommandTools, orderId: string, status: 'DONE' | 'CANCELLED', doneById: string | null = null): Promise<number> {
  return closeTasksInCommand(tools, { recordType: PO_RECORD_TYPE, recordId: orderId, kinds: ['CONFIRM_PO'], status, doneById })
}

/** Inside the buyer's refusal (office scope): this revision's request opens again (the supplier answers again). */
export async function reopenConfirmTask(tools: CommandTools, order: Pick<ConfirmTaskOrder, 'id' | 'revision'>): Promise<boolean> {
  const [task] = await tasksOfRecord(tools.tx, PO_RECORD_TYPE, order.id, { kinds: ['CONFIRM_PO'], sourceKey: confirmTaskKey(order.id, order.revision) })
  if (!task || task.status === 'OPEN') return false
  await reopenInCommand(tools, task, false)
  return true
}

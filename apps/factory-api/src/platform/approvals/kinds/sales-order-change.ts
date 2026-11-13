import { SALES_ORDER_CHANGE_FIELDS } from '@nexus/factory-domain/sales/order-changes/priced'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
// B-W2b-309: what the order does with the decision (the subject's read, the yes and the no).
import { changeApprovedInCommand, changeRejectedInCommand, readChangeSubject } from '../../../modules/sales/order-changes/yes'
import type { ApprovalKindDefinition, Reader, TaskRef } from './kind'

/**
 * SALES_ORDER_CHANGE (B-W2b-309; SAL-190 "re-approval after editing an approved order"): a confirmed order changed (W2a's
 * amendment, a priced change after the start, a customer's change request accepted) asks a yes again when a rule of the
 * company holds on the change's facts. The subject is the order (recordType SalesOrder: the database's rule for
 * SalesOrderAmendment.reapprovalTaskId), about its latest change; the amendment names the request. The facts its rules test:
 * the order's value after the change, the change in value (net, the price grain) and in percent, the fee, the lines and
 * pieces changed, whether it was priced after the start, the furthest production stage of a changed line, the customer's
 * code, whether the order went on with a SALES_ORDER yes. The fingerprint covers the change itself (a newer change makes it
 * STALE). The yes is kept on the order; the no leaves the change written and the order says so (modules/sales/order-changes:
 * a person puts it back). Asked from the generic route too (orders.manage): after a STALE request, or when only the person
 * who changed the order could decide at the time.
 */
export const SALES_ORDER_CHANGE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'SALES_ORDER_CHANGE',
  recordType: 'SalesOrder',
  label: { en: 'Sales order change', it: "Modifica dell'ordine di vendita" },
  view: ORDERS_VIEW,
  ask: ORDERS_MANAGE,
  fields: SALES_ORDER_CHANGE_FIELDS,
  read: (client: Reader, recordId: string) => readChangeSubject(client, recordId),
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.salesOrderAmendment.findMany({ where: companyId ? { companyId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit * 4, select: { orderId: true } })
    return [...new Set(rows.map((row) => row.orderId))].slice(0, limit)
  },
  onApproved: (tools: CommandTools, task: TaskRef) => changeApprovedInCommand(tools, task),
  onRejected: (tools: CommandTools, task: TaskRef) => changeRejectedInCommand(tools, task),
})

import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { BulkRefusal } from '@nexus/factory-domain/views/bulk/rules'
import { actorOf } from '../../../../core/context'
import { mayOn, officeContextOf } from '../../../../modules/production/work-orders/access'
import { dayOrNull } from '../../../../modules/production/work-orders/store'
import { updateWorkOrder } from '../../../../modules/production/work-orders/work-orders'
import { defineBulkTarget } from '../target'

/**
 * Production › Work orders (SCR-069, `/production/work-orders`; design shell.lists pop:bulk-edit "Edit 12 work orders",
 * sec:grid "planned date, priority"): the due date and the priority, by the list frame's column ids `due` and
 * `priority`, each written through the module's own workorders.update (workorders.manage over the row's company and
 * site, its version check, its audit row and its workorder.changed event). A CLOSED or CANCELLED work order keeps both
 * (the command itself refuses them: "only its note changes"). Totals per work order only: no person, no money.
 */

const SELECT = { id: true, number: true, status: true, version: true, companyId: true, siteId: true, dueDate: true, priority: true } as const satisfies Prisma.WorkOrderSelect

interface Row {
  readonly id: string
  readonly number: string
  readonly status: WorkOrderStatus
  readonly version: number
  readonly companyId: string
  readonly siteId: string
  readonly dueDate: BusinessDate | null
  readonly priority: number
}

const FINAL: readonly WorkOrderStatus[] = ['CLOSED', 'CANCELLED']
const held = (row: Row): BulkRefusal | null => (FINAL.includes(row.status) ? { code: 'held', status: row.status } : null)

export const workOrders = defineBulkTarget<Row>({
  listKey: 'production.work-orders',
  permission: WORKORDERS_MANAGE,
  fields: {
    due: { kind: 'date', nullable: true, read: (row) => row.dueDate, held },
    priority: { kind: 'integer', min: -1000, max: 1000, read: (row) => row.priority, held },
  },
  async load(caller, ids) {
    const context = officeContextOf(caller)
    const wanted = ids.filter(isUuid)
    if (wanted.length === 0) return []
    const rows = await caller.withClient((client) =>
      client.workOrder.findMany({ where: { AND: [scopeWhere(actorOf(context), WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput, { id: { in: wanted } }] }, select: SELECT }),
    )
    return rows.map((row) => ({ ...row, dueDate: dayOrNull(row.dueDate) }))
  },
  idOf: (row) => row.id,
  labelOf: (row) => row.number,
  versionOf: (row) => row.version,
  statusOf: (row) => row.status,
  rowHeld: (caller, row) => (mayOn(officeContextOf(caller), WORKORDERS_MANAGE, row) ? null : { code: 'forbidden' }),
  async write(caller, row, changes, version, idempotencyKey) {
    const { workOrder } = await updateWorkOrder(
      caller,
      row.id,
      {
        version,
        ...(Object.hasOwn(changes, 'due') ? { dueDate: (changes.due as BusinessDate | null) ?? null } : {}),
        ...(Object.hasOwn(changes, 'priority') ? { priority: changes.priority as number } : {}),
      },
      idempotencyKey,
    )
    return { id: workOrder.id, number: workOrder.number, status: workOrder.status, version: workOrder.version, companyId: workOrder.companyId, siteId: workOrder.siteId, dueDate: workOrder.dueDate, priority: workOrder.priority }
  },
})

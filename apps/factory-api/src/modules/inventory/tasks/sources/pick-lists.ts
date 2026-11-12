import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { OPEN_TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import type { CommandCaller } from '../../../../core/command'
import { PICK_LIST_NOTE } from '../../issue/kits'
import type { Reader } from '../../issue/store'
import { cancelInCommand, createTaskInCommand, doneInCommand, openTasksOf } from '../lifecycle'
import { defineTaskSource, posterOf, sourceCommand } from '../source-kit'

/**
 * A pick list makes a PICK task (B-W2b-292; SCM-274; WarehouseTask kind PICK, source WorkOrder). A pick list is what Warehouse ›
 * Picking & kits made for a released work order (modules/inventory/issue kits.ts createPickLists: its reservations carry the
 * pick list's note):
 *
 *   inventory.reserved                 a pick list made for a work order: one open PICK task for it
 *   inventory.issued                   nothing of its pick list is left to pick: the task is done by who issued the last of it
 *   inventory.reservations_released    its pick list was let go: the task is cancelled (done, when some of it was issued)
 * B-W2b-298's pick list by bin will name its task the same way.
 */

const OPEN = [...OPEN_TASK_STATUSES]

async function pickListOf(db: Reader, workOrderId: string) {
  const rows = await db.reservation.findMany({ where: { workOrderId, note: PICK_LIST_NOTE }, select: { status: true } })
  return { any: rows.length > 0, active: rows.filter((row) => row.status === 'ACTIVE').length, issued: rows.filter((row) => row.status === 'ISSUED').length }
}

async function onReserved(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  const { workOrderId } = event.payload as { workOrderId: string | null }
  if (!workOrderId) return
  const read = await caller.withClient(async (client) => {
    const db = client as unknown as Reader
    const list = await pickListOf(db, workOrderId)
    if (list.active === 0) return null
    if ((await openTasksOf(db, { type: 'WorkOrder', id: workOrderId }, 'PICK')).length > 0) return null
    return db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true } })
  })
  if (!read) return
  await sourceCommand(caller, 'pickLists', event, { workOrderId }, async (tools) => {
    if ((await openTasksOf(tools.tx, { type: 'WorkOrder', id: workOrderId }, 'PICK')).length > 0) {
      tools.audit({ action: 'inventory.warehouseTaskSource', recordType: 'WorkOrder', recordId: workOrderId, companyId: read.companyId, siteId: read.siteId, after: { pickTask: 'open already' } })
      return
    }
    await createTaskInCommand(tools, { companyId: read.companyId, siteId: read.siteId, kind: 'PICK', source: { type: 'WorkOrder', id: read.id }, note: `Pick list of ${read.number}` })
  })
}

async function onPicked(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  const payload = event.payload as { workOrderId?: string; workOrderIds?: string[]; moveIds?: string[] }
  const workOrderIds = payload.workOrderId ? [payload.workOrderId] : (payload.workOrderIds ?? [])
  for (const workOrderId of workOrderIds) {
    const read = await caller.withClient(async (client) => {
      const db = client as unknown as Reader
      const open = await db.warehouseTask.findMany({ where: { kind: 'PICK', status: { in: OPEN }, sourceType: 'WorkOrder', sourceId: workOrderId }, select: { id: true } })
      if (open.length === 0) return null
      const list = await pickListOf(db, workOrderId)
      if (list.active > 0) return null
      const move = payload.moveIds?.length ? await db.stockMove.findFirst({ where: { id: { in: payload.moveIds } }, select: { createdById: true, deviceId: true }, orderBy: { id: 'asc' } }) : null
      return { open, issued: list.issued > 0, by: move ? posterOf(move) : null }
    })
    if (!read) continue
    await sourceCommand(caller, `pickLists:${workOrderId}`, event, { workOrderId }, async (tools) => {
      for (const row of await openTasksOf(tools.tx, { type: 'WorkOrder', id: workOrderId }, 'PICK')) {
        if (read.issued && read.by) await doneInCommand(tools, row, read.by)
        else await cancelInCommand(tools, row, read.issued ? 'Everything on the pick list was picked.' : 'The pick list was let go: nothing to pick.')
      }
    })
  }
}

export default defineTaskSource({
  name: 'pickLists',
  events: ['inventory.reserved', 'inventory.issued', 'inventory.reservations_released'],
  async handle(caller, event) {
    if (event.type === 'inventory.reserved') await onReserved(caller, event)
    else await onPicked(caller, event)
  },
})

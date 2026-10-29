import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { moveChange, workOrderMachine, type ManualMove } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { officeContextOf } from './access'
import { lockedStatus, readWorkOrder } from './store'
import { workOrderView, type WorkOrderView } from './views'
import { officeWorkOrder, onWorkOrder, todayOfCommand } from './work-orders'

/**
 * The office's moves after the release (B-W1-38; MES-007): start (RELEASED → IN_PROGRESS; the floor's first issue, cut
 * or scan will start it by itself in B-W1-39/40/42), complete (IN_PROGRESS → COMPLETED), close (COMPLETED → CLOSED; the
 * close with planned vs actual and a tolerance reason is W2b, MES-012) and cancel (from DRAFT, RELEASED or IN_PROGRESS,
 * with a reason). One command each on the work order (its version bump locks the row): the machine's check, then the
 * status with its time in one row update (the trigger refuses a status without its time). A cancelled work order gives
 * its pieces back to its order lines; what was issued to it stays on it in the ledger until it is returned (the record
 * lists it per material: `spec.materials[].issued`).
 *
 * Complete, close and cancel end the issuing (B-W1-39: stock is issued only to a RELEASED or IN_PROGRESS work order), so
 * they take the work order's issue lock (modules/inventory/issue store `lockWorkOrderIssues`, the lock every issue,
 * return, undo and reversal takes first) BEFORE the work order's row: an issue in flight finishes first and the move
 * follows it, or the move commits first and the issue, reading the status under the same lock, refuses. Never an issue
 * on a cancelled work order. (The floor cannot lock the row itself: its role only reads work orders.)
 */

/** The moves after which nothing more is issued to the work order. */
const ENDS_ISSUING: readonly ManualMove[] = Object.freeze(['COMPLETED', 'CLOSED', 'CANCELLED'])

/** command()'s record guard, by hand (after the issue lock): the version the caller read, then compare-and-set. */
async function bumpVersion(tx: CommandTx, workOrderId: string, expected: number | undefined): Promise<void> {
  const row = await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { version: true } })
  if (!row) throw new NotFoundError('WorkOrder not found.')
  if (expected !== undefined && expected !== row.version) throw new StaleVersionError('WorkOrder', workOrderId, row.version, expected)
  const { count } = await tx.workOrder.updateMany({ where: { id: workOrderId, version: row.version }, data: { version: row.version + 1 } })
  if (count !== 1) {
    const current = await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { version: true } })
    if (!current) throw new NotFoundError('WorkOrder not found.')
    throw new StaleVersionError('WorkOrder', workOrderId, current.version, row.version)
  }
}

const COMMAND: Readonly<Record<ManualMove, `workorders.${string}`>> = {
  IN_PROGRESS: 'workorders.start',
  COMPLETED: 'workorders.complete',
  CLOSED: 'workorders.close',
  CANCELLED: 'workorders.cancel',
}

export async function moveWorkOrder(
  caller: CommandCaller,
  workOrderId: string,
  to: ManualMove,
  body: { readonly version?: number | undefined; readonly reason?: string | undefined },
  idempotencyKey?: string,
): Promise<{ workOrder: WorkOrderView }> {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  const spec = { name: COMMAND[to], idempotencyKey, input: { workOrderId, to, ...body }, version: body.version }
  const work = async (tools: CommandTools): Promise<{ workOrder: WorkOrderView }> => {
    const { tx, now } = tools
    const current = (await readWorkOrder(tx, workOrder.id))!
    assertTransition(workOrderMachine, current.status, to, { reason: body.reason ?? null })
    const change = moveChange(to, now, body.reason)
    await tx.workOrder.update({ where: { id: current.id }, data: change, select: { id: true } })
    const after = Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value instanceof Date ? toUtcIso(value) : value]))
    tools.audit({
      recordType: 'WorkOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { status: current.status },
      after,
      ...(to === 'CANCELLED' ? { reason: (body.reason ?? '').trim() } : {}),
    })
    tools.emit({
      type: 'workorder.status_changed',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { workOrderId: current.id, number: current.number, from: current.status, to },
    })
    return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools)) }
  }
  if (!ENDS_ISSUING.includes(to)) return onWorkOrder(caller, workOrder, spec, work)
  const { tenantId } = officeContextOf(caller)
  const { result } = await command(caller, { name: spec.name, idempotencyKey, input: spec.input }, async (tools) => {
    await lockWorkOrderIssues(tools.tx, tenantId, workOrder.id)
    await bumpVersion(tools.tx, workOrder.id, body.version)
    return work(tools)
  })
  return result
}

/**
 * The first work on a released work order starts it (B-W1-39: the first issue; B-W1-40 and B-W1-42 can call it for the
 * first cut or scan): RELEASED → IN_PROGRESS with its start time, as the system (the worker's handler; the floor role
 * cannot update a work order) or the office, in one command on the work order (its version bump locks the row). Answers
 * `started: false` and writes nothing when the work order is not RELEASED any more (started already, or cancelled
 * meanwhile). The same work order is started once: its key is `workorders-start:<id>`, so a repeat answers from the
 * receipt.
 */
export async function startOnFirstWork(caller: CommandCaller, workOrderId: string, cause: { readonly what: string; readonly causationId?: string }): Promise<{ started: boolean }> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'system' && context.audience !== 'office')) throw new ForbiddenError()
  const current = await caller.withClient((client) => readWorkOrder(client, workOrderId))
  if (!current || current.status !== 'RELEASED') return { started: false }
  try {
    const { result } = await command(
      caller,
      {
        name: 'workorders.start',
        idempotencyKey: `workorders-start:${workOrderId}`,
        input: { workOrderId, to: 'IN_PROGRESS', cause: cause.what },
        record: { type: 'WorkOrder', id: workOrderId },
        ...(cause.causationId ? { causationId: cause.causationId } : {}),
      },
      async (tools) => {
        const row = await lockedStatus(tools.tx, workOrderId, ['RELEASED'], 'its first work starts it')
        const change = moveChange('IN_PROGRESS', tools.now)
        await tools.tx.workOrder.update({ where: { id: row.id }, data: change, select: { id: true } })
        tools.audit({
          recordType: 'WorkOrder',
          recordId: row.id,
          companyId: row.companyId,
          siteId: row.siteId,
          before: { status: row.status },
          after: { status: 'IN_PROGRESS', startedAt: toUtcIso(tools.now) },
          reason: `Started by its first work: ${cause.what}.`,
        })
        tools.emit({
          type: 'workorder.status_changed',
          subject: row.id,
          companyId: row.companyId,
          siteId: row.siteId,
          payload: { workOrderId: row.id, number: row.number, from: row.status, to: 'IN_PROGRESS' },
        })
        return { started: true }
      },
    )
    return result
  } catch (error) {
    if (error instanceof InvalidStateError) return { started: false }
    throw error
  }
}

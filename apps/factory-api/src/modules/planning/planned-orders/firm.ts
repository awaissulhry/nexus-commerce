import { ConflictError } from '@nexus/factory-domain/core/errors'
import { PLANNING_FIRM } from '@nexus/factory-domain/planning/mrp/permissions'
import { firmProblem, type PlannedOrderStatus } from '@nexus/factory-domain/planning/planned-orders/rules'
import { command, type CommandCaller } from '../../../core/command'
import { officeContextOf } from '../access'
import type { PlannedOrderView } from './contract'
import { plannedFor, viewsOf } from './read'
import { readPlanned } from './store'

/**
 * Firm planned work orders (B-W2b-293 with B-W2a-22's PLN-075; design planning.mrp "firm and convert"): a planner fixes a
 * planned order as it is, so the next runs keep it (it moves on to each run unchanged, and the demand it pegs counts as
 * covered), or makes it planned again (the next run plans that demand freely). planning.firm over the site. ONE command on
 * the planned order (its version bump, at the version the planner read); audited; `planned_work_order.firmed`. A planned
 * order made real is never firm or planned again.
 */
async function setFirm(caller: CommandCaller, id: string, firm: boolean, version: number, idempotencyKey: string | undefined): Promise<{ plannedOrder: PlannedOrderView; replayed: boolean }> {
  const office = officeContextOf(caller)
  const row = await plannedFor(caller, id, PLANNING_FIRM)
  const { replayed } = await command(
    caller,
    { name: firm ? 'planning.plannedOrders.firm' : 'planning.plannedOrders.unfirm', idempotencyKey, input: { plannedWorkOrderId: id, version }, record: { type: 'PlannedWorkOrder', id, expectedVersion: version } },
    async (tools) => {
      const { tx, now, context } = tools
      const current = (await readPlanned(tx, id))!
      const problem = firmProblem({ status: current.status as PlannedOrderStatus, firm: current.firm }, firm)
      if (problem) throw new ConflictError(problem)
      const actorId = context.audience === 'office' ? context.actorId : null
      await tx.plannedWorkOrder.update({ where: { id }, data: firm ? { firm: true, firmedAt: now, firmedById: actorId } : { firm: false, firmedAt: null, firmedById: null }, select: { id: true } })
      tools.audit({
        action: firm ? 'planning.plannedOrders.firm' : 'planning.plannedOrders.unfirm',
        recordType: 'PlannedWorkOrder',
        recordId: id,
        companyId: row.companyId,
        siteId: row.siteId,
        before: { firm: current.firm },
        after: { firm },
      })
      tools.emit({ type: 'planned_work_order.firmed', subject: id, companyId: row.companyId, siteId: row.siteId, payload: { plannedWorkOrderId: id, siteId: row.siteId, firm } })
      return { id }
    },
  )
  const [view] = await caller.withClient(async (db) => viewsOf(db, [(await readPlanned(db, id))!], office))
  return { plannedOrder: view!, replayed }
}

/** POST /planning/planned-orders/:plannedOrderId/firm */
export const firmPlannedOrder = (caller: CommandCaller, id: string, body: { readonly version: number }, idempotencyKey?: string) => setFirm(caller, id, true, body.version, idempotencyKey)

/** POST /planning/planned-orders/:plannedOrderId/unfirm */
export const unfirmPlannedOrder = (caller: CommandCaller, id: string, body: { readonly version: number }, idempotencyKey?: string) => setFirm(caller, id, false, body.version, idempotencyKey)

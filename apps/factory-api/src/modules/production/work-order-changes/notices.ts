import { workOrderChangeApplied, workOrderChangeDeclined, workOrderChangeProposed } from '@nexus/factory-domain/order-apply/events'
import { can } from '@nexus/factory-domain/core/permissions'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import { followersOf } from '../../../platform/threads/followers'
import { supervisorOfOrder, supervisorOfWorkOrder } from '../supervisor/resolver'
import { reachesWorkOrder } from '../work-orders/scope'
import { mayRead } from './read'

/**
 * B-SA-041 (sales page plan, lead picks P6', R9 "ONE bell mechanism"; 13-backend B4b "Bell"): the bell of a work-order change,
 * through the one fan-out (platform/notifications), one line in its rules/index.ts.
 *
 *   work_order_change.proposed            ASSIGNMENT to who may apply it: the work order's production supervisor and its followers
 *                                         (the work order's thread, not muted) who hold workorders.manage over it; a new DRAFT's
 *                                         (MAKE_MORE naming none): the order's supervisor, with workorders.manage over the order's
 *                                         company and customer. "Bea proposes a work order change on WO-0142"
 *   work_order_change.applied | declined  SYSTEM to the proposer, while he still reads it: "Carla applied the work order change on
 *                                         WO-0142" / "… left it as is"
 *
 * THE WALL (Owner rule 2026-11-16): a person is told only while he is an ACTIVE office person who reaches the work order (its company,
 * site and customer; a mixed one only with every customer) or, for a new DRAFT, the order's company and customer — re-checked at the
 * fan-out by his live roles, never at the act. Nobody is told what he did himself (the fan-out drops the actor). The words name our
 * work order or order number; never a customer's person, a figure or the words typed.
 */

const SALES_ORDER = 'SalesOrder'
const WORK_ORDER = 'WorkOrder'

async function workOrderOf(context: RuleContext, workOrderId: string | null) {
  return workOrderId ? context.tx.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, partyId: true } }) : null
}

export const WORK_ORDER_CHANGE_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'production.workOrderChangeProposed',
    events: ['work_order_change.proposed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = workOrderChangeProposed.payload.parse(raw)
      const change = await context.tx.workOrderChange.findUnique({ where: { id: payload.changeId }, select: { id: true, status: true, companyId: true, partyId: true, proposedById: true } })
      if (!change || change.status !== 'PROPOSED') return []
      const workOrder = await workOrderOf(context, payload.workOrderId)
      const order = await context.tx.salesOrder.findUnique({ where: { id: payload.salesOrderId }, select: { id: true, number: true } })
      if (!order) return []
      const candidates = new Set<string>()
      if (workOrder) {
        const supervisor = await supervisorOfWorkOrder(context.tx, workOrder.id)
        if (supervisor?.supervisorId) candidates.add(supervisor.supervisorId)
        for (const userId of await followersOf(context.tx, { type: WORK_ORDER, id: workOrder.id })) candidates.add(userId)
      } else {
        const supervisor = await supervisorOfOrder(context.tx, order.id)
        if (supervisor?.supervisorId) candidates.add(supervisor.supervisorId)
      }
      const drafts: Draft[] = []
      for (const userId of candidates) {
        const reader = await context.reader(userId)
        if (!reader) continue
        const may = workOrder ? reachesWorkOrder(reader.actor, WORKORDERS_MANAGE, workOrder) : can(reader.actor, WORKORDERS_MANAGE, { companyId: change.companyId, partyId: change.partyId })
        if (!may) continue
        drafts.push({
          userId,
          category: 'ASSIGNMENT',
          record: workOrder ? { type: WORK_ORDER, id: workOrder.id, label: workOrder.number } : { type: SALES_ORDER, id: order.id, label: order.number },
          companyId: change.companyId,
          anchor: `work-order-change:${change.id}`,
          messageKey: 'notifications.production.workOrderChangeProposed',
          params: { changeId: change.id, salesOrderId: order.id, workOrderId: workOrder?.id ?? null, kind: payload.kind },
          actorId: change.proposedById,
        })
      }
      return drafts
    },
  },
  {
    name: 'production.workOrderChangeDecided',
    events: ['work_order_change.applied', 'work_order_change.declined'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const applied = context.event?.type === 'work_order_change.applied'
      const payload = (applied ? workOrderChangeApplied : workOrderChangeDeclined).payload.parse(raw)
      const change = await context.tx.workOrderChange.findUnique({ where: { id: payload.changeId }, select: { id: true, companyId: true, partyId: true, proposedById: true, decidedById: true, madeWorkOrderId: true } })
      if (!change) return []
      const reader = await context.reader(change.proposedById)
      if (!reader) return []
      const workOrder = await workOrderOf(context, payload.workOrderId ?? change.madeWorkOrderId)
      if (!mayRead(reader.actor, change, workOrder)) return []
      const order = await context.tx.salesOrder.findUnique({ where: { id: payload.salesOrderId }, select: { id: true, number: true } })
      if (!order) return []
      return [
        {
          userId: change.proposedById,
          category: 'SYSTEM',
          // The door he can open: the work order when he reaches it, else the order.
          record: workOrder && reachesWorkOrder(reader.actor, WORKORDERS_VIEW, workOrder) ? { type: WORK_ORDER, id: workOrder.id, label: workOrder.number } : { type: SALES_ORDER, id: order.id, label: order.number },
          companyId: change.companyId,
          anchor: `work-order-change:${change.id}:decided`,
          messageKey: applied ? 'notifications.production.workOrderChangeApplied' : 'notifications.production.workOrderChangeDeclined',
          params: { changeId: change.id, salesOrderId: order.id, workOrderId: workOrder?.id ?? null, kind: payload.kind },
          actorId: change.decidedById,
        },
      ]
    },
  },
])

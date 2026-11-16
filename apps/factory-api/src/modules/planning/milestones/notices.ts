import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { events as gateEvents } from '@nexus/factory-domain/planning-milestones/events'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'

/**
 * The gate's owner is told (B-W2b-GB29, G221; B-W2b-263's gap "no notification to the gate's owner on a pass or a start
 * before"): when a pre-production gate of a sales order is marked done (`order_gate.changed` PASSED: by a person, by its
 * sample round's approval or by the order's leather released) or started before with a reason (STARTED_BEFORE), the person
 * who owns the gate (OrderGate.ownerId, the planner of it) gets a notification in the bell — SYSTEM for a pass, ALERT for a
 * start before (someone went ahead of their gate) — anchored to the gate (a replay tells nobody twice), if they still reach
 * Home (home.view) and see the plans of the order's company (planning.view). Quiet: nobody else, and never the person who
 * did it themselves. The sentence names the order only (no typed reason, no figure).
 */

const payloadSchema = gateEvents.find((event) => event.type === 'order_gate.changed')!.payload

export const GATE_OWNER_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'planning.gateOwnerTold',
    events: ['order_gate.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadSchema.parse(raw) as { gateId: string; salesOrderId: string; number: string; kind: string; change: string }
      if (payload.change !== 'PASSED' && payload.change !== 'STARTED_BEFORE') return []
      const gate = await context.tx.orderGate.findUnique({ where: { id: payload.gateId }, select: { companyId: true, ownerId: true, passedById: true, overriddenById: true } })
      if (!gate?.ownerId) return []
      const doneBy = payload.change === 'PASSED' ? gate.passedById : gate.overriddenById
      if (doneBy === gate.ownerId) return []
      const reader = await context.reader(gate.ownerId)
      if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PLANNING_VIEW, { companyId: gate.companyId })) return []
      return [
        {
          userId: gate.ownerId,
          category: payload.change === 'PASSED' ? 'SYSTEM' : 'ALERT',
          record: { type: 'OrderGate', id: payload.gateId, label: payload.number },
          companyId: gate.companyId,
          anchor: `gate:${payload.gateId}`,
          messageKey: payload.change === 'PASSED' ? 'notifications.planning.gatePassed' : 'notifications.planning.gateStartedBefore',
          params: { gateId: payload.gateId, salesOrderId: payload.salesOrderId, kind: payload.kind },
          // A gate passed by its event names the system: "The system", never a person.
          actorId: doneBy && doneBy !== SYSTEM_ACTOR_ID ? doneBy : null,
        },
      ]
    },
  },
])

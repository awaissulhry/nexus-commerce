import { HELD_WORK_ORDER_KINDS, holdWords, OPEN_ORDER_STATUSES, type GateKind } from '@nexus/factory-domain/planning/milestones/rules'
import { ScheduleRefusal } from '@nexus/factory-domain/planning/schedule/refusals'
import type { Reader } from '../store'

/**
 * The planning board holds a drop on a gate not passed (B-W2b-263; PLN-186; design planning.milestones conn "Planning board —
 * Gates hold drops", better "Gates stop scheduling, not just colour a date"). A work order that has not started yet (no
 * `startedAt`, not completed, closed or cancelled) and makes an open sales order that has a pre-production gate neither passed
 * nor started before (OrderGate, B-W2b-212) is not placed or moved on the site's working plan: the place / move answers 409
 * `refusal/GATE_NOT_PASSED` with one issue `gate/<gate id>` per gate (its message the gate's kind), and "Place all by due date"
 * skips it with the code GATE_NOT_PASSED. Sending a bar back to the tray is never held. The way on: pass the gate, or start
 * before it with a reason in Time & action (someone other than its planner).
 *
 * B-W2b-F22: only the order's production work orders are held (SIZE_GRID and MADE_TO_MEASURE). A sample work order makes the
 * sample that passes the gate, and a repair mends a garment already made: both are placed while the gate waits.
 *
 * This is a planning milestone, not a compliance gate: the one compliance gate at work-order release stays B-W2b-254's; a work
 * order's release by W1's route is not held here.
 */

export interface GateHold {
  readonly gateId: string
  readonly salesOrderId: string
  readonly orderNumber: string
  readonly kind: GateKind
  readonly label: string | null
}

const DONE = ['COMPLETED', 'CLOSED', 'CANCELLED']

/** Per production work order (among `workOrderIds`) that has not started: the WAITING gates of the open orders it makes. */
export async function gateHoldsOf(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, GateHold[]>> {
  const holds = new Map<string, GateHold[]>()
  if (workOrderIds.length === 0) return holds
  const workOrders = await db.workOrder.findMany({
    // B-W2b-F22: production work orders only, never a SAMPLE or a REPAIR.
    where: { id: { in: [...workOrderIds] }, kind: { in: [...HELD_WORK_ORDER_KINDS] }, startedAt: null, status: { notIn: DONE as ('COMPLETED' | 'CLOSED' | 'CANCELLED')[] } },
    select: { id: true, sizes: { select: { salesOrderLine: { select: { orderId: true } } } } },
  })
  const ordersOf = new Map(workOrders.map((row) => [row.id, [...new Set(row.sizes.map((size) => size.salesOrderLine.orderId))]]))
  const orderIds = [...new Set([...ordersOf.values()].flat())]
  if (orderIds.length === 0) return holds
  const gates = await db.orderGate.findMany({
    where: { salesOrderId: { in: orderIds }, passedAt: null, overriddenAt: null, salesOrder: { status: { in: [...OPEN_ORDER_STATUSES] } } },
    select: { id: true, salesOrderId: true, kind: true, label: true, salesOrder: { select: { number: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const [workOrderId, orders] of ordersOf) {
    const own = gates.filter((gate) => orders.includes(gate.salesOrderId)).map((gate) => ({ gateId: gate.id, salesOrderId: gate.salesOrderId, orderNumber: gate.salesOrder.number, kind: gate.kind as GateKind, label: gate.label }))
    if (own.length > 0) holds.set(workOrderId, own)
  }
  return holds
}

/** A place or move of this work order's bar is held while a gate waits (409 refusal/GATE_NOT_PASSED, issues gate/<id>). */
export async function assertNoGateHold(db: Reader, workOrder: { readonly id: string; readonly number: string }): Promise<void> {
  const gates = (await gateHoldsOf(db, [workOrder.id])).get(workOrder.id)
  if (!gates || gates.length === 0) return
  throw new ScheduleRefusal(
    'GATE_NOT_PASSED',
    holdWords(workOrder.number, gates),
    gates.map((gate) => ({ path: `gate/${gate.gateId}`, message: gate.kind })),
  )
}

import { passesGate, SAMPLE_GATE_KINDS, OPEN_ORDER_STATUSES } from '@nexus/factory-domain/planning/milestones/rules'
import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { passBySystemInCommand } from './gates'
import { orderFactsOf } from './world'

/**
 * Gates passed by their events (B-W2b-263; design planning.milestones live: "sample approved, lot released → gate milestones
 * marked done and the gate tile"). The worker's handlers (listed in background.ts), each in ONE system command (the tenant's
 * system scope; its key the event's id, so a repeat answers from the receipt):
 *
 *   planning.gatesOnSampleDecided   `sample_round.decided` APPROVED or APPROVED_WITH_COMMENTS → every WAITING sample gate
 *                                   (SAMPLE_APPROVED, PP_SAMPLE) of an open order that names the round passes
 *   planning.gatesOnLotReleased     `lot.released` of a LEATHER item → for each open order the lot is reserved for (through its
 *                                   work orders or its lines), its WAITING LEATHER_APPROVED gate passes once every leather lot
 *                                   reserved for the order is released
 *
 * The system is the one who passed (OrderGate.passedById = the system actor; the screens say "by its sample round" / "by the
 * leather's release"). A gate started before is passed all the same (both are kept). Nothing else is written.
 */

/** The WAITING sample gates of open orders that name this round. */
async function gatesOfRound(caller: CommandCaller, roundId: string): Promise<string[]> {
  return caller.withClient(async (db) => {
    const rows = await db.orderGate.findMany({ where: { sampleRoundId: roundId, passedAt: null, kind: { in: [...SAMPLE_GATE_KINDS] }, salesOrder: { status: { in: [...OPEN_ORDER_STATUSES] } } }, select: { id: true }, orderBy: { id: 'asc' } })
    return rows.map((row) => row.id)
  })
}

export async function passGatesOfRound(caller: CommandCaller, roundId: string, decision: string, cause: { readonly causationId?: string; readonly key: string }): Promise<string[]> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'system' || !passesGate(decision)) return []
  const gateIds = await gatesOfRound(caller, roundId)
  if (gateIds.length === 0) return []
  const { result } = await command(
    caller,
    { name: 'planning.milestones.passBySample', idempotencyKey: `order-gates-round:${cause.key}`, input: { sampleRoundId: roundId, gateIds }, ...(cause.causationId ? { causationId: cause.causationId } : {}) },
    async (tools) => {
      const passed = await passBySystemInCommand(tools, gateIds, 'SAMPLE', { sampleRoundId: roundId })
      if (passed.length === 0) tools.audit({ action: 'planning.milestones.passBySample', recordType: 'SampleRound', recordId: roundId, before: null, after: { passed: 0 } })
      return passed
    },
  )
  return result
}

/** The open orders a lot is reserved for (ACTIVE or ISSUED reservations, through their work orders or lines). */
async function ordersOfLot(caller: CommandCaller, lotId: string): Promise<string[]> {
  return caller.withClient(async (db) => {
    const reservations = await db.reservation.findMany({
      where: { lotId, status: { in: ['ACTIVE', 'ISSUED'] } },
      select: { workOrderId: true, salesOrderLine: { select: { orderId: true } } },
    })
    const workOrderIds = [...new Set(reservations.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
    const sizes = workOrderIds.length ? await db.workOrderSize.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { salesOrderLine: { select: { orderId: true } } } }) : []
    const ids = [...new Set([...reservations.flatMap((row) => (row.salesOrderLine ? [row.salesOrderLine.orderId] : [])), ...sizes.map((row) => row.salesOrderLine.orderId)])]
    if (ids.length === 0) return []
    const open = await db.salesOrder.findMany({ where: { id: { in: ids }, status: { in: [...OPEN_ORDER_STATUSES] } }, select: { id: true }, orderBy: { id: 'asc' } })
    return open.map((row) => row.id)
  })
}

export async function passLeatherGatesOfLot(caller: CommandCaller, lotId: string, itemId: string, cause: { readonly causationId?: string; readonly key: string }): Promise<string[]> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'system') return []
  const leather = await caller.withClient((db) => db.item.findUnique({ where: { id: itemId }, select: { kind: true } }))
  if (leather?.kind !== 'LEATHER') return []
  const orderIds = await ordersOfLot(caller, lotId)
  if (orderIds.length === 0) return []
  const gateIds = await caller.withClient(async (db) => {
    const gates = await db.orderGate.findMany({ where: { salesOrderId: { in: orderIds }, kind: 'LEATHER_APPROVED', passedAt: null }, select: { id: true, salesOrderId: true }, orderBy: { id: 'asc' } })
    if (gates.length === 0) return []
    const facts = await orderFactsOf(db, [...new Set(gates.map((gate) => gate.salesOrderId))])
    return gates.filter((gate) => facts.get(gate.salesOrderId)?.leather === 'PASSED').map((gate) => gate.id)
  })
  if (gateIds.length === 0) return []
  const { result } = await command(
    caller,
    { name: 'planning.milestones.passByLot', idempotencyKey: `order-gates-lot:${cause.key}`, input: { lotId, gateIds }, ...(cause.causationId ? { causationId: cause.causationId } : {}) },
    async (tools) => {
      const passed = await passBySystemInCommand(tools, gateIds, 'LOT', { lotId })
      if (passed.length === 0) tools.audit({ action: 'planning.milestones.passByLot', recordType: 'Lot', recordId: lotId, before: null, after: { passed: 0 } })
      return passed
    },
  )
  return result
}

/** The worker's handlers (background.ts): safe to repeat (a repeat finds nothing waiting, or answers from the receipt). */
export function gateHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'planning.gatesOnSampleDecided',
      events: ['sample_round.decided'],
      async handle(event, { caller }) {
        const payload = event.payload as { sampleRoundId: string; decision: string }
        await passGatesOfRound(caller, payload.sampleRoundId, payload.decision, { causationId: event.eventId, key: event.eventId })
      },
    }),
    defineHandler({
      name: 'planning.gatesOnLotReleased',
      events: ['lot.released'],
      async handle(event, { caller }) {
        const payload = event.payload as { lotId: string; itemId: string }
        await passLeatherGatesOfLot(caller, payload.lotId, payload.itemId, { causationId: event.eventId, key: event.eventId })
      },
    }),
  ]
}

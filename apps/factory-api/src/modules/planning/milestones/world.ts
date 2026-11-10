import type { Prisma } from '@nexus/factory-db'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { BUSINESS_TIME_ZONE, businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_MILESTONES_MANAGE, PLANNING_MILESTONES_OVERRIDE } from '@nexus/factory-domain/planning/milestones/permissions'
import {
  editRefusal,
  gateStateOf,
  GATE_LIMITS,
  HELD_WORK_ORDER_KINDS,
  isSampleGate,
  lateDays,
  leatherStateOf,
  milestoneOrder,
  milestoneStateOf,
  OPEN_ORDER_STATUSES,
  orderClosedRefusal,
  passRefusal,
  removeRefusal,
  startBeforeRefusal,
  tileCounts,
  type GateFacts,
  type GateKind,
  type LeatherState,
  type MilestoneKind,
} from '@nexus/factory-domain/planning/milestones/rules'
import type { GateView, MilestoneView, OrderView } from './contract'
import { action, GATE_COLUMNS, lacking, namesOf, ORDER_COLUMNS, SYSTEM_PASSER, type GateRow, type OrderRow, type Reader } from './store'

/**
 * Time & action's read model (B-W2b-263; design planning.milestones sec:gates, sec:calendar): the open sales orders the caller
 * plans for (planning.view over the order's company and customer), each with its gates and its milestones, and the tiles of
 * "Waiting on a gate". What the factory already records makes the milestones (templates stay Later):
 *
 *   gate    target = the gate's date; actual = the day it passed (the site's day); started before = the override
 *   start   target = the earliest bar of the order's work orders on the site's WORKING plan; actual = the first work order
 *           that started (WorkOrder.startedAt)
 *   ship    target = the promise date; actual = the first shipment that left (Shipment.shippedAt)
 *
 * A LEATHER_APPROVED gate says where the order's leather stands: the lots reserved (ACTIVE or ISSUED) for its work orders or
 * its lines, of a LEATHER item — none (not received), some not RELEASED (not passed), all RELEASED (passed: the gate passes by
 * the `lot.released` handler). Days are the business zone's (Europe/Rome).
 */

const day = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const DONE_WORK_ORDERS = ['COMPLETED', 'CLOSED', 'CANCELLED']

export interface WorldFilter {
  readonly companyId?: string | undefined
  readonly orderIds?: readonly string[] | undefined
  readonly q?: string | undefined
}

interface OrderFacts {
  readonly workOrders: { id: string; kind: string; status: string; startedAt: Date | null }[]
  readonly firstBar: Date | null
  readonly shippedAt: Date | null
  readonly leather: LeatherState
}

/** Per order: its work orders, the earliest bar on the working plan, the first shipment, the leather reserved for it. */
async function orderFactsOf(db: Reader, orderIds: readonly string[]): Promise<Map<string, OrderFacts>> {
  const empty = (): OrderFacts => ({ workOrders: [], firstBar: null, shippedAt: null, leather: 'NOT_RECEIVED' })
  const facts = new Map<string, { workOrders: OrderFacts['workOrders']; firstBar: Date | null; shippedAt: Date | null; lots: Map<string, string> }>(
    orderIds.map((id) => [id, { workOrders: [], firstBar: null, shippedAt: null, lots: new Map() }]),
  )
  if (orderIds.length === 0) return new Map()
  const ids = [...orderIds]
  const workOrders = await db.workOrder.findMany({
    where: { sizes: { some: { salesOrderLine: { orderId: { in: ids } } } } },
    select: { id: true, kind: true, status: true, startedAt: true, sizes: { select: { salesOrderLine: { select: { orderId: true } } } } },
  })
  const ordersOfWorkOrder = new Map<string, Set<string>>()
  for (const workOrder of workOrders) {
    const of = new Set(workOrder.sizes.map((size) => size.salesOrderLine.orderId).filter((id) => facts.has(id)))
    ordersOfWorkOrder.set(workOrder.id, of)
    for (const orderId of of) facts.get(orderId)!.workOrders.push({ id: workOrder.id, kind: workOrder.kind, status: workOrder.status, startedAt: workOrder.startedAt })
  }
  const workOrderIds = workOrders.map((row) => row.id)
  const [slots, shipments, reservations] = await Promise.all([
    workOrderIds.length ? db.scheduleSlot.findMany({ where: { planKind: 'WORKING', workOrderId: { in: workOrderIds } }, select: { workOrderId: true, startAt: true } }) : Promise.resolve([]),
    db.shipment.findMany({ where: { salesOrderId: { in: ids }, shippedAt: { not: null } }, select: { salesOrderId: true, shippedAt: true } }),
    db.reservation.findMany({
      where: {
        status: { in: ['ACTIVE', 'ISSUED'] },
        lotId: { not: null },
        item: { kind: 'LEATHER' },
        OR: [...(workOrderIds.length ? [{ workOrderId: { in: workOrderIds } }] : []), { salesOrderLine: { orderId: { in: ids } } }],
      },
      select: { workOrderId: true, salesOrderLine: { select: { orderId: true } }, lot: { select: { id: true, qualityStatus: true } } },
    }),
  ])
  for (const slot of slots) {
    for (const orderId of ordersOfWorkOrder.get(slot.workOrderId) ?? []) {
      const entry = facts.get(orderId)!
      if (entry.firstBar === null || slot.startAt < entry.firstBar) entry.firstBar = slot.startAt
    }
  }
  for (const shipment of shipments) {
    const entry = facts.get(shipment.salesOrderId)
    if (entry && shipment.shippedAt && (entry.shippedAt === null || shipment.shippedAt < entry.shippedAt)) entry.shippedAt = shipment.shippedAt
  }
  for (const reservation of reservations) {
    if (!reservation.lot) continue
    const orders = new Set<string>([...(reservation.workOrderId ? (ordersOfWorkOrder.get(reservation.workOrderId) ?? []) : []), ...(reservation.salesOrderLine ? [reservation.salesOrderLine.orderId] : [])])
    for (const orderId of orders) facts.get(orderId)?.lots.set(reservation.lot.id, reservation.lot.qualityStatus)
  }
  return new Map(
    [...facts].map(([id, entry]) => [
      id,
      { ...empty(), workOrders: entry.workOrders, firstBar: entry.firstBar, shippedAt: entry.shippedAt, leather: leatherStateOf([...entry.lots.values()].map((qualityStatus) => ({ qualityStatus }))) },
    ]),
  )
}

const notStarted = (workOrders: OrderFacts['workOrders']) => workOrders.filter((row) => row.startedAt === null && !DONE_WORK_ORDERS.includes(row.status)).length
/** B-W2b-F22: what a waiting gate holds on the board (schedule/gates.ts): production work orders not started, never a sample or a repair. */
const held = (workOrders: OrderFacts['workOrders']) => notStarted(workOrders.filter((row) => (HELD_WORK_ORDER_KINDS as readonly string[]).includes(row.kind)))

export interface WorldContext {
  readonly actor: Actor
  readonly actorId: string
  readonly now: Date
}

/** One gate as the screens draw it, with what may happen now. */
export function gateViewOf(gate: GateRow, order: OrderRow, round: { id: string; number: string; kind: string; decision: string | null } | null, names: ReadonlyMap<string, string>, facts: OrderFacts, world: WorldContext, today: BusinessDate): GateView {
  const kind = gate.kind as GateKind
  const gateFacts: GateFacts = {
    number: order.number,
    kind,
    orderStatus: order.status,
    passedAt: gate.passedAt,
    overriddenAt: gate.overriddenAt,
    ownerId: gate.ownerId,
    createdById: gate.createdById,
    round: round ? { number: round.number, decision: round.decision, kind: round.kind } : null,
  }
  const ownerId = gate.ownerId ?? gate.createdById
  const person = (id: string | null) => (id && names.has(id) ? { id, name: names.get(id)! } : null)
  const byEvent = gate.passedById === SYSTEM_PASSER
  return {
    id: gate.id,
    salesOrderId: gate.salesOrderId,
    kind,
    label: gate.label,
    targetDate: day(gate.targetDate),
    sampleRound: round,
    owner: person(ownerId),
    ownerId: gate.ownerId,
    makerId: gate.createdById,
    state: gateStateOf(gate),
    passedOn: gate.passedAt ? businessDate(gate.passedAt) : null,
    passedAt: at(gate.passedAt),
    passedBy: byEvent ? null : person(gate.passedById),
    via: gate.passedAt === null ? null : byEvent ? (isSampleGate(kind) ? 'SAMPLE' : 'LOT') : 'OFFICE',
    startedBefore: gate.overriddenAt && gate.overrideReason ? { at: toUtcIso(gate.overriddenAt), by: person(gate.overriddenById), reason: gate.overrideReason } : null,
    leather: kind === 'LEATHER_APPROVED' ? facts.leather : null,
    holds: held(facts.workOrders), // B-W2b-F22
    version: gate.version,
    actions: {
      pass: action(lacking(world.actor, PLANNING_MILESTONES_MANAGE, order), passRefusal(gateFacts, today, today)),
      startBefore: action(lacking(world.actor, PLANNING_MILESTONES_OVERRIDE, order), startBeforeRefusal(gateFacts, world.actorId)),
      edit: action(lacking(world.actor, PLANNING_MILESTONES_MANAGE, order), editRefusal(gateFacts)),
      remove: action(lacking(world.actor, PLANNING_MILESTONES_MANAGE, order), removeRefusal(gateFacts)),
    },
  }
}

function milestonesOf(order: OrderRow, gates: readonly GateView[], facts: OrderFacts, today: BusinessDate): MilestoneView[] {
  const row = (id: string, kind: MilestoneKind, gate: GateView | null, target: BusinessDate | null, actual: BusinessDate | null): MilestoneView => ({
    id,
    kind,
    gateId: gate?.id ?? null,
    gateKind: gate?.kind ?? null,
    label: gate?.label ?? null,
    salesOrderId: order.id,
    target,
    actual,
    state: milestoneStateOf(kind, gate?.state ?? null, actual),
    late: kind === 'GATE' && gate?.state === 'STARTED_BEFORE' ? null : lateDays(target, actual, today),
    owner: gate?.owner ?? null,
  })
  const started = facts.workOrders.map((workOrder) => workOrder.startedAt).filter((value): value is Date => value !== null)
  const firstStart = started.length ? new Date(Math.min(...started.map((value) => value.getTime()))) : null
  const rows = [
    ...gates.map((gate) => row(`gate:${gate.id}`, 'GATE', gate, gate.targetDate, gate.passedOn)),
    ...(facts.workOrders.length > 0 ? [row(`start:${order.id}`, 'START', null, facts.firstBar ? businessDate(facts.firstBar) : null, firstStart ? businessDate(firstStart) : null)] : []),
    row(`ship:${order.id}`, 'SHIP', null, day(order.promiseDate), facts.shippedAt ? businessDate(facts.shippedAt) : null),
  ]
  return rows.sort(milestoneOrder)
}

/** The orders' gates, milestones and the tiles, as the page reads them (see above). */
export async function readWorld(db: Reader, world: WorldContext, filter: WorldFilter): Promise<{ today: BusinessDate; timeZone: string; tiles: ReturnType<typeof tileCounts>; orders: OrderView[]; truncated: boolean }> {
  const today = businessDate(world.now)
  const q = filter.q?.trim()
  const where: Prisma.SalesOrderWhereInput = {
    AND: [
      scopeWhere(world.actor, PLANNING_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput,
      filter.orderIds ? { id: { in: [...filter.orderIds] } } : { status: { in: [...OPEN_ORDER_STATUSES] } },
      filter.companyId ? { companyId: filter.companyId } : {},
      q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { customerRef: { contains: q, mode: 'insensitive' } }] } : {},
    ],
  }
  const found = await db.salesOrder.findMany({ where, orderBy: [{ promiseDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }], take: GATE_LIMITS.orders + 1, select: ORDER_COLUMNS })
  const orders = found.slice(0, GATE_LIMITS.orders)
  const ids = orders.map((row) => row.id)
  const [gates, parties, facts] = await Promise.all([
    ids.length ? db.orderGate.findMany({ where: { salesOrderId: { in: ids } }, select: GATE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : Promise.resolve([] as GateRow[]),
    ids.length ? db.party.findMany({ where: { id: { in: [...new Set(orders.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : Promise.resolve([]),
    orderFactsOf(db, ids),
  ])
  const roundIds = [...new Set(gates.flatMap((gate) => (gate.sampleRoundId ? [gate.sampleRoundId] : [])))]
  const [rounds, names] = await Promise.all([
    roundIds.length ? db.sampleRound.findMany({ where: { id: { in: roundIds } }, select: { id: true, number: true, kind: true, decision: true } }) : Promise.resolve([]),
    namesOf(db, gates.flatMap((gate) => [gate.ownerId, gate.createdById, gate.passedById, gate.overriddenById])),
  ])
  const roundOf = new Map(rounds.map((row) => [row.id, row]))
  const partyOf = new Map(parties.map((row) => [row.id, row]))
  const views: OrderView[] = orders.map((order) => {
    const own = facts.get(order.id) ?? { workOrders: [], firstBar: null, shippedAt: null, leather: 'NOT_RECEIVED' as const }
    const gateViews = gates.filter((gate) => gate.salesOrderId === order.id).map((gate) => gateViewOf(gate, order, gate.sampleRoundId ? (roundOf.get(gate.sampleRoundId) ?? null) : null, names, own, world, today))
    const milestones = milestonesOf(order, gateViews, own, today)
    const party = partyOf.get(order.partyId)
    const next = milestones.find((row) => row.state === 'WAITING' || row.state === 'TO_COME') ?? null
    return {
      id: order.id,
      number: order.number,
      companyId: order.companyId,
      customer: { id: order.partyId, code: party?.code ?? '', name: party ? (party.tradeName ?? party.legalName) : '' },
      status: order.status,
      promiseDate: day(order.promiseDate),
      customerRef: order.customerRef,
      workOrders: { count: own.workOrders.length, notStarted: notStarted(own.workOrders) },
      gates: gateViews,
      milestones,
      waiting: gateViews.filter((gate) => gate.state === 'WAITING').map((gate) => gate.kind),
      late: milestones.filter((row) => row.late !== null && row.state !== 'DONE').length,
      next: next?.id ?? null,
      mayAddGate: (() => {
        const needs = lacking(world.actor, PLANNING_MILESTONES_MANAGE, order)
        const refusal = orderClosedRefusal({ number: order.number, orderStatus: order.status })
        return { allowed: needs === null && refusal === null, needs, refusal }
      })(),
    }
  })
  const tiles = tileCounts(views.flatMap((order) => order.gates.map((gate) => ({ salesOrderId: order.id, kind: gate.kind, state: gate.state, leather: gate.leather }))))
  return { today, timeZone: BUSINESS_TIME_ZONE, tiles, orders: views, truncated: found.length > GATE_LIMITS.orders }
}

/** One gate's view after a write (its order's facts read again). */
export async function readGateView(db: Reader, world: WorldContext, gateId: string): Promise<GateView> {
  const gate = await db.orderGate.findUniqueOrThrow({ where: { id: gateId }, select: GATE_COLUMNS })
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: gate.salesOrderId }, select: ORDER_COLUMNS })
  const [facts, round, names] = await Promise.all([
    orderFactsOf(db, [order.id]),
    gate.sampleRoundId ? db.sampleRound.findUnique({ where: { id: gate.sampleRoundId }, select: { id: true, number: true, kind: true, decision: true } }) : Promise.resolve(null),
    namesOf(db, [gate.ownerId, gate.createdById, gate.passedById, gate.overriddenById]),
  ])
  return gateViewOf(gate, order, round, names, facts.get(order.id) ?? { workOrders: [], firstBar: null, shippedAt: null, leather: 'NOT_RECEIVED' }, world, businessDate(world.now))
}

export { orderFactsOf }

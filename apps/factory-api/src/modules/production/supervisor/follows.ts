import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { brandSupervisorChanged } from '@nexus/factory-domain/production-brand/events'
import { effectiveSupervisor, SUPERVISED_ORDER_STATES, workOrderSupervisor, type SupervisorSource } from '@nexus/factory-domain/production-brand/supervisor'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { followInCommand, unfollowInCommand, type FollowedRecord } from '../../../platform/threads/followers'
import { mayOnThread, type WallScope } from '../../../platform/threads/records'
import { customerDefaultsOf, orderSupervisorsOf, type Reader } from './resolver'

/**
 * B-PR-42b — the production supervisor follows (production plan §1 "The supervisor follows every open order of that brand, so
 * every brand message reaches him at once (unless he muted that order — his band then says so)"; lead picks L22; review fixes
 * R-58, R-60; threads agreement T5). The worker's handler `production.supervisorFollows` makes each record's production
 * supervisor (./resolver: an order's own, else its customer's default; a work order's single order's, else the default) follow
 * that record's thread — the sales order's and each of its work orders' — through threads' exported seam `followInCommand`
 * (reason ASSIGNEE), for OPEN orders only (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED: not shipped, not cancelled):
 *
 *   brand_production.supervisor_changed   ORDER: the orders named and their work orders made of that one order; BRAND (the
 *                                         customer's default): every open order of the customer, and its work orders, whose
 *                                         supervisor IS the default (an order with its own keeps it). The person each replaces
 *                                         (`previousIds`) stops following there through threads' `unfollowInCommand` — only a
 *                                         follow made for that reason (ASSIGNEE) and not muted, and never while he holds an
 *                                         OPEN task on the record (a task's own follow is ASSIGNEE too)
 *   sales_order.created (an open order),   a new order: its supervisor follows at once (and the work orders of that one order)
 *   sales_order.status_changed → CONFIRMED
 *   workorder.created                      a new work order: its supervisor follows at once
 *
 * Only through threads' seams — never a write to RecordFollower here. `followInCommand` adds nothing when the person has a row:
 * a muted follow stays muted (the band's "You muted this order", F-PR-21, reads it: resolver recordSupervisorOf), and a person's
 * own unfollow is not undone by an order's later status moves (only these events follow). THE WALL (PW-14): a follow is made
 * only while the person — ACTIVE, an office person — reads that record's thread by his live roles (`mayOnThread` over the
 * record's scope: a work order's through its customer), re-checked per record.
 *
 * A customer's default can move hundreds of orders: the records are read once, and written in commands of at most 200 records
 * (FOLLOW_CHUNK), each one system command with one summary audit row naming only that customer's records; never in the request
 * that changed the supervisor (B-PR-42a). A record with nothing to do writes nothing. Idempotent by construction (a follow row
 * is made once; an unfollow finds nothing the second time): a repeated job changes nothing.
 */

export const SUPERVISOR_FOLLOWS_HANDLER = 'production.supervisorFollows'
/** The most records one command follows or unfollows. */
export const FOLLOW_CHUNK = 200
export const SUPERVISOR_FOLLOW_EVENTS = ['brand_production.supervisor_changed', 'sales_order.created', 'sales_order.status_changed', 'workorder.created'] as const

/** A work order that no longer works takes no follow. */
const ENDED_WORK_ORDER = ['CLOSED', 'CANCELLED'] as const

export type SupervisedType = 'SalesOrder' | 'WorkOrder'

/** A record with a production supervisor, as the worker reads it: its place, its customer and its supervisor now. */
export interface SupervisedRecord {
  readonly type: SupervisedType
  readonly id: string
  readonly companyId: string
  readonly siteId: string | null
  readonly partyId: string
  /** The supervisor now (null: none), and from where. */
  readonly supervisorId: string | null
  readonly from: SupervisorSource | null
  /** An order: itself; a work order: the distinct sales orders its cells make. */
  readonly orderIds: readonly string[]
}

/**
 * The open orders asked (by id, or every open order of a customer) and the work orders made of their lines (plus those asked by
 * id), each with its supervisor now. Work orders of no customer, closed or cancelled, take none. Read in the caller's scope.
 */
export async function supervisedRecords(db: Reader, input: { readonly orderIds?: readonly string[]; readonly partyId?: string; readonly workOrderIds?: readonly string[] }): Promise<SupervisedRecord[]> {
  const askedOrders = (input.orderIds ?? []).filter(isUuid)
  const orders =
    askedOrders.length > 0 || input.partyId !== undefined
      ? await db.salesOrder.findMany({
          where: { status: { in: [...SUPERVISED_ORDER_STATES] }, ...(input.orderIds !== undefined ? { id: { in: askedOrders } } : {}), ...(input.partyId !== undefined ? { partyId: input.partyId } : {}) },
          select: { id: true, companyId: true, partyId: true },
          orderBy: { id: 'asc' },
        })
      : []
  const openIds = orders.map((order) => order.id)
  const made = openIds.length === 0 ? [] : (await db.workOrderSize.findMany({ where: { salesOrderLine: { orderId: { in: openIds } } }, select: { workOrderId: true } })).map((cell) => cell.workOrderId)
  const workOrderIds = [...new Set([...made, ...(input.workOrderIds ?? []).filter(isUuid)])]
  const workOrders =
    workOrderIds.length === 0
      ? []
      : await db.workOrder.findMany({ where: { id: { in: workOrderIds }, partyId: { not: null }, status: { notIn: [...ENDED_WORK_ORDER] } }, select: { id: true, companyId: true, siteId: true, partyId: true }, orderBy: { id: 'asc' } })
  const cells = workOrders.length === 0 ? [] : await db.workOrderSize.findMany({ where: { workOrderId: { in: workOrders.map((row) => row.id) } }, select: { workOrderId: true, salesOrderLine: { select: { orderId: true } } } })
  const ordersOf = new Map<string, string[]>()
  for (const cell of cells) {
    if (!cell.salesOrderLine) continue
    const list = ordersOf.get(cell.workOrderId) ?? []
    if (!list.includes(cell.salesOrderLine.orderId)) list.push(cell.salesOrderLine.orderId)
    ordersOf.set(cell.workOrderId, list)
  }
  const own = await orderSupervisorsOf(db, [...openIds, ...[...ordersOf.values()].flat()])
  const defaults = await customerDefaultsOf(db, [...orders.map((order) => order.partyId), ...workOrders.flatMap((row) => (row.partyId !== null ? [row.partyId] : []))])
  const records: SupervisedRecord[] = orders.map((order) => {
    const found = effectiveSupervisor(own.get(order.id) ?? null, defaults.get(order.partyId)?.supervisorId ?? null)
    return { type: 'SalesOrder', id: order.id, companyId: order.companyId, siteId: null, partyId: order.partyId, supervisorId: found.userId, from: found.from, orderIds: [order.id] }
  })
  for (const row of workOrders) {
    const partyId = row.partyId!
    const orderIds = ordersOf.get(row.id) ?? []
    const found = workOrderSupervisor({ orders: orderIds.map((salesOrderId) => ({ salesOrderId, supervisorId: own.get(salesOrderId) ?? null })), customerDefault: defaults.get(partyId)?.supervisorId ?? null })
    records.push({ type: 'WorkOrder', id: row.id, companyId: row.companyId, siteId: row.siteId, partyId, supervisorId: found.userId, from: found.from, orderIds })
  }
  return records
}

/** What one event asks: the records to look at (one customer's), and the people they may replace. */
export interface FollowAsk {
  readonly partyId: string
  readonly records: readonly SupervisedRecord[]
  /** Who stops following where he is no longer the supervisor (empty: a new order or work order only adds). */
  readonly previousIds: readonly string[]
}

const text = (payload: unknown, key: string): string | null => {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : null
}

/** The records an event names (null: nothing to follow). Read in the caller's scope (the job's: system). */
export async function followAskOf(db: Reader, event: Pick<EventEnvelope, 'type' | 'payload'>): Promise<FollowAsk | null> {
  switch (event.type) {
    case 'brand_production.supervisor_changed': {
      const payload = brandSupervisorChanged.payload.parse(event.payload)
      if (payload.scope === 'ORDER') {
        const named = new Set(payload.orderIds)
        const records = (await supervisedRecords(db, { orderIds: payload.orderIds })).filter(
          (record) => record.partyId === payload.partyId && (record.type === 'SalesOrder' ? named.has(record.id) : record.orderIds.length === 1 && named.has(record.orderIds[0]!)),
        )
        return { partyId: payload.partyId, records, previousIds: payload.previousIds }
      }
      // BRAND: the records that follow the customer's default (an order or a work order with its own supervisor keeps him).
      const records = (await supervisedRecords(db, { partyId: payload.partyId })).filter((record) => record.partyId === payload.partyId && record.from !== 'ORDER')
      return { partyId: payload.partyId, records, previousIds: payload.previousIds }
    }
    case 'sales_order.created':
    case 'sales_order.status_changed': {
      // A new order follows once, when it is first open (made CONFIRMED, or confirmed after its approval): later moves of its
      // status never follow again (a person's own unfollow lasts).
      if (event.type === 'sales_order.status_changed' && text(event.payload, 'to') !== 'CONFIRMED') return null
      const orderId = text(event.payload, 'orderId')
      if (!orderId || !isUuid(orderId)) return null
      const records = (await supervisedRecords(db, { orderIds: [orderId] })).filter((record) => (record.type === 'SalesOrder' ? record.id === orderId : record.orderIds.length === 1 && record.orderIds[0] === orderId))
      const order = records.find((record) => record.type === 'SalesOrder')
      return order ? { partyId: order.partyId, records: records.filter((record) => record.partyId === order.partyId), previousIds: [] } : null
    }
    case 'workorder.created': {
      const workOrderId = text(event.payload, 'workOrderId')
      if (!workOrderId || !isUuid(workOrderId)) return null
      const record = (await supervisedRecords(db, { workOrderIds: [workOrderId] })).find((row) => row.type === 'WorkOrder' && row.id === workOrderId)
      return record ? { partyId: record.partyId, records: [record], previousIds: [] } : null
    }
    default:
      return null
  }
}

/** A record's scope as threads' checks read it (a work order's customer is its WALL party: never shared). */
export const scopeOfRecord = (record: Pick<SupervisedRecord, 'type' | 'companyId' | 'siteId' | 'partyId'>): WallScope =>
  record.type === 'WorkOrder' ? { companyId: record.companyId, siteId: record.siteId, partyId: null, wallPartyId: record.partyId } : { companyId: record.companyId, siteId: null, partyId: record.partyId }

/** The office actor of a person's live roles (two-factor taken as proved), or null: not an ACTIVE office person. Cached per run. */
export function personActors(db: Reader, tenantId: string, now: Date): (userId: string) => Promise<Actor | null> {
  const cache = new Map<string, Actor | null>()
  return async (userId) => {
    if (cache.has(userId)) return cache.get(userId)!
    const user = await db.user.findFirst({ where: { id: userId, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
    const actor: Actor | null = user ? { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) } : null
    cache.set(userId, actor)
    return actor
  }
}

/** One record's work: who follows it now, and who stops. */
export interface FollowMove {
  readonly record: SupervisedRecord
  readonly follow: string | null
  readonly unfollow: readonly string[]
}

/**
 * What to do on each record (only those with something to do): the supervisor follows when he reads the record and has no
 * follow row yet; each person replaced stops when his row is an ASSIGNEE follow, not muted, and he holds no OPEN task there.
 */
export async function followMoves(db: Reader, tenantId: string, ask: FollowAsk, now: Date): Promise<FollowMove[]> {
  const actorOf = personActors(db, tenantId, now)
  const people = [...new Set([...ask.records.flatMap((record) => (record.supervisorId !== null ? [record.supervisorId] : [])), ...ask.previousIds])]
  if (people.length === 0 || ask.records.length === 0) return []
  const rows = await db.recordFollower.findMany({
    where: { userId: { in: people }, OR: ask.records.map((record) => ({ recordType: record.type, recordId: record.id })) },
    select: { recordType: true, recordId: true, userId: true, reason: true, muted: true },
  })
  const rowOf = (record: SupervisedRecord, userId: string) => rows.find((row) => row.recordType === record.type && row.recordId === record.id && row.userId === userId)
  const tasks =
    ask.previousIds.length === 0
      ? []
      : await db.task.findMany({ where: { status: 'OPEN', assigneeId: { in: [...ask.previousIds] }, OR: ask.records.map((record) => ({ recordType: record.type, recordId: record.id })) }, select: { recordType: true, recordId: true, assigneeId: true } })
  const moves: FollowMove[] = []
  for (const record of ask.records) {
    let follow: string | null = null
    if (record.supervisorId !== null && !rowOf(record, record.supervisorId)) {
      const actor = await actorOf(record.supervisorId)
      if (actor && mayOnThread(actor, THREADS_READ, record.type, scopeOfRecord(record))) follow = record.supervisorId
    }
    const unfollow = ask.previousIds.filter((userId) => {
      if (userId === record.supervisorId) return false
      const row = rowOf(record, userId)
      if (!row || row.reason !== 'ASSIGNEE' || row.muted) return false
      return !tasks.some((task) => task.recordType === record.type && task.recordId === record.id && task.assigneeId === userId)
    })
    if (follow !== null || unfollow.length > 0) moves.push({ record, follow, unfollow })
  }
  return moves
}

/** Splits a list into chunks of `size`. */
export const chunksOf = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))

const followedOf = (record: SupervisedRecord): FollowedRecord => ({ type: record.type, id: record.id, companyId: record.companyId, siteId: record.siteId })

/** One chunk's command: the follows and unfollows through threads' seams, and one audit row of that customer's records. */
async function writeChunk(tools: CommandTools, ask: FollowAsk, moves: readonly FollowMove[], eventType: string): Promise<{ followed: number; unfollowed: number }> {
  const followed: { type: string; id: string; userId: string }[] = []
  const unfollowed: { type: string; id: string; userId: string }[] = []
  for (const move of moves) {
    if (move.follow !== null && (await followInCommand(tools, followedOf(move.record), move.follow, 'ASSIGNEE', null))) followed.push({ type: move.record.type, id: move.record.id, userId: move.follow })
    for (const userId of move.unfollow) if (await unfollowInCommand(tools, followedOf(move.record), userId, 'ASSIGNEE')) unfollowed.push({ type: move.record.type, id: move.record.id, userId })
  }
  // Every command records a row: this customer's records only (one customer per event, per chunk).
  tools.audit({ action: SUPERVISOR_FOLLOWS_HANDLER, recordType: 'Party', recordId: ask.partyId, companyId: moves[0]?.record.companyId ?? null, after: { eventType, records: moves.length, followed, unfollowed } })
  return { followed: followed.length, unfollowed: unfollowed.length }
}

/** One event's follows (the handler's work; tests call it with the system caller). How many follows were made and taken back. */
export async function supervisorFollows(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>): Promise<{ followed: number; unfollowed: number }> {
  const context = caller.factoryContext
  const tenantId = context && 'tenantId' in context ? context.tenantId : undefined
  if (!tenantId) return { followed: 0, unfollowed: 0 }
  const now = serverClock.now()
  const plan = await caller.withClient(async (db) => {
    const ask = await followAskOf(db, event)
    return ask ? { ask, moves: await followMoves(db, tenantId, ask, now) } : null
  })
  if (!plan || plan.moves.length === 0) return { followed: 0, unfollowed: 0 }
  let followed = 0
  let unfollowed = 0
  for (const [index, chunk] of chunksOf(plan.moves, FOLLOW_CHUNK).entries()) {
    const { result } = await command(
      caller,
      { name: SUPERVISOR_FOLLOWS_HANDLER, input: { eventId: event.eventId, chunk: index, records: chunk.map((move) => `${move.record.type}:${move.record.id}`) }, causationId: event.eventId },
      (tools) => writeChunk(tools, plan.ask, chunk, event.type),
    )
    followed += result.followed
    unfollowed += result.unfollowed
  }
  return { followed, unfollowed }
}

/** The worker's `production.supervisorFollows` (background.ts). */
export function supervisorFollowsHandler(): EventHandler {
  return defineHandler({
    name: SUPERVISOR_FOLLOWS_HANDLER,
    events: SUPERVISOR_FOLLOW_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      await supervisorFollows(caller, event)
    },
  })
}

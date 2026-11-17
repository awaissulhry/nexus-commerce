import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { assertOneParty, brandHealthChanged } from '@nexus/factory-domain/production-brand/events'
import { effectiveHealth, raiseProblems, raiseUntil, type BrandHealth, type HealthRaise, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { PRODUCTION_BRAND_MANAGE } from '@nexus/factory-domain/production-brand/permissions'
import type { WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { NOT_IN_PRODUCTION_WORDS } from '@nexus/factory-domain/production-brand/words'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../work-orders/access'
import { asDay, dayOf, type Reader } from '../work-orders/store'
import { isKeptState } from './facts'

/**
 * B-PR-35 — the factory raises an order's health by hand (production plan §4 "Health": "a person may raise it to 'At risk' with a
 * reason code (drops after 7 days or when the computed health changes). The brand reads the chip and the reason code; free text
 * goes through the thread."; review fix R-10, decision D3; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well.").
 *
 *   raise  PUT /production/brand-orders/:orderId/health {reasonCode, note?, version?} (production.brand.manage): ONLY to AT_RISK,
 *          only from a better computed health (ON_TRACK, NO_DATE: a typed raise never hides a computed Late, and an order already
 *          at risk needs none — factory-domain production-brand/health raiseProblems), with one curated reason the customer reads
 *          and the office's own one-line note it never reads. It stands until set day + 7 (`healthSetUntil`); the keeper (B-PR-17,
 *          ./keeper planKeep) drops it at its next pass after that day, or as soon as the computed health changes. A second raise
 *          while one stands replaces its reason and note and starts its 7 days again (the customer still reads At risk).
 *   clear  DELETE the same (production.brand.manage): the computed health is what the customer reads again.
 *   read   GET the same (workorders.view): the computed and the effective health, the raise with its note (office only), who and
 *          when, what the order waits on.
 *
 * The wall: the order is found by its id, then the caller must reach its company AND its customer (workorders.view or
 * production.brand.manage) — another customer's order is "Sales order not found.", the words of an unknown id; seen but not managed
 * is forbidden. Each write is ONE command under the keeper's own advisory lock of the order (`factory.brand-keeper|<order>`), so a
 * keeper pass and a raise never cross: the production state's row is read under it (its version when sent), written, audited on
 * the row (the note included: the audit is the office's), and `brand_production.health_changed` {byNote: true} is told when the
 * health the customer reads changed — in the order's own customer's name (assertOneParty): the customer reads the chip and the
 * reason, never the note (the event carries none; its partner live fields are orderId, partyId, health).
 */

const ROW_SELECT = {
  id: true,
  partyId: true,
  salesOrderId: true,
  health: true,
  healthSet: true,
  healthReasonCode: true,
  healthNote: true,
  healthSetAt: true,
  healthSetById: true,
  healthSetUntil: true,
  waitingOn: true,
  waitingSince: true,
  version: true,
} as const

interface StateRow {
  readonly id: string
  readonly partyId: string
  readonly salesOrderId: string
  readonly health: BrandHealth | null
  readonly healthSet: BrandHealth | null
  readonly healthReasonCode: HealthReasonCode | null
  readonly healthNote: string | null
  readonly healthSetAt: Date | null
  readonly healthSetById: string | null
  readonly healthSetUntil: BusinessDate | null
  readonly waitingOn: WaitingOn | null
  readonly waitingSince: Date | null
  readonly version: number
}

interface OrderRow {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
  readonly status: string
}

const ORDER_SELECT = { id: true, number: true, companyId: true, partyId: true, status: true } as const

async function readOrder(db: Reader, orderId: string): Promise<OrderRow | null> {
  return isUuid(orderId) ? db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT }) : null
}

async function readState(db: Reader, orderId: string): Promise<StateRow | null> {
  const row = await db.brandOrderProduction.findFirst({ where: { key: `brand-production:${orderId}` }, select: ROW_SELECT })
  if (!row) return null
  return {
    ...row,
    health: row.health as BrandHealth | null,
    healthSet: row.healthSet as BrandHealth | null,
    healthReasonCode: row.healthReasonCode as HealthReasonCode | null,
    healthSetUntil: row.healthSetUntil ? dayOf(row.healthSetUntil) : null,
    waitingOn: row.waitingOn as WaitingOn | null,
  }
}

/**
 * The order the caller may see (its company and customer, with workorders.view or production.brand.manage; else not found, as an
 * unknown id) and act on with `permission` (else forbidden).
 */
async function officeOrder(caller: CommandCaller, orderId: string, permission?: Permission): Promise<OrderRow> {
  const actor = actorOf(officeContextOf(caller))
  const order = await caller.withClient((client) => readOrder(client, orderId))
  const at = order ? { companyId: order.companyId, partyId: order.partyId } : null
  if (!order || !at || !(can(actor, WORKORDERS_VIEW, at) || can(actor, PRODUCTION_BRAND_MANAGE, at))) throw new NotFoundError('Sales order not found.')
  if (permission && !can(actor, permission, at)) throw new ForbiddenError()
  return order
}

/** The raise kept on the row, as the domain reads it (null: none). */
const raiseOf = (row: StateRow): HealthRaise | null => (row.healthSet !== null && row.healthReasonCode !== null && row.healthSetUntil !== null ? { reasonCode: row.healthReasonCode, until: row.healthSetUntil } : null)

/** The raise when it still counts today (past its days it no longer counts, even before the keeper drops it). */
const standingRaise = (row: StateRow, today: BusinessDate): HealthRaise | null => {
  const raise = raiseOf(row)
  return raise !== null && today < raise.until ? raise : null
}

async function viewOf(db: Reader, order: OrderRow, row: StateRow | null, today: BusinessDate) {
  if (row === null) {
    return { orderId: order.id, number: order.number, partyId: order.partyId, kept: false, computed: null, health: null, reasonCode: null, raise: null, waitingOn: null, waitingSince: null, version: null }
  }
  const effective = effectiveHealth(row.health, standingRaise(row, today))
  const setBy = row.healthSetById ? await db.user.findUnique({ where: { id: row.healthSetById }, select: { id: true, displayName: true } }) : null
  const raise = raiseOf(row)
  return {
    orderId: order.id,
    number: order.number,
    partyId: order.partyId,
    kept: true,
    computed: row.health,
    health: effective.health,
    reasonCode: effective.reasonCode,
    raise:
      raise !== null && row.healthSetAt !== null
        ? { reasonCode: raise.reasonCode, note: row.healthNote, setAt: toUtcIso(row.healthSetAt), setBy: setBy ? { id: setBy.id, name: setBy.displayName } : null, until: raise.until, stands: today < raise.until }
        : null,
    waitingOn: row.waitingOn,
    waitingSince: row.waitingSince ? toUtcIso(row.waitingSince) : null,
    version: row.version,
  }
}

/** GET /production/brand-orders/:orderId/health (workorders.view). */
export async function getBrandHealth(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => ({ health: await viewOf(client, order, await readState(client, orderId), businessDate(serverClock.now())) }))
}

/** The keeper's own lock of the order (./keeper keepOrder): a raise and a keeper pass never cross. */
const lockOrder = (tools: CommandTools, orderId: string) => tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.brand-keeper', ${orderId}::uuid), 0))`

/** Under the lock: the order still in production, its production state made, at the version sent. */
async function lockedState(tools: CommandTools, orderId: string, version: number | undefined): Promise<{ order: OrderRow; row: StateRow }> {
  await lockOrder(tools, orderId)
  const order = (await readOrder(tools.tx, orderId))!
  if (!isKeptState(order.status)) throw new InvalidStateError(NOT_IN_PRODUCTION_WORDS.en)
  const row = await readState(tools.tx, orderId)
  if (!row) throw new InvalidStateError('This order has no production state yet: it is made when the order is confirmed. Try again in a moment.')
  if (version !== undefined && version !== row.version) throw new StaleVersionError('BrandOrderProduction', row.id, row.version, version)
  return { order, row }
}

/** Tells the customer's health moved by a person's hand (its own customer's name only). */
function tellHealth(tools: CommandTools, order: OrderRow, row: StateRow, before: BrandHealth | null, after: BrandHealth | null): void {
  if (before === after) return
  assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, new Map([[order.id, row.partyId]]))
  tools.emit(eventFor(brandHealthChanged, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, health: after, previous: before, byNote: true } }))
}

const raiseState = (row: StateRow) => ({ raised: row.healthSet !== null, reasonCode: row.healthReasonCode, note: row.healthNote, until: row.healthSetUntil })

export interface RaiseBody {
  readonly reasonCode: HealthReasonCode
  readonly note?: string | null | undefined
  readonly version?: number | undefined
}

/** PUT /production/brand-orders/:orderId/health (production.brand.manage): the order's health raised to At risk, with a reason. */
export async function raiseBrandHealth(caller: CommandCaller, orderId: string, body: RaiseBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  await officeOrder(caller, orderId, PRODUCTION_BRAND_MANAGE)
  const note = body.note?.trim() || null
  // The reason and the note first (400); the order's health under the lock (409).
  const asked = raiseProblems({ computed: 'ON_TRACK', reasonCode: body.reasonCode, note })
  if (asked.length > 0) throw new ValidationError(asked.length === 1 ? asked[0]!.message : 'This raise is not valid.', asked)
  const { result } = await command(caller, { name: 'production.raiseBrandHealth', idempotencyKey, input: { orderId, reasonCode: body.reasonCode, note, version: body.version ?? null } }, async (tools) => {
    const { order, row } = await lockedState(tools, orderId, body.version)
    const today = businessDate(tools.now)
    const refused = raiseProblems({ computed: row.health, reasonCode: body.reasonCode, note: null })
    if (refused.length > 0) throw new InvalidStateError(refused[0]!.message)
    const before = effectiveHealth(row.health, standingRaise(row, today)).health
    const until = raiseUntil(today)
    await tools.tx.brandOrderProduction.update({
      where: { id: row.id },
      data: { healthSet: 'AT_RISK', healthReasonCode: body.reasonCode, healthNote: note, healthSetAt: tools.now, healthSetById: context.actorId, healthSetUntil: asDay(until), updatedAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({
      recordType: 'BrandOrderProduction',
      recordId: row.id,
      companyId: order.companyId,
      before: { salesOrderId: order.id, computed: row.health, ...raiseState(row) },
      after: { salesOrderId: order.id, computed: row.health, raised: true, health: 'AT_RISK', reasonCode: body.reasonCode, note, until },
      reason: `Raised to At risk: ${body.reasonCode}.`,
    })
    tellHealth(tools, order, row, before, 'AT_RISK')
    return { health: await viewOf(tools.tx, order, await readState(tools.tx, orderId), today) }
  })
  return result
}

/** DELETE /production/brand-orders/:orderId/health (production.brand.manage): the raise cleared; the computed health counts again. */
export async function clearBrandHealth(caller: CommandCaller, orderId: string, version: number | undefined, idempotencyKey?: string) {
  await officeOrder(caller, orderId, PRODUCTION_BRAND_MANAGE)
  const { result } = await command(caller, { name: 'production.clearBrandHealth', idempotencyKey, input: { orderId, version: version ?? null } }, async (tools) => {
    const { order, row } = await lockedState(tools, orderId, version)
    if (row.healthSet === null) throw new InvalidStateError('No raise stands on this order: the customer reads its computed health.')
    const today = businessDate(tools.now)
    const before = effectiveHealth(row.health, standingRaise(row, today)).health
    await tools.tx.brandOrderProduction.update({
      where: { id: row.id },
      data: { healthSet: null, healthReasonCode: null, healthNote: null, healthSetAt: null, healthSetById: null, healthSetUntil: null, updatedAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({
      recordType: 'BrandOrderProduction',
      recordId: row.id,
      companyId: order.companyId,
      before: { salesOrderId: order.id, computed: row.health, ...raiseState(row) },
      after: { salesOrderId: order.id, computed: row.health, raised: false, health: row.health },
      reason: 'The raise to At risk was cleared.',
    })
    tellHealth(tools, order, row, before, row.health)
    return { health: await viewOf(tools.tx, order, await readState(tools.tx, orderId), today) }
  })
  return result
}

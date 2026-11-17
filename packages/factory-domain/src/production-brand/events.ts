import { z } from 'zod'
import { defineEvent, eventFor, type EmittedEvent, type EventPayloadInput } from '../events/define'
import { WORK_ORDER_HOLD_KINDS } from '../production/holds/kinds'
import { WORKORDERS_VIEW } from '../production/work-orders/permissions'
import { BRAND_HEALTHS } from './health'
import { ISSUE_RECORD_TYPES, ISSUE_SOURCES } from './issues'
import { BRAND_STAGES } from './stages'
import { SUPERVISOR_SOURCES } from './supervisor'
import { BRAND_URGENCIES, URGENCY_ACTORS } from './urgency'

/**
 * B-PR-16 (production plan §2 the brand wall, §3, §6 "Notifications and live events"; lead picks L15, R-48, R-51): the events of
 * a customer's production. apps/factory-api's modules/production emits them in the commands that make the change: the keeper
 * (B-PR-17) the stage, the health and the hold of an order; the urgency commands of the portal and the office (B-PR-22a/b,
 * B-PR-27b); the supervisor (B-PR-42a); the issues that need an answer (B-PR-43b, B-PR-45). Replaces the old
 * `brand_production.ranked` (the customer's urgency replaced its "rank").
 *
 *   brand_production.stage_reached       an order's plain stage moved forward (stages.ts movedForward; a stage going back is
 *                                        never told)
 *   brand_production.health_changed      an order's health changed: computed, or raised to At risk by a person (byNote) or
 *                                        that raise dropped
 *   brand_production.urgency_changed     the customer's urgency of its orders changed: marked Urgent or Regular, its Urgent list
 *                                        put in a new order, an earlier batch put back (undo), or by us: set back to Regular,
 *                                        locked or unlocked, or marked Urgent by accepting its "Urgent – asked" (asked)
 *   brand_production.supervisor_changed  the production supervisor of orders (ORDER) or the customer's default and backup
 *                                        (BRAND) changed — OFFICE ONLY: the customer is never told who supervises (R-41)
 *   brand_production.hold_changed        a hold (quality, production, or the customer's own pause) on an order's work was
 *                                        placed or lifted
 *   production_issue.raised              an issue that needs an answer was raised (the office's "Needs an answer", the
 *                                        customer's "Report a problem") — OFFICE ONLY
 *   production_issue.answered            it was answered (its task done; a shared office message in the order's thread)
 *   production_issue.escalated           it went one step up unanswered (1 the backup or production managers, 2 Owner, Admin)
 *
 * The wall (PW-P07, PW-15): every event names ONE customer (`partyId`) and only that customer's orders. A command over orders of
 * several customers emits one event per customer and company (and writes one audit row per share): `sharesPerParty`, and the
 * builders `urgencyChangedEvent` / `supervisorChangedEvent` that take one share; `assertOneParty` refuses an event that names
 * an order of another customer right before it is emitted. Payloads carry ids, states and flags only: never a name, an amount,
 * a note, a reason a person typed, an urgent place or a count of anyone.
 *
 * Live: the office's screens of a customer's production (workorders.view: the Overview, the Customer card, the work orders'
 * supervisor and urgency, the issues) receive every one, only people who reach the named customer (events/live.ts). The
 * customer's own sessions receive the stage, the health, its urgency and a hold (portal/notifications/live.ts
 * PARTNER_LIVE_EVENTS, its own party only); never supervisor_changed, production_issue.* nor work_order_hold.*.
 */

/** What the office's live screens of a customer's production listen to (the Overview, the Customer card, Work orders). */
const live = (fields: readonly string[]) => ({ permission: WORKORDERS_VIEW, fields }) as const

/** What an urgency command did (the partner notices of B-PR-31 tell a set-back, a lock and an unlock apart). */
export const URGENCY_CHANGES = ['MARK', 'ORDER', 'SET_BACK', 'LOCK', 'UNLOCK'] as const
export type UrgencyChange = (typeof URGENCY_CHANGES)[number]

/** The holds an order's work may be under, as the customer's hold mark counts them: quality's, and the plain ones (B-PR-15). */
export const BRAND_HOLD_KINDS = ['QUALITY', ...WORK_ORDER_HOLD_KINDS] as const
export type BrandHoldKind = (typeof BRAND_HOLD_KINDS)[number]

/** The escalation steps an issue goes up (supervisor.ts ESCALATION_STEPS without 0). */
const escalationStep = () => z.number().int().min(1).max(2)

export const brandStageReached = defineEvent({
  type: 'brand_production.stage_reached',
  context: 'production-brand',
  description: "An order's plain stage for its customer moved forward (preparing, cutting, sewing, quality, ready).",
  payload: z.strictObject({
    /** The sales order. */
    orderId: z.uuid(),
    partyId: z.uuid(),
    stage: z.enum(BRAND_STAGES),
    /** The stage before (null: the order had none yet). */
    previous: z.enum(BRAND_STAGES).nullable(),
  }),
  live: live(['orderId', 'partyId', 'stage']),
})

export const brandHealthChanged = defineEvent({
  type: 'brand_production.health_changed',
  context: 'production-brand',
  description: "An order's health for its customer changed: computed, raised to At risk by a person, or that raise dropped.",
  payload: z.strictObject({
    orderId: z.uuid(),
    partyId: z.uuid(),
    /** The health the customer reads now (null: nothing left to make). */
    health: z.enum(BRAND_HEALTHS).nullable(),
    previous: z.enum(BRAND_HEALTHS).nullable(),
    /** A person's raise (with its curated reason) or its drop made the change, not the computed health. */
    byNote: z.boolean(),
  }),
  live: live(['orderId', 'partyId', 'health']),
})

export const brandUrgencyChanged = defineEvent({
  type: 'brand_production.urgency_changed',
  context: 'production-brand',
  description: "A customer's urgency of its orders changed: marked, put in order, undone, or set back, locked, unlocked or accepted as urgent by us.",
  payload: z.strictObject({
    partyId: z.uuid(),
    /** The customer's own orders the command changed (one event per customer: sharesPerParty). */
    orderIds: z.array(z.uuid()).min(1),
    /** The urgency the named orders have now (an undo that puts orders back to both emits one event per urgency). */
    urgency: z.enum(BRAND_URGENCIES),
    by: z.enum(URGENCY_ACTORS),
    change: z.enum(URGENCY_CHANGES),
    /** The named orders are locked at Regular after the change. */
    locked: z.boolean(),
    /** The command put an earlier batch of the customer back (B-PR-22a Undo). */
    undo: z.boolean(),
    /** Our mark came from accepting the customer's own "Urgent – asked" (B-PR-27b): it is told no "changed by us". */
    asked: z.boolean(),
    /** The batch the command stamped on the rows (BrandOrderProduction.urgencyBatchId): one per customer, never shared. */
    batchId: z.uuid(),
  }),
  live: live(['partyId', 'orderIds', 'urgency', 'by', 'change', 'locked', 'batchId']),
})

export const brandSupervisorChanged = defineEvent({
  type: 'brand_production.supervisor_changed',
  context: 'production-brand',
  description: "The production supervisor of a customer's orders, or the customer's default supervisor and backup, changed (office only).",
  payload: z.strictObject({
    partyId: z.uuid(),
    /** ORDER: the customer's own orders the command changed; BRAND: empty (the default moves every order without its own). */
    orderIds: z.array(z.uuid()),
    /** The office person now (null: ORDER back to the customer's default; BRAND none). */
    supervisorId: z.uuid().nullable(),
    /** The people it replaces, each once (the orders' supervisors before; BRAND the default and the backup before). */
    previousIds: z.array(z.uuid()),
    /** BRAND: the customer's backup now (null: none); ORDER: null (an order has no backup of its own). */
    backupId: z.uuid().nullable(),
    scope: z.enum(SUPERVISOR_SOURCES),
    batchId: z.uuid(),
  }),
  // Office only: no partner live entry (R-41); ids only.
  live: live(['partyId', 'orderIds', 'supervisorId', 'scope', 'batchId']),
})

export const brandHoldChanged = defineEvent({
  type: 'brand_production.hold_changed',
  context: 'production-brand',
  description: "A hold on the work of a customer's order was placed or lifted (quality, production, or the customer's own pause).",
  payload: z.strictObject({
    orderId: z.uuid(),
    partyId: z.uuid(),
    /** The order is on hold after the change (another hold may still hold it after a lift). */
    held: z.boolean(),
    /** The kind of the hold placed or lifted. */
    kind: z.enum(BRAND_HOLD_KINDS),
  }),
  live: live(['orderId', 'partyId', 'held']),
})

export const productionIssueRaised = defineEvent({
  type: 'production_issue.raised',
  context: 'production-brand',
  description: "An issue that needs an answer was raised on a sales order or work order of one customer (the office's note or the customer's report).",
  payload: z.strictObject({
    issueId: z.uuid(),
    partyId: z.uuid(),
    recordType: z.enum(ISSUE_RECORD_TYPES),
    recordId: z.uuid(),
    source: z.enum(ISSUE_SOURCES),
    /** The batch it was raised in (one task per batch; never two customers); null: alone. */
    batchId: z.uuid().nullable(),
  }),
  // Office only: no partner live entry (R-48).
  live: live(['issueId', 'partyId', 'recordType', 'recordId', 'source']),
})

export const productionIssueAnswered = defineEvent({
  type: 'production_issue.answered',
  context: 'production-brand',
  description: 'An issue that needed an answer was answered (its task done, or a shared office message in its order thread).',
  payload: z.strictObject({
    issueId: z.uuid(),
    partyId: z.uuid(),
    source: z.enum(ISSUE_SOURCES),
    /** The issue's sales order (null: a work order of several orders). */
    salesOrderId: z.uuid().nullable(),
    batchId: z.uuid().nullable(),
    /** BRAND: the order of the batch in whose thread the answer came ("Answered in …"); OFFICE: null. */
    answeredInOrderId: z.uuid().nullable(),
  }),
  // Office only: no partner live entry (R-48).
  live: live(['issueId', 'partyId', 'salesOrderId', 'source']),
})

export const productionIssueEscalated = defineEvent({
  type: 'production_issue.escalated',
  context: 'production-brand',
  description: 'An issue still unanswered went one step up: to the backup or the production managers, then to the Owner and Admin.',
  payload: z.strictObject({
    issueId: z.uuid(),
    partyId: z.uuid(),
    batchId: z.uuid().nullable(),
    step: escalationStep(),
  }),
  // Office only: no partner live entry (R-48).
  live: live(['issueId', 'partyId', 'step']),
})

export const events = [
  brandStageReached,
  brandHealthChanged,
  brandUrgencyChanged,
  brandSupervisorChanged,
  brandHoldChanged,
  productionIssueRaised,
  productionIssueAnswered,
  productionIssueEscalated,
] as const

// ---- R-48: one event per customer ------------------------------------------------------------------------------------------

/** One order a command changes, with its company and customer as the command read them (its own row, never the caller's). */
export interface PartyOrder {
  readonly orderId: string
  readonly companyId: string
  readonly partyId: string
}

/** One event's (and one audit row's) share of a command: one customer at one company, its own orders only. */
export interface PartyShare {
  /** The envelope's company (null: a customer-wide change, as its default supervisor). */
  readonly companyId: string | null
  readonly partyId: string
  readonly orderIds: readonly string[]
}

/** An event that names its customer's orders, or an order read as two customers: refused before it is emitted. */
export class BrandEventWallError extends Error {
  override name = 'BrandEventWallError'
}

/**
 * The orders of one command split into one share per customer — and per company, so a person limited to one company never
 * reads another company's order ids either: each share names only its own customer's orders, each once, in the order given;
 * the shares sorted by company, then customer (a command's events come in a stable order). An order read as two customers
 * throws.
 */
export function sharesPerParty(orders: readonly PartyOrder[]): PartyShare[] {
  const partyOf = new Map<string, string>()
  const shares = new Map<string, { companyId: string; partyId: string; orderIds: string[] }>()
  for (const order of orders) {
    const known = partyOf.get(order.orderId)
    if (known !== undefined && known !== order.partyId) throw new BrandEventWallError('production-brand events: one order was read as two customers')
    if (known !== undefined) continue
    partyOf.set(order.orderId, order.partyId)
    const key = `${order.companyId}\u0000${order.partyId}`
    const share = shares.get(key) ?? { companyId: order.companyId, partyId: order.partyId, orderIds: [] }
    share.orderIds.push(order.orderId)
    shares.set(key, share)
  }
  const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...shares.values()].sort((a, b) => text(a.companyId, b.companyId) || text(a.partyId, b.partyId))
}

/**
 * Does the event name only orders of its own customer? `partyOf` is the command's read of each order's customer; an order the
 * read does not know counts as another customer's.
 */
export function namesOnlyItsParty(event: { readonly partyId: string; readonly orderIds: readonly string[] }, partyOf: ReadonlyMap<string, string>): boolean {
  return event.orderIds.every((orderId) => partyOf.get(orderId) === event.partyId)
}

/** Refuses (throws) an event that names an order of another customer: the command calls it right before it emits. */
export function assertOneParty(event: { readonly partyId: string; readonly orderIds: readonly string[] }, partyOf: ReadonlyMap<string, string>): void {
  if (!namesOnlyItsParty(event, partyOf)) throw new BrandEventWallError("production-brand events: an event named an order of another customer than its own")
}

/** What an urgency command says beside the share it changed (its batch is the share's own: one batch per customer). */
export type UrgencyChangeFacts = Omit<EventPayloadInput<typeof brandUrgencyChanged>, 'partyId' | 'orderIds'>

/** One urgency_changed for one share of a command (sharesPerParty): its customer and its own orders only. */
export function urgencyChangedEvent(share: PartyShare, facts: UrgencyChangeFacts): EmittedEvent<typeof brandUrgencyChanged> {
  return eventFor(brandUrgencyChanged, { subject: facts.batchId, companyId: share.companyId, payload: { ...facts, partyId: share.partyId, orderIds: [...share.orderIds] } })
}

/** What a supervisor command says beside the share it changed (BRAND: a share of no order and no company). */
export type SupervisorChangeFacts = Omit<EventPayloadInput<typeof brandSupervisorChanged>, 'partyId' | 'orderIds'>

/** One supervisor_changed for one share of a command: its customer and its own orders only (BRAND: none). */
export function supervisorChangedEvent(share: PartyShare, facts: SupervisorChangeFacts): EmittedEvent<typeof brandSupervisorChanged> {
  if (facts.scope === 'BRAND' && share.orderIds.length > 0) throw new BrandEventWallError("production-brand events: the customer's default names no order")
  if (facts.scope === 'ORDER' && share.orderIds.length === 0) throw new BrandEventWallError('production-brand events: an order supervisor change names its orders')
  return eventFor(brandSupervisorChanged, { subject: facts.batchId, companyId: share.companyId, payload: { ...facts, partyId: share.partyId, orderIds: [...share.orderIds] } })
}

import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { PartnerMessageKey } from '@nexus/factory-domain/portal/notifications/messages'
import { PORTAL_HOME_VIEW } from '@nexus/factory-domain/portal/tasks/permissions'
import { events as productionBrandEvents, type BrandHoldKind, type UrgencyChange } from '@nexus/factory-domain/production-brand/events'
import { effectiveHealth, type BrandHealth, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import type { IssueSource } from '@nexus/factory-domain/production-brand/issues'
import { HOLD_CAUSE_OF_EVENT, healthNoticeKey, holdNoticeKey, problemNotice, stageNoticeKey, urgencyNoticeKey, type HoldCause } from '@nexus/factory-domain/production-brand/notices'
import { PORTAL_PRODUCTION_VIEW } from '@nexus/factory-domain/production-brand/permissions'
import type { BrandStage } from '@nexus/factory-domain/production-brand/stages'
import type { UrgencyActor } from '@nexus/factory-domain/production-brand/urgency'
// B-PR-31 (F-PR-15's ask): a gate passed or started before (+ Gates & dates), a final inspection's result (+ Quality & photos).
import { events as gateEvents } from '@nexus/factory-domain/planning-milestones/events'
import { events as qualityEvents } from '@nexus/factory-domain/quality/events'
import type { ProductionShareLevel } from '@nexus/factory-domain/production-brand/levels'
import { gateNoticeKey, qualityNoticeKey } from '@nexus/factory-domain/production-brand/notices'
import { workOrderAlone } from '@nexus/factory-domain/production-brand/quality-read'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import type { CommandTx } from '../../../../core/command'
import type { PartnerReader } from '../../tasks/people'
import { orderNamed } from './records'
// B-SA-054: the workshop told of an order change (its floor note's event).
import { events as productionEvents } from '@nexus/factory-domain/production/events'
import { PORTAL_JOBS_VIEW } from '@nexus/factory-domain/purchasing/portal-jobs/permissions'
import { WORKSHOP_CHANGES } from '@nexus/factory-domain/sales/orders/change-notes'
import type { PartnerDraft, PartnerRule, PartnerRuleContext } from './types'

/**
 * B-PR-31 — the customer is told of its own production (production plan §6 "Notifications" L15, 06-tree B.4 P-NOTIF; review fixes
 * R-41, R-51; walls PW-P07, PW-15, PW-18; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any
 * other brand. But we, as the production unit, should be able to see it all. And manage it all as well."). Which event makes
 * which notice is factory-domain production-brand/notices.ts (pure); this file reads the records and makes the drafts:
 *
 *   brand_production.stage_reached     Cutting / Sewing / Quality check / Ready to ship, while the order is still there
 *   brand_production.health_changed    worse, to At risk or Late, while the order still reads it
 *   brand_production.hold_changed      on hold (a hold placed) / resumed (nothing holds it any more); the cause is the event the
 *                                      keeper followed (the envelope's causationId: a hold placed or lifted); B-OO-005: ONE notice
 *                                      per act and order (holding or lifting N work orders of it in one command tells it once)
 *   brand_production.urgency_changed   ours only — set back to Regular, locked at Regular, unlocked — while its urgency switch is
 *                                      on; ONE notice per act (the first of the orders named, "and 2 more"), never the
 *                                      customer's own marks (PW-18), never our yes to its "Urgent – asked"
 *   production_issue.answered          a problem the customer reported: answered, or answered in another order's conversation
 *   order_gate.changed                 (F-PR-15's ask) a gate of its order passed, or "missed" — its work started before the gate
 *                                      was passed — only its real gates and only while its level shares gates (+ Gates & dates)
 *   quality.inspection_decided         (F-PR-15's ask) a final inspection of work made for it ALONE passed or not, only at + Quality
 *                                      & photos; ONE notice per act and company (the first of its orders the work order makes,
 *                                      "and 2 more"); a shared work order's result never reaches a customer
 *
 * The answers to its production asks and our counter-offers are the change-request source's (./change-requests.ts, the keys of
 * every kind); "waiting on you" of a counter-offer or a new date is the one task list's notice (./tasks.ts: the APPROVE task the
 * counter and the re-promise open).
 *
 * THE WALL (PW-P07, PW-15): every order is read by its OWN row and kept only when its customer is the event's (W06: the party
 * of a notice is the record's, never the event's word); an order of another customer named by mistake is dropped, never told.
 * Each notice names ONE customer and only its own orders, by its own number ("your order 12", never SO-…); its readers are that
 * customer's people who see its production (portal.home.view, portal.salesOrders.view — the notice opens the order — and
 * portal.production.view over the order's company and customer). Params hold its own numbers only: never a person, an amount, a
 * reason a person typed, a work order, a line or a site. Topic PRODUCTION (non-essential: a daily summary by default).
 */

const payloadOf = <T>(type: string) => (raw: unknown): T => productionBrandEvents.find((event) => event.type === type)!.payload.parse(raw) as T

interface OwnOrder {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly customerSeq: number | null
}
const ORDER = { id: true, companyId: true, partyId: true, customerSeq: true } as const

/** The people of the order's customer who see its production (and open the order the notice links to). */
export const productionReader =
  (place: { readonly companyId: string; readonly partyId: string }) =>
  (reader: PartnerReader): boolean =>
    can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_SALES_ORDERS_VIEW, place) && can(reader.actor, PORTAL_PRODUCTION_VIEW, place)

/** The order by its own row, only when it is this customer's (else null: never told). */
async function ownOrder(tx: CommandTx, orderId: string, partyId: string): Promise<OwnOrder | null> {
  const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: ORDER })
  return order && order.partyId === partyId ? order : null
}

/** The order's production row as the customer reads it (its own customer's only). */
async function productionRowOf(tx: CommandTx, order: OwnOrder) {
  const row = await tx.brandOrderProduction.findFirst({
    where: { key: `brand-production:${order.id}` },
    select: { partyId: true, stage: true, health: true, healthSet: true, healthReasonCode: true, healthSetUntil: true },
  })
  return row && row.partyId === order.partyId ? row : null
}

/** One notice of the customer's own order. */
function draftOf(order: OwnOrder, messageKey: PartnerMessageKey, extra: Record<string, number | null> = {}, batchId: string | null = null, codes: Record<string, string> = {} /* B-PR-31: a gate's kind */): PartnerDraft {
  const named = orderNamed(order)
  const place = { companyId: order.companyId, partyId: order.partyId }
  return { partyId: order.partyId, companyId: order.companyId, record: named.record, messageKey, params: { ...named.params, ...extra, ...codes }, anchor: null, forReader: productionReader(place), batchId }
}

// ---- B-OO-005 (order overview F10b; plan.md §3 "one on hold notice per act"): ONE hold notice per act and order ---------------
/**
 * What moved a hold: the event the keeper followed (the envelope's causation: a hold placed or lifted), when the outbox knows it
 * (`cause` null: another event, taken as placed) — B-OO-005: with its id and the act it belongs to: the request
 * (or job) that wrote it — one request's events share its correlation id (OutboxEvent.correlationId). The keeper's own event
 * carries the cause's id as its causation, so the act is read on the cause, whatever caller ran the keeper.
 */
async function holdCauseRowOf(context: PartnerRuleContext): Promise<{ readonly id: string; readonly cause: HoldCause | null; readonly correlationId: string } | null> {
  const causationId = context.event.causationId
  // A causation that is no event id (a job's own key) is not read: a bad id would fail the fan-out's transaction.
  if (!causationId || !isUuid(causationId)) return null
  const cause = await context.tx.outboxEvent.findUnique({ where: { id: causationId }, select: { id: true, type: true, correlationId: true } })
  if (!cause) return null
  return { id: cause.id, cause: Object.hasOwn(HOLD_CAUSE_OF_EVENT, cause.type) ? HOLD_CAUSE_OF_EVENT[cause.type]! : null, correlationId: cause.correlationId }
}

/**
 * Whether the same notice of this order was told already for the same act: "Hold the whole order" (and Production's Hold N,
 * and one Lift for N work orders) is ONE act on several work orders of the order — N hold events, N keeper events — and the
 * customer is told once. The cheapest correct lookup (13-backend §5): the order's earlier keeper hold events (subject = the order,
 * the outbox's (tenant, subject, …) index), written after this act's cause and before this event (UUIDv7 ids are in write
 * order; the keeper writes one order's events one after the other under its lock), whose own cause is of the same act (the
 * cause's correlation id) and whose notice is the same key. The first of them tells; every later one is skipped.
 */
async function toldInTheSameAct(context: PartnerRuleContext, orderId: string, key: PartnerMessageKey, act: { readonly id: string; readonly correlationId: string }): Promise<boolean> {
  const earlier = await context.tx.outboxEvent.findMany({
    where: { type: 'brand_production.hold_changed', subject: orderId, id: { gt: act.id, lt: context.event.eventId } },
    select: { causationId: true, payload: true },
  })
  const causeIds = [...new Set(earlier.flatMap((row) => (row.causationId && isUuid(row.causationId) ? [row.causationId] : [])))]
  if (causeIds.length === 0) return false
  const causes = new Map((await context.tx.outboxEvent.findMany({ where: { id: { in: causeIds }, correlationId: act.correlationId }, select: { id: true, type: true } })).map((row) => [row.id, row.type]))
  return earlier.some((row) => {
    const type = row.causationId ? causes.get(row.causationId) : undefined
    if (type === undefined) return false
    const payload = (row.payload ?? {}) as { readonly held?: unknown; readonly kind?: unknown }
    if (typeof payload.held !== 'boolean' || typeof payload.kind !== 'string') return false
    const cause = Object.hasOwn(HOLD_CAUSE_OF_EVENT, type) ? HOLD_CAUSE_OF_EVENT[type]! : null
    return holdNoticeKey({ held: payload.held, kind: payload.kind as BrandHoldKind }, payload.held ? cause : null) === key
  })
}
// ---- end B-OO-005

// ---- B-PR-31 (F-PR-15's ask): a gate and a final inspection, each at the level that shares it ---------------------------------
/** The customer's level of what it sees of its production (its own PortalSettings row: one per party), or null (no portal row). */
async function levelOf(tx: CommandTx, partyId: string): Promise<ProductionShareLevel | null> {
  const row = await tx.portalSettings.findUnique({ where: { id: partyId }, select: { partyId: true, productionLevel: true } })
  return row && row.partyId === partyId ? (row.productionLevel as ProductionShareLevel) : null
}

/** One notice per company of the customer's own orders, the first named and "and N more" (one act tells a person once). */
function oncePerCompany(orders: readonly OwnOrder[], key: PartnerMessageKey): PartnerDraft[] {
  const byCompany = new Map<string, OwnOrder[]>()
  for (const order of orders) byCompany.set(order.companyId, [...(byCompany.get(order.companyId) ?? []), order])
  return [...byCompany.values()].map((own) => draftOf(own[0]!, key, { more: own.length - 1 }))
}

// ---- B-SA-054 (sales page plan R8; 14-change-flow §5; sa-8's D5): outside workshops are told of an order change ---------------
/** Subcontract orders whose pieces are out at the workshop (modules/sales/orders/still-to-do AT_WORKSHOP: the same set). */
const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const

/**
 * `production.floor_note_posted` whose changes touch quantities (sizes, lines closed, a work-order change applied: modules/sales/
 * orders/change-notes.ts WORKSHOP_CHANGES) → "Order changed — check quantities: <its subcontract order's number>" to the workshop of
 * each OPEN subcontract order of that work order (a Notification of recordType 'SubcontractOrder', the one that closes Still to do's
 * TELL_WORKSHOP row). THE WALL: the work order's floor note by its own row (the system's, for the floor, on that work order's
 * thread); each subcontract order by its own row, of that work order; the notice goes to ITS workshop only, names only its own
 * number — never the customer, the sales order, another workshop's work or a price; its readers are the workshop's people who see
 * their jobs (portal.home.view and portal.jobs.view over its company and party). A workshop with no open subcontract order on the
 * work order gets nothing.
 */
const WORKSHOP_RULES: readonly PartnerRule[] = [
  {
    name: 'portalProduction.workshopOrderChanged',
    events: ['production.floor_note_posted'],
    async drafts(context, raw) {
      const event = productionEvents.find((entry) => entry.type === 'production.floor_note_posted')!.payload.parse(raw) as { workOrderId: string; messageId: string; changes: string[] }
      if (!event.changes.some((change) => (WORKSHOP_CHANGES as readonly string[]).includes(change))) return []
      const note = await context.tx.message.findUnique({ where: { id: event.messageId }, select: { authorKind: true, forFloor: true, thread: { select: { recordType: true, recordId: true } } } })
      if (!note || note.authorKind !== 'SYSTEM' || !note.forFloor || note.thread.recordType !== 'WorkOrder' || note.thread.recordId !== event.workOrderId) return []
      const orders = await context.tx.subcontractOrder.findMany({ where: { workOrderId: event.workOrderId, status: { in: [...AT_WORKSHOP] } }, select: { id: true, number: true, companyId: true, partyId: true, workOrderId: true }, orderBy: { number: 'asc' } })
      return orders
        .filter((order) => order.workOrderId === event.workOrderId)
        .map((order): PartnerDraft => {
          const place = { companyId: order.companyId, partyId: order.partyId }
          return {
            partyId: order.partyId,
            companyId: order.companyId,
            record: { type: 'SubcontractOrder', id: order.id, label: order.number },
            messageKey: 'portal.job.order_changed',
            params: {},
            anchor: null,
            forReader: (reader) => can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_JOBS_VIEW, place),
          }
        })
    },
  },
]
// ---- end B-SA-054

const GATE_AND_QUALITY_RULES: readonly PartnerRule[] = [
  {
    name: 'portalProduction.gateChanged',
    events: ['order_gate.changed'],
    async drafts(context, raw) {
      const event = gateEvents.find((entry) => entry.type === 'order_gate.changed')!.payload.parse(raw) as { gateId: string; salesOrderId: string; partyId: string; kind: string; change: string; passed: boolean; startedBefore: boolean }
      // Decided on the payload first (another change, another kind: nothing to read), as if the level shared gates.
      if (gateNoticeKey(event, { passed: event.passed, startedBefore: event.startedBefore }, 'GATES') === null) return []
      // The gate by its own row: still of this order and kind, of the same customer; its state now, not the event's.
      const gate = await context.tx.orderGate.findUnique({ where: { id: event.gateId }, select: { salesOrderId: true, partyId: true, kind: true, passedAt: true, overriddenAt: true } })
      if (!gate || gate.salesOrderId !== event.salesOrderId || gate.kind !== event.kind) return []
      const order = await ownOrder(context.tx, gate.salesOrderId, event.partyId)
      if (!order || gate.partyId !== order.partyId) return []
      // An order the customer reads in production (its keeper's row), at a level that shares its gates.
      if (!(await productionRowOf(context.tx, order))) return []
      const key = gateNoticeKey(event, { passed: gate.passedAt !== null, startedBefore: gate.overriddenAt !== null }, await levelOf(context.tx, order.partyId))
      return key ? [draftOf(order, key, {}, null, { gate: gate.kind })] : []
    },
  },
  {
    name: 'portalProduction.qualityResult',
    events: ['quality.inspection_decided'],
    async drafts(context, raw) {
      const event = qualityEvents.find((entry) => entry.type === 'quality.inspection_decided')!.payload.parse(raw) as { inspectionId: string; workOrderId: string; status: 'PASSED' | 'FAILED' }
      // The inspection and its work order by their own rows (never the event's party word): a work order of one customer only.
      const inspection = await context.tx.inspection.findUnique({ where: { id: event.inspectionId }, select: { workOrderId: true, status: true } })
      if (!inspection || inspection.workOrderId !== event.workOrderId) return []
      const workOrder = await context.tx.workOrder.findUnique({ where: { id: inspection.workOrderId }, select: { partyId: true, kind: true, status: true } })
      if (!workOrder || workOrder.partyId === null || workOrder.kind === 'REPAIR' || workOrder.status === 'CANCELLED') return []
      const partyId: string = workOrder.partyId
      const cells = await context.tx.workOrderSize.findMany({ where: { workOrderId: inspection.workOrderId }, select: { partyId: true, salesOrderLineId: true } })
      const level = await levelOf(context.tx, partyId)
      // Its ALONE (every cell that names a customer names it) and at + Quality & photos: else its result judges other goods too.
      const alone = level !== null && workOrderAlone(level, { partyId, cellParties: cells.map((cell) => cell.partyId) }, partyId)
      const key = qualityNoticeKey(event, inspection.status, alone)
      if (key === null) return []
      const lineIds = [...new Set(cells.flatMap((cell) => (cell.salesOrderLineId ? [cell.salesOrderLineId] : [])))]
      if (lineIds.length === 0) return []
      const lines = await context.tx.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { orderId: true } })
      const orderIds = [...new Set(lines.map((line) => line.orderId))]
      const found = await context.tx.salesOrder.findMany({ where: { id: { in: orderIds } }, select: ORDER, orderBy: [{ customerSeq: 'asc' }, { id: 'asc' }] })
      // Only its own orders it reads in production (its keeper's row).
      const own: OwnOrder[] = []
      for (const order of found) if (order.partyId === partyId && (await productionRowOf(context.tx, order))) own.push(order)
      return oncePerCompany(own, key)
    },
  },
]
// ---- end B-PR-31 (gates and QC)

export const PRODUCTION_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalProduction.stageReached',
    events: ['brand_production.stage_reached'],
    async drafts(context, raw) {
      const event = payloadOf<{ orderId: string; partyId: string; stage: BrandStage; previous: BrandStage | null }>('brand_production.stage_reached')(raw)
      // Decided on the payload first (a first stage, a move back: nothing to read).
      if (stageNoticeKey(event, event.stage) === null) return []
      const order = await ownOrder(context.tx, event.orderId, event.partyId)
      if (!order) return []
      const row = await productionRowOf(context.tx, order)
      const key = stageNoticeKey(event, (row?.stage as BrandStage | undefined) ?? null)
      return key ? [draftOf(order, key)] : []
    },
  },
  {
    name: 'portalProduction.healthChanged',
    events: ['brand_production.health_changed'],
    async drafts(context, raw) {
      const event = payloadOf<{ orderId: string; partyId: string; health: BrandHealth | null; previous: BrandHealth | null }>('brand_production.health_changed')(raw)
      if (healthNoticeKey(event, event.health) === null) return []
      const order = await ownOrder(context.tx, event.orderId, event.partyId)
      if (!order) return []
      const row = await productionRowOf(context.tx, order)
      if (!row) return []
      // The health the customer reads now: the computed one, raised to At risk while a raise stands (the keeper drops one that
      // no longer does).
      const raise = row.healthSet !== null && row.healthReasonCode !== null && row.healthSetUntil !== null ? { reasonCode: row.healthReasonCode as HealthReasonCode, until: businessDate(row.healthSetUntil) } : null
      const key = healthNoticeKey(event, effectiveHealth(row.health as BrandHealth | null, raise).health)
      return key ? [draftOf(order, key)] : []
    },
  },
  {
    name: 'portalProduction.holdChanged',
    events: ['brand_production.hold_changed'],
    async drafts(context, raw) {
      const event = payloadOf<{ orderId: string; partyId: string; held: boolean; kind: BrandHoldKind }>('brand_production.hold_changed')(raw)
      // B-OO-005: the cause read once, with its act.
      const cause = await holdCauseRowOf(context)
      const key = holdNoticeKey(event, event.held ? (cause?.cause ?? null) : null)
      if (key === null) return []
      const order = await ownOrder(context.tx, event.orderId, event.partyId)
      if (!order) return []
      // B-OO-005: one notice per act and order — a later hold event of the same act is not told again.
      if (cause && (await toldInTheSameAct(context, order.id, key, cause))) return []
      return [draftOf(order, key)]
    },
  },
  {
    name: 'portalProduction.urgencyChanged',
    events: ['brand_production.urgency_changed'],
    async drafts(context, raw) {
      const event = payloadOf<{ partyId: string; orderIds: string[]; by: UrgencyActor; change: UrgencyChange; asked: boolean; undo: boolean; batchId: string }>('brand_production.urgency_changed')(raw)
      // PW-18: the customer's own marks, orders and undo tell nobody (nor any other customer); our yes to its ask is its answer's.
      if (urgencyNoticeKey(event, true) === null) return []
      const settings = await context.tx.portalSettings.findUnique({ where: { id: event.partyId }, select: { partyId: true, productionUrgencyOn: true } })
      const key = urgencyNoticeKey(event, settings !== null && settings.partyId === event.partyId && settings.productionUrgencyOn)
      if (key === null) return []
      const wanted = [...new Set(event.orderIds)]
      const found = await context.tx.salesOrder.findMany({ where: { id: { in: wanted } }, select: ORDER })
      // Only the event's customer's own orders, in the event's order; one notice per company (an act is one company's).
      const own = found.filter((order) => order.partyId === event.partyId).sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id))
      const byCompany = new Map<string, OwnOrder[]>()
      for (const order of own) byCompany.set(order.companyId, [...(byCompany.get(order.companyId) ?? []), order])
      return [...byCompany.values()].map((orders) => draftOf(orders[0]!, key, { more: orders.length - 1 }))
    },
  },
  {
    name: 'portalProduction.problemAnswered',
    events: ['production_issue.answered'],
    async drafts(context, raw) {
      const event = payloadOf<{ issueId: string; partyId: string; source: IssueSource; salesOrderId: string | null; batchId: string | null; answeredInOrderId: string | null }>('production_issue.answered')(raw)
      if (problemNotice(event) === null) return []
      // The issue by its own row (office only: read in the fan-out's system scope), still answered, of this customer.
      const issue = await context.tx.productionIssue.findUnique({ where: { id: event.issueId }, select: { partyId: true, source: true, status: true, salesOrderId: true, batchId: true } })
      if (!issue || issue.partyId !== event.partyId || issue.source !== 'BRAND' || issue.status !== 'ANSWERED' || issue.salesOrderId === null) return []
      const decided = problemNotice({ source: issue.source, salesOrderId: issue.salesOrderId, answeredInOrderId: event.answeredInOrderId })
      const order = await ownOrder(context.tx, issue.salesOrderId, issue.partyId)
      if (!decided || !order) return []
      if (decided.inOrderId === null) return [draftOf(order, decided.key, {}, issue.batchId)]
      // The order holding the answer: only one of its own at the same company; any other names nothing (plain "answered").
      const inOrder = await ownOrder(context.tx, decided.inOrderId, issue.partyId)
      if (!inOrder || inOrder.companyId !== order.companyId) return [draftOf(order, 'portal.production.problem_answered', {}, issue.batchId)]
      return [draftOf(order, decided.key, { inSeq: inOrder.customerSeq }, issue.batchId)]
    },
  },
  // B-PR-31 (F-PR-15's ask)
  ...GATE_AND_QUALITY_RULES,
  // B-SA-054
  ...WORKSHOP_RULES,
])

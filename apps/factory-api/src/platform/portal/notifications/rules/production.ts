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
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import type { CommandTx } from '../../../../core/command'
import type { PartnerReader } from '../../tasks/people'
import { orderNamed } from './records'
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
 *                                      keeper followed (the envelope's causationId: a hold placed or lifted)
 *   brand_production.urgency_changed   ours only — set back to Regular, locked at Regular, unlocked — while its urgency switch is
 *                                      on; ONE notice per act (the first of the orders named, "and 2 more"), never the
 *                                      customer's own marks (PW-18), never our yes to its "Urgent – asked"
 *   production_issue.answered          a problem the customer reported: answered, or answered in another order's conversation
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
function draftOf(order: OwnOrder, messageKey: PartnerMessageKey, extra: Record<string, number | null> = {}, batchId: string | null = null): PartnerDraft {
  const named = orderNamed(order)
  const place = { companyId: order.companyId, partyId: order.partyId }
  return { partyId: order.partyId, companyId: order.companyId, record: named.record, messageKey, params: { ...named.params, ...extra }, anchor: null, forReader: productionReader(place), batchId }
}

/** What moved a hold: the event the keeper followed (the envelope's causation), when the outbox knows it. */
async function holdCauseOf(context: PartnerRuleContext): Promise<HoldCause | null> {
  const causationId = context.event.causationId
  // A causation that is no event id (a job's own key) is not read: a bad id would fail the fan-out's transaction.
  if (!causationId || !isUuid(causationId)) return null
  const cause = await context.tx.outboxEvent.findUnique({ where: { id: causationId }, select: { type: true } })
  return cause && Object.hasOwn(HOLD_CAUSE_OF_EVENT, cause.type) ? HOLD_CAUSE_OF_EVENT[cause.type]! : null
}

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
      const key = holdNoticeKey(event, event.held ? await holdCauseOf(context) : null)
      if (key === null) return []
      const order = await ownOrder(context.tx, event.orderId, event.partyId)
      return order ? [draftOf(order, key)] : []
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
])

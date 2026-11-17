import type { PartnerMessageKey } from '../portal/notifications/messages'
import type { BrandHoldKind, UrgencyChange } from './events'
import { healthRank, type BrandHealth } from './health'
import type { IssueSource } from './issues'
import { movedForward, type BrandStage } from './stages'
import type { UrgencyActor } from './urgency'

/**
 * B-PR-31 (production plan §6 "Notifications" L15, 06-tree B.4 P-NOTIF; review fixes R-41, R-51; walls PW-P07, PW-15, PW-18; the
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well."): which notice a customer is told of its own production, pure. The
 * API's partner rule (apps/factory-api platform/portal/notifications/rules/production.ts) reads the records — each order by its
 * own row, of the event's customer only — and asks these; the sentences are portal/notifications/messages.ts's
 * `portal.production.*`, topic PRODUCTION (non-essential: a daily summary by default).
 *
 *   stage_reached       a forward move to Cutting, Sewing, Quality check or Ready to ship, told while the order is still at that
 *                       stage (a stage that moved on before the worker told it is not stale news: the next one is told). Never
 *                       the order's FIRST stage (previous null): the keeper makes the row with it — a new order was just told
 *                       "confirmed", and the keeper's first nightly run over the orders made before it must not flood every
 *                       customer with a notice per order. Never a move back (the keeper never tells one either).
 *   health_changed      worse, to At risk or Late, while the order still reads it; never its first health (previous null, as
 *                       above), never a better one (the page shows it), never No date or On track.
 *   hold_changed        placed: the order is on hold (a lift that leaves another hold standing tells nothing: it was on hold
 *                       and still is); lifted: nothing holds it any more. Never the customer's OWN pause placed: only our yes
 *                       to its pause request places one, and that answer tells it.
 *   urgency_changed     only ours (by FACTORY), and not our yes to its own "Urgent – asked" (`asked`: that answer tells it):
 *                       set back to Regular, locked at Regular, unlocked — "we", never a name (R-41: "Changed by us"). Never
 *                       the customer's own marks, orders or undo (it did them: PW-18, nobody is told of a customer's mark), and
 *                       never while its urgency switch is off (its portal shows no urgency then).
 *   production_issue.answered  a problem the CUSTOMER reported (source BRAND) on one of its sales orders: "answered" on the order
 *                       whose conversation holds our answer, "answered in the conversation of your order N" on the other orders of
 *                       its batch. Never an office issue (the customer never knew of it).
 * Each names only what the customer reads on its own page; never a person, an amount, a work order, a line, a site or a reason a
 * person typed (PW-15).
 */

/** The stages a customer is told it reached (PREPARING is where an order starts: never news). */
export const STAGE_NOTICE_KEYS: Readonly<Partial<Record<BrandStage, PartnerMessageKey>>> = Object.freeze({
  CUTTING: 'portal.production.cutting',
  SEWING: 'portal.production.sewing',
  QUALITY: 'portal.production.quality',
  READY: 'portal.production.ready',
})

/** The healths a customer is told of when its order gets worse. */
export const HEALTH_NOTICE_KEYS: Readonly<Partial<Record<BrandHealth, PartnerMessageKey>>> = Object.freeze({
  AT_RISK: 'portal.production.at_risk',
  LATE: 'portal.production.late',
})

/** Our urgency acts a customer is told of. */
export const URGENCY_NOTICE_KEYS: Readonly<Partial<Record<UrgencyChange, PartnerMessageKey>>> = Object.freeze({
  SET_BACK: 'portal.production.set_regular',
  LOCK: 'portal.production.locked',
  UNLOCK: 'portal.production.unlocked',
})

/** The notice of a stage reached; `now`: the stage the order's production row reads when the worker tells it. */
export function stageNoticeKey(event: { readonly stage: BrandStage; readonly previous: BrandStage | null }, now: BrandStage | null): PartnerMessageKey | null {
  if (event.previous === null || !movedForward(event.previous, event.stage)) return null
  if (now !== event.stage) return null
  return STAGE_NOTICE_KEYS[event.stage] ?? null
}

/** The notice of a health changed; `now`: the health the customer reads when the worker tells it (computed, or raised). */
export function healthNoticeKey(event: { readonly health: BrandHealth | null; readonly previous: BrandHealth | null }, now: BrandHealth | null): PartnerMessageKey | null {
  const { health, previous } = event
  if (health === null || previous === null) return null
  const key = HEALTH_NOTICE_KEYS[health]
  if (key === undefined || healthRank(health) >= healthRank(previous)) return null
  return now === health ? key : null
}

/** What moved the hold: a hold placed, a hold lifted (the event the keeper followed), or not known (taken as placed). */
export const HOLD_CAUSES = ['PLACED', 'LIFTED'] as const
export type HoldCause = (typeof HOLD_CAUSES)[number]

/** The event types that place a hold on a work order, and those that lift one (the keeper's hold events). */
export const HOLD_CAUSE_OF_EVENT: Readonly<Record<string, HoldCause>> = Object.freeze({
  'work_order_hold.placed': 'PLACED',
  'quality.hold_placed': 'PLACED',
  'work_order_hold.lifted': 'LIFTED',
  'quality.hold_released': 'LIFTED',
})

/** The notice of a hold changed (`held`: the order is on hold after it). */
export function holdNoticeKey(event: { readonly held: boolean; readonly kind: BrandHoldKind }, cause: HoldCause | null): PartnerMessageKey | null {
  if (!event.held) return 'portal.production.hold_lifted'
  // Still held after a lift: another hold stands — it was on hold and is.
  if (cause === 'LIFTED') return null
  // The customer's own pause: placed only by our yes to its pause request, which tells it.
  if (event.kind === 'BRAND') return null
  return 'portal.production.on_hold'
}

/** The notice of an urgency change (`urgencyOn`: the customer's urgency switch now). */
export function urgencyNoticeKey(event: { readonly by: UrgencyActor; readonly change: UrgencyChange; readonly asked: boolean; readonly undo: boolean }, urgencyOn: boolean): PartnerMessageKey | null {
  if (!urgencyOn || event.by !== 'FACTORY' || event.asked || event.undo) return null
  return URGENCY_NOTICE_KEYS[event.change] ?? null
}

/** The notice of an issue answered: on the issue's own order, and the order whose conversation holds the answer if another. */
export function problemNotice(event: { readonly source: IssueSource; readonly salesOrderId: string | null; readonly answeredInOrderId: string | null }): { readonly key: PartnerMessageKey; readonly inOrderId: string | null } | null {
  if (event.source !== 'BRAND' || event.salesOrderId === null) return null
  if (event.answeredInOrderId !== null && event.answeredInOrderId !== event.salesOrderId) return { key: 'portal.production.problem_answered_in', inOrderId: event.answeredInOrderId }
  return { key: 'portal.production.problem_answered', inOrderId: null }
}

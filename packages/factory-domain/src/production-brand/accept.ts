import type { Words } from '../portal/tasks/kinds'
import type { WorkOrderStatus } from '../production/work-orders/machine'
import type { OrderRequestKind } from '../sales/change-requests/rules'

/**
 * B-PR-27a (production plan §3 "Brand asks, we decide", "Who answers / sets", "Legacy mixed work order: accept is held ('answer by
 * hand')"; 08-backend §4.2 "Accept does"; lead pick L4; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): what
 * accepting a customer's production ask does to the work of its order, pure. apps/factory-api's
 * production/brand-requests/accept.ts carries it out in the accept's ONE command.
 *
 *   where     HOLD, RESUME (B-PR-27a), RUSH and SAMPLE_ROUND (B-PR-27b) are accepted in production (POST
 *             /production/brand-requests/:id/accept); CHANGE, CANCEL and SPLIT_SHIPMENT in Sales (POST
 *             /sales/change-requests/:id/accept): each route refuses the other's kinds in words
 *   HOLD      a BRAND hold (WorkOrderHold, the customer's pause: its HOLD ask named) on each OPEN work order of the order (DRAFT,
 *             RELEASED, IN_PROGRESS, ON_HOLD; never a repair) — one already paused by the customer is left as it is. Held, in
 *             words, the office answers by hand: an order with no open work order yet (nothing to pause), a work order made
 *             before the one-customer rule (no customer: it makes another customer's pieces too), a work order that also
 *             makes another order (a pause of this order would stop that one)
 *   RESUME    every ACTIVE BRAND hold its HOLD asks placed on the order's work orders, lifted (a work order still held by
 *             another hold stays held under it); none left: the accept says that nothing was paused any more
 * The customer reads "Paused at your request" while a BRAND hold stands (the portal's read); the floor reads the pause's words
 * on the work order (never a customer's name); the office reads every work order and why one is held.
 */

/** The kinds accepted in production (the others are Sales'). */
export const PRODUCTION_ACCEPT_KINDS = ['HOLD', 'RESUME', 'RUSH', 'SAMPLE_ROUND'] as const satisfies readonly OrderRequestKind[]
export type ProductionAcceptKind = (typeof PRODUCTION_ACCEPT_KINDS)[number]
export const isProductionAccept = (kind: string): kind is ProductionAcceptKind => (PRODUCTION_ACCEPT_KINDS as readonly string[]).includes(kind)

/** A Sales kind sent to production's accept (409 `request/SALES_ASK`). */
export const SALES_ACCEPT_WORDS: Words = Object.freeze({
  it: 'Questa richiesta si accetta in Vendite (modifica, annullamento, spedizione di ciò che è pronto).',
  en: 'This request is accepted in Sales (a change, a cancel, ship what is ready).',
})

/**
 * The reason a customer's pause carries (WorkOrderHold.reasonCode of a BRAND hold: the customer's own HOLD ask is why, never a
 * code of the PRODUCTION_HOLD list) and the words the work order shows while held under it (WorkOrder.holdReason, the floor's).
 */
export const CUSTOMER_PAUSE_REASON = Object.freeze({ code: 'CUSTOMER_PAUSE', it: 'In pausa su richiesta del cliente', en: "Paused at the customer's request" })

/** The words a plain hold shows: a customer's pause its own, a production hold its reason's (else its code). */
export const plainHoldWordsOf = (hold: { readonly kind: string; readonly reasonCode: string }, reasonEn: string | undefined): string =>
  hold.kind === 'BRAND' ? CUSTOMER_PAUSE_REASON.en : (reasonEn ?? hold.reasonCode)

/** The work order statuses a hold is placed on (the database's: …_brand_production_guards). */
export const OPEN_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'])
export const isOpenWorkOrder = (status: string): boolean => (OPEN_WORK_ORDER_STATUSES as readonly string[]).includes(status)

/** One work order that makes the order's goods (a cell of one of its goods lines; never a repair), as the accept reads it. */
export interface AcceptWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: WorkOrderStatus
  /** Its customer (null: made before the one-customer rule — a mixed work order). */
  readonly partyId: string | null
  /** It also makes pieces of another order (a cell of another order's line, or of no order). */
  readonly otherOrders: boolean
  /** A BRAND hold (the customer's pause) stands on it already. */
  readonly paused: boolean
}

export type PauseRefusal = 'NO_WORK' | 'MIXED' | 'SHARED'

export type PausePlan =
  | { readonly ok: true; readonly hold: readonly string[]; readonly already: readonly string[] }
  | { readonly ok: false; readonly code: PauseRefusal; readonly numbers: readonly string[]; readonly words: Words }

const listed = (numbers: readonly string[]): string => numbers.join(', ')

/** The office's words of a pause it answers by hand (each names only the order's own work orders). */
export function pauseRefusalWords(code: PauseRefusal, numbers: readonly string[]): Words {
  const one = numbers.length === 1
  switch (code) {
    case 'NO_WORK':
      return {
        it: "L'ordine non ha ancora ordini di lavoro aperti: non c'è niente da mettere in pausa. Rispondi a mano: rifiuta con un motivo, o accetta quando i suoi ordini di lavoro ci sono.",
        en: 'The order has no open work order yet: there is nothing to pause. Answer by hand: refuse with words, or accept once its work orders are made.',
      }
    case 'MIXED':
      return {
        it: `${one ? "L'ordine di lavoro" : 'Gli ordini di lavoro'} ${listed(numbers)} ${one ? 'è stato fatto' : 'sono stati fatti'} prima della regola di un solo cliente e ${one ? 'fa' : 'fanno'} anche capi di altri clienti: rispondi a mano (dividi prima, o metti in pausa a mano solo i capi di questo cliente).`,
        en: `Work order${one ? '' : 's'} ${listed(numbers)} ${one ? 'was' : 'were'} made before the one-customer rule and also ${one ? 'makes' : 'make'} other customers' pieces: answer by hand (split first, or pause only this customer's pieces yourself).`,
      }
    case 'SHARED':
      return {
        it: `${one ? "L'ordine di lavoro" : 'Gli ordini di lavoro'} ${listed(numbers)} ${one ? 'fa' : 'fanno'} anche un altro ordine: una pausa di questo fermerebbe anche quello. Rispondi a mano.`,
        en: `Work order${one ? '' : 's'} ${listed(numbers)} also ${one ? 'makes' : 'make'} another order: a pause of this order would stop that one too. Answer by hand.`,
      }
  }
}

/**
 * Which work orders accepting a pause holds: every open one of the order's (one the customer paused already is left as it is), or
 * the reason it is answered by hand — no open work order, a mixed one, one that also makes another order (that order would stop
 * too). The work orders come in id order (the lock order); the plan keeps it.
 */
export function pausePlan(workOrders: readonly AcceptWorkOrder[]): PausePlan {
  const open = workOrders.filter((workOrder) => isOpenWorkOrder(workOrder.status))
  if (open.length === 0) return { ok: false, code: 'NO_WORK', numbers: [], words: pauseRefusalWords('NO_WORK', []) }
  const mixed = open.filter((workOrder) => workOrder.partyId === null).map((workOrder) => workOrder.number)
  if (mixed.length > 0) return { ok: false, code: 'MIXED', numbers: mixed, words: pauseRefusalWords('MIXED', mixed) }
  const shared = open.filter((workOrder) => workOrder.otherOrders).map((workOrder) => workOrder.number)
  if (shared.length > 0) return { ok: false, code: 'SHARED', numbers: shared, words: pauseRefusalWords('SHARED', shared) }
  return { ok: true, hold: open.filter((workOrder) => !workOrder.paused).map((workOrder) => workOrder.id), already: open.filter((workOrder) => workOrder.paused).map((workOrder) => workOrder.id) }
}

/** Why a customer's pause was lifted (WorkOrderHold.liftReason: one line, at most 500). */
export const resumeReasonOf = (orderNumber: string): string => `Resumed at the customer's request (${orderNumber}).`.slice(0, 500)

/** What an accepted pause or resume did, in the office's words. */
export function pauseDoneWords(kind: 'HOLD' | 'RESUME', numbers: readonly string[]): Words {
  if (numbers.length === 0) {
    return kind === 'HOLD'
      ? { it: "Ogni ordine di lavoro dell'ordine era già in pausa su richiesta del cliente.", en: "Every work order of the order was paused at the customer's request already." }
      : { it: "Non c'era più niente in pausa: il lavoro dell'ordine continua.", en: "Nothing was paused any more: the order's work goes on." }
  }
  const one = numbers.length === 1
  return kind === 'HOLD'
    ? { it: `In pausa su richiesta del cliente: ${listed(numbers)}.`, en: `Paused at the customer's request: ${listed(numbers)}.` }
    : { it: `${one ? 'Ripreso' : 'Ripresi'}: ${listed(numbers)}.`, en: `Taken up again: ${listed(numbers)}.` }
}

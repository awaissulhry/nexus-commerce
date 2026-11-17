import type { Words } from '../portal/tasks/kinds'
import type { BrandUrgency } from './urgency'
import { ASK_KIND_WORDS, CUSTOMER_URGENCY_WORDS, setBackWords, URGENCY_WORDS } from './words'

/**
 * F-PR-18 — the customer's urgency as the office's Work orders column and filter say it (production plan §5 "Work orders: … Customer
 * urgency"; 10-steps-web F-PR-18: "Urgent 2 / Urgent – asked / Regular / Set to regular by us"), pure. One state per work order, from
 * its orders' urgency that COUNTS (B-PR-22b: the order still in production and its customer's urgency switch on), each order's open
 * "Urgent – asked" (a RUSH request we answer in Home › Approvals) and who set a Regular mark:
 *
 *   URGENT     one of its orders is Urgent — with the best place in its customer's OWN Urgent list ("Urgent 2"), never a place in
 *              our plan
 *   ASKED      none is Urgent and one has an open "Urgent – asked"
 *   SET_BACK   none is Urgent or asked, and one was set back to Regular by us (or locked by us): "Set to regular by us"
 *   REGULAR    every other order whose urgency counts
 *
 * A work order whose orders have no urgency that counts has none (null: no customer order, no production state yet, or the
 * customer's switch off — its marks are kept but count for nothing, R-46). The rule takes only the work order's own orders (one
 * customer per work order, B-PR-01): it never reads, names or counts another customer's.
 */

export const CUSTOMER_URGENCY_STATES = ['URGENT', 'ASKED', 'REGULAR', 'SET_BACK'] as const
export type CustomerUrgencyState = (typeof CUSTOMER_URGENCY_STATES)[number]

export const isCustomerUrgencyState = (value: unknown): value is CustomerUrgencyState => typeof value === 'string' && (CUSTOMER_URGENCY_STATES as readonly string[]).includes(value)

/** One order of the work order, as the rule reads it. */
export interface OrderUrgencyFacts {
  readonly urgency: BrandUrgency
  /** Its place in its customer's OWN Urgent list (1 first); null when Regular. */
  readonly urgentRank: number | null
  /** An "Urgent – asked" (an open RUSH request) waits on it. */
  readonly asked: boolean
  /** Its Regular mark is ours: set back to Regular by us, or locked by us. */
  readonly setByUs: boolean
}

export interface WorkOrderUrgencyState {
  readonly state: CustomerUrgencyState
  /** The best place among its Urgent orders (URGENT only; null: a place not known). */
  readonly urgentRank: number | null
}

/** The work order's state from its orders' facts (none: null). */
export function customerUrgencyStateOf(orders: readonly OrderUrgencyFacts[]): WorkOrderUrgencyState | null {
  if (orders.length === 0) return null
  const urgent = orders.filter((order) => order.urgency === 'URGENT')
  if (urgent.length > 0) {
    const ranks = urgent.flatMap((order) => (order.urgentRank !== null && order.urgentRank > 0 ? [order.urgentRank] : []))
    return { state: 'URGENT', urgentRank: ranks.length > 0 ? Math.min(...ranks) : null }
  }
  if (orders.some((order) => order.asked)) return { state: 'ASKED', urgentRank: null }
  if (orders.some((order) => order.setByUs)) return { state: 'SET_BACK', urgentRank: null }
  return { state: 'REGULAR', urgentRank: null }
}

/**
 * The state in words (the export's; the web says its own catalogue's): "Urgent (customer) 2" — "Urgente" alone is already the
 * planner's rush flag in Italian —, "Urgent – asked", "Regular", "Set to Regular by us".
 */
export function customerUrgencyStateWords(state: WorkOrderUrgencyState): Words {
  if (state.state === 'URGENT') {
    const place = state.urgentRank !== null ? ` ${state.urgentRank}` : ''
    return { it: `${CUSTOMER_URGENCY_WORDS.chip.it}${place}`, en: `${CUSTOMER_URGENCY_WORDS.chip.en}${place}` }
  }
  if (state.state === 'ASKED') return ASK_KIND_WORDS.RUSH
  if (state.state === 'SET_BACK') return setBackWords(null)
  return URGENCY_WORDS.REGULAR
}

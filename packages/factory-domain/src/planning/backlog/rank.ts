import type { BusinessDate } from '../../core/time'
import type { BrandUrgency } from '../../production-brand/urgency'

/**
 * The backlog ranked (B-W2b-317; PLN-177 "Backlog ranking drives allocation"; B-W2b-286's SalesOrder.backlogRank, 1 first,
 * up to 1 000 000, ties allowed, null = not ranked): the open orders in the order planning serves them. Allocation reads it
 * (B-W2b-318's scarce material by the backlog's priority, PLN-088; the promise engine asks for the open pieces in this
 * order, so the first order takes the first free capacity and material).
 *
 * The order:
 *   1. the orders a planner ranked by hand, by their rank (1 first; ties by the rule below)
 *   2. then every other open order by the rule: priority level (URGENT, HIGH, NORMAL, LOW; B-W2b-281), W1's priority number
 *      (higher first), the promise (the earliest current promise of its open lines, else the order's; none last), the
 *      customer (its code: a customer's orders of one day sit together), the order date, the number.
 *   3. B-PR-41 (production plan §3 "Brand-slot rule"; review fixes R-40, R-46): then the customer's own urgency, by the
 *      brand-slot pass — never a key of the rule. Per customer and per office level, that customer's urgent orders (by its
 *      urgentRank) take the earliest places ITS OWN orders already hold in that level; the orders a planner ranked by hand keep
 *      their places; another customer's places never change; a mark counts only while the customer's urgency switch is on
 *      (switched off, the marks are kept but order nothing). Putting an order ahead of other customers stays our act: accept
 *      its "Urgent – asked", raise its level, or rank it by hand. Scarce material reads only the hand rank (backlogRank); the
 *      places feed the promise engine.
 */

export const PRIORITY_LEVELS = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]

export const RANK_MIN = 1
export const RANK_MAX = 1_000_000
/** The most orders one ranking names. */
export const RANK_BATCH_MAX = 500

export interface BacklogOrder {
  readonly id: string
  readonly number: string
  /** SalesOrder.backlogRank: the planner's rank (null: not ranked by hand). */
  readonly rank: number | null
  readonly priorityLevel: PriorityLevel
  readonly priority: number
  readonly promise: BusinessDate | null
  readonly customerCode: string
  readonly orderDate: BusinessDate
  // B-PR-41: the customer's own urgency (BrandOrderProduction, B-PR-15; read by B-PR-22b). Left out: Regular, switch off.
  /** The customer's mark of the order (left out: REGULAR). */
  readonly customerUrgency?: BrandUrgency
  /** Its place in the customer's own Urgent list (1 first; null or left out: not urgent). */
  readonly urgentRank?: number | null
  /** The customer's urgency switch (PortalSettings.productionUrgencyOn; left out: off, the mark is dormant). */
  readonly urgencyOn?: boolean
}

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const levelRank = (level: PriorityLevel): number => {
  const index = PRIORITY_LEVELS.indexOf(level)
  return index < 0 ? PRIORITY_LEVELS.indexOf('NORMAL') : index
}

/** The rule's order (no hand rank). */
export function ruleCompare(a: BacklogOrder, b: BacklogOrder): number {
  if (a.priorityLevel !== b.priorityLevel) return levelRank(a.priorityLevel) - levelRank(b.priorityLevel)
  if (a.priority !== b.priority) return b.priority - a.priority
  const pa = a.promise ?? '9999-12-31'
  const pb = b.promise ?? '9999-12-31'
  if (pa !== pb) return text(pa, pb)
  return text(a.customerCode, b.customerCode) || text(a.orderDate, b.orderDate) || text(a.number, b.number) || text(a.id, b.id)
}

/** The backlog's order: ranked by hand first (by rank), then the rule. */
export function backlogCompare(a: BacklogOrder, b: BacklogOrder): number {
  if (a.rank !== null || b.rank !== null) {
    if (a.rank === null) return 1
    if (b.rank === null) return -1
    if (a.rank !== b.rank) return a.rank - b.rank
  }
  return ruleCompare(a, b)
}

// ---- B-PR-41: the brand-slot pass ----------------------------------------------------------------------------------------------

/** The customer's mark counts in the backlog: Urgent, while its switch is on, and not ranked by hand (that place is ours). */
export const urgencyCounts = (order: BacklogOrder): boolean => order.rank === null && order.urgencyOn === true && order.customerUrgency === 'URGENT'

/**
 * The brand-slot pass over orders already in the backlog's order (hand rank, then the rule): per customer (its code: unique in
 * the tenant) and office level, the places that customer's orders not ranked by hand hold are filled again — its counted
 * urgent orders first (by urgentRank, then as they stood), then its other orders as they stood. Every other place keeps its
 * order: a hand-ranked one, and every order of another customer.
 */
export function brandSlots<T extends BacklogOrder>(ordered: readonly T[]): T[] {
  const groups = new Map<string, number[]>()
  ordered.forEach((order, index) => {
    if (order.rank !== null) return
    const key = `${levelRank(order.priorityLevel)}|${order.customerCode}`
    const places = groups.get(key)
    if (places) places.push(index)
    else groups.set(key, [index])
  })
  const out = [...ordered]
  for (const places of groups.values()) {
    const members = places.map((index) => ({ order: ordered[index]!, index }))
    const urgent = members.filter((member) => urgencyCounts(member.order))
    if (urgent.length === 0) continue
    const rankOf = (order: T) => order.urgentRank ?? Number.MAX_SAFE_INTEGER
    urgent.sort((a, b) => rankOf(a.order) - rankOf(b.order) || a.index - b.index)
    const rest = members.filter((member) => !urgencyCounts(member.order))
    const refilled = [...urgent, ...rest]
    places.forEach((place, k) => {
      out[place] = refilled[k]!.order
    })
  }
  return out
}

/** The orders in the backlog's order, each with its place (1 first) and its place by the rule alone (no hand rank, no urgency). */
export function rankedBacklog<T extends BacklogOrder>(orders: readonly T[]): (T & { readonly position: number; readonly rulePosition: number })[] {
  const byRule = new Map([...orders].sort(ruleCompare).map((order, index) => [order.id, index + 1]))
  return brandSlots([...orders].sort(backlogCompare)).map((order, index) => ({ ...order, position: index + 1, rulePosition: byRule.get(order.id)! }))
}

/** "By hand 1" · "By the rule (urgent, promised 4 Dec)" · B-PR-41: "…; customer urgency: own places (urgent 1)". */
export function whyWords(order: BacklogOrder, dayWords: (date: BusinessDate) => string): string {
  if (order.rank !== null) return `Ranked by hand: ${order.rank}.`
  const promise = order.promise ? `promised ${dayWords(order.promise)}` : 'no promise yet'
  const urgency = urgencyCounts(order) ? `; customer urgency: own places${order.urgentRank ? ` (urgent ${order.urgentRank})` : ''}` : ''
  return `By the rule: ${order.priorityLevel.toLowerCase()} priority${order.priority !== 0 ? ` (${order.priority})` : ''}, ${promise}, customer ${order.customerCode}${urgency}.`
}

export const RULE_WORDS =
  'Ranked by hand first (1 = first, ties by the rule), then by the rule: priority (urgent, high, normal, low), the order\'s priority number (higher first), the promise date (earliest first), the customer, the order date and number.'

export interface RankItem {
  readonly orderId: string
  /** The rank the planner saw (null: not ranked): a different one now means someone ranked it since. */
  readonly from: number | null
  /** The new rank (null: back to the rule). */
  readonly to: number | null
}

/** Every problem of a ranking at once: each order once, ranks 1 to 1 000 000 or none, at most 500, something to change. */
export function rankProblems(items: readonly RankItem[]): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  if (items.length === 0) problems.push({ path: 'body/ranks', message: 'Name at least one order.' })
  if (items.length > RANK_BATCH_MAX) problems.push({ path: 'body/ranks', message: `At most ${RANK_BATCH_MAX} orders at once.` })
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (seen.has(item.orderId)) problems.push({ path: `body/ranks/${index}/orderId`, message: 'This order is named twice.' })
    seen.add(item.orderId)
    if (item.to !== null && (!Number.isSafeInteger(item.to) || item.to < RANK_MIN || item.to > RANK_MAX)) problems.push({ path: `body/ranks/${index}/to`, message: `A rank is a whole number from ${RANK_MIN} to ${RANK_MAX} (or none).` })
  })
  return problems
}

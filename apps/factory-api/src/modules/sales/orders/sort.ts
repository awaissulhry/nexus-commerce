// B-CW-030: "Most urgent first" — planning's own rule and the office's phase rule (pure).
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { brandSlots, ruleCompare, type BacklogOrder, type PriorityLevel } from '@nexus/factory-domain/planning/backlog/rank'
import { isAfterProduction, officeStripStateOf } from '@nexus/factory-domain/production-brand/stages'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'

/**
 * B-TH-057 (threads plan TH-4; SHEET-G15, feature SHEET.overall-F05 "Sort across all pages"): what Sales › Orders sorts by on
 * the server. The address term `sort` (so a saved view and its file keep it): `customer`, `brand`, `promise`, `daysLate`,
 * `ordered`; `-` in front: the other way round. None: newest first. The list's read is ./orders.ts listOrders.
 * B-CW-030 (customer Work tab plan §3; lead settles S5, S17): + `urgent` — "Most urgent first" (our priority, then the customer's
 * urgent order, then the promise date; `urgentOrderOf` below). Office only: the customer's portal never reads this key.
 */
export const ORDER_SORT_KEYS = ['customer', 'brand', 'promise', 'daysLate', 'ordered', 'urgent' /* B-CW-030 */] as const
export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number]
export const ORDER_SORTS = [...ORDER_SORT_KEYS, ...ORDER_SORT_KEYS.map((key) => `-${key}` as const)] as const
export type OrderSortTerm = (typeof ORDER_SORTS)[number]
export const isOrderSort = (value: unknown): value is OrderSortTerm => typeof value === 'string' && (ORDER_SORTS as readonly string[]).includes(value)

// ── B-CW-030 (customer Work tab plan §3): "Most urgent first" as ONE order of the view's rows ──
/** What the rule reads of an order: its level and number (ours), its own promise date, its customer's code, when it was ordered. */
export interface UrgentSortRow {
  readonly id: string
  readonly number: string
  readonly status: SalesOrderStatus
  readonly orderDate: BusinessDate
  /** The order's own promise date — the one its row shows (none: after every promise). */
  readonly promise: BusinessDate | null
  readonly priority: number
  readonly priorityLevel: PriorityLevel
  /** The customer's code (unique in the tenant): the brand-slot pass groups a customer's orders by it. */
  readonly customerCode: string
}

/**
 * The view's orders, most urgent first, as two groups of ids in order:
 *
 *   open  the orders production still has to do with (waiting for a yes, confirmed, in production, ready, partly shipped), by
 *         planning's own functions (factory-domain planning/backlog/rank): the rule first — our level (Top, High, Normal, Low), our
 *         priority number (higher first), the promise date (earliest first, none last), the customer, the order date, the number —
 *         then the brand-slot pass: inside one level, a customer's Urgent orders (by their place in ITS OWN Urgent list) take the
 *         earliest places that customer's own orders already hold. Another customer's places never change, so a customer's mark
 *         never puts its order ahead of another customer's.
 *   left  the orders that left (shipped, delivered, closed, cancelled), newest first (the order date, then the id).
 *
 * `marks`: the Urgent marks that count among these orders (order id → its place in the customer's own list); an order absent has
 * none — Regular, not kept, or its customer's urgency switch off (the marks then order nothing). Three limits against the planning
 * backlog, so the label never says "the planning order": this is one list over companies (the backlog is per company), it reads
 * the order's own promise date (the backlog each line's current promise), and it knows no hand rank (no screen sets one).
 */
export function urgentOrderOf(rows: readonly UrgentSortRow[], marks: ReadonlyMap<string, number | null>): { readonly open: string[]; readonly left: string[] } {
  const open: BacklogOrder[] = []
  const left: UrgentSortRow[] = []
  for (const row of rows) {
    if (isAfterProduction(officeStripStateOf(row.status))) {
      left.push(row)
      continue
    }
    const counted: Pick<BacklogOrder, 'customerUrgency' | 'urgentRank' | 'urgencyOn'> = marks.has(row.id) ? { customerUrgency: 'URGENT', urgentRank: marks.get(row.id) ?? null, urgencyOn: true } : {}
    open.push({ id: row.id, number: row.number, rank: null, priorityLevel: row.priorityLevel, priority: row.priority, promise: row.promise, customerCode: row.customerCode, orderDate: row.orderDate, ...counted })
  }
  const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  left.sort((a, b) => text(b.orderDate, a.orderDate) || text(b.id, a.id))
  return { open: brandSlots([...open].sort(ruleCompare)).map((order) => order.id), left: left.map((row) => row.id) }
}
// ── end B-CW-030 ──

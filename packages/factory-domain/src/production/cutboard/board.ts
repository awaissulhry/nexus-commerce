import { Dec, HUNDRED, type Decimal } from '../../tax/decimal'

/**
 * The cutting room board (B-W2b-130; MES-163 "Cutting room board"; design production.floor "Cutting room": "Cut orders waiting,
 * in progress, cut vs plan today, hides used and yield today; no cutter names"), pure. One site and one day:
 *
 *   waiting       cut orders PLANNED (the office still plans them) and RELEASED (their tickets wait at the table)
 *   in progress   cut orders IN_PROGRESS (a ticket was scanned at the start)
 *   planned       the garments the plan asked of the day: the cut orders due on the day or before, neither cancelled nor cut
 *                 before the day began, less what their lays cut before the day (fabric)
 *   cut of plan   the garments those cut orders cut on the day: FABRIC the lays cut that day (ratio × plies counted), LEATHER the
 *                 whole order when its ticket ended that day (B-W2b-112: a leather cut order is cut with its one ticket)
 *   cut that day  every garment cut that day, planned for it or cut ahead of the plan
 *
 * Hides used and their yield come from the cut log (factory-domain production/yield), the fabric used from the lays' confirmed
 * fabric (production/lays). Garments, counts and areas only: no money, and nothing per person (Statuto dei Lavoratori art. 4;
 * SCM-255): per cut order, lay, hide, lot and site.
 */

export const OPEN_CUT_STATUSES = ['PLANNED', 'RELEASED', 'IN_PROGRESS'] as const
export const CUT_DONE_STATUSES = ['CUT', 'RECONCILED'] as const

/** How many open cut orders the board lists (the rest are counted: "+ 4 more on the Cutting page"). */
export const CUTBOARD_LIST_LIMIT = 8

/** A day's start and end at the site, as instants (the end is the next day's start). */
export interface DayRange {
  readonly start: Date
  readonly end: Date
}

export const isOpenCutStatus = (status: string): boolean => (OPEN_CUT_STATUSES as readonly string[]).includes(status)

/** What the plan reads of a cut order. */
export interface PlanOrder {
  readonly kind: 'LEATHER' | 'FABRIC'
  readonly status: string
  /** YYYY-MM-DD, or null: no due date (never in the day's plan). */
  readonly dueDate: string | null
  readonly createdAt: Date
  readonly cutAt: Date | null
  readonly cancelledAt: Date | null
  /** Σ garments of its lines. */
  readonly garments: number
  /** Σ ratio of its lines (fabric: the garments one ply cuts). */
  readonly ratioSum: number
  /** Its lays that were cut: when, and the plies counted. */
  readonly cutLays: readonly { readonly cutAt: Date; readonly plies: number }[]
}

const within = (at: Date | null, range: DayRange): boolean => at !== null && at >= range.start && at < range.end

/** The garments a cut order cut inside a range of time. */
export function garmentsCutWithin(order: PlanOrder, range: DayRange): number {
  if (order.kind === 'FABRIC') return order.cutLays.filter((lay) => within(lay.cutAt, range)).reduce((sum, lay) => sum + lay.plies * order.ratioSum, 0)
  return within(order.cutAt, range) ? order.garments : 0
}

/** The garments a cut order cut before an instant. */
function garmentsCutBefore(order: PlanOrder, before: Date): number {
  if (order.kind === 'FABRIC') return order.cutLays.filter((lay) => lay.cutAt < before).reduce((sum, lay) => sum + lay.plies * order.ratioSum, 0)
  return order.cutAt !== null && order.cutAt < before ? order.garments : 0
}

/** Whether the day's plan holds the cut order: due by the day, made before it ended, not cut or cancelled before it began. */
export function inDayPlan(order: PlanOrder, day: string, range: DayRange): boolean {
  if (order.dueDate === null || order.dueDate > day) return false
  if (order.createdAt >= range.end) return false
  if (order.cancelledAt !== null && order.cancelledAt < range.end) return false
  if (order.status === 'CANCELLED' && order.cancelledAt === null) return false
  return order.cutAt === null || order.cutAt >= range.start
}

export interface DayPlan {
  /** The garments the plan asked of the day. */
  readonly planned: number
  /** Of those, the garments cut on the day. */
  readonly cut: number
  /** Every garment cut on the day (planned or ahead of the plan). */
  readonly cutThatDay: number
  /** cut ÷ planned, whole percent; null: nothing was planned. */
  readonly pct: number | null
}

/** Cut against plan for one day. */
export function dayPlan(orders: readonly PlanOrder[], day: string, range: DayRange): DayPlan {
  let planned = 0
  let cut = 0
  let cutThatDay = 0
  for (const order of orders) {
    const that = garmentsCutWithin(order, range)
    cutThatDay += that
    if (!inDayPlan(order, day, range)) continue
    planned += Math.max(0, order.garments - garmentsCutBefore(order, range.start))
    cut += that
  }
  return { planned, cut, cutThatDay, pct: sharePct(cut, planned) }
}

/** part ÷ whole as a whole percent (half up); null when the whole is 0. */
export function sharePct(part: number, whole: number): number | null {
  if (whole <= 0) return null
  return Math.round((part * 100) / whole)
}

/** An open cut order past its due date on the day. */
export const isLate = (order: { readonly status: string; readonly dueDate: string | null }, day: string): boolean => isOpenCutStatus(order.status) && order.dueDate !== null && order.dueDate < day

const STATUS_RANK: Readonly<Record<string, number>> = Object.freeze({ IN_PROGRESS: 0, RELEASED: 1, PLANNED: 2 })

/** The board's list order: cutting now, then released to the table, then still planned; earliest due first (none last), then by number. */
export function boardOrder(a: { readonly status: string; readonly dueDate: string | null; readonly number: string }, b: { readonly status: string; readonly dueDate: string | null; readonly number: string }): number {
  const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
  if (rank !== 0) return rank
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1
    if (b.dueDate === null) return -1
    return a.dueDate < b.dueDate ? -1 : 1
  }
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0
}

/** (used − estimated) ÷ estimated in percent, one place; null when nothing was estimated. */
export function differencePct(used: Decimal, estimated: Decimal): string | null {
  if (estimated.isZero()) return null
  return used.minus(estimated).times(HUNDRED).div(estimated).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

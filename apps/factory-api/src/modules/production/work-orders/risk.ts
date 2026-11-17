import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON, type WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { daysLate, OPEN_STATUSES, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { dayOf, type Reader } from './store'

/**
 * B-PR-34 (production plan §5 "Work orders: sorted by risk"; 06-tree §0.4 "Risk sort", A.3 O-WOL-grid; 08-backend §7; review
 * fix R-31): the risk of a work order on the office's list and what it waits on, computed per query from what is stored —
 * nothing here is a new column:
 *
 *   LATE      open (DRAFT, RELEASED, IN_PROGRESS, ON_HOLD) past its due date; the most days late first
 *   AT_RISK   open, not late, and its bars on the site's WORKING plan end after its due date (planning/promise/store
 *             plannedFinishesOf: the board's planned finish), or a person of the factory raised one of its orders to At risk and
 *             the raise still stands (BrandOrderProduction.healthSet, B-PR-35; the keeper drops it, B-PR-17)
 *   BLOCKED   open, neither late nor at risk, and it cannot move: on hold (HOLD), or its order waits on the customer (CUSTOMER:
 *             an approval, a task, the deposit, its own pause) or on a supplier (MATERIAL) — the keeper's
 *             BrandOrderProduction.waitingOn (B-PR-17); a workshop's work is moving, so it is not a block
 *   ON_TRACK  any other open work order; a finished one (COMPLETED, CLOSED, CANCELLED) has no risk
 *
 * Waiting on per row: the keeper's of the work order's own sales order(s) — the first owner in the order customer → supplier →
 * workshop → us, since the earliest of that owner's rows (one customer per work order, B-PR-01: its orders are that customer's;
 * a legacy mixed one only reaches people of every customer). Only an open work order waits on someone; a work order of no order
 * (a sample of no customer) or an order the keeper has not kept yet waits on no one we know ("—").
 *
 * The sorts: `risk` = LATE → AT_RISK → BLOCKED → ON_TRACK → finished, then by due date (oldest first, none last), then newest;
 * `due` = by due date, then newest; `newest` = by id, newest first (the list's default, as before). A computed sort pages with an
 * opaque cursor over (risk, due, id): `<sort>~<rank>~<due>~<id>`, so the next page starts right after the last row read even when
 * that row left the list meanwhile. The customer urgency tie-break ("ties by brand priority") comes with B-PR-22b.
 */

// ── B-PR-34 ──
export const LIST_SORTS = ['newest', 'risk', 'due'] as const
export type ListSort = (typeof LIST_SORTS)[number]

export const WORK_ORDER_RISKS = ['LATE', 'AT_RISK', 'BLOCKED', 'ON_TRACK'] as const
export type WorkOrderRisk = (typeof WORK_ORDER_RISKS)[number]

export const BLOCKED_BY = ['HOLD', 'CUSTOMER', 'MATERIAL'] as const
export type BlockedBy = (typeof BLOCKED_BY)[number]

/** What the risk of one work order is computed from. */
export interface RiskInput {
  readonly status: WorkOrderStatus
  readonly dueDate: BusinessDate | null
  /** The day its last bar on the WORKING plan ends (site zone); null: not on the board. */
  readonly plannedEnd: BusinessDate | null
  /** What its order(s) wait on (null: no order kept, or finished). */
  readonly waiting: RowWaiting | null
  /** The reason of a standing raise to At risk on one of its orders (null: none). */
  readonly raised: HealthReasonCode | null
}

export interface RowWaiting {
  readonly on: WaitingOn
  readonly since: Date | null
}

export interface RowRisk {
  readonly state: WorkOrderRisk
  /** Whole days past the due date (only when LATE). */
  readonly daysLate: number | null
  readonly plannedEnd: BusinessDate | null
  /** Its planned end is after its due date. */
  readonly planAfterDue: boolean
  /** A person raised its order to At risk, with this reason (it stands). */
  readonly raised: HealthReasonCode | null
  /** Why it cannot move, whatever its state (a late work order may be on hold too). */
  readonly blockedBy: BlockedBy | null
}

const isOpen = (status: WorkOrderStatus): boolean => OPEN_STATUSES.includes(status)

/** Why the work order cannot move (null: nothing blocks it). */
export function blockedByOf(status: WorkOrderStatus, waiting: RowWaiting | null): BlockedBy | null {
  if (!isOpen(status)) return null
  if (status === 'ON_HOLD') return 'HOLD'
  if (waiting?.on === 'BRAND') return 'CUSTOMER'
  if (waiting?.on === 'SUPPLIER') return 'MATERIAL'
  return null
}

/** The risk of one work order on `today` (null: finished, no risk). */
export function riskOf(input: RiskInput, today: BusinessDate): RowRisk | null {
  if (!isOpen(input.status)) return null
  const late = daysLate(input.status, input.dueDate, today) ?? 0
  const planAfterDue = input.dueDate !== null && input.plannedEnd !== null && input.plannedEnd > input.dueDate
  const blockedBy = blockedByOf(input.status, input.waiting)
  const state: WorkOrderRisk = late > 0 ? 'LATE' : planAfterDue || input.raised !== null ? 'AT_RISK' : blockedBy !== null ? 'BLOCKED' : 'ON_TRACK'
  return { state, daysLate: late > 0 ? late : null, plannedEnd: input.plannedEnd, planAfterDue, raised: input.raised, blockedBy }
}

/** The risk's place in the risk sort: LATE 0 … ON_TRACK 3, finished 4. */
export const riskRank = (risk: RowRisk | null): number => (risk === null ? WORK_ORDER_RISKS.length : WORK_ORDER_RISKS.indexOf(risk.state))

/** Several orders' waiting merged: the first owner in the order customer → supplier → workshop → us, since its earliest row. */
export function mergeWaiting(rows: readonly RowWaiting[]): RowWaiting | null {
  for (const on of WAITING_ON) {
    const mine = rows.filter((row) => row.on === on)
    if (mine.length === 0) continue
    const known = mine.flatMap((row) => (row.since === null ? [] : [row.since.getTime()]))
    return { on, since: known.length > 0 ? new Date(Math.min(...known)) : null }
  }
  return null
}

// ---- the sort and its cursor -------------------------------------------------------------------------------------------------

/** A row's place in a sort. */
export interface SortKey {
  readonly rank: number
  readonly due: BusinessDate | null
  readonly id: string
}

const byDue = (a: BusinessDate | null, b: BusinessDate | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1)
const newestFirst = (a: string, b: string): number => (a === b ? 0 : a < b ? 1 : -1)

/** The order of two rows in a sort (negative: `a` first). */
export function compareKeys(sort: ListSort, a: SortKey, b: SortKey): number {
  if (sort === 'risk' && a.rank !== b.rank) return a.rank - b.rank
  if (sort !== 'newest') {
    const due = byDue(a.due, b.due)
    if (due !== 0) return due
  }
  return newestFirst(a.id, b.id)
}

const CURSOR = /^(risk|due)~([0-9])~(\d{4}-\d{2}-\d{2})?~([0-9a-fA-F-]{36})$/

/** The cursor of the page after a row: its id for `newest` (as before), else its position token in the sort. */
export const encodeCursor = (sort: ListSort, key: SortKey): string => (sort === 'newest' ? key.id : `${sort}~${key.rank}~${key.due ?? ''}~${key.id}`)

/** A cursor as the list wrote it (a work order id for `newest`, else the position token of the same sort); else refused in words. */
export function decodeCursor(sort: ListSort, cursor: string | undefined): SortKey | null {
  if (cursor === undefined) return null
  if (sort === 'newest') {
    if (isUuid(cursor)) return { rank: 0, due: null, id: cursor.toLowerCase() }
  } else {
    const match = CURSOR.exec(cursor)
    if (match && match[1] === sort && isUuid(match[4]!)) return { rank: Number(match[2]), due: match[3] ?? null, id: match[4]!.toLowerCase() }
  }
  throw new ValidationError('This page of the list cannot be read: start from the first page.', [{ path: 'query/cursor', message: `Not a cursor of the ${sort} sort.` }])
}

/** One page of rows in the sort, after the cursor's position, and the cursor of the next page. */
export function pageOf<Row extends { readonly key: SortKey }>(rows: readonly Row[], sort: ListSort, after: SortKey | null, limit: number): { page: Row[]; next: string | null } {
  const sorted = [...rows].sort((a, b) => compareKeys(sort, a.key, b.key))
  const rest = after === null ? sorted : sorted.filter((row) => compareKeys(sort, row.key, after) > 0)
  const page = rest.slice(0, limit)
  return { page, next: rest.length > limit ? encodeCursor(sort, page[page.length - 1]!.key) : null }
}

// ---- the stored facts ----------------------------------------------------------------------------------------------------------

/** A work order as the risk needs it (the list's light read). */
export interface RiskRow {
  readonly id: string
  readonly status: WorkOrderStatus
  readonly dueDate: BusinessDate | null
  readonly siteId: string
  /** The site's zone: the day a bar ends. */
  readonly timezone: string
}

export interface RowFacts {
  readonly risk: RowRisk | null
  readonly waiting: RowWaiting | null
}

/**
 * The risk and waiting of each work order, read from what is stored: the WORKING plan's bars of the open ones (one read per site),
 * their orders (their cells' order lines) and those orders' production state (BrandOrderProduction by its key, B-PR-15/17). Reads
 * only the rows' own orders: a work order's cells are of its one customer.
 */
export async function riskFactsOf(db: Reader, rows: readonly RiskRow[], today: BusinessDate): Promise<Map<string, RowFacts>> {
  const out = new Map<string, RowFacts>()
  const open = rows.filter((row) => isOpen(row.status))
  for (const row of rows) if (!isOpen(row.status)) out.set(row.id, { risk: null, waiting: null })
  if (open.length === 0) return out

  // The planned end of each open work order on its site's WORKING plan.
  const plannedEnd = new Map<string, BusinessDate>()
  const bySite = new Map<string, { timezone: string; ids: string[] }>()
  for (const row of open) {
    const site = bySite.get(row.siteId) ?? { timezone: row.timezone, ids: [] }
    site.ids.push(row.id)
    bySite.set(row.siteId, site)
  }
  for (const [siteId, site] of bySite) {
    for (const [workOrderId, day] of await plannedEndsOf(db, siteId, site.timezone, site.ids)) plannedEnd.set(workOrderId, day)
  }

  // Their orders, and each order's production state.
  const cells = await db.workOrderSize.findMany({
    where: { workOrderId: { in: open.map((row) => row.id) }, salesOrderLineId: { not: null } },
    distinct: ['workOrderId', 'salesOrderLineId'],
    select: { workOrderId: true, salesOrderLine: { select: { orderId: true } } },
  })
  const ordersOf = new Map<string, Set<string>>()
  for (const cell of cells) {
    if (!cell.salesOrderLine) continue
    const orders = ordersOf.get(cell.workOrderId) ?? new Set<string>()
    orders.add(cell.salesOrderLine.orderId)
    ordersOf.set(cell.workOrderId, orders)
  }
  const orderIds = [...new Set(cells.flatMap((cell) => (cell.salesOrderLine ? [cell.salesOrderLine.orderId] : [])))].sort()
  const states =
    orderIds.length === 0
      ? []
      : await db.brandOrderProduction.findMany({
          where: { key: { in: orderIds.map((orderId) => `brand-production:${orderId}`) } },
          select: { salesOrderId: true, waitingOn: true, waitingSince: true, healthSet: true, healthReasonCode: true, healthSetUntil: true },
        })
  const stateOf = new Map(states.map((state) => [state.salesOrderId, state]))

  for (const row of open) {
    const orders = [...(ordersOf.get(row.id) ?? [])].sort()
    const kept = orders.flatMap((orderId) => {
      const state = stateOf.get(orderId)
      return state ? [state] : []
    })
    const waiting = mergeWaiting(kept.flatMap((state) => (state.waitingOn ? [{ on: state.waitingOn as WaitingOn, since: state.waitingSince }] : [])))
    // A raise stands until its last day (the keeper also drops it once the computed health changed).
    const raise = kept.find((state) => state.healthSet !== null && state.healthReasonCode !== null && state.healthSetUntil !== null && today < dayOf(state.healthSetUntil))
    const raised = (raise?.healthReasonCode ?? null) as HealthReasonCode | null
    out.set(row.id, { risk: riskOf({ status: row.status, dueDate: row.dueDate, plannedEnd: plannedEnd.get(row.id) ?? null, waiting, raised }, today), waiting })
  }
  return out
}

/**
 * When each work order's bars on its site's WORKING plan end: the day (site zone) its latest bar ends — the rule of
 * planning/promise/store plannedFinishesOf (the board's planned finish), read here without that module's imports so the list's
 * contract stays light. A work order not on the board has none.
 */
async function plannedEndsOf(db: Reader, siteId: string, timezone: string, workOrderIds: readonly string[]): Promise<Map<string, BusinessDate>> {
  const out = new Map<string, BusinessDate>()
  if (workOrderIds.length === 0) return out
  const plan = await db.planVersion.findFirst({ where: { siteId, kind: 'WORKING' }, select: { id: true } })
  if (!plan) return out
  const rows = await db.scheduleSlot.groupBy({ by: ['workOrderId'], where: { planVersionId: plan.id, workOrderId: { in: [...workOrderIds] } }, _max: { endAt: true } })
  for (const row of rows) if (row._max.endAt) out.set(row.workOrderId, businessDate(new Date(row._max.endAt.getTime() - 1), timezone))
  return out
}

/** Does a row pass the computed filters (waiting on, risk, blocked by)? */
export function passes(facts: RowFacts | undefined, filter: { readonly waitingOn?: WaitingOn | undefined; readonly risk?: WorkOrderRisk | undefined; readonly blockedBy?: BlockedBy | undefined }): boolean {
  if (filter.waitingOn !== undefined && facts?.waiting?.on !== filter.waitingOn) return false
  if (filter.risk !== undefined && facts?.risk?.state !== filter.risk) return false
  if (filter.blockedBy !== undefined && facts?.risk?.blockedBy !== filter.blockedBy) return false
  return true
}
// ── end B-PR-34 ──

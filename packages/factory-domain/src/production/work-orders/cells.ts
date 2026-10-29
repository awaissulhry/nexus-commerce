import type { Issue } from '../../core/errors'

/**
 * A work order's cells from sales order lines (B-W1-38; features MES-001, MES-002; plan A1 §2.4 E), pure. A work order
 * makes ONE style at ONE site of the order's company, as a size grid: each cell is the pieces of one colourway in one
 * size, from one sales order line of that style (lines of several orders of the company may share a work order). A
 * cell takes at most what is still open on its line for that size: the size's ordered pieces less those already on
 * other work orders that are not CANCELLED (a cancelled work order gives its pieces back). One cell per colourway and
 * size (the table's unique key). Cells change only while the work order is a DRAFT (the …_production_guards trigger).
 *
 * Made-to-measure units (MES-003) are deferred by the Owner (Q9: the first order is a brand size run; B-W1-17/18): a
 * made-to-measure line is refused with MADE_TO_MEASURE_LATER, never made into a size-grid cell.
 */

/** Order statuses a work order is made for: confirmed, and already in production. */
export const ORDER_STATUSES_FOR_WORK_ORDERS = ['CONFIRMED', 'IN_PRODUCTION'] as const

/** Most cells one request names, and one work order holds. */
export const MAX_CELLS = 400
/** Most order lines one work order is made from in one request. */
export const MAX_LINES = 50
/** Most pieces in one cell. */
export const MAX_CELL_PIECES = 100_000

export const MADE_TO_MEASURE_LATER =
  'Made-to-measure comes later: this step makes size-run work orders only (the made-to-measure unit work order is B-W1-17/18, deferred by the Owner).'

/** A sales order line as the cell rules read it. */
export interface OrderLineFacts {
  readonly id: string
  readonly seq: number
  readonly orderId: string
  readonly orderNumber: string
  readonly orderStatus: string
  readonly companyId: string
  readonly partyId: string
  readonly kind: 'SIZE_GRID' | 'MADE_TO_MEASURE'
  readonly styleId: string
  /** The revision the order fixes for the line, if any. */
  readonly styleRevisionId: string | null
  readonly colourwayId: string
  /** The line's making site; null: not decided. */
  readonly siteId: string | null
  /** The size grid: pieces ordered per size. */
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  /** Pieces of each size already on OTHER work orders that are not CANCELLED. */
  readonly onWorkOrders: Readonly<Record<string, number>>
}

/** The work order the cells are for. */
export interface CellTarget {
  readonly companyId: string
  readonly siteId: string
  readonly styleId: string
  /** The style's size range, in order. */
  readonly styleSizes: readonly string[]
  /** The revision chosen for the work order (null: none yet). */
  readonly styleRevisionId: string | null
}

/** One cell asked for: a line's size and its pieces (0 removes the cell). */
export interface CellRequest {
  readonly salesOrderLineId: string
  readonly size: string
  readonly quantity: number
}

/** One size of a line: ordered, already on other work orders, still open. */
export interface OpenSize {
  readonly size: string
  readonly ordered: number
  readonly onWorkOrders: number
  readonly open: number
}

/** The line's sizes with what is still open on each, in the line's order. */
export function openSizes(line: Pick<OrderLineFacts, 'sizes' | 'onWorkOrders'>): OpenSize[] {
  return line.sizes.map(({ size, quantity }) => {
    const taken = line.onWorkOrders[size] ?? 0
    return { size, ordered: quantity, onWorkOrders: taken, open: Math.max(0, quantity - taken) }
  })
}

const lineLabel = (line: Pick<OrderLineFacts, 'orderNumber' | 'seq'>): string => `${line.orderNumber} line ${line.seq}`

/**
 * Why the line cannot make cells of this work order (empty: it can). The made-to-measure refusal is not here: the
 * caller refuses such a line first, with its own answer (MADE_TO_MEASURE_LATER).
 */
export function lineProblems(line: OrderLineFacts, target: CellTarget, path: string): Issue[] {
  const problems: Issue[] = []
  const label = lineLabel(line)
  if (!(ORDER_STATUSES_FOR_WORK_ORDERS as readonly string[]).includes(line.orderStatus)) {
    problems.push({ path, message: `${label}: the order is ${line.orderStatus}; work orders are made for CONFIRMED or IN_PRODUCTION orders.` })
  }
  if (line.companyId !== target.companyId) problems.push({ path, message: `${label} is an order of another company than the work order's site.` })
  if (line.styleId !== target.styleId) problems.push({ path, message: `${label} is another style: a work order makes one style.` })
  if (line.siteId !== null && line.siteId !== target.siteId) problems.push({ path, message: `${label} is made at another site.` })
  if (line.styleRevisionId !== null && target.styleRevisionId !== null && line.styleRevisionId !== target.styleRevisionId) {
    problems.push({ path, message: `${label} is ordered to another revision of the style than the work order's.` })
  }
  return problems
}

/** Why `quantity` pieces of `size` cannot be a cell from this line (empty: they can). */
export function cellProblems(line: OrderLineFacts, target: Pick<CellTarget, 'styleSizes'>, size: string, quantity: number, path: string): Issue[] {
  const label = lineLabel(line)
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_CELL_PIECES) {
    return [{ path: `${path}/quantity`, message: `Expected whole pieces from 0 (0 removes the cell) to ${MAX_CELL_PIECES}.` }]
  }
  if (!target.styleSizes.includes(size)) return [{ path: `${path}/size`, message: `Size ${size} is not in the style's size range.` }]
  const open = openSizes(line).find((entry) => entry.size === size)
  if (!open) return [{ path: `${path}/size`, message: `${label} orders no size ${size}.` }]
  if (quantity > open.open) {
    return [
      {
        path: `${path}/quantity`,
        message: `${label} size ${size}: ${open.ordered} ordered, ${open.onWorkOrders} already on other work orders, so ${open.open} can still be made; ${quantity} asked.`,
      },
    ]
  }
  return []
}

/** A cell as the work order holds it (for the uniqueness of colourway × size). */
export interface HeldCell {
  readonly salesOrderLineId: string
  readonly colourwayId: string
  readonly size: string
}

/**
 * Two cells of one colourway and size from different lines (the work order holds one per colourway and size): the
 * requests that clash with a held cell or with each other.
 */
export function clashProblems(
  requests: readonly (CellRequest & { readonly colourwayId: string })[],
  held: readonly HeldCell[],
  path: string,
): Issue[] {
  const owner = new Map(held.map((cell) => [`${cell.colourwayId}\u0000${cell.size}`, cell.salesOrderLineId]))
  const problems: Issue[] = []
  requests.forEach((request, index) => {
    if (request.quantity === 0) return
    const key = `${request.colourwayId}\u0000${request.size}`
    const current = owner.get(key)
    if (current !== undefined && current !== request.salesOrderLineId) {
      problems.push({ path: `${path}/${index}`, message: `Size ${request.size} of this colourway is already made for another order line on this work order: one cell per colourway and size.` })
    } else {
      owner.set(key, request.salesOrderLineId)
    }
  })
  return problems
}

/** The cells to ask for a line when none are named: every size with pieces still open. */
export function allOpenCells(line: OrderLineFacts): CellRequest[] {
  return openSizes(line)
    .filter((entry) => entry.open > 0)
    .map((entry) => ({ salesOrderLineId: line.id, size: entry.size, quantity: entry.open }))
}

/** A request's cells per line and size: a size named twice for one line is refused (the caller says which). */
export function duplicateRequests(requests: readonly CellRequest[], path: string): Issue[] {
  const seen = new Set<string>()
  const problems: Issue[] = []
  requests.forEach((request, index) => {
    const key = `${request.salesOrderLineId}\u0000${request.size}`
    if (seen.has(key)) problems.push({ path: `${path}/${index}`, message: `Size ${request.size} of this order line is named twice.` })
    seen.add(key)
  })
  return problems
}

/** The revision a new work order is made to: the one asked, else the one its lines fix, else the style's released one. */
export function revisionFor(asked: string | null, lines: readonly Pick<OrderLineFacts, 'styleRevisionId'>[], released: string | null): { readonly revisionId: string | null; readonly problem: string | null } {
  const fixed = [...new Set(lines.map((line) => line.styleRevisionId).filter((id): id is string => id !== null))]
  if (fixed.length > 1) return { revisionId: null, problem: 'These order lines are ordered to different revisions of the style: make one work order per revision.' }
  if (asked !== null && fixed.length === 1 && fixed[0] !== asked) return { revisionId: null, problem: 'These order lines are ordered to another revision of the style than the one asked.' }
  return { revisionId: asked ?? fixed[0] ?? released, problem: null }
}

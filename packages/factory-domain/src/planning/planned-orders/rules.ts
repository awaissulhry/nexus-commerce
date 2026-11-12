import type { BusinessDate } from '../../core/time'
import type { PlanOrderLine, PlanWorkOrderCell } from '../explode'

/**
 * Planned work orders and planned subcontract orders (B-W2b-293; PLN-067, PLN-068, PLN-069, PLN-089; design planning.mrp
 * "To make"), pure. The run proposes the work its orders still need; a person makes each one real.
 *
 *   to make      per order line and size: the pieces ordered, less those on work orders (open or made; a cancelled one
 *                gives its pieces back, a repair is no production) and those a kept planned order already pegs (firm,
 *                or with fields a planner protected). A made-to-measure unit is W1's own path (no proposal).
 *   grouping     one planned order per style, the revision the order line names (PLN-089: the line's own; none named:
 *                the style's RELEASED one when it is made real), colourway and due date (W1's one grid), split by the
 *                site's size-run rule (PLN-068): ONE_GRID keeps every size in one grid, SIZE_GROUPS makes one planned
 *                order per group of sizes (a size in no group: a group of its own)
 *   kind         MAKE, or SUBCONTRACT when the revision's routing sends steps to a workshop (RoutingOperation.supplierId,
 *                W2a PRD-120; PLN-069): the first such step's workshop with every step it does (the steps of another
 *                workshop stay its own subcontract orders, made after the release). A workshop that is no ACTIVE
 *                subcontractor is not proposed: the order is MAKE and says why.
 *   life         one row lives across runs (B-W2b-286): a run moves a row of the same key on (the new run, its sizes,
 *                demand and dates), adds the new ones and removes a plain PLANNED one nothing needs any more. A firm
 *                row is never changed by a run (it only moves on to the new run) and its demand counts as covered;
 *                B-W2b-306 (PLN-076): a row a planner protected fields of follows its demand, the run rewriting only the
 *                fields not protected (planning/actions/protect); a CONVERTED one is history.
 */

export const SIZE_RUN_RULES = ['ONE_GRID', 'SIZE_GROUPS'] as const
export type SizeRunRule = (typeof SIZE_RUN_RULES)[number]
export const PLANNED_ORDER_KINDS = ['MAKE', 'SUBCONTRACT'] as const
export type PlannedOrderKind = (typeof PLANNED_ORDER_KINDS)[number]
export const PLANNED_ORDER_STATUSES = ['PLANNED', 'CONVERTED'] as const
export type PlannedOrderStatus = (typeof PLANNED_ORDER_STATUSES)[number]
/** The fields a planner may protect from the next run (the database's list; B-W2b-306 protects them). */
export const PROTECTABLE_FIELDS = ['sizes', 'startDate', 'dueDate', 'lineId', 'partyId', 'operationSeqs', 'kitDueAt', 'styleRevisionId'] as const

/** At most this many planned orders are made real in one request. */
export const MAX_CONVERT = 50
/** A size run of a planned order: at most this many sizes (the database's). */
export const MAX_SIZES = 200
/** A planned order pegs at most this many demands (the database's). */
export const MAX_DEMAND = 1000
/** One working day of a lane, in standard minutes, for the planned order's own lead time. */
export const DAY_MINUTES = 480

export interface SizeQuantity {
  readonly size: string
  readonly quantity: number
}

/** One demand a planned order pegs (PlannedWorkOrder.demand). */
export interface PeggedDemand {
  readonly orderId: string
  readonly orderLineId: string
  readonly size: string
  readonly pieces: number
  /**
   * B-W2b-306 (PLN-083): the day the order line needs it (its date; none: the run's day). The planned order's own due date
   * may be later when it cannot be ready in time (late demand starts today); the row keeps its key by this day.
   */
  readonly needDate?: BusinessDate
}

/**
 * The groups a size run is split by, with their words: ONE_GRID one grid (no words); SIZE_GROUPS the site's groups (their
 * words from the group as set, "44-50", so a group keeps its name whatever sizes a run has), then each size in no group on
 * its own (its code). Sizes in run order; a group none of whose sizes is in the run is left out.
 */
export function sizeGroupsOf(sizes: readonly string[], rule: SizeRunRule, groups: readonly (readonly string[])[]): { readonly codes: string[]; readonly words: string | null }[] {
  if (sizes.length === 0) return []
  if (rule === 'ONE_GRID' || groups.length === 0) return [{ codes: [...sizes], words: null }]
  const out: { codes: string[]; words: string | null }[] = []
  for (const group of groups) {
    const inGroup = sizes.filter((size) => group.includes(size))
    if (inGroup.length > 0) out.push({ codes: inGroup, words: sizeGroupWords(group, rule) })
  }
  for (const size of sizes) if (!groups.some((group) => group.includes(size))) out.push({ codes: [size], words: size })
  return out
}

/** The words of a group of sizes: "44-50" (its first and last code), one code alone; null for one grid. */
export function sizeGroupWords(codes: readonly string[], rule: SizeRunRule): string | null {
  if (rule === 'ONE_GRID' || codes.length === 0) return null
  return codes.length === 1 ? codes[0]! : `${codes[0]}-${codes[codes.length - 1]}`
}

/** What a revision's routing says about its outside work: the workshop the order goes to, and the steps it does. */
export interface OutsideWork {
  readonly partyId: string
  /** The workshop's routing steps (RoutingOperation.seq), in order. */
  readonly operationSeqs: readonly number[]
  /** The steps' transit days, added up (the days the work is away). */
  readonly transitDays: number
  /** Whether the workshop may get work: an ACTIVE party with the SUBCONTRACTOR role. */
  readonly usable: boolean
  /** Why it may not, in words (null when usable). */
  readonly why: string | null
}

/** The outside work of a routing: the first step with a workshop, and every step of that workshop. */
export function outsideWorkOf(steps: readonly { readonly seq: number; readonly supplierId: string | null; readonly transitDays: number | null }[], workshop: (partyId: string) => { readonly usable: boolean; readonly why: string | null }): OutsideWork | null {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq)
  const first = sorted.find((step) => step.supplierId !== null)
  if (!first) return null
  const mine = sorted.filter((step) => step.supplierId === first.supplierId)
  const facts = workshop(first.supplierId!)
  return { partyId: first.supplierId!, operationSeqs: mine.map((step) => step.seq), transitDays: mine.reduce((sum, step) => sum + (step.transitDays ?? 0), 0), usable: facts.usable, why: facts.why }
}

/** One open cell of demand no work order or kept planned order makes yet. */
export interface OpenCell {
  readonly line: PlanOrderLine
  /** The revision the order line names itself (PLN-089); null: none (the RELEASED one when it is made real). */
  readonly ownRevisionId: string | null
  readonly size: string
  readonly sizeIndex: number
  readonly pieces: number
}

/**
 * Per order line and size, the pieces no work order makes and no kept planned order pegs (made-to-measure units and lines
 * without a revision to make are left out).
 */
export function openCells(
  lines: readonly PlanOrderLine[],
  ownRevisionOf: (orderLineId: string) => string | null,
  workOrderCells: readonly Pick<PlanWorkOrderCell, 'orderLineId' | 'size' | 'pieces'>[],
  kept: readonly PeggedDemand[],
): OpenCell[] {
  const taken = new Map<string, number>()
  const add = (orderLineId: string, size: string, pieces: number) => taken.set(`${orderLineId}|${size}`, (taken.get(`${orderLineId}|${size}`) ?? 0) + pieces)
  for (const cell of workOrderCells) add(cell.orderLineId, cell.size, cell.pieces)
  for (const demand of kept) add(demand.orderLineId, demand.size, demand.pieces)
  const out: OpenCell[] = []
  for (const line of lines) {
    if (line.madeToMeasure || line.revisionId === null) continue
    line.sizes.forEach((row, sizeIndex) => {
      const pieces = row.pieces - (taken.get(`${line.orderLineId}|${row.size}`) ?? 0)
      if (pieces > 0) out.push({ line, ownRevisionId: ownRevisionOf(line.orderLineId), size: row.size, sizeIndex, pieces })
    })
  }
  return out
}

/** A planned order the run proposes (its dates follow from its lead time: the API's calendars). */
export interface Proposal {
  /** The row's key across runs (`proposalKey`). */
  readonly key: string
  readonly kind: PlannedOrderKind
  readonly styleId: string
  readonly colourwayId: string
  /** PLN-089: the revision the order lines name (null: the RELEASED one when made real). */
  readonly styleRevisionId: string | null
  /** The revision planned (its BOM and routing): the lines' own, else the released one. */
  readonly planRevisionId: string
  readonly sizeGroup: string | null
  readonly sizes: readonly SizeQuantity[]
  readonly quantity: number
  readonly dueDate: BusinessDate
  readonly demand: readonly PeggedDemand[]
  /** SUBCONTRACT: the workshop and its steps. */
  readonly partyId: string | null
  readonly operationSeqs: readonly number[]
  readonly transitDays: number
}

export const proposalKey = (row: { readonly kind: string; readonly styleId: string; readonly colourwayId: string; readonly styleRevisionId: string | null; readonly sizeGroup: string | null; readonly dueDate: BusinessDate }): string =>
  [row.kind, row.styleId, row.colourwayId, row.styleRevisionId ?? '-', row.sizeGroup ?? '-', row.dueDate].join('|')

/**
 * The planned orders for the open cells: grouped by style, the revision the lines name, colourway and due date (a line
 * without a date is due on the run's day), split by the size-run rule; sizes in the style's order as the lines give them.
 */
export function proposeWork(input: {
  readonly cells: readonly OpenCell[]
  readonly runDate: BusinessDate
  readonly rule: SizeRunRule
  readonly groups: readonly (readonly string[])[]
  /** The style's size range (the order of a size run). */
  readonly sizesOf: (styleId: string) => readonly string[]
  /** The revision's outside work (null: everything in-house). */
  readonly outsideOf: (revisionId: string) => OutsideWork | null
}): Proposal[] {
  const groups = new Map<string, OpenCell[]>()
  for (const cell of input.cells) {
    const due = cell.line.dueDate ?? input.runDate
    const key = [cell.line.styleId, cell.ownRevisionId ?? '-', cell.line.revisionId, cell.line.colourwayId, due].join('|')
    groups.set(key, [...(groups.get(key) ?? []), cell])
  }
  const out: Proposal[] = []
  for (const cells of groups.values()) {
    const first = cells[0]!
    const dueDate = first.line.dueDate ?? input.runDate
    const range = input.sizesOf(first.line.styleId)
    const order = (size: string) => {
      const at = range.indexOf(size)
      return at < 0 ? Number.MAX_SAFE_INTEGER : at
    }
    const sizes = [...new Set(cells.map((cell) => cell.size))].sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))
    const outside = input.outsideOf(first.line.revisionId!)
    const subcontract = outside !== null && outside.usable
    for (const { codes, words } of sizeGroupsOf(sizes, input.rule, input.groups)) {
      const mine = cells.filter((cell) => codes.includes(cell.size))
      const sizeRun = codes.map((size) => ({ size, quantity: mine.filter((cell) => cell.size === size).reduce((sum, cell) => sum + cell.pieces, 0) })).filter((row) => row.quantity > 0)
      if (sizeRun.length === 0) continue
      const sizeGroup = words
      const demand = [...mine]
        .sort((a, b) => (a.line.orderNumber < b.line.orderNumber ? -1 : a.line.orderNumber > b.line.orderNumber ? 1 : a.line.lineSeq - b.line.lineSeq || a.sizeIndex - b.sizeIndex))
        // B-W2b-306 (PLN-083): each demand says the day it is needed (the row's key day, whatever its due date becomes).
        .map((cell) => ({ orderId: cell.line.orderId, orderLineId: cell.line.orderLineId, size: cell.size, pieces: cell.pieces, needDate: dueDate }))
      const kind: PlannedOrderKind = subcontract ? 'SUBCONTRACT' : 'MAKE'
      const row = { kind, styleId: first.line.styleId, colourwayId: first.line.colourwayId, styleRevisionId: first.ownRevisionId, sizeGroup, dueDate }
      out.push({
        ...row,
        key: proposalKey(row),
        planRevisionId: first.line.revisionId!,
        sizes: sizeRun,
        quantity: sizeRun.reduce((sum, entry) => sum + entry.quantity, 0),
        demand,
        partyId: subcontract ? outside.partyId : null,
        operationSeqs: subcontract ? outside.operationSeqs : [],
        transitDays: subcontract ? outside.transitDays : 0,
      })
    }
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** The working days a planned order takes in-house: its routing's in-house standard minutes for its garments (at least one). */
export function inHouseDays(steps: readonly { readonly standardMinutes: string; readonly outside: boolean }[], garments: number): number {
  const minutes = steps.filter((step) => !step.outside).reduce((sum, step) => sum + Number(step.standardMinutes) * garments, 0)
  return Math.max(1, Math.ceil(minutes / DAY_MINUTES))
}

/**
 * A row the run keeps whole: a firm one (it only moves on to the new run; its demand counts as covered). B-W2b-306
 * (PLN-076): a row a planner protected fields of is no longer kept whole: the run rewrites the fields NOT protected
 * (planning/actions/protect), so `protectedFields` does not make it kept.
 */
export const keptByRun = (row: { readonly status: PlannedOrderStatus; readonly firm: boolean; readonly protectedFields: readonly string[] }): boolean => row.status === 'PLANNED' && row.firm

/** The demand of a stored row, as written (anything else in the list is skipped). */
export function demandOf(value: unknown): PeggedDemand[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = entry as Partial<PeggedDemand> | null
    if (!(row && typeof row.orderId === 'string' && typeof row.orderLineId === 'string' && typeof row.size === 'string' && typeof row.pieces === 'number')) return []
    // B-W2b-306 (PLN-083): the day it is needed, when the run wrote it.
    return [{ orderId: row.orderId, orderLineId: row.orderLineId, size: row.size, pieces: row.pieces, ...(typeof row.needDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.needDate) ? { needDate: row.needDate } : {}) }]
  })
}

/** B-W2b-306 (PLN-083): the day a stored row's demand is needed (its earliest), else its due date: the day of its key. */
export function needDateOf(demand: readonly PeggedDemand[], dueDate: BusinessDate): BusinessDate {
  const days = demand.flatMap((entry) => (entry.needDate ? [entry.needDate] : [])).sort()
  return days[0] ?? dueDate
}

/** The size run of a stored row. */
export function sizesOf(value: unknown): SizeQuantity[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = entry as Partial<SizeQuantity> | null
    return row && typeof row.size === 'string' && typeof row.quantity === 'number' ? [{ size: row.size, quantity: row.quantity }] : []
  })
}

/** The order lines a work order made from a planned order takes, each with its sizes (in the demand's order). */
export function workOrderLinesOf(demand: readonly PeggedDemand[]): { salesOrderLineId: string; sizes: { size: string; quantity: number }[] }[] {
  const lines = new Map<string, { size: string; quantity: number }[]>()
  for (const entry of demand) {
    const sizes = lines.get(entry.orderLineId) ?? []
    const same = sizes.find((row) => row.size === entry.size)
    if (same) same.quantity += entry.pieces
    else sizes.push({ size: entry.size, quantity: entry.pieces })
    lines.set(entry.orderLineId, sizes)
  }
  return [...lines.entries()].map(([salesOrderLineId, sizes]) => ({ salesOrderLineId, sizes }))
}

/** Why a planned order cannot be made real now (null: it can), in words. */
export function convertProblem(row: { readonly status: PlannedOrderStatus; readonly demand: readonly PeggedDemand[]; readonly workOrderNumber?: string | null }): string | null {
  if (row.status === 'CONVERTED') return `It was made real already${row.workOrderNumber ? ` (work order ${row.workOrderNumber})` : ''}.`
  if (row.demand.length === 0) return 'It pegs no order line (stock): a work order is made from order lines.'
  return null
}

/** Why a planned order cannot be made firm or planned again now (null: it can), in words. */
export function firmProblem(row: { readonly status: PlannedOrderStatus; readonly firm: boolean }, firm: boolean): string | null {
  if (row.status === 'CONVERTED') return 'It was made real already: its work order says the rest.'
  if (row.firm === firm) return firm ? 'It is firm already.' : 'It is not firm.'
  return null
}

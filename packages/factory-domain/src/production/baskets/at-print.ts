import type { WorkOrderKind, WorkOrderStatus } from '../work-orders/machine'

/**
 * The baskets "Print and start the work" makes (owb- order workflow, plan.md § 5 G; PL-schema § 1; PL-review § 4 guards 1-6;
 * base settles 2 + data pick "basket = Bundle"). A basket is a Bundle; at print it is made BEFORE cutting, behind the site's
 * switch `ProductionSettings.basketsAtPrint` (default off: a site without it keeps today's bundles made at cutting). Pure: S3's
 * print command reads the facts inside its transaction (after today's release), calls this, takes codes from the BUNDLE
 * allocator, and writes each Bundle with `cutLogIds = []`, `part = null`, `madeAtPrint = true` — the OrderPrint row first.
 *
 *   one garment, one basket   per cell (WorkOrderSize) `quantity` baskets of ONE garment each: one suit = one basket
 *   small parts               a small-parts line (gloves, parts) makes ONE basket per cell holding all of the cell's pieces
 *                             (a basket never spans two cells: Bundle.workOrderSizeId)
 *   made-to-measure           always one garment a basket (the bundle guard: 1 for a made-to-measure unit)
 *
 * Refusals, as codes (S3 says them in words):
 *   SWITCH_OFF     the site does not make baskets at print (its cutting makes them, as today)
 *   NOT_RELEASED   a work order is not RELEASED or IN_PROGRESS (the bundle guard needs one of them): run the release first
 *   ALREADY_MADE   a cell already has ACTIVE bundles (made at an earlier print, or at cutting): "Print again" reprints them
 *   TOO_MANY       more than MAX_BASKETS_AT_PRINT baskets in one print — its own limit, NOT the cutting bench's
 *                  MAX_BUNDLES_PER_MAKE (100): a 114-piece order makes 114 baskets
 */

/** The most baskets one "Print and start the work" makes (the cutting bench's 100 is for a bench's request, not a print). */
export const MAX_BASKETS_AT_PRINT = 2000

/** The work order states a basket may be made in (the bundle guard's). */
export const BASKET_WORK_ORDER_STATUSES = ['RELEASED', 'IN_PROGRESS'] as const satisfies readonly WorkOrderStatus[]

/**
 * The product types whose lines are small parts: one basket per cell, not per piece. S4 adds its new small-parts type
 * (MOLDED_PART, its "routes" wave) here.
 */
export const SMALL_PARTS_PRODUCT_TYPES: readonly string[] = Object.freeze(['GLOVES'])
export const isSmallPartsType = (productType: string | null | undefined): boolean => productType !== null && productType !== undefined && SMALL_PARTS_PRODUCT_TYPES.includes(productType)

export const BASKETS_AT_PRINT_REFUSALS = ['SWITCH_OFF', 'NOT_RELEASED', 'ALREADY_MADE', 'TOO_MANY'] as const
export type BasketsAtPrintRefusalCode = (typeof BASKETS_AT_PRINT_REFUSALS)[number]

/** A cell of a work order, as the print reads it. */
export interface PrintCellFacts {
  readonly workOrderSizeId: string
  /** The garments (or pieces) the work order makes in the cell (WorkOrderSize.quantity). */
  readonly quantity: number
  /** Its ACTIVE bundles now (any part); above 0 refuses ALREADY_MADE. */
  readonly activeBundles: number
}

/** A work order of the order, after today's release. */
export interface PrintWorkOrderFacts {
  readonly workOrderId: string
  readonly status: WorkOrderStatus
  readonly kind: WorkOrderKind
  /** Its line is small parts (isSmallPartsType of the style's product type). */
  readonly smallParts: boolean
  readonly cells: readonly PrintCellFacts[]
}

export interface BasketsAtPrintFacts {
  /** ProductionSettings.basketsAtPrint of the site that makes the order. */
  readonly switchOn: boolean
  readonly workOrders: readonly PrintWorkOrderFacts[]
}

/** One basket to make: its work order, its cell, how many garments (pieces) it carries. */
export interface BasketToMake {
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly quantity: number
}

export interface BasketsAtPrintRefusal {
  readonly code: BasketsAtPrintRefusalCode
  readonly workOrderId: string | null
  readonly workOrderSizeId: string | null
  /** TOO_MANY: the baskets the print would make, and the limit. */
  readonly count: number | null
  readonly limit: number | null
}

export type BasketsAtPrintAnswer = { readonly ok: true; readonly baskets: readonly BasketToMake[] } | { readonly ok: false; readonly refusal: BasketsAtPrintRefusal }

const refused = (code: BasketsAtPrintRefusalCode, at: { workOrderId?: string; workOrderSizeId?: string; count?: number; limit?: number } = {}): BasketsAtPrintAnswer => ({
  ok: false,
  refusal: { code, workOrderId: at.workOrderId ?? null, workOrderSizeId: at.workOrderSizeId ?? null, count: at.count ?? null, limit: at.limit ?? null },
})

/** The baskets one print makes, in work order and cell order, or the first refusal. */
export function basketsAtPrint(facts: BasketsAtPrintFacts): BasketsAtPrintAnswer {
  if (!facts.switchOn) return refused('SWITCH_OFF')
  for (const workOrder of facts.workOrders) {
    if (!(BASKET_WORK_ORDER_STATUSES as readonly string[]).includes(workOrder.status)) return refused('NOT_RELEASED', { workOrderId: workOrder.workOrderId })
    const made = workOrder.cells.find((cell) => cell.activeBundles > 0)
    if (made) return refused('ALREADY_MADE', { workOrderId: workOrder.workOrderId, workOrderSizeId: made.workOrderSizeId })
  }
  const count = facts.workOrders.reduce((sum, workOrder) => sum + workOrder.cells.reduce((cells, cell) => cells + basketsOfCell(workOrder, cell), 0), 0)
  if (count > MAX_BASKETS_AT_PRINT) return refused('TOO_MANY', { count, limit: MAX_BASKETS_AT_PRINT })
  const baskets: BasketToMake[] = []
  for (const workOrder of facts.workOrders) {
    for (const cell of workOrder.cells) {
      if (cell.quantity < 1) continue
      if (onePerCell(workOrder)) baskets.push({ workOrderId: workOrder.workOrderId, workOrderSizeId: cell.workOrderSizeId, quantity: cell.quantity })
      else for (let piece = 0; piece < cell.quantity; piece++) baskets.push({ workOrderId: workOrder.workOrderId, workOrderSizeId: cell.workOrderSizeId, quantity: 1 })
    }
  }
  return { ok: true, baskets }
}

/** A small-parts line makes one basket a cell — never a made-to-measure one (one garment a basket, always). */
const onePerCell = (workOrder: PrintWorkOrderFacts): boolean => workOrder.smallParts && workOrder.kind !== 'MADE_TO_MEASURE'

function basketsOfCell(workOrder: PrintWorkOrderFacts, cell: PrintCellFacts): number {
  if (cell.quantity < 1) return 0
  return onePerCell(workOrder) ? 1 : cell.quantity
}

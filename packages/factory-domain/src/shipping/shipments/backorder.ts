/**
 * Partial shipments and the backorder (B-W2a-48; LOG-004; SCOPE W2a rule 1: once several orders run, part of an order
 * leaves and the rest waits). Pure rules; apps/factory-api's modules/shipping/shipments reads the facts and holds them in
 * its commands. A shipment already takes part of an order (W1: any released garments of the order); this file says what
 * of each order line and size is left behind, and stops a shipment from taking more than the order still wants.
 *
 *   ordered      the size's pieces on the order line (a made-to-measure unit: 1 of its size)
 *   closed       the pieces the office closed short (SAL-210, B-W2a-30): once a line is closed, each size's quantity
 *                less what shipped of it will never ship
 *   shipped      on shipments that left (SHIPPED, DELIVERED)
 *   open         on shipments that have not left yet (DRAFT, PACKED), this one included unless it is named apart
 *   backorder    ordered − closed − shipped − open (never below 0): still to ship, made or not
 *   readyNow     of the backorder, garments quality released and on no shipment yet (released less reversals less every
 *                shipment that is not CANCELLED): they could go on the next shipment today
 *
 * A line closed short takes no more garments on a shipment (the database does not refuse it: this rule does, B-W2a-30
 * named it), and a shipment that holds garments of a line closed after they were packed does not leave.
 */

/** One size of an order line, as the backorder reads it. */
export interface SizeFacts {
  readonly size: string
  readonly ordered: number
  /** The order line was closed short (its four columns set). */
  readonly closedShort: boolean
  /** On shipments that left (SHIPPED, DELIVERED). */
  readonly shipped: number
  /** On DRAFT and PACKED shipments other than the one named apart. */
  readonly open: number
  /** On the shipment named apart (0 when none is). */
  readonly thisShipment: number
  /** Released less reversals over the line's cells of the size (repair work orders aside). */
  readonly netReleased: number
  /** On every shipment that is not CANCELLED (RETURNED ones too): what the released garments are held by. */
  readonly onShipments: number
}

export interface SizeBackorder extends SizeFacts {
  readonly closed: number
  readonly backorder: number
  readonly readyNow: number
  /** Still to make: the backorder less what is ready now. */
  readonly inProduction: number
}

const max0 = (value: number): number => (value > 0 ? value : 0)

export function sizeBackorder(facts: SizeFacts): SizeBackorder {
  const closed = facts.closedShort ? max0(facts.ordered - facts.shipped) : 0
  const backorder = max0(facts.ordered - closed - facts.shipped - facts.open - facts.thisShipment)
  const readyNow = Math.min(backorder, max0(facts.netReleased - facts.onShipments))
  return { ...facts, closed, backorder, readyNow, inProduction: backorder - readyNow }
}

/** An order's backorder in total (the sizes of every line). */
export function backorderTotals(sizes: readonly SizeBackorder[]): { ordered: number; closed: number; shipped: number; open: number; thisShipment: number; backorder: number; readyNow: number; inProduction: number } {
  const total = (pick: (size: SizeBackorder) => number) => sizes.reduce((sum, size) => sum + pick(size), 0)
  return {
    ordered: total((size) => size.ordered),
    closed: total((size) => size.closed),
    shipped: total((size) => size.shipped),
    open: total((size) => size.open),
    thisShipment: total((size) => size.thisShipment),
    backorder: total((size) => size.backorder),
    readyNow: total((size) => size.readyNow),
    inProduction: total((size) => size.inProduction),
  }
}

/**
 * The words for an order whose shipment leaves only part of it (the screen's "backorder" line): what stays behind.
 * Empty when nothing does.
 */
export function backorderWords(totals: { readonly backorder: number; readonly readyNow: number; readonly inProduction: number }): string | null {
  if (totals.backorder === 0) return null
  const parts = [`${totals.backorder} garment${totals.backorder === 1 ? '' : 's'} of the order stay${totals.backorder === 1 ? 's' : ''} on backorder`]
  if (totals.readyNow > 0) parts.push(`${totals.readyNow} released and ready for the next shipment`)
  if (totals.inProduction > 0) parts.push(`${totals.inProduction} still to be made or released`)
  return `${parts.join('; ')}.`
}

// ---- what a shipment may still take of an order line (LOG-004 with SAL-210) ---------------------------------------

/** One order line and size a request adds garments of. */
export interface OrderCapFacts {
  /** "Order line 10 SEED-JKT-02 BLK, size 52". */
  readonly label: string
  readonly ordered: number
  readonly closedShort: boolean
  /** The line's short-close reason (when closed). */
  readonly closeShortReason?: string | null
  /** On shipments that are not CANCELLED or RETURNED (DRAFT, PACKED, SHIPPED, DELIVERED). */
  readonly onShipments: number
}

/**
 * Why `more` garments of an order line's size cannot go on a shipment (empty: they can): a line closed short takes none
 * (its remaining pieces will not ship: reopen it first), and no size ships more than the order line ordered of it.
 */
export function orderCapProblems(facts: OrderCapFacts, more: number): string[] {
  if (more <= 0) return []
  if (facts.closedShort) {
    const why = facts.closeShortReason?.trim() ? ` (${facts.closeShortReason.trim()})` : ''
    return [`${facts.label} was closed short${why}: what is left of it will not ship. Reopen the line on the order first.`]
  }
  const left = max0(facts.ordered - facts.onShipments)
  if (more <= left) return []
  return [`${facts.label}: ${facts.ordered} ordered and ${facts.onShipments} on shipments already, so ${left} more can ship; ${more} asked.`]
}

/**
 * Why a PACKED shipment cannot leave (empty: it can): it holds garments of an order line closed short after they were
 * planned (closing counted them as not shipping). Take them off (unpack, then change the lines) or reopen the line.
 */
export function closedShortAtShipProblems(lines: readonly { readonly label: string; readonly closedShort: boolean; readonly garments: number }[]): string[] {
  const closed = lines.filter((line) => line.closedShort && line.garments > 0)
  if (closed.length === 0) return []
  return [`${closed.map((line) => `${line.label} (${line.garments} garment${line.garments === 1 ? '' : 's'})`).join(', ')}: the order line was closed short after these were planned, so they do not leave. Unpack and take them off the shipment, or reopen the line on the order.`]
}

/**
 * W2b (B-W2b-19; the B-W2a-12 note): a repair work order's garment goes back to its customer with the repair's DDT
 * (B-W2a-17), never on a shipment of the order. Adding its cell is refused (B-W2a-48); a line of one that is already on
 * a shipment (made before the rule) neither grows nor leaves.
 */
export const repairCellWords = (workOrderNumber: string): string =>
  `${workOrderNumber} is a repair work order: its garment goes back with the repair's DDT, never on a shipment of the order.`

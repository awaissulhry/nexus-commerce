import type { SalesOrderStatus } from '../../sales/orders/orders'
import { Dec, HUNDRED } from '../../tax/decimal'

/**
 * Orders below the margin floor (B-W2b-416; FIN-050 low-margin alert; design finance.margins "Orders below the floor (W2b)",
 * the orders grid's "floor flag (W2b)"; follow-up KA3:01: the margins' belowFloor reads the margin floors of Sales
 * settings), pure.
 *
 * An order is held to the margin floor of the person it was sold by, read now from the Sales settings (B-W2b-330's floors
 * by role, sales/price-waterfall/rules floorFor): the maker of its accepted quote version (an order typed by the office:
 * the order's maker), their live office roles over the order's company and customer, the lowest floor those roles have,
 * else the company's floor. The same floor the quote was held to while nothing in the settings changed.
 *
 * The order is judged on its margin as it stands: the FINAL margin once every work order is done and every piece is made
 * (its actual is its final cost), else the margin as ESTIMATED now (the actual so far reads high until the work is done:
 * it is never the basis). Below = margin × 100 < floor × value, the quote's own rule (sales/quotes underFloor), so an order
 * and its quote never disagree at the boundary. No cost known: not judged (null, never "fine"). Nothing here names a person.
 */

/** What an order's flag is judged on. */
export const FLOOR_BASES = ['ESTIMATE', 'FINAL'] as const
export type FloorBasis = (typeof FLOOR_BASES)[number]

/** Where the floor comes from: a role's floor in the Sales settings, or the company's floor. */
export const FLOOR_SOURCES = ['ROLE', 'COMPANY'] as const
export type FloorSource = (typeof FLOOR_SOURCES)[number]

/**
 * The orders the low-margin alert watches: confirmed, being made or on their way (their margin can still move or has
 * just been fixed). Not an order waiting for its yes (the approval is about its margin), a closed or a cancelled one.
 */
export const WATCHED_STATUSES: readonly SalesOrderStatus[] = Object.freeze(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED'])

/** The figures of an order the flag reads (minor units of the order's currency; null: not known). */
export interface FloorFigures {
  /** Every work order done and every piece made: the actual is the final cost. */
  readonly final: boolean
  /** The value now (pieces closed short taken off). */
  readonly value: number
  /** The margin as estimated now (null: a cost cannot be told). */
  readonly estimateMargin: number | null
  /** The margin so far (null: nothing posted, or costs in another currency). */
  readonly actualMargin: number | null
}

/** margin × 100 < floor × value (the quote's rule; a value of 0 is below only at a loss). */
export function underFloor(margin: number, value: number, floorPct: string): boolean {
  if (value === 0) return margin < 0
  return new Dec(margin).times(HUNDRED).lt(new Dec(floorPct).times(value))
}

export interface FloorFlag {
  /** null: the margin it would be judged on is not known. */
  readonly below: boolean | null
  /** What it is judged on (null when not known). */
  readonly basis: FloorBasis | null
}

/** The flag of an order against its floor: the final margin once final, else the estimate now. */
export function floorFlagOf(figures: FloorFigures, floorPct: string | null): FloorFlag {
  if (floorPct === null) return { below: null, basis: null }
  const basis: FloorBasis = figures.final ? 'FINAL' : 'ESTIMATE'
  const margin = figures.final ? figures.actualMargin : figures.estimateMargin
  if (margin === null) return { below: null, basis: null }
  return { below: underFloor(margin, figures.value, floorPct), basis }
}

/** Whether the alert watches an order of this status. */
export const watched = (status: string): boolean => (WATCHED_STATUSES as readonly string[]).includes(status)

/** The facts of a low-margin alert: what it is judged on and whether the quote was already under its floor. No figure. */
export interface FloorAlertFacts {
  readonly basis: FloorBasis
  /** The accepted version was priced under its floor (a yes let it through). */
  readonly quotedBelow: boolean
  readonly status: string
}

/** The orders below the floor among the flags (the tile "Orders below the floor"). */
export const belowCount = (flags: readonly FloorFlag[]): number => flags.filter((flag) => flag.below === true).length

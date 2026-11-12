import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from '../ledger/moves'
import type { TreeLocation } from '../locations/rules'

/**
 * Pick lists by bin (B-W2b-298; SCM-212; design warehouse.picking pop:pk-list "lines sorted by bin path", tab "Pick list PDF
 * (sorted by bin path)", floor.pick sec:need "W2b pick list (SCM-212): sorted by bin path, reservations, scan each pick"),
 * pure: the walk the picker makes through the site's store.
 *
 *   the bin path     a place's codes from the top of the site's tree down to it ("A1-STORE / A1-STORE-01 / A1-STORE-01-B");
 *                    the walk visits the tree depth first, the places inside one place in the natural order of their codes
 *                    (digits as numbers: A-2 before A-10), so the picker passes each shelf once, top to bottom
 *   a stop           what to take at one place: a reserved lot or hide (the work order's pick list), what a pick list would
 *                    reserve now (the stock oldest first), or an approved substitute's lot; with its quantity in the
 *                    material's base unit and the lot's quality status
 *   several orders   the stops of many work orders merged into one walk (rule 1: the cutter and the kit maker pick for the
 *                    shift's work orders in one round), each stop still naming its work order
 *
 * No figure here is money; no stop names a person.
 */

/** What a stop is. */
export const STOP_SOURCES = ['RESERVED', 'PROPOSED', 'SUBSTITUTE'] as const
export type StopSource = (typeof STOP_SOURCES)[number]

/** At most this many work orders are walked at once (the office's sheet takes 20 too). */
export const MAX_WALK_ORDERS = 20

/** A place of the site as the walk reads it. */
export interface BinPlace extends TreeLocation {
  readonly name: string
  readonly kind: string
  readonly labelCode: string | null
  /** Blocked now (a count, damage …): nothing is taken from it until it is unblocked. */
  readonly blocked: boolean
}

/** A place in the walk: its path of codes from the top and its turn (0 = first). */
export interface PlacedBin extends BinPlace {
  readonly path: readonly string[]
  readonly rank: number
}

const DIGITS = /(\d+)/

/** Two codes in natural order: runs of digits compared as numbers, the rest as text (then as plain text). */
export function compareBinCodes(a: string, b: string): number {
  const left = a.split(DIGITS)
  const right = b.split(DIGITS)
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index]!
    const y = right[index]!
    if (x === y) continue
    const numeric = index % 2 === 1
    if (numeric) {
      const difference = Number.parseInt(x, 10) - Number.parseInt(y, 10)
      if (difference !== 0) return difference < 0 ? -1 : 1
      // Same number written differently ("02" and "2"): the shorter first.
      if (x.length !== y.length) return x.length < y.length ? -1 : 1
      continue
    }
    return x < y ? -1 : 1
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * The site's places in walking order (depth first from the top, the places inside one place by their codes in natural
 * order), each with its path and rank. A place whose parent is not listed sits at the top; a loop is cut where it closes.
 */
export function binWalkOrder(places: readonly BinPlace[]): Map<string, PlacedBin> {
  const ids = new Set(places.map((place) => place.id))
  const children = new Map<string | null, BinPlace[]>()
  for (const place of places) {
    const parent = place.parentId !== null && ids.has(place.parentId) ? place.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), place])
  }
  for (const list of children.values()) list.sort((a, b) => compareBinCodes(a.code, b.code) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const placed = new Map<string, PlacedBin>()
  const visit = (parent: string | null, path: readonly string[]) => {
    for (const place of children.get(parent) ?? []) {
      if (placed.has(place.id)) continue
      const own = [...path, place.code]
      placed.set(place.id, { ...place, path: own, rank: placed.size })
      if (own.length < 64) visit(place.id, own)
    }
  }
  visit(null, [])
  // Places only a loop reaches (never in a well-formed tree): after the rest, by code.
  for (const place of [...places].sort((a, b) => compareBinCodes(a.code, b.code))) {
    if (!placed.has(place.id)) placed.set(place.id, { ...place, path: [place.code], rank: placed.size })
  }
  return placed
}

/** Where some stock lies: a place and how much is there (base unit, above 0). */
export interface Lying {
  readonly locationId: string
  readonly onHand: DecimalInput
}

/**
 * How `open` is taken from the places it lies in, in walking order: from each place what is there until it is covered (a
 * hide, `whole`, is taken whole from wherever it lies). A place the walk does not know comes last. What no place covers is
 * left out (the line says it is short).
 */
export function takeInWalkOrder(open: DecimalInput, lying: readonly Lying[], order: ReadonlyMap<string, Pick<PlacedBin, 'rank'>>, whole = false): { locationId: string; quantity: string }[] {
  const sorted = [...lying].filter((place) => new Dec(place.onHand).gt(0)).sort((a, b) => rankOf(order, a.locationId) - rankOf(order, b.locationId) || (a.locationId < b.locationId ? -1 : 1))
  if (whole) return sorted.map((place) => ({ locationId: place.locationId, quantity: quantityText(place.onHand) }))
  let left: Decimal = new Dec(open)
  const takes: { locationId: string; quantity: string }[] = []
  for (const place of sorted) {
    if (left.lte(ZERO)) break
    const take = Dec.min(left, new Dec(place.onHand))
    takes.push({ locationId: place.locationId, quantity: quantityText(take) })
    left = left.minus(take)
  }
  return takes
}

const rankOf = (order: ReadonlyMap<string, Pick<PlacedBin, 'rank'>>, locationId: string): number => order.get(locationId)?.rank ?? Number.MAX_SAFE_INTEGER

/** What sorts a stop in the walk beside its place. */
export interface WalkSortable {
  readonly locationId: string
  readonly workOrderNumber: string
  readonly itemCode: string
  readonly colourCode: string | null
  readonly lotCode: string | null
  readonly hideCode: string | null
  readonly source: StopSource
}

const SOURCE_ORDER: Readonly<Record<StopSource, number>> = Object.freeze({ RESERVED: 0, SUBSTITUTE: 1, PROPOSED: 2 })
const text = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : compareBinCodes(a, b))

/** The stops in walking order: by place, then work order, material, colour, lot and hide; what is reserved before a proposal. */
export function walkOrder<Stop extends WalkSortable>(stops: readonly Stop[], order: ReadonlyMap<string, Pick<PlacedBin, 'rank'>>): Stop[] {
  return [...stops].sort(
    (a, b) =>
      rankOf(order, a.locationId) - rankOf(order, b.locationId) ||
      compareBinCodes(a.workOrderNumber, b.workOrderNumber) ||
      compareBinCodes(a.itemCode, b.itemCode) ||
      text(a.colourCode, b.colourCode) ||
      text(a.lotCode, b.lotCode) ||
      text(a.hideCode, b.hideCode) ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source],
  )
}

/** The places a walk passes, in order, with how many stops each has (the paper's headings; the tablet's "3 places"). */
export function placesOf<Stop extends { readonly locationId: string }>(stops: readonly Stop[]): { locationId: string; stops: number }[] {
  const seen = new Map<string, number>()
  for (const stop of stops) seen.set(stop.locationId, (seen.get(stop.locationId) ?? 0) + 1)
  return [...seen.entries()].map(([locationId, count]) => ({ locationId, stops: count }))
}

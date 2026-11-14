import { Decimal } from 'decimal.js'
import { fromMinorUnits, toMinorUnits, type CurrencyCode } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { marginPctOf } from '../sheet-versions/rules'

/**
 * The mass cost update (B-W2b-423; FIN-022; design finance.costing › "Mass cost update": the new material price, the cost
 * sheets affected, the effect on margins of open orders and price lists, "Approve update"), pure.
 *
 *   the change        one or more materials, each with its new standard purchase price per base unit (in the material's
 *                     own currency)
 *   affected sheets   per cost sheet series (a style, a company, a season) whose revision takes a changed material at any
 *                     level of its BOM (the roll-up, FIN-019): its newest version that is not frozen; its cost at today's
 *                     prices and with the new ones (B-W2b-418's components, nothing else changed), per size and weighted
 *   open price lists  each active entry of an affected style: its price against the cost before and after (margin)
 *   open orders       each line of an affected style on an order not yet shipped, closed or cancelled: its net against its
 *                     cost and that cost moved by the change for its pieces (margin) — the order's own cost is not changed
 *
 * Shown before a person applies it: the preview is a read, and the apply names the preview it was shown (its hash: the
 * changes, every version and material it read and every figure); anything that moved since is refused (STALE) and shown
 * again. Applying writes each material's new price and a NEW DRAFT version of each affected series from its components
 * (its typed lines kept); it never changes an approved or frozen version, and never a posted cost (the ledger, frozen
 * standards and the documents keep theirs). Applying is a step-up action (a fresh code), the company's money settings line.
 */

export const MASS_LIMITS = Object.freeze({ changes: 50, series: 100, documents: 500 })

export const MASS_REFUSALS = ['STALE', 'TOO_MANY', 'NOTHING_AFFECTED', 'NOTHING_CHANGES', 'NOT_RECOMPUTED', 'NO_RIGHT'] as const
export type MassRefusal = (typeof MASS_REFUSALS)[number]

export const MASS_REFUSAL_WORDS: Readonly<Record<MassRefusal, string>> = Object.freeze({
  STALE: 'Something changed since the preview (a price, a cost sheet version, a rate or a document): look at the update again before you apply it.',
  TOO_MANY: `The update touches more than ${MASS_LIMITS.series} cost sheet series: narrow it to fewer materials.`,
  NOTHING_AFFECTED: 'No cost sheet takes these materials: change their price on the material instead.',
  NOTHING_CHANGES: 'Every new price is the price the material has now: nothing to update.',
  NOT_RECOMPUTED: 'Some affected cost sheets miss an input and cannot be recomputed: complete them, or apply leaving their missing inputs out.',
  NO_RIGHT: 'Applying needs the right to keep the cost sheets and the materials’ standard prices of every company it touches.',
})

/** Where an affected series stands (a closed season takes no new version). */
export const SERIES_STATES = ['RECOMPUTED', 'INCOMPLETE', 'SEASON_CLOSED'] as const
export type SeriesState = (typeof SERIES_STATES)[number]

export const SERIES_WORDS: Readonly<Record<SeriesState, string>> = Object.freeze({
  RECOMPUTED: 'Recomputed: applying makes a new draft version of it from its components.',
  INCOMPLETE: 'An input is missing: applying makes its new draft only when missing inputs may be left out.',
  SEASON_CLOSED: 'Its season is closed: no new version is made (its versions stay as they are).',
})

export interface MassChange {
  readonly itemId: string
  readonly newPrice: string
}

/** The changes as sent: 1 to MASS_LIMITS.changes materials, each once, a price of 0 or more with at most 6 decimals. */
export function changesProblems(changes: readonly MassChange[]): { readonly path: string; readonly message: string }[] {
  const issues: { path: string; message: string }[] = []
  if (changes.length < 1 || changes.length > MASS_LIMITS.changes) issues.push({ path: 'changes', message: `Change 1 to ${MASS_LIMITS.changes} materials at a time.` })
  const seen = new Set<string>()
  changes.forEach((change, index) => {
    if (seen.has(change.itemId)) issues.push({ path: `changes/${index}/itemId`, message: 'Each material once.' })
    seen.add(change.itemId)
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(change.newPrice)) issues.push({ path: `changes/${index}/newPrice`, message: 'A price of 0 or more per base unit, with at most 12 digits and 6 decimals.' })
  })
  return issues
}

/** The percent a price moves, 2 places; null from 0. */
export function priceChangePct(before: string | null, after: string): string | null {
  if (before === null) return null
  const b = new Decimal(before)
  if (b.isZero()) return null
  return decimalText(new Decimal(after).minus(b).dividedBy(b).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
}

/** A price list entry's margin before and after a cost moved (the entry's price against the cost; 2 places). */
export function entryEffect(price: string, costBefore: string | null, delta: string | null) {
  const after = costBefore === null || delta === null ? null : decimalText(new Decimal(costBefore).plus(delta).toDecimalPlaces(6, Decimal.ROUND_HALF_UP))
  const marginBefore = marginPctOf(price, costBefore)
  const marginAfter = marginPctOf(price, after)
  return { costBefore, costAfter: after, marginBefore, marginAfter, marginMove: marginBefore === null || marginAfter === null ? null : decimalText(new Decimal(marginAfter).minus(marginBefore)) }
}

/**
 * An order line's effect: its net and cost (minor units of its currency) and the cost each of its pieces moves by (by size;
 * a size without a figure makes the whole effect unknown). Margin = (net − cost) ÷ net, 2 places.
 */
export function orderLineEffect(input: { readonly currency: CurrencyCode; readonly net: number; readonly cost: number | null; readonly pieces: readonly { readonly size: string; readonly quantity: number }[]; readonly delta: ReadonlyMap<string, string | null> }) {
  let move = new Decimal(0)
  let known = input.cost !== null
  for (const piece of input.pieces) {
    const delta = input.delta.get(piece.size) ?? null
    if (delta === null) {
      known = false
      break
    }
    move = move.plus(new Decimal(delta).times(piece.quantity))
  }
  const costMove = known ? toMinorUnits(move, input.currency) : null
  const costAfter = known && input.cost !== null && costMove !== null ? input.cost + costMove : null
  const asText = (minor: number | null) => (minor === null ? null : decimalText(fromMinorUnits(minor, input.currency)))
  const marginBefore = marginPctOf(asText(input.net), asText(input.cost))
  const marginAfter = marginPctOf(asText(input.net), asText(costAfter))
  return { costMove, costAfter, marginBefore, marginAfter, marginMove: marginBefore === null || marginAfter === null ? null : decimalText(new Decimal(marginAfter).minus(marginBefore)) }
}

/** A value as one stable JSON text (keys sorted), for the preview's hash. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

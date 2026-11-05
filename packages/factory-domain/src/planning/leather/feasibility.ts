import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import type { ShadeRule } from '../../inventory/reservations/shade'

/**
 * Can this order be cut from one shade? (B-W2b-132; PLN-108; design planning.leather "Leather need per order", pop-up "Can
 * this order be cut from one shade?"), pure. Planning asks it BEFORE a promise; the pick refuses another shade lot
 * (B-W2b-100) and the cutting table warns (B-W2b-103). The API gives what the order line still has to find (its need less
 * what is issued and what its work orders or the line hold reserved), its sizes (the area each still takes), the shade lots
 * of the article and colour available at the site (free hides only, in the order factory-domain inventory/reservations/find
 * puts them: the order's own lot first) and the lots the order already holds. The answer is one of:
 *
 *   COVERED       nothing left to find, from one shade lot (or none needed);
 *   FITS          one lot covers what is left (the order's own lot when it holds one);
 *   SPLIT         no lot covers it alone, but whole sizes can each come from one lot (sizes in scale order, the order's
 *                 own lot first, then the largest): every garment stays one shade — the order does not (an order that holds
 *                 a lot with no hides left, whose sizes left all fit one other lot, is a split as well);
 *   MUST_BUY      even split by garment the free stock does not cover it: buy the area that completes the best lot (in its
 *                 shade), the order's own lot when it holds one;
 *   ASK_CUSTOMER  the order already holds hides of more than one shade lot: only the customer can accept the mix.
 *
 * The options the drawer offers follow: reserve from the best lot (FITS), the split (when one exists), buy the area that
 * completes the best lot, ask the customer — each with its effect. Under the shade rule OFF one shade is not asked: FITS
 * when the free stock covers the need, else MUST_BUY. Areas are the base unit's, four places.
 */

export const FEASIBILITY = ['COVERED', 'FITS', 'SPLIT', 'MUST_BUY', 'ASK_CUSTOMER'] as const
export type Feasibility = (typeof FEASIBILITY)[number]

export interface FeasibilityLot {
  readonly key: string
  readonly lotId: string
  readonly lotCode: string
  readonly shadeLabel: string | null
  /** The free area of the lot's hides at the site. */
  readonly total: DecimalInput
  readonly count: number
  /** The order holds (issued or reserved) hides of this shade lot. */
  readonly ordersOwn: boolean
}

export interface FeasibilityInput {
  readonly rule: ShadeRule
  /** What is left to find (need − issued − reserved), never below zero. */
  readonly toFind: DecimalInput
  /** What the order's reservations still hold (they belong to its own lot). */
  readonly reserved: DecimalInput
  /** The area each size still takes (need − issued), in scale order. */
  readonly sizes: readonly { readonly size: string; readonly area: DecimalInput }[]
  /** Free lots, the order's own first (find's order), out-of-shade hides left out. */
  readonly lots: readonly FeasibilityLot[]
  /** The shade lots the order already holds. */
  readonly held: number
}

export interface SplitPart {
  readonly lotKey: string
  readonly lotCode: string
  readonly shadeLabel: string | null
  readonly sizes: readonly string[]
  readonly area: string
}

export interface FeasibilityAnswer {
  readonly status: Feasibility
  /** The lot the order is best cut from (FITS: the one that covers; else the own lot, else the largest). */
  readonly best: FeasibilityLot | null
  /** Whole sizes per lot (SPLIT, and offered as an option when it exists). */
  readonly split: readonly SplitPart[] | null
  /** The area to buy so the best lot covers the order (null when nothing needs buying), and in whose shade. */
  readonly buy: { readonly area: string; readonly lotCode: string | null; readonly shadeLabel: string | null } | null
}

const dec = (value: DecimalInput): Decimal => new Dec(value.toString())
const area = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** Whole sizes per lot, the own lot first (with what the order holds reserved), then the largest; null when a size fits no lot. */
export function splitByGarment(input: Pick<FeasibilityInput, 'sizes' | 'lots' | 'reserved'>): SplitPart[] | null {
  const own = input.lots.filter((lot) => lot.ordersOwn)
  const others = input.lots.filter((lot) => !lot.ordersOwn).sort((a, b) => dec(b.total).comparedTo(dec(a.total)) || (a.lotCode < b.lotCode ? -1 : 1))
  const lots = [...own, ...others]
  const sizes = input.sizes.filter((size) => dec(size.area).gt(0))
  if (sizes.length === 0 || lots.length === 0) return null
  const parts: SplitPart[] = []
  let index = 0
  let lotIndex = 0
  while (index < sizes.length && lotIndex < lots.length) {
    const lot = lots[lotIndex]!
    let left = dec(lot.total).plus(lot.ordersOwn ? dec(input.reserved) : ZERO)
    const taken: string[] = []
    let used = ZERO
    while (index < sizes.length && dec(sizes[index]!.area).lte(left)) {
      left = left.minus(sizes[index]!.area)
      used = used.plus(sizes[index]!.area)
      taken.push(sizes[index]!.size)
      index += 1
    }
    if (taken.length > 0) parts.push({ lotKey: lot.key, lotCode: lot.lotCode, shadeLabel: lot.shadeLabel, sizes: taken, area: area(used) })
    lotIndex += 1
  }
  return index === sizes.length ? parts : null
}

/** The answer for one order line (rules in the header). */
export function shadeFeasibility(input: FeasibilityInput): FeasibilityAnswer {
  const toFind = Dec.max(ZERO, dec(input.toFind))
  const own = input.lots.find((lot) => lot.ordersOwn) ?? null
  const largest = [...input.lots].sort((a, b) => dec(b.total).comparedTo(dec(a.total)) || (a.lotCode < b.lotCode ? -1 : 1))[0] ?? null
  const covering = input.lots.find((lot) => dec(lot.total).gte(toFind)) ?? null
  // A split is whole sizes over more than one lot; for an order that already holds a lot with no hides left to give, one
  // other lot for every size left is a split too (the garments cut so far keep their lot, the rest take the new one).
  const splitOf = () => {
    const parts = splitByGarment(input)
    if (!parts) return null
    if (parts.length > 1) return parts
    return input.held === 1 && !input.lots.some((lot) => lot.ordersOwn && lot.key === parts[0]!.lotKey) ? parts : null
  }
  if (input.rule === 'OFF') {
    const free = input.lots.reduce((sum, lot) => sum.plus(lot.total), ZERO)
    if (toFind.isZero()) return { status: 'COVERED', best: own, split: null, buy: null }
    if (free.gte(toFind)) return { status: 'FITS', best: covering ?? largest, split: null, buy: null }
    return { status: 'MUST_BUY', best: largest, split: null, buy: { area: area(toFind.minus(free)), lotCode: null, shadeLabel: null } }
  }
  if (input.held > 1) {
    const best = own ?? largest
    const short = best ? Dec.max(ZERO, toFind.minus(best.total)) : toFind
    return { status: 'ASK_CUSTOMER', best, split: toFind.isZero() ? null : splitOf(), buy: short.gt(0) ? { area: area(short), lotCode: best?.lotCode ?? null, shadeLabel: best?.shadeLabel ?? null } : null }
  }
  if (toFind.isZero()) return { status: 'COVERED', best: own, split: null, buy: null }
  // One shade per order: an order that holds a lot is cut from it; another lot alone would mix the order.
  const fitting = input.held === 1 ? (own && dec(own.total).gte(toFind) ? own : null) : covering
  if (fitting) return { status: 'FITS', best: fitting, split: null, buy: null }
  const best = input.held === 1 ? own : largest
  const short = best ? Dec.max(ZERO, toFind.minus(best.total)) : toFind
  const buy = { area: area(short), lotCode: best?.lotCode ?? null, shadeLabel: best?.shadeLabel ?? null }
  const split = splitOf()
  if (split) return { status: 'SPLIT', best, split, buy }
  return { status: 'MUST_BUY', best, split: null, buy }
}

/** "46–50" for consecutive sizes of the scale, else "46, 50, 54". */
export function sizesText(sizes: readonly string[], scale: readonly string[]): string {
  if (sizes.length === 0) return ''
  if (sizes.length === 1) return sizes[0]!
  const at = sizes.map((size) => scale.indexOf(size))
  const consecutive = at.every((place, index) => place >= 0 && (index === 0 || place === at[index - 1]! + 1))
  return consecutive ? `${sizes[0]}–${sizes[sizes.length - 1]}` : sizes.join(', ')
}

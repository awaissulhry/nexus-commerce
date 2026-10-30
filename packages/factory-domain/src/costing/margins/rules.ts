import { Dec, HUNDRED, ZERO, type Decimal } from '../../tax/decimal'
import { decimalText } from '../../product/units/units'

/**
 * Order margin from estimate to actual (B-W2a-29; FIN-047; design finance.margins "Order margin, quote to actual", its
 * DetailModal "profitability" bridge, sales.orders Margin tab "Margin, quoted → now", "Where the margin went", "By
 * line"), pure. Three figures per order line, each value − cost = margin:
 *
 *   quoted    the line as sold: its net and its cost at quote (SalesOrderLine.costAmount, from the quote's cost sheet),
 *             split into material, labour and overhead in the mix of the quote line's cost snapshot
 *   estimate  as it stands now: the net of the pieces still to deliver (pieces closed short taken off pro rata); the cost
 *             of each work order that makes it (shared by garments), where a work order that is done counts at its
 *             actual cost and an open one at the larger of its plan (its frozen standard, else its estimate at release,
 *             else its garments' quoted cost) and what it has already cost, part by part; the pieces no work order makes
 *             yet at the quoted cost per piece
 *   actual    so far: the same net, and Σ the work orders' cost ledger entries (shared by garments): it grows until every
 *             work order is done, then it is the final cost
 *
 * Amounts are Int minor units of the order's currency, every share rounded once and placed by the largest remainder so
 * the shares add up exactly to what is shared. Margin % has four places, as the order and the quote write it. No person
 * is named: labour is per work order and operation (Statuto dei Lavoratori art. 4).
 */

export const MARGIN_PARTS = ['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT'] as const
export type MarginPart = (typeof MARGIN_PARTS)[number]

/** Where the margin went, quoted → now: the value's change, then each cost part's (a cost up is a margin down). */
export const WATERFALL_REASONS = ['PRICE', ...MARGIN_PARTS] as const
export type WaterfallReason = (typeof WATERFALL_REASONS)[number]

/** Cost parts, minor units. */
export interface Parts {
  readonly material: number
  readonly labour: number
  readonly subcontract: number
  readonly overhead: number
  readonly adjustment: number
}

const KEYS = ['material', 'labour', 'subcontract', 'overhead', 'adjustment'] as const satisfies readonly (keyof Parts)[]
export const NO_PARTS: Parts = Object.freeze({ material: 0, labour: 0, subcontract: 0, overhead: 0, adjustment: 0 })

export const totalOf = (parts: Parts): number => KEYS.reduce((sum, key) => sum + parts[key], 0)
export const addParts = (a: Parts, b: Parts): Parts => ({ material: a.material + b.material, labour: a.labour + b.labour, subcontract: a.subcontract + b.subcontract, overhead: a.overhead + b.overhead, adjustment: a.adjustment + b.adjustment })
export const sumParts = (list: readonly Parts[]): Parts => list.reduce(addParts, NO_PARTS)

/**
 * `amount` shared by `weights` (≥ 0): each share rounded once, the remainder placed by the largest remainders (the first
 * on a tie), so the shares add up to `amount` exactly. No weight: all to the first (or none when there is nothing to
 * share).
 */
export function shareOf(amount: number, weights: readonly (number | Decimal)[]): number[] {
  if (weights.length === 0) return []
  const positive = weights.map((weight) => Dec.max(ZERO, new Dec(weight)))
  const total = positive.reduce((sum, weight) => sum.plus(weight), ZERO)
  if (total.isZero()) return weights.map((_, index) => (index === 0 ? amount : 0))
  const exact = positive.map((weight) => new Dec(amount).times(weight).dividedBy(total))
  const floors = exact.map((value) => value.toDecimalPlaces(0, Dec.ROUND_FLOOR))
  const out = floors.map((value) => Number.parseInt(value.toFixed(0), 10))
  let left = amount - out.reduce((sum, value) => sum + value, 0)
  const order = exact.map((value, index) => ({ index, rest: value.minus(floors[index]!) })).sort((a, b) => b.rest.comparedTo(a.rest) || a.index - b.index)
  for (const { index } of order) {
    if (left <= 0) break
    out[index]! += 1
    left -= 1
  }
  return out.map((value) => (value === 0 ? 0 : value))
}

/** Each part shared by the weights (see shareOf): the shares add up part by part. */
export function shareParts(parts: Parts, weights: readonly number[]): Parts[] {
  const byKey = KEYS.map((key) => shareOf(parts[key], weights))
  return weights.map((_, index) => ({ material: byKey[0]![index]!, labour: byKey[1]![index]!, subcontract: byKey[2]![index]!, overhead: byKey[3]![index]!, adjustment: byKey[4]![index]! }))
}

/** `total` split in the mix of `mix` (exact decimals per part); no mix: all of it material. */
export function partsInMix(total: number, mix: ExactMix | null): Parts {
  if (mix === null) return { ...NO_PARTS, material: total }
  const weights = [mix.material, mix.labour, mix.subcontract, mix.overhead]
  if (weights.every((weight) => !weight.greaterThan(0))) return { ...NO_PARTS, material: total }
  const [material, labour, subcontract, overhead] = shareOf(total, weights)
  return { material: material!, labour: labour!, subcontract: subcontract!, overhead: overhead!, adjustment: 0 }
}

/** The quote's cost mix of a line: exact amounts per part (the line's or one piece's: only the proportions matter). */
export interface ExactMix {
  readonly material: Decimal
  readonly labour: Decimal
  readonly subcontract: Decimal
  readonly overhead: Decimal
  /** The leather part of the material. */
  readonly leather: Decimal | null
}

const decimalIn = (value: unknown): Decimal | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  try {
    const parsed = new Dec(value)
    return parsed.isFinite() ? parsed : null
  } catch {
    return null
  }
}

/**
 * The mix of a quote line's cost snapshot (QuoteLine.costSnapshot): the cost sheet's cells as priced (cells[] with their
 * quantity, material with its categories, labour and overhead per garment, B-W1-21), or one figure per piece
 * (`{ material, labour, per: 'piece' }`). Null when it holds neither.
 */
export function mixOfSnapshot(snapshot: unknown): ExactMix | null {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const value = snapshot as Record<string, unknown>
  if (Array.isArray(value.cells)) {
    let material = ZERO
    let labour = ZERO
    let overhead = ZERO
    let leather: Decimal | null = ZERO
    let any = false
    for (const cell of value.cells as Record<string, unknown>[]) {
      const pieces = decimalIn(cell?.quantity)
      if (pieces === null) continue
      const m = decimalIn((cell.material as Record<string, unknown> | undefined)?.amount)
      const l = decimalIn((cell.labour as Record<string, unknown> | undefined)?.amount)
      const o = decimalIn((cell.overhead as Record<string, unknown> | null | undefined)?.amount) ?? ZERO
      if (m === null || l === null) return null
      any = true
      material = material.plus(m.times(pieces))
      labour = labour.plus(l.times(pieces))
      overhead = overhead.plus(o.times(pieces))
      const categories = (cell.material as Record<string, unknown>).byCategory
      const leatherRow = Array.isArray(categories) ? (categories as Record<string, unknown>[]).find((row) => row?.category === 'LEATHER') : undefined
      const leatherAmount = leatherRow ? decimalIn(leatherRow.amount) : Array.isArray(categories) ? ZERO : null
      leather = leather === null || leatherAmount === null ? null : leather.plus(leatherAmount.times(pieces))
    }
    return any ? { material, labour, subcontract: ZERO, overhead, leather } : null
  }
  const material = decimalIn(value.material)
  const labour = decimalIn(value.labour)
  if (material === null || labour === null) return null
  return { material, labour, subcontract: decimalIn(value.subcontract) ?? ZERO, overhead: decimalIn(value.overhead) ?? ZERO, leather: decimalIn(value.leather) }
}

/** The leather share of `total` in the mix (null when the mix does not say). */
export function leatherInMix(total: number, mix: ExactMix | null): number | null {
  if (mix === null || mix.leather === null) return null
  const sum = mix.material.plus(mix.labour).plus(mix.subcontract).plus(mix.overhead)
  if (!sum.greaterThan(0)) return null
  return shareOf(total, [mix.leather, sum.minus(mix.leather)])[0]!
}

/**
 * A work order's cost as estimated now: a done one at its actual; an open one, part by part, at the larger of its plan and
 * what it already cost (a part never reads less than what is spent on it).
 */
export function estimateNowOf(plan: Parts, actual: Parts, done: boolean): Parts {
  if (done) return actual
  return { material: Math.max(plan.material, actual.material), labour: Math.max(plan.labour, actual.labour), subcontract: Math.max(plan.subcontract, actual.subcontract), overhead: Math.max(plan.overhead, actual.overhead), adjustment: Math.max(plan.adjustment, actual.adjustment) }
}

/** Margin % of the value, four places (null without a value or a cost), the order record's rule. */
export function marginPctOf(value: number, cost: number | null): string | null {
  if (cost === null || value === 0) return null
  const pct = new Dec(value - cost).times(HUNDRED).dividedBy(value).toDecimalPlaces(4, Dec.ROUND_HALF_UP)
  return pct.abs().gte(100_000) ? null : decimalText(pct)
}

/** The value of the pieces still to deliver: the net less the closed-short pieces' share, pro rata, rounded once. */
export function valueNowOf(net: number, quantity: number, closedShort: number): number {
  if (closedShort <= 0 || quantity <= 0) return net
  const kept = Math.max(0, quantity - closedShort)
  return shareOf(net, [kept, quantity - kept])[0]!
}

export interface WaterfallStep {
  readonly reason: WaterfallReason
  readonly amount: number
}

/**
 * Where the margin went, from the quoted margin to the one estimated now: the value's change (PRICE), then each cost
 * part's (a cost up is a margin down). The steps add up exactly to now − quoted.
 */
export function waterfallOf(quoted: { readonly value: number; readonly parts: Parts }, now: { readonly value: number; readonly parts: Parts }): WaterfallStep[] {
  const steps: WaterfallStep[] = [
    { reason: 'PRICE', amount: now.value - quoted.value },
    { reason: 'MATERIAL', amount: quoted.parts.material - now.parts.material },
    { reason: 'LABOUR', amount: quoted.parts.labour - now.parts.labour },
    { reason: 'SUBCONTRACT', amount: quoted.parts.subcontract - now.parts.subcontract },
    { reason: 'OVERHEAD', amount: quoted.parts.overhead - now.parts.overhead },
    { reason: 'ADJUSTMENT', amount: quoted.parts.adjustment - now.parts.adjustment },
  ]
  return steps.map((step) => ({ ...step, amount: step.amount === 0 ? 0 : step.amount }))
}

/** Average margin % over several orders: Σ margin ÷ Σ value of those with a known cost (null when none). */
export function averageMarginPct(rows: readonly { readonly value: number; readonly cost: number | null }[]): string | null {
  const known = rows.filter((row) => row.cost !== null)
  if (known.length === 0) return null
  return marginPctOf(known.reduce((sum, row) => sum + row.value, 0), known.reduce((sum, row) => sum + row.cost!, 0))
}

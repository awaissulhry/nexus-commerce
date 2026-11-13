import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { buildWaterfall, stepPrice, type OptionCharge, type StartKind, type WaterfallStep } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { manualChangeOf, netOfBasis, type RepriceHeld } from '@nexus/factory-domain/sales/configurator/rules'
import { Dec, HUNDRED } from '@nexus/factory-domain/tax/decimal'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { planLinePrice, storedSteps, type LinePricePlan, type PriceContext } from '../price-waterfall/quote-price'
import { decimal, type LineRecord, type Reader, type VersionRow } from '../quotes/store'

/**
 * A quote line priced again after its picks (B-W2b-340; SAL-133, SAL-136), through B-W2b-330's waterfall — never a price
 * computed only in the browser:
 *
 *   a stored waterfall   kept as it is (its start, quantity break, discount, manual change and size surcharges: the
 *                        same figures), the OPTION steps replaced by the line's options now; a manual change keeps its
 *                        amount (a rounding of -0.25 stays -0.25: the options move the price)
 *   none, at its list    a LIST start (B-W2b-330's planLinePrice: the list's break and size surcharges), the options, and the
 *                        discount W1 typed off the list (the same net before the options)
 *   none, typed by hand  not priced again (`NO_START`): the person gives the line a start in its waterfall first (Price &
 *                        margin); the options' surcharges are frozen on the line meanwhile and join it then
 *   a fee / a unit       `FEE` / `NOT_SIZE_GRID` (B-W2b-330 prices size-grid lines only)
 *
 * The percent of an option is taken once of the start's net (`baseOf`): the price before any change.
 */

/** A waterfall's charges from option rows (B-W2b-330's label: the value's name, then the typed text). */
export const chargesOf = (rows: readonly { readonly id: string; readonly name: string; readonly text: string | null; readonly amount: string | null; readonly pct: string | null }[]): OptionCharge[] =>
  rows.map((row) => ({ optionId: row.id, label: `${row.name}${row.text ? ` "${row.text}"` : ''}`, amount: row.amount, pct: row.pct }))

/** The start figure (on the basis) a price is built from, or the line's price when it is not priced again. */
export type Restart = { readonly kind: 'STORED'; readonly steps: WaterfallStep[]; readonly start: string } | { readonly kind: 'LIST'; readonly discountPct: string | null } | { readonly kind: 'HELD'; readonly held: RepriceHeld }

const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && new Dec(a).eq(b)

/** How a quote line is priced again (see the file's head). */
export function restartOf(line: Pick<LineRecord, 'kind' | 'unitPrice' | 'listUnitPrice'> & { readonly feeKind?: string | null }, stored: WaterfallStep[] | null, listPrice: string | null): Restart {
  if (line.kind === 'FEE') return { kind: 'HELD', held: 'FEE' }
  if (line.kind !== 'SIZE_GRID') return { kind: 'HELD', held: 'NOT_SIZE_GRID' }
  if (stored && stored.length >= 2 && stored[0]!.unitPrice !== undefined) return { kind: 'STORED', steps: stored, start: stored[0]!.unitPrice }
  const unit = decimal(line.unitPrice)
  const list = decimal(line.listUnitPrice)
  if (listPrice !== null && same(list, listPrice) && unit !== null) {
    if (new Dec(unit).gte(listPrice)) return new Dec(unit).eq(listPrice) ? { kind: 'LIST', discountPct: null } : { kind: 'HELD', held: 'NO_START' }
    // W1's discount off the list, kept (4 places, as a waterfall's percent).
    const pct = new Dec(1).minus(new Dec(unit).dividedBy(listPrice)).times(HUNDRED).toDecimalPlaces(4, Dec.ROUND_HALF_UP)
    return pct.gt(0) && pct.lte(100) ? { kind: 'LIST', discountPct: decimalText(pct) } : { kind: 'HELD', held: 'NO_START' }
  }
  return { kind: 'HELD', held: 'NO_START' }
}

/** The figure a percent surcharge is taken of: the start's net (the line's net when it is not priced again). */
export function baseOf(restart: Restart, line: Pick<LineRecord, 'unitPrice'>, listPrice: string | null, basis: 'NET' | 'GROSS', rate: string | null): string {
  const start = restart.kind === 'STORED' ? restart.start : restart.kind === 'LIST' && listPrice !== null ? listPrice : (decimal(line.unitPrice) ?? '0')
  return netOfBasis(start, basis, rate)
}

const toNetOf = (rate: string | null, basis: 'NET' | 'GROSS') => (price: string) => (basis === 'NET' || rate === null ? stepPrice(price) : stepPrice(new Dec(price).times(HUNDRED).dividedBy(HUNDRED.plus(new Dec(rate)))))

/**
 * A stored waterfall built again with `charges` in place of its OPTION steps (every other figure as stored); a manual change
 * keeps its amount (built twice: first without it, to know the price it is added to).
 */
function rebuilt(ctx: PriceContext, version: VersionRow, line: LineRecord, steps: readonly WaterfallStep[], charges: readonly OptionCharge[]): LinePricePlan {
  const first = steps[0]!
  const breakStep = steps.find((step) => step.kind === 'BREAK')
  const discount = steps.find((step) => step.kind === 'DISCOUNT')
  const manual = manualChangeOf(steps)
  const sizeCharges = steps.filter((step) => step.kind === 'SIZE_SURCHARGE' && step.sizes && step.source).flatMap((step) => Object.entries(step.sizes!).map(([size, added]) => ({ surchargeId: step.source!.id, size, added })))
  const input = {
    start: { kind: first.kind as StartKind, unitPrice: first.unitPrice!, ...(first.source ? { source: first.source } : {}), ...(first.reasonCode ? { reasonCode: first.reasonCode } : {}), ...(first.label ? { label: first.label } : {}), ...(first.note ? { note: first.note } : {}) },
    breakStep: breakStep && breakStep.delta && breakStep.source ? { delta: breakStep.delta, ...(breakStep.pct ? { pct: breakStep.pct } : {}), source: breakStep.source, ...(breakStep.label ? { label: breakStep.label } : {}) } : null,
    options: charges,
    discount: discount && discount.pct ? { pct: discount.pct, reasonCode: discount.reasonCode ?? null, ...(discount.label ? { label: discount.label } : {}) } : null,
    sizeCharges,
    onBasis: ctx.listed.onBasis,
    toNet: toNetOf(ctx.listed.rate, ctx.listed.basis),
    currency: version.currency,
  }
  const fail = (issues: readonly Issue[]) => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The price cannot be built.', issues as Issue[])
  let built = buildWaterfall(input)
  if (Array.isArray(built)) throw fail(built)
  if (manual) {
    const target = stepPrice(new Dec(built.unitPrice).plus(manual.delta))
    built = buildWaterfall({ ...input, net: { unitPrice: new Dec(target).lt(0) ? '0' : target, reasonCode: manual.reasonCode, note: manual.note } })
    if (Array.isArray(built)) throw fail(built)
  }
  const out = discount?.note ? built.steps.map((step) => (step.kind === 'DISCOUNT' ? { ...step, note: discount.note! } : step)) : built.steps
  return {
    steps: out as WaterfallStep[],
    unitPrice: built.unitPrice,
    listUnitPrice: decimal(line.listUnitPrice),
    adjustmentReason: built.adjustmentReason,
    sizesAfter: line.sizes.map((row) => ({ size: row.size, unitPrice: built.sizePrices[row.size] ?? null })),
  }
}

/** The price of a quote line with `charges` as its options (no write), or why it is not priced again. */
export async function plannedPrice(db: Reader, ctx: PriceContext, version: VersionRow, line: LineRecord, restart: Restart, charges: readonly OptionCharge[]): Promise<{ readonly plan: LinePricePlan; readonly start: StartKind } | { readonly held: RepriceHeld }> {
  if (restart.kind === 'HELD') return { held: restart.held }
  if (restart.kind === 'STORED') return { plan: rebuilt(ctx, version, line, restart.steps, charges), start: restart.steps[0]!.kind as StartKind }
  const withCharges: PriceContext = { ...ctx, options: new Map([...ctx.options, [line.id, [...charges]]]) }
  const plan = await planLinePrice(db, withCharges, version, line, { version: 1, start: 'LIST', options: true, ...(restart.discountPct ? { discount: { pct: restart.discountPct } } : {}) })
  return { plan, start: 'LIST' }
}

/** The line's stored waterfall (B-W2b-330's extras of the context). */
export const storedOf = (ctx: PriceContext, lineId: string): WaterfallStep[] | null => storedSteps(ctx.extras.get(lineId)?.priceSteps ?? null)

/** The list price the context reads for the line (null: no list prices it). */
export const listPriceOf = (ctx: PriceContext, lineId: string): string | null => ctx.listed.lines.find((row) => row.line.id === lineId)?.priced.listPrice ?? null

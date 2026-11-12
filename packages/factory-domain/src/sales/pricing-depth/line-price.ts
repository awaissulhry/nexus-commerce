import type { CurrencyCode } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { listPriceText } from '../pricelists/pricelists'
import { breakFor, surchargeFor, type AppliedBreak, type AppliedSurcharge, type BreakRow, type SurchargeRow } from './rules'

/**
 * A line's price from its price list (B-W2b-325; SAL-166, SAL-167, SAL-180), pure: the list price on the document's day
 * (the dated entry that holds then: the caller picks it), the quantity break the pieces reach, and the size surcharge of
 * each size; and the same as the first steps of the line's waterfall (factory-db QuoteLine.priceSteps, the shape the
 * database checks: LIST → BREAK → SIZE_SURCHARGE … → NET), so B-W2b-330 writes them with the line's price and adds its
 * own steps (options, discount, a manual change) before NET.
 *
 * Every figure is on the document's price basis: `onBasis` turns a net list figure into it (a consumer's quote is priced
 * VAT included); each delta is the difference of two figures on that basis, so the steps always add up.
 */

export interface PriceStep {
  readonly kind: 'LIST' | 'BREAK' | 'SIZE_SURCHARGE' | 'NET'
  readonly unitPrice?: string
  readonly delta?: string
  readonly pct?: string
  readonly sizes?: Readonly<Record<string, string>>
  readonly source?: { readonly type: string; readonly id: string }
  readonly label?: string
}

export interface LinePriceInput {
  /** The entry that prices the line on the document's day; null: no list prices it. */
  readonly entry: { readonly id: string; readonly versionId: string; readonly unitPrice: string; readonly label: string } | null
  /** The breaks of the entry's version. */
  readonly breaks: readonly BreakRow[]
  /** The size surcharges of the entry's version and the style's own. */
  readonly surcharges: readonly SurchargeRow[]
  readonly styleId: string
  /** The pieces the break counts (every line of the document the entry prices). */
  readonly quantity: number
  /** The line's sizes (none for a made-to-measure unit). */
  readonly sizes: readonly string[]
  readonly currency: CurrencyCode
  /** A net list figure on the document's price basis (identity for a business). */
  readonly onBasis?: (net: string) => string
}

export interface LinePrice {
  /** The list price on the document's basis; null: no list prices the line. */
  readonly listPrice: string | null
  readonly break: (AppliedBreak & { readonly delta: string }) | null
  /** The unit price after the break, on the document's basis. */
  readonly unitPrice: string | null
  /** Per size: what it adds on the document's basis. */
  readonly sizeSurcharges: readonly (AppliedSurcharge & { readonly onBasis: string })[]
  /** The waterfall's steps so far, ending in NET (empty without a list price). */
  readonly steps: readonly PriceStep[]
}

const minus = (a: string, b: string): string => decimalText(new Dec(a).minus(new Dec(b)))

/** The line's price from its list (see the module comment). */
export function linePriceOf(input: LinePriceInput): LinePrice {
  const onBasis = input.onBasis ?? ((net: string) => listPriceText(net))
  if (input.entry === null) return { listPrice: null, break: null, unitPrice: null, sizeSurcharges: [], steps: [] }
  const listNet = listPriceText(input.entry.unitPrice)
  const listPrice = onBasis(listNet)
  const applied = breakFor(input.breaks, input.entry.id, listNet, input.quantity, input.currency)
  const afterNet = applied?.unitPrice ?? listNet
  const unitPrice = applied ? onBasis(applied.unitPrice) : listPrice
  const steps: PriceStep[] = [{ kind: 'LIST', unitPrice: listPrice, source: { type: 'PriceListEntry', id: input.entry.id }, label: input.entry.label }]
  let brk: LinePrice['break'] = null
  if (applied) {
    const delta = minus(unitPrice, listPrice)
    if (!new Dec(delta).isZero()) {
      brk = { ...applied, delta }
      steps.push({ kind: 'BREAK', delta, unitPrice, ...(applied.discountPct ? { pct: decimalText(new Dec(applied.discountPct).negated()) } : {}), source: { type: 'PriceBreak', id: applied.breakId }, label: `From ${applied.minQuantity} pieces` })
    }
  }
  const sizeSurcharges: (AppliedSurcharge & { readonly onBasis: string })[] = []
  for (const size of input.sizes) {
    const found = surchargeFor(input.surcharges, { versionId: input.entry.versionId, styleId: input.styleId, size, unitPrice: afterNet, currency: input.currency })
    if (!found) continue
    // What the size adds on the basis: the basis of (price + surcharge) less the basis of the price, so it adds up.
    const added = minus(onBasis(decimalText(new Dec(afterNet).plus(new Dec(found.amount)))), unitPrice)
    if (new Dec(added).isZero()) continue
    sizeSurcharges.push({ ...found, onBasis: added })
  }
  const bySource = new Map<string, Record<string, string>>()
  for (const row of sizeSurcharges) bySource.set(row.surchargeId, { ...(bySource.get(row.surchargeId) ?? {}), [row.size]: row.onBasis })
  for (const [id, sizes] of bySource) steps.push({ kind: 'SIZE_SURCHARGE', sizes, source: { type: 'SizeSurcharge', id }, label: `Size ${Object.keys(sizes).join(', ')}` })
  steps.push({ kind: 'NET', unitPrice })
  return { listPrice, break: brk, unitPrice, sizeSurcharges, steps }
}

/** The pieces a break counts for one entry: every goods line of the document that this entry prices. */
export function breakQuantityOf(lines: readonly { readonly entryId: string | null; readonly quantity: number }[], entryId: string): number {
  return lines.filter((line) => line.entryId === entryId).reduce((sum, line) => sum + line.quantity, 0)
}

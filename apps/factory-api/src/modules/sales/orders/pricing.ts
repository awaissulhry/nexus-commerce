import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toMinorUnits, type CurrencyCode, type MinorUnits } from '@nexus/factory-domain/core/money'
import type { SnapshotHeader, SnapshotLine } from '@nexus/factory-domain/sales/amendments/amendments'
import { isIssueList, piecesOf, priceText, priceVersion, resolvePrice, sizeGrid, type SizeInput, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { QUOTE_RULE_DEFAULTS } from '@nexus/factory-domain/sales/quotes/rules'
import type { PartyTaxMode } from '@nexus/factory-domain/parties/tax'
import type { PriceBasis } from '@nexus/factory-domain/tax/vat-summary'
import type { VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { listPriceOf } from '../quotes/list-price'
import { costingCompanyOf, costLine, type SheetCache } from '../quotes/pricing'
import { defaultLineDescription, lineTarget } from '../quotes/lines'
import { storedVat, type QuoteParty } from '../quotes/store'
import type { PriceChain } from '../pricelists/store'
import type { Reader } from './store'

/**
 * The money of an order's lines when the office types them (B-W2a-30): a manual order (manual.ts) and an amendment
 * (amend.ts). The quote module's rules, reused as they are: a line is a style in one active colourway of the company,
 * sizes of the style's range offered as ACTIVE SKUs (sales/quotes `sizeGrid`), its unit price typed or the customer's
 * list price (B-W2a-19 price chain; on the order's basis), costed from its style revision's sheet (the RELEASED one,
 * else the newest draft: an estimate); the order's VAT treatment for every line; one rounding per figure
 * (sales/quotes `priceVersion`). A line the order already had keeps its cost per piece (the cost it was sold with).
 */

/** A line as it will be written. */
export interface LineDraft {
  /** The order line it changes; null: a new line. */
  readonly id: string | null
  readonly seq: number
  readonly kind: 'SIZE_GRID' | 'MADE_TO_MEASURE'
  readonly styleId: string
  /** Stored on the order line: the RELEASED revision only (else the work order chooses, as at acceptance). */
  readonly styleRevisionId: string | null
  readonly colourwayId: string
  readonly measurementProfileId: string | null
  readonly baseSize: string | null
  readonly description: string | null
  readonly note: string | null
  readonly unitPrice: string
  readonly sizes: readonly SizeRow[]
  readonly unitCost: string | null
  readonly costAmount: MinorUnits | null
  /** A new line, or an existing one whose sizes or prices change. */
  readonly changed: boolean
}

export interface PricedDraft extends LineDraft {
  readonly quantity: number
  readonly netAmount: MinorUnits
  readonly vatAmount: MinorUnits
  readonly vatRatePct: string
  readonly vatNature: string | null
}

export interface PricedLines {
  readonly lines: readonly PricedDraft[]
  readonly netAmount: MinorUnits
  readonly vatAmount: MinorUnits
  readonly grossAmount: MinorUnits
  readonly costAmount: MinorUnits | null
}

/** Every line priced on the basis with the treatment, and the totals (the cost only when every line has one). */
export function priceLines(basis: PriceBasis, currency: string, treatment: VatTreatment, lines: readonly LineDraft[]): PricedLines {
  const priced = priceVersion({ basis, currency, treatment, lines: lines.map((line) => ({ seq: line.seq, unitPrice: line.unitPrice, listUnitPrice: null, sizes: line.sizes, costAmount: line.costAmount })), depositPct: null, rules: QUOTE_RULE_DEFAULTS })
  const vat = storedVat(treatment)
  return {
    lines: lines.map((line, index) => ({ ...line, quantity: priced.lines[index]!.quantity, netAmount: priced.lines[index]!.netAmount, vatAmount: priced.lines[index]!.vatAmount, vatRatePct: vat.vatRatePct, vatNature: vat.vatNature })),
    netAmount: priced.netAmount,
    vatAmount: priced.vatAmount,
    grossAmount: priced.grossAmount,
    costAmount: priced.costAmount,
  }
}

/** A line's cost at its cost per piece for its new pieces (an existing line keeps what it was sold with). */
export function scaledCost(unitCost: string | null, pieces: number, currency: string): MinorUnits | null {
  if (unitCost === null) return null
  return toMinorUnits(new Dec(unitCost).times(pieces), currency as CurrencyCode)
}

export interface NewLineInput {
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: readonly SizeInput[]
  readonly unitPrice?: string | null | undefined
  readonly discountPct?: string | null | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/**
 * A new line from what the office typed: its style, colourway and revision checked (quotes `lineTarget`, in the
 * order's company), its size grid, its price (typed, else the list price; a discount off the list price), costed from
 * today's sheet. Returns the draft or the problems at `at`.
 */
export async function newLineDraft(
  db: Reader,
  ctx: { readonly companyId: string; readonly taxMode: PartyTaxMode; readonly party: QuoteParty; readonly chain: PriceChain; readonly cache: SheetCache; readonly now: Date },
  input: NewLineInput,
  seq: number,
  at: string,
): Promise<LineDraft | Issue[]> {
  let target: Awaited<ReturnType<typeof lineTarget>>
  try {
    target = await lineTarget(db, ctx.companyId, { styleId: input.styleId, colourwayId: input.colourwayId, styleRevisionId: undefined }, null, at)
  } catch (error) {
    if (error instanceof ValidationError) return [...(error.issues ?? [{ path: at, message: error.message }])]
    throw error
  }
  const sizes = sizeGrid(input.sizes, target.grid, `${at}/sizes`)
  const listed = listPriceOf(ctx.chain, ctx.taxMode, ctx.party, target.style.id, target.colourway.id)
  const typed = input.unitPrice !== undefined && input.unitPrice !== null
  const discounted = input.discountPct !== undefined && input.discountPct !== null
  const issues: Issue[] = isIssueList(sizes) ? [...sizes] : []
  if (!typed && listed === null) issues.push({ path: `${at}/unitPrice`, message: 'No price list prices this style in this colourway for the customer: type its unit price.' })
  const price = listed === null && !typed ? null : resolvePrice(typed ? { unitPrice: input.unitPrice, listUnitPrice: listed?.onBasis ?? null } : discounted ? { listUnitPrice: listed!.onBasis, discountPct: input.discountPct } : { unitPrice: listed!.onBasis, listUnitPrice: listed!.onBasis }, null, at)
  if (price !== null && isIssueList(price)) issues.push(...price)
  if (issues.length > 0) return issues
  const grid = sizes as SizeRow[]
  const resolved = price as Exclude<typeof price, Issue[] | null>
  const company = await costingCompanyOf(db, ctx.companyId)
  const cost = await costLine(db, ctx.cache, { styleId: target.style.id, styleRevisionId: target.revisionId, colourwayId: target.colourway.id, sizes: grid }, company, ctx.now)
  const released = target.revisionId === null ? null : await db.styleRevision.findUnique({ where: { id: target.revisionId }, select: { status: true } })
  return {
    id: null,
    seq,
    kind: 'SIZE_GRID',
    styleId: target.style.id,
    styleRevisionId: released?.status === 'RELEASED' ? target.revisionId : null,
    colourwayId: target.colourway.id,
    measurementProfileId: null,
    baseSize: null,
    description: blankToNull(input.description) ?? defaultLineDescription(target.style, target.colourway),
    note: blankToNull(input.note),
    unitPrice: priceText(resolved.unitPrice),
    sizes: grid,
    unitCost: cost.cost.unitCost,
    costAmount: cost.cost.amount,
    changed: true,
  }
}

/** The snapshot of a priced line (prices, never a cost). */
export const snapshotLine = (line: PricedDraft & { readonly id: string; readonly closedShortQuantity: number | null }): SnapshotLine => ({
  id: line.id,
  seq: line.seq,
  kind: line.kind,
  styleId: line.styleId,
  colourwayId: line.colourwayId,
  description: line.description,
  note: line.note,
  quantity: line.quantity,
  unitPrice: priceText(line.unitPrice),
  netAmount: line.netAmount,
  vatRatePct: new Dec(line.vatRatePct).toFixed(2),
  vatAmount: line.vatAmount,
  closedShortQuantity: line.closedShortQuantity,
  sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice === null ? null : priceText(size.unitPrice) })),
})

export type { SnapshotHeader, Reader }
export { piecesOf }

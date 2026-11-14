import { minorPlaces } from '../../core/money'
import { Dec, type DecimalInput } from '../../tax/decimal'

/**
 * Purchase price variance (B-W2b-407; FIN-031; design finance.costing "Purchase price variance": material, supplier,
 * standard, paid, difference), pure. A purchase is compared with its material's FROZEN standard per base unit, where the
 * company takes it (ActualCostSettings.ppvAt, the accountant's choice):
 *
 *   RECEIPT  a POSTED goods receipt of ours (never a customer's own goods: CUSTOMER_SUPPLIED), each line's whole base
 *            quantity at its purchase order line's price per base unit (the receipt's own valuation rule: unit price ×
 *            ordered quantity ÷ ordered base quantity), in the order's currency
 *   INVOICE  an APPROVED (or PAID) supplier invoice, each GOODS line mapped to a purchase order line: its base quantity
 *            (the invoiced quantity × the order line's base per unit) at its net amount per base unit, in the invoice's
 *            currency
 *
 * A price in another currency than the standard's is converted at the day's rate of the receipt's or the invoice's day
 * (platform/currency, never stored: B-W2b-389). difference = quantity × (paid − standard), in minor units of the standard's
 * currency, ONE half-up rounding; above 0 the company paid more than its standard. Written only while the company's
 * figures for the accountant are on (GATE-ACCOUNTANT): ./settings.ts.
 *
 * UNVERIFIED (GATE-ACCOUNTANT): at RECEIPT the order line's discount is not taken off (the receipt's valuation does not
 * either); a receipt reversed takes back its variances; an invoice voided takes back its variances; a credit note is not
 * a purchase price (no variance).
 */

export const PPV_AT = ['RECEIPT', 'INVOICE'] as const
export type PpvAt = (typeof PPV_AT)[number]

/** One variance per source event: the line's key, `:<n>` from the second one on (after a reversal); a reversal's own key. */
export const ppvKeys = Object.freeze({
  receiptLine: (lineId: string, n = 1): string => (n <= 1 ? `ppv:receipt-line:${lineId}` : `ppv:receipt-line:${lineId}:${n}`),
  invoiceLine: (lineId: string, n = 1): string => (n <= 1 ? `ppv:invoice-line:${lineId}` : `ppv:invoice-line:${lineId}:${n}`),
  reversal: (varianceId: string): string => `ppv:reversal:${varianceId}`,
})

/** quantity × (paid − standard) in minor units of `currency`, one half-up rounding; above 0 paid more than standard. */
export function ppvDifference(quantity: DecimalInput, paidUnitCost: DecimalInput, standardUnitCost: DecimalInput, currency: string): number {
  const scale = new Dec(10).pow(minorPlaces(currency))
  return Number(new Dec(quantity).times(new Dec(paidUnitCost).minus(new Dec(standardUnitCost))).times(scale).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0))
}

/** A unit cost to the six places the ledgers keep. */
const unitCost6 = (value: DecimalInput): string => new Dec(value).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)

/** An invoiced quantity in the base unit of its order line: invoiced × (ordered base quantity ÷ ordered quantity), four places. */
export function invoicedBaseQuantity(invoiced: DecimalInput, ordered: DecimalInput, orderedBase: DecimalInput): string | null {
  const per = new Dec(ordered)
  if (!per.greaterThan(0)) return null
  return new Dec(invoiced).times(new Dec(orderedBase)).dividedBy(per).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
}

/** What an invoice line paid per base unit: its net amount (minor units) ÷ its base quantity, six places. */
export function paidPerBase(netAmountMinor: number, currency: string, baseQuantity: DecimalInput): string | null {
  const base = new Dec(baseQuantity)
  if (!base.greaterThan(0)) return null
  return unitCost6(new Dec(netAmountMinor).dividedBy(new Dec(10).pow(minorPlaces(currency))).dividedBy(base))
}

/** What the order paid per base unit at receipt: unit price × ordered quantity ÷ ordered base quantity (inventory receipts' rule). */
export function orderPaidPerBase(unitPrice: DecimalInput, ordered: DecimalInput, orderedBase: DecimalInput): string | null {
  const base = new Dec(orderedBase)
  if (!base.greaterThan(0)) return null
  return unitCost6(new Dec(unitPrice).times(new Dec(ordered)).dividedBy(base))
}

/** Why a line of a receipt or an invoice took no variance, in words beside the code. */
export const PPV_SKIPS = ['CUSTOMER_OWNED', 'NOT_GOODS', 'NO_ORDER_LINE', 'NO_STANDARD', 'NO_RATE', 'NO_QUANTITY', 'TAKEN'] as const
export type PpvSkip = (typeof PPV_SKIPS)[number]

export const PPV_SKIP_WORDS: Readonly<Record<PpvSkip, string>> = Object.freeze({
  CUSTOMER_OWNED: "The customer's own goods: never valued, so never compared with a standard.",
  NOT_GOODS: 'Not a goods line (a service, a subcontract fee or a charge): no purchase price variance.',
  NO_ORDER_LINE: 'Not on a purchase order line: there is no material to compare.',
  NO_STANDARD: 'The material has no FROZEN standard on that day: nothing to compare with (freeze one in Costing › Standards).',
  NO_RATE: 'The price is in another currency and no exchange rate of that day is kept.',
  NO_QUANTITY: 'No quantity to compare.',
  TAKEN: 'Its variance is taken already.',
})

/** A variance's words: paid against standard per base unit, the quantity and the difference. */
export function ppvWords(row: { readonly quantity: string; readonly paidUnitCost: string; readonly standardUnitCost: string; readonly currency: string; readonly differenceAmount: number; readonly reversal: boolean }): string {
  const difference = new Dec(row.differenceAmount).dividedBy(new Dec(10).pow(minorPlaces(row.currency))).toFixed(minorPlaces(row.currency))
  if (row.reversal) return `Takes back a variance of ${new Dec(difference).negated().toFixed(minorPlaces(row.currency))} ${row.currency}.`
  const way = row.differenceAmount > 0 ? 'paid more than the standard' : row.differenceAmount < 0 ? 'paid less than the standard' : 'paid the standard'
  return `${new Dec(row.quantity).toString()} at ${new Dec(row.paidUnitCost).toString()} against ${new Dec(row.standardUnitCost).toString()} ${row.currency}: ${way} (${difference} ${row.currency}).`
}

/** Why a variance write is refused, as the issue path `refusal/<code>` (the screens word each code). */
export const PPV_REFUSALS = ['WAITS_FOR_ACCOUNTANT', 'OTHER_PLACE', 'NOT_READY', 'LOCKED', 'IS_REVERSAL', 'REVERSED_ALREADY'] as const
export type PpvRefusal = (typeof PPV_REFUSALS)[number]

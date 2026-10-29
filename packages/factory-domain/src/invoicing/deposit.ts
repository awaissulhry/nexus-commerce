import { fromMinorUnits, type MinorUnits } from '../core/money'
import type { BusinessDate } from '../core/time'
import { depositDocumentFor, type DepositDocumentDecision } from '../tax/deposit-rule'
import { TaxRuleError } from '../tax/rules'
import { STANDARD_VAT_RATE } from '../tax/vat-rates'
import { decideVatTreatment, type CustomerTaxProfile, type VatTreatment } from '../tax/vat-treatment'
import { formatDateIt } from './fatturapa/format'
import type { CoreLine } from './invoices'

/**
 * The deposit invoice (TD02) of a deposit request (B-W1-28; FIN-066, GAP-001; Q12: the deposit is an acconto, paid by
 * bank transfer; stage 06b-deposit), pure.
 *
 * When one is due (DPR 633/1972 art. 6 c.4): a payment received BEFORE the goods are delivered makes the sale happen,
 * for the amount paid, on the day of the payment, so an invoice is due for that amount. The request says whether the
 * rule for the party issues one at all (its `fiscalDocument`, decided by the VAT rules of B-W1-05 when it was asked
 * for: tax/deposit-rule depositDocumentFor; NONE e.g. for an EU business buying goods with a valid VIES number, when
 * the setting says so). A payment that arrives after the goods left settles the sale's own invoice: no TD02. A part
 * payment gets a TD02 for the part (the request's TD02s never pass its amount).
 *
 * What it says: one line per payment, VAT-inclusive (GROSS basis: the amount transferred is the total of the invoice,
 * Codice del Consumo art. 51 for consumers), taxed as the goods it pays for are, from the customer's tax profile at
 * the payment's date (decideVatTreatment, the ordinary 22% rate of garments; N3.2 for an EU business with a VIES proof;
 * N3.1 for an export), and a causale naming the payment.
 */

export interface DepositInvoiceDecisionInput {
  readonly fiscalDocument: 'TD02' | 'NONE'
  /** The rule code the request recorded (its fiscalRule). */
  readonly fiscalRule: string
  /** The gross this payment pays on the request (its allocation), minor units. */
  readonly paidAmount: MinorUnits
  /** The payment's value date. */
  readonly paidOn: BusinessDate
  /** The day the order's first goods left (a shipment SHIPPED), or null while nothing left. */
  readonly goodsLeftOn: BusinessDate | null
}

export interface DepositInvoiceDecision {
  readonly required: boolean
  readonly reason: string
}

export function depositInvoiceDecision(input: DepositInvoiceDecisionInput): DepositInvoiceDecision {
  if (input.fiscalDocument === 'NONE') {
    return { required: false, reason: `The deposit request needs no deposit invoice (rule ${input.fiscalRule}): the payment is recorded, the final invoice carries the whole price.` }
  }
  if (input.paidAmount <= 0) return { required: false, reason: 'Nothing of this payment went to the deposit request: no deposit invoice.' }
  if (input.goodsLeftOn !== null && input.goodsLeftOn <= input.paidOn) {
    return {
      required: false,
      reason: `The goods left on ${formatDateIt(input.goodsLeftOn)}, before this payment: it settles the sale's invoice, not an advance (DPR 633/1972 art. 6 c.4 is for payments before delivery).`,
    }
  }
  return { required: true, reason: 'Paid before the goods ship: a deposit invoice (TD02) is due for the amount paid (DPR 633/1972 art. 6 c.4).' }
}

/** What the VAT rules of B-W1-05 say for this customer now (shown beside the request's own decision). */
export function depositRuleNow(profile: CustomerTaxProfile): DepositDocumentDecision | { readonly documentType: null; readonly ruleId: null; readonly reason: string } {
  try {
    return depositDocumentFor(profile)
  } catch (error) {
    if (error instanceof TaxRuleError) return { documentType: null, ruleId: null, reason: error.message }
    throw error
  }
}

/** The VAT of a deposit: the goods' treatment for this customer (exports assumed: goods paid in advance are shipped). */
export function depositTreatment(profile: CustomerTaxProfile): { readonly treatment: VatTreatment } | { readonly problem: string } {
  try {
    return { treatment: decideVatTreatment({ customer: profile, supply: 'GOODS', rate: STANDARD_VAT_RATE, goodsLeaveEu: true }).treatment }
  } catch (error) {
    if (error instanceof TaxRuleError) return { problem: error.message }
    throw error
  }
}

export interface DepositDraftInput {
  readonly amount: MinorUnits
  readonly currency: string
  readonly treatment: VatTreatment
  readonly paidOn: BusinessDate
  /** The percent of the order's total it came from, as the request says ("30.0000"). */
  readonly depositPct: string | null
  readonly order: { readonly number: string; readonly date: BusinessDate } | null
}

/** The TD02 draft's line and causale (GROSS basis). */
export function depositInvoiceDraft(input: DepositDraftInput): { readonly priceBasis: 'GROSS'; readonly lines: readonly CoreLine[]; readonly causale: string } {
  const pct = input.depositPct === null ? '' : ` ${trimPercent(input.depositPct)}%`
  const description = input.order ? `Acconto${pct} su ordine n. ${input.order.number} del ${formatDateIt(input.order.date)}` : `Acconto${pct} su offerta accettata`
  return {
    priceBasis: 'GROSS',
    lines: [{ kind: 'GOODS', description, quantity: '1', unitPrice: fromMinorUnits(input.amount, input.currency).toFixed(6), vat: input.treatment }],
    causale: `Fattura di acconto: pagamento ricevuto il ${formatDateIt(input.paidOn)} (art. 6 c.4 DPR 633/1972)`,
  }
}

/** "30.0000" → "30", "12.5000" → "12.5". */
function trimPercent(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

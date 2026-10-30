import type { CurrencyCode, MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { formatDate, formatMoney } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { depositDocumentFor } from '../../tax/deposit-rule'
import { TaxRuleError } from '../../tax/rules'
import type { CustomerTaxProfile } from '../../tax/vat-treatment'
import { addDays, type DepositKind } from '../quotes/quotes'
import { DEPOSIT_DUE_DAYS } from '../quotes/terms'

/**
 * The deposit request of an accepted quote (B-W1-24; SAL-195, FIN-066; Q12: an acconto paid by bank transfer; PLAN §4.7
 * stage 06b-deposit), pure. Made at the acceptance from the version the customer accepted: its percent, kind and amount
 * (gross × percent, rounded once when the version was priced), due DEPOSIT_DUE_DAYS after the acceptance day, with the
 * fiscal decision of the VAT rules (B-W1-05 tax/deposit-rule) for the customer at that moment:
 *
 *   ACCONTO   an advance on the price: TD02 when the rule for the customer says so (DPR 633/1972 art. 6 c.4: paid
 *             before delivery, the supply happens for the amount paid), NONE when it does not (an EU business buying
 *             goods with a VIES proof: DL 331/1993 art. 39, UNVERIFIED, the accountant confirms)
 *   CAPARRA   a caparra confirmatoria (c.c. art. 1385) is a guarantee, not a payment on the price: no deposit invoice
 *             when it is paid; it counts against the price when the sale is invoiced (accountant to confirm)
 *
 * When it is paid (payments: deposit received), the request becomes PAID and the TD02 follows when its decision says so.
 */

export const CAPARRA_RULE = 'CAPARRA_CONFIRMATORIA'

export interface DepositDraft {
  readonly kind: DepositKind
  readonly depositPct: string
  readonly currency: CurrencyCode
  readonly amount: MinorUnits
  readonly dueDate: BusinessDate
  readonly fiscalDocument: 'TD02' | 'NONE'
  /** The rule that decided it (DepositRequest.fiscalRule). */
  readonly fiscalRule: string
  /** Why, in words (the audit row). */
  readonly reason: string
}

export interface DepositVersionFacts {
  readonly depositPct: string | null
  readonly depositKind: DepositKind | null
  readonly depositAmount: MinorUnits | null
  readonly currency: CurrencyCode
}

/** The fiscal decision of a deposit request: whether its payment is invoiced (TD02), by which rule, and why. */
export type DepositFiscalDecision = Pick<DepositDraft, 'fiscalDocument' | 'fiscalRule' | 'reason'>

/**
 * The fiscal decision of a payment of `kind` asked of this customer now (the VAT rules of B-W1-05 tax/deposit-rule): a
 * CAPARRA none, an ACCONTO the rule's (TD02 when it says so). Shared by the deposit and by a before-shipping step's
 * request (B-W2a-F2), so both follow one rule.
 */
export function depositFiscalOf(kind: DepositKind, profile: CustomerTaxProfile | null): DepositFiscalDecision {
  if (kind === 'CAPARRA') {
    return { fiscalDocument: 'NONE', fiscalRule: CAPARRA_RULE, reason: 'A caparra confirmatoria (c.c. art. 1385) is not a payment on the price: no deposit invoice when it is paid (accountant to confirm).' }
  }
  if (profile === null) {
    return { fiscalDocument: 'TD02', fiscalRule: 'DEPOSIT_INVOICE_IT', reason: 'The customer has no tax identity in force: the deposit is invoiced as an Italian one, checked again when it is paid.' }
  }
  try {
    const decision = depositDocumentFor(profile)
    return { fiscalDocument: decision.documentType === 'TD02' ? 'TD02' : 'NONE', fiscalRule: decision.ruleId, reason: decision.reason }
  } catch (error) {
    if (!(error instanceof TaxRuleError)) throw error
    // A sale the rules do not decide (an EU consumer under OSS): invoiced, and the issue's checks stop it for a person.
    return { fiscalDocument: 'TD02', fiscalRule: 'UNDECIDED', reason: error.message }
  }
}

/** The deposit request an accepted version asks for, or null when it asks none (no percent, or nothing to pay). */
export function depositRequestFor(version: DepositVersionFacts, acceptedOn: BusinessDate, profile: CustomerTaxProfile | null, dueDays: number = DEPOSIT_DUE_DAYS): DepositDraft | null {
  if (version.depositPct === null || version.depositAmount === null || version.depositAmount <= 0) return null
  const kind = version.depositKind ?? 'ACCONTO'
  // B-W2a-19: `dueDays` from the quote's payment terms (their order instalment), else DEPOSIT_DUE_DAYS.
  const base = { kind, depositPct: version.depositPct, currency: version.currency, amount: version.depositAmount, dueDate: addDays(acceptedOn, dueDays) }
  return { ...base, ...depositFiscalOf(kind, profile) }
}

/** The company's account the deposit is paid to (Q12: by bank transfer). */
export interface BankDetails {
  readonly accountHolder: string
  readonly iban: string
  readonly bic: string | null
  readonly bankName: string | null
}

/** The reference (causale) the customer writes on the transfer: the quote and version it pays for. */
export function depositReference(documentNumber: string, language: DocumentLanguage): string {
  return language === 'it' ? `Acconto offerta ${documentNumber}` : `Deposit quotation ${documentNumber}`
}

export interface PaymentInstructions {
  readonly method: 'BANK_TRANSFER'
  readonly amount: MinorUnits
  readonly currency: CurrencyCode
  readonly dueDate: BusinessDate
  readonly reference: string
  /** Null while the company has no bank details on record: the page says they follow. */
  readonly bank: BankDetails | null
  /** The instructions in words, for the page and the mail. */
  readonly text: string
}

/** How to pay a deposit request: amount, due date, reference and the company's bank account. */
export function paymentInstructions(input: {
  readonly amount: MinorUnits
  readonly currency: CurrencyCode
  readonly dueDate: BusinessDate
  readonly kind: DepositKind
  readonly documentNumber: string
  readonly bank: BankDetails | null
  readonly language: DocumentLanguage
}): PaymentInstructions {
  const reference = depositReference(input.documentNumber, input.language)
  const amount = formatMoney(input.amount, input.currency, input.language)
  const due = formatDate(input.dueDate, input.language)
  const bank = input.bank
  let text: string
  if (input.language === 'it') {
    const what = input.kind === 'CAPARRA' ? 'una caparra confirmatoria' : 'un acconto'
    const to = bank ? ` sul conto intestato a ${bank.accountHolder}, IBAN ${bank.iban}${bank.bic ? `, BIC ${bank.bic}` : ''}${bank.bankName ? ` (${bank.bankName})` : ''}` : ''
    text = `Le chiediamo ${what} di ${amount} entro il ${due}, con bonifico bancario${to}, causale «${reference}».${bank ? '' : ' Le coordinate bancarie le saranno comunicate a parte.'}`
  } else {
    const what = input.kind === 'CAPARRA' ? 'a confirmatory deposit (caparra confirmatoria)' : 'an advance payment'
    const to = bank ? ` to the account of ${bank.accountHolder}, IBAN ${bank.iban}${bank.bic ? `, BIC ${bank.bic}` : ''}${bank.bankName ? ` (${bank.bankName})` : ''}` : ''
    text = `We ask for ${what} of ${amount} by ${due}, by bank transfer${to}, reference "${reference}".${bank ? '' : ' Our bank details will follow separately.'}`
  }
  return { method: 'BANK_TRANSFER', amount: input.amount, currency: input.currency, dueDate: input.dueDate, reference, bank, text }
}

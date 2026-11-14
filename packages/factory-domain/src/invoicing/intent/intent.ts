import type { Issue } from '../../core/errors'
import { INT_MAX, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { nonTaxable, type VatTreatment } from '../../tax/vat-treatment'
import { amountText } from '../invoices'

/**
 * Declarations of intent (B-W2b-392; FIN-100; DPR 633/1972 art. 8 c.1 lett. c; DL 746/1983 art. 1; Provv. AdE
 * 96911/2020 and 293390/2021), pure: a habitual exporter (esportatore abituale) buys without VAT up to the amount it
 * declared to the tax agency for a year. We record the agency's protocol number and date, the year and the amount
 * declared for our supplies, check the protocol on the agency's site and keep the receipt it printed; an invoice whose
 * lines rest on it (Natura N3.5) names it, prints its protocol and date in the XML (AltriDatiGestionali, TipoDato
 * INTENTO) and uses its amount up at the issue; a credit note gives back what it credits. A VAT-free invoice is refused
 * when the declaration is not checked, revoked, of another year, or used up (a used-up declaration is a fine: D.Lgs.
 * 471/1997 art. 7 c.4-bis).
 *
 * GATE-ACCOUNTANT: an invoice names a declaration only while the company's declarations switch is on
 * (CompanyEInvoiceSettings.declarationsOfIntentOn, OFF by default; the …_tax_currency_w2b_guards refuse it too).
 */

export const PROTOCOL_PATTERN = /^[0-9]{17}-[0-9]{6}$/
export const MAX_REVOKE_REASON = 500
/** The Natura of a line resting on a declaration of intent. */
export const INTENT_NATURA = 'N3.5'
/** The law an N3.5 line cites when the company's tax codes give none (RiferimentoNormativo). */
export const INTENT_LEGAL_REF = 'Art. 8 c.1 lett. c) DPR 633/1972'
/** FatturaPA AltriDatiGestionali TipoDato of the declaration on an N3.5 line (Provv. AdE 293390/2021). */
export const INTENT_DATA_TYPE = 'INTENTO'

export const DECLARATION_STATES = ['UNCHECKED', 'CHECKED', 'USED_UP', 'REVOKED'] as const
export type DeclarationState = (typeof DECLARATION_STATES)[number]

export interface DeclarationFacts {
  readonly protocolNumber: string
  readonly protocolDate: BusinessDate
  readonly year: number
  readonly amount: MinorUnits
  readonly usedAmount: MinorUnits
  readonly checkedAt: string | null
  readonly revokedAt: string | null
}

export interface DeclarationInput {
  readonly protocolNumber: string
  readonly protocolDate: BusinessDate
  readonly year: number
  readonly amount: MinorUnits
}

const yearOf = (day: BusinessDate): number => Number.parseInt(day.slice(0, 4), 10)

/** Every problem of a new declaration, in words, before it is written. */
export function declarationProblems(input: DeclarationInput, today: BusinessDate, at = 'body'): Issue[] {
  const issues: Issue[] = []
  if (!PROTOCOL_PATTERN.test(input.protocolNumber)) {
    issues.push({ path: `${at}/protocolNumber`, message: "The tax agency's protocol: 17 digits, a hyphen and 6 digits, as on its receipt (26123456789012345-000001)." })
  }
  if (input.protocolDate > today) issues.push({ path: `${at}/protocolDate`, message: 'The protocol date is not in the future.' })
  const protocolYear = yearOf(input.protocolDate)
  if (input.year !== protocolYear && input.year !== protocolYear + 1) {
    issues.push({ path: `${at}/year`, message: `A declaration dated ${input.protocolDate} covers ${protocolYear} or ${protocolYear + 1}.` })
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > INT_MAX) issues.push({ path: `${at}/amount`, message: 'The amount declared for our supplies, above 0.' })
  return issues
}

/** What is left to use of a declaration (never below 0). */
export const remainingOf = (declaration: Pick<DeclarationFacts, 'amount' | 'usedAmount'>): MinorUnits => Math.max(0, declaration.amount - declaration.usedAmount)

export function declarationStateOf(declaration: DeclarationFacts): DeclarationState {
  if (declaration.revokedAt !== null) return 'REVOKED'
  if (declaration.usedAmount >= declaration.amount) return 'USED_UP'
  return declaration.checkedAt === null ? 'UNCHECKED' : 'CHECKED'
}

/** One line of an invoice as the declaration reads it. */
export interface IntentLine {
  readonly kind: string
  readonly vatNature: string | null
  readonly netAmount: MinorUnits
}

/**
 * What an invoice uses of a declaration: the net of its N3.5 lines (a deposit invoice deducted counts negative: it used
 * its share when it was issued), never below 0.
 */
export const intentAmountOf = (lines: readonly IntentLine[]): MinorUnits => Math.max(0, lines.filter((line) => line.vatNature === INTENT_NATURA).reduce((sum, line) => sum + line.netAmount, 0))

/** The VAT of a line under a declaration: N3.5 with the law (the company's tax code's, else INTENT_LEGAL_REF). */
export const intentTreatment = (legalRef: string | null): VatTreatment => nonTaxable(INTENT_NATURA, legalRef ?? INTENT_LEGAL_REF)

/** The lines a declaration turns VAT-free when it is named: goods, services and charges that carry Italian VAT. */
export const takesIntent = (line: { readonly kind: string; readonly chargeKind?: string | null; readonly vat: VatTreatment }): boolean =>
  line.kind !== 'DEPOSIT_DEDUCTION' && line.chargeKind !== 'STAMP_DUTY' && line.vat.kind === 'TAXABLE'

/** The lines that go back to the buyer's VAT when the declaration is let go: those it made N3.5. */
export const leavesIntent = (line: { readonly kind: string; readonly vat: VatTreatment }): boolean =>
  line.kind !== 'DEPOSIT_DEDUCTION' && line.vat.kind === 'NON_TAXABLE' && line.vat.natura === INTENT_NATURA

/** FatturaPA AltriDatiGestionali of an N3.5 line: the declaration's protocol and date. */
export const intentOtherData = (declaration: Pick<DeclarationFacts, 'protocolNumber' | 'protocolDate'>) => ({ type: INTENT_DATA_TYPE, text: declaration.protocolNumber, date: declaration.protocolDate })

const amountWords = (minor: MinorUnits): string => amountText(minor, 'EUR')

export interface IntentIssueFacts {
  /** The company's declarations switch (GATE-ACCOUNTANT). */
  readonly switchOn: boolean
  readonly docType: string
  /** The declaration the invoice names, or null. */
  readonly declaration: (DeclarationFacts & { readonly id: string }) | null
  readonly lines: readonly IntentLine[]
  /** The day it would be issued (today). */
  readonly issueDate: BusinessDate
}

/**
 * The checks before issue for a declaration of intent (codes INTENT_*), each in words with where to fix it. A credit
 * note never names one (it gives back what it credits). With the switch off, N3.5 lines without a declaration stay as
 * W1 issues them (met by hand).
 */
export function intentIssueProblems(facts: IntentIssueFacts): { code: string; path: string; message: string }[] {
  const problems: { code: string; path: string; message: string }[] = []
  const add = (code: string, path: string, message: string) => problems.push({ code, path, message })
  const declaration = facts.declaration
  const n35 = facts.lines.some((line) => line.vatNature === INTENT_NATURA && line.kind !== 'DEPOSIT_DEDUCTION')
  if (declaration === null) {
    if (facts.switchOn && n35 && facts.docType !== 'TD04') {
      add('INTENT_MISSING', 'declarationOfIntent', "Lines without VAT under a declaration of intent (N3.5) rest on the customer's declaration: name it on the invoice, or give the lines their VAT.")
    }
    return problems
  }
  const words = `Declaration of intent ${declaration.protocolNumber}`
  if (!facts.switchOn) add('INTENT_OFF', 'declarationOfIntent', `Declarations of intent are switched off for this company until the accountant confirms them: let ${declaration.protocolNumber} go from the invoice.`)
  if (declaration.revokedAt !== null) add('INTENT_REVOKED', 'declarationOfIntent', `${words} was revoked: no invoice rests on it. Let it go and charge VAT, or name the customer's new declaration.`)
  else {
    if (declaration.checkedAt === null) add('INTENT_UNCHECKED', 'declarationOfIntent', `${words} is not checked on the tax agency's site yet: check it and keep the receipt first.`)
    if (declaration.year !== yearOf(facts.issueDate)) add('INTENT_YEAR', 'declarationOfIntent', `${words} covers ${declaration.year}; an invoice issued on ${facts.issueDate} rests on a declaration of ${yearOf(facts.issueDate)}.`)
    if (declaration.protocolDate > facts.issueDate) add('INTENT_DATE', 'declarationOfIntent', `${words} is dated ${declaration.protocolDate}, after the invoice.`)
    const needed = intentAmountOf(facts.lines)
    const left = remainingOf(declaration)
    if (needed > left) {
      add(
        'INTENT_USED_UP',
        'declarationOfIntent',
        `${words} declares ${amountWords(declaration.amount)} and ${amountWords(declaration.usedAmount)} of it is used: this invoice needs ${amountWords(needed)}, only ${amountWords(left)} is left. Charge VAT on the rest, or ask the customer for a new declaration.`,
      )
    }
  }
  if (!n35) add('INTENT_NO_LINES', 'lines', `The invoice names ${words} but has no line without VAT under it (N3.5): let the declaration go, or name it again to turn the lines VAT-free.`)
  return problems
}

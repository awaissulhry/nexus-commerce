import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal } from '../../tax/decimal'
import { isNaturaCode, NATURA_DESCRIPTIONS, type NaturaCode } from '../../tax/natura'
import { TAX_RULES, type TaxRuleId, type TaxRuleStatus } from '../../tax/rules'
import { ITALIAN_VAT_RATES } from '../../tax/vat-rates'
import { nonTaxable, taxable, type VatTreatment } from '../../tax/vat-treatment'

/**
 * A company's tax codes as data (B-W2b-392; FIN-107; design finance.settings "Company & tax" → "Per company (W2b tax
 * configuration: rates, reason codes, effective dates)" and "VAT reasons and wording"), pure: what a code version is
 * (factory-db tax.prisma TaxCode: a rate, or a Natura with its law, the account key, the rule of factory-domain
 * tax/rules.ts it applies, valid from a day to a day or open), the problems of a new or changed version in words, the
 * state of a version on a day, what may be done to it, and the code in force for a line's VAT. Finance changes them
 * through the API (apps/factory-api modules/invoicing/tax-codes), never code.
 *
 * The rules the …_tax_currency_w2b_guards triggers hold, said again here so the API refuses first in words:
 *   - a version in force (its first day ≤ today, Europe/Rome) is never edited: its end may move (not before yesterday),
 *     its label changes; anything else is a new version from a later day (the old one ends the day before);
 *   - a version not yet in force is edited or deleted; a version made by mistake is ARCHIVED;
 *   - ACTIVE versions of one code (company, country, code) never overlap;
 *   - UNVERIFIED until a person records the accountant's confirmation (VERIFIED, once, never back).
 *
 * GATE-ACCOUNTANT: the codes reach documents only while the company's tax-codes switch is on (CompanyEInvoiceSettings
 * taxCodesOn, OFF by default): then an invoice line's VAT must be a code in force on the issue day (an Italian rate, or a
 * Natura code) and a non-taxable line prints the code's law. Italy (IT) is the only tax system documents use today.
 */

export const TAX_CODE_STATES = ['PLANNED', 'IN_FORCE', 'ENDED', 'ARCHIVED'] as const
export type TaxCodeState = (typeof TAX_CODE_STATES)[number]

export const TAX_CODE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export const TAX_CODE_VERIFICATIONS = ['VERIFIED', 'UNVERIFIED'] as const satisfies readonly TaxRuleStatus[]

/** The tax system the invoice lines use (Italian VAT). */
export const DOCUMENT_COUNTRY = 'IT'

export const COUNTRY_PATTERN = /^[A-Z]{2}$/
export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,19}$/
export const ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,59}$/
export const MAX_LABEL = 200
export const MAX_LEGAL_REF = 100
// One line: no control character (the guards' factory_recall_words_ok without lines).
const ONE_LINE = /^[^\p{Cc}]*$/u

/** A tax code version as the API reads it (dates as YYYY-MM-DD; the rate as "22.00"). */
export interface TaxCodeFacts {
  readonly id: string
  readonly companyId: string
  readonly country: string
  readonly code: string
  readonly label: string
  readonly ratePct: string
  readonly natura: string | null
  readonly legalRef: string | null
  readonly accountCodeKey: string | null
  readonly ruleId: string | null
  readonly verification: TaxRuleStatus
  readonly confirmedAt: string | null
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
  readonly status: (typeof TAX_CODE_STATUSES)[number]
}

/** What a person types for a version (a new code, a new version of a code, or a change of one not yet in force). */
export interface TaxCodeInput {
  readonly country: string
  readonly code: string
  readonly label: string
  readonly ratePct: string
  readonly natura: string | null
  readonly legalRef: string | null
  readonly accountCodeKey: string | null
  readonly ruleId: string | null
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
}

const isRuleId = (value: string): value is TaxRuleId => Object.hasOwn(TAX_RULES, value)
const words = (value: string, longest: number): boolean => value.trim() !== '' && value.length <= longest && ONE_LINE.test(value)

/** Every problem of a version, in words, with where to fix it (`at` + field), before it is written. */
export function taxCodeProblems(input: TaxCodeInput, at = 'body'): Issue[] {
  const issues: Issue[] = []
  const add = (field: string, message: string) => issues.push({ path: `${at}/${field}`, message })
  if (!COUNTRY_PATTERN.test(input.country)) add('country', 'The country is two capitals (ISO 3166-1): IT for Italian VAT.')
  if (!CODE_PATTERN.test(input.code)) add('code', 'A code is 1 to 20 capitals, digits, dot, underscore or hyphen: "22", "N3.2", "N3.5-DI".')
  if (!words(input.label, MAX_LABEL)) add('label', `Say what the code is for in one line, 1 to ${MAX_LABEL} characters.`)
  const rate = parseDecimal(input.ratePct)
  if (rate === null || rate.lt(0) || rate.gt(100) || rate.decimalPlaces() > 2) add('ratePct', 'A rate from 0 to 100 percent with at most 2 decimals.')
  else if (input.country === DOCUMENT_COUNTRY && !rate.isZero() && !ITALIAN_VAT_RATES.some((one) => new Dec(one).eq(rate))) {
    add('ratePct', `An Italian VAT rate is ${ITALIAN_VAT_RATES.join(', ')} percent, or 0 with its Natura.`)
  }
  const zero = rate !== null && rate.isZero()
  if (zero && input.natura === null) add('natura', 'A rate of 0 needs its Natura (N1, N2.1 … N7: why no VAT is charged) and its law.')
  if (!zero && input.natura !== null) add('natura', 'A code with a rate carries no Natura; a Natura goes with a rate of 0.')
  if (input.natura !== null && !isNaturaCode(input.natura)) add('natura', 'A detailed Natura code SDI accepts: N1, N2.1, N2.2, N3.1 … N3.6, N4, N5, N6.1 … N6.9, N7.')
  if (input.natura !== null && (input.legalRef === null || !words(input.legalRef, MAX_LEGAL_REF))) {
    add('legalRef', `A code with a Natura cites its law in one line, 1 to ${MAX_LEGAL_REF} characters (it is printed on the invoice: RiferimentoNormativo).`)
  }
  if (input.natura === null && input.legalRef !== null) add('legalRef', 'Only a code with a Natura cites a law.')
  if (input.accountCodeKey !== null && !ACCOUNT_KEY_PATTERN.test(input.accountCodeKey)) add('accountCodeKey', 'An account key is 1 to 60 letters, digits, dot, underscore, colon, slash or hyphen.')
  if (input.ruleId !== null && !isRuleId(input.ruleId)) add('ruleId', `Not a tax rule of the catalogue: ${Object.keys(TAX_RULES).join(', ')}.`)
  if (input.validTo !== null && input.validTo < input.validFrom) add('validTo', 'A code ends on or after the day it starts.')
  return issues
}

/** Where a version stands on `today` (Europe/Rome). */
export function codeStateOf(code: Pick<TaxCodeFacts, 'status' | 'validFrom' | 'validTo'>, today: BusinessDate): TaxCodeState {
  if (code.status === 'ARCHIVED') return 'ARCHIVED'
  if (code.validFrom > today) return 'PLANNED'
  if (code.validTo !== null && code.validTo < today) return 'ENDED'
  return 'IN_FORCE'
}

/** The day before `day` (YYYY-MM-DD). */
export function dayBefore(day: BusinessDate): BusinessDate {
  const at = new Date(`${day}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() - 1)
  return at.toISOString().slice(0, 10)
}

/** What a person may do to a version on `today` (the triggers' rules). */
export interface CodeActions {
  /** Change anything (not yet in force). */
  readonly edit: boolean
  /** Change its label, or its end (in force, its end not passed). */
  readonly relabel: boolean
  readonly end: boolean
  /** Make the next version from a later day (in force or planned, ACTIVE). */
  readonly newVersion: boolean
  readonly archive: boolean
  readonly delete: boolean
  /** Record the accountant's confirmation (UNVERIFIED, ACTIVE). */
  readonly confirm: boolean
}

export function codeActions(code: TaxCodeFacts, today: BusinessDate): CodeActions {
  const state = codeStateOf(code, today)
  const active = code.status === 'ACTIVE'
  return {
    edit: state === 'PLANNED',
    relabel: state === 'PLANNED' || state === 'IN_FORCE',
    end: state === 'IN_FORCE',
    newVersion: state === 'IN_FORCE' || state === 'PLANNED',
    archive: active,
    delete: state === 'PLANNED',
    confirm: active && code.verification === 'UNVERIFIED',
  }
}

/** Two periods [from, to] (to null: open) share a day. */
export const periodsOverlap = (a: { validFrom: BusinessDate; validTo: BusinessDate | null }, b: { validFrom: BusinessDate; validTo: BusinessDate | null }): boolean =>
  a.validFrom <= (b.validTo ?? '9999-12-31') && b.validFrom <= (a.validTo ?? '9999-12-31')

/** The ACTIVE version of the same code whose period meets `candidate`'s (the guards refuse it), or null. */
export function overlappingVersion(candidate: Pick<TaxCodeFacts, 'country' | 'code' | 'validFrom' | 'validTo'> & { readonly id?: string }, others: readonly TaxCodeFacts[]): TaxCodeFacts | null {
  return others.find((other) => other.status === 'ACTIVE' && other.id !== candidate.id && other.country === candidate.country && other.code === candidate.code && periodsOverlap(other, candidate)) ?? null
}

/**
 * The next version of a code from `from`: the current version ends the day before. `from` is after the current version's
 * first day and, while it is in force, not before today (its end is never before yesterday). Null: allowed; else the
 * problem in words.
 */
export function nextVersionProblem(current: TaxCodeFacts, from: BusinessDate, today: BusinessDate): string | null {
  if (current.status !== 'ACTIVE') return 'An archived version has no next version: make a new code version from the list.'
  if (from <= current.validFrom) return `The next version starts after this one (from ${current.validFrom}).`
  if (codeStateOf(current, today) === 'IN_FORCE' && from < today) return 'A code in force changes from today at the earliest: what applied to past documents stays.'
  if (current.validTo !== null && current.validTo < today) return 'This version has ended: make a new version from the list.'
  return null
}

/** The VAT a code puts on an invoice line, or null when the line cannot carry it (a rate that is not Italian). */
export function treatmentOfCode(code: Pick<TaxCodeFacts, 'ratePct' | 'natura' | 'legalRef'>): VatTreatment | null {
  const rate = parseDecimal(code.ratePct)
  if (rate === null) return null
  if (rate.isZero()) return isNaturaCode(code.natura) && code.legalRef ? nonTaxable(code.natura, code.legalRef) : null
  const italian = ITALIAN_VAT_RATES.find((one) => new Dec(one).eq(rate))
  return italian === undefined || code.natura !== null ? null : taxable(italian)
}

/** The company's ACTIVE versions in force on `day` (country IT unless said). */
export function codesInForce(codes: readonly TaxCodeFacts[], day: BusinessDate, country = DOCUMENT_COUNTRY): TaxCodeFacts[] {
  return codes.filter((code) => code.status === 'ACTIVE' && code.country === country && code.validFrom <= day && (code.validTo === null || code.validTo >= day))
}

/**
 * The code in force that carries a line's VAT: for a rate, a code of that rate; for a Natura, a code of that Natura,
 * preferring the one whose law the line prints already, then the one of `ruleId`, then the first by code. Null: none.
 */
export function codeForTreatment(inForce: readonly TaxCodeFacts[], treatment: VatTreatment, ruleId: TaxRuleId | null = null): TaxCodeFacts | null {
  const fitting = inForce
    .filter((code) => {
      const own = treatmentOfCode(code)
      if (own === null) return false
      if (treatment.kind === 'TAXABLE') return own.kind === 'TAXABLE' && own.rate === treatment.rate
      return own.kind === 'NON_TAXABLE' && own.natura === treatment.natura
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  if (fitting.length === 0) return null
  if (treatment.kind === 'NON_TAXABLE') {
    const same = fitting.find((code) => code.legalRef === treatment.legalReference)
    if (same) return same
  }
  return fitting.find((code) => ruleId !== null && code.ruleId === ruleId) ?? fitting[0]!
}

/** A line's VAT in words: "22 %", "N3.2 (non imponibili - cessioni intracomunitarie)". */
export function treatmentWords(treatment: VatTreatment): string {
  return treatment.kind === 'TAXABLE' ? `${treatment.rate} %` : `${treatment.natura} (${NATURA_DESCRIPTIONS[treatment.natura as NaturaCode]})`
}

/** One line of an invoice as the code check reads it. */
export interface CheckedLine {
  readonly seq: number
  readonly kind: string
  readonly vat: VatTreatment | null
}

/**
 * With the tax-codes switch on: every line but a deposit deducted (it keeps its deposit invoice's VAT) carries the VAT of
 * a code in force on the issue day; else a problem TAX_CODE in words, with where to fix it.
 */
export function lineCodeProblems(lines: readonly CheckedLine[], inForce: readonly TaxCodeFacts[], day: BusinessDate): { code: string; path: string; message: string }[] {
  const problems: { code: string; path: string; message: string }[] = []
  lines.forEach((line, index) => {
    if (line.kind === 'DEPOSIT_DEDUCTION' || line.vat === null) return
    if (codeForTreatment(inForce, line.vat) === null) {
      problems.push({
        code: 'TAX_CODE',
        path: `lines/${index}/vat`,
        message: `Line ${line.seq} carries VAT ${treatmentWords(line.vat)}, which is not a tax code of the company in force on ${day}: finance adds it in the tax set-up, or the line takes another VAT.`,
      })
    }
  })
  return problems
}

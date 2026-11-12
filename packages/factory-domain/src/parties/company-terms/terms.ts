import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { parseDecimal } from '../../tax/decimal'

/**
 * A customer's terms with one of our companies (B-W2b-290; SAL-028 "one customer across several of our companies", SAL-013
 * "customer PO number required"; design sales.customers record › Tax & terms › Commercial terms "Customer PO number
 * required (W2b, SAL-013)"), pure. The rows are factory-db's PartyCompanyTerms (B-W2b-279): one live row per party and
 * company, changed in place (who set it last is kept, the audit keeps each change), ended when that company goes back to
 * the party's own terms. A tenant-wide customer (no company) may have terms with each company; a customer of one company
 * only with its own.
 *
 * What a company's terms decide, each null = the party's own (W1, W2a: Party columns, the default for every company):
 *
 *   paymentTermsId, paymentTerms   the payment terms (library, printed) a new quote and a typed order of that company take
 *   priceListId                    the list its quotes and orders of that company are priced from
 *   depositPct                     the deposit a new quote of that company asks
 *   poNumberRequired               its orders with that company need its purchase order number at confirm (no column on
 *                                  the party: without a row of the company, no PO number is required)
 *
 * The credit limit on the same row is B-W2b-304's (credit limits): read here with the price grain, never written.
 */

export const TERMS_LIMITS = Object.freeze({ paymentTerms: 500, customerRef: 100 })

export interface PartyDefaults {
  readonly paymentTermsId: string | null
  readonly paymentTerms: string | null
  readonly priceListId: string | null
  /** As stored: a decimal or null. */
  readonly defaultDepositPct: { toString(): string } | null
}

export interface CompanyTermsFacts {
  readonly paymentTermsId: string | null
  readonly paymentTerms: string | null
  readonly priceListId: string | null
  readonly depositPct: { toString(): string } | null
  readonly poNumberRequired: boolean
}

export interface TermsInForce {
  readonly paymentTermsId: string | null
  readonly paymentTerms: string | null
  readonly priceListId: string | null
  readonly depositPct: string | null
  readonly poNumberRequired: boolean
  /** Where each came from: the company's terms, or the party's own. */
  readonly source: { readonly paymentTerms: 'COMPANY' | 'PARTY'; readonly priceList: 'COMPANY' | 'PARTY'; readonly deposit: 'COMPANY' | 'PARTY' }
}

/** The terms a company works with: its live row's, field by field, else the party's own. */
export function termsInForce(party: PartyDefaults, company: CompanyTermsFacts | null): TermsInForce {
  const termsFromCompany = company !== null && (company.paymentTermsId !== null || company.paymentTerms !== null)
  const listFromCompany = company !== null && company.priceListId !== null
  const depositFromCompany = company !== null && company.depositPct !== null
  return {
    paymentTermsId: termsFromCompany ? company.paymentTermsId : party.paymentTermsId,
    paymentTerms: termsFromCompany ? company.paymentTerms : party.paymentTerms,
    priceListId: listFromCompany ? company.priceListId : party.priceListId,
    depositPct: depositFromCompany ? company.depositPct!.toString() : party.defaultDepositPct === null ? null : party.defaultDepositPct.toString(),
    poNumberRequired: company?.poNumberRequired ?? false,
    source: { paymentTerms: termsFromCompany ? 'COMPANY' : 'PARTY', priceList: listFromCompany ? 'COMPANY' : 'PARTY', deposit: depositFromCompany ? 'COMPANY' : 'PARTY' },
  }
}

export interface CompanyTermsInput {
  readonly paymentTerms?: string | null | undefined
  readonly depositPct?: string | null | undefined
}

/** The rules of the fields a person types (the database holds the same); paths are field names. */
export function companyTermsProblems(input: CompanyTermsInput): Issue[] {
  const issues: Issue[] = []
  if (input.paymentTerms !== undefined && input.paymentTerms !== null && input.paymentTerms.trim().length > TERMS_LIMITS.paymentTerms) {
    issues.push({ path: 'paymentTerms', message: `At most ${TERMS_LIMITS.paymentTerms} characters.` })
  }
  if (input.depositPct !== undefined && input.depositPct !== null) {
    const pct = parseDecimal(input.depositPct)
    if (pct === null || !fitsDecimal(input.depositPct, 7, 4) || pct.lte(0) || pct.gt(100)) issues.push({ path: 'depositPct', message: 'A deposit above 0 and at most 100 percent of the gross total, or none (the party’s own).' })
  }
  return issues
}

/** The order's PO number is missing where the company's terms require one: the words, else null. */
export function poNumberProblem(required: boolean, customerRef: string | null | undefined, who: { readonly code: string; readonly company: string }): string | null {
  if (!required) return null
  if ((customerRef ?? '').trim() !== '') return null
  return `${who.code} needs its purchase order number on every order with ${who.company}: type the customer's PO number (customer reference) before the order is confirmed.`
}

/** The changes of a company's terms its event names (party.company_terms_changed): SET (made or changed), ENDED. */
export const COMPANY_TERMS_CHANGES = ['SET', 'ENDED'] as const

import type { InvoiceTiming } from '../../terms/api'

/**
 * F-CT-102 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 13-backend §4.1; 18-lead-settles Z1, Z32) — ONE SOURCE of "the terms
 * in force" with one of our companies, pure. Terms & requirements, Money's Credit & terms and Balance, and the Overview's Payment fact
 * all ask THIS helper, so the three tabs never say two things: for a company its live terms row wins field by field, else the
 * customer's own terms, else the text typed on the customer, else nothing (the server's own order: factory-domain parties/company-terms
 * `termsInForce`). Payment terms, deposit and price list each say where they come from; invoicing and currency are always the
 * customer's own (a company row has none). The payment terms' name is said in the page's language (`nameI18n`), their meaning too. The
 * library row's `customers` count (other customers) is never read here.
 *
 * The input types are the reads' shapes as this helper reads them (structural): the commercial-terms read (R1), the company-terms read
 * (R4, with S5's `inForce.paymentTerms` / `inForce.priceList` when the server gives them — absent, the company row's label).
 */

/** Payment terms as a read names them: R1's `paymentTerms`, R4's `inForce.paymentTerms` (S5). */
export interface NamedTerms {
  readonly id: string
  readonly code: string
  readonly name: string
  /** The name per language ({ it, en }); absent or null: the name only. */
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly summary: { readonly it: string; readonly en: string }
  /** The share of the order instalment (the terms' deposit), else null. */
  readonly deposit: { readonly sharePct: string } | null
}

/** The customer's own terms (R1 `GET /parties/:id/commercial-terms`), as this helper reads them. */
export interface OwnTerms {
  readonly currency: string
  readonly paymentTermsId: string | null
  readonly paymentTerms: NamedTerms | null
  readonly paymentTermsText: string | null
  readonly priceList: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly defaultDepositPct: string | null
  readonly invoiceTiming: InvoiceTiming
}

type Source = 'COMPANY' | 'PARTY'
export type TermsSource = Source

/** One company of the company-terms read (R4), as this helper reads it. */
export interface CompanyTermsEntry {
  readonly company: { readonly id: string; readonly code: string; readonly name: string }
  /** The company's own live terms row (null: none — the customer's own apply). */
  readonly terms: {
    readonly paymentTermsLabel: { readonly code: string; readonly name: string } | null
    readonly priceListLabel: { readonly code: string; readonly name: string } | null
  } | null
  readonly inForce: {
    readonly paymentTermsId: string | null
    readonly paymentTermsText: string | null
    readonly priceListId: string | null
    readonly depositPct: string | null
    readonly poNumberRequired: boolean
    readonly source: { readonly paymentTerms: Source; readonly priceList: Source; readonly deposit: Source }
    /** S5: the payment terms in force, named (either source); absent before ct-s. */
    readonly paymentTerms?: NamedTerms | null | undefined
    /** S5: the price list in force (either source); absent before ct-s. */
    readonly priceList?: { readonly id: string; readonly code: string; readonly name: string } | null | undefined
  }
}

/** The company-terms read (R4), as this helper reads it. */
export interface CompanyTermsFacts {
  readonly tenantWide: boolean
  readonly companies: readonly CompanyTermsEntry[]
}

export interface TermsSources {
  /** The customer's own terms (R1); null: not read (yet, or it failed). */
  readonly commercial: OwnTerms | null
  /** The terms per company (R4); null: not read (yet, or it failed) — the customer's own then answer, and the caller SAYS so. */
  readonly companies: CompanyTermsFacts | null
  /** The company asked about: the page's (the session's); a customer of one company: its one row whatever is asked. */
  readonly companyId: string | null
  /** The text typed on the customer (party.paymentTerms, the old printed words): the last fallback. */
  readonly typed: string | null
}

export interface PaymentTermsInForce {
  /** The library terms' id; null for a typed text. */
  readonly id: string | null
  readonly code: string | null
  /** In the page's language. */
  readonly name: string
  /** What they mean, in the page's language; null when the read does not say it (a typed text, a company row before S5). */
  readonly meaning: string | null
  readonly source: TermsSource
  /** The company whose own row gives them (source COMPANY), else null. */
  readonly company: string | null
  /** A typed text, not from the library. */
  readonly typed: boolean
  /** The share of the order instalment the terms ask (their deposit), else null. */
  readonly orderShare: string | null
}

export interface DepositInForce {
  /** The percent ("30"); null: from the sales settings. */
  readonly pct: string | null
  /** The company's own row · the customer's own percent · the payment terms' order share · the sales settings. */
  readonly from: 'COMPANY' | 'PARTY' | 'TERMS' | 'SETTINGS'
  readonly source: TermsSource
}

export interface PriceListInForce {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly source: TermsSource
}

/** Z32: the ONE in-force terms object of a company — every fact of the three tabs comes from it. */
export interface TermsInForce {
  /** The company it is for (null: none asked and the customer is of several). */
  readonly company: CompanyTermsEntry['company'] | null
  readonly paymentTerms: PaymentTermsInForce | null
  readonly deposit: DepositInForce
  readonly priceList: PriceListInForce | null
  /** The company's PO number rule; null: the company terms are not read. */
  readonly poNumberRequired: boolean | null
  /** Always the customer's own; null: R1 not read. */
  readonly invoicing: InvoiceTiming | null
  /** Always the customer's own; null: R1 not read. */
  readonly currency: string | null
  /** The company-terms read is in: false = these are the customer's own terms only (the caller says so once). */
  readonly companyRead: boolean
}

const nameIn = (terms: NamedTerms, locale: 'en' | 'it'): string => terms.nameI18n?.[locale] ?? terms.name

/** The company's entry: the one asked; a customer of one company: its one row; else null. */
export function companyOf(companies: CompanyTermsFacts | null, companyId: string | null): CompanyTermsEntry | null {
  if (!companies) return null
  const asked = companyId ? companies.companies.find((entry) => entry.company.id === companyId) : undefined
  if (asked) return asked
  return companies.companies.length === 1 ? companies.companies[0]! : null
}

/** The payment terms in force with the company, named in the page's language, with their source. */
export function paymentTermsInForce(input: TermsSources, locale: 'en' | 'it'): PaymentTermsInForce | null {
  const entry = companyOf(input.companies, input.companyId)
  if (entry && entry.inForce.source.paymentTerms === 'COMPANY') {
    const company = entry.company.name
    const named = entry.inForce.paymentTerms ?? null
    if (named) return { id: named.id, code: named.code, name: nameIn(named, locale), meaning: named.summary[locale], source: 'COMPANY', company, typed: false, orderShare: named.deposit?.sharePct ?? null }
    const label = entry.terms?.paymentTermsLabel ?? null
    if (label) return { id: entry.inForce.paymentTermsId, code: label.code, name: label.name, meaning: null, source: 'COMPANY', company, typed: false, orderShare: null }
    if (entry.inForce.paymentTermsText) return { id: null, code: null, name: entry.inForce.paymentTermsText, meaning: null, source: 'COMPANY', company, typed: true, orderShare: null }
  }
  const own = input.commercial?.paymentTerms ?? (entry && entry.inForce.source.paymentTerms === 'PARTY' ? (entry.inForce.paymentTerms ?? null) : null)
  if (own) return { id: own.id, code: own.code, name: nameIn(own, locale), meaning: own.summary[locale], source: 'PARTY', company: null, typed: false, orderShare: own.deposit?.sharePct ?? null }
  // R1's typed text IS the customer's own column; without R1 the company read's (PARTY source), else the party's field.
  const typed = input.commercial ? input.commercial.paymentTermsText : ((entry?.inForce.source.paymentTerms === 'PARTY' ? entry.inForce.paymentTermsText : null) ?? input.typed)
  if (typed) return { id: null, code: null, name: typed, meaning: null, source: 'PARTY', company: null, typed: true, orderShare: null }
  return null
}

/**
 * The deposit a new quote of the company takes (the server's rule, P17): the company row's percent › the customer's own percent › the
 * order share of the payment terms in force › the sales settings.
 */
export function depositInForce(input: TermsSources): DepositInForce {
  const entry = companyOf(input.companies, input.companyId)
  if (entry && entry.inForce.source.deposit === 'COMPANY' && entry.inForce.depositPct !== null) return { pct: entry.inForce.depositPct, from: 'COMPANY', source: 'COMPANY' }
  const own = input.commercial ? input.commercial.defaultDepositPct : (entry?.inForce.depositPct ?? null)
  if (own !== null) return { pct: own, from: 'PARTY', source: 'PARTY' }
  const terms = paymentTermsInForce(input, 'en')
  if (terms?.orderShare) return { pct: terms.orderShare, from: 'TERMS', source: terms.source }
  return { pct: null, from: 'SETTINGS', source: 'PARTY' }
}

/** The price list a new quote of the company is priced from, with its source; null: the base list. */
export function priceListInForce(input: TermsSources): PriceListInForce | null {
  const entry = companyOf(input.companies, input.companyId)
  if (entry && entry.inForce.source.priceList === 'COMPANY' && entry.inForce.priceListId) {
    const named = entry.inForce.priceList ?? null
    const label = named ?? entry.terms?.priceListLabel ?? null
    return { id: entry.inForce.priceListId, code: label?.code ?? '', name: label?.name ?? '', source: 'COMPANY' }
  }
  const own = input.commercial?.priceList ?? (entry && entry.inForce.source.priceList === 'PARTY' ? (entry.inForce.priceList ?? null) : null)
  return own ? { id: own.id, code: own.code, name: own.name, source: 'PARTY' } : null
}

/** Z32: the ONE in-force terms object of the company asked — payment terms, deposit and price list with their source, invoicing, currency. */
export function termsInForce(input: TermsSources, locale: 'en' | 'it'): TermsInForce {
  const entry = companyOf(input.companies, input.companyId)
  return {
    company: entry?.company ?? null,
    paymentTerms: paymentTermsInForce(input, locale),
    deposit: depositInForce(input),
    priceList: priceListInForce(input),
    poNumberRequired: input.companies ? (entry?.inForce.poNumberRequired ?? false) : null,
    invoicing: input.commercial?.invoiceTiming ?? null,
    currency: input.commercial?.currency ?? null,
    companyRead: input.companies !== null,
  }
}

/** The terms in force with EACH company the reader sees (the company rows of Commercial terms). */
export function termsPerCompany(input: Omit<TermsSources, 'companyId'>, locale: 'en' | 'it'): Array<{ readonly entry: CompanyTermsEntry; readonly inForce: TermsInForce }> {
  return (input.companies?.companies ?? []).map((entry) => ({ entry, inForce: termsInForce({ ...input, companyId: entry.company.id }, locale) }))
}

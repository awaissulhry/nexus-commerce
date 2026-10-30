import type { BusinessDate } from '../../core/time'
import type { CurrencyCode, MinorUnits } from '../../core/money'
import { formatDate, formatMoney, formatPercent } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { PartyTaxMode } from '../../parties/tax'
import type { DepositKind } from './quotes'

/**
 * The terms and legal wording a sent quote prints (SAL-194; PLAN §2.8; A1 §2.5 "legal wording moves to a per-country
 * table"; ported from the old app's apps/factory/src/lib/quotes/legal.ts, EPQ.5), pure. A version prints the clauses of
 * its TERMS SET (who it is for: a consumer, a business, a buyer outside the EU), in its language, and the company's own
 * terms (QuoteVersion.termsText) under their version (termsVersion). The acceptance records which terms were accepted
 * (QuoteAcceptance.termsVersion): the version's own termsVersion, or the set's id when the company has no terms of its
 * own. The sales settings hold no terms yet (W2a "terms library"); these are the defaults.
 *
 *   clause              when                              why
 *   PRICES              always                            consumers: VAT-inclusive prices (Codice del Consumo art. 49)
 *   VALIDITY            always                            a firm offer says so expressly (c.c. art. 1329); otherwise
 *                                                         the bare "valid until" keeps it revocable until accepted
 *   DELIVERY            a promise date                    a consumer is told the delivery date (art. 49(1)(g))
 *   DEPOSIT             a deposit is asked                an acconto (advance on the price) OR a caparra confirmatoria
 *                                                         (c.c. art. 1385): never both labels on one sum; a consumer's
 *                                                         caparra carries both directions of art. 1385
 *   NO_WITHDRAWAL       a made-to-measure unit for a      the exclusion holds only when disclosed (art. 59(1)(c),
 *                       consumer                          CJEU C-529/19)
 *   DUTIES              a buyer outside the EU            duties and taxes of the destination are the buyer's
 *   ACCEPTANCE          always                            how to accept: the personal link and a typed name
 *   TERMS               the company's own terms           printed with their version
 */

export const TERMS_KINDS = ['CONSUMER', 'BUSINESS', 'EXPORT'] as const
export type TermsKind = (typeof TERMS_KINDS)[number]

/** The version of the default clause sets: a change of their wording is a new number (the evidence names it). */
export const DEFAULT_TERMS_REVISION = 1

/** Whose terms a version prints: a consumer's (IT_B2C, EU_B2C), an export's (EXTRA_EU), else a business's. */
export function termsKindOf(taxMode: PartyTaxMode): TermsKind {
  if (taxMode === 'IT_B2C' || taxMode === 'EU_B2C') return 'CONSUMER'
  if (taxMode === 'EXTRA_EU') return 'EXPORT'
  return 'BUSINESS'
}

/** The id of a default clause set, recorded as the terms version when the company has none of its own. */
export const defaultTermsVersion = (kind: TermsKind): string => `default-${kind.toLowerCase()}-${DEFAULT_TERMS_REVISION}`

/**
 * Days the deposit is due after the acceptance when the quote's payment terms name none (the design's "due N days after
 * acceptance"); B-W2a-19: terms with an order instalment give its days (sales/terms depositDueDaysOf).
 */
export const DEPOSIT_DUE_DAYS = 7

export interface TermsInput {
  readonly language: DocumentLanguage
  readonly taxMode: PartyTaxMode
  readonly currency: CurrencyCode
  readonly validUntil: BusinessDate
  readonly firmOffer: boolean
  readonly promiseDate: BusinessDate | null
  readonly deposit: { readonly pct: string; readonly kind: DepositKind; readonly amount: MinorUnits } | null
  readonly noWithdrawal: boolean
  readonly termsText: string | null
  readonly termsVersion: string | null
  /** B-W2a-19: the days the deposit is due after the acceptance (the payment terms' order instalment); default DEPOSIT_DUE_DAYS. */
  readonly depositDueDays?: number | undefined
}

export const CLAUSE_CODES = ['PRICES', 'VALIDITY', 'DELIVERY', 'DEPOSIT', 'CAPARRA_BOTH_WAYS', 'NO_WITHDRAWAL', 'DUTIES', 'ACCEPTANCE', 'TERMS'] as const
export type ClauseCode = (typeof CLAUSE_CODES)[number]

export interface Clause {
  readonly code: ClauseCode
  readonly text: string
}

export interface QuoteTerms {
  readonly kind: TermsKind
  /** What the acceptance records: the version's own terms version, else the default set's id. */
  readonly termsVersion: string
  readonly clauses: readonly Clause[]
}

const WORDS = {
  it: {
    pricesConsumer: 'Prezzi IVA inclusa (Codice del Consumo, art. 49).',
    pricesBusiness: "Prezzi al netto dell'IVA.",
    validity: (date: string) => `Offerta valida fino al ${date}.`,
    firm: (date: string) => `Offerta irrevocabile: ci impegniamo a mantenerla ferma fino al ${date} (art. 1329 c.c.).`,
    delivery: (date: string) => `Consegna prevista entro il ${date}.`,
    acconto: (pct: string, amount: string, days: number) => `Acconto all'accettazione: ${pct} del totale, ${amount}, da versare con bonifico bancario ${days === 0 ? "il giorno dell'accettazione" : `entro ${days} giorni dall'accettazione`}.`,
    caparra: (pct: string, amount: string, days: number) =>
      `Caparra confirmatoria (art. 1385 c.c.) all'accettazione: ${pct} del totale, ${amount}, da versare con bonifico bancario ${days === 0 ? "il giorno dell'accettazione" : `entro ${days} giorni dall'accettazione`}.`,
    caparraBothWays:
      "Caparra confirmatoria ai sensi dell'art. 1385 c.c.: in caso di recesso ingiustificato del cliente la caparra è trattenuta; in caso di inadempimento del venditore, il cliente ha diritto al doppio della caparra.",
    noWithdrawal: 'Diritto di recesso escluso ai sensi dell\'art. 59, c. 1, lett. c) del D.Lgs. 206/2005: beni confezionati su misura.',
    duties: 'Dazi, imposte e oneri doganali del paese di destinazione esclusi.',
    acceptance: "Per accettare l'offerta apra il link personale ricevuto per e-mail e digiti nome e cognome, oppure ci restituisca una copia firmata.",
    terms: (version: string) => `Condizioni generali di vendita (versione ${version}):`,
  },
  en: {
    pricesConsumer: 'Prices include VAT (Italian Consumer Code, art. 49).',
    pricesBusiness: 'Prices exclude VAT.',
    validity: (date: string) => `Offer valid until ${date}.`,
    firm: (date: string) => `Firm offer: we will not withdraw it before ${date} (Italian Civil Code, art. 1329).`,
    delivery: (date: string) => `Expected delivery by ${date}.`,
    acconto: (pct: string, amount: string, days: number) => `Advance payment (acconto) at acceptance: ${pct} of the total, ${amount}, by bank transfer ${days === 0 ? 'on the day of acceptance' : `within ${days} days of acceptance`}.`,
    caparra: (pct: string, amount: string, days: number) =>
      `Confirmatory deposit (caparra confirmatoria, Italian Civil Code art. 1385) at acceptance: ${pct} of the total, ${amount}, by bank transfer ${days === 0 ? 'on the day of acceptance' : `within ${days} days of acceptance`}.`,
    caparraBothWays:
      'Confirmatory deposit under art. 1385 of the Italian Civil Code: if the customer withdraws without cause, the deposit is kept; if the seller defaults, the customer is entitled to twice the deposit.',
    noWithdrawal: 'No right of withdrawal: the goods are made to the consumer\'s specifications (Italian Consumer Code, art. 59(1)(c)).',
    duties: 'Duties, taxes and customs charges of the country of destination are not included.',
    acceptance: 'To accept the offer, open the personal link in our e-mail and type your full name, or return a signed copy.',
    terms: (version: string) => `General terms of sale (version ${version}):`,
  },
} as const

/** The clauses a version prints and the terms version its acceptance records (see the module comment). */
export function quoteTerms(input: TermsInput): QuoteTerms {
  const words = WORDS[input.language]
  const kind = termsKindOf(input.taxMode)
  const clauses: Clause[] = []
  const add = (code: ClauseCode, text: string) => clauses.push({ code, text })
  add('PRICES', kind === 'CONSUMER' ? words.pricesConsumer : words.pricesBusiness)
  const until = formatDate(input.validUntil, input.language)
  add('VALIDITY', input.firmOffer ? words.firm(until) : words.validity(until))
  if (input.promiseDate) add('DELIVERY', words.delivery(formatDate(input.promiseDate, input.language)))
  if (input.deposit && input.deposit.amount > 0) {
    const pct = formatPercent(input.deposit.pct, input.language)
    const amount = formatMoney(input.deposit.amount, input.currency, input.language)
    const days = input.depositDueDays ?? DEPOSIT_DUE_DAYS
    add('DEPOSIT', input.deposit.kind === 'CAPARRA' ? words.caparra(pct, amount, days) : words.acconto(pct, amount, days))
    if (input.deposit.kind === 'CAPARRA' && kind === 'CONSUMER') add('CAPARRA_BOTH_WAYS', words.caparraBothWays)
  }
  if (input.noWithdrawal && kind === 'CONSUMER') add('NO_WITHDRAWAL', words.noWithdrawal)
  if (kind === 'EXPORT') add('DUTIES', words.duties)
  add('ACCEPTANCE', words.acceptance)
  const own = input.termsText?.trim() ? input.termsText.trim() : null
  const termsVersion = input.termsVersion?.trim() ? input.termsVersion.trim() : defaultTermsVersion(kind)
  if (own) add('TERMS', `${words.terms(termsVersion)}\n${own}`)
  return { kind, termsVersion, clauses }
}

/** The clauses as one text block (the PDF's notes). */
export const clausesText = (terms: QuoteTerms): string => terms.clauses.map((clause) => clause.text).join('\n')

/**
 * The link page's retention notice (GDPR art. 13; ported from the old app's RETENTION_NOTICE): what the acceptance keeps
 * and for how long. The company's privacy notice is linked beside it (GAP-005).
 */
export const ACCEPTANCE_RETENTION_NOTICE: Readonly<Record<DocumentLanguage, string>> = Object.freeze({
  it: "Conserviamo i dati dell'accettazione (data e ora, nome digitato, esito della verifica dell'e-mail, indirizzo IP in forma cifrata, browser) per 10 anni ai sensi dell'art. 2220 c.c., a fini di prova del contratto.",
  en: 'We keep the acceptance data (date and time, the name typed, the e-mail check, the IP address in hashed form, the browser) for 10 years (Italian Civil Code art. 2220), as evidence of the contract.',
})

import type { ApprovalField, Facts, PreviewChange, Words } from '../../approvals/rules'
import { fromMinorUnits, isCurrencyCode, type MinorUnits } from '../../core/money'

/**
 * Credit limits (B-W2b-304; SAL-148, SAL-237, SAL-241, SAL-244; design finance.receivables sec:credit): the pure rules of a
 * customer's credit with one of our companies. apps/factory-api's modules/sales/credit reads the facts and writes one
 * CreditCheck row per check (factory-db sales-orders-depth.prisma, append-only); this file says what a check sees and
 * what it answers.
 *
 *   exposure   what the customer owes or will owe the company: the open orders not yet invoiced + the invoices not yet
 *              paid (the overdue part of them apart) + what is checked when it is not one of those yet (a quote being
 *              sent, an order being made). "Used" is the same without the subject.
 *   limit      the live PartyCompanyTerms row's creditLimitAmount (B-W2b-279/-290), in its currency; none: no check at
 *              all, as before (the plan: "No limit set means no check, as today").
 *   findings   OVER_LIMIT (exposure above the limit), OVERDUE (an invoice past its due date), ON_HOLD (a CREDIT account
 *              hold in force, B-W2b-290's PartyHold). None: PASS.
 *   result     PASS, or with a finding WARN (shown, let through) or HOLD (the step waits for a yes). HOLD only where the
 *              company says so: its CREDIT_OVERRIDE approval rules (Admin › Approvals, automation & AI) switched on, in
 *              force, whose condition holds on the check's facts; none, as on every tenant until the Owner sets one: WARN.
 *              The quote never holds (it shows the reading; the order holds).
 *   override   a CREDIT_OVERRIDE request for a yes about the HOLD check (platform/approvals); its yes adds a new check that
 *              names the HOLD and the request, and the held step goes on. Nobody approves their own request.
 *
 * Money: every amount is the price grain (minor units of the limit's currency). The words of a check name what it found,
 * never an amount (the amounts are the grained columns).
 */

export const CREDIT_STEPS = ['QUOTE', 'ORDER', 'RELEASE', 'SHIPMENT', 'PORTAL', 'API'] as const
export type CreditStep = (typeof CREDIT_STEPS)[number]

export const CREDIT_RESULTS = ['PASS', 'WARN', 'HOLD'] as const
export type CreditResult = (typeof CREDIT_RESULTS)[number]

export const CREDIT_FINDINGS = ['OVER_LIMIT', 'OVERDUE', 'ON_HOLD'] as const
export type CreditFinding = (typeof CREDIT_FINDINGS)[number]

/** The steps whose check may hold: the quote only shows the reading. */
export const HOLDING_STEPS: readonly CreditStep[] = Object.freeze(['ORDER', 'RELEASE', 'SHIPMENT', 'PORTAL', 'API'])

/** The steps whose subject is a new order (counted as the check's subject, not as an open order). */
export const ORDER_STEPS: readonly CreditStep[] = Object.freeze(['ORDER', 'PORTAL', 'API'])

/** The record types a check of each step names (the …_sales_orders_depth_w2b_guards trigger holds the same). */
export const STEP_RECORDS: Readonly<Record<CreditStep, readonly string[]>> = Object.freeze({
  QUOTE: ['QuoteVersion'],
  ORDER: ['SalesOrder'],
  RELEASE: ['WorkOrder'],
  SHIPMENT: ['Shipment'],
  PORTAL: ['PortalOrderRequest', 'SalesOrder'],
  API: ['SalesOrder'],
})

/** The order statuses whose amount not yet invoiced is exposure (a cancelled or closed order is not). */
export const OPEN_ORDER_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'] as const

/** The database's limit on a check's words. */
export const CREDIT_LIMITS = Object.freeze({ words: 500, note: 4000, maxLimit: 2_147_483_647 })

/** What one check saw (minor units of `currency`, every amount 0 or more). */
export interface CreditReading {
  readonly currency: string
  readonly openOrders: MinorUnits
  readonly openInvoices: MinorUnits
  /** The part of the open invoices past its due date (at most openInvoices). */
  readonly overdue: MinorUnits
  /** What is checked when it is not counted yet (a quote, a new order); 0 otherwise. */
  readonly subject: MinorUnits
  /** null: no limit (no check). */
  readonly limit: MinorUnits | null
  readonly onHold: boolean
}

export const exposureOf = (reading: Pick<CreditReading, 'openOrders' | 'openInvoices' | 'subject'>): MinorUnits => reading.openOrders + reading.openInvoices + reading.subject

/** Used: open orders + open invoices (the subject left out): Finance › Receivables › Credit limits. */
export const usedOf = (reading: Pick<CreditReading, 'openOrders' | 'openInvoices'>): MinorUnits => reading.openOrders + reading.openInvoices

/** Still available under the limit (below 0: over it); null without a limit. */
export const availableOf = (reading: Pick<CreditReading, 'openOrders' | 'openInvoices' | 'limit'>): MinorUnits | null => (reading.limit === null ? null : reading.limit - usedOf(reading))

/** How far the exposure goes over the limit (0 within it or without one). */
export const overLimitBy = (reading: CreditReading): MinorUnits => (reading.limit === null ? 0 : Math.max(0, exposureOf(reading) - reading.limit))

/** The share of the limit used, in whole percent (rounded down); a limit of 0 with anything used is 100; null without a limit. */
export function usedPercent(reading: Pick<CreditReading, 'openOrders' | 'openInvoices' | 'limit'>): number | null {
  if (reading.limit === null) return null
  const used = usedOf(reading)
  if (reading.limit === 0) return used > 0 ? 100 : 0
  return Math.floor((used * 100) / reading.limit)
}

/** What the check found, in this order. */
export function findingsOf(reading: CreditReading): CreditFinding[] {
  const found: CreditFinding[] = []
  if (reading.limit !== null && exposureOf(reading) > reading.limit) found.push('OVER_LIMIT')
  if (reading.overdue > 0) found.push('OVERDUE')
  if (reading.onHold) found.push('ON_HOLD')
  return found
}

/**
 * The result: PASS with nothing found; otherwise HOLD when the step may hold and the company's rules ask a yes
 * (`rulesHold`), else WARN. The database holds the same shape (PASS only within the limit and not on hold).
 */
export function creditResult(reading: CreditReading, step: CreditStep, rulesHold: boolean): CreditResult {
  if (findingsOf(reading).length === 0) return 'PASS'
  return rulesHold && HOLDING_STEPS.includes(step) ? 'HOLD' : 'WARN'
}

/** The result of an override's own check (what it sees at the yes): PASS when nothing is found any more, else WARN (let through). */
export const overrideResult = (reading: CreditReading): CreditResult => (findingsOf(reading).length === 0 ? 'PASS' : 'WARN')

export const STEP_WORDS: Readonly<Record<CreditStep, Words>> = Object.freeze({
  QUOTE: { en: 'the quote', it: 'il preventivo' },
  ORDER: { en: 'the order', it: "l'ordine" },
  RELEASE: { en: "the work order's release", it: "il rilascio dell'ordine di lavoro" },
  SHIPMENT: { en: 'the shipment', it: 'la spedizione' },
  PORTAL: { en: 'an order from the portal', it: 'un ordine dal portale' },
  API: { en: 'an order through the API', it: "un ordine tramite l'API" },
})

export const FINDING_WORDS: Readonly<Record<CreditFinding, Words>> = Object.freeze({
  OVER_LIMIT: { en: 'over the credit limit', it: 'oltre il fido' },
  OVERDUE: { en: 'invoices overdue', it: 'fatture scadute' },
  ON_HOLD: { en: 'on credit hold', it: 'bloccato per fido' },
})

export const RESULT_WORDS: Readonly<Record<CreditResult, Words>> = Object.freeze({
  PASS: { en: 'Within the credit limit', it: 'Entro il fido' },
  WARN: { en: 'Shown and let through', it: 'Segnalato e lasciato passare' },
  HOLD: { en: 'Held until a yes', it: 'Fermo fino a un sì' },
})

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * A check's words, one line without an amount: "Over the credit limit · invoices overdue: held until a yes." An override:
 * "Let through with a yes: over the credit limit."
 */
export function checkWords(findings: readonly CreditFinding[], result: CreditResult, locale: 'en' | 'it' = 'en', override = false): string {
  const found = findings.map((finding) => FINDING_WORDS[finding][locale]).join(' · ')
  if (override) return found ? `${locale === 'en' ? 'Let through with a yes' : 'Lasciato passare con un sì'}: ${found}.` : `${RESULT_WORDS.PASS[locale]}.`
  if (result === 'PASS') return `${RESULT_WORDS.PASS[locale]}.`
  const tail = result === 'HOLD' ? (locale === 'en' ? 'held until a yes' : 'fermo fino a un sì') : locale === 'en' ? 'shown and let through' : 'segnalato e lasciato passare'
  return `${capital(found)}: ${tail}.`.slice(0, CREDIT_LIMITS.words)
}

/** A step held for credit, in words (the 409 of a release or a shipment, the order's notice). */
export function heldWords(label: string, findings: readonly CreditFinding[], asked: 'ASKED' | 'TO_ASK', locale: 'en' | 'it' = 'en'): string {
  const found = findings.map((finding) => FINDING_WORDS[finding][locale]).join(' · ') || FINDING_WORDS.OVER_LIMIT[locale]
  if (locale === 'it') return asked === 'ASKED' ? `${label} è fermo per il fido (${found}): attende il sì richiesto.` : `${label} è fermo per il fido (${found}): chiedi un sì, o controlla di nuovo dopo un pagamento.`
  return asked === 'ASKED' ? `${label} is held for credit (${found}): it waits for the yes that was asked.` : `${label} is held for credit (${found}): ask for a yes, or check again after a payment.`
}

// ---- the approval kind's facts (CREDIT_OVERRIDE; platform/approvals/kinds/credit-override.ts) --------------------------

const major = (amount: MinorUnits, currency: string): string | null => (isCurrencyCode(currency) ? fromMinorUnits(amount, currency).toFixed() : null)

/**
 * The facts a CREDIT_OVERRIDE rule may test (the RuleBuilder's fields). `overLimit` is the seeded rule's fact ("Orders over
 * the credit limit": overLimit is true). Money facts carry the price grain: their value, and a rule's threshold on them,
 * only with it.
 */
export const CREDIT_OVERRIDE_FIELDS: readonly ApprovalField[] = Object.freeze([
  { id: 'step', label: { en: 'step', it: 'passaggio' }, kind: 'choice', options: CREDIT_STEPS.map((step) => ({ value: step, label: { en: capital(STEP_WORDS[step].en), it: capital(STEP_WORDS[step].it) } })) },
  { id: 'overLimit', label: { en: 'over the credit limit', it: 'oltre il fido' }, kind: 'yesNo' },
  { id: 'overLimitBy', label: { en: 'over the limit by', it: 'oltre il fido di' }, kind: 'number', grain: 'price', min: 0 },
  { id: 'exposure', label: { en: 'exposure', it: 'esposizione' }, kind: 'number', grain: 'price', min: 0 },
  { id: 'limit', label: { en: 'credit limit', it: 'fido' }, kind: 'number', grain: 'price', min: 0 },
  { id: 'hasOverdue', label: { en: 'invoices overdue', it: 'fatture scadute' }, kind: 'yesNo' },
  { id: 'overdue', label: { en: 'overdue amount', it: 'importo scaduto' }, kind: 'number', grain: 'price', min: 0 },
  { id: 'onHold', label: { en: 'on credit hold', it: 'bloccato per fido' }, kind: 'yesNo' },
  { id: 'currency', label: { en: 'currency', it: 'valuta' }, kind: 'text' },
  { id: 'customerCode', label: { en: 'customer code', it: 'codice cliente' }, kind: 'text' },
])

/** The facts of a reading for the rules (money as decimal text in the currency's units). */
export function creditFacts(reading: CreditReading, step: CreditStep, customerCode: string | null): Facts {
  return {
    step,
    overLimit: reading.limit !== null && exposureOf(reading) > reading.limit,
    overLimitBy: major(overLimitBy(reading), reading.currency),
    exposure: major(exposureOf(reading), reading.currency),
    limit: reading.limit === null ? null : major(reading.limit, reading.currency),
    hasOverdue: reading.overdue > 0,
    overdue: major(reading.overdue, reading.currency),
    onHold: reading.onHold,
    currency: reading.currency,
    customerCode,
  }
}

/** The change a CREDIT_OVERRIDE request shows: the hold lifted (no money). */
export const OVERRIDE_CHANGES: readonly PreviewChange[] = Object.freeze([{ field: 'creditHold', from: true, to: false, grain: null }])

// ---- a limit typed by Finance --------------------------------------------------------------------------------------------

/** A limit the office types: minor units, 0 to the largest Int, with a currency of three capitals; null clears it. */
export function limitProblems(input: { readonly amount: number | null; readonly currency: string | null }): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  if (input.amount === null) return problems
  if (!Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > CREDIT_LIMITS.maxLimit) problems.push({ path: 'amount', message: 'A credit limit is 0 or more, in the currency\'s smallest units.' })
  if (input.currency === null || !/^[A-Z]{3}$/.test(input.currency)) problems.push({ path: 'currency', message: 'A credit limit names its currency (three capitals, ISO 4217).' })
  return problems
}

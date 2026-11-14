import type { BusinessDate } from '../../core/time'
import { isEuMemberState } from '../../tax/eu'
import { formatDateIt } from '../fatturapa/format'

/**
 * Self-invoices for foreign purchases (B-W2b-401; FIN-095; design finance.payables "Self-invoices": purchase, kind (TD17
 * services from abroad · TD18 goods from the EU · TD19 goods already in Italy), deadline, status; factory-db tax.prisma
 * SelfInvoice). When a company buys from a supplier without an Italian VAT number, Italy asks the company to account for the
 * VAT itself: it sends SDI an integration document of the purchase (art. 17 c.2 DPR 633/1972; art. 46-47 DL 331/1993 for EU
 * goods), an Invoice of type TD17, TD18 or TD19 whose buyer is the supplier, numbered from the company's SELF_INVOICE series.
 * Pure: which kind fits, the deadline, what stops one, its lines from the supplier's invoice.
 *
 * GATE-ACCOUNTANT (lead decision 11-14): self-invoices, debit notes and the time limit on VAT decreases are this step's three
 * rules, all behind the company's switch `selfInvoicesOn` (OFF by default; the schema has one column for the step: each rule
 * its own column is a schema need). While off a self-invoice and a debit note are drafted but never issued, and the VAT
 * time limit is not judged. Every rule below is UNVERIFIED until the accountant confirms it.
 */

export const SELF_INVOICE_KINDS = ['TD17', 'TD18', 'TD19'] as const
export type SelfInvoiceKind = (typeof SELF_INVOICE_KINDS)[number]

/** Every self-invoice document type, TD16 (an internal reverse charge, not built here) included: never a customer document. */
export const SELF_INVOICE_DOC_TYPES = ['TD16', 'TD17', 'TD18', 'TD19'] as const
export const isSelfInvoiceDocType = (docType: string): boolean => (SELF_INVOICE_DOC_TYPES as readonly string[]).includes(docType)

export const SELF_INVOICE_STATUSES = ['PENDING', 'ISSUED', 'CANCELLED'] as const
export type SelfInvoiceStatus = (typeof SELF_INVOICE_STATUSES)[number]

export const KIND_WORDS: Readonly<Record<SelfInvoiceKind, string>> = Object.freeze({
  TD17: 'TD17 services from abroad',
  TD18: 'TD18 goods from the EU',
  TD19: 'TD19 goods already in Italy',
})

// ---- the step's switch: three rules behind `selfInvoicesOn` -------------------------------------------------------------

export const DEPTH_RULES = ['SELF_INVOICES', 'DEBIT_NOTES', 'VAT_DECREASE_LIMIT'] as const
export type DepthRule = (typeof DEPTH_RULES)[number]

const RULE_WORDS: Readonly<Record<DepthRule, { readonly on: string; readonly off: string }>> = Object.freeze({
  SELF_INVOICES: {
    on: 'Self-invoices TD17, TD18 and TD19 are issued from the self-invoice series and sent to SDI by their deadline (rules UNVERIFIED).',
    off: 'Waits for the accountant: self-invoices are listed with their deadline and drafted, but none is issued yet.',
  },
  DEBIT_NOTES: {
    on: 'Debit notes TD05 are issued for charges added after an invoice (rules UNVERIFIED).',
    off: 'Waits for the accountant: debit notes are drafted, but none is issued yet.',
  },
  VAT_DECREASE_LIMIT: {
    on: 'A credit note that lowers VAT by a later agreement says when it is beyond the one-year limit (rule UNVERIFIED).',
    off: 'Waits for the accountant: the time limit on VAT decreases is not judged yet.',
  },
})

/** The three rules' words now: what each does, or what waits (one switch for the three). */
export const depthRuleWords = (on: boolean): Record<DepthRule, string> => Object.fromEntries(DEPTH_RULES.map((rule) => [rule, on ? RULE_WORDS[rule].on : RULE_WORDS[rule].off])) as Record<DepthRule, string>

/** What waits while the switch is off (null when on), for one rule. */
export const waitsWords = (on: boolean, rule: DepthRule): string | null => (on ? null : RULE_WORDS[rule].off)

// ---- which kind, the deadline ---------------------------------------------------------------------------------------------

export interface SupplierFacts {
  /** The supplier's tax country (its tax identity's, else its record's). */
  readonly country: string
  readonly lineKinds: readonly string[]
}

/**
 * The kind a purchase suggests (the office confirms it): services from any foreign supplier TD17; goods from an EU supplier
 * TD18; goods from outside the EU come through customs (the customs bill, not a self-invoice) unless they were already in
 * Italy, which only the office knows (TD19). Null: no suggestion. UNVERIFIED.
 */
export function suggestedKind(facts: SupplierFacts): { readonly kind: SelfInvoiceKind | null; readonly why: string } {
  const country = facts.country.toUpperCase()
  if (country === 'IT') return { kind: null, why: 'The supplier is Italian: no self-invoice (an internal reverse charge, TD16, stays with the accountant).' }
  const goods = facts.lineKinds.filter((kind) => kind === 'GOODS' || kind === 'CHARGE').length
  const services = facts.lineKinds.filter((kind) => kind === 'SERVICE' || kind === 'SUBCONTRACT').length
  if (services > 0 && goods === 0) return { kind: 'TD17', why: 'Services bought from a supplier abroad: TD17.' }
  if (goods > 0 && services === 0 && isEuMemberState(country)) return { kind: 'TD18', why: 'Goods bought from a supplier in another EU state: TD18.' }
  if (goods > 0 && services === 0) return { kind: null, why: 'Goods from outside the EU come through customs (the customs bill); TD19 only when they were already in Italy.' }
  return { kind: null, why: 'Goods and services together: pick the kind with your accountant.' }
}

/** The deadline (UNVERIFIED): the 15th of the month after the month the invoice was received (art. 17 c.2; art. 47 DL 331/1993). */
export function selfInvoiceDeadline(receivedOn: BusinessDate): BusinessDate {
  const year = Number.parseInt(receivedOn.slice(0, 4), 10)
  const month = Number.parseInt(receivedOn.slice(5, 7), 10)
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  return `${next.year}-${String(next.month).padStart(2, '0')}-15`
}

export const DEADLINE_STATES = ['OPEN', 'DUE_SOON', 'LATE', 'DONE'] as const
export type DeadlineStateCode = (typeof DEADLINE_STATES)[number]

const dayNumber = (day: BusinessDate): number => Math.round(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000)

/** Where a self-invoice stands against its deadline: done, late, due within 5 days, or open. */
export function deadlineStateOf(deadline: BusinessDate, today: BusinessDate, status: SelfInvoiceStatus): { readonly state: DeadlineStateCode; readonly daysLeft: number; readonly words: string } {
  const daysLeft = dayNumber(deadline) - dayNumber(today)
  if (status !== 'PENDING') return { state: 'DONE', daysLeft, words: status === 'ISSUED' ? 'Issued.' : 'Cancelled.' }
  if (daysLeft < 0) return { state: 'LATE', daysLeft, words: `Late: the deadline was ${deadline} (${-daysLeft} day(s) ago). Issue it now and tell your accountant.` }
  if (daysLeft <= 5) return { state: 'DUE_SOON', daysLeft, words: `Due by ${deadline}: ${daysLeft} day(s) left.` }
  return { state: 'OPEN', daysLeft, words: `Due by ${deadline}.` }
}

// ---- what stops one ---------------------------------------------------------------------------------------------------------

export const SELF_INVOICE_REFUSALS = ['VOIDED', 'CREDIT_NOTE', 'ITALIAN_SUPPLIER', 'TD18_NOT_EU', 'ALREADY', 'NO_AMOUNT'] as const
export type SelfInvoiceRefusal = (typeof SELF_INVOICE_REFUSALS)[number]

const REFUSAL_WORDS: Readonly<Record<SelfInvoiceRefusal, string>> = Object.freeze({
  VOIDED: 'The supplier invoice is voided: no self-invoice.',
  CREDIT_NOTE: "The supplier's document is a credit note: its self-invoice correction stays with the accountant (not built).",
  ITALIAN_SUPPLIER: 'The supplier is Italian: no self-invoice (an internal reverse charge, TD16, stays with the accountant).',
  TD18_NOT_EU: 'TD18 is for goods from another EU state: this supplier is outside the EU (TD17 for services, TD19 for goods already in Italy).',
  ALREADY: 'This supplier invoice has its self-invoice already.',
  NO_AMOUNT: 'The supplier invoice has no taxable amount to integrate.',
})

export const refusalWords = (code: SelfInvoiceRefusal): string => REFUSAL_WORDS[code]

/** What stops a self-invoice of this kind for this supplier invoice (empty: it may be made). */
export function selfInvoiceProblems(input: { readonly status: string; readonly kind: string; readonly country: string; readonly netTotal: number; readonly live: boolean; readonly selfKind: SelfInvoiceKind }): SelfInvoiceRefusal[] {
  const problems: SelfInvoiceRefusal[] = []
  if (input.status === 'VOIDED') problems.push('VOIDED')
  if (input.kind === 'CREDIT_NOTE') problems.push('CREDIT_NOTE')
  if (input.country.toUpperCase() === 'IT') problems.push('ITALIAN_SUPPLIER')
  else if (input.selfKind === 'TD18' && !isEuMemberState(input.country.toUpperCase())) problems.push('TD18_NOT_EU')
  if (input.live) problems.push('ALREADY')
  if (input.netTotal <= 0) problems.push('NO_AMOUNT')
  return problems
}

// ---- its lines -------------------------------------------------------------------------------------------------------------

/** The standard rate the integration takes when the office names none (UNVERIFIED: the goods' or the service's own rate). */
export const DEFAULT_INTEGRATION_RATE = '22'

export interface SupplierLineFacts {
  readonly description: string
  /** Net, minor units of the invoice's currency (negative on a discount line). */
  readonly netAmount: number
}

/**
 * The self-invoice's lines, in euro (minor units): one per supplier line when every line is above 0 (at most 100), else one
 * line for the whole taxable amount; each at the Italian rate given. `toEuro` converts minor units of the supplier's currency.
 */
export function integrationLines(lines: readonly SupplierLineFacts[], netTotal: number, reference: string, toEuro: (minor: number) => number): { readonly description: string; readonly netEur: number }[] {
  const perLine = lines.length > 0 && lines.length <= 100 && lines.every((line) => line.netAmount > 0)
  if (perLine) return lines.map((line) => ({ description: line.description.slice(0, 1000), netEur: toEuro(line.netAmount) }))
  return [{ description: `Integrazione IVA ${reference}`.slice(0, 1000), netEur: toEuro(netTotal) }]
}

/** The Causale of a self-invoice: what it integrates (the supplier's invoice). */
export const selfInvoiceCausale = (kind: SelfInvoiceKind, supplierNumber: string, supplierDate: BusinessDate, supplierName: string): string =>
  `${kind === 'TD17' ? "Integrazione/autofattura per acquisto servizi dall'estero" : kind === 'TD18' ? 'Integrazione per acquisto di beni intracomunitari' : 'Integrazione/autofattura per acquisto beni ex art. 17 c.2 DPR 633/1972'} - fattura n. ${supplierNumber} del ${formatDateIt(supplierDate)} di ${supplierName}`.slice(0, 2000)

export const SELF_INVOICE_RULE = Object.freeze({
  status: 'UNVERIFIED' as const,
  words:
    'Self-invoices are suggested by the supplier’s country and its lines, due by the 15th of the month after the invoice was received, with the Italian rate 22 % unless the office names another, and the supplier’s amounts converted to euro at the rate of its invoice date: the accountant confirms each before the switch goes on.',
})

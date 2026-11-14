import { fromMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { PriceBasis } from '../../tax/vat-summary'
import { nonTaxable } from '../../tax/vat-treatment'
import { amountText, computeInvoiceTotals, type CoreLine, type InvoiceDocType } from '../invoices'

/**
 * Stamp duty on VAT-free invoices (B-W2b-392; FIN-101; DPR 642/1972 Tariffa parte I art. 13, Tabella allegato B; DM
 * 17.6.2014 art. 6), pure. W1's rule stays (factory-domain tax/stamp-duty stampDutyFor: 2.00 euro when the amounts
 * without VAT exceed 77.47 euro, exports N3.1, intra-EU supplies N3.2 and reverse charges N6.x exempt; which Natura codes
 * are exempt is UNVERIFIED and a setting). This step adds:
 *
 *   - the charge to the customer (Owner 11-13; the accountant confirms before the switch goes on): an invoice line of kind
 *     CHARGE, chargeKind STAMP_DUTY, one unit at the stamp duty's amount, rate 0, Natura N1 (escluso art. 15 DPR 633/1972),
 *     in euro, one per invoice, on the types that bill goods or services (TD01, TD24, TD05). A credit note (TD04) and a
 *     deposit invoice (TD02: its total is the money received) carry their own stamp duty (W1's rule) but charge none
 *     (UNVERIFIED). The line is decided again whenever a draft is saved, from its other lines; nobody types it;
 *   - the quarter's total for payment: the invoices of a calendar quarter that carry stamp duty and their total, the day
 *     it is due and its F24 tax code (UNVERIFIED), then paid (after the quarter ended), frozen.
 *
 * GATE-ACCOUNTANT: the line and the quarter's writes run only while the company's stamp duty switch is on
 * (CompanyEInvoiceSettings.stampDutyOn, OFF by default; the …_tax_currency_w2b_guards refuse the line too).
 */

/** The types that charge the stamp duty to the customer. */
export const STAMP_DUTY_CHARGED_TYPES = ['TD01', 'TD24', 'TD05'] as const satisfies readonly InvoiceDocType[]
/** The line's text (Descrizione), Italian as the invoice. */
export const STAMP_DUTY_LINE_TEXT = 'Imposta di bollo assolta in modo virtuale (DM 17.6.2014)'
export const STAMP_DUTY_NATURA = 'N1'
/** The law the line cites when the company's tax codes give none (RiferimentoNormativo). */
export const STAMP_DUTY_LEGAL_REF = 'Art. 15 DPR 633/1972'
/** Below this year's running total the first quarters may be paid later (DL 73/2022 art. 3; UNVERIFIED): 5,000 euro. */
export const QUARTER_DEFER_LIMIT: MinorUnits = 500_000

export const STAMP_DUTY_REASONS = ['DUE', 'NOT_DUE', 'SWITCH_OFF', 'NOT_CHARGED_ON_TYPE', 'NOT_EURO'] as const
export type StampDutyReason = (typeof STAMP_DUTY_REASONS)[number]

export interface StampDutyDecision {
  /** The stamp duty the invoice carries (W1's rule on the lines without the charge), or null. */
  readonly amount: MinorUnits | null
  /** Whether a STAMP_DUTY line charges it to the customer. */
  readonly charge: boolean
  readonly reason: StampDutyReason
}

const isCharged = (docType: string): boolean => (STAMP_DUTY_CHARGED_TYPES as readonly string[]).includes(docType)

/**
 * Whether the stamp duty is due on a draft and charged to the customer, from its lines without any STAMP_DUTY line (the
 * charge never decides itself: an N1 line would count towards the threshold).
 */
export function decideStampDuty(input: { readonly docType: string; readonly currency: string; readonly basis: PriceBasis; readonly lines: readonly CoreLine[]; readonly switchOn: boolean }): StampDutyDecision {
  const amount = input.lines.length === 0 ? null : computeInvoiceTotals(input.lines, input.basis, input.currency).stampDutyAmount
  if (amount === null) return { amount, charge: false, reason: 'NOT_DUE' }
  if (!input.switchOn) return { amount, charge: false, reason: 'SWITCH_OFF' }
  if (!isCharged(input.docType)) return { amount, charge: false, reason: 'NOT_CHARGED_ON_TYPE' }
  if (input.currency !== 'EUR') return { amount, charge: false, reason: 'NOT_EURO' }
  return { amount, charge: true, reason: 'DUE' }
}

/** The STAMP_DUTY line of `amount` (minor units of euro) as the core computes it. */
export function stampDutyLine(amount: MinorUnits, legalRef: string | null): CoreLine {
  return {
    kind: 'CHARGE',
    description: STAMP_DUTY_LINE_TEXT,
    itemCode: null,
    quantity: '1',
    uom: null,
    unitPrice: fromMinorUnits(amount, 'EUR').toFixed(2),
    discountPct: null,
    vat: nonTaxable(STAMP_DUTY_NATURA, legalRef ?? STAMP_DUTY_LEGAL_REF),
  }
}

/** The decision in words, for the invoice's tax view and the pre-check. */
export function stampDutyWords(decision: StampDutyDecision): string {
  const amount = decision.amount === null ? '' : amountText(decision.amount, 'EUR')
  switch (decision.reason) {
    case 'NOT_DUE':
      return 'No stamp duty: the amounts without VAT that count are 77.47 EUR or less.'
    case 'SWITCH_OFF':
      return `Stamp duty of ${amount} is due and printed on the e-invoice; charging it to the customer waits for the accountant (the company's stamp duty switch is off).`
    case 'NOT_CHARGED_ON_TYPE':
      return `Stamp duty of ${amount} is due and printed on the e-invoice; a credit note or a deposit invoice charges none to the customer.`
    case 'NOT_EURO':
      return `Stamp duty of ${amount} is due; it is charged to the customer only on an invoice in euro.`
    case 'DUE':
      return `Stamp duty of ${amount} is due and charged to the customer as a line.`
  }
}

/**
 * The checks before issue for the stamp duty (code STAMP_DUTY): the line the invoice charges is the one the rule
 * decides now. Saving the draft again decides it.
 */
export function stampDutyIssueProblems(decision: StampDutyDecision, charged: MinorUnits | null): { code: string; path: string; message: string }[] {
  const wanted = decision.charge ? decision.amount : null
  if (charged === wanted) return []
  const message =
    wanted === null
      ? `The invoice charges stamp duty of ${amountText(charged!, 'EUR')} that it no longer charges (${stampDutyWords(decision)}): save the draft again to take the line away.`
      : charged === null
        ? `${stampDutyWords(decision)} The line is not on the invoice yet: save the draft again to add it.`
        : `The invoice charges stamp duty of ${amountText(charged, 'EUR')}; the rule says ${amountText(wanted, 'EUR')}: save the draft again to correct it.`
  return [{ code: 'STAMP_DUTY', path: 'lines/stampDuty', message }]
}

// ---- the quarter ------------------------------------------------------------------------------------------------------

export const QUARTER_STATES = ['OPEN', 'TO_PAY', 'LATE', 'PAID'] as const
export type QuarterState = (typeof QUARTER_STATES)[number]

const pad = (n: number): string => String(n).padStart(2, '0')
const lastDayOf = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** The first day of the calendar quarter of `day`: 1 January, April, July or October. */
export function quarterStartOf(day: BusinessDate): BusinessDate {
  const month = Number.parseInt(day.slice(5, 7), 10)
  return `${day.slice(0, 4)}-${pad(month - ((month - 1) % 3))}-01`
}

/** The quarter's last day. */
export function quarterEndOf(start: BusinessDate): BusinessDate {
  const year = Number.parseInt(start.slice(0, 4), 10)
  const month = Number.parseInt(start.slice(5, 7), 10) + 2
  return `${year}-${pad(month)}-${pad(lastDayOf(year, month))}`
}

/** 1 to 4. */
export const quarterNumberOf = (start: BusinessDate): 1 | 2 | 3 | 4 => (Math.floor((Number.parseInt(start.slice(5, 7), 10) - 1) / 3) + 1) as 1 | 2 | 3 | 4

/** The quarters of a year, first days. */
export const quartersOf = (year: number): BusinessDate[] => [`${year}-01-01`, `${year}-04-01`, `${year}-07-01`, `${year}-10-01`]

/** "Q4 2026". */
export const quarterLabel = (start: BusinessDate): string => `Q${quarterNumberOf(start)} ${start.slice(0, 4)}`

/** The F24 tax code (codice tributo) of each quarter's virtual stamp duty on e-invoices (Ris. AdE 42/E/2019; UNVERIFIED). */
export const F24_CODES: Readonly<Record<1 | 2 | 3 | 4, string>> = Object.freeze({ 1: '2521', 2: '2522', 3: '2523', 4: '2524' })

/**
 * When a quarter's stamp duty is paid (DM 17.6.2014 art. 6 c.2 as amended; DL 73/2022 art. 3; UNVERIFIED, the accountant
 * confirms): Q1 by 31 May, Q2 by 30 September, Q3 by 30 November, Q4 by the end of February of the next year; Q1 below
 * 5,000 euro goes with Q2 (30 September), and Q1 + Q2 below 5,000 euro both by 30 November. `firstHalf`: the year's first
 * two quarters' totals so far (minor units).
 */
export function paymentDueOf(start: BusinessDate, firstHalf: { readonly q1?: MinorUnits; readonly q2?: MinorUnits } = {}): { readonly dueOn: BusinessDate; readonly f24Code: string; readonly deferred: boolean } {
  const year = Number.parseInt(start.slice(0, 4), 10)
  const quarter = quarterNumberOf(start)
  const q1 = firstHalf.q1 ?? 0
  const q2 = firstHalf.q2 ?? 0
  const f24Code = F24_CODES[quarter]
  if (quarter === 4) return { dueOn: `${year + 1}-02-${pad(lastDayOf(year + 1, 2))}`, f24Code, deferred: false }
  if (quarter === 3) return { dueOn: `${year}-11-30`, f24Code, deferred: false }
  if (q1 + q2 < QUARTER_DEFER_LIMIT) return { dueOn: `${year}-11-30`, f24Code, deferred: true }
  if (quarter === 2) return { dueOn: `${year}-09-30`, f24Code, deferred: false }
  return q1 < QUARTER_DEFER_LIMIT ? { dueOn: `${year}-09-30`, f24Code, deferred: true } : { dueOn: `${year}-05-31`, f24Code, deferred: false }
}

/** Where a quarter stands on `today`. */
export function quarterStateOf(start: BusinessDate, paid: boolean, dueOn: BusinessDate, today: BusinessDate): QuarterState {
  if (paid) return 'PAID'
  if (today <= quarterEndOf(start)) return 'OPEN'
  return today > dueOn ? 'LATE' : 'TO_PAY'
}

/** Whether the quarter may be marked paid on `today` (it ended). */
export const quarterEnded = (start: BusinessDate, today: BusinessDate): boolean => today > quarterEndOf(start)

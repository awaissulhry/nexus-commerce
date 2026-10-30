import type { Issue } from '../core/errors'
import type { BusinessDate } from '../core/time'
import type { IntrastatRow, RecordFix } from './intrastat'
import { unplacedOf, vatEntriesOf, type PaymentFacts } from './journals'
import type { AccountingPackage } from './packages'
import { monthLabel, periodEnded, type Period } from './periods'
import type { YearEndCountFacts } from './year-end'

/**
 * The named checks of an accounting export (B-W2a-39; design finance.accounting "2 · Checks": every shipment invoiced ·
 * no invoice rejected at SDI · payments placed · totals equal row sums · placements never exceed payments; "work
 * orders closed" is W2b). Each check passes, or fails with its count, its words and the records that fix it (the
 * design's "Fix links", "Show me"). A failing check does not stop an export: the person explains it in words, and the
 * export keeps how each check stood with its explanation (AccountingExport.checks; the database refuses an EXPORTED
 * batch with a failed check that has no explanation).
 *
 *   PERIOD_ENDED                the month is over (an export of a month still running misses what comes later; a
 *                               re-export brings it)
 *   SHIPMENTS_INVOICED          every DDT of the month's shipped goods is billed by an issued invoice
 *   NO_INVOICE_REJECTED         no invoice of the month is REJECTED by SDI (it counts as never issued until sent again)
 *   PAYMENTS_PLACED             every payment received in the month is placed on what it pays (or refunded)
 *   PLACEMENTS_WITHIN_PAYMENTS  no payment is placed (or refunded) beyond its amount
 *   TOTALS_EQUAL_ROWS           every invoice's totals are the sums of its VAT summary
 *   INTRASTAT_COMPLETE          (Intrastat) every EU sale row has what the file needs
 *   YEAR_END_SIGNED_OFF         (year-end pack) every site's year-end inventory is signed off, none open
 *   STOCK_VALUED                (year-end pack) every stock move up to the year end has its value
 */

export const CHECK_CODES = [
  'PERIOD_ENDED',
  'SHIPMENTS_INVOICED',
  'NO_INVOICE_REJECTED',
  'PAYMENTS_PLACED',
  'PLACEMENTS_WITHIN_PAYMENTS',
  'TOTALS_EQUAL_ROWS',
  'INTRASTAT_COMPLETE',
  'YEAR_END_SIGNED_OFF',
  'STOCK_VALUED',
] as const
export type CheckCode = (typeof CHECK_CODES)[number]

export const CHECK_TITLES: Readonly<Record<CheckCode, { readonly en: string; readonly it: string }>> = Object.freeze({
  PERIOD_ENDED: { en: 'The month is over', it: 'Il mese è chiuso' },
  SHIPMENTS_INVOICED: { en: 'Every shipment invoiced', it: 'Ogni spedizione fatturata' },
  NO_INVOICE_REJECTED: { en: 'No invoice rejected at SDI', it: 'Nessuna fattura scartata dallo SDI' },
  PAYMENTS_PLACED: { en: 'Payments placed', it: 'Incassi abbinati' },
  PLACEMENTS_WITHIN_PAYMENTS: { en: 'Placements never exceed payments', it: 'Abbinamenti entro gli incassi' },
  TOTALS_EQUAL_ROWS: { en: 'Totals equal row sums', it: 'Totali uguali alla somma delle righe' },
  INTRASTAT_COMPLETE: { en: 'Intrastat data complete', it: 'Dati Intrastat completi' },
  YEAR_END_SIGNED_OFF: { en: 'Year-end inventory signed off', it: 'Inventario di fine anno firmato' },
  STOCK_VALUED: { en: 'Every stock move valued', it: 'Ogni movimento di magazzino valorizzato' },
})

/** A record a failing check names (to open and fix). */
export interface CheckFix extends RecordFix {
  readonly number: string | null
}

export interface CheckResult {
  readonly code: CheckCode
  readonly passed: boolean
  /** How many records fail it (0 when passed). */
  readonly count: number
  readonly words: string
  /** The first records that fail it (at most FIX_LIMIT). */
  readonly fixes: readonly CheckFix[]
}

export const FIX_LIMIT = 20
export const MAX_EXPLANATION = 2000

/** The checks an export of these packages carries, in order. */
export function checksFor(packages: readonly AccountingPackage[]): CheckCode[] {
  const wanted = new Set(packages)
  return CHECK_CODES.filter((code) => {
    if (code === 'INTRASTAT_COMPLETE') return wanted.has('INTRASTAT')
    if (code === 'YEAR_END_SIGNED_OFF' || code === 'STOCK_VALUED') return wanted.has('YEAR_END_STOCK')
    return true
  })
}

const result = (code: CheckCode, failing: readonly CheckFix[], passedWords: string, failedWords: (count: number, names: string) => string): CheckResult => {
  const names = failing
    .slice(0, 5)
    .map((fix) => fix.number ?? fix.recordId)
    .join(', ')
  return failing.length === 0
    ? { code, passed: true, count: 0, words: passedWords, fixes: [] }
    : { code, passed: false, count: failing.length, words: failedWords(failing.length, `${names}${failing.length > 5 ? ', …' : ''}`), fixes: failing.slice(0, FIX_LIMIT) }
}

export function periodEndedCheck(period: Period, today: BusinessDate): CheckResult {
  return periodEnded(period, today)
    ? { code: 'PERIOD_ENDED', passed: true, count: 0, words: `${monthLabel(period.month)} is over.`, fixes: [] }
    : {
        code: 'PERIOD_ENDED',
        passed: false,
        count: 1,
        words: `${monthLabel(period.month)} ends on ${period.end}: documents dated after this export reach the accountant in a re-export.`,
        fixes: [],
      }
}

export function shipmentsInvoicedCheck(open: readonly { readonly ddtId: string; readonly number: string }[]): CheckResult {
  return result(
    'SHIPMENTS_INVOICED',
    open.map((ddt) => ({ recordType: 'Ddt', recordId: ddt.ddtId, number: ddt.number, field: null })),
    'Every DDT of the month is billed by an issued invoice.',
    (count, names) => `${count} DDT(s) of the month carry goods no issued invoice bills: ${names}.`,
  )
}

export function rejectedCheck(rejected: readonly { readonly id: string; readonly number: string | null }[]): CheckResult {
  return result(
    'NO_INVOICE_REJECTED',
    rejected.map((invoice) => ({ recordType: 'Invoice', recordId: invoice.id, number: invoice.number, field: null })),
    'No invoice of the month is rejected by SDI.',
    (count, names) => `${count} invoice(s) of the month are rejected by SDI and count as never issued until sent again (corrected, same number and date): ${names}.`,
  )
}

export function paymentsPlacedCheck(payments: readonly Pick<PaymentFacts, 'id' | 'reference' | 'amount' | 'placed' | 'refunded'>[]): CheckResult {
  return result(
    'PAYMENTS_PLACED',
    payments.filter((payment) => unplacedOf(payment) > 0).map((payment) => ({ recordType: 'Payment', recordId: payment.id, number: payment.reference, field: null })),
    'Every payment of the month is placed on what it pays.',
    (count, names) => `${count} payment(s) of the month are not wholly placed on invoices or deposits (a credit balance): ${names}.`,
  )
}

export function placementsCheck(payments: readonly Pick<PaymentFacts, 'id' | 'reference' | 'amount' | 'placed' | 'refunded'>[]): CheckResult {
  return result(
    'PLACEMENTS_WITHIN_PAYMENTS',
    payments.filter((payment) => payment.placed + payment.refunded > payment.amount || payment.placed < 0).map((payment) => ({ recordType: 'Payment', recordId: payment.id, number: payment.reference, field: null })),
    'No payment is placed or refunded beyond its amount.',
    (count, names) => `${count} payment(s) are placed or refunded beyond their amount: ${names}.`,
  )
}

export interface TotalsFacts {
  readonly id: string
  readonly number: string
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly stampDutyAmount: number | null
  readonly vatSummary: unknown
}

/** An invoice's totals are its VAT summary's sums (the gross with or without the stamp duty it names). */
export function totalsAddUp(invoice: TotalsFacts): boolean {
  const entries = vatEntriesOf(invoice.vatSummary)
  const taxable = entries.reduce((sum, entry) => sum + entry.taxable, 0)
  const vat = entries.reduce((sum, entry) => sum + entry.vat, 0)
  const gross = invoice.netTotal + invoice.vatTotal
  return taxable === invoice.netTotal && vat === invoice.vatTotal && (invoice.grossTotal === gross || invoice.grossTotal === gross + (invoice.stampDutyAmount ?? 0))
}

export function totalsCheck(invoices: readonly TotalsFacts[]): CheckResult {
  return result(
    'TOTALS_EQUAL_ROWS',
    invoices.filter((invoice) => !totalsAddUp(invoice)).map((invoice) => ({ recordType: 'Invoice', recordId: invoice.id, number: invoice.number, field: null })),
    "Every invoice's totals are the sums of its VAT summary.",
    (count, names) => `${count} invoice(s) have totals that are not the sums of their VAT summary: ${names}.`,
  )
}

export function intrastatCheck(rows: readonly IntrastatRow[]): CheckResult {
  const failing: CheckFix[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const flag of row.flags) {
      if (flag.severity !== 'BLOCKING') continue
      const fix: CheckFix = flag.fix ? { ...flag.fix, number: flag.fix.recordType === 'Style' ? (row.style?.code ?? null) : flag.fix.recordType === 'Party' ? row.partner.code : row.invoiceNumber } : { recordType: 'Invoice', recordId: row.invoiceId, number: row.invoiceNumber, field: null }
      const key = `${fix.recordType}|${fix.recordId}|${fix.field ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      failing.push(fix)
    }
  }
  return result(
    'INTRASTAT_COMPLETE',
    failing,
    rows.length === 0 ? 'No EU sale in the month.' : 'Every EU sale row has what the Intrastat file needs.',
    (count, names) => `${count} thing(s) the Intrastat file needs are missing (CN code, origin, net mass, VAT ID…): ${names}.`,
  )
}

export function yearEndCheck(input: { readonly counts: readonly YearEndCountFacts[]; readonly sitesWithStock: readonly { readonly siteId: string; readonly code: string }[] }): CheckResult {
  const failing: CheckFix[] = []
  for (const count of input.counts) if (count.status !== 'SIGNED_OFF' && count.status !== 'CANCELLED') failing.push({ recordType: 'StockCount', recordId: count.id, number: count.number, field: null })
  for (const site of input.sitesWithStock) {
    if (!input.counts.some((count) => count.siteId === site.siteId && count.status === 'SIGNED_OFF')) failing.push({ recordType: 'Site', recordId: site.siteId, number: site.code, field: null })
  }
  return result(
    'YEAR_END_SIGNED_OFF',
    failing,
    'Every site with stock has its year-end inventory signed off.',
    (count, names) => `${count} year-end inventory(ies) open, or site(s) with stock and no signed-off inventory for the day: ${names}.`,
  )
}

export function stockValuedCheck(unvaluedMoves: number): CheckResult {
  return unvaluedMoves === 0
    ? { code: 'STOCK_VALUED', passed: true, count: 0, words: 'Every stock move up to the year end has its value.', fixes: [] }
    : { code: 'STOCK_VALUED', passed: false, count: unvaluedMoves, words: `${unvaluedMoves} stock move(s) up to the year end have no value yet: their stock is counted but not valued.`, fixes: [] }
}

export interface Explanation {
  readonly code: CheckCode
  readonly explanation: string
}

/** A failing check with no explanation in words (paths `body/explanations/<code>`). */
export function explanationProblems(checks: readonly CheckResult[], explanations: readonly Explanation[]): Issue[] {
  const given = new Map(explanations.map((entry) => [entry.code, entry.explanation.trim()]))
  return checks
    .filter((check) => !check.passed && !given.get(check.code))
    .map((check) => ({ path: `body/explanations/${check.code}`, message: `"${CHECK_TITLES[check.code].en}" fails: ${check.words} Explain it in words, or fix it first.` }))
}

export interface StoredCheck {
  readonly code: CheckCode
  readonly passed: boolean
  readonly count: number
  readonly explanation?: string
}

/** The checks as an export keeps them (AccountingExport.checks). */
export function storedChecks(checks: readonly CheckResult[], explanations: readonly Explanation[]): StoredCheck[] {
  const given = new Map(explanations.map((entry) => [entry.code, entry.explanation.trim()]))
  return checks.map((check) => {
    const explanation = check.passed ? '' : (given.get(check.code) ?? '')
    return { code: check.code, passed: check.passed, count: check.count, ...(explanation ? { explanation } : {}) }
  })
}

/** Stored checks read back (the seeds' older rows have no count). */
export function parseStoredChecks(value: unknown): StoredCheck[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): StoredCheck[] => {
    if (raw === null || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    if (typeof entry.code !== 'string' || !(CHECK_CODES as readonly string[]).includes(entry.code) || typeof entry.passed !== 'boolean') return []
    return [{ code: entry.code as CheckCode, passed: entry.passed, count: typeof entry.count === 'number' ? entry.count : 0, ...(typeof entry.explanation === 'string' ? { explanation: entry.explanation } : {}) }]
  })
}

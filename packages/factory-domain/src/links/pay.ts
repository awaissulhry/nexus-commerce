/**
 * Pay figures never go by link (Owner, 11-02; plan B-W2b-163, §10 "Pay figures by link"). Whatever the purpose, no link
 * opens a record that holds pay figures, and no link shares a file of one: the link maker of platform/links (POST /links,
 * a set of files, a renewal) and every module that makes its own link (B-W2b-54's payroll Send) ask this one rule, and the
 * database refuses the same record types (the …_links_depth_w2b_guards function factory_link_pay_record).
 *
 *   PAY_RECORD_TYPES   the record types of pay.prisma whose rows hold pay figures (`@grain pay`) or print them: piece
 *                      rates, their published sheets and signed receipts, incentive schemes, pay periods, earnings and
 *                      the workers' statements. Equal to the database's list (factory-db's links-depth PG test keeps that
 *                      one equal to the schema).
 *   PayrollExport      the labour consultant's payroll file: it carries pay figures when one of its values has an amount
 *                      (people/payroll/values carriesPay). Such a file never goes by link. A file of hours only may go
 *                      while PAYROLL_HOURS_ONLY_BY_LINK is true: the Owner's W2b-2 question 2 decides it (plan §13), one
 *                      line here.
 *
 * Pure: the API reads the facts (a file's record type, an export's values) and asks.
 */

export const PAY_RECORD_TYPES = Object.freeze([
  'PieceRateTable',
  'PieceRateVersion',
  'PieceRateEntry',
  'RatePublication',
  'RateAcknowledgement',
  'IncentiveScheme',
  'PayPeriod',
  'EarningsEntry',
  'WorkerStatement',
] as const)

/** The payroll file's record type (B-W2b-54): decided by what it carries. */
export const PAYROLL_EXPORT = 'PayrollExport'

/**
 * May a payroll file of hours only (no amount) still go by link? The Owner's W2b-2 question 2 (plan §13); the lead's
 * default until he answers: yes, as B-W2b-54 sends it today. Set false and no payroll file goes by link at all.
 */
export const PAYROLL_HOURS_ONLY_BY_LINK = true

/** The refusal's code (409, issue `refusal/PAY_FIGURES`). */
export const PAY_BY_LINK_REFUSAL = 'PAY_FIGURES'

export const isPayRecord = (recordType: string): boolean => (PAY_RECORD_TYPES as readonly string[]).includes(recordType)

export interface PaySubject {
  /** The record a link opens, or the record a shared file belongs to. */
  readonly recordType: string
  /** For a PayrollExport: one of its values has an amount. */
  readonly payrollCarriesPay?: boolean | undefined
  /** How the subject is named in the words: "this link" (a record) or the file's name. */
  readonly fileName?: string | null | undefined
}

/** Why this record or file may not go by link, in words; null when it may. */
export function payByLinkProblem(subject: PaySubject): string | null {
  const what = subject.fileName ? `"${subject.fileName}"` : 'This record'
  if (isPayRecord(subject.recordType)) return `${what} holds pay figures, and pay figures never go by link. Hand it over in person or in the office.`
  if (subject.recordType === PAYROLL_EXPORT) {
    if (subject.payrollCarriesPay === true) return `${what} is a payroll file with amounts, and pay figures never go by link. Only a file of hours may be sent.`
    if (!PAYROLL_HOURS_ONLY_BY_LINK) return `${what} is a payroll file: payroll files do not go by link.`
  }
  return null
}

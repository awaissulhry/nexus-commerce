import { createHash } from 'node:crypto'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { isCurrencyCode, minorPlaces, type MinorUnits } from '../../core/money'
import { Dec } from '../../tax/decimal'

/**
 * A bank statement read from the file the company downloaded from its bank (B-W2b-393; FIN-130; Owner 11-13: files only,
 * no paid feed), pure: what every format reads into (camt053.ts, ofx.ts, sheet.ts), the line in the form the database
 * keeps it (factory-db bank.prisma BankLine: words of one line, an IBAN shape, minor units), the problems of a line by
 * code (the screens word the codes; `BANK_LINE_PROBLEM_WORDS` are the API's English words), and the fingerprint that
 * makes a line count once per account.
 *
 * The fingerprint: SHA-256 of the account, the booking day, the amount, the bank's reference and the reference text (both
 * folded: upper case, one space), and the line's place among the file's lines that are the same in all of those (two
 * bank charges of 1.50 on one day with the same words are two lines: the first is #1, the second #2). The same movement
 * read again from a later file of the same account (an overlapping period) gets the same fingerprint, and the database's
 * unique key (account, fingerprint) refuses it: a duplicate is never imported twice.
 */

export const BANK_FORMATS = ['CAMT053', 'CSV', 'XLSX', 'OFX'] as const
export type BankFormat = (typeof BANK_FORMATS)[number]

/** The most lines one statement file brings (a month of a busy account fits many times over). */
export const MAX_STATEMENT_LINES = 5000

/** What may be wrong with one line of a file, by code. */
export const BANK_LINE_PROBLEMS = ['NO_DATE', 'BAD_DATE', 'FUTURE_DATE', 'NO_AMOUNT', 'BAD_AMOUNT', 'ZERO_AMOUNT', 'TOO_MANY_DECIMALS', 'OTHER_CURRENCY', 'BOTH_SIDES', 'REFERENCE_TOO_LONG'] as const
export type BankLineProblem = (typeof BANK_LINE_PROBLEMS)[number]

export const BANK_LINE_PROBLEM_WORDS: Readonly<Record<BankLineProblem, string>> = Object.freeze({
  NO_DATE: 'The line has no booking date.',
  BAD_DATE: 'The booking or value date is not a date (day first, or YYYY-MM-DD).',
  FUTURE_DATE: 'The booking date has not come yet.',
  NO_AMOUNT: 'The line has no amount.',
  BAD_AMOUNT: 'The amount is not a number in the chosen format.',
  ZERO_AMOUNT: 'The amount is 0: nothing moved.',
  TOO_MANY_DECIMALS: "The amount has more decimals than the account's currency.",
  OTHER_CURRENCY: "The line is in another currency than the account's.",
  BOTH_SIDES: 'The line has an amount both in and out: one of them, please.',
  REFERENCE_TOO_LONG: "The bank's reference has more than 100 characters.",
})

/** One line as a format read it: what it could read, and what is wrong with it. */
export interface ParsedLine {
  /** Where it is in the file: the entry's number (XML, OFX) or the sheet's row. */
  readonly row: number
  readonly bookedOn: BusinessDate | null
  readonly valueOn: BusinessDate | null
  /** Minor units: money in above 0, out below 0. */
  readonly amount: MinorUnits | null
  readonly currency: string | null
  readonly bankReference: string | null
  readonly referenceText: string | null
  readonly counterpartyName: string | null
  readonly counterpartyIban: string | null
  readonly problems: readonly BankLineProblem[]
}

export interface ParsedStatement {
  readonly format: BankFormat
  /** The account the file names (camt.053 Acct/Id/IBAN, OFX ACCTID when it is an IBAN); null when it names none. */
  readonly iban: string | null
  /** The account's currency the file names, when it does. */
  readonly currency: string | null
  /** The days the file says it covers, when it does. */
  readonly periodStart: BusinessDate | null
  readonly periodEnd: BusinessDate | null
  readonly lines: readonly ParsedLine[]
}

/** The file cannot be read at all (not that format, broken, more than one account): the words say why. */
export class StatementReadError extends Error {
  override name = 'StatementReadError'
  constructor(
    readonly code: StatementRefusal,
    message: string = STATEMENT_REFUSAL_WORDS[code],
  ) {
    super(message)
  }
}

/** Why a whole file is refused, by code. */
export const STATEMENT_REFUSALS = ['UNREADABLE', 'NOT_THIS_FORMAT', 'NO_LINES', 'TOO_MANY_LINES', 'SEVERAL_ACCOUNTS'] as const
export type StatementRefusal = (typeof STATEMENT_REFUSALS)[number]

export const STATEMENT_REFUSAL_WORDS: Readonly<Record<StatementRefusal, string>> = Object.freeze({
  UNREADABLE: 'We could not read this file.',
  NOT_THIS_FORMAT: 'This file is not in the format chosen.',
  NO_LINES: 'The file has no booked movement.',
  TOO_MANY_LINES: `The file has more than ${MAX_STATEMENT_LINES} movements; download a shorter period.`,
  SEVERAL_ACCOUNTS: 'The file holds the movements of more than one account; download one account at a time.',
})

// ---- the line in the database's form ---------------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/g

/** Words of one line: control characters as spaces, spaces folded, trimmed; null when nothing is left. */
export function oneLine(value: string | null | undefined, longest?: number): string | null {
  const text = (value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return null
  return longest !== undefined && text.length > longest ? text.slice(0, longest).trim() : text
}

/** An IBAN as the database keeps a counterparty's (upper case, no spaces, the shape only: the bank wrote it), or null. */
export function ibanShape(value: string | null | undefined): string | null {
  const compact = (value ?? '').replace(/\s+/g, '').toUpperCase()
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact) ? compact : null
}

/**
 * A decimal amount as the bank wrote it ("410.00", "-1234.5") in minor units of the currency, or the problem: more
 * decimals than the currency has (a bank never rounds), not a number, or 0.
 */
export function amountOf(text: string, currency: string): { amount: MinorUnits | null; problem: BankLineProblem | null } {
  const plain = text.trim()
  if (!/^[-+]?\d+(\.\d+)?$/.test(plain)) return { amount: null, problem: 'BAD_AMOUNT' }
  const places = isCurrencyCode(currency) ? minorPlaces(currency) : 2
  const decimals = plain.includes('.') ? plain.split('.')[1]!.replace(/0+$/, '').length : 0
  if (decimals > places) return { amount: null, problem: 'TOO_MANY_DECIMALS' }
  const minor = new Dec(plain).times(new Dec(10).pow(places))
  if (minor.abs().greaterThan(2_147_483_647)) return { amount: null, problem: 'BAD_AMOUNT' }
  const amount = Number.parseInt(minor.toFixed(0), 10)
  return amount === 0 ? { amount: null, problem: 'ZERO_AMOUNT' } : { amount, problem: null }
}

/** A day the file wrote (YYYY-MM-DD, or a date-time whose day it is), or null. */
export function isoDay(text: string | null | undefined): BusinessDate | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec((text ?? '').trim())
  return match && isBusinessDate(match[1]) ? match[1] : null
}

/**
 * The problems every format checks the same way: a booking day (not after today), an amount, the account's currency.
 * `problems` already found by the format come first.
 */
export function lineProblems(line: Omit<ParsedLine, 'problems'>, found: readonly BankLineProblem[], today: BusinessDate, accountCurrency: string | null): BankLineProblem[] {
  const problems = new Set<BankLineProblem>(found)
  if (line.bookedOn === null && !problems.has('BAD_DATE')) problems.add('NO_DATE')
  if (line.bookedOn !== null && line.bookedOn > today) problems.add('FUTURE_DATE')
  if (line.amount === null && ![...problems].some((code) => code === 'BAD_AMOUNT' || code === 'ZERO_AMOUNT' || code === 'TOO_MANY_DECIMALS' || code === 'BOTH_SIDES')) problems.add('NO_AMOUNT')
  if (accountCurrency !== null && line.currency !== null && line.currency !== accountCurrency) problems.add('OTHER_CURRENCY')
  if (line.bankReference !== null && line.bankReference.length > 100) problems.add('REFERENCE_TOO_LONG')
  return BANK_LINE_PROBLEMS.filter((code) => problems.has(code))
}

/** The days a set of lines covers (their first and last booking day), or null when none has one. */
function daysOf(lines: readonly Pick<ParsedLine, 'bookedOn'>[]): { first: BusinessDate; last: BusinessDate } | null {
  const days = lines.flatMap((line) => (line.bookedOn ? [line.bookedOn] : [])).sort()
  return days.length === 0 ? null : { first: days[0]!, last: days[days.length - 1]! }
}

/**
 * The statement's period: the days the file says when they hold every line and end by today, else its lines' first
 * and last booking day.
 */
export function periodOf(statement: Pick<ParsedStatement, 'periodStart' | 'periodEnd' | 'lines'>, today: BusinessDate): { start: BusinessDate; end: BusinessDate } | null {
  const days = daysOf(statement.lines)
  if (!days) return null
  const { periodStart: start, periodEnd: end } = statement
  if (start && end && start <= days.first && end >= days.last && end <= today) return { start, end }
  return { start: days.first, end: days.last }
}

// ---- the fingerprint -------------------------------------------------------------------------------------------------

const folded = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

/** What makes a line itself, before its place among equal lines. */
function lineKey(bankAccountId: string, line: Pick<ParsedLine, 'bookedOn' | 'amount' | 'bankReference' | 'referenceText'>): string {
  return [bankAccountId, line.bookedOn ?? '', String(line.amount ?? ''), folded(line.bankReference), folded(line.referenceText)].join('\u001f')
}

/** The fingerprint of each line, in order (`sha256:` + 64 hex: no spaces, at most 200 characters). */
export function fingerprints(bankAccountId: string, lines: readonly Pick<ParsedLine, 'bookedOn' | 'amount' | 'bankReference' | 'referenceText'>[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const key = lineKey(bankAccountId, line)
    const place = (seen.get(key) ?? 0) + 1
    seen.set(key, place)
    return `sha256:${createHash('sha256').update(`${key}\u001f#${place}`).digest('hex')}`
  })
}

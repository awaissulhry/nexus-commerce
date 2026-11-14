import type { MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { BANK_LINE_PROBLEM_WORDS, fingerprints, periodOf, type BankFormat, type BankLineProblem, type ParsedLine, type ParsedStatement } from '../bank-formats/statement'

/**
 * Importing a bank statement (B-W2b-393; FIN-130; design finance.bank pop:import "file → column mapping → dry run (new,
 * duplicate refused) → Apply"), pure: which format a file is, which of the company's accounts it is for, and what each
 * line becomes — NEW (imported), DUPLICATE (the account has it already: never imported again; two equal lines of one file are two lines, statement.ts)
 * or ERROR (it cannot be read: imported only when the person says to leave those lines out). The dry run and the import
 * answer the same verdicts; the import writes the NEW lines of one statement in one command, and the database's unique
 * key (account, fingerprint) refuses a duplicate that slipped in meanwhile.
 */

/** The file kinds and types a statement is stored as (platform/files KIND_RULES), by format. Kept ten years. */
export const STATEMENT_FILES: Readonly<Record<BankFormat, { readonly kind: 'FISCAL_ARCHIVE' | 'DOCUMENT' | 'ATTACHMENT'; readonly contentType: string; readonly extensions: readonly string[] }>> = Object.freeze({
  CAMT053: { kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', extensions: ['.xml', '.camt', '.053'] },
  CSV: { kind: 'DOCUMENT', contentType: 'text/csv', extensions: ['.csv', '.txt'] },
  XLSX: { kind: 'DOCUMENT', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extensions: ['.xlsx'] },
  OFX: { kind: 'ATTACHMENT', contentType: 'text/plain', extensions: ['.ofx', '.qfx'] },
})

/** How long a statement file is kept (an accounting record: c.c. art. 2220). */
export const STATEMENT_RETENTION_YEARS = 10

/** The format a file name says, or null. */
export function formatOfName(name: string): BankFormat | null {
  const lower = name.trim().toLowerCase()
  for (const [format, file] of Object.entries(STATEMENT_FILES) as [BankFormat, (typeof STATEMENT_FILES)[BankFormat]][]) {
    if (file.extensions.some((extension) => lower.endsWith(extension))) return format
  }
  return null
}

/** Why an import (or its dry run) is refused, by code. */
export const IMPORT_REFUSALS = [
  'FORMAT_UNKNOWN',
  'FILE_NOT_READY',
  'NOT_A_STATEMENT_FILE',
  'FILE_USED',
  'ACCOUNT_NEEDED',
  'ACCOUNT_UNKNOWN',
  'ACCOUNT_DIFFERS',
  'ACCOUNT_OFF',
  'CURRENCY_DIFFERS',
  'MAPPING_INCOMPLETE',
  'NOTHING_NEW',
  'LINES_UNREADABLE',
  'CHANGED_SINCE_DRY_RUN',
] as const
export type ImportRefusal = (typeof IMPORT_REFUSALS)[number]

export const IMPORT_REFUSAL_WORDS: Readonly<Record<ImportRefusal, string>> = Object.freeze({
  FORMAT_UNKNOWN: 'Say which format the file is: camt.053 (XML), CSV, Excel (XLSX) or OFX.',
  FILE_NOT_READY: 'The file is not ready: finish the upload, or upload it again.',
  NOT_A_STATEMENT_FILE: 'This file was not uploaded as a bank statement of this company.',
  FILE_USED: 'This file is imported already.',
  ACCOUNT_NEEDED: "The file names no account: choose the company's bank account it is for.",
  ACCOUNT_UNKNOWN: "The file is for an account the company does not have (or has switched off): add the account first, or check the file.",
  ACCOUNT_DIFFERS: 'The file is for another account than the one chosen.',
  ACCOUNT_OFF: 'The account chosen is switched off: nothing is imported into it.',
  CURRENCY_DIFFERS: "The file is in another currency than the account's.",
  MAPPING_INCOMPLETE: 'Map the columns of the booking date and of the amount (or of money in and money out) first.',
  NOTHING_NEW: 'Every line of this file is imported already: nothing new to import.',
  LINES_UNREADABLE: 'Some lines cannot be read: fix the column mapping, or import without them.',
  CHANGED_SINCE_DRY_RUN: 'The lines changed since the dry run (another import took some): run the dry run again.',
})

export interface AccountFacts {
  readonly id: string
  readonly iban: string
  readonly currency: string
  readonly active: boolean
}

/**
 * The account a statement is for: the one the file names (its IBAN, a live account of the company), checked against the
 * one chosen when both are given; the chosen one when the file names none. A refusal code otherwise.
 */
export function accountFor(statement: Pick<ParsedStatement, 'iban' | 'currency'>, accounts: readonly AccountFacts[], chosenId: string | null): { account: AccountFacts } | { refusal: ImportRefusal } {
  const chosen = chosenId === null ? null : (accounts.find((account) => account.id === chosenId) ?? null)
  if (chosenId !== null && !chosen) return { refusal: 'ACCOUNT_UNKNOWN' }
  let account: AccountFacts | null = chosen
  if (statement.iban !== null) {
    const named = accounts.find((entry) => entry.iban === statement.iban && entry.active) ?? null
    if (chosen && chosen.iban !== statement.iban) return { refusal: 'ACCOUNT_DIFFERS' }
    if (!named && !chosen) return { refusal: 'ACCOUNT_UNKNOWN' }
    account = chosen ?? named
  }
  if (!account) return { refusal: 'ACCOUNT_NEEDED' }
  if (!account.active) return { refusal: 'ACCOUNT_OFF' }
  if (statement.currency !== null && statement.currency !== account.currency) return { refusal: 'CURRENCY_DIFFERS' }
  return { account }
}

export const LINE_VERDICTS = ['NEW', 'DUPLICATE', 'ERROR'] as const
export type LineVerdict = (typeof LINE_VERDICTS)[number]

export interface JudgedLine extends ParsedLine {
  readonly fingerprint: string
  readonly verdict: LineVerdict
}

export interface ImportPlan {
  readonly lines: readonly JudgedLine[]
  readonly counts: Readonly<Record<LineVerdict, number>>
  /** What the NEW lines bring in and take out (minor units of the account's currency). */
  readonly totals: { readonly moneyIn: MinorUnits; readonly moneyOut: MinorUnits }
  /** The statement's days (all lines read), or null when no line has a day. */
  readonly period: { readonly start: BusinessDate; readonly end: BusinessDate } | null
}

/** Each line's verdict, against the fingerprints the account has already. */
export function planImport(statement: ParsedStatement, bankAccountId: string, known: ReadonlySet<string>, today: BusinessDate): ImportPlan {
  const prints = fingerprints(bankAccountId, statement.lines)
  const lines: JudgedLine[] = statement.lines.map((line, index) => {
    const fingerprint = prints[index]!
    const verdict: LineVerdict = line.problems.length > 0 ? 'ERROR' : known.has(fingerprint) ? 'DUPLICATE' : 'NEW'
    return { ...line, fingerprint, verdict }
  })
  const counts = { NEW: 0, DUPLICATE: 0, ERROR: 0 }
  let moneyIn = 0
  let moneyOut = 0
  for (const line of lines) {
    counts[line.verdict] += 1
    if (line.verdict === 'NEW' && line.amount !== null) {
      if (line.amount > 0) moneyIn += line.amount
      else moneyOut += -line.amount
    }
  }
  const readable = lines.filter((line) => line.verdict !== 'ERROR')
  return { lines, counts, totals: { moneyIn, moneyOut }, period: periodOf({ ...statement, lines: readable }, today) }
}

/** Why the plan cannot be imported as asked (null: it can). */
export function importRefusal(plan: ImportPlan, options: { readonly skipErrors: boolean }): ImportRefusal | null {
  if (plan.counts.ERROR > 0 && !options.skipErrors) return 'LINES_UNREADABLE'
  if (plan.counts.NEW === 0) return 'NOTHING_NEW'
  return null
}

/** A line problem with its words, for an answer. */
export const problemView = (code: BankLineProblem) => ({ code, words: BANK_LINE_PROBLEM_WORDS[code] })

import type { Issue } from '../../core/errors'
import { LAYOUT_LIMITS } from './layouts'

/**
 * People settings › Payroll and statements (B-W2b-89; design people.settings, follow-ups of B-W2b-54 and B-W2b-68): the
 * company's labour consultant as a party, the payroll code their software knows the company by (Company.payrollCode), and the
 * office printer of the worker statements (PeopleSettings.statementPrinterId). Pure: the API reads the rows.
 *
 *   consultant   an ACTIVE party with the CONSULTANT role, of the company or tenant-wide. Checked when it is named; one that
 *                is blocked or loses the role later stays named, and every reader says so (the database does the same).
 *   payroll code what the file's company column prints (the company's code when none is given); at most 20 characters.
 *   printer      an ACTIVE A4 printer of the company, wherever it stands; named and archived later: statements are held
 *                (factory-domain people/myday `statementPrinterOf`), never sent to another printer.
 */

export const PAYROLL_SETTINGS_REFUSALS = ['NOT_CONSULTANT', 'PRINTER_NOT_USABLE'] as const
export type PayrollSettingsRefusal = (typeof PAYROLL_SETTINGS_REFUSALS)[number]

/** Why a named consultant or printer no longer serves; null: it does. */
export const CONSULTANT_PROBLEMS = ['NOT_CONSULTANT', 'NOT_ACTIVE', 'OTHER_COMPANY', 'GONE'] as const
export type ConsultantProblem = (typeof CONSULTANT_PROBLEMS)[number]
export const PRINTER_PROBLEMS = ['NOT_A4', 'NOT_ACTIVE', 'GONE'] as const
export type PrinterProblem = (typeof PRINTER_PROBLEMS)[number]

export interface ConsultantFacts {
  readonly companyId: string | null
  readonly roles: readonly string[]
  readonly status: string
}

export function consultantProblemOf(party: ConsultantFacts | null, companyId: string): ConsultantProblem | null {
  if (!party) return 'GONE'
  if (!party.roles.includes('CONSULTANT')) return 'NOT_CONSULTANT'
  if (party.status !== 'ACTIVE') return 'NOT_ACTIVE'
  if (party.companyId !== null && party.companyId !== companyId) return 'OTHER_COMPANY'
  return null
}

export interface PrinterFacts {
  readonly kind: string
  readonly status: string
}

export function printerProblemOf(printer: PrinterFacts | null): PrinterProblem | null {
  if (!printer) return 'GONE'
  if (printer.kind !== 'A4_PDF') return 'NOT_A4'
  if (printer.status !== 'ACTIVE') return 'NOT_ACTIVE'
  return null
}

export const CONSULTANT_PROBLEM_WORDS: Readonly<Record<ConsultantProblem, string>> = Object.freeze({
  NOT_CONSULTANT: 'The party named as the labour consultant no longer has the Consultant role.',
  NOT_ACTIVE: 'The party named as the labour consultant is not active.',
  OTHER_COMPANY: 'The party named as the labour consultant belongs to another company.',
  GONE: 'The party named as the labour consultant is not found.',
})

export const PRINTER_PROBLEM_WORDS: Readonly<Record<PrinterProblem, string>> = Object.freeze({
  NOT_A4: 'The printer named for statements is not an A4 printer: statements are held until another is named.',
  NOT_ACTIVE: 'The printer named for statements is archived: statements are held until another is named.',
  GONE: 'The printer named for statements is not found: statements are held until another is named.',
})

/** The payroll code as typed: trimmed, null when blank; its problems at `<at>/payrollCode`. */
export const payrollCodeOf = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

export function payrollCodeProblems(value: string | null, at = 'body'): Issue[] {
  return value !== null && value.length > LAYOUT_LIMITS.companyCode ? [{ path: `${at}/payrollCode`, message: `At most ${LAYOUT_LIMITS.companyCode} characters.` }] : []
}

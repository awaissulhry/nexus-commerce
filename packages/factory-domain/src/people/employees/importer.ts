import { cell } from '../../imports/cells'
import { defineImporter, diffPlan, type ExistingRecord, type RowPlan, type RowValues } from '../../imports/importer'
import { Dec } from '../../tax/decimal'
import { EMPLOYEE_CONTRACTS, EMPLOYEE_KINDS, EMPLOYEE_LIMITS } from './rules'

/**
 * The employees' import (B-W2b-26; MES-209; design people.employees "Import employees": the payroll provider's export or
 * a CSV → column mapping → dry run → new · changed · refused → apply), one row per person, keyed by the payroll's
 * employee code (matricola). A new code makes the record at the row's site; a known one changes the cells the row gives
 * (a blank cell is "not given", never "clear it"). The dry run applies the same rules as POST/PATCH /people/employees
 * (factory-domain people/employees/rules `employeeProblems`), and the API's adapter (platform/imports/importers/
 * employees.ts) checks what each code names: the site (of the job's company), the agency (an organisation), the home
 * line (of that site), the code not on another person's floor sign-in. So a row that would break a rule is an error in
 * the review, never a failed apply.
 *
 *   employee code                       the key (letters, digits and . _ - /; the payroll file's own)
 *   first name, last name, floor name   a new record needs both names; the floor name defaults to "First L."
 *   type                                EMPLOYEE, AGENCY (with the agency's code and the contract end) or EXTERNAL
 *   site, home line                     the site's code (a site of the job's company), a line of that site
 *   department, role                    words (the role risk sheets are W2b-2)
 *   contract, weekly hours              full or part time; hours a week (up to two decimals), stored as minutes
 *   start date, end date, language
 *
 * Not imported: the team (moves keep their history: People › Teams), the floor sign-in and the office account (one
 * edit path: Admin › Users), and leaving (the leaver steps; the review lists who is in Nexus but not in the file, and
 * the screen offers to start their leaver steps). Nothing here is a figure about a person's work; no pay column.
 */

export const EMPLOYEES_IMPORTER_KEY = 'people.employees'

const KIND_ALIASES = {
  dipendente: 'EMPLOYEE', interno: 'EMPLOYEE', employee: 'EMPLOYEE', staff: 'EMPLOYEE', subordinato: 'EMPLOYEE',
  interinale: 'AGENCY', somministrato: 'AGENCY', somministrazione: 'AGENCY', agenzia: 'AGENCY', agency: 'AGENCY', temp: 'AGENCY', temporary: 'AGENCY',
  esterno: 'EXTERNAL', collaboratore: 'EXTERNAL', external: 'EXTERNAL', contractor: 'EXTERNAL', consulente: 'EXTERNAL',
} as const satisfies Record<string, (typeof EMPLOYEE_KINDS)[number]>

const CONTRACT_ALIASES = {
  'tempo pieno': 'FULL_TIME', 'full time': 'FULL_TIME', 'full-time': 'FULL_TIME', fulltime: 'FULL_TIME', ft: 'FULL_TIME', pieno: 'FULL_TIME',
  'tempo parziale': 'PART_TIME', 'part time': 'PART_TIME', 'part-time': 'PART_TIME', parttime: 'PART_TIME', pt: 'PART_TIME', parziale: 'PART_TIME',
} as const satisfies Record<string, (typeof EMPLOYEE_CONTRACTS)[number]>

/** The columns a new record needs (the key, both names, the site and the start date). */
export const NEW_EMPLOYEE_COLUMNS = ['firstName', 'lastName', 'site', 'startDate'] as const

export const employeesImporter = defineImporter({
  key: EMPLOYEES_IMPORTER_KEY,
  label: 'Employees',
  description: 'The people who work here, from the payroll provider\'s export or a CSV: employee code, names, type and agency, site and home line, department and role, contract and weekly hours, start and end dates, language.',
  columns: {
    employeeCode: { label: 'Employee code', aliases: ['matricola', 'codice dipendente', 'codice matricola', 'n. matricola', 'employee number', 'employee id', 'payroll code'], required: true, type: cell.code({ max: EMPLOYEE_LIMITS.code }), description: 'The payroll file\'s own code (matricola).' },
    firstName: { label: 'First name', aliases: ['nome', 'first name', 'given name'], type: cell.text({ max: EMPLOYEE_LIMITS.name }) },
    lastName: { label: 'Last name', aliases: ['cognome', 'last name', 'surname', 'family name'], type: cell.text({ max: EMPLOYEE_LIMITS.name }) },
    displayName: { label: 'Name on the floor', aliases: ['nome in reparto', 'nome sul badge', 'nome breve', 'floor name', 'badge name', 'display name'], type: cell.text({ max: EMPLOYEE_LIMITS.displayName }), description: 'Shown on the tablets and the badge; "First L." when blank on a new record.' },
    kind: { label: 'Type', aliases: ['tipo', 'tipo rapporto', 'rapporto', 'type', 'worker type'], type: cell.oneOf(EMPLOYEE_KINDS, KIND_ALIASES), description: 'EMPLOYEE, AGENCY (needs the agency and the contract end) or EXTERNAL.' },
    agency: { label: 'Agency', aliases: ['agenzia', 'agenzia interinale', 'agency code', 'codice agenzia'], type: cell.code({ upper: true, max: 24 }), description: 'The agency\'s code (Customers & suppliers), for an agency worker.' },
    site: { label: 'Site', aliases: ['sito', 'stabilimento', 'sede', 'unita produttiva', 'site code', 'plant'], type: cell.code({ upper: true, max: 24 }), description: 'The site\'s code (a site of the job\'s company); a new record needs it.' },
    homeLine: { label: 'Home line', aliases: ['linea', 'reparto linea', 'linea di appartenenza', 'line', 'line code'], type: cell.code({ upper: true, max: 24 }), description: 'A line of the person\'s site.' },
    department: { label: 'Department', aliases: ['reparto', 'ufficio', 'centro di costo', 'department'], type: cell.text({ max: EMPLOYEE_LIMITS.text }) },
    jobRole: { label: 'Role', aliases: ['mansione', 'qualifica', 'ruolo', 'role', 'job title', 'job role'], type: cell.text({ max: EMPLOYEE_LIMITS.text }) },
    contract: { label: 'Contract', aliases: ['contratto', 'orario', 'tipo orario', 'contract', 'working time'], type: cell.oneOf(EMPLOYEE_CONTRACTS, CONTRACT_ALIASES) },
    weeklyHours: { label: 'Weekly hours', aliases: ['ore settimanali', 'orario settimanale', 'ore', 'weekly hours', 'hours per week'], type: cell.decimal({ precision: 5, scale: 2, min: '0' }), description: 'Hours a week (up to 80, two decimals at most).' },
    startDate: { label: 'Start date', aliases: ['data assunzione', 'assunto il', 'data inizio', 'inizio rapporto', 'start date', 'hire date', 'hired on'], type: cell.date(), description: 'A new record needs it.' },
    endDate: { label: 'End date', aliases: ['data cessazione', 'fine rapporto', 'scadenza contratto', 'data fine', 'end date', 'contract end'], type: cell.date(), description: 'The contract\'s end (an agency worker needs it). Leaving is the leaver steps, never this column.' },
    language: { label: 'Language', aliases: ['lingua', 'lingua madre', 'language', 'locale'], type: cell.code({ max: 3 }), description: 'Two or three small letters: it, en, ro.' },
  },
  keyColumns: ['employeeCode'],
  batchSize: 100,
  plan: (values, existing) => planEmployeeRow(values, existing),
})

/** Weekly hours (as the cell parses them) in whole minutes; null when they are not whole minutes. */
export function minutesOfHours(hours: string): number | null {
  const minutes = new Dec(hours).times(60)
  return minutes.isInteger() ? Number(minutes.toFixed(0)) : null
}

/** Weekly minutes as the import shows them: hours with up to two decimals. */
export function hoursOfMinutes(minutes: number | null): string | null {
  return minutes === null ? null : new Dec(minutes).dividedBy(60).toDecimalPlaces(2).toString()
}

/**
 * One row's plan: a new code needs both names, the site and the start date (the review says which are missing); a known
 * one the default comparison (the given cells that differ). Rules across the record (an agency worker's agency and end,
 * the dates' order, the weekly minutes) and what the codes name are the adapter's check, against the record as stored.
 */
export function planEmployeeRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const missing = NEW_EMPLOYEE_COLUMNS.filter((column) => values[column] === undefined)
    if (missing.length > 0) return { action: 'ERROR', errors: missing.map((column) => ({ column, message: 'A new employee needs it.' })) }
  }
  return diffPlan(employeesImporter, values, existing)
}

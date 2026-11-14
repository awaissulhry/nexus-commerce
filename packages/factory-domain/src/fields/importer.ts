import type { Grain } from '../auth/grains/grains'
import { cell, type CellValue } from '../imports/cells'
import { defineImporter, type Importer, type RowIssue } from '../imports/importer'
import type { TemplateExample } from '../imports/templates'
import { FIELD_LIMITS } from './rules'

/**
 * The import of custom values (B-W2b-421; PLT-111): ONE row per record and field — a record's code or number, the field's
 * code, and its value — so one importer per record type takes every field the tenant adds, with no column the code must
 * know (an importer's columns are fixed when the factory starts). A money field's amount goes in the column of its grain
 * (Price, Cost, Margin, Wages) with its currency: the engine refuses that column to a person without the grain and
 * keeps its values out of their review, as it does any money column. The API's adapter (platform/fields/importer.ts) finds
 * the record and the field, checks the value for the field's type and writes it through the values' command path.
 *
 *   record   the record's code or number (key)          value      text, a day, sì/no, a value code or label of the list
 *   field    the field's code (key)                                (several: separated by commas), a person's e-mail, a
 *   number   a number field's number (the job's format)            linked record's code or number
 *   currency the money columns' currency (EUR)
 *   priceValue · costValue · marginValue · wagesValue   a money field's amount, in the column of its grain (pay: none)
 */

/**
 * The money column of each grain an import takes. Piece pay (the `pay` grain: HR and the worker only) is never imported
 * into a custom field: a pay field's value is typed on its record.
 */
export const MONEY_COLUMNS: Readonly<Partial<Record<Grain, 'priceValue' | 'costValue' | 'marginValue' | 'wagesValue'>>> = Object.freeze({
  price: 'priceValue',
  cost: 'costValue',
  margin: 'marginValue',
  wages: 'wagesValue',
})

const money = (grain: Grain, label: string, aliases: readonly string[]) => ({ label, aliases, type: cell.decimal({ precision: 18, scale: 4 }), grain, description: `A ${grain} field's amount (with its currency).` })

const COLUMNS = {
  record: { label: 'Record', aliases: ['codice', 'numero', 'code', 'record code'], required: true, type: cell.text({ max: 80 }), description: "The record's code or number." },
  field: { label: 'Field', aliases: ['campo', 'field code', 'codice campo'], required: true, type: cell.text({ max: 40 }), description: "The custom field's code (heat_number)." },
  value: { label: 'Value', aliases: ['valore'], type: cell.text({ max: FIELD_LIMITS.text }), description: 'The value: text, a day, sì/no, a value code or label of the list (several: separated by commas), a person\'s e-mail, a linked record\'s code or number.' },
  number: { label: 'Number', aliases: ['valore numerico'], type: cell.decimal({ precision: 18, scale: 6 }), description: "A number field's number." },
  priceValue: money('price', 'Price', ['prezzo']),
  costValue: money('cost', 'Cost', ['costo']),
  marginValue: money('margin', 'Margin', ['margine']),
  wagesValue: money('wages', 'Wages', ['salari']),
  currency: { label: 'Currency', aliases: ['valuta'], type: cell.code({ max: 3, upper: true }), description: "The money columns' currency (EUR)." },
} as const

const MONEY_NAMES = ['priceValue', 'costValue', 'marginValue', 'wagesValue'] as const

/** The columns a row's value may be in: the value, the number, one money amount (with its currency). */
export const VALUE_COLUMNS = Object.freeze(['value', 'number', ...MONEY_NAMES] as const)

/** A row gives exactly one of: a value, a number, one money amount with its currency. */
function rowIssues(values: Readonly<Record<string, CellValue>>): RowIssue[] {
  const given = VALUE_COLUMNS.filter((name) => values[name] !== undefined)
  const issues: RowIssue[] = []
  if (given.length === 0) issues.push({ column: 'value', message: "Give the value (a number field's in the Number column, a money field's amount in the column of its grain)." })
  if (given.length > 1) issues.push({ column: given[1]!, message: 'One value per row: the value, a number or an amount.' })
  if (given.length === 1 && MONEY_NAMES.includes(given[0] as (typeof MONEY_NAMES)[number]) && values.currency === undefined) issues.push({ column: 'currency', message: "Give the amount's currency (EUR)." })
  return issues
}

/** The importer of one record type's custom values (`fields.orders` …). */
export function customValuesImporter(key: string, label: string): Importer<typeof COLUMNS> {
  return defineImporter({ key, label, description: `One row per ${label.toLowerCase()} and custom field.`, columns: COLUMNS, keyColumns: ['record', 'field'], validateRow: rowIssues })
}

/** Made-up rows for a template: a text value, a day, a number and a price amount. */
export const CUSTOM_VALUE_EXAMPLES: readonly TemplateExample[] = Object.freeze<TemplateExample[]>([
  { record: 'ESEMPIO-001', field: 'heat_number', value: 'HN-2026-17' },
  { record: 'ESEMPIO-001', field: 'fair_date', value: '2027-01-21' },
  { record: 'ESEMPIO-001', field: 'thickness_mm', number: '1.2' },
  { record: 'ESEMPIO-002', field: 'target_retail_price', priceValue: '899.00', currency: 'EUR' },
])

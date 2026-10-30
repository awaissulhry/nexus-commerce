import type { Grain } from '../auth/grains/grains'
import { cellMetaOf, type NumberFormat } from './cells'
import type { ImportColumn, Importer } from './importer'

/**
 * Import templates (B-W2a-41; PLT-177; design admin.import "Download template" on each importer, "Templates" in the
 * page's More menu): for every importer a sheet a person fills in — its columns' labels in the importer's order, one or
 * two made-up example rows written the way the import is told to read them (Italian numbers `1.234,50` and dates
 * `31/12/2026` by default), and a second part that explains each column (required, what it takes, what it holds, the
 * other headers the import also reads). Pure; the API writes it as CSV or Excel.
 *
 * Money (A1 §2.6): a column that carries money appears only for a person holding its grain, because the import refuses
 * the column for anyone else; the template says which columns it left out and why.
 */

export interface TemplateColumn {
  readonly name: string
  readonly label: string
  readonly required: boolean
  /** What the cell takes ("a number with up to 6 decimals"). */
  readonly takes: string | null
  readonly description: string | null
  /** The other headers the import reads as this column. */
  readonly aliases: readonly string[]
  readonly grain: Grain | null
}

export interface ImportTemplate {
  readonly importerKey: string
  readonly label: string
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly columns: readonly TemplateColumn[]
  /** Money columns left out: the person does not hold their grain. */
  readonly leftOut: readonly { readonly label: string; readonly grain: Grain }[]
}

/** An example row: column name → the value written neutrally (decimals with a point, dates as 2026-12-31). */
export type TemplateExample = Readonly<Record<string, string>>

const NUMBER_KINDS = new Set(['decimal', 'integer', 'minorUnits'])
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A neutral example value as the import reads it in this number format. */
export function exampleCell(column: ImportColumn, value: string, numberFormat: NumberFormat): string {
  const kind = cellMetaOf(column.type as never)?.kind
  if (kind && NUMBER_KINDS.has(kind)) return numberFormat === 'it' ? value.replace(/\./g, ',') : value
  if (kind === 'date' && numberFormat === 'it') {
    const match = ISO_DATE.exec(value)
    if (match) return `${match[3]}/${match[2]}/${match[1]}`
  }
  return value
}

export interface TemplateInput {
  readonly numberFormat: NumberFormat
  /** The grains the person holds. */
  readonly grains: readonly Grain[]
  /** Neutral examples (formatted here), or rows already written for this number format (`formatted`). */
  readonly examples: readonly TemplateExample[]
  readonly formatted?: boolean
}

/** The template of one importer for one person. */
export function importTemplate(importer: Importer, input: TemplateInput): ImportTemplate {
  const all = Object.entries(importer.columns as Readonly<Record<string, ImportColumn>>)
  const shown = all.filter(([, column]) => column.grain === undefined || input.grains.includes(column.grain))
  const leftOut = all.filter(([, column]) => column.grain !== undefined && !input.grains.includes(column.grain)).map(([, column]) => ({ label: column.label, grain: column.grain! }))
  const columns: TemplateColumn[] = shown.map(([name, column]) => ({
    name,
    label: column.label,
    required: column.required === true,
    takes: cellMetaOf(column.type as never)?.describe ?? null,
    description: column.description ?? null,
    aliases: [...(column.aliases ?? [])],
    grain: column.grain ?? null,
  }))
  const rows = input.examples.map((example) =>
    shown.map(([name, column]) => {
      const value = example[name]
      if (value === undefined) return ''
      return input.formatted ? value : exampleCell(column, value, input.numberFormat)
    }),
  )
  return { importerKey: importer.key, label: importer.label, header: columns.map((column) => column.label), rows, columns, leftOut }
}

/** A file name for the template (`product-materials-template.csv`). */
export const templateFileName = (importerKey: string, format: 'csv' | 'xlsx'): string => `${importerKey.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-template.${format}`

/** The explanation rows (the Excel workbook's second sheet; the CSV has none). */
export function templateHelp(template: ImportTemplate): readonly (readonly string[])[] {
  const rows: string[][] = [['Column', 'Required', 'What it takes', 'What it holds', 'Also read as']]
  for (const column of template.columns) {
    rows.push([column.label, column.required ? 'yes' : '', column.takes ?? '', [column.description ?? '', column.grain ? `Money (${column.grain}): only people who see it may import it.` : ''].filter(Boolean).join(' '), column.aliases.join(', ')])
  }
  for (const column of template.leftOut) rows.push([column.label, '', '', `Left out: it holds money (${column.grain}) you do not see, so you may not import it.`, ''])
  return rows
}

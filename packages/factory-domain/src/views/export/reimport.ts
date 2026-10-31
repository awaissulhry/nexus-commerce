import type { Grain } from '../../auth/grains/grains'
import { cellMetaOf, type CellValue } from '../../imports/cells'
import type { ImportColumn, Importer, RecordValues } from '../../imports/importer'
import { importTemplate, type TemplateColumn } from '../../imports/templates'

/**
 * "Full file for re-import (XLSX)" (B-W2b-11; design shell.lists toolbar Export ▾ 'Full file for re-import (XLSX)',
 * page anatomy 3.13 "Export ▾ names what it writes"): the rows of the view in the layout of the list's IMPORTER, so the
 * same file goes back through Admin › Import (or the list's Import) and every row is UNCHANGED until someone edits a
 * cell. Pure: the layout and the cells; the API reads the records through the importer's own load and writes the book.
 *
 * Layout = the importer's template for the person (factory-domain imports/templates): its columns in the importer's
 * order, headed by their labels (which the import maps back by name), a money column only for a person holding its
 * grain (the import refuses the column for anyone else; the file names what it left out on its second sheet, never
 * above the header: the import takes the first non-blank row as the header).
 *
 * Cells are written the way the import reads them back whatever number format the job is given: numbers as Excel
 * numbers (an Excel number is read as its shortest decimal text), days as ISO text (2026-12-31), yes/no as Excel
 * booleans, codes and words as text. An empty field stays an empty cell (a blank cell is "not given" to the import, so
 * re-importing never clears a field that was empty).
 */

/** A cell of the re-import sheet, as the writer puts it in the book. */
export type ReimportCell = string | number | boolean | null

export interface ReimportLayout {
  readonly importerKey: string
  /** The importer's label: the sheet's name. */
  readonly label: string
  readonly columns: readonly TemplateColumn[]
  /** The importer's key columns (how a row finds its record again). */
  readonly keyColumns: readonly string[]
  /** Money columns left out: the person does not hold their grain. */
  readonly leftOut: readonly { readonly label: string; readonly grain: Grain }[]
  readonly maxRows: number
}

/** The layout of an importer's re-import file for a person holding `grains`. */
export function reimportLayout(importer: Importer, grains: readonly Grain[]): ReimportLayout {
  const template = importTemplate(importer, { numberFormat: 'it', grains, examples: [] })
  return { importerKey: importer.key, label: importer.label, columns: template.columns, keyColumns: [...importer.keyColumns], leftOut: template.leftOut, maxRows: importer.maxRows }
}

/** One record's value of one column, as the import reads it back. */
export function reimportCell(column: ImportColumn | undefined, value: CellValue | null | undefined): ReimportCell {
  if (value === null || value === undefined || value === '') return null
  const kind = column ? cellMetaOf(column.type as never)?.kind : undefined
  if (kind === 'decimal' || kind === 'integer') {
    // As an Excel number: text such as "1.234" would read as a thousand in the Italian number format.
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(number) ? number : String(value)
  }
  if (kind === 'minorUnits') return typeof value === 'number' ? value / 100 : Number(value) / 100
  if (kind === 'boolean') return typeof value === 'boolean' ? value : String(value)
  return typeof value === 'number' || typeof value === 'boolean' ? value : String(value)
}

/** A record's row in the layout's order. */
export function reimportRow(importer: Importer, layout: ReimportLayout, values: RecordValues): ReimportCell[] {
  const columns = importer.columns as Readonly<Record<string, ImportColumn>>
  return layout.columns.map((column) => reimportCell(columns[column.name], values[column.name]))
}

/** The key of a record or a list row, as one text (key columns in the importer's order). */
export function reimportKey(keyColumns: readonly string[], values: Readonly<Record<string, CellValue | null | undefined>>): string {
  return JSON.stringify(keyColumns.map((name) => (values[name] === null || values[name] === undefined ? null : String(values[name]))))
}

/** The second sheet: what each column takes, and the columns the person's rights left out. */
export function reimportHelp(layout: ReimportLayout, locale: 'it' | 'en'): string[][] {
  const head = locale === 'it' ? ['Colonna', 'Obbligatoria', 'Contiene', 'Altre intestazioni lette'] : ['Column', 'Required', 'Takes', 'Other headers read']
  const yes = locale === 'it' ? 'sì' : 'yes'
  const rows = layout.columns.map((column) => [column.label, column.required ? yes : '', column.takes ?? '', column.aliases.join(', ')])
  const note = layout.leftOut.length === 0 ? [] : [[], [locale === 'it' ? `Colonne escluse dai tuoi permessi: ${layout.leftOut.map((entry) => entry.label).join(', ')}` : `Columns left out by your rights: ${layout.leftOut.map((entry) => entry.label).join(', ')}`]]
  const back = [[], [locale === 'it' ? 'Reimporta questo file da Amministrazione › Importa: le righe non modificate restano invariate.' : 'Import this file again from Admin › Import: rows nobody changed stay unchanged.']]
  return [head, ...rows, ...note, ...back]
}

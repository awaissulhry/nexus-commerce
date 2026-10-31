import ExcelJS from 'exceljs'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { cellMetaOf } from '@nexus/factory-domain/imports/cells'
import type { ImportColumn } from '@nexus/factory-domain/imports/importer'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import { reimportHelp, reimportKey, reimportLayout, reimportRow, type ReimportCell, type ReimportLayout } from '@nexus/factory-domain/views/export/reimport'
import type { CommandCaller, CommandTx } from '../../core/command'
import { processImporters, type ImportAdapter } from '../imports/registry'
import type { AnyExportSource } from './source'

/**
 * "Full file for re-import (XLSX)" (B-W2b-11; factory-domain views/export/reimport.ts): the rows of the view, each read
 * again through the list's IMPORTER's own `load` (platform/imports registry), so every cell holds exactly what the
 * import compares — the file goes back through Admin › Import as UNCHANGED rows until someone edits a cell. The rows and
 * their order are the list's (the source's read, as the person); the importer only gives the values of its columns
 * for the keys the person's list showed. Money columns only with their grain.
 */

const TEXT_KINDS = new Set(['text', 'code', 'oneOf', 'email', 'date'])

/** A list without an importer to read the file back: refused in words (never retried). */
class NoImporter extends DomainError {
  override name = 'NoImporter'
  constructor() {
    super('invalid_state', 'This list has no importer to read a re-import file back.')
  }
}

/** The importer a source re-imports through (a source without one, or a missing importer: refused in words). */
export function reimportAdapterOf(source: AnyExportSource): ImportAdapter {
  const key = source.reimport?.importer
  const adapter = key ? processImporters().get(key) : undefined
  if (!adapter) throw new NoImporter()
  return adapter
}

/** The layout of the file for a person holding `grains`, and the importer columns of a grain they lack (by name). */
export function reimportColumns(adapter: ImportAdapter, grains: ReadonlySet<Grain>): { readonly layout: ReimportLayout; readonly omitted: readonly { readonly key: string; readonly label: string }[] } {
  const layout = reimportLayout(adapter.importer, [...grains])
  const columns = adapter.importer.columns as Readonly<Record<string, ImportColumn>>
  const omitted = Object.entries(columns)
    .filter(([, column]) => column.grain !== undefined && !grains.has(column.grain))
    .map(([name, column]) => ({ key: name, label: column.label }))
  return { layout, omitted }
}

/**
 * One page of list rows as re-import rows: their keys (the source's), the records the importer's load finds for them in
 * the job's company, in the list's order. A row whose record is gone meanwhile is left out.
 */
export async function reimportPage(reader: CommandCaller, source: AnyExportSource, adapter: ImportAdapter, layout: ReimportLayout, rows: readonly unknown[], companyId: string | null): Promise<ReimportCell[][]> {
  if (rows.length === 0 || !source.reimport) return []
  const keys = rows.map((row) => source.reimport!.key(row))
  const records = await reader.withClient((client) => adapter.load(client as unknown as CommandTx, keys, { companyId }))
  const byKey = new Map(records.map((record) => [reimportKey(layout.keyColumns, record.values), record]))
  const out: ReimportCell[][] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const id = reimportKey(layout.keyColumns, key)
    const record = byKey.get(id)
    if (!record || seen.has(id)) continue
    seen.add(id)
    out.push(reimportRow(adapter.importer, layout, record.values))
  }
  return out
}

/** The workbook: the importer's sheet (header + rows, the header bold and frozen), then the columns explained. */
export async function writeReimport(input: { readonly adapter: ImportAdapter; readonly layout: ReimportLayout; readonly rows: readonly (readonly ReimportCell[])[]; readonly locale: ExportLocale }): Promise<Uint8Array> {
  const { adapter, layout } = input
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Nexus Factory'
  const sheet = workbook.addWorksheet(layout.label.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Import')
  const header = sheet.addRow(layout.columns.map((column) => column.label))
  header.font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  const columns = adapter.importer.columns as Readonly<Record<string, ImportColumn>>
  layout.columns.forEach((column, index) => {
    const target = sheet.getColumn(index + 1)
    target.width = Math.min(40, Math.max(12, column.label.length + 2))
    const kind = cellMetaOf(columns[column.name]?.type as never)?.kind
    // Codes, words and days as text: a code like 0012 or a day keeps exactly what it is when someone edits the cell.
    if (kind && TEXT_KINDS.has(kind)) target.numFmt = '@'
  })
  for (const row of input.rows) sheet.addRow([...row])
  const help = workbook.addWorksheet(input.locale === 'it' ? 'Colonne' : 'Columns')
  for (const line of reimportHelp(layout, input.locale)) help.addRow(line)
  help.getRow(1).font = { bold: true }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

import ExcelJS from 'exceljs'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { importTemplate, templateFileName, templateHelp, type ImportTemplate } from '@nexus/factory-domain/imports/templates'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { processImporters } from '../registry'
import { examplesOf } from './examples'

/**
 * GET /imports/importers/:importerKey/template (B-W2a-41; PLT-177; design admin.import "Download template"): the template
 * of any importer the caller may use (its view or write permission in any grant, as GET /imports/importers lists them),
 * as CSV (UTF-8, `;` between cells, which an Italian Excel opens as columns; header + examples) or as an Excel workbook
 * (the sheet, then a "Columns" sheet that explains each one). Money columns only with their grain (factory-domain
 * imports/templates). Holds no data: made-up examples only.
 */

const cellText = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** The template the caller may download, or 404 (an importer they may not use is not there for them). */
export function templateFor(caller: CommandCaller, importerKey: string, numberFormat: NumberFormat): ImportTemplate {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  const actor = actorOf(caller.factoryContext)
  const adapter = processImporters().list().find((item) => item.importer.key === importerKey)
  if (!adapter || !(can(actor, adapter.viewPermission) || can(actor, adapter.permission))) throw new NotFoundError('Importer not found.')
  const { examples, formatted } = examplesOf(importerKey, numberFormat)
  return importTemplate(adapter.importer, { numberFormat, grains: [...heldGrains(actor)], examples, formatted })
}

export async function templateFile(template: ImportTemplate, format: 'csv' | 'xlsx'): Promise<{ name: string; contentType: string; body: Buffer }> {
  const name = templateFileName(template.importerKey, format)
  if (format === 'csv') {
    const lines = [template.header, ...template.rows].map((row) => row.map(cellText).join(';'))
    return { name, contentType: `${SHEET_TYPES.csv}; charset=utf-8`, body: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8') }
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(template.label.slice(0, 31))
  sheet.addRow([...template.header])
  for (const row of template.rows) sheet.addRow([...row])
  sheet.getRow(1).font = { bold: true }
  // Every cell as text: a code like 0012 or a date typed by a person keeps exactly what they wrote.
  sheet.columns.forEach((column) => {
    column.numFmt = '@'
    column.width = 18
  })
  const help = workbook.addWorksheet('Columns')
  for (const row of templateHelp(template)) help.addRow([...row])
  help.getRow(1).font = { bold: true }
  return { name, contentType: SHEET_TYPES.xlsx, body: Buffer.from(await workbook.xlsx.writeBuffer()) }
}

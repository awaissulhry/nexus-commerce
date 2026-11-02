import { delimitedFile, fixedWidthFile, layoutConfirmed, payrollFileName, spreadsheetFile, type FileContext } from '@nexus/factory-domain/people/payroll/layouts'
import { parseChecks } from '@nexus/factory-domain/people/payroll/checks'
import { PAYROLL_RETENTION_YEARS } from '@nexus/factory-domain/people/payroll/rules'
import { payrollSummary } from '@nexus/factory-domain/people/payroll/summary'
import { parseValues, valueChanges } from '@nexus/factory-domain/people/payroll/values'
import { writeExport } from '../../../platform/exports/writer'
import { addYears } from '../../../platform/files/rules'
import type { Place } from '../close/store'
import { renderSummaryPdf } from './summary-pdf'
import { contextOfFile, layoutUsedOf, monthOfRow, type ExportRow } from './store'

/**
 * The files of a payroll export (B-W2b-54; MES-268, MES-270): the data file in the export's layout, and the summary for the
 * consultant's check. The seal is the SHA-256 of the stored bytes. Office only, and read only through this module
 * (platform/files MODULE_READ_FILES): they hold everyone's hours and pay by employee code.
 */

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface PlannedFile {
  readonly kind: 'DATA' | 'SUMMARY'
  readonly format: 'CSV' | 'XLSX' | 'TXT' | 'PDF'
  readonly name: string
  readonly contentType: string
  /** The file kind's rule: fixed-width text is text/plain, which only ATTACHMENT takes. */
  readonly fileKind: 'DOCUMENT' | 'ATTACHMENT'
  readonly rowCount: number
  readonly body: Uint8Array
}

async function dataFile(row: ExportRow, context: FileContext): Promise<PlannedFile> {
  const { format, definition } = layoutUsedOf(row.layoutSnapshot)
  const values = parseValues(row.values)
  if (format === 'SPREADSHEET') {
    const sheet = spreadsheetFile(definition, values, context)
    const body = await writeExport({ format: 'XLSX', locale: 'it', title: `Paghe ${context.month}`, note: null, headings: sheet.headings, rows: sheet.rows })
    return { kind: 'DATA', format: 'XLSX', name: payrollFileName(context, '', 'xlsx'), contentType: XLSX, fileKind: 'DOCUMENT', rowCount: sheet.rowCount, body }
  }
  const file = format === 'FIXED_WIDTH' ? fixedWidthFile(definition, values, context) : delimitedFile(definition, values, context)
  return { kind: 'DATA', format: file.format, name: payrollFileName(context, '', file.extension), contentType: file.contentType, fileKind: file.format === 'TXT' ? 'ATTACHMENT' : 'DOCUMENT', rowCount: file.rowCount, body: Buffer.from(file.text, file.encoding === 'UTF-8' ? 'utf8' : 'latin1') }
}

/** The export's two files, in memory. */
export async function renderFiles(place: Place, row: ExportRow): Promise<PlannedFile[]> {
  const context = contextOfFile(place, monthOfRow(row), row.revision)
  const used = layoutUsedOf(row.layoutSnapshot)
  const provider = (row.layoutSnapshot as { provider?: string | null } | null)?.provider ?? null
  const values = parseValues(row.values)
  const summary = payrollSummary({
    context,
    company: row.company,
    layoutName: row.layout.name,
    confirmed: layoutConfirmed({ provider, definition: used.definition }),
    values,
    changes: row.correctionOf ? valueChanges(parseValues(row.correctionOf.values), values) : [],
    replaces: row.correctionOf ? { number: row.correctionOf.number, revision: row.correctionOf.revision } : null,
    leftOut: parseChecks(row.checks).find((check) => check.code === 'AGENCY_LEFT_OUT')?.count ?? 0,
    createdAt: row.createdAt,
  })
  const pdf: PlannedFile = { kind: 'SUMMARY', format: 'PDF', name: summary.fileName, contentType: 'application/pdf', fileKind: 'DOCUMENT', rowCount: summary.blocks.length, body: await renderSummaryPdf(summary) }
  return [await dataFile(row, context), pdf]
}

export const retentionFrom = (at: Date): Date => addYears(at, PAYROLL_RETENTION_YEARS)

import { defineMachine } from '../state/machine'

/**
 * An import job (plan A1 §2.3 ImportJob; feature PLT-176), pure: its states, its modes and the engine's limits.
 *
 *   UPLOADED ──dry run──▶ PLANNED ──apply──▶ APPLYING ──▶ APPLIED
 *      │                     │                  │
 *      └──▶ FAILED ◀─────────┼──────────────────┘   (an unreadable sheet, a refused column; an apply that failed)
 *      CANCELLED ◀── from any state that is not APPLIED or CANCELLED
 *
 * FAILED → APPLYING resumes an apply that failed (only once the dry run finished: `planned`): the rows already applied
 * stay applied, the others are applied. Mode DRY_RUN stops at PLANNED for a person to review the plan; mode APPLY goes
 * on to apply the valid rows as soon as the dry run is done (no review: for a person who already knows the sheet).
 */

export const IMPORT_STATUSES = ['UPLOADED', 'PLANNED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED'] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]

export const IMPORT_MODES = ['DRY_RUN', 'APPLY'] as const
export type ImportMode = (typeof IMPORT_MODES)[number]

/** What happened to a planned row at apply time. */
export const ROW_OUTCOMES = ['APPLIED', 'SKIPPED'] as const
export type RowOutcome = (typeof ROW_OUTCOMES)[number]

export interface ImportFacts {
  /** The dry run finished (plannedAt is set). */
  readonly planned: boolean
}

export const importMachine = defineMachine<ImportStatus, ImportFacts>({
  name: 'import',
  states: IMPORT_STATUSES,
  transitions: {
    UPLOADED: ['PLANNED', 'FAILED', 'CANCELLED'],
    PLANNED: ['APPLYING', 'CANCELLED'],
    APPLYING: ['APPLIED', 'FAILED', 'CANCELLED'],
    FAILED: ['APPLYING', 'CANCELLED'],
  },
  guards: { APPLYING: (facts) => (facts.planned ? [] : ['a finished dry run (upload the sheet again)']) },
})

const MIB = 1_048_576

/**
 * The engine's limits. A sheet larger than maxBytes or with more data rows than maxRows (or an importer's own lower
 * maxRows) is refused whole, before any row is planned; an xlsx whose parts unpack to more than maxUnpackedBytes
 * (a zip bomb) is refused before it is opened.
 */
export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 10 * MIB,
  maxUnpackedBytes: 100 * MIB,
  maxRows: 10_000,
  maxColumns: 200,
  /** Rows per dry-run batch (one read and one write of plan rows). */
  planBatchSize: 500,
  /** Rows per apply batch (one transaction), unless the importer says fewer. */
  batchSize: 200,
  maxBatchSize: 1_000,
})

/** The sheet formats: CSV (UTF-8 or Windows-1252) and Excel workbooks (.xlsx). Macro-enabled and old .xls are refused. */
export const SHEET_TYPES = Object.freeze({
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})
export const SHEET_CONTENT_TYPES: readonly string[] = Object.values(SHEET_TYPES)

export const CSV_ENCODINGS = ['utf-8', 'windows-1252'] as const
export type CsvEncoding = (typeof CSV_ENCODINGS)[number]

/** Why a content type or file name is refused as a sheet, or null when it is a sheet. */
export function sheetTypeProblem(contentType: string, fileName: string): string | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  const name = fileName.toLowerCase()
  if (type.includes('macroenabled') || /\.(xlsm|xltm|xlam)$/.test(name)) {
    return 'Workbooks with macros (.xlsm) are refused: save the sheet as .xlsx (Excel Workbook) or .csv and upload that.'
  }
  if (type === 'application/vnd.ms-excel' || /\.(xls|xlsb)$/.test(name)) {
    return 'Old Excel files (.xls, .xlsb) are not read: save the sheet as .xlsx (Excel Workbook) or .csv and upload that.'
  }
  if (!SHEET_CONTENT_TYPES.includes(type)) return 'Expected a .csv file (text/csv) or an Excel workbook (.xlsx).'
  return null
}

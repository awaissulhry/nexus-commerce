/**
 * AX-IE.2 — build the bulksheet workbook from the shared schema.
 *
 * The point of this file is that the sheet's columns, its cell types and number
 * formats, its dropdowns and its Dictionary all come from ONE object
 * (@nexus/shared/ads-bulksheet). Adding a column is editing that array; nothing
 * here enumerates columns.
 *
 * Scope: AX-IE.2 keeps the existing single Sponsored Products sheet and adds the
 * generated Dictionary. The full nine-sheet workbook (SB, SD, Portfolios, Summary,
 * Lists, _meta) is AX-IE.3, and needs one real Seller Central bulksheet download
 * first to pin the exact SB/SD column sets.
 */

import {
  COLUMNS, HEADERS, VOCABULARIES, DICTIONARY_HEADERS, buildDictionaryRows, parseVocabulary,
  type BulksheetColumn,
} from '@nexus/shared/ads-bulksheet'
import { createWriter, type CellValue, type SheetColumnSpec } from './spreadsheet-adapter.js'

export const SP_SHEET = 'Sponsored Products Campaigns'
export const DICTIONARY_SHEET = 'Dictionary'

/** A row expressed by header name; unknown/absent headers become blank cells. */
export type BulksheetRow = Record<string, unknown>

/**
 * Coerce one value for its column so the writer emits the right CELL TYPE.
 *
 * This is the fix for the corruption chain AX-IE.0 closed: money must land as a
 * number (a text bid is what made an it-IT "1,25" come back as NaN and silently
 * become €0.50), dates as real Dates, and ids as text so a 19-digit Amazon id can
 * never be re-read as a float.
 */
export function coerceCell(col: BulksheetColumn, v: unknown): CellValue {
  if (v == null || v === '') return null
  // Enum columns are written in the vocabulary's OWN spelling. Our DB stores
  // 'BROAD' and 'LEGACY_FOR_SALES'; the dropdown on the cell offers 'Broad' and
  // 'Dynamic bids - down only'. Emitting the raw DB value would make Excel flag
  // every one of those cells as violating its own validation list. An
  // unrecognised value exports blank rather than as something the sheet rejects.
  if (col.vocabulary) return parseVocabulary(col.vocabulary, String(v))
  switch (col.type) {
    case 'money': {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    case 'int':
    case 'percent': {
      const n = Number(v)
      return Number.isFinite(n) ? Math.round(n) : null
    }
    case 'date':
      return v instanceof Date ? v : new Date(String(v))
    default:
      return String(v)
  }
}

function columnSpecs(): SheetColumnSpec[] {
  return COLUMNS.map((c) => ({
    header: c.header,
    type: c.type,
    // Dropdowns are a UX aid only — Numbers silently drops all data validation,
    // so the server-side validator is the only real gate.
    allowedValues: c.vocabulary ? VOCABULARIES[c.vocabulary].values : undefined,
    headerNote: `${c.definition}${c.editable ? '' : '\n(read-only)'}`,
  }))
}

export interface BuildResult {
  buffer: Buffer
  rowCount: number
}

/**
 * Build the workbook. `rows` are keyed by canonical header; the column order,
 * typing and formatting all come from the schema.
 */
export async function buildBulksheetWorkbook(rows: Iterable<BulksheetRow>): Promise<BuildResult> {
  const writer = await createWriter()

  writer.addSheet({
    name: SP_SHEET,
    columns: columnSpecs(),
    // Header row plus Product/Entity/Operation, so scrolling right never orphans
    // a row. Numbers only supports freezing leading rows/columns, so keep it small.
    freeze: { rows: 1, columns: 3 },
  })

  let rowCount = 0
  for (const r of rows) {
    await writer.addRow(SP_SHEET, COLUMNS.map((c) => coerceCell(c, r[c.header])))
    rowCount++
  }

  // Generated from the same object that produced the sheet above — a
  // hand-maintained dictionary is a second source of truth that goes stale.
  writer.addSheet({
    name: DICTIONARY_SHEET,
    columns: DICTIONARY_HEADERS.map((h) => ({ header: h, type: 'text' as const })),
    freeze: { rows: 1, columns: 1 },
  })
  for (const d of buildDictionaryRows()) await writer.addRow(DICTIONARY_SHEET, d)

  return { buffer: await writer.toBuffer(), rowCount }
}

export { HEADERS }

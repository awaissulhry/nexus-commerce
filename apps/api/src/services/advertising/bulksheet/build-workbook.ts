/**
 * AX-IE.2/.3 — build the bulksheet workbook from the shared schema.
 *
 * The columns, cell types, number formats, dropdowns and the Dictionary all come
 * from ONE object (@nexus/shared/ads-bulksheet). Adding a column is editing that
 * array; nothing here enumerates columns.
 *
 * Sheets, in tab order:
 *   README                       what this is, what it covers, how to re-upload
 *   Sponsored Products Campaigns the editable grid
 *   Portfolios                   portfolio rows
 *   Dictionary                   generated from the schema, never hand-written
 *   _meta                        hidden — export id, schema version, coverage
 *
 * NOT here yet, and deliberately: the Sponsored Brands and Sponsored Display
 * sheets. Their column sets under bulksheets 2.0 cannot be confirmed without one
 * real Seller Central bulksheet download — Amazon publishes no machine-readable
 * schema and its docs site is a client-rendered SPA. Emitting a guessed SB/SD
 * layout would be exactly the kind of plausible-but-wrong output this whole
 * engagement exists to remove. See docs/AX-IE-0-1-PLAN.md §5.
 */

import {
  COLUMNS, HEADERS, VOCABULARIES, DICTIONARY_HEADERS, buildDictionaryRows, parseVocabulary,
  META_HEADERS, ROW_KEY_HEADER, BASELINE_HEADER, computeBaseline, BULKSHEET_SCHEMA_VERSION, toAmazonDate,
  type BulksheetColumn,
} from '@nexus/shared/ads-bulksheet'
import { createWriter, type CellValue, type SheetColumnSpec } from './spreadsheet-adapter.js'

export const SP_SHEET = 'Sponsored Products Campaigns'
export const PORTFOLIOS_SHEET = 'Portfolios'
export const DICTIONARY_SHEET = 'Dictionary'
export const README_SHEET = 'README'
export const META_SHEET = '_meta'

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
    case 'ratio': {
      // Stored as a FRACTION and formatted '0.00%' — Amazon's own convention.
      // Writing "46.88%" as text would destroy sorting and re-import.
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    case 'date': {
      // Amazon's bulksheet uses YYYYMMDD, so emit that rather than a Date serial.
      const d = v instanceof Date ? v : new Date(String(v))
      return Number.isNaN(d.getTime()) ? null : toAmazonDate(d)
    }
    default:
      return String(v)
  }
}

function columnSpecs(): SheetColumnSpec[] {
  const cols: SheetColumnSpec[] = COLUMNS.map((c) => ({
    header: c.header,
    type: c.type,
    // Dropdowns are a UX aid only — Numbers silently drops all data validation,
    // so the server-side validator remains the only real gate.
    allowedValues: c.vocabulary ? VOCABULARIES[c.vocabulary].values : undefined,
    headerNote: `${c.definition}${c.editable ? '' : '\n(read-only)'}`,
  }))
  // Identity columns last and hidden: present for the round trip, out of the way
  // for the human. Never edit-worthy.
  for (const h of META_HEADERS) {
    cols.push({
      header: h,
      type: 'text',
      hidden: true,
      headerNote: h === ROW_KEY_HEADER
        ? 'Internal row identity. The only key used to match this row on re-upload — do not edit or delete.'
        : 'Fingerprint of this row\'s editable values at export time. Used to detect that someone changed the entity on Amazon since you downloaded — do not edit.',
    })
  }
  return cols
}

export interface WorkbookCoverage {
  /** Entity kinds actually present in the sheet. */
  entities: string[]
  /** Entity kinds knowingly absent, so the file cannot read as complete when it isn't. */
  excludes: string[]
  campaignsExported: number
  campaignsTotal: number
  truncated: boolean
  marketplaces: string[]
  /** Days of performance summed into the read-only metric columns. */
  performanceWindowDays: number
  /**
   * Which grains actually have performance data. Ours currently holds only
   * CAMPAIGN and PRODUCT_AD rows, so keyword and ad-group metrics are BLANK
   * rather than zero — a zero there would assert "no impressions" when the truth
   * is "never collected".
   */
  performanceGrains: string[]
}

export interface BuildResult {
  buffer: Buffer
  rowCount: number
  portfolioCount: number
  exportId: string
}

export interface BuildInput {
  rows: Iterable<BulksheetRow>
  portfolios?: Iterable<BulksheetRow>
  coverage: WorkbookCoverage
  exportId: string
  generatedAt: Date
}

const PORTFOLIO_COLUMNS: SheetColumnSpec[] = [
  { header: 'Portfolio ID', type: 'id' },
  { header: 'Portfolio name', type: 'text' },
  { header: 'State', type: 'enum', allowedValues: VOCABULARIES.state.values },
  { header: 'Budget amount', type: 'money' },
  { header: 'Budget currency', type: 'text' },
  { header: 'Budget policy', type: 'text' },
  { header: 'Start date', type: 'date' },
  { header: 'End date', type: 'date' },
  { header: 'In budget', type: 'text' },
]

export async function buildBulksheetWorkbook(input: BuildInput): Promise<BuildResult> {
  const { rows, portfolios, coverage, exportId, generatedAt } = input
  const writer = await createWriter()

  // 1 ── README. First tab, because the don't-do list has to be read before the
  // grid is touched, not after.
  writer.addSheet({ name: README_SHEET, columns: [{ header: 'Nexus — Amazon Ads bulksheet', type: 'text' }] })
  for (const line of readmeLines(coverage, generatedAt, exportId)) {
    await writer.addRow(README_SHEET, [line])
  }

  // 2 ── the editable grid
  writer.addSheet({
    name: SP_SHEET,
    columns: columnSpecs(),
    // Header row plus Product/Entity/Operation, so scrolling right never orphans
    // a row. Numbers only supports freezing leading rows/columns, so keep it small.
    freeze: { rows: 1, columns: 3 },
  })

  let rowCount = 0
  for (const r of rows) {
    const cells: CellValue[] = COLUMNS.map((c) => coerceCell(c, r[c.header]))
    cells.push(String(r[ROW_KEY_HEADER] ?? ''))
    // Computed here, from the same values being written, so the fingerprint can
    // never disagree with the cells it describes.
    cells.push(computeBaseline(String(r.Entity ?? ''), (h) => r[h]))
    await writer.addRow(SP_SHEET, cells)
    rowCount++
  }

  // 3 ── portfolios
  writer.addSheet({ name: PORTFOLIOS_SHEET, columns: PORTFOLIO_COLUMNS, freeze: { rows: 1, columns: 2 } })
  let portfolioCount = 0
  for (const p of portfolios ?? []) {
    await writer.addRow(PORTFOLIOS_SHEET, PORTFOLIO_COLUMNS.map((c) => coerceCellRaw(c.type, p[c.header])))
    portfolioCount++
  }

  // 4 ── Dictionary, generated from the same object that produced the grid. A
  // hand-maintained dictionary is a second source of truth that goes stale.
  writer.addSheet({
    name: DICTIONARY_SHEET,
    columns: DICTIONARY_HEADERS.map((h) => ({ header: h, type: 'text' as const })),
    freeze: { rows: 1, columns: 1 },
  })
  for (const d of buildDictionaryRows()) await writer.addRow(DICTIONARY_SHEET, d)

  // 5 ── _meta, hidden. Lets an uploaded file be matched to the export that
  // produced it, and makes two exports of "the same data" explain their difference.
  writer.addSheet({ name: META_SHEET, columns: [{ header: 'key', type: 'text' }, { header: 'value', type: 'text' }], hidden: true })
  for (const [k, v] of metaPairs(coverage, generatedAt, exportId, rowCount)) {
    await writer.addRow(META_SHEET, [k, v])
  }

  return { buffer: await writer.toBuffer(), rowCount, portfolioCount, exportId }
}

function coerceCellRaw(type: SheetColumnSpec['type'], v: unknown): CellValue {
  if (v == null || v === '') return null
  if (type === 'money') { const n = Number(v); return Number.isFinite(n) ? n : null }
  if (type === 'int' || type === 'percent') { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null }
  if (type === 'date') return v instanceof Date ? v : new Date(String(v))
  return String(v)
}

function metaPairs(c: WorkbookCoverage, at: Date, exportId: string, rowCount: number): Array<[string, string]> {
  return [
    ['exportId', exportId],
    ['schemaVersion', BULKSHEET_SCHEMA_VERSION],
    ['generatedAt', at.toISOString()],
    ['rowCount', String(rowCount)],
    ['campaignsExported', String(c.campaignsExported)],
    ['campaignsTotal', String(c.campaignsTotal)],
    ['truncated', String(c.truncated)],
    ['marketplaces', c.marketplaces.join(',')],
    ['performanceWindowDays', String(c.performanceWindowDays)],
    ['performanceGrains', c.performanceGrains.join(',')],
    ['entities', c.entities.join(',')],
    ['excludes', c.excludes.join(',')],
  ]
}

function readmeLines(c: WorkbookCoverage, at: Date, exportId: string): string[] {
  const editable = COLUMNS.filter((x) => x.editable).map((x) => x.header)
  const readOnly = COLUMNS.filter((x) => !x.editable).map((x) => x.header)
  return [
    'This file is your current Amazon Ads state. Edit it and upload it back.',
    '',
    `Generated  ${at.toISOString()}`,
    `Export id  ${exportId}`,
    `Schema     ${BULKSHEET_SCHEMA_VERSION}`,
    `Coverage   ${c.campaignsExported} of ${c.campaignsTotal} campaigns${c.truncated ? '  ** TRUNCATED **' : ''}`,
    `Markets    ${c.marketplaces.join(', ') || '—'}`,
    `Metrics    last ${c.performanceWindowDays} days, available for: ${c.performanceGrains.join(', ') || 'nothing yet'}`,
    '',
    'ABOUT THE PERFORMANCE COLUMNS',
    `  Impressions … ROAS are read-only context, summed over the last ${c.performanceWindowDays} days.`,
    `  They are populated for ${c.performanceGrains.join(' and ') || 'no grain yet'}. On every other row they are`,
    '  BLANK ON PURPOSE — we do not yet collect metrics at that grain, and writing 0',
    '  there would claim "no impressions" when the truth is "never collected".',
    '',
    'WHAT IS IN HERE',
    `  Included  ${c.entities.join(', ')}`,
    `  NOT yet   ${c.excludes.join(', ')}`,
    '',
    'HOW TO CHANGE SOMETHING',
    '  1. Find the row. Leave Operation blank on every row you do not want to touch.',
    '  2. Put Create, Update or Archive in Operation on the rows you DO want to change.',
    '  3. Edit the green (editable) columns only. Grey columns are read-only context.',
    '  4. Upload the file back. You will see a preview of every change before anything is applied.',
    '',
    'THE DON\'T-DO LIST',
    '  • Do not delete or edit the hidden _row_key / _baseline columns. They are how',
    '    a row is matched on the way back in, and how we detect that someone changed',
    '    the same entity in Seller Central while you were editing.',
    '  • Do not retype an id. Ids are text on purpose so that long numbers survive.',
    '  • Archive is IRREVERSIBLE on Amazon. There is no unarchive, by API or by UI.',
    '  • Match type cannot be changed. Amazon treats it as immutable: "changing" one',
    '    means archiving the target and creating a new one, which loses all of its',
    '    performance history. Create a new row instead.',
    '  • Write dates as yyyy-mm-dd. 03/04/2026 means March 4th in the US and April 3rd',
    '    in Italy, so anything ambiguous is rejected rather than guessed.',
    '  • Numbers (the Mac app) silently drops dropdowns and ignores sheet protection.',
    '    The file still uploads fine — every value is re-checked on the server.',
    '',
    `EDITABLE COLUMNS   ${editable.join(', ')}`,
    '',
    `READ-ONLY COLUMNS  ${readOnly.join(', ')}`,
  ]
}

export { HEADERS }

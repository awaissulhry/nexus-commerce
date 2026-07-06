/**
 * FF2.1 — Workbook parser: xlsx bytes → ParsedWorkbook.
 *
 * Pure function — reads ONLY; writes NOTHING to any DB or external service.
 *
 * Responsibilities:
 *   - Load the xlsx with exceljs.
 *   - Extract the hidden _meta sheet into the `meta` object.
 *   - Extract data sheets (Products / Amazon / eBay / Shopify) into `sheets`,
 *     keyed by sheet name → { headers[], rows[] }.
 *   - Normalise each cell via normalizeCell(), flagging Excel's silent mutations
 *     (numeric coercion, date serialisation, BOM, curly quotes, trailing spaces).
 *   - Never guess destructively: blank = no-change marker; __CLEAR__ = explicit clear.
 */
import ExcelJS from 'exceljs'
import { canonicalizeText } from './normalize.js'

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface ParsedCell { raw: unknown; value: string; warning?: string }
export interface ParsedRow { sheet: string; rowNumber: number; cells: Record<string, ParsedCell> }
export interface ParsedSheet { headers: string[]; rows: ParsedRow[] }
export interface ParsedWorkbook {
  sheets: Record<string, ParsedSheet>
  meta: { snapshotId?: string; schemaVersion?: string; markets?: Record<string, string[]> }
  parseWarnings: string[]
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Sheet names that carry metadata, not product/listing data. */
const NON_DATA_SHEETS = new Set(['README'])

// ── normalizeCell ─────────────────────────────────────────────────────────────

/**
 * Convert a raw exceljs cell value to a normalised `{ value, warning? }` pair.
 *
 * Rules (in evaluation order):
 *
 * 1. null / undefined / '' → { value: '' }
 *    Blank is the "no-change" sentinel downstream; never coerce to something.
 *
 * 2. '__CLEAR__' → { value: '__CLEAR__' }
 *    Explicit clear marker — kept verbatim so later stages can distinguish it
 *    from blank.
 *
 * 3. Date object → ISO date (YYYY-MM-DD) + 'date coercion' warning.
 *    Excel serialises dates as numbers; exceljs re-hydrates them to JS Dates
 *    when the cell carries a date numFmt. We emit the ISO-date portion and
 *    warn so the caller can verify time-zone expectations.
 *
 * 4. number → String(raw) + optional 'numeric coercion' warning.
 *    If the string representation contains 'e'/'E' (scientific notation) OR
 *    the magnitude is > 1e11 (potential precision loss on identifiers like
 *    EANs/GTINs), we flag it. The caller cannot know the column type here;
 *    the warning surfaces in the UI so the operator can verify.
 *
 * 5. boolean → 'true' or 'false'.
 *
 * 6. string → strip BOM + curly quotes + trim trailing whitespace.
 *    Leading apostrophe is preserved (a real ' prefix, e.g. Italian 'O sole mio).
 *    Safe transformations: no warning needed.
 *
 * 7. Fallback → String(raw) (covers ExcelJS rich-text objects, etc.)
 *
 * Note: String.replaceAll is intentionally avoided (constraint); .split().join()
 * used instead.
 */
export function normalizeCell(raw: unknown): { value: string; warning?: string } {
  // Rule 1 — null / empty
  if (raw == null || raw === '') return { value: '' }

  // Rule 2 — explicit clear sentinel
  if (raw === '__CLEAR__') return { value: '__CLEAR__' }

  // Rule 3 — Excel date (exceljs returns JS Date for date-formatted cells)
  // Use LOCAL date parts to avoid UTC off-by-one for late-night dates in non-UTC TZs.
  if (raw instanceof Date) {
    const y = raw.getFullYear()
    const m = String(raw.getMonth() + 1).padStart(2, '0')
    const d = String(raw.getDate()).padStart(2, '0')
    return { value: `${y}-${m}-${d}`, warning: 'date coercion' }
  }

  // Rule 4 — number
  if (typeof raw === 'number') {
    const s = String(raw)
    if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1 || Math.abs(raw) > 1e11) {
      return { value: s, warning: 'numeric coercion — verify identifier' }
    }
    return { value: s }
  }

  // Rule 5 — boolean
  if (typeof raw === 'boolean') {
    return { value: raw ? 'true' : 'false' }
  }

  // Rule 6 — string (the common path)
  if (typeof raw === 'string') {
    // NOTE: leading apostrophe (0x27) is intentionally NOT stripped here.
    // A real leading ‘ value (e.g. Italian ‘O sole mio) would be corrupted.
    // Delegate to canonicalizeText (shared with diff.ts) — BOM strip + curly
    // quotes + trimEnd — so file-side and DB-side canonicalisations are symmetric.
    return { value: canonicalizeText(raw) }
  }

  // Rule 7 — ExcelJS compound cell (formula result, rich-text, other objects)
  // By this point raw is not null, not a Date, not a number, not a boolean, not a string —
  // it must be a plain object (formula or rich-text cell from exceljs).
  const obj = raw as any
  if ('result' in obj) {
    // Formula cell: { formula: '=1+1', result: 2 }. Use the evaluated result.
    return { ...normalizeCell(obj.result), warning: 'formula cell — result used' }
  }
  if (Array.isArray(obj.richText)) {
    // Rich-text cell: { richText: [{ text: 'Hel', font: {...} }, { text: 'lo' }] }
    const text = (obj.richText as Array<{ text?: string }>).map(r => r.text ?? '').join('')
    return normalizeCell(text)
  }
  return { value: String(raw), warning: 'unrecognised cell type' }
}

// ── parseWorkbook ─────────────────────────────────────────────────────────────

/**
 * Parse an xlsx workbook from raw bytes into a ParsedWorkbook.
 *
 * Sheet processing:
 *   - '_meta'   → extract snapshotId / schemaVersion / markets into meta; NOT added to sheets.
 *   - 'README'  → skipped entirely; NOT added to sheets.
 *   - all other → parsed into ParsedSheet with headers (row 1) + rows (rows 2..n).
 *
 * @param bytes  Raw xlsx file content (e.g. from a multipart upload or artifact store).
 * @returns      Structured ParsedWorkbook. Never throws on individual cell errors;
 *               anomalies are collected into parseWarnings.
 */
export async function parseWorkbook(bytes: Uint8Array): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook()
  // Buffer.from(Uint8Array) returns Buffer<ArrayBuffer> in TS5.x; cast to satisfy
  // exceljs's older non-generic Buffer typedef (runtime is identical).
  await wb.xlsx.load(Buffer.from(bytes) as any)

  const sheets: Record<string, ParsedSheet> = {}
  const meta: ParsedWorkbook['meta'] = {}
  const parseWarnings: string[] = []

  for (const ws of wb.worksheets) {
    const name = ws.name

    // ── _meta sheet ───────────────────────────────────────────────────────────
    if (name === '_meta') {
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return // skip 'key | value' header

        const k = normalizeCell(row.getCell(1).value).value
        const v = normalizeCell(row.getCell(2).value).value
        if (!k) return // skip blank separator rows and fingerprint entries below '---'

        if (k === 'snapshotId') {
          meta.snapshotId = v
        } else if (k === 'schemaVersion') {
          meta.schemaVersion = v
        } else if (k.indexOf('markets.') === 0) {
          // e.g. 'markets.amazon' → channel key 'AMAZON'
          const channel = k.slice('markets.'.length).toUpperCase()
          if (!meta.markets) meta.markets = {}
          meta.markets[channel] = v
            ? v.split(',').map((s) => s.trim()).filter(Boolean)
            : []
        }
        // exportedAt and fingerprint rows are intentionally ignored here
      })
      continue
    }

    // ── README and other meta-only sheets — skip ──────────────────────────────
    if (NON_DATA_SHEETS.has(name)) continue

    // ── Data sheet (Products / Amazon / eBay / Shopify / ...) ─────────────────

    // Step 1: build a column-number → header-text map from row 1.
    // We track column numbers so data-row cell lookups stay aligned even when
    // there are gaps between header columns.
    const headerPairs: Array<[number, string]> = []
    ws.getRow(1).eachCell((cell, colNo) => {
      headerPairs.push([colNo, normalizeCell(cell.value).value])
    })
    // Guarantee ascending column order (eachCell should already be ordered, but be safe)
    headerPairs.sort((a, b) => a[0] - b[0])
    const headers = headerPairs.map(([, h]) => h)

    // Step 2: iterate data rows (2..n) and normalise each cell.
    const rows: ParsedRow[] = []

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return // already consumed as headers

      const cells: Record<string, ParsedCell> = {}

      for (let i = 0; i < headerPairs.length; i++) {
        const [colNo, headerText] = headerPairs[i]
        if (!headerText) continue // skip unnamed / gap columns

        const cell = row.getCell(colNo)
        const raw = cell.value
        const normalized = normalizeCell(raw)
        const parsed: ParsedCell = { raw, value: normalized.value }
        if (normalized.warning) {
          parsed.warning = normalized.warning
          parseWarnings.push(`${name}!R${rowNumber} ${headerText}: ${normalized.warning}`)
        }
        cells[headerText] = parsed
      }

      rows.push({ sheet: name, rowNumber, cells })
    })

    sheets[name] = { headers, rows }
  }

  return { sheets, meta, parseWarnings }
}

/**
 * UFX P7 — RFC-4180-aware clipboard tokenizer for the flat-file paste path
 * (audit #29). Excel / Google Sheets wrap a copied cell in double quotes when
 * it contains a newline or a tab; the previous `split('\n') → split('\t')`
 * pipeline exploded such a cell into extra rows/columns. This module parses
 * quoted fields (embedded newlines, tabs and `""` escapes) while staying
 * byte-identical to the legacy behavior for input that contains no quotes.
 *
 * Pure module — no React, unit-tested in paste-tokenizer.vitest.test.ts.
 */

/**
 * Tokenize clipboard text into rows × cells.
 *
 * - Delimiter defaults to TAB (what spreadsheets put on the clipboard).
 * - `\r\n` / `\r` are normalized to `\n`; inside quotes they become a plain
 *   `\n` inside the cell value.
 * - A field is treated as quoted only when it STARTS with `"`. Inside quotes:
 *   `""` is a literal quote, delimiters/newlines are literal. Text after the
 *   closing quote (before the next delimiter) is appended verbatim
 *   (Excel-lenient).
 * - An unbalanced quote (still open at end of input) means the text was never
 *   RFC-encoded (e.g. a lone cell that happens to start with `"`): fall back
 *   to the plain split so nothing is swallowed.
 * - Trailing blank lines are dropped (matching the legacy paste path), but
 *   interior blank rows are preserved.
 */
export function tokenizeClipboard(text: string, delimiter = '\t'): string[][] {
  if (!text) return []
  // Fast path — no quotes anywhere: guaranteed identical to the legacy split.
  if (!text.includes('"')) return plainSplit(text, delimiter)
  return tryRfc4180(text, delimiter) ?? plainSplit(text, delimiter)
}

/** Legacy behavior: normalize line endings, split, drop trailing blank rows. */
function plainSplit(text: string, delimiter: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const rows = lines.map((l) => l.split(delimiter))
  trimTrailingEmptyRows(rows)
  return rows
}

/** Strict-ish RFC-4180 parse; returns null when a quoted field never closes. */
function tryRfc4180(text: string, delimiter: string): string[][] | null {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let atFieldStart = true
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue } // escaped quote
        inQuotes = false; i++; continue // closing quote
      }
      if (c === '\r') { // normalize embedded CRLF / CR to LF
        field += '\n'
        i += text[i + 1] === '\n' ? 2 : 1
        continue
      }
      field += c; i++; continue
    }
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; i++; continue }
    if (c === delimiter) { row.push(field); field = ''; atFieldStart = true; i++; continue }
    if (c === '\n' || c === '\r') {
      row.push(field); rows.push(row)
      row = []; field = ''; atFieldStart = true
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += c; atFieldStart = false; i++
  }
  if (inQuotes) return null // unbalanced quote — input was never RFC-encoded
  row.push(field); rows.push(row)
  trimTrailingEmptyRows(rows)
  return rows
}

/** Drop trailing rows that are a single empty cell (keep at least one row). */
function trimTrailingEmptyRows(rows: string[][]): void {
  while (rows.length > 1) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') rows.pop()
    else break
  }
}

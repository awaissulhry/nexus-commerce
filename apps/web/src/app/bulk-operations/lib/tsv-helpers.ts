// TSV (tab-separated) parse + serialise helpers used for clipboard
// copy/paste between Excel/Sheets/Numbers and the bulk-ops grid.
// Plus value coercion for paste targets and a loose equality check
// used to detect "unchanged" cells during paste preview.

import type { FieldDef } from '../components/ColumnSelector'

/**
 * RFC 4180-style escaping applied to TSV. If a cell value contains a
 * tab, newline, or double-quote, the whole cell is wrapped in double
 * quotes and embedded quotes are doubled. Otherwise it's emitted as
 * plain text. Excel, Sheets, Numbers and Notion all paste this format
 * back into their grids correctly.
 */
export function toTsvCell(value: unknown): string {
  if (value == null) return ''
  const str = String(value)
  if (/[\t\n"]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

/**
 * Inverse of toTsvCell: parse a TSV string into a 2D grid handling
 * RFC 4180 quoting, escaped "" inside quoted cells, and CRLF / LF /
 * CR as row separators. Tabs separate cells.
 */
export function parseTsv(text: string): string[][] {
  const result: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === '\t') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      result.push(row)
      row = []
      cell = ''
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') {
      row.push(cell)
      result.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += ch
    i++
  }
  // Flush trailing cell — but don't push a phantom empty row when the
  // input ended with a final newline.
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    result.push(row)
  }
  return result
}

/** Coerce a raw clipboard string to the target field's value type. */
export function coercePasteValue(
  raw: string,
  field: FieldDef | undefined,
): { value: unknown; error?: string } {
  if (!field) return { value: raw }
  const trimmed = raw.trim()
  if (trimmed === '') return { value: null }
  if (field.type === 'number') {
    const num = Number(trimmed)
    if (Number.isNaN(num)) return { value: null, error: 'Not a number' }
    return { value: num }
  }
  if (field.type === 'select' && field.options && field.options.length > 0) {
    if (!field.options.includes(trimmed)) {
      return {
        value: null,
        error: `Must be one of: ${field.options.slice(0, 6).join(', ')}${
          field.options.length > 6 ? '…' : ''
        }`,
      }
    }
    return { value: trimmed }
  }
  // W2.1 — boolean. Operators paste 'true' / 'false' / '1' / '0' /
  // 'yes' / 'no' from spreadsheet exports; coerce against a known
  // vocabulary and reject anything else with a clear error.
  if (field.type === 'boolean') {
    const lower = trimmed.toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(lower))
      return { value: true }
    if (['false', '0', 'no', 'n', 'off'].includes(lower))
      return { value: false }
    return {
      value: null,
      error: `Must be true/false / 1/0 / yes/no (got "${trimmed}")`,
    }
  }
  return { value: trimmed }
}

export function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}

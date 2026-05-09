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
  // W2.3 — date / datetime. Accepts ISO 8601 + dd/mm/yyyy +
  // dd.mm.yyyy (Italian / German operator habit). Bad inputs surface
  // a clear error instead of silently falling back to text.
  if (field.type === 'date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { value: trimmed }
    const eu = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
    if (eu) {
      const [, dd, mm, yyyy] = eu
      return {
        value: `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`,
      }
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) {
      // W2.3 — local components, NOT toISOString: avoids the
      // CEST-shift bug where local midnight rolls back a day in UTC.
      const d = new Date(parsed)
      const pad = (n: number) => String(n).padStart(2, '0')
      return {
        value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      }
    }
    return { value: null, error: 'Use yyyy-mm-dd or dd/mm/yyyy' }
  }
  if (field.type === 'datetime') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return { value: trimmed }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) {
      const d = new Date(parsed)
      const pad = (n: number) => String(n).padStart(2, '0')
      return {
        value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      }
    }
    return { value: null, error: 'Use yyyy-mm-ddTHH:MM' }
  }
  // W2.4 — URL: accept any string that the URL constructor parses,
  // either as-is or with a https:// prefix. Reject obvious garbage.
  if (field.type === 'url') {
    try {
      const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? new URL(trimmed)
        : new URL(`https://${trimmed}`)
      return { value: u.toString().replace(/\/$/, '') }
    } catch {
      return { value: null, error: 'Not a valid URL' }
    }
  }
  // W2.4 — email: lightweight RFC-5322-ish check.
  if (field.type === 'email') {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { value: trimmed }
    return { value: null, error: 'Not a valid email' }
  }
  // W2.4 — phone: strip spaces / dashes / parens and re-check.
  if (field.type === 'phone') {
    const cleaned = trimmed.replace(/[\s().-]/g, '')
    if (/^\+?\d{4,15}$/.test(cleaned)) return { value: cleaned }
    return { value: null, error: 'Use a phone number with optional + prefix' }
  }
  // W2.6 — multiSelect: comma / semicolon / pipe separated, or a
  // JSON array. When meta.options is present, validate each entry
  // against the allowed set.
  if (field.type === 'multiSelect' || field.type === 'string_array') {
    let parts: string[]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed)
        parts = Array.isArray(parsed) ? parsed.map((x) => String(x).trim()) : []
      } catch {
        parts = []
      }
    } else {
      parts = trimmed.split(/[,;|]/).map((x) => x.trim()).filter((x) => x.length > 0)
    }
    parts = Array.from(new Set(parts.filter((x) => x.length > 0)))
    if (field.options && field.options.length > 0) {
      const allowed = new Set(field.options)
      const invalid = parts.filter((x) => !allowed.has(x))
      if (invalid.length > 0) {
        return {
          value: null,
          error: `Unknown values: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`,
        }
      }
    }
    return { value: parts }
  }
  // W2.7 — image: any string the URL constructor accepts (with a
  // protocol; W11 will add an upload-from-paste path for local
  // images). Same coercion as 'url' minus the prefix-completion since
  // a thumbnail-rendering cell needs a real fetchable URL.
  if (field.type === 'image') {
    try {
      const u = new URL(trimmed)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return { value: u.toString() }
      }
      return { value: null, error: 'Image URL must be http or https' }
    } catch {
      return { value: null, error: 'Not a valid image URL' }
    }
  }
  // W2.5 — color: accepts #rrggbb, #rgb, rgb(), or a named color.
  if (field.type === 'color') {
    const lower = trimmed.toLowerCase()
    const long = lower.match(/^#?([0-9a-f]{6})$/)
    if (long) return { value: `#${long[1]}` }
    const short = lower.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/)
    if (short) {
      return {
        value: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`,
      }
    }
    const rgb = lower.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/)
    if (rgb) {
      const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((x) =>
        Math.max(0, Math.min(255, parseInt(x, 10))),
      )
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      return { value: `#${hex(r)}${hex(g)}${hex(b)}` }
    }
    return { value: null, error: 'Use #rrggbb, #rgb, rgb(r,g,b) or a named color' }
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

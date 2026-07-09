import type { FlatFileColumn } from './FlatFileGrid.types'

const byteLen = (s: string) => new TextEncoder().encode(s).length

/**
 * Normalize a STRING value written into a cell by a BULK path (paste, fill-down /
 * fill-right, find-replace, AI) so it obeys the same rules the interactive editor
 * enforces. Returns the normalized string to write, or `null` to REJECT the write
 * entirely (the caller keeps the cell's previous value — it never blanks it).
 *
 * Rules by column kind:
 *  - boolean          → coerced to 'true' / 'false' / '' (unrecognized → '').
 *  - enum (strict,     → accepted only if it case-insensitively matches an option,
 *    single-value)       normalized to the option's canonical casing; '' clears;
 *                        anything else is REJECTED. Open enums + multi-value enums
 *                        are treated as free text (suggestions), unchanged here.
 *  - number           → must coerce to a finite number ('' clears); non-numeric is
 *                        REJECTED; a value below `col.min` clamps up to `col.min`.
 *                        A valid number keeps the operator's exact (trimmed) text so
 *                        e.g. "29.90" is not reformatted to "29.9".
 *  - text / longtext  → clamped to maxLength (chars) and maxUtf8ByteLength (bytes).
 */
export function normalizeCellValue(col: FlatFileColumn, value: string): string | null {
  if (col.kind === 'boolean') {
    const t = value.trim().toLowerCase()
    return ['true', 'yes', '1', 'y', 't'].includes(t)
      ? 'true'
      : ['false', 'no', '0', 'n', 'f'].includes(t)
        ? 'false'
        : ''
  }

  // Strict, single-value enum (SELECTION_ONLY, e.g. Follow/Pinned, row Action):
  // the channel only accepts listed values, so a bulk-pasted junk string must not
  // slip through. Open enums (suggestions) and multi-value enums keep free text.
  if (col.kind === 'enum' && col.enumMode === 'strict' && !col.multiValue && Array.isArray(col.options)) {
    const t = value.trim()
    if (t === '') return ''
    const match = col.options.find((o) => o.toLowerCase() === t.toLowerCase())
    return match ?? null
  }

  if (col.kind === 'number') {
    let t = value.trim()
    if (t === '') return ''
    // Comma-decimal support (Italian operators type "12,50"): a SINGLE comma used
    // as the decimal separator is normalized to a dot. Mixed thousands formats like
    // "1.234,56" stay REJECTED — ambiguous, so the previous value is kept.
    if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.')
    const n = Number(t)
    if (Number.isNaN(n)) return null
    if (typeof col.min === 'number' && n < col.min) return String(col.min)
    return t
  }

  // text / longtext / open enum / multi-value enum: length clamps only.
  let out = value
  if (col.maxLength && out.length > col.maxLength) out = out.slice(0, col.maxLength)
  if (col.maxUtf8ByteLength) {
    while (out && byteLen(out) > col.maxUtf8ByteLength) out = out.slice(0, -1)
  }
  return out
}

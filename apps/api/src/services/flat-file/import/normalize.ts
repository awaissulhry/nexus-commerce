/**
 * FF2 — Shared text/decimal canonicalisers.
 *
 * Used by BOTH the parser (file side, parse.ts) and the diff (DB side, diff.ts)
 * so that comparisons are symmetric — identical transformations on both sides
 * guarantee round-trip identity for real Italian product data.
 *
 * Note: String.replaceAll is intentionally avoided (constraint); .split().join()
 * and .replace(/…/g,…) used instead.
 */

/**
 * Canonicalise a text string:
 *   1. Strip leading BOM (U+FEFF) — Excel sometimes emits it in UTF-8-encoded cells.
 *   2. Normalise curly single quotes → straight single quote (U+0027).
 *   3. Normalise curly double quotes → straight double quote (U+0022).
 *   4. Trim trailing whitespace (regex, NOT trimEnd — avoids replaceAll constraint).
 */
export function canonicalizeText(s: string): string {
  let t = s
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)           // strip BOM
  t = t.split('‘').join("'").split('’').join("'") // curly single quotes
  t = t.split('“').join('"').split('”').join('"') // curly double quotes
  t = t.replace(/\s+$/, '')                                  // trimEnd (regex)
  return t
}

/**
 * Canonicalise a decimal string so that different locale-specific and
 * precision-padded representations of the same value compare as equal.
 *
 * Transformations applied (in order):
 *   1. Trim surrounding whitespace + remove internal spaces (e.g. '1 234,56' → '1234,56').
 *   2. If BOTH '.' and ',' present → IT thousands/decimal format (e.g. '1.234,56' → '1234.56').
 *   3. Else if only ',' present → comma-decimal (e.g. '189,90' → '189.90').
 *   4. Number-normalise: parse as Number and stringify → removes trailing zeros
 *      ('189.90' → '189.9', '189.9' → '189.9') — idempotent on a clean value.
 *
 * Returns the original string unchanged when the result is NaN (non-numeric input).
 */
export function canonicalizeDecimal(s: string): string {
  let t = s.trim().split(' ').join('')
  if (t.indexOf('.') !== -1 && t.indexOf(',') !== -1) {
    // Italian thousands-separator '.' + decimal-separator ',' → standard dot decimal
    t = t.split('.').join('').split(',').join('.')
  } else if (t.indexOf(',') !== -1) {
    // Comma-only → treat as decimal separator
    t = t.split(',').join('.')
  }
  const n = Number(t)
  return Number.isNaN(n) ? s : String(n)
}

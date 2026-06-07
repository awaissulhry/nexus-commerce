/**
 * FFA.1 — locale-tolerant number parsing for flat-file price/qty.
 *
 * `parseFloat("19,99")` is 19 in JS — an Italian operator typing "19,99" would
 * silently send €19 to Amazon. This normalizes common European + US formats and
 * stray currency symbols/spaces before parsing, at the backend choke points
 * (feed body, DB sync, collapsed attributes).
 *
 * Rules:
 *  - strip everything except digits . , and a leading minus
 *  - both '.' and ',' present → the RIGHTMOST is the decimal, the other is a
 *    thousands separator ("1.234,56"→1234.56 · "1,234.56"→1234.56)
 *  - only ',' → decimal if 1–2 digits follow ("19,99"→19.99), else thousands
 *    ("1,234"→1234)
 *  - multiple '.' → thousands ("1.234.567"→1234567); single '.' → decimal
 */
export function parseLocaleNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null

  let s = String(raw).trim()
  if (!s) return null

  const negative = /^-/.test(s.replace(/[^\d.,-]/g, ''))
  s = s.replace(/[^\d.,]/g, '') // drop currency symbols, spaces, minus (re-applied below)
  if (!s) return null

  const hasDot = s.includes('.')
  const hasComma = s.includes(',')

  // A lone separator with 1–2 trailing digits is a decimal ("19,99","1.5");
  // otherwise it's a thousands separator ("1.000","1,234","1.234"). This is for
  // price/qty (never 3-decimal), so the heuristic is safe in this context.
  const singleSep = (str: string, sep: string): string => {
    const parts = str.split(sep)
    if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) return `${parts[0]}.${parts[1]}`
    return parts.join('')
  }

  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.') // EU: "1.234,56" → 1234.56
    } else {
      s = s.replace(/,/g, '') // US: "1,234.56" → 1234.56
    }
  } else if (hasComma) {
    s = singleSep(s, ',')
  } else if (hasDot) {
    s = singleSep(s, '.')
  }

  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

/** Integer variant for quantities (truncates the parsed number). */
export function parseLocaleInt(raw: unknown): number | null {
  const n = parseLocaleNumber(raw)
  return n === null ? null : Math.trunc(n)
}

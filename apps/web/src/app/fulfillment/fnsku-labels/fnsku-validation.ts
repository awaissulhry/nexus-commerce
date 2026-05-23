// Amazon FNSKU format: exactly 10 alphanumeric characters, always starting with X.
// Real examples: X0029S704D, X001HHJSXJ. ASINs also fit /^B0[A-Z0-9]{8}$/ — a common
// paste mistake — so we additionally flag ASIN-shaped values as "looks like ASIN".

const FNSKU_RE = /^X[A-Z0-9]{9}$/
const ASIN_RE  = /^B0[A-Z0-9]{8}$/

export function isValidFnskuFormat(value: string): boolean {
  return FNSKU_RE.test(value.trim().toUpperCase())
}

/** Returns a short, user-friendly hint describing what's wrong, or null if valid. */
export function fnskuFormatHint(value: string): string | null {
  const v = value.trim().toUpperCase()
  if (v.length === 0) return null
  if (FNSKU_RE.test(v)) return null
  if (ASIN_RE.test(v)) return 'Looks like an ASIN — FNSKU starts with X'
  if (v.length !== 10) return `Need 10 chars, got ${v.length}`
  if (!v.startsWith('X')) return 'FNSKU must start with X'
  return 'Invalid characters (use A-Z, 0-9 only)'
}

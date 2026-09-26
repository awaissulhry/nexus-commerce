/**
 * Canonical data formatters — one definition for the platform (consolidates the
 * duplicated ads `format.ts`). Money is cents-based (Amazon convention); the
 * locale is fixed (`en-IE` / `en-GB`) so SSR and client render identically.
 */

/** cents → "€1,284.00" */
export const eur = (cents: number | null | undefined) =>
  cents == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)

/** cents → "€1,284" (no decimals — dense tiles/bars) */
export const eur0 = (cents: number | null | undefined) =>
  cents == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents / 100)

/** Amazon reports store cost in micros (1e6). micros → "€" */
export const eurMicros = (micros: number | bigint | null | undefined) =>
  micros == null ? '—' : eur(Number(micros) / 10_000)

/** rounded integer with grouping → "1,284" */
export const num = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n))

/** ratio → "14.9%" (input is a fraction, e.g. 0.149) */
export const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)

/** multiplier → "2.40×" */
export const x2 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}×`)

/** ISO/Date → "22 Jun 2026" */
export const formatDate = (value: string | Date | null | undefined) => {
  if (value == null) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * bytes → "673 KB" · "1.8 MB" · "999 B". Binary steps (1024), like the size guard in
 * `FileDropzone`, and never four digits: from 1000 of a unit it reads in the next one
 * ("1.0 KB" for 1000 B). One decimal below 10 so a small file still shows its size, whole
 * numbers above.
 */
export const formatBytes = (bytes: number | null | undefined) => {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  const last = BYTE_UNITS.length - 1
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < last) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  const tenths = Math.round(value * 10) / 10
  if (tenths < 10) return `${tenths.toFixed(1)} ${BYTE_UNITS[unit]}`
  const whole = Math.round(value)
  if (whole >= 1000 && unit < last) return `1.0 ${BYTE_UNITS[unit + 1]}`
  return `${whole} ${BYTE_UNITS[unit]}`
}

/**
 * elapsed milliseconds → "12 s" · "1 min 1 s" · "1 h 2 min". Whole seconds, floored, so a
 * ticking display never runs ahead of the clock; a negative span (a start time from a clock that
 * is ahead of this one) reads "0 s".
 */
export const formatElapsed = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return `${minutes} min ${seconds} s`
  return `${seconds} s`
}

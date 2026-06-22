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

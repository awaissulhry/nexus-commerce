/** Shared advertising formatters — one definition instead of ~12 per-file
 *  copies. Cents-based money, counts, percentages, multipliers. */

export const eur = (c: number | null | undefined) =>
  c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)

/** Whole-euro variant (no decimals) for dense KPI tiles / bars. */
export const eur0 = (c: number | null | undefined) =>
  c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)

export const num = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n))

export const pct = (v: number | null | undefined, dp = 1) =>
  v == null ? '—' : `${(v * 100).toFixed(dp)}%`

export const x2 = (v: number | null | undefined) =>
  v == null ? '—' : `${v.toFixed(2)}×`

/** Amazon reports store cost in micros (1e6). Convert micros → display €. */
export const eurMicros = (micros: number | bigint | null | undefined) =>
  micros == null ? '—' : eur(Number(micros) / 10_000)

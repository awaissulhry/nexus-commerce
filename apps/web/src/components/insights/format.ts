// Locale-aware formatters for /insights. Mirrors the dashboard
// overview's it-IT defaults; Xavia operator reads in Italian so all
// number formatting (decimal/thousand separators) follows it-IT.

export const PCT_FMT = new Intl.NumberFormat('it-IT', {
  style: 'percent',
  maximumFractionDigits: 1,
})

export const NUM_FMT = new Intl.NumberFormat('it-IT')

export const COMPACT_NUM_FMT = new Intl.NumberFormat('it-IT', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const currencyFormatters = new Map<string, Intl.NumberFormat>()
const compactCurrencyFormatters = new Map<string, Intl.NumberFormat>()

export function currencyFormatter(code: string): Intl.NumberFormat {
  const cached = currencyFormatters.get(code)
  if (cached) return cached
  const fresh = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 0,
  })
  currencyFormatters.set(code, fresh)
  return fresh
}

export function compactCurrencyFormatter(code: string): Intl.NumberFormat {
  const cached = compactCurrencyFormatters.get(code)
  if (cached) return cached
  const fresh = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: code,
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  compactCurrencyFormatters.set(code, fresh)
  return fresh
}

export function formatCurrency(n: number, code: string): string {
  return currencyFormatter(code).format(Math.round(n))
}

export function formatCurrencyCompact(n: number, code: string): string {
  return compactCurrencyFormatter(code).format(n)
}

export function formatPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return PCT_FMT.format(n / 100)
}

export function formatNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return NUM_FMT.format(n)
}

export function formatNumCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return COMPACT_NUM_FMT.format(n)
}

export type DeltaTone = 'pos' | 'neg' | 'flat' | 'na'

export function deltaTone(
  pct: number | null | undefined,
  invert = false,
): DeltaTone {
  if (pct == null || Number.isNaN(pct)) return 'na'
  if (Math.abs(pct) < 0.5) return 'flat'
  const positive = pct > 0
  if (invert) return positive ? 'neg' : 'pos'
  return positive ? 'pos' : 'neg'
}

export function formatDelta(
  pct: number | null | undefined,
): { label: string; sign: string } {
  if (pct == null || Number.isNaN(pct)) return { label: '—', sign: '' }
  if (Math.abs(pct) < 0.5) return { label: '0%', sign: '' }
  const sign = pct > 0 ? '+' : ''
  return { label: `${sign}${pct.toFixed(1)}%`, sign }
}

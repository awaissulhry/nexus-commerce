// AD.2 — shared formatters for Trading Desk surfaces.

export function formatEur(cents: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function formatEurAmount(amount: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatPct(value: number | null): string {
  if (value == null) return '—'
  return `${(value * 100).toFixed(1)}%`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('it-IT').format(value)
}

/** Margin band classifier — used by profit lens row coloring. */
export function marginBand(marginPct: number | null): 'good' | 'warn' | 'bad' | 'none' {
  if (marginPct == null) return 'none'
  if (marginPct >= 0.15) return 'good'
  if (marginPct >= 0.05) return 'warn'
  return 'bad'
}

export const MARGIN_BAND_CLASS: Record<'good' | 'warn' | 'bad' | 'none', string> = {
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  bad: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  none: 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
}

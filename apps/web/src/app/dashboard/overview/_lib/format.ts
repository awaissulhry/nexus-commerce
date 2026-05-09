// Number / currency / delta formatting for the Command Center.
//
// DO.1 — currency formatting is driven by the active currency code,
// not a hardcoded glyph. Italian locale ('it-IT') gives the right
// thousand/decimal separators regardless of currency.
//
// Cache one Intl.NumberFormat per currency code to avoid the per-
// render allocation cost when the dashboard re-renders.

import type { T } from './types'

export const PCT_FMT = new Intl.NumberFormat('it-IT', {
  style: 'percent',
  maximumFractionDigits: 1,
})

export const NUM_FMT = new Intl.NumberFormat('it-IT')

const currencyFormatters = new Map<string, Intl.NumberFormat>()

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

export function formatCurrency(n: number, code: string): string {
  return currencyFormatter(code).format(Math.round(n))
}

export function formatDelta(
  pct: number | null,
  t: T,
): {
  label: string
  tone: 'pos' | 'neg' | 'flat' | 'na'
} {
  if (pct === null) return { label: t('overview.delta.na'), tone: 'na' }
  if (Math.abs(pct) < 0.5)
    return { label: t('overview.delta.flat'), tone: 'flat' }
  return {
    label: PCT_FMT.format(pct / 100),
    tone: pct > 0 ? 'pos' : 'neg',
  }
}

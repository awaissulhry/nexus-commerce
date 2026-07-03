/**
 * ER1 — transitional cents formatters for pages awaiting their ER3 rebuild
 * slot. Rebuilt surfaces use `money()` from campaigns/_grid/format (C7 —
 * currency-aware, never hardcoded €). These remain for the v1 pages only.
 */
export const eurC = (cents?: number | null): string =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })
export const pctP = (p?: number | null, dp = 1): string => (p == null ? '—' : `${p.toFixed(dp)}%`)
export const intlN = (n?: number | null): string => (n == null ? '—' : Math.round(n).toLocaleString('en-IE'))

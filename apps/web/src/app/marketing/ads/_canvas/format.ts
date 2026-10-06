// Formatters for the ops canvas inspector, and for the ads screens that import them (Dashboard, Portfolios, …).
//
// 🔴 AM-30 — money, percent and ROAS are the console's ONE rendering (`campaigns/_grid/format.ts`, the Ad Manager's
// precision): €1,234.56, 38.02%, 2.31. They were whole euros, a 0–1-decimal percent and "2.3×" here, so the
// Dashboard, Portfolios, Suggestions and Mission Control each printed the same metric differently from the Ad Manager.
// `eur2` stays as a name for its callers; it is now the same as `eur`.
import { eur as eurMoney, pct as pctFraction, roasText } from '../campaigns/_grid/format'

export const eur = (n?: number): string =>
  typeof n === 'number' && Number.isFinite(n) ? eurMoney(n) : '—'

export const eur2 = eur

export const pct = (frac?: number): string =>
  typeof frac === 'number' && Number.isFinite(frac) ? pctFraction(frac) : '—'

export const intl = (n?: number): string => (typeof n === 'number' ? Math.round(n).toLocaleString('en-IE') : '—')

export const roas = (n?: number): string =>
  typeof n === 'number' && Number.isFinite(n) ? roasText(n) : '—'

export const ago = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

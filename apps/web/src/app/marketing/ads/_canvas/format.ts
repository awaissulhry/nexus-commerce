// Lightweight, dependency-free formatters for the ops canvas inspector.

export const eur = (n?: number): string =>
  typeof n === 'number' ? `€${Math.round(n).toLocaleString('en-IE')}` : '—'

export const eur2 = (n?: number): string =>
  typeof n === 'number'
    ? `€${n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'

export const pct = (frac?: number): string =>
  typeof frac === 'number' && Number.isFinite(frac) ? `${(frac * 100).toFixed(frac < 0.1 ? 1 : 0)}%` : '—'

export const intl = (n?: number): string => (typeof n === 'number' ? Math.round(n).toLocaleString('en-IE') : '—')

export const roas = (n?: number): string =>
  typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}×` : '—'

export const ago = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

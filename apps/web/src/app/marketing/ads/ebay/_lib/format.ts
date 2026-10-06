/**
 * ER1 — transitional cents formatters for pages awaiting their ER3 rebuild
 * slot. Rebuilt surfaces use `money()` from campaigns/_grid/format (C7 —
 * currency-aware, never hardcoded €). These remain for the v1 pages only.
 *
 * AM-30 — both now hand out the console's one rendering (`campaigns/_grid/format`): money €1,234.56, percent with 2
 * decimals (38.02%), as the Amazon Ad Manager shows them. `pctP` was 1 decimal ("38.0%").
 */
import { money, pct } from '../../campaigns/_grid/format'

export const eurC = (cents?: number | null): string => money(cents, 'EUR')
/** PERCENT POINTS in (38.02 = 38.02 %). */
export const pctP = (p?: number | null, dp = 2): string => (p == null || !Number.isFinite(p) ? '—' : pct(p / 100, dp))
export const intlN = (n?: number | null): string => (n == null ? '—' : Math.round(n).toLocaleString('en-IE'))

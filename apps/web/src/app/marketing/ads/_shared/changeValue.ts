/**
 * FB.3e (2026-08-21) — ONE formatter for an AdvertisingChange value, because there were three
 * units behind one untyped string and two surfaces printing it raw.
 *
 * The operator caught it on a live row: a bid change rendered "35 → 2" (read as "0.35 → 2")
 * when reality was €0.35 → €0.02. `oldValue`/`newValue` are stored as STRINGS, and the unit
 * depends entirely on the field:
 *
 *   · `bid` / `defaultBid`      — CENTS   (ads-mutation.service stringifies `bidCents`; verified
 *                                  by probe against 400 audited targets — bid-grid.service's note)
 *   · `dailyBudget`             — EUR decimal (the neighbouring budget fields are euros — the
 *                                  exact split reference_ads_action_log_budget_euros records)
 *   · `PLACEMENT_*`             — PERCENT
 *   · anything else (`state`…)  — a literal, printed as stored
 *
 * A formatter that cannot see the field cannot be honest about the value. Every renderer of a
 * change row goes through THIS map — a second copy is how the drawer and the account-wide
 * Change Log came to lie identically.
 */

import { currencySymbol } from '../_shell/adsMarkets'

const CENT_FIELDS = new Set(['bid', 'defaultBid'])
const EUR_FIELDS = new Set(['dailyBudget'])
const PCT_FIELDS = new Set(['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE'])

/**
 * CM-32 — `currency` is the market's own (ISO code): a UK row reads in pounds. It was "€" for every market. Callers
 * that know the row's market pass `currencyOf(market)`; the default keeps the euro for the callers that do not.
 * `null` means unknown: the number alone, never a made-up symbol.
 */
export function fmtChangeValue(v: string | null | undefined, field: string, currency: string | null = 'EUR'): string {
  if (v == null || v === '') return '—'
  if (PCT_FIELDS.has(field)) return `${v}%`
  if (CENT_FIELDS.has(field)) {
    const n = Number(v)
    // A non-numeric string in a cents field is a data fault — print it verbatim rather than
    // inventing €NaN; verbatim is at least debuggable.
    return Number.isFinite(n) ? money(n / 100, currency) : v
  }
  if (EUR_FIELDS.has(field)) {
    const n = Number(v)
    return Number.isFinite(n) ? money(n, currency) : v
  }
  return v
}

/** `€0.35` for EUR exactly as before; another currency by its own symbol; unknown → the bare number. */
function money(n: number, currency: string | null): string {
  if (currency === 'EUR') return `€${n.toFixed(2)}`
  if (!currency) return n.toFixed(2)
  const sym = currencySymbol(currency)
  return sym.length === 1 ? `${sym}${n.toFixed(2)}` : `${n.toFixed(2)} ${sym}`
}

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

const CENT_FIELDS = new Set(['bid', 'defaultBid'])
const EUR_FIELDS = new Set(['dailyBudget'])
const PCT_FIELDS = new Set(['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE'])

export function fmtChangeValue(v: string | null | undefined, field: string): string {
  if (v == null || v === '') return '—'
  if (PCT_FIELDS.has(field)) return `${v}%`
  if (CENT_FIELDS.has(field)) {
    const n = Number(v)
    // A non-numeric string in a cents field is a data fault — print it verbatim rather than
    // inventing €NaN; verbatim is at least debuggable.
    return Number.isFinite(n) ? `€${(n / 100).toFixed(2)}` : v
  }
  if (EUR_FIELDS.has(field)) {
    const n = Number(v)
    return Number.isFinite(n) ? `€${n.toFixed(2)}` : v
  }
  return v
}

'use client'

/**
 * SG.7 — the page's shared metric cells, lifted out of SuggestionsClient so the
 * Recommendations view renders through the SAME components (shared means exactly the same —
 * one dash, one € reading, one ACoS/ROAS dot treatment). Moved verbatim from
 * SuggestionsClient.tsx; no behaviour change.
 */

/** SG.2 — trailing 30-day performance for the entity; null = no rows in the window ("—"). */
export interface SuggestionMetrics {
  windowDays: number
  impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number
  acos: number | null; roas: number | null; ctr: number | null; cvr: number | null; cpcCents: number | null
}

/**
 * SG.2 — metric cells. A null `metrics` (no performance rows in the window — the COMMON case at
 * target grain, ~18% coverage) renders "—", never a confident 0. A null ratio inside real
 * metrics ("not measurable": zero denominator) also renders "—". Real zeros render as 0.
 */
export const NO_PERF = 'No performance rows for this entity in the last 30 days'
export const dash = (title = NO_PERF) => <span className="h10-sug-nd" title={title}>—</span>

export const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

/**
 * SG.2c/d — the ACoS traffic light, EXACTLY as H10 does it (operator's call, 2026-08-21:
 * "do the same as Helium 10"). Verified frame-by-frame (f_1361 upscaled: 29.4% green ·
 * 34.29% yellow · 102.61% red — green even ABOVE the coach's own 25% target, so H10's bands
 * are FIXED, not target-relative):
 *   green  < 30%   (comfortably profitable)
 *   yellow 30–100% (watch it — spend is eating the margin)
 *   red    ≥ 100%  (the ad spends more than it sells)
 * A row whose spend bought NO sales at all is red however the ratio reads (H10 shows
 * "0.00% ●red" there; we keep the honest "—" and give it the red dot with the reason).
 * The list payload also carries `ruleAcosPct` (the producing rule's own ACoS criterion) —
 * unused by the dot ON PURPOSE; flipping to criteria-adaptive bands is a one-line change here
 * if the operator ever asks again.
 */
export const ACOS_DOT_TIP = 'Green < 30% · yellow 30–100% · red ≥ 100% (spend exceeds sales) — Helium 10’s bands'
export function AcosCell({ m }: { m: SuggestionMetrics | null | undefined }) {
  if (!m) return dash()
  if (m.acos == null) {
    if (m.spendCents > 0) {
      return (
        <span className="h10-sug-num" title="This spend produced no attributed sales at all — the worst reading an ACoS can have">
          —<i className="h10-sug-dot r" aria-hidden />
        </span>
      )
    }
    return dash('Not measurable — no spend in this window')
  }
  const pct = m.acos * 100
  const cls = pct < 30 ? 'g' : pct < 100 ? 'a' : 'r'
  return (
    <span className="h10-sug-num" title={ACOS_DOT_TIP}>
      {pct.toFixed(2)}%
      <i className={`h10-sug-dot ${cls}`} aria-hidden />
    </span>
  )
}

/**
 * ROAS wears the SAME economics as H10's ACoS bands, inverted (ROAS = 1/ACoS):
 *   green ≥ 3.33 (≙ ACoS < 30%) · yellow 1–3.33 · red < 1 (sales below spend).
 * Spend that bought nothing renders 0.00 with the red dot; no spend → no judgment.
 */
export const ROAS_DOT_TIP = 'Green ≥ 3.33 · yellow 1–3.33 · red < 1 (sales below spend) — Helium 10’s ACoS bands, inverted'
export function RoasCell({ m }: { m: SuggestionMetrics | null | undefined }) {
  if (!m) return dash()
  if (m.roas == null) return dash('Not measurable — no spend in this window')
  const cls = m.roas >= 3.33 ? 'g' : m.roas >= 1 ? 'a' : 'r'
  return (
    <span className="h10-sug-num" title={ROAS_DOT_TIP}>
      {m.roas.toFixed(2)}
      <i className={`h10-sug-dot ${cls}`} aria-hidden />
    </span>
  )
}

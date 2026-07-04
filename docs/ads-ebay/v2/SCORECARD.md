# ER4 Scorecard — the eBay Ads console vs the field

Verdicts against COMPETITOR-TEARDOWN §7 (the beat-checklist seed), 2026-07-04. Evidence =
the phase gate reports (all prod-verified).

## What only we have (the moats) — all four SHIPPING

| # | Moat | Where it lives | Status |
|---|---|---|---|
| 1 | Per-listing **break-even from the commerce system** clamping every rate/bid/automation | `clampAutoRate` in the engine · Products break-even column + cost entry · rule editor's break-even benchmark (ER3.2) · builder rate steps (ER2) · dashboard "rates above break-even" recommendation (ER3.3) | ✅ shipping; deepened every phase |
| 2 | **Immutable audit + external-change drift detection + one-click re-apply/accept** | Drift tab (E-series, kept verbatim) · drift-accept rows classified `external (accepted)` in the account-wide Change Log (ER3.4) — H10 classifies external changes, cannot reconcile them | ✅ shipping |
| 3 | **Proposal rollback inverses** | Applied tab one-click rollback (hub, ER3.2 grid) · rate-discovery rollback restores rates + HALTs the plan (ER2) · Change Log rolled-back markers (ER3.4) | ✅ shipping |
| 4 | **Honest attribution framing** | "any-click" labels on every money surface; fees-vs-sales framing throughout (never "attributed ROI"); digest + dashboard footnotes; 72h reconciliation stated on pacing, windows, and rule templates (excludeRecentDays default) | ✅ shipping |

## What everyone has and we had to match — 6/6 landed

| Table stake (source) | Ours | Phase |
|---|---|---|
| Saved filter presets (H10 Filter Library) | AdsDataGrid `filterPresetsKey` — save/apply/rename/delete chips | ER3.1 |
| Automation visibility on the campaign row (H10) | ⚙ rule-count column + Protected/posture pills → `?tab=automation` | ER3.1 |
| Recommendations-as-prefilled-actions (Teika/Seller Hub) | Dashboard Recommendations panel: 5 live-computed types, transparent criteria, prefilled CTAs incl. margin-aware "rates above break-even" | ER3.3 |
| Benchmark-relative rule conditions (Pacvue) | Condition `benchmark × multiplier`: account avg · campaign avg · **break-even** (ours alone) | ER3.2 |
| Review-gated AI/automation output (Teika) | Every launch passes the Review step (gaps + acks + readiness); every automation flows PROPOSE→Suggestions unless explicitly AUTOPILOT within guardrails. No generative structure output exists yet to gate — the gate pattern is in place | ER2/ER3.2 (pattern) |
| "Limited by budget" derived states (Seller Hub) | Status pill + filterable LIMITED state + dashboard pacing chip deep link | ER3.1/ER3.3 |

## Adopted idioms — where each verdict landed

| Verdict (teardown) | Landed |
|---|---|
| H10 Suggestions queue ✓/✕-snooze/⏸ + Apply-N | ER3.2 (snooze/stop ride `expiresAt`; dismiss honestly re-suggests) |
| H10 Change Log incl. change-source | ER3.4 (automation / operator / external-accepted from recorded actors) |
| Teika Budget Pacing w/ honest lag | ER3.3 (straight-line projection labelled as such; 72h + 2× notes) |
| Pacvue noise guards / lookbacks | ER3.2 (AND conditions + per-condition windows + exclude-recent-days) |
| Seller Hub row Actions menu | ER3.1 (Enable/Pause · Budget… w/ 15-a-day meter · Clone… · End…) |
| Dry-run rule preview | ER3.2 — **beyond the field**: no competitor previews an unsaved rule against live data |

## Honest gaps (not claimed)

- No AI-generated campaign structures (Teika Smart Campaigns) — deliberate; the review
  gate exists for when/if that ships.
- ~~`estimatedImpact` unpopulated~~ — **CLOSED 2026-07-04 (E3)**: honest weekly
  extrapolations with the assumption stated on every suggestion.
- ~~No per-marketplace digest split~~ — **CLOSED 2026-07-04 (E2)**.
- ~~PRI listing-attach write-layer gap~~ — **CLOSED 2026-07-04 (E4)**: MANUAL Priority
  attaches into ad groups, Smart at campaign level; wizard no longer drops the selection.
- No hourly dayparting on eBay (the API has no hourly grain). Pacvue-for-eBay remains the
  only direct competitor product; our margin substrate + drift reconciliation + rollback
  remain unmatched there.

# E7 — Best-in-Class Campaign Builder (study + blueprint)

> Enterprise teardown (Pacvue Super Wizard, Perpetua goal launch, Adbrew automation-at-birth, Intentwise segmented wizard, Quartile, Skai mirroring/Budget Navigator, Optmyzr feed-synced builders, Google PMax objective cascade + Ad Strength, Rithum rate experiments, Webinterpret 2-choice onboarding + collision cleanup, 3Dsellers CSV+rules, Adspert gated goal ramp, eBay Seller Hub native) — full agent report with citations preserved in the session record; this doc carries the buildable spec.

## Cross-cutting patterns the leaders converge on
1 Goal-first, derive-everything · 2 Automation attached at birth · 3 Reusable versioned structure templates · 4 Creation as a standing inventory-sync contract · 5 Platform suggestions bounded by economics · 6 Gated goal ramps + bounded changes · 7 Preview-enumerate-push with row-level errors · 8 Completeness meters over blocking forms · 9 Collision handling as a first-class step · 10 Launch choreography + change transparency.

## The 25-item blueprint (each with acceptance criteria — agreed scope)
(a) Goal-first: 1 goal cards derive everything · 2 ≤3-decision quick launch · 3 inspectable/overridable Decisions panel · 4 one CampaignPlan object, quick+studio skins.
(b) Intelligence: 5 break-even-clamped suggested rate per listing (ours/eBay/trending/BE always together) · 6 fee forecast under 2026 any-click (trailing sales × attribution share × rate, live slider) · 7 keyword seeds from 3 tagged sources w/ clamped bids · 8 collision preflight (one-listing-one-General; skip/move/replace per listing) · 9 budget formula + learning ramp (ROAS rules unlock at ≥30 conversions).
(c) Automation attach: 10 rule packs as launch toggles (PROPOSE default) · 11 hard ceilings persisted on campaign · 12 fixed-rate default; DYNAMIC only capped + Floor Watch · 13 naming grammar + structured tags at birth.
(d) Templates: 14 four shipped versioned templates (Catch-All General / Hero Priority / Smart Probe / Clearance) · 15 catch-all + explicit overrides never clobbered · 16 clone-by-rematerialization (eBay cloneCampaign is ENDED-rules-only) · 17 granularity picker + sprawl cap (confirm >25 campaigns).
(e) Bulk: 18 Launch Plans (heterogeneous multi-campaign, per-item results, resumable repair) · 19 fan-out generator + future-bucket PROPOSE · 20 CSV round-trip + scheduled launches (DB clock) · 21 standing coverage guard + coverage KPI.
(f) Validation/launch: 22 preflight checklist blocking vs advisory + entity enumeration · 23 Launch Readiness meter (Ad Strength analog) · 24 "what happens next" timeline + day-7 check-in · 25 post-launch reconciliation diff + immutable event log.

## Implementation stages
- **Stage 1 (now)**: items 1,2,3,5(partial: ours+BE; no IT suggestion API),6,8,10,11(v1 via rule scope),13(naming),22(core checks),23,24(timeline card) — the goal-first builder with our unique intelligence.
- **Stage 2**: 4 (drafts/Studio), 7 (keyword seeding UI), 9 (ramp gating), 14–17 (template registry + clone-rematerialize + sprawl cap), 12 Floor Watch monitor.
- **Stage 3**: 18–21 (launch plans, fan-out proposals, CSV/scheduled, coverage guard KPI), 25 (divergence repair view; hourly sync already reconciles).

Native weaknesses we exploit (verified): suggested rates revenue-optimized for eBay w/o margin context; immutable 4-field rules; no dayparting; smart↔manual irreversibility; next-day budget latency; 2026 any-click opacity (80–90% attribution share); stealth floor raises (dynamic 2%→5% Nov 2024; Priority min CPC $0.20).

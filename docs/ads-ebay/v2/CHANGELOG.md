# eBay Ads Console v2 — Change Log (ER series)

All phases double-gated (spec → approval → build → prod verification → approval), all
prod-verified with Amazon before/after snapshots. No page shipped dark (D7: atomic).
Two reversible migrations total; every other phase migration-free.

## ER0 — Foundations (2026-07-03)
Docs only: AMAZON-PATTERN-LANGUAGE (§PL-1..10), COMPETITOR-TEARDOWN (+eBay fact table),
CURRENT-STATE-CRITIQUE (X1–X9), SPEC-campaign-detail, SPEC-campaign-builder, DECISIONS
(D1–D7 + ER3 order).

## ER1 — Campaign detail (2026-07-03) · `4a7a9c59` `26c3d259` `6dd02112`
Migration: `20260703_er1_campaign_automation_policy` (rollback: DROP TABLE).
Strategy-aware tab matrix · editable Details (scroll-spy + sticky footer) · NEW per-
campaign Automation tab (posture/Protected/caps — genuinely enforced by the evaluator) ·
routed ad-group drill-down · search-query report pipeline (CPC) · rename/end-date writes ·
criterion preview · X2 fixed console-wide (eBay wordmark).

## ER2 — Builder (2026-07-03) · `261ffc74` `f9e9c10f`
Migration: `20260703_er2_rate_discovery_plan` (rollback: DROP TABLE).
Type-card chooser + per-type stepper wizards (goal-first retired) · rules-based creation
with live criterion preview · multi-ad-group Priority launches · localStorage drafts ·
Rate Discovery ladder (bounded, BE-anchored, PROPOSE steps, rollback HALTs) · composable
builder endpoints (prefill deleted) · v1 endDate-drop found + fixed.

## ER3.1 — Ad Manager (2026-07-03) · `07aaa839` (+`5d683cbc` `46fbb63f`)
Automation column · Limited-by-budget derived state · Filter Library (additive
`filterPresetsKey`) · row menu Budget…/Clone…/End… (15-a-day meter before attempts) ·
DateRangePicker · ACOS+ROAS · hidden-ads visibility · Data Sync · dup-Export fix.

## ER3.2 — Rules & Automation hub (2026-07-03) · `0e312e5c` (+fixes)
Glass-box rule cards · routed condition-stack editor (benchmarks: account/campaign avg +
**break-even**; per-condition windows — v1's single-max-window defect fixed in scope;
exclude-recent-days honesty) · dry-run preview (zero writes) · Suggestions queue with
Why pane + Dismiss/Snooze/Stop (snooze rides `expiresAt`; plain-reject clearing bug
caught by smoke) · Applied grid with rollback · posture band decomposition · validated
rule CRUD + templates endpoint. 23 unit tests.

## ER3.3 — Dashboard (2026-07-03) · `95c59e5f` (+`ad17091c` `ea302d55`)
Recommendations panel (5 live types, transparent criteria, prefilled CTAs) · budget
pacing (MTD vs ceiling, straight-line projection, CPC utilisation, LIMITED deep link via
additive `initialFilters`) · Status decomposition · header DateRangePicker · trend metric
views · ROAS tile + sparklines + CVR · alert link-through (`campaignId` additive).
`GET /ebay-ads/dashboard`. 7 unit tests.

## ER3.4 — Products + Change Log (2026-07-03/04) · `3d6d182d` (+`09897bdc`)
Products: Promoted column (campaign chips + links), OOS/hidden badges, prose→tips, real
buttons, `?state=UNMATCHED` deep link, DateRangePicker, ROAS. Change Log (D4): rail entry
+ account-wide audit page with change-source classification (automation / operator /
external-accepted), campaign-name resolution, type filter, cursor paging; shared
`actionSummary` extracted. Root-caused the shared sticky-column defect (F1).

## ER3.5 — Weekly Digest (2026-07-04) · `5effcaa2`
12-week picker (+`GET /digests/:id`) · movers mini-table · per-proposal deep links into
the hub (`?tab=&highlight=`, additive `rowClassName`) · honest All-markets label · WoW
deltas.

## ER4 — Consistency & benchmark pass (2026-07-04) · `51328fcb` `5a66edc8` `81f60231` `24f11a2e`
ER4-AUDIT.md (C1–C14 side-by-side · component census · CSS audit · a11y/perf/i18n) ·
SCORECARD.md (beat-checklist verdicts: 4/4 moats shipping, 6/6 table stakes landed) ·
this changelog. Fixes applied on approval:
- **E1** `5a66edc8` — Run now greyed on disabled rules (evaluator only runs enabled).
- **F1** `81f60231` — sticky first column pins at `left:0` on `selectable={false}` grids
  (`.nosel` modifier; assumed 40px checkbox column overlaid column 2 under overflow —
  Amazon Budget Manager + 7 eBay grids; ER3.4 page workaround swept).
- **F2** `24f11a2e` — Total rows react to grid filters (function-form `total` over the
  filtered set; 6 Amazon detail-tab grids + eBay Ad Manager/Products migrated, 65+ totals;
  unfiltered values identical by construction). Verified live on GALE BROAD DE search
  terms (147→68 clicks with exact sum/ratio recompute) and the eBay Ad Manager.
Backlog carried: rule versioning.

## ER4 follow-ups — E2/E3/E4 (2026-07-04) · `8be9b657` `62b1dde7` `1f5e3a6c`
- **E2** — digest per-marketplace split (campaign-grain facts rolled up by marketplace;
  deleted campaigns land under "unknown"; older stored weeks render unchanged).
- **E3** — `estimatedImpact` on suggestions: rate steps scale fees with the rate,
  bid-downs framed as upper bounds, pauses show saved fees AND sales-at-risk, assumption
  stated on every row; kinds without a defensible model stay blank. 27 unit tests total.
- **E4** — Priority listing-attach: `promoteListings` serves CPC (MANUAL → required ad
  group, validated; Smart → campaign level; CPS guardrails untouched); the launch flow
  attaches staged listings to the first ad group and the wizard stops sending `items: []`.
  9-check sandbox smoke ALL PASS.

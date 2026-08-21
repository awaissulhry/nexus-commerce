# BP — Bid page + Bid builder perfection (Phase 0 study + P1–P6 build record)

**Date:** 2026-08-21 · **Status:** P1–P6 BUILT and locally verified end-to-end (operator approved
"go ahead"); **LOCAL AND UNCOMMITTED** — batch commit+push on the operator's command. Build record
in §6 below; the study (§0–§5) is unchanged.
**Operator laws added this session:** new components go INTO the design system; 100% round-trip
honesty — what displays is a real reading, what is changed reaches Amazon
(`feedback_100_percent_honest_ui`).
**Target:** `/marketing/ads/rules-automation/bid` (BidRulesClient → `_shared/RulesGrid`) and
`/marketing/ads/rules-automation/builder/bid` (`_shared/RuleBuilder` + `_schedule/CampaignSection`).
**Working mode (operator, this session):** everything stays LOCAL and uncommitted; verified via a
local web build against prod reads; one batch commit+push on the operator's command.

Measured on prod 2026-08-21 by clicking (Chrome, computed styles + geometry) and by
`apps/api/scripts/_bp0-census.mts` (read-only, `railway run`). References: the H10 frame study
(`docs/2026-08-16-ra-h10-reference-study.md` §3.2 · §4.1 · §5.2 · §5.3), the operator's Bid studies
(`docs/2026-08-11-bid-study.md` + `docs/2026-08-11-bid-page.md`), the W-series register
(`docs/2026-08-20-ra-w-series.md`), competitor research (2026-08-04 pair, obsidian 31,
COMMERCE-PLATFORM-RESEARCH Pacvue/Quartile, ads-ebay v2 teardown §2).

---

## 0 · The context that changes everything: W7

All 51 engine-native rules were **deleted** 2026-08-20 (backup
`docs/backups/2026-08-20-legacy-automation-rules.json`). **Every rule from here is
operator-authored in the builder** — so the BUILDER shape is now the only shape that will hold live
data, and every piece of two-shape handling that privileges the engine shape is now aimed at the
wrong half.

## 1 · Prod census (2026-08-21)

| fact | value |
|---|---|
| advertising rules · bid rules | **0 · 0** (clean slate confirmed) |
| pending suggestions | **1** — `__ea manual 1781961158143`, a 2026-06-20 TEST artifact, orphaned (its rule is deleted); holds the badge at 1 forever |
| rule templates | 0 |
| AD_TARGET-grain daily-perf rows, settled 14d | 4,744 rows · **521 distinct targets** · 260 with ≥1 click · **21 with a computable ACoS** · **18 pass the KEYWORD_HIGH_ACOS emit filter** (orders>0 · sales>0 · spend≥€2) |
| campaigns · ENABLED · ad groups | 220 · 86 · 289 |
| ENABLED positive targets | 2,739 · **595 at ≤3¢** · 445 flagged `suppressedFromBidCents` |
| campaign bounds | `minBidCents` on **0**, `maxBidCents` on **82** |

So: a default builder Bid rule (IF ACOS > x) has at most ~18–21 matchable target-contexts per tick
today; computed ops (`setCpc`, `targetAcos`) have ~260 targets with clicks to work from. Thin but
real — the target-grain report cycle (ADX tg cron) genuinely flows now, unlike the 2026-08-11 zeros.

## 2 · The wiring, verified end-to-end (code)

Builder save → `POST /advertising/automation-rules` (trigger `KEYWORD_HIGH_ACOS`) → stored
builder-shaped, **`enabled:false` + `dryRun:true` always** → evaluator cron `*/15`
(`advertising-rule-evaluator.job.ts`) builds ≤500 KEYWORD_HIGH_ACOS contexts from
`AmazonAdsDailyPerformance` (`sales7dCents`/`orders7d`, settled window) → `evaluateRule` translates
in-memory (`ads-rule-adapter.service.ts` → `bid_apply` with `minEur/maxEur/campaignIds`) →
`bid_apply` clamps to [max(0.05,min), max] and writes via `updateAdTargetWithSync` (5-min grace,
write gate). `control:'manual'` forces the propose path even at AUTO (a real safety belt).
Mode truth: `resolveAutonomy` — `!enabled → OFF`; else `autonomyLevel` (default PROPOSE);
**only AUTO writes**; PROPOSE queues `AdsRuleSuggestion` → `/marketing/ads/suggestions`.

## 3 · Findings — the gap matrix

**KEEP (verified good, do not touch)**
- K1 The page shape: header · tabs · ONE RulesGrid — H10 §3.2 exactly; empty state verbatim.
- K2 The grid's honesty machinery: two-shape criteria/threshold/lookback cells, held-not-disabled
  toggles, activity cell (wrote/waiting), failed-read ≠ empty, delete confirmation naming cascades.
- K3 `bid_apply`: one write path, computed ops refuse with named missing signals, clamps, grace
  window, gate. Better than anything in the competitor set at this grain.
- K4 CampaignSection: Products tab is REAL and fast (7 product lines, 89 campaign rows, honest
  per-line counts, per-tab search semantics). One shared picker, prop-extended.
- K5 Save protection for engine-native rules (EA5 `locked` levels) — dormant post-W7 but correct.
- K6 Templates backend (`AutomationRuleTemplate` + 3 routes) — live, empty.
- K7 The B5 overlay (builder over the grid, URL-driven, real hrefs preserved).

**FIX (defects, with evidence)**
- F1 🔴 **The arming path is broken for the only rule shape that will exist.** A builder rule is
  created `enabled:false`; the Control step's Automate/Manual writes only `actions[0].control`,
  which `resolveAutonomy` never reads. The grid's Automation toggle on a builder rule PATCHes
  `control` only — it changes neither `enabled` nor `autonomyLevel`, so **"On" renders and arms
  nothing** (mirror image of U12, which fixed the engine branch when 51/51 rules were engine rules;
  post-W7, 100% of rules take the builder branch). Create→Automate today = a rule that never runs,
  and nothing says so at creation.
- F2 🔴 **Frequency + Timezone are controls whose value changes no behaviour.** The adapter drops
  `schedule` at translation; no reader exists (grepped). The evaluator runs every 15 min on the
  trigger. Same "lie with a dropdown" class P2.1 purged for Lookback — and the grid's Frequency
  cell prints the stored schedule as fact for builder rules. Timezone default is PST for a
  Rome-based account.
- F3 🔴 **"No cap" is false copy.** `maxDailyAdSpendCentsEur` defaults to **€100/day** server-side
  when the field is blank; the input's placeholder says "No cap". `maxExecutionsPerDay` defaults to
  10 and is surfaced nowhere in the builder.
- F4 **The IF→THEN connector crosses the "Noise guard" label.** Measured: line x=352, label
  x 351–422 (`.h10-rb-conds:has(.cond.then)::before` spans the whole box; W5 put the noise row
  inside the span).
- F5 **The step nav is inert.** `scrollTo({behavior:'smooth'})` on `.h10-rb-body` moves ~6px and
  dies (measured; instant scroll works). Clicking "Advanced Settings" does nothing; scroll-spy
  stays on "Rule Name". Likely the scroll-spy's per-scroll `setActive` re-render churn cancelling
  the smooth animation; fix with instant/`scrollIntoView` + stable listener.
- F6 **Typography: family is fine, scale is not.** The builder IS Inter (measured — same family as
  the console), but its chrome runs 16px base / 16px-700 step nav / 20px-800 h2 against the
  console's 13–14px control scale; per-element normalization pass needed, verified numerically.
- F7 **Learn is a dead button** (no handler). H10 has a per-tab video pill. ⛔ placeholder rules
  apply — operator decides wire/remove/keep.
- F8 **Dead provenance filter.** Post-W7 the Legacy/Created-by-you filter can never light again
  (operator already flagged); it is also the only content of the page's "Filters" card, so the
  card itself is dead chrome.
- F9 **The orphan test suggestion** (`__ea manual…`) keeps the Suggestions badge at 1; approve/
  dismiss buttons point at a deleted rule.

**BUILD (from the H10 spec + adopt-list, verified missing)**
- B1 H10 Bid metrics we lack: **Current Bid** (context lacks `bidCents` — cheap addition) ·
  **Inventory** (commerce-signal; bigger, roadmap). We also carry `Orders` H10 lacks — keep.
- B2 H10 Bid actions we lack: **Revenue per Click** (bid = sales/clicks — computable from the
  context today) · **Current Bid × Target ACoS / ACoS** (needs Current Bid in context). We have
  `setCpc`, `targetAcos` (CPC×), pause/enable, min/max guardrails — the rest of §5.3 is covered.
- B3 **Per-rule lookback** (H10 Bid carries lookback per criteria block; we pin the trigger's fixed
  14d settled window with an honest note). Engine work: honour a per-rule `windowDays` in the
  KEYWORD_HIGH_ACOS context build. Per-BLOCK is H10's literal shape; per-RULE is the honest first
  step (one window per evaluation pass).
- B4 **Per-rule frequency made real** (supersedes B6's deferral — its premise was 51 shared-cron
  engine rules, which no longer exist): a due-check in the evaluator honouring the stored
  schedule+timezone turns F2's dead controls into real ones and makes the grid's Frequency cell
  true. H10 parity (nightly default).
- B5 **Named template archetypes** (research Tier-2 #11: archetypes get adopted, blank builders
  don't; H10 ships "Helium 10 Ads Default"). Seed 3–5 Bid templates as TEMPLATES (visible,
  editable, never auto-created rules) — operator picks the list.

**REFUSE (decided, with the reason on record)**
- R1 "Increase to Top of Search" bid action — C3 decision stands: no per-keyword ToS signal exists;
  the capability lives on the Placement tab.
- R2 Drag-to-reorder criteria blocks — H10's own release note: *"Order does not affect
  precedence"*; the handle is cosmetic. Our arbitration is EA7 (first claim per tick, YIELDED
  recorded), which is stronger.
- R3 Benchmark-relative conditions (Pacvue) — engine design (relative references), deferred by W5;
  unchanged.
- R4 Hourly bidding — deliberate (2026-08-11 study §7: cadence is a choice; the feed's recency
  guard isn't built). Unchanged.
- R5 Per-keyword min/max fields — the 2026-08-11 design law stands (campaign grain; Perpetua's
  segment conclusion).

## 4 · The phase plan (each phase = one approval, local until batch push)

| # | phase | scope | size |
|---|---|---|---|
| **P1** | **Truth in the lifecycle** — builder save wires Control to the autonomy route (Manual → PROPOSE+enabled · Automate → AUTO+enabled, ceiling 409 honoured in the server's words, `pause_target` rules land at PROPOSE with the ceiling's sentence); RulesGrid's builder-branch toggle writes the level too (keeping `control` in step); Control-step copy states exactly what will happen and where output lands | F1 | S–M |
| **P2** | **No dead controls** — frequency+timezone made REAL (due-check in the evaluator, Europe/Rome default) so the grid Frequency cell is true; "No cap" placeholder replaced by the real €100/day default (editable); `maxExecutionsPerDay` surfaced; Learn button decision (operator: wire/remove/keep) | F2 F3 F7, B4 | M (engine due-gate + UI) |
| **P3** | **Builder visual/DS pass** — connector no longer crosses the noise guard; step-nav scroll fixed + scroll-spy correct; typography normalized to the console scale (numeric before/after per text role); dialog/button idiom audit (ratchets stay ≤ baseline) | F4 F5 F6 | M |
| **P4** | **H10 bid grammar completed** — Current Bid metric + Revenue-per-Click + CurrentBid×TargetACoS/ACoS actions (context gains `bidCents`); per-rule lookback honoured by the evaluator (B3's successor) | B1 B2 B3 | M |
| **P5** | **Template archetypes** — seed the Bid template library (operator approves the list); Apply Template modal grouped/labelled | B5 | S |
| **P6** | **Grid & page close-out** — provenance filter + dead Filters card removed (operator already flagged); orphan `__ea` suggestion deleted (explicit yes — destructive); Lookback/Frequency cells re-checked against P2/P4 semantics on live rules | F8 F9 | S |

Refusals R1–R5 are recorded, not scheduled. Inventory-as-metric and Pacvue's commerce-state gates
are roadmap notes for an engine session, not this page's scope.

## 5 · Verification method (local-first)

Per phase: `tsc` + vitest + the pre-push ratchets locally (no push) · the W-series stub pattern
(`_w1-verify-stub.mts` shape: prod reads, simulated writes, port 8099 with
`access-control-allow-methods`) + `NEXT_PUBLIC_API_URL=http://localhost:8099 npm run dev` · clicked
in the browser with computed-style/geometry probes, reading the SCREEN as a stranger. Real
E2E (create → arm → propose/write → suggestion appears) runs on deploy day after the batch push.

## Appendix

`_bp0-census.mts` (read-only census; kept). Prod screenshots: bid tab empty state · builder top ·
connector×noise-guard overlap (line x=352 vs label x 351–422) · Advanced Settings + Control.

---

## 6 · Build record (2026-08-21, all LOCAL — verification per item)

Verified with `apps/api/scripts/_bp-verify-stub.mts` (port 8099: prod reads via Neon, rule writes
simulated in-memory THROUGH the real `producedActionTypes` + `graduationCeiling` + `isLevelAllowed`)
+ `apps/web/scripts/_bp-e2e-local.mjs` (Playwright over the isolated dev server on 3001, route-
intercepting :8099 — current Chrome's Local Network Access policy blocks cross-port loopback
writes even with correct CORS, so hand-Chrome can only verify reads locally now; note added below).

**P1 — truth in the lifecycle.**
- `producedActionTypes()` (adapter): a rule is judged by the actions its translation EMITS —
  a set/raise/lower Bid rule produces `bid_apply` (ceiling AUTO); a pausing one produces
  `pause_target` (ceiling PROPOSE). All four `graduationCeiling` call sites converted
  (graduate route · autonomy list · autonomy PATCH · readiness board). Pre-P1, the slug expansion
  capped EVERY builder bid rule at PROPOSE.
- Builder save arms the rule through `PATCH /advertising/autonomy/rules/:id`: Manual →
  PROPOSE+enabled, Automate → AUTO+enabled, 409 → PROPOSE fallback. Edit re-arms only when the
  Control radio was changed this session (`initialControl`). Control-step copy states it.
- RulesGrid toggle: ONE write path for both shapes (the autonomy route), builder rules keep the
  `control` belt in step (belt first when arming, rolled back on 409); `automation` derivation =
  enabled ∧ AUTO ∧ control≠manual; ceiling applies to builder rules (held + reason).
- **E2E-proven** (stub log): `CREATE → enabled:false PROPOSE` → `LEVEL → AUTO produced=[bid_apply]`;
  toggle OFF → `LEVEL → PROPOSE` + `PATCH [actions]`; pause rule → `LEVEL AUTO REFUSED 409
  (ceiling PROPOSE: produced=[pause_target])` → PROPOSE, grid toggle held with the ceiling's sentence.

**P2 — no dead controls.**
- `ads-rule-schedule.ts` + 12 tests: `scheduleIsDue` (Hourly ≥55min · interval cadences at the
  stored time in the rule's OWN timezone · never-evaluated = due now · Custom-Weeks weekday).
  Wired into `applyMarketplaceScope` — a builder rule with a schedule evaluates only when due;
  engine rules unchanged; `simulateOneRule` bypasses deliberately. ⚠ Clock = `lastEvaluatedAt`
  (a Simulate absorbs that day's run) — dedicated column blocked by the migration freeze (W1 law).
- Timezone default → `cet` (Rome). Frequency copy states the first-check-within-15-min deviation.
- Caps honesty: maxAdSpend prefilled 100 (placeholder "100 (default)"), NEW "Max runs per day"
  input (maxExecutionsPerDay, prefilled 10), block copy names both defaults. Hydration + locked-
  path PATCH included.
- Learn button: **REMOVED** (operator decision 2026-08-21: "Remove the learn button") — it had no handler since the builder shipped; Preview keeps its idiom.

**P3 — visual/DS pass** (all measured in the local build).
- Noise guard indented 50px (matches `.h10-rb-addand`); pills `position:relative` so the dashed
  connector passes BEHIND; line no longer crosses any text.
- Step nav: `steps` memoised (the un-memoised array re-attached the scroll listener every render
  and killed smooth scrolls at ~6px); `goto` → instant `scrollIntoView` + the pre-existing
  `scroll-margin-top`. Measured: click scrolls 0 → 1576; spy highlights on real scroll.
  ⚠ Probe note: programmatic scrolls in the MCP JS sandbox fire NO scroll events — only real
  input does; do not diagnose the spy from scripted scrolls.
- Typography to the console scale (measured after): `.h10-rb` base 13.5px · steps 16/500→14/600 ·
  h2 20→18 · top title 16→15. Family was already Inter.

**P4 — H10 bid grammar completed.**
- `Current Bid` metric (context gains `adTarget.bidCents` via one findMany in the emitter;
  `ADTARGET_METRIC` + `PC_METRICS_BID`, Bid builder only).
- Actions `revPerClick` (sales÷clicks — break-even bid; refuses with no sales) and
  `curBidTargetAcos` (current bid × target/actual); both through `bid_apply`'s one clamp+write path.
- Per-rule lookback: builder select (7/14/30/60/90, default 14) → `actions[0].windowDays` →
  honoured by BOTH readers: per-window KEYWORD_HIGH_ACOS context passes (`ruleFilter` param on
  `applyMarketplaceScope`) and `targetPerformance` override; clamp `BID_WINDOW_MIN/MAX` (7–90)
  declared once in `@nexus/shared/ads-rule-window` (`ACTION_WINDOW.bid`, tunable) so the grid's
  Lookback cell reads the same number. E2E: cell shows "30 days" and hydrates back.
- **P4b — multi-block truth** (found during P1; the old translation flattened all blocks' IFs into
  one AND-list and ran only block 1's THEN): the adapter now emits `blocks` (one conditions+action
  pair per builder group; budget/placement/bid/sov/kt); `evaluateRule` selects per context —
  FIRST matched block acts (stated beside "+ Criteria" in the builder and in the Criteria cell's
  "+N more" tooltip). A mixed bid+pause rule produces both types → structural ceiling, automatic.
  H10's "greater same-direction change wins" precedence is a possible later refinement; first-match
  is deterministic, legible and stated.
- Harvest/negative multi-group flattening NOT touched (their tabs' sessions own them; the flatten
  only ever TIGHTENS — fail-safe direction). Named here so it is not forgotten.

**P5 — starter templates** (code-shipped, Bid only): five archetypes with noise guards (Cut bids
on high ACoS · Scale winners · Floor zero-sale spenders · Converge to 25% ACoS · Bid break-even),
in the Apply Template modal above Saved templates, applying through the same editable path.
E2E: 5 listed, apply seeds ACOS>35.

**P6 — close-out**: dead W1 provenance filter + legacy chip removed from `RulesGrid` (post-W7 they
could never light again; this also removes the page's empty Filters card — E2E: 0 "Show Filters").
`_bp6-delete-orphan-suggestion.mts` **RUN with --apply on the operator's word 2026-08-21**: the one
`__ea manual 1781961158143` orphan deleted; prod re-verified 0 pending suggestions (badge → 0).

**Gates at close:** api tsc ✓ · web tsc ✓ · shared build+41 tests ✓ · api vitest 4,943 ✓ (the 6
red in `ads-protect-converting` are the SG session's uncommitted `add_negative_exact` scope-flip
hunk in `automation-action-handlers.ts`, not BP's — verified by diff) · web 922 ✓ ·
button-vocab 286 ✓ · silent-disabled 27 ✓ · help-cursor 0 ✓ · ds-conformance ✓ · p3-token ✓.

**Files touched (for the batch commit):** api — `ads-rule-adapter.service.ts`,
`ads-graduation-readiness.service.ts`, `advertising.routes.ts` (3 hunks — ⚠ shared-hot),
`automation-rule.service.ts`, `automation-action-handlers.ts` (⚠ carries SG's WIP hunk — needs
blob-splitting at commit), `advertising-rule-evaluator.job.ts` (⚠ carries SG's sweep hunk),
NEW `ads-rule-schedule.ts` + test · shared — `ads-rule-window.ts` · web — `RuleBuilder.tsx`,
`RulesGrid.tsx`, `PerformanceCriteria.tsx`, `rules-automation.css` · adapter tests extended ·
scripts `_bp-verify-stub.mts`, `_bp0-census.mts`, `_bp6-delete-orphan-suggestion.mts`,
`web/scripts/_bp-e2e-local.mjs` (+ this doc).

**Local-preview proxy (added after the operator updated Chrome and LNA still blocked):**
`next.config.js` gained an env-gated `rewrites()` — with `NEXT_DEV_STUB_PROXY=http://localhost:8099`
and `NEXT_PUBLIC_API_URL=http://localhost:<dev-port>`, /api/* proxies server-side to the stub, so
hand-driven Chrome exercises WRITES same-origin (no CORS, no LNA). Unset in prod/Vercel/pre-push →
zero rewrites. `next.config.js` joins the batch-commit file list (verified clean of sibling hunks
at edit time; re-diff on commit day — it is a known collision file).

**Deploy-day checklist:** re-run gates on a quiet tree · hunk-audit the three ⚠ shared files
against the SG session · batch commit (`git add` untracked first, `--only` with explicit paths,
ancestry-verify) · prod click-through: create→arm→first evaluation within 15 min→suggestion or
write · update
`docs/2026-08-20-ra-w-series.md` register + memories.

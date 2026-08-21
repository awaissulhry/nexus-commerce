# BUD-P — Budget perfection (Phase 0 study)

**Date:** 2026-08-21 · **Status:** STUDY, awaiting operator approval — no application code changed.
**Target:** `/marketing/ads/rules-automation/budget` (the H10-shape rules grid) and
`/builder/budget`. Fourth target of the per-subpage perfection programme
(BP `9da305684` · HP `1639282ed` · NEG-P `09751db79`+`6e13e3614`).

**Builds ON:** the BUD page programme (BUD.1–BUD.8, esp. `2026-08-16-bud-8-armed.md` — read it
for the €1-floor correction: the PACER floored 56 of 58, not the rules), the D-series
(`CampaignRuleAssignment` D1–D3b shipped; D4–D6 open), BP P4b (campaign-family multi-block),
EA4 (the picker's campaigns honoured), BUD.2 (baseline anchoring + guardrail columns).
**Changed since those:** W7 deleted every budget rule AND their 1,320 assignment rows (cascade —
measured: 0 today). The ownership line stands: **BSP (tab 4) decides how much money exists;
BUD (this tab) decides who may move it and by how much.**

## 1 · Census (2026-08-21, `_bud-p0-census.mts`)

| fact | value |
|---|---|
| budget rules · assignment rows | **0 · 0** (post-W7 clean slate; the D1 backfill died with the rules) |
| enabled campaigns · **at the €1 floor** | **86 · 55** — a Decrease op is a no-op on 55 of 86 |
| baselines captured · min/max budget set | **28 · 0/0** (BUD.8's floor derivation still unarmed — cross-page item, ads-mutation layer) |
| campaigns with spend in the 7d settled window (**the context floor**) | **58** — the reachable set for any budget rule |
| `AD_BUDGET_UPDATE` rows, 7d | **334 — 331 by `automation:budget-manager-cron`** (tab 4's pacer, live+armed), 3 by a since-deleted rule. Budgets move ~47×/day with zero budget rules — the page must say WHO moves them |

## 2 · What is already excellent (KEEP — this tab starts far ahead)

The engine side of this tab was rebuilt by earlier waves and is the best-wired of the eleven:
**five actions** (Set €, Inc/Dec %, Inc/Dec €) — a superset of H10's three; **Budget Guardrails
Min/Max** carried end-to-end (adapter `minEur`/`maxEur` → handler clamp, €1 floor hard);
**the campaign picker binds** (EA4: `campaignIds` honoured in `budget_apply`, empty = account-wide);
**baseline anchoring** (BUD.2: relative ops anchor to `budgetBaselineCents`, idempotent not
compounding, `noChange` short-circuit); **multi-block truth** (BP P4b: per-block conditions+action,
first-match acts); daily-spend cap; the perfected shared campaign picker (All/Portfolios/Products —
exceeds H10); templates already offered (`isCampaign`); the D-series column + modal on Apply Rules;
window truth-note; caps/market/arming/ceiling inherited. Honest nulls throughout the context.

## 3 · Gaps

| # | gap | evidence |
|---|---|---|
| **B1** | **Budget Utilization is missing from the builder's metric list** — the INVERSE of the usual gap: the context derives it (`avgDailySpend ÷ dailyBudget`, null-honest), `CAMPAIGN_METRIC` maps it, `PC_METRIC_UNIT` registers it — and `METRICS_BASE` never offers it. It is H10's signature budget metric ("Average Budget Utilization: Spend ÷ Sum(daily budget) × 100%") | code + §5.3 of the H10 study |
| **B2** | **The context floor is unstated**: ENABLED ∧ spend > 0 in the 7d settled window — 58 of 86 reachable. The window note says only "last 7 days" | evaluator `buildCampaignBudgetContexts` |
| **B3** | **The assignment split-brain (D4/D6)**: a builder rule binds via `action.campaignIds` (honoured, invisible to the Apply Rules Budget-Rule column); a column assignment binds via `CampaignRuleAssignment` (resolver ANDs it, invisible to the builder's picker). Post-W7 both start empty — the moment to unify is NOW, before rules exist | D-series memory + code |
| **B4** | **Lookback parity**: H10's Budget rule carries Lookback (60d default) in Advanced Settings; ours is fixed 7d. BP already built the mechanism for Bid (per-rule `windowDays` 7–90 + per-window context passes) | H10 §4.1/§5.3 |
| **B5** | No budget starter templates | `STARTER_TEMPLATES` lacks `budget` |
| **B6** | No strip — and this tab's history is exactly why one matters: the operator should see "55 of 86 at the €1 floor (a cut is a no-op there)" and "budgets moved 331× this week by **Budget Manager pacing**, not by rules" on the tab itself | census |

## 4 · The phases (each = one approval)

| # | phase | closes | size |
|---|---|---|---|
| **BUD-P1** | **Metric + floor honesty** — offer Budget Utilization (with H10's formula in the copy); floor sentence in the window note ("campaigns surface only once they have spend in the window") | B1, B2 | S |
| **BUD-P2** | **One binding truth** — builder save mirrors the picker into `CampaignRuleAssignment` (kind from the slug), so the Apply Rules column tells the truth for builder rules and the resolver's AND semantics hold on one dataset; column edits on a builder rule patch the rule's own list (the D6 direction). Delete nothing; the two mechanisms converge instead of coexisting | B3 (D4/D6) | M |
| **BUD-P3** | **Per-rule lookback** — `windowDays` 7–90 on the budget action via BP's bid mechanism (per-window `CAMPAIGN_PERFORMANCE_BUDGET` passes); H10 parity with the honest twist: OUR window is settled and says so | B4 | M |
| **BUD-P4** | **Starters + strip** — three anchored starters (e.g. "Trim high-ACoS spend" ACoS ≥ 40% ∧ Spend ≥ €50 → −15%; "Feed capped winners" ACoS ≤ 20% ∧ Utilization ≥ 90% → +20%; "Idle budget sweep" Utilization ≤ 10% ∧ Spend ≥ €5 → Set €1-floor-safe); the strip (0 rules · 86 enabled · **55 at €1 floor** · 28 baselines · pacer-writes count → Budget Manager + Suggestions links) | B5, B6 | M |
| **BUD-P5** | **Arming** — decision: pilot budget rule at PROPOSE. Note the honesty bound: with 55 at the floor and the pacer live, a cut-rule's real surface is ~31 campaigns; a raise-rule interacts with tab 4's monthly envelope (BUD.8 §3) — the starter choice matters more here than on any other tab | decision | — |

**Refusals (with evidence):** Amazon-native budget rules (increase-only, SP-only, no EU
hours-of-day — ours run in our engine deliberately) · H10's one-rule-per-campaign exclusivity
(operator decided the multi-key on 2026-08-20; never narrow a `@@unique` —
`reference_prisma_upsert_on_conflict`) · restore-of-the-55, min/max-budget floor VALUES, and the
floor-enforcement-layer move (`ads-mutation.service.ts`) — all tab-4/cross-page items per BUD.8;
re-flagged, not absorbed.

---

# BUD-P build record — P1–P4 BUILT + verified locally, 2026-08-21

**Status:** LOCAL, uncommitted. All gates green. P5 is a decision and is presented below, unexecuted.

## 0 · 🔴 Correction to §3: **B1 was wrong**

The study says Budget Utilization "is missing from the builder's metric list". **It was not.**
`RuleBuilder.tsx` already carried its own `METRICS_BUDGET` array ending in `'Budget Utilization'`,
and lines 1054/1076 already fed it to the metric dropdown for `isBudget`. The study read
`METRICS_BASE` in `PerformanceCriteria.tsx` and concluded the builder offered only that list.

What was really wrong is smaller and different: **two copies of the budget metric list**, one in
each file, free to drift — and `pcMetricsFor('budget')` (the shared accessor every other tab uses)
returned the base list without Budget Utilization. P1 therefore single-sources the list rather than
"adding a missing metric". The metric set is unchanged in content (12 entries, reordered to match
`METRICS_BASE`); nothing was added to or removed from what the operator can pick.

**B2 and B4–B6 stand as written. B3 was UNDERSTATED — see §2.**

## 1 · P1 — metric + floor honesty · SHIPPED (local)

- `PerformanceCriteria.tsx`: `METRICS_BUDGET` + `PC_METRICS_BUDGET` exported; `pcMetricsFor('budget')`
  returns them; `RuleBuilder`'s local copy now aliases the shared one.
- `PcWindowNote` gained the budget sentence: the context floor (**enabled ∧ ad spend inside the
  window**) and the Budget Utilization formula.
- The formula sentence was corrected after measurement: utilization divides window spend by the
  campaign's **CURRENT** daily budget, and the Budget Manager pacer moves budgets ~48×/day — so it
  legitimately reads above 100% (measured: `IT-AIREON-SP-Auto` at 126%). The note says so rather
  than letting the operator read >100% as a bug.

## 2 · P2 — one binding truth · SHIPPED (local) — and the gap was bigger than B3 said

B3 described "a link created via the Apply Rules Budget-Rule column is a no-op for builder rules
while displaying as bound". Measured, the root cause is one test with **three** consequences:

> A budget rule exists in two shapes. Engine-native stores `actions[].type === 'adjust_ad_budget'`.
> Every rule the BUILDER writes stores `actions[0].type === 'budget'` with the picker's `campaigns`.
> Three places tested only the first.

| site | consequence |
|---|---|
| `advertising.routes.ts:1118` (column **catalogue**) | a builder budget rule **never appeared in the column's dropdown at all** — it could not be assigned, so B3's "displays as bound" was not even reachable by that path |
| `advertising-rule-evaluator.job.ts:487` | builder budget rules were **not assignment-governed**; only `budget_apply`'s own `campaignIds` check (EA4) held them in, so every non-picked campaign was still evaluated |
| `ads-rule-reach.service.ts:123` | reach **over-reported** them — the exact "220 for a rule assigned to three" that file's own header warns against |

**Built:**
- One pure helper set in `ads-rule-adapter.service.ts` (no prisma, the existing home for builder-shape
  knowledge): `isEngineBudgetRule` · `builderBudgetCampaignIds` · `isBudgetRuleOfAnyShape`.
- New `rule-campaign-binding.service.ts` — mirrors **both** directions: builder save →
  `CampaignRuleAssignment` (so the column DISPLAYS the truth), and column Apply → the rule's own
  `campaigns` (so a column edit REACHES the engine).
- Call sites: POST create, PATCH (only when `actions` was sent), and the bulk Apply. All three
  wrapped so a mirror failure logs `[ADS-RULE-BINDING]` and never fails the operator's save.
- Catalogue filter now accepts both shapes.

**Deviation from the agreed design, deliberate.** The agreed plan made builder rules
assignment-governed by reading the *table*. Built instead: a builder rule is governed by its **own**
stored list, which the mirrors keep equal to the table. Same semantics in every case (including
uncheck-all → `[]` → matches nothing = H10's "None"), but the failure mode is strictly better — a
mirror that loses a race leaves the COLUMN stale (visible, self-correcting on the next save) instead
of making a live rule silently match nothing. The engine never depends on a secondary write.

**Also fixed inside P2:** the bulk route collected only the rule ids *named in the request*.
Unchecking a rule from every campaign sends `ruleIds: []`, so the rule losing its last link appeared
nowhere — and the removal would have been a no-op for builder rules, reintroducing the very defect.
The transaction now collects the rows it DELETES as well, and mirrors those too.

**Tests:** `rule-campaign-binding.vitest.test.ts`, 11 cases — both shapes, the three governance
states, create/remove/empty, engine-native no-op, the uncheck-all clear, the "already agree → write
nothing" case (no `updatedAt` heartbeat), and a save → mirror → column-edit → inverse-mirror round trip.

## 3 · P3 — per-rule lookback · SHIPPED (local)

`windowDays` (7–90, default 7) on the budget action; Lookback select in Advanced Settings above the
window note; adapter carries it onto `budget_apply`; `buildCampaignBudgetContexts(overrideDays?)`
parameterised (including the `avgDailySpendCents` divisor); per-window
`CAMPAIGN_PERFORMANCE_BUDGET` passes with the default pass excluding rules that chose their own —
BP's bid mechanism exactly. `ACTION_WINDOW.budget` added to `packages/shared/ads-rule-window.ts`, so
the grid's Lookback cell honours it via `ruleLookback` with no grid change.

## 4 · P4 — starters + strip · SHIPPED (local)

**Three starters**, every one guarded, and the guards are arithmetic rather than decoration: a
€1/day campaign cannot clear a €7 spend floor over 7 settled days, so the cut starters exclude the
55 floor-bound campaigns by construction instead of promising a cut that cannot land.

| starter | criteria | action |
|---|---|---|
| Feed capped winners | ACoS ≤ 20% ∧ Orders ≥ 2 ∧ Utilization ≥ 90% | +20% |
| Trim high-ACoS spend | ACoS ≥ 40% ∧ Spend ≥ €50 | −15% |
| Reclaim idle budget | Utilization ≤ 10% ∧ Spend ≥ €5 | −25% |

**The strip** — `GET /advertising/budget-rules/strip` (`getBudgetRulesStrip` in
`budget-grid.service.ts`; route in `advertising-intel.routes.ts`, `grep -a`ed for collisions and
boot-checked with `printRoutes`). Rendered live:

> **86** enabled campaigns · **57** with spend in the last 7 settled days, the most a budget rule can
> reach · **55** already at the €1 floor, where a cut does nothing · **28** baselines captured ·
> budgets moved **336×** in 7 days by [Budget Manager pacing] and **3×** by rules · rule output
> queues on [Suggestions]

Absent, never fabricated, on a failed read. Links use `.h10-hv-cohortline .h10-nt-open` — the
in-strip override from `6e13e3614`; verified on screen at `opacity: 1`, `display: inline`,
`rgb(26,97,198)`, not the grid's hover-reveal pill.

**Two defects found by MEASURING rather than reading the diff:**

1. 🔴 **The strip first reported "0 at the €1 floor" against a true 55.** `Campaign.dailyBudget` is a
   Prisma `Decimal`, so the file's own `eurosToCents` (which tests `typeof number | string`) took its
   `NaN` branch for every row and returned null. A silent zero on the one number the strip exists to
   state. Fixed with `Number(Decimal)`, the same conversion the context builder uses.
2. 🔴 **Starter descriptions were CLIPPED on every tab, since BP.P5.** `.tmn` is
   `white-space: nowrap` + `text-overflow: ellipsis` (right for a saved template's one-line name);
   the description is a block child of that span and inherited it, so the modal rendered
   "…and budget ≥90% consumed -" and stopped. Fixed at the end of `rules-automation.css`; the name
   keeps its ellipsis, the description wraps. Confirmed un-clipped on negative-targeting and
   keyword-harvesting too.

`reachable` is **57**, not the study's 58: the study's census counted every campaign with spend, the
strip intersects with ENABLED exactly as `buildCampaignBudgetContexts` does. 57 is what the engine
sees.

## 5 · Verification

`@nexus/shared` build ✓ · `tsc` api ✓ web ✓ · api vitest **389 files / 5020 tests** ✓ (5009 + the 11
new) · web vitest **922** ✓ (8 Playwright files fail to load under vitest — baseline) · ratchets:
button-vocabulary **286** ✓ · silent-disabled **27** ✓ · help-cursor **0** ✓ · ds-conformance ✓ ·
p3-token-sweep ✓ · link-targets (300 static hrefs, incl. the strip's two) ✓ · fastify boot check ✓.

Local rig: stub on **:8098** and dev on **:3002** — a sibling session holds :8099 and :3001, so
`_bp-verify-stub.mts` gained a `BP_STUB_PORT` override and the dev server ran with
`NEXT_DIST_DIR=.next-dev-budp` (Next refuses a second dev server sharing a dist dir). Neither
sibling process was touched.

Playwright (`_budp-smoke.mjs`, `_budp-apply-check.mjs`): strip present with visible links · 12 metric
options with **Budget Utilization** on screen (scrolled into view and screenshotted, plus reachable by
typing "util") · Lookback select "Last 7 Days" · window note correct · 3 starters, all fully legible ·
both starters apply the right criteria and THEN action (`Budget Utilization ≥ 90` → *Increase Daily
Budget by(%) = 20*) · **0 page errors**.

## 6 · P5 — arming: the numbers first, and they change the recommendation

Measured over the 7 settled days on the reachable set of 57:

| fact | value |
|---|---|
| reachable (ENABLED ∧ spend in window) | **57** |
| of those, above the €1 floor — where a cut can actually move money | **29** (the study estimated ~31) |
| **with ZERO attributed sales, so ACoS is null and fails EVERY ACoS condition** | **45 of 57** |
| with measurable ACoS | 12 · highest **33.3%** · none ≥ 40% |
| spend ≥ €50 · ≥ €20 · ≥ €5 | 3 · 15 · 36 |

**Match counts today:** Trim high-ACoS spend **0** · Feed capped winners **1** · Reclaim idle budget **3**.

🔴 **The ACoS starters are close to inert on this account, and not because of the €1 floor.** 45 of
57 reachable campaigns have no attributed sales in the window at all, so their ACoS is null — and a
null honestly fails every ACoS condition. The biggest spenders are in that group: `GALE BROAD DE`
(€62.01, 100% utilization) and `IT-AIREON-SP-Auto` (€54.25, 126%) both spend hard with nothing
attributed, and **no ACoS rule can ever touch them**.

(ACoS here uses the codebase-wide `sales7dCents + sales14dCents` convention — 10+ call sites across
the ads code. Not introduced here and not changed here; flagged because it sets the ACoS scale.)

**Recommendation: arm "Reclaim idle budget" at PROPOSE, not an ACoS rule.** It matches 3 campaigns
today, it is a cut (so it cannot raise spend), the €1 guardrail floor bounds it, and PROPOSE means
it queues on Suggestions rather than writing. It also interacts least with tab 4's monthly envelope
(`2026-08-16-bud-8-armed.md` §3), which a raise rule would push against.

**Not recommended without a further decision:** a rule targeting the zero-sales burners. It is where
the money actually is, but "spend with no attributed sales" is Negative Targeting's brief, and the
GALE IT negative pilot is already running at PROPOSE against the same campaigns. Arming a budget cut
on the same evidence would have two rules proposing on one cause.

**Operator decision needed:** (a) arm Reclaim idle budget at PROPOSE, (b) arm nothing yet, or
(c) something aimed at the zero-sales burners, which needs its own design.

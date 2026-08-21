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

---

## 7 · Shipped + armed — 2026-08-21

**Commit `9653baa7a`**, pushed from a detached worktree so the pre-push hook gated the exact commit
(the shared tree carries the SG session's WIP). Deployed: Railway SUCCESS, Vercel Ready.

The commit was assembled through a temp index with **hunk-level filtering** — `advertising.routes.ts`
showed +476 in the shared tree of which only 67 were mine, and 6 of its 12 hunks were kept; the
evaluator's SG sweep block and the CSS SG.1 moves stayed uncommitted in the tree. One hunk
classified MIXED on inspection turned out to be a false positive (the sibling's suggestions-row
enrichment reads `a.windowDays` and calls `ruleLookback` — none of my code). The CSS could not be
hunk-staged at all (EOF append under shifted offsets) and was staged as a rebuilt blob:
HEAD + my 9 lines, **0 deletions**.

### Verified ON PROD, by reading the screen

· **The strip renders live** and its numbers move: 336× pacer writes at build time, **346×** an hour
later on prod — computed, not cached.
· `GET /advertising/budget-rules/strip` returns 401 (RBAC) while a sibling nonsense path under the
same prefix returns 404 — the discriminator that proves the route is registered, not the SPA
fallback.
· Builder: **Measurement window = Last 7 Days** with the full note; **all three starters legible**
(the clipping fix holds on prod); the starter applies as
`Budget Utilization ≤ 10%` ∧ `Spend ≥ €5` → `Decrease Daily Budget by(%) 25`.

### The armed pilot

**`Reclaim idle budget — DE`** · `cmt3byq3i00arl901dwu06y4u` · created through the prod BUILDER by
click, not by API.

| field | value |
|---|---|
| enabled · autonomyLevel | `true` · **`PROPOSE`** (grid Automation toggle off) |
| trigger · scopeMarketplace | `CAMPAIGN_PERFORMANCE_BUDGET` · **`DE`** |
| actions[0] | `type:'budget'` · **`windowDays: 7`** · `budgetFloor: 1` · `campaigns: 86` |
| caps | €100/day ad spend · 10 runs/day |
| **`CampaignRuleAssignment` rows** | **86** (table total was 0) |
| `isEngineBudgetRule` | **`false`** — the OLD test would have missed this rule entirely |
| `reachForRules` | **8 campaigns, 8 enabled** of 220 — the DE ∩ assigned intersection |

🔴 **That table is BUD-P2's proof on live data.** The rule the builder writes is invisible to the
pre-P2 test, and the 86 mirrored rows were created by the real `POST /advertising/automation-rules`
path. Reach reports **8**, not 86 and not 220.

Scope rationale: all three campaigns matching the starter today are DE — `DE_Exact_3_Keywords`
(€15.00, 9.5% util), `DE_Auto_Substitute` (€20.00, 9.7%), `GALE PHRASE DE` (€80.00, 7.3%) — so a DE
pilot matches the HP/NEG precedent (GALE DE, GALE IT) and bounds the surface to 8 campaigns.

### 🔴 Found while arming, NOT fixed (out of BUD-P's approved scope)

**The builder's Budget Preview applies the action arithmetic to every selected campaign without
applying the criteria or the marketplace scope.** With 86 campaigns picked and DE scope set, it
listed `ES_Phrase_3_Keywords €6.32 → €4.74` and `FR_Phrase_8_Keywords €2.61 → €1.96` — campaigns
this rule can never touch. The €1-floor rows correctly show no change, so the guardrail half is
honest; the *matching* half is not. Its own subtitle ("the new daily budget each selected campaign
would get when this rule fires") reads as a prediction, and it over-predicts. Pre-existing, on the
shared builder, and it deserves its own decision rather than a silent widening of this phase.

**Also observed, and it belongs to the SG session:** the grid's Criteria cell renders
`Budget Utilization ≤ 10%, Spend ≥ 5 → −25%` — the utilization carries its `%` but the spend
carries no `€`. `conditionsTextOf` (`rule-conditions-text.ts`) is SG's in-flight file; flagged to
them rather than edited.

### The pilot's first tick — 19:30:10 UTC

`lastEvaluatedAt=2026-08-21T19:30:10.962Z · executions=2 · suggestions=2 · **actionLogs=0**`

Two proposals queued, **zero writes** — PROPOSE behaving exactly as declared:

| campaign | budget | util | proposed |
|---|---|---|---|
| `GALE PHRASE DE` | €80.00 | 7.26% | −25% |
| `DE_Exact_3_Keywords` | €15.00 | 9.47% | −25% |

**Two, not the three predicted — and the third is not a defect.** `DE_Auto_Substitute` (€20.00,
9.7% util) went **PAUSED at 19:20:04**, between the P5 probe and the tick. The context builder
filters `status: 'ENABLED'`, so it left the reachable set and was correctly never evaluated. The
grid's Activity cell reads **2 waiting**.

### 🔴 A full campaign status refresh landed mid-verification

Between 19:15 and 19:26 UTC, **162 campaign rows were rewritten — 130 to PAUSED, 32 to ENABLED**, at
a regular ~0.63 s cadence. **No cron run overlapped that window** and there are **no
`AdvertisingActionLog` rows** for it (the only row in the window is this session's own
`set_rule_autonomy`). That is the signature of a sync mirroring Amazon's statuses, not of our
automation acting — and it is not attributable to this commit, which touches no status path.

Consequence for every number above: the census taken at build time (86 enabled · 57 reachable ·
55 at floor) was pre-refresh. The strip now reads **70 enabled · 43 reachable · 37 at the €1 floor ·
364× pacer writes** — it moved because the truth moved, which is the strip working.

The rule's 86 mirrored assignment rows now include 16 paused campaigns. That is correct and needs no
cleanup: assignment is a stored relation answerable for any campaign (D2/D3), and the context
builder's ENABLED filter means a paused campaign simply never surfaces.

### Correction — the missing `€` was NOT `conditionsTextOf`

Recorded because the first diagnosis was wrong. `conditionsTextOf` (server) already printed
"Spend ≥ €5". The Criteria cell is rendered **client-side** by `clause()` in `_shared/RulesGrid.tsx`
— two readings of the same conditions, disagreeing. `clause()` derives units from the shape of the
FIELD PATH (`/Cents$/`, `isRatioField`), which cannot work for a builder leaf whose `raw` is the
metric NAME; "Budget Utilization" kept its `%` only because `isRatioField` matches the word
"utilization", while Spend, Sales, CPC and Current Bid were all bare. Fixed by the SG session in
`6382fe56f` (builder leaves now read `PC_METRIC_UNIT`), and **verified rendering on prod**:
`Budget Utilization ≤ 10%, Spend ≥ €5 → −25%`.

⚠ The trap inside that fix, worth carrying: builder values are stored in **display units** ("5" =
€5) while the grid's `money()` takes **cents**, so a naive `money(n)` prints "€0.05" — swapping a
missing unit for a wrong number, which is worse. Caught only by looking at the rendered row.

---

# BUD-PP — the Budget Preview made honest (2026-08-21, operator-directed)

> *"The budget preview must not ignore the criteria and the marketplace scope. We must make sure
> that it's absolutely perfect and perfectly valued."*

## 1 · It was wrong FIVE ways, not two

The reported defect was "ignores criteria and scope". Reading the code against the handler found
three more, and the third is the one that matters most:

| # | defect | consequence |
|---|---|---|
| 1 | criteria never evaluated | 86 budget changes advertised for a rule that could make 2 |
| 2 | marketplace scope ignored | a DE rule listed `ES_Phrase_3_Keywords`, `FR_Phrase_8_Keywords` |
| 3 | multi-block ignored | only `groups[0]`'s action was applied; the engine runs the FIRST BLOCK whose conditions match (BP.P4b) |
| 4 | 🔴 **wrong anchor** | the preview applied the op to the CURRENT budget. `budget_apply` anchors every relative op to **`budgetBaselineCents`** (BUD.2) — the thing that makes the rule idempotent instead of compounding. 28 campaigns carry a baseline, so the *number* was wrong wherever baseline ≠ current |
| 5 | context floor ignored | a campaign with no spend in the settled window emits no context and can never be touched; it was listed anyway |

## 2 · The fix: run the engine, don't re-implement it

Better arithmetic in the browser would have been a second implementation of "what will this rule
do" — the exact trap that produced two disagreeing Criteria formatters on this same page hours
earlier. So `ads-rule-preview.service.ts` runs the real path:

    real contexts (buildCampaignBudgetContexts, the rule's own lookback)
      → real scope (ruleMatchesScope) + the picker list the handler enforces
        → real translation (maybeTranslateAdsRule)
          → real conditions (evaluateConditions, first-matching block)
            → real action (ACTION_HANDLERS.budget_apply, dryRun — returns `wouldChange`, writes nothing)

**Nothing in the preview path computes a budget.** The number on screen is produced by the code
that will produce the change. `POST /advertising/automation-rules/preview` (boot-checked; coexists
with `/:id/simulate`). The builder's `submit` and the preview now share ONE payload builder
(`previewActions`/`previewConditions`), so the preview cannot describe a rule different from the
one Save would create.

## 3 · Proof — the preview reproduces the armed rule exactly

Cross-checked against `Reclaim idle budget — DE`, which had already run for real:

| | preview | what the engine actually proposed |
|---|---|---|
| campaigns | GALE PHRASE DE · DE_Exact_3_Keywords | GALE PHRASE DE · DE_Exact_3_Keywords |
| values | €80.00 → €60.00 · €15.00 → €11.25 | €80.00 → €60.00 · €15.00 → €11.25 |

Census: `86 selected · 43 measurable · 4 in scope · 2 matched`. Before the fix the same draft
listed all 86 with values computed from the wrong anchor.

## 4 · Two defects the UNIT TESTS could not have caught

Both found only by driving the real form, and both produced a *confident wrong answer* rather than
an error — the worst failure mode for this widget.

1. 🔴 **`'all'` is the builder's word for UNSCOPED.** The form sent `scopeMarketplace: "all"`
   literally; `ruleMatchesScope` compared `'all' !== 'DE'` and dropped every context, so the modal
   said **"0 of 70 match"** — with total confidence. `submit` had always translated it
   (`if (scopeMarket !== 'all')`); the new caller did not. Fixed at both ends and pinned by test 2b.
2. 🔴 **A stale `useCallback` closure.** `runPreview`'s dependency array predated this change and
   omitted `scopeMarket` and the two payload builders, so it captured the market chosen when the
   form first rendered. Switching the scope to FR still previewed the DE campaigns. Invisible to
   unit tests and to a direct API call — the endpoint was right, the component was calling it with
   a stale argument.

Also fixed on reading the rendered copy: `"1 were measured"`, and a subtitle that claimed
`"the 0 of 70 selected campaigns that match"` directly above a body message saying none did.

## 5 · Verification

`@nexus/shared` build ✓ · `tsc` api ✓ web ✓ · api vitest **391 files / 5052 tests** ✓ · web **945** ✓
(8 Playwright files, baseline) · all five ratchets at baseline ✓ · fastify boot check ✓ ·
11 new preview tests, one per lie ✓ · Playwright against the live rig: DE scope narrows 43 → 4,
FR scope returns 0 with an explanation, 0 page errors ✓.

⚠ Mid-verification the shared tree's `tsc` went red in `ad-budget-schedule.job.ts` (108 uncommitted
lines) and in a committed `advertising.routes.ts` delivery-tally block — another session's in-flight
Budget-Schedules work, not this change. It cleared on its own before the gates were re-run.

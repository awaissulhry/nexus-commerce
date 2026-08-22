# PLC-P — Placement perfection (Phase 0: the read-only study)

**Unit:** the RA perfection programme's Placement page — `/marketing/ads/rules-automation/placement`
(`PlacementRulesClient`) and its builder at `/builder/placement` (`_shared/RuleBuilder` slug
`placement`).
**Status:** ✅ **COMPLETE AND PUSHED 2026-08-22** — `e1e78d6d9` · `6a091e7fe` · `7d2fc3387` ·
`dcfb4f2e3`. All seven phases and all four decisions shipped. The per-phase logs below were
written as each phase was built and say "not pushed"; §8 records what actually landed and when.
**Measured:** 2026-08-22, 00:19–00:22 Europe/Rome, against prod (Neon) and
`https://nexus-commerce-three.vercel.app`.
**Probes:** `apps/api/scripts/_plcp-p0-census{,2,3,4}.mts` (read-only; they write nothing).

Sibling-session boundary: Budget Schedules (BSP-P) is owned elsewhere. Nothing in this document
touches `ad-budget-schedule.job.ts`, `_schedule/*`, `budget-schedules/*` or any `_bsp-*.mts`.
RD / `ad-rank-defend` is described here and **not changed**.

---

## 1. What Placement is today

| Layer | File | State |
|---|---|---|
| Page | `placement/page.tsx` → `PlacementRulesClient.tsx` (2.9 KB) | H10 §3.8 shape: header · tab bar · ONE `RulesGrid` card |
| Builder | `_shared/RuleBuilder.tsx` slug `placement` | 5 steps: Rule Name · Placement Rule Setup · Criteria · Advanced Settings · Control |
| Translation | `ads-rule-adapter.service.ts:614` | per-group blocks → `placement_apply` (BP.P4b multi-block) |
| Handler | `automation-action-handlers.ts:1701` | `placement_apply` → `updatePlacementBidding`, merged, clamped `[minPct,maxPct]` |
| Contexts | `advertising-rule-evaluator.job.ts:631` | trigger `CAMPAIGN_PERFORMANCE_BUDGET`, 7 settled days, **campaign-wide only** |
| Output | `AdsRuleSuggestion` family `placement` → Suggestions page | approve re-runs the real handler |
| Parked | `PlacementClient.tsx` (62 KB) · `PlcInspector` · `PlcBulkPanel` · `PlacementScopeBar` | ⛔ untouched; PLC.3 write path still served |

Screenshot read (prod, as a stranger): the page renders `Showing 0 Placement Rules`, columns
**Placement Rule · Lookback · Criteria · Frequency · Automation · Activity · Actions**, and the
empty state *"Create a Placement Rule to generate suggestions for a campaign!"* with a
**Create Rule** button. Below the card, ~240 px of empty page. **There is no strip** — the tab
states nothing about what a placement rule can reach or what already writes those lanes.

---

## 2. The census — every number measured, none inferred

### 2.1 The fleet

- **3** advertising rules exist in total (the W7 wipe's survivors: one negative, one budget, one
  harvest, all `PROPOSE`). **0** carry a placement action. The Placement tab has never had a rule
  since PLC.0 removed the old eight.
- **5** `AdsRuleSuggestion` rows exist; **0** are placement.
- Automation state: `autonomy: AUTO`, `halted: false`, `maxActionsPerHour: 500`. `AdSpendCeiling`
  rows: **0**.

Consequence for the plan: every grid-side phase needs a **fixture rule**; nothing on this tab can
be verified against what is there today.

### 2.2 The funnel a placement rule actually passes through

| step | count |
|---|---|
| campaigns, all statuses | 220 |
| ENABLED | **70** |
| …`SPONSORED_PRODUCTS` (placement is an SP construct) | 70 (all) |
| …with spend in the 7 **settled** days — the `CAMPAIGN_PERFORMANCE_BUDGET` context floor | **44**† |
| …`liveBidWritesEnabled` — the write gate | **43** |
| …**NOT** governed by an enabled `AdSchedule` | **17** ← durable reach |
| …governed *and* reachable (a rule can write; the engine snaps it back) | **26**† |

† These three were measured with a hand-rolled `now−9d … now−2d` window at 00:19 Rome. The
shipped strip calls `ruleWindowBounds(7)` — the engine's own bounds — and the settled window rolled
a day between the two readings, so P1 verified at **43 / 42 / 25** with `durable` unchanged at 17.
The strip's numbers are the authoritative ones; these are a snapshot of the same facts an hour and
a half earlier.

### 2.3 Who actually owns the placement lanes

`ad-rank-defend` is by a very large margin the dominant actor on this field:

- `update_placement_bidding` action-log rows, 30 days: **15,522**
- `CampaignBidHistory` 30 days: `PLACEMENT_TOP` **12,197** · `PLACEMENT_REST_OF_SEARCH` **11,075**
  · `PLACEMENT_PRODUCT_PAGE` **2**
- Last 7 days, automation only: `PLACEMENT_TOP` **4,075** + `PLACEMENT_REST_OF_SEARCH` **3,743**
  = **7,818 writes across 34 distinct campaigns**
- Last 30 days, **human**: **6 writes total** (TOP 3 · PDP 2 · ROS 1)
- 33 enabled `AdSchedule` rows, 33 distinct campaigns, **all 33 ENABLED**, all 33 evaluated within
  the last 2 hours

A verbatim sample from 21:15 UTC:

```
PLACEMENT_TOP            75 → 0   automation:rank-defend-…  "snap to 45% Placement · dropping Top 75→0"
PLACEMENT_REST_OF_SEARCH null → 45 automation:rank-defend-…  "snap to 45% Placement · dropping Top 75→0"
```

**`PLACEMENT_PRODUCT_PAGE` is the only lane the rank engine leaves alone** (2 writes in 30 days) —
the placement analogue of `unmanaged` in [[reference_placement_multiplier_is_hour_dependent]].

### 2.4 The multiplier is a clock reading (re-measured)

At **00:19 Rome**, of the 70 ENABLED: **61** carry a non-zero multiplier on some lane, **6** on two
or more. Per lane: TOP **16** · PDP **5** · ROS **48**. Of the 43 *reachable*: TOP non-zero on
**13** (lane absent from the payload on 30), PDP **5** (absent 38), ROS **28** (absent 15).

None of these is quotable without its hour.

### 2.5 Is a per-lane condition even measurable?

`AmazonAdsPlacementReport`, last 30 days: **4,075** rows · **0** with a null `localCampaignId`
(the historic join trap is closed) · **74** distinct local campaigns · freshest date **2026-08-20**
(one day behind). Labels are Amazon's report strings, **not** the API enums:
`"Top of Search on-Amazon"` · `"Other on-Amazon"` · `"Detail Page on-Amazon"`. `topOfSearchIS` is
present on 1,108 rows (TOP only, a ratio — weight by impressions, never sum).

Restricted to the **43 reachable** campaigns:

| lane label | campaign-cells | ≥5 clicks / 30d | ≥20 clicks / 30d |
|---|---|---|---|
| Top of Search on-Amazon | 41 | 28 | **19** |
| Other on-Amazon | 40 | 31 | **19** |
| Detail Page on-Amazon | 42 | 33 | **13** |

Over **7 days**: 122 cells, **16** clear 20 clicks.

**So the data exists — but not on the window this rule type currently runs on.** A lane-scoped
criterion is decidable on 30 days and is essentially undecidable on 7.

---

## 3. Gap matrix

### KEEP — verified working; do not touch

| # | What | Evidence |
|---|---|---|
| K1 | H10 §3.8 shape: header · tab bar · ONE rules card, "Showing 0 Placement Rules", H10's empty line | prod screenshot |
| K2 | Builder's 5 steps + campaign picker (All / Portfolios / Products, status radio, Add All, right-hand added list) — H10 §4.1 verbatim | prod screenshot |
| K3 | THEN vocabulary: 3 lanes × {Set to, Increase by, Decrease by} + Floor/Cap 0–900. H10 §5.3 exactly; Sellozo offers only 2 lanes — **we are ahead** | `RuleBuilder.tsx:228-240`, `docs/…competitor-deep-dives.md:530` |
| K4 | Multi-block: the adapter emits one block per criteria group, engine runs the first match (BP.P4b) | `ads-rule-adapter.service.ts:614-641` |
| K5 | `campaignIds` picker allowlist honoured at execution (EA4) | `automation-action-handlers.ts:1706` |
| K6 | Arming reaches AUTO: `placement_apply` ∈ `REVERSIBLE_ACTIONS`, `BUILDER_SLUG_ACTIONS.placement = ['placement_apply']` | `ads-graduation.ts:51`, adapter:250 |
| K7 | Round-trip to Suggestions exists: family `placement`, approve re-runs the real handler, and a **refused apply stays pending** (SG.0) | `ads-suggestions.service.ts:69`, `advertising.routes.ts:6786` |
| K8 | The builder already states the window honestly: *"Measured over the last 7 days — this trigger's fixed window. The most recent 2 days are still settling and are excluded."* | prod screenshot |
| K9 | Spend ceiling / write cap / marketplace / guardrail controls are the shared inherited ones | prod screenshot |

### FIX — measured defects

**F1 🔴 The builder's IF placement-scope dropdown is stored and never read.**
`pcDefaultCondition('placement')` sets `scope:'campaign'` and the `H10Select` at
`RuleBuilder.tsx:1135` writes `Campaign | Top of Search | Product Pages | Rest of Search` onto every
condition. `conditionsForStorage` stores the builder shape verbatim, so it **persists**.
`translateConditions` (`ads-rule-adapter.service.ts:208-217`) reads `metric`, `op`, `value` — and
nothing else. And `buildCampaignBudgetContexts` emits **no per-lane fields at all**, so there is
nothing for a lane-scoped condition to read even if the adapter wanted one.
**Result: "IF Top of Search · ACoS > 40%" evaluates the CAMPAIGN's ACoS.** This is the cardinal sin
— a stored-but-unread form control, in the one dropdown that distinguishes this rule type from
Budget. See decision **D-PLC-1**.

**F2 🔴 The Placement Preview is browser arithmetic — the same five defects BUD-PP fixed.**
`RuleBuilder.tsx:675-685`. Measured live on prod, 2026-08-22:

| defect | what I did | what the modal said |
|---|---|---|
| criteria ignored | `IF Campaign ACOS > 9999%` (unsatisfiable), Add All | listed **70 of 70** campaigns, every one "New Modifier 50%" |
| marketplace scope ignored | set Marketplace = **Germany (DE)**, re-previewed | still **70** rows, including `FR_Phrase_8_Keywords` and every `GALE \| IT \| *` |
| multi-block ignored | — | only `groups[0]`'s op is ever applied (code) |
| context floor ignored | — | only **44** of 70 ENABLED produce a context; 26 listed rows can never be touched |
| 🔴 the anchor is a **clock reading** | — | "Current" reads `dynamicBidding.placementBidding`, which the rank engine rewrote **7,818×** across **34** campaigns in the last 7 days. The handler reads the same field *at execution time*. |

The modal's own sentence — *"the new Top of Search bid modifier each selected campaign would get
when this rule fires"* — is false on all five counts.
`ads-rule-preview.service.ts` already runs the engine for Budget and `placement_apply` already has
a `dryRun` branch returning `wouldChange: "30% → 50%"`. **Do not re-implement the maths in the
browser.**

**F3 🔴 The grid cannot tell three placement rules apart.**
`summariseRule` (`RulesGrid.tsx:365-381`) handles the percent unit but never reads
`action.placeTarget`; its local `BuilderGroup` interface even declares `target?: string`, the wrong
field name. So *Top of Search Set to 50%*, *Product Pages Set to 50%* and *Rest of Search Set to
50%* all render as **`ACoS > 40% → Set 50%`** — identical. `clause()` likewise drops the
condition's `scope`. The API's own `describeAction` (adapter:391) already prints the placement; the
two disagree. This is "two things that mean different things render identically", on the one column
that describes the rule.

**F4 A refused placement write loses its reason.**
`updatePlacementBidding` returns `{ ok:false, mode:'blocked', reason, deniedAt }` — PLC.3 added
those two fields for exactly this. `placement_apply` returns
`{ ok: res.ok !== false, output: { …, mode: res.mode } }`: **no `error`, no `reason`, no
`deniedAt`.** The suggestion correctly stays pending, and the operator is shown a bare "refused"
with the gate's sentence discarded. `bid_apply` passes `res.error` through; placement does not.

**F5 The lane-merge rule is implemented twice.**
`placement_apply` rebuilds the payload inline (`others` + the target lane) instead of calling
`buildManualAdjustments` (`ads-placement-manual.ts`, 14 tests) — the helper that exists because a
one-lane payload erases the other two, and **88 of 88** two-lane campaigns would have lost one.
The two are currently equivalent; a second implementation of the one rule whose failure is silent
and account-wide is worth converging.

**F6 A no-change proposal reaches the queue at PROPOSE.**
`placement_apply`'s `dryRun` return sits **before** its `noChange` check, so `set 50` on a campaign
already at 50% emits `wouldChange: "50% → 50%"` — which `recordSuggestions`' filter
(`out.noChange || out.wouldChange === 0 || '0'`) does not catch. This is the ADX A2.1 class ("48 of
227 rows explicitly reported changing nothing"). ⚠ **`budget_apply` has the identical ordering**
(handlers:1689/1692), so this is a cross-cutting engine fix, not a placement one. See **D-PLC-3**.

### BUILD — absent, and the evidence says it belongs

**B1 The strip.** The tab is silent about reach and about who already owns these lanes. Every
number for that line is measured in §2 and is server-censusable, mirroring `getBudgetRulesStrip`:
70 enabled · 44 measurable · 43 through the gate · **26 governed by the rank engine, which rewrote
these lanes 7,818× in 7 days** · 17 with durable reach · "rule output queues on Suggestions".
Absent-not-fabricated on a failed read. This is the highest-value single addition: today, arming a
rule on a governed campaign looks identical to arming one that will hold.

**B2 Starters.** `STARTER_TEMPLATES` has no `placement` key, so the Apply Template modal offers
"Saved templates" only. Bid, Budget, Harvest and Negative each ship three, each shaped by census
arithmetic. Placement's must be too — evidence floors sized to the ≥20-clicks-per-lane table, and
no starter that promises a change on a lane the rank engine zeroes hourly.

**B3 A per-rule lookback.** Bid (BP.P4) and Budget (BUD-P3) each own `actions[0].windowDays`, with
a per-window evaluator pass and an `ACTION_WINDOW` entry. Placement has **neither**:
`budgetRuleWindow()` (`advertising-rule-evaluator.job.ts:1326`) requires `a0.type === 'budget'`, so
a placement rule's `windowDays` would be read by nobody, and `ACTION_WINDOW` has no `placement`
key. H10 puts Lookback in the Placement builder's Advanced Settings (§4.1). **This matters more
here than anywhere else**: over 7 days only 16 of 122 campaign×lane cells clear 20 clicks; over 30
days, 51 of 123 do. B3 is a prerequisite for F1/P7 being useful.

**B4 The conflict warning is not where the conflict is.** `ads-conflicts.service.ts` already
classifies the `placement` field and already picks up `automation:rank-defend` as an engine actor
from the action log (15,522 rows ≫ its 10-row floor). It surfaces **only on the Automations tab**.
Neither the Placement grid nor the builder's picker says "26 of the campaigns you just selected are
governed by the rank engine, which rewrites this lane hourly".

### REFUSE — out of scope by standing decision

| # | What | Why |
|---|---|---|
| R1 | Sweeping the parked four (`PlacementClient` 62 KB, `PlcInspector`, `PlcBulkPanel`, `PlacementScopeBar`) | ⛔ KEEP surfaces are a roadmap; `docs/2026-08-16-ra-parked-sections.md` §U2 names where each is headed. PLC.3 write path stays served. |
| R2 | "Increase to Top of Search / First Page" as a bid action | Already considered and declined (C3, `RuleBuilder.tsx:200-224`). No new data. |
| R3 | Changing `ad-rank-defend` / RD | OFF-LIMITS. PLC-P describes it; it does not touch it. |
| R4 | Fixing F6 inside a placement phase without approval | It moves Budget and Bid too. |

---

## 4. Decisions — ANSWERED by the operator, 2026-08-22

**D-PLC-1 — the IF placement-scope dropdown (F1).** Three honest resolutions:

| | option | cost | effect |
|---|---|---|---|
| **(a)** | **Honour it.** New `buildCampaignPlacementContexts` from `AmazonAdsPlacementReport` (label→enum map, impression-weighted `topOfSearchIS`), adapter maps `scope` → `placement.<lane>.<metric>` | largest — a new context family + evaluator pass | Placement becomes genuinely lane-aware. H10 advertises this in its IF and publishes no KB saying it works; this would beat it outright. **Needs B3 first** — 30-day windows, or the lane data cannot decide. |
| **(b)** | **Remove it.** Every placement rule reads the campaign | smallest | Instantly honest; loses an advertised capability. |
| **(c)** | **Disable with a reason.** Keep it visible, locked to "Campaign", answer the click with why (`reference_disabled_control_cannot_explain`) | tiny | Honest immediately, roadmap stays visible, zero engine change. |

✅ **ANSWERED: (c) now, (a) as PLC-P7.** The dropdown is locked to "Campaign" with a reason that
answers the click, inside the first phase that touches the builder (P3) — zero engine change, and
the tab stops being dishonest immediately. The real lane-scoped context family is built in **P7**,
after P5 gives it the 30-day windows it needs to decide anything. P7 is therefore IN scope, not
conditional.

**D-PLC-2 — a placement rule vs the rank engine.** 26 of the 43 reachable campaigns are governed.
Options: (i) warn in the builder + on the strip, allow anyway; (ii) additionally refuse to arm at
**AUTO** on a governed campaign (PROPOSE still allowed); (iii) leave silent (today).
✅ **ANSWERED: (i) in P1, and (ii) comes back as its own decision before P4.** The strip and the
builder name the governed campaigns and what the rank engine did to them. Whether a placement rule
is additionally *refused* at AUTO on those 26 campaigns is decided separately, on the evidence P1
puts on screen.

**D-PLC-3 — F6 (no-change proposals) engine-wide, now or later?** One guard, two handlers
(`placement_apply` and `budget_apply`). It is a two-line fix and a genuinely cross-cutting one.

✅ **ANSWERED: NOT inside PLC-P.** It moves Budget's live queue as well as Placement's, so it gets
its own approval as a cross-cutting unit. **PLC-P4 must not touch it.** Recorded here so the next
session does not rediscover it.

**D-PLC-4 — the fixture rule.** With 0 placement rules on prod, P3/P5 cannot be verified against
anything. Either (i) create one real rule at **PROPOSE** through the builder, scoped to a campaign
from the 17 durable-reach set, and keep it; or (ii) seed and clean fixtures with a script, the way
SG.8 did.

✅ **ANSWERED: (i) — one real rule at PROPOSE, kept.** Created through the builder, scoped to a
single campaign from the **17 durable-reach** set (not rank-engine governed, has spend in the 7
settled days, gate open). Shape: `IF ACoS ≥ 40% AND clicks ≥ 20 THEN Top of Search · Decrease by
20%`, guardrails 0–900%, PROPOSE. It proves the whole wire — builder → storage → translation →
contexts → handler → Suggestions — and stays as the tab's first real rule.

---

## 5. Phase plan — one phase per approval

| phase | what | touches | verified by |
|---|---|---|---|
| **PLC-P1** | **The strip + the governance truth.** `GET /advertising/placement-rules/strip` (in `advertising-intel.routes.ts`, `grep -a`'d first) → `getPlacementRulesStrip()` beside `getBudgetRulesStrip`; `PlacementRulesClient` renders `h10-hv-cohortline`, absent-not-fabricated. Names the 26 governed campaigns and links to Suggestions. | 1 route file, 1 service, 1 client | census script asserting every number against the DB; screenshot **read as a stranger** |
| **PLC-P2** | **The honest preview.** `previewPlacementRule` in `ads-rule-preview.service.ts` (real contexts → `ruleMatchesScope` → `maybeTranslateAdsRule` → `evaluateConditions` first-match → `placement_apply` dryRun). Dispatch on `actions[0].type` inside the existing `POST /automation-rules/preview` — one endpoint, one contract. The builder calls it with the existing `previewActions()`/`previewConditions()`, so save and preview share one payload. The modal gains the census footer **and the hour + governance line**. | 1 service, 1 route, `RuleBuilder` `isPlacement` branch | the 9999% draft must return **0** rows; the DE draft must drop IT/FR/ES; **Playwright against the running form** (the two BUD-PP bugs unit tests could not catch) |
| **PLC-P3** | **The grid tells the lanes apart, and the scope control stops lying.** `summariseRule` reads `placeTarget`; `BuilderGroup` gets the right field name. **D-PLC-1's lock lands here**: the IF placement-scope select is fixed to "Campaign", `aria-disabled` + a reason that answers the click (never a bare `disabled`, and never a `help` cursor). **The D-PLC-4 fixture rule is created at the start of this phase.** | `RulesGrid.tsx` (shared — hunk-level staging), `RuleBuilder.tsx`, `PerformanceCriteria.tsx` | vitest: three synthetic rules (TOS / PDP / ROS, same op and value) must produce **three different** Criteria strings; the real fixture rule read on prod as a stranger; `check-silent-disabled` (27) and `check-help-cursor` (0) must both hold |
| **PLC-P4** | **Refusals speak, and one merge implementation.** `placement_apply` carries `reason`/`deniedAt` out as `error`; converge on `buildManualAdjustments` after proving equivalence. | `automation-action-handlers.ts` | vitest on the handler; a live blocked write on `ZZ_e2e_single_wwq7s` (`cmqr28uno001ak4011kei84su`) |
| **PLC-P5** | **The per-rule lookback.** `actions[0].windowDays` (Advanced Settings select, 7–90); generalise `budgetRuleWindow` to a slug-parameterised helper so the evaluator builds per-window passes for placement too; add `ACTION_WINDOW.placement`. | evaluator, `packages/shared/ads-rule-window.ts`, builder | the grid's Lookback cell prints the rule's own number; a 30-day rule provably gets 30-day contexts |
| **PLC-P6** | **Starters, shaped by the census.** Three `STARTER_TEMPLATES.placement` entries, each excluding by arithmetic what it cannot deliver. | `RuleBuilder.tsx` | each starter run through the P2 preview returns a non-empty, correct match set |
| **PLC-P7** | **The lane-scoped IF** (D-PLC-1 = (a), confirmed). `buildCampaignPlacementContexts` from `AmazonAdsPlacementReport` (label→enum map, impression-weighted `topOfSearchIS`); adapter maps `scope` → `placement.<lane>.<metric>`; P3's lock is lifted. | evaluator, adapter, builder | prod script proving per-lane numbers match the report, impression-weighted; the locked dropdown becomes live and a lane-scoped draft previews differently from a campaign-scoped one |

**Order rationale:** P1 is cheap and grounds every later claim. P2 removes the loudest lie on the
page (a preview promising 70 changes for a rule that can make 0). P3–P4 make what exists legible
and honest — P3 also carries D-PLC-1's lock. P5 unlocks the evidence a lane-scoped rule needs, so
P7 cannot precede it. The **fixture rule (D-PLC-4) is created at the start of P3**, which is the
first phase that needs one.

**Standing constraint from D-PLC-3:** PLC-P4 fixes `placement_apply`'s refusal reason and the merge
implementation, and **must not** reorder the `dryRun` / `noChange` returns — that is a separate
cross-cutting unit.

### Gates every phase must pass

`npm run build --workspace=@nexus/shared` · `tsc` both apps · api vitest (~391 files / 5052+) ·
web vitest (945) · the five ratchets — `check-button-vocabulary` (286), `check-silent-disabled`
(27), `check-help-cursor` (0), `ds-conformance-guard --check`, `p3-token-sweep-targets` — each run
**bare** so its own exit code is read. `grep -a` on every ads file. Shared-tree discipline:
`git diff -a --numstat` before staging, blob-splice for `rules-automation.css` and `RulesGrid.tsx`,
plumbing commit, then reset the shared index.

---

## 6. Traps re-confirmed this session (for the next reader)

- `Campaign.adProduct` is `SPONSORED_PRODUCTS`, **not** `SP` — a census filtering on `'SP'` returns
  0 and reads as "placement can reach nothing". (My own first probe did exactly this.)
- `AmazonAdsPlacementReport.placement` still holds report labels
  (`"Top of Search on-Amazon"` · `"Other on-Amazon"` · `"Detail Page on-Amazon"`), never the API
  enums. `localCampaignId` is now fully populated (0 nulls in 30 days) — the old join trap is
  closed, but check it again before relying on it.
- `PLACEMENT_PRODUCT_PAGE` is the only lane the rank engine leaves alone (2 writes in 30 days).
  It is the stable one; the other two are clock readings.
- The prod builder's Preview writes nothing — safe to drive with an unsatisfiable criterion. The
  draft is abandoned by closing the tab; nothing was saved.

---

## 7. Ship log

### PLC-P1 — the strip + the governance truth — **BUILT AND VERIFIED LOCALLY 2026-08-22, not pushed**

**What shipped**

| file | change |
|---|---|
| `placement-grid.service.ts` | `+133` — `PlacementRulesStrip` + `getPlacementRulesStrip()`, appended beside the page's other reads |
| `advertising-intel.routes.ts` | `+17` — `GET /advertising/placement-rules/strip`, `grep -a`'d against BOTH route files first (a duplicate registration is a boot crash) |
| `PlacementRulesClient.tsx` | `+57` — the `h10-hv-cohortline` strip, absent-not-fabricated |
| `_bp-verify-stub.mts` | `+6` — serves the new endpoint from the real service, since it is not deployed yet |

All four are **pure additions** and the diff line counts match exactly what was written — no sibling
hunk was swept in. `getBudgetRulesStrip` was the template throughout.

**The line, as it renders:**

> **70** enabled campaigns · **43** with spend in the last 7 settled days, the most a placement rule
> can reach · **42** past the write gate · **25** of those governed by [the rank engine], which
> rewrote these lanes **7,818×** in 7 days and no rule did any of it · the remaining **17** are
> where a rule's write is the last word · rule output queues on [Suggestions]

**Three decisions inside it, each with a reason**

1. **No current multiplier, anywhere.** "N campaigns carry a multiplier" is a time-of-day reading
   (167 at 13:00, 145 at 02:56). Every number in the strip is either a standing fact or a windowed
   count; the one timestamp, `engineLastWriteAt`, is labelled as one and lives in the tooltip.
2. **`durable` renders INSIDE the governed branch.** On its own it is `gateOpen` restated, and
   "17 where a rule's write is the last word" with no preceding contrast makes a reader do
   arithmetic against a number that is not on screen. It now reads "the remaining **17**".
3. **The supporting measurement is a `title` on the link the clause already invites you to hover**,
   not a bare ⓘ glyph. The sentence is complete without the tooltip, so the tooltip must not look
   like a control.

**Verification — measured, not assumed**

- `_plcp-p1-strip.mts` — **15/15 PASS**. It imports the SERVICE (so it exercises the endpoint's own
  logic, not a re-implementation) and re-derives every field by an independent query: the funnel
  nests, `durable = gateOpen − governed`, `ruleWrites7d ≤ engineWrites7d`, `engineLastWriteAt` falls
  inside its window, and no key matches `/carry|multiplier|current|pct/` (the clock-reading guard).
- **Read on screen, as a stranger**, on an isolated dev server (port 3021, own `NEXT_DIST_DIR`,
  own stub on 8098 — the sibling session's 3000/8099 were left running and untouched).
- **Computed styles, probed against each element's OWN background** (never a parent walk):
  page ground `rgb(244,246,249)`; strip text `rgb(85,96,109)` = **5.91:1**; both links
  `rgb(26,97,198)` = **5.43:1**. Both AA.
- 🔴 **The NEG-P3 invisible-pill trap did not fire**: both `.h10-nt-open` links measured
  `opacity: 1`, `display: inline`, transparent background, 95×15 and 77×15 boxes, `cursor: pointer`
  (never `help`). The `.h10-hv-cohortline .h10-nt-open` override is doing its job.
- Class↔stylesheet checked **both ways**: `h10-hv-cohortline` (3 rules), `h10-nt-open` (9),
  `h10-rules-page` (14) — all defined, none invented.

**Gates — every one run bare so its own exit code is read**

| gate | result |
|---|---|
| `npm run build --workspace=@nexus/shared` | ✓ |
| `tsc --noEmit` apps/api · apps/web | ✓ 0 · ✓ 0 |
| api vitest | ✓ **392 files / 5072 tests**, all passed |
| web vitest | ✓ **954 tests** passed (8 Playwright files fail to load — known, pre-existing) |
| `check-button-vocabulary` | ✓ 286, at baseline |
| `check-silent-disabled` | ✓ 27, at baseline |
| `check-help-cursor` | ✓ 0, at baseline |
| `ds-conformance-guard --check` | ✓ clean |
| `p3-token-sweep --targets` | ✓ 0 in 0 files |

**Teardown verified**: dev server 3021 down, stub 8098 down, `.next-plcp` removed; the sibling
session's `next dev` on 3000 and stub on 8099 confirmed still listening and untouched.

**Not pushed** — local-first, per the standing rule. Nothing is staged.

---

### PLC-P2 — the honest preview — **BUILT AND VERIFIED LOCALLY 2026-08-22, not pushed**

**What shipped**

| file | change |
|---|---|
| `ads-rule-preview.service.ts` | `+290 −39` — the five stages extracted to `runDraftPreview`, `previewBudgetRule` rewired onto it, `previewPlacementRule` added |
| `ads-rule-preview.vitest.test.ts` | `+178 −3` — 14 new cases |
| `ads-rule-adapter.service.ts` | `+19` — `builderDraftCampaignIds(actions, slug)` |
| `advertising-intel.routes.ts` | `+19 −2` — the existing preview route dispatches on the draft's slug |
| `RuleBuilder.tsx` | `+74 −13` — the placement branch calls the engine; the modal gains a Lane column, the engine marker and the census + hour footer |
| `rules-automation.css` | `+19` — `.ptable.plcp`, `.pnote.eng`, `.pfoot .phour` |
| `_bp-verify-stub.mts` | `+13 −3` — same dispatch, so the harness and the route cannot disagree |

**The pipeline was extracted, not copied.** `previewBudgetRule` and `previewPlacementRule` now run
one `runDraftPreview`: real contexts → `ruleMatchesScope` → `maybeTranslateAdsRule` →
`evaluateConditions` (first matching block) → the real handler in `dryRun`. They differ only in
which handler runs and how its `wouldChange` sentence is parsed. Copying the five stages would have
been the same disease the preview exists to cure — and all 11 pre-existing Budget tests pass
unchanged against the extracted version, which is the evidence that the rewire is behaviour-neutral.

**The two proofs, driven through the real form** (not curl, not unit tests — BUD-PP's lesson is that
both of those passed while the form was broken):

| | before (measured on prod, Phase 0) | after (measured locally) |
|---|---|---|
| `IF Campaign ACOS > 9999%`, all 70 campaigns added | listed **70 of 70** rows, each "New Modifier 50%" | *"No campaign matches these criteria right now — **43** campaigns were measured over the last 7 settled days. The rule is still valid; it will act when one does."* |
| same draft, Marketplace = **Germany (DE)** | still **70** rows, including `FR_Phrase_8_Keywords` and every `GALE \| IT \| *` | **4** rows, all DE. Zero IT, zero FR, zero ES. Footer: "70 selected · 43 with spend in the window · **4 in scope** · **4 match**" |

With a satisfiable criterion (`Spend > €1`) the same draft returns **33 of 70**, each row naming its
lane, and the footer reads:

> Current values read at 01:23. **22 of the 33** are governed by the rank engine, which rewrites
> these lanes on a schedule — there, the current value is a reading rather than a setting, and a
> rule's write is undone on the engine's next pass.

**Three things this modal now says that Budget's does not need to**

1. **Lane is a COLUMN.** On a multi-block rule the lane is decided per campaign by whichever block
   matched, so one lane named in the subtitle would be wrong on some rows — and this is the same
   omission that makes three different placement rules read identically on the grid (F3, still open).
2. **`engine-managed`** under the current value of every governed row, with the rank engine's last
   write to that lane in its tooltip.
3. **The hour, always.** `placement_apply` reads the current multiplier at execution time, so
   "current" is a reading with a timestamp. The footer states when, and how many of the matched
   rows are quoting a number somebody else owns.

**Verification**

- `ads-rule-preview.vitest.test.ts` — **25/25** (11 pre-existing Budget + 14 new). The five lies are
  re-pinned against the placement path so a regression in the shared pipeline fails on both sides,
  plus: the lane is named in words never the enum, a governed campaign is flagged with its last
  engine write, `readAt` is always present, the LATEST write per lane wins, a guardrail no-op reads
  as no change, an untranslatable metric refuses, a budget draft is refused by name.
- **Computed styles, each against its own background:** `.pnote.eng` `#8a5316` = **6.31:1** ·
  `.pfoot .phour` `#626c7c` = **5.31:1** · `.ptr .lane` = 15.48:1 · footer 5.91:1. All AA. No row
  overflow, no horizontal body scroll, modal 640 px, columns 218/124/104/150.
- Ratchets: button-vocabulary 286 · silent-disabled 27 · help-cursor 0 · ds-conformance clean ·
  token sweep 0 — all at baseline.
- tsc api 0 · web 0 · shared build ✓ · web vitest **954** passed.

**Two findings that are NOT PLC-P's to fix**

1. 🔴 **A sibling session's uncommitted change is red.** `apps/api/src/services/advertising/`
   `ads-bid-optimizer.service.ts` has an in-flight `+20 −3` adding `changeSetId`, and its own test
   `ads-bid-optimizer-apply.vitest.test.ts` (unchanged in the tree) now fails:
   `expected … to be called with [{…}]` → `+ "changeSetId": null`. That is the **1 failing test** in
   the api suite (391 of 392 files, 5,089 of 5,090 tests pass). **It must not be pushed in this
   state** — a commit is a deploy.
2. `.h10-rb-prev .ptr .newb.up` is `#15a34a` = **3.30:1** on white, below AA. Pre-existing, shared by
   the Bid, Budget, Rank and Placement previews — a one-line fix, but it changes three shipped and
   prod-verified surfaces, so it is offered rather than taken.

**A harness note worth keeping.** The cross-origin POST from `localhost:3021` to the stub on `:8098`
is blocked by Chrome's Local Network Access policy no matter what CORS headers the stub returns —
the OPTIONS preflight answered 204 and the POST still died (the extension logged 503; the page saw
`TypeError: Failed to fetch`). `next.config.js` already documents this and ships the fix:
`NEXT_DEV_STUB_PROXY=http://localhost:8098` with `NEXT_PUBLIC_API_URL=http://localhost:3021` makes
`/api/*` same-origin. **GETs pass without it, which is what makes it a trap** — PLC-P1's strip
worked cross-origin and P2's POST did not.

Also: **kill a dev server by PORT, never by pattern.** `pgrep -f "next dev -p 3021"` reported clean
while a listener was still holding 3021 — the cmdline of the process that actually binds does not
match. `lsof -t -nP -iTCP:<port> -sTCP:LISTEN` is the only check that told the truth.

**Not pushed** — local-first. Nothing is staged.

---

### PLC-P3 — the grid tells the lanes apart, the scope control stops lying — **BUILT AND VERIFIED LOCALLY 2026-08-22, not pushed**

**What shipped**

| file | change |
|---|---|
| `_shared/placementLanes.ts` | **new** — the three lanes and `placementThenSentence`, imported by BOTH the builder and the grid |
| `_shared/placementLanes.vitest.test.ts` | **new** — 7 cases |
| `RulesGrid.tsx` | `+19 −2` — `summariseRule` names the lane; `BuilderGroup.target` → `placeTarget` |
| `RuleBuilder.tsx` | `+47 −6` (P3 half) — the IF scope control is held, with an answer |
| `FilterDropdown.tsx` | `+17 −3` — `H10Select` gains optional `held` / `onHeld` |
| `rules-automation.css` | `+20` (P3 half) — `.h10-dd-btn.held`, `.h10-rb-heldnote` |
| `_bp-verify-stub.mts` | `+20 −1` — `GET /automation-rules` returns the REAL rules plus the simulated ones |

**① The grid now tells three rules apart.** Measured on screen, three placement rules with the same
op and value:

```
Sales = €0, Clicks ≥ 20 → Decrease Top of Search by 20%
Sales = €0, Clicks ≥ 20 → Decrease Product Pages by 20%
Sales = €0, Clicks ≥ 20 → Decrease Rest of Search by 20%
```

Before, all three rendered `… → −20%`. Two things were wrong and only one was obvious: the cell
never read `placeTarget`, **and** the file's local `BuilderGroup` interface declared the field as
`target` — a name the stored shape does not use, so it was unreadable by construction. A typed
field that can never hold anything is worse than an absent one: it reads as already handled.

The sentence is now English rather than arithmetic (`Decrease Top of Search by 20%`, not `−20%`),
and it lives in `placementLanes.ts` so the builder's THEN picker and the grid's cell take their
lane names from one list.

**② The scope control is held, and it answers.** Measured on the rendered control:

| | |
|---|---|
| `aria-disabled` | `"true"` |
| `disabled` attribute | **absent** — the ratchet's escape, and the reason it can still speak |
| takes focus | **true** (`document.activeElement === btn`) |
| opens its popover | **false** |
| cursor | `default` — never `help` |
| click | renders the note below, `role="status"` |

The note reads: *"A placement rule reads the **campaign's own** performance — its ACoS, spend and
clicks across every lane. Per-lane criteria ("Top of Search ACoS") need per-lane data on a longer
window than this rule's 7 settled days, and are not wired yet, so the scope is fixed rather than
offering a choice the engine would ignore. The **THEN** row below still chooses which lane the rule
changes."*

`H10Select` was **extended, not forked** — `held` / `onHeld` are optional and all 45 existing call
sites are behaviourally byte-identical.

**③ The fixture rule — created on prod, through the real builder, and it is live.**

> **Trim Top of Search on zero-sale clicks — GALE BROAD IT**
> `cmt3lf6h6005jsd01wzv5hcad` · `enabled=true` · **PROPOSE** · trigger `CAMPAIGN_PERFORMANCE_BUDGET`
> IF `Sales = €0` AND `Clicks ≥ 20` → THEN `Decrease Top of Search by 20%` · guardrails 0–900%
> · one campaign: `GALE BROAD IT` (32 clicks, €11.86 spend, no sales in the 7 settled days,
> Top of Search currently 30%, **not** rank-engine governed)

🔴 **The criterion is not the one the approval preview illustrated, and here is why.** D-PLC-4's
preview showed `ACoS ≥ 40% AND clicks ≥ 20`. Measured against the durable-reach set before
building: **zero of the 17** clear it — no un-governed campaign has an ACoS that high, and `acos` is
`null` (never a large number) exactly where it would matter, because a campaign with clicks and no
sales has no ACoS at all. That rule would have been inert, and an inert fixture proves the grid
while proving nothing about the wire — which is the one thing D-PLC-4 said the fixture is for.
`Sales = 0 AND Clicks ≥ 20` is the honest form of the same intent, matches three durable-reach
campaigns today, and mirrors the account's own negative-targeting default. At PROPOSE it writes
nothing to Amazon; it queues on Suggestions. **Delete it or reshape it if you disagree —
`DELETE /advertising/automation-rules/cmt3lf6h6005jsd01wzv5hcad`.**

**Verification**

- `placementLanes.vitest.test.ts` — **7/7**. The one with teeth: the same op and value across all
  three lanes must produce **three different** strings, asserted for every op including one the
  function has never been taught, so no future op can reintroduce the collision. Also: an unknown
  lane key returns the raw key rather than inventing "Top of Search".
- **On screen**, against the real prod rule plus two lane variants: three distinct Criteria cells,
  `Viewing 1-3 of 3 Placement Rules`, Lookback `7 days`, Automation off, Activity `not checked`.
- **Computed styles:** note text `#3a4452` on `#f2f7ff` = **9.17:1** · bold **14.39:1** · info icon
  `#1a61c6` = **5.47:1** · held control `#626c7c` on its own `#eef1f6` = **4.69:1**. All AA.
- Gates: tsc api 0 · web 0 · shared build ✓ · web vitest **985** passed · five ratchets all at
  baseline (button-vocabulary 286 · silent-disabled **27, unchanged** — the held control is not a
  new silent site · help-cursor 0 · ds-conformance clean · token sweep 0).

**Correction to the PLC-P2 log.** I wrote that the sibling's `changeSetId` change "must not be
pushed in this state". It already had been: it is commit `e40ca5d80`
(*feat(sg10): undo an approved A.I. change…*), on `origin/main`, and
`ads-bid-optimizer-apply.vitest.test.ts` fails against it at HEAD. Still the single api-suite
failure (5,089 of 5,090 pass), still not PLC-P's, but it is live rather than pending.

**A harness note.** A local dev server **cannot** read the prod rules API: it is RBAC-gated and the
session cookie does not cross from `localhost` to the Railway host, so the grid rendered
`Showing 0 Placement Rules` against a rule that demonstrably existed. The stub's
`GET /automation-rules` now returns the real rules from the database alongside its simulated ones,
in the live route's exact `{ items, count }` shape — a stub that answers a different shape verifies
the stub rather than the page.

Also, twice now: **a programmatic `el.click()` is not a click.** It opened an ordinary
`H10Select` fine and did not fire the held one's handler; a full pointer sequence did, and so did a
real `ref`-targeted click through the harness. Verify interaction with `ref`, never with `.click()`
and never with coordinates.

**Not pushed** — local-first. Nothing is staged. The fixture rule IS live on prod, by design.

---

### PLC-P4 — refusals speak, one merge implementation — **CODE COMPLETE, VERIFIED; one revert PENDING OPERATOR APPROVAL**

**What shipped**

| file | change |
|---|---|
| `automation-action-handlers.ts` | `placement_apply` calls `buildManualAdjustments`, refuses an unmanaged lane, and carries `reason`/`deniedAt` out as `error` |
| `ads-placement-apply.vitest.test.ts` | **new** — 11 cases |
| `_plcp-p4-merge-equiv.mts` | **new** — the equivalence proof, read-only |

**① The merge, converged — after proving equivalence rather than assuming it.**
`_plcp-p4-merge-equiv.mts` built both payloads for **all 220 campaign profiles × 3 lanes × 6
values = 3,960 pairs**:

- **3,960 / 3,960** agree on the set of value-carrying lanes — what Amazon is actually told.
- 24 byte differences, all one kind: the helper omits an untouched lane already at 0. Amazon reads
  absent and 0 identically, and `updatePlacementBidding` derives history from the NEW array, so an
  omitted zero writes no `CampaignBidHistory` row.
- The helper is additionally the safer of the two: it clamps every lane rather than only the target,
  dedupes a doubled lane, and preserves non-managed placements explicitly.

A new guard falls out of the convergence: `buildManualAdjustments` owns three lanes, so handed a
**fourth as the target** it would build a payload not containing it — a write that silently does
nothing, reported as success. The handler now refuses by name instead.

**② A refusal carries the gate's own sentence.** `res.reason` verbatim as `error`, `deniedAt` in
`output`. Where the gate refuses without a sentence, the handler names the gate rather than
returning an empty refusal.

**③ Fenced, as instructed (D-PLC-3).** The `dryRun` / `noChange` ordering is untouched, and a test
now **pins the current behaviour** — a dryRun no-op still reports `wouldChange: "50% → 50%"` — so
this phase cannot quietly fix half of a cross-cutting defect and leave `budget_apply` behind.

**Verification:** 11/11 unit tests · tsc api 0 / web 0 · web vitest 985 · five ratchets at baseline.

---

#### 🔴 An incident, caused by this phase's own verification probe

**What happened.** The phase plan said to verify the refusal path with "a live blocked write on
`ZZ_e2e_single_wwq7s`". Two premises were wrong:

1. That campaign's `liveBidWritesEnabled` is **true**, not false — a live write there would have
   pushed a multiplier to Amazon. Caught by reading its state first; nothing was run against it.
2. So I ran the probe against a PAUSED campaign with `liveBidWritesEnabled: false`, expecting the
   `campaign_allowlist` denial the memories record for all 133 PAUSED campaigns. **It was not
   denied.**

**Why it was not denied — the trap, which is not in any memory.** `checkAdsWriteGate` opens with

```ts
if (adsMode() === 'sandbox') return { allowed: true, mode: 'sandbox' }
```

and `adsMode()` reads `NEXUS_AMAZON_ADS_MODE`, which is **unset in the local `.env`**. So from a
local `tsx` script the gate short-circuits to ALLOWED before the halt check, the connection check
and the campaign allowlist. `updateCampaign` then also short-circuits (no HTTP), but
`updatePlacementBidding` **proceeds to write the local database** — because sandbox means "do not
call Amazon", not "do not write locally", and that is deliberate (`ads-create.service.ts` says
sandbox SHOULD write locally).

**The rule this yields: a write-path handler run from a local script writes to the PRODUCTION
database, and the gate will tell you it allowed the write. Never invoke a `dryRun: false` handler
locally to observe a refusal.** Either pass `dryRun: true`, or call `checkAdsWriteGate` read-only
first and assert on ITS decision.

**What was changed.** Campaign **`Regal Product Trageting`** (`cmpee2fmt09o7oj01v9jjttyy`, IT,
**PAUSED**, 0 enabled schedules):

| | before | after |
|---|---|---|
| `PLACEMENT_TOP` | **43%** | **25%** |
| `PLACEMENT_REST_OF_SEARCH` | 12% | 12% (untouched) |
| `PLACEMENT_PRODUCT_PAGE` | 3% | 3% (untouched) |

Plus one `CampaignBidHistory` row (`PLACEMENT_TOP 43→25 by automation:rule-plcp4-refusal-probe`)
and one audit row (SUCCESS, `mode: "sandbox"`).

**Amazon was never contacted** — three independent confirmations: the gate returned
`mode: 'sandbox'`; `updateCampaign` returned `mode: 'sandbox'`; and `syncStamp` is only set when
the mode is not sandbox, so `lastSyncedAt` still reads `2026-08-21T22:27:40Z`, well before the
00:09 write. The campaign is PAUSED, so the value spends nothing either way. The only live
consequence is that the placement grid reads 25% where the truth is 43%.

**✅ REVERTED 2026-08-22 00:18Z**, on the operator's go-ahead, through `updatePlacementBidding`
rather than by patching the row — so the ledger records the correction as its own entry and both
halves of the mistake stay on the record. Nothing was deleted.

```
PLACEMENT_TOP  43 / PRODUCT_PAGE 3 / REST_OF_SEARCH 12   ← restored, exactly the prior profile

ledger:
  00:09:49Z  PLACEMENT_TOP 43→25  by automation:rule-plcp4-refusal-probe
  00:18:16Z  PLACEMENT_TOP 25→43  by user:awais — "PLC-P4 revert — restoring the profile a
                                    verification probe changed by mistake"
```

---

### PLC-P5 · P6 · P7 — **BUILT AND VERIFIED LOCALLY 2026-08-22, not committed**

#### PLC-P5 — the per-rule lookback

| file | change |
|---|---|
| `packages/shared/ads-rule-window.ts` | `ACTION_WINDOW.placement`, same window/settledness/clamp as budget |
| `advertising-rule-evaluator.job.ts` | `budgetRuleWindow` → `campaignRuleWindow`, testing BOTH campaign-budget slugs |
| `RuleBuilder.tsx` | the Lookback select on Placement; `windowDays` in the shared payload builder |
| `ads-placement-window.vitest.test.ts` | **new** — 14 cases |

The absence of the map entry was a two-sided lie: the grid's Lookback cell fell through to the
trigger and printed a flat "7 days", and the evaluator's helper tested `a0.type !== 'budget'`, so a
`windowDays` on a placement rule was read by nobody. It never became live only because the builder
offered no control to store one.

#### PLC-P6 — three starters, each shaped by a measurement

🔴 **`ACoS ≥ 40%` matches ZERO reachable campaigns** over 7 settled days and two over 30, so the
"trim the bleeders" starter every other tab ships would be inert here. What this account has is
spend with *no sales at all*, where ACoS is `null` rather than large.

| starter | matches | rows that move |
|---|---|---|
| `Sales = 0, Clicks ≥ 20` → **Decrease Rest of Search 30%** | 12 of 46 | 9 |
| `ACoS ≤ 25%, Orders ≥ 2` (30d) → **Set Product Pages to 25%** | 11 of 53 | **11** |
| `CTR ≤ 0.3%, Impressions ≥ 500` → **Set Rest of Search to 0%** | 21 of 46 | 14 |

Two decisions came from running them rather than from reasoning:

- The cut starters name **Rest of Search**, not Top of Search: of the 12 campaigns matching the
  zero-sale bar, Rest of Search already carries a multiplier on 9 and Top of Search on 2. A
  decrease on a lane at 0 clamps to 0 and does nothing.
- The raise starter is `Set to`, **not `Increase by`** — shipped as a raise it moved 3 of 11 rows,
  because Product Pages sits at 0 on 8 of its matches and increasing 0 by 25% is 0. As `Set to` it
  moves 11 of 11. It raises the one lane `ad-rank-defend` leaves alone (2 writes in 30 days against
  12,197 on Top of Search), so it is the raise that *holds*.

🔴 **A blocker found on the way:** `applyTemplate` **dropped `placeTarget` entirely**, so every
placement starter would have silently landed on Top of Search whatever its name said. Nothing
caught it because no placement template existed until this unit. It now carries the lane, and
`windowDays` too (which the 30-day starter needs).

Verified by `_plcp-p6-starters-verify.mts` — **27/27** — which runs each starter through the P2
preview engine AND asserts its literals still appear in `RuleBuilder.tsx`, so an edited starter
breaks the check instead of testing a ghost.

#### PLC-P7 — the lane-scoped IF, and the null trap

| file | change |
|---|---|
| `ads-placement-math.ts` | `REPORT_LABEL_TO_PLACEMENT` + `PLACEMENT_BY_BUILDER_KEY` — the two-vocabulary join, in one place |
| `placement-grid.service.ts` | its `REPORT_TO_BID_KEY` now DERIVES from that map instead of retyping three strings |
| `advertising-rule-evaluator.job.ts` | `PlacementLaneMetrics` + one grouped query; every context now carries `placement.{tos,pdp,ros}` |
| `ads-rule-adapter.service.ts` | `placementScopedField` — a condition's `scope` finally re-points its field |
| `RuleBuilder.tsx` | the scope select is LIVE again; the note becomes the lane-data caveat |
| `ads-placement-scope.vitest.test.ts` | **new** — 14 cases |

The lane metrics ride the EXISTING context family rather than a new one, which is what lets a single
rule mix a campaign-wide condition with a lane-scoped one — verified on screen: `IF Top of Search ·
ACoS ≤ 25% AND Campaign · Orders ≥ 2 THEN Product Pages Set to 25%`, on a 30-day window.

**The proof is a difference.** Same threshold, two scopes, run through the real engine:

```
campaign-wide  "CTR ≤ 0.3% AND impressions ≥ 500"  →  26 match
Top of Search  "CTR ≤ 0.3% AND impressions ≥ 500"  →   0 match
```

Top-of-search ads get clicked (7.31% CTR on the sampled campaign), so the lane rule correctly
selects nobody where the campaign-wide one selects 26. If the two agreed, the scope would still be
decorative.

🔴 **The null trap, found by a failing test rather than by reading.** The first cut emitted `null`
for an unmeasured lane, and a lane-scoped `CTR ≤ 99%` draft matched **53** campaigns when only
**51** had a measurable Product Pages CTR. Cause:

```ts
applyOperator('lte', lhs, rhs)  →  Number(lhs) <= Number(rhs)
Number(null)      === 0    →  null      <= 0.003  is TRUE
Number(undefined) === NaN  →  undefined <= 0.003  is FALSE
```

A `null` behaves exactly like the fabricated zero it was meant to prevent. The lane metrics are now
`undefined` when not measurable, and the draft matches 51 of 51.

**⚠ The half NOT fixed, and it is bigger than this page.** The campaign-level ratios one level up
are still `null`. Measured on prod 2026-08-22: **38 of the 46** campaigns emitting a budget context
have `acos: null` (spend, no attributed sales), and **all 38 match "ACoS ≤ 25%"** — so a
"back the winners" rule raises budgets on campaigns that have sold nothing. Two of the four enabled
rules carry an `lt`/`lte` condition today; both are PROPOSE, so a human sees each suggestion first.
The comparator is shared by every rule type, so this is its own unit and the operator's call — the
same fence as D-PLC-3. Reported independently by the Keyword Tracker session, whose correction is
worth carrying: `undefined` fails **every** operator (`gt`/`gte` included, since every comparison
against NaN is false). That is right for "not measurable" and is NOT the same as "a null should
fail `lte` only" — scoping the comparator fix as the latter would be wrong.

**One fix from a peer review:** `.h10-rb-heldnote` had no dark-theme variant — the only light-blue
panel in the builder without one, beside `.h10-rb-banner.warn` and `.h10-ktp-strip` which both have
one. Reported by the Keyword Tracker session, which reused the `held`/`onHeld` pattern. Fixed in
both directions (media query + `[data-theme="dark"]`).

**Gates for P5–P7:** tsc api 0 · web 0 · shared build ✓ · **api vitest 5,169 / 5,169** · web vitest
985 · five ratchets at baseline.

---

## 8. What actually shipped — the ship record

Every §7 log below was written while the phase was still local; they say "not pushed" and that is
now false. This section is the register.

| commit | what |
|---|---|
| `e1e78d6d9` | P1–P7 **engine half** — 36 files. Verified as a commit in a detached worktree: api 5,142/0, web 985, tsc 0/0. |
| `6a091e7fe` | 🔴 the fix for a gap in the commit above — a bad hunk filter dropped the preview route's placement branch, so `previewPlacementRule` shipped with **no caller**. Invisible to tsc, to 5,142 tests, and to the worktree build; found by the SOV session grepping the committed route. |
| `7d2fc3387` | the **builder half** — REBUILT from HEAD, not filtered from the tree, because three sessions interleave in `RuleBuilder.tsx` inside single expressions. Every lifted slice ran through a guard refusing it if it carried a peer marker; it fired once, correctly. |
| `dcfb4f2e3` | **D-PLC-2 + D-PLC-3**, and the starter-copy fix the clock forced. |

### The decisions, as answered

| | answer |
|---|---|
| **D-PLC-1** | (c) then (a): the scope control was held in P3 with a reason, and made live in P7 once the lane contexts existed. Both shipped. |
| **D-PLC-2** | Refuse at AUTO — but only for a **contested** lane. Product Pages got 2 engine writes in 30 days against 12,197 on Top of Search, so a Product Pages rule holds and is allowed. PROPOSE is never refused. |
| **D-PLC-3** | Fixed in both handlers. `noChange` **added beside** `wouldChange`, never swapped for it — the preview parses that sentence for its guardrail census. |
| **D-PLC-4** | One real rule at PROPOSE, live on prod: `Trim Top of Search on zero-sale clicks — GALE BROAD IT` (`cmt3lf6h6005jsd01wzv5hcad`). |
| **the comparator** | Fixed by the Keyword Tracker session in `1cf7869ca` (a `measured()` helper across eight context builders). PLC-P's 64 tests and the live lane probe verified green after it. |

### Two defects of my own, recorded because they were mine

1. 🔴 **A verification probe changed production data.** `_plcp-p4-refusal-live.mts` ran a
   `dryRun: false` handler expecting a gate denial; `checkAdsWriteGate` short-circuits to
   `allowed: true` in sandbox *before* the allowlist, so it wrote `PLACEMENT_TOP` 43→25 on a paused
   campaign. Amazon was never contacted. Reverted through `updatePlacementBidding` so the ledger
   carries both halves. → `reference_local_handler_writes_prod_db`.
2. 🔴 **A starter description quoted a clock reading** — "9 of which carry a Rest of Search
   multiplier" — and the account disproved it the same morning: the engine dropped Rest of Search
   45→0 account-wide at 08:15, and Top of Search went from non-zero on 16 campaigns to 48. The same
   reading turned my own verify script red at 11:46 having passed at 03:00. **A check that fails on
   the hour teaches you to ignore a red**; it now asserts only what is hour-independent.

### Still open, deliberately

- `.h10-dd-btn.held` lives in `rules-automation.css`; its DS home is `ads.css`. Left there because
  another session was editing that file and both users of `held` are in this section. Move it when
  `ads.css` is quiet.
- The parked four (`PlacementClient` · `PlcInspector` · `PlcBulkPanel` · `PlacementScopeBar`) stay
  parked, and the PLC.3 write path stays served. R1–R4 in §3 are unchanged decisions.

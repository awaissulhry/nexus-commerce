# AUTO — Automations as its own page: the control plane

*Page 10 of 11, Rules & Automation. This page is **already routed**; the question is not "convert it"
but **what the control plane must become when the other ten are pages too**.*

**Read-only study. Nothing was changed, no code was written, nothing was committed.**
Measured on production 2026-08-11 with `apps/api/scripts/_auto-page-{govern,conflicts,attribution,caps,capcheck}.mts`.

Supersedes the tab study [`2026-08-11-auto-automations-study.md`](2026-08-11-auto-automations-study.md)
and **corrects it in three places** (§0.1). Sibling studies cited, never re-measured:
[kt](2026-08-11-kt-keyword-tracker-study.md) ·
[sov](2026-08-11-sov-share-of-voice-study.md) ·
[plc](2026-08-11-plc-placement-study.md) ·
[bs](2026-08-11-bs-budget-schedules-study.md) ·
[rd](2026-08-11-rd-rank-dayparting-study.md) ·
[bud](2026-08-11-bud-budget-study.md) ·
[neg](2026-08-11-neg-negative-targeting-study.md) ·
[hv](2026-08-11-hv-keyword-harvest-study.md) ·
[bid](2026-08-11-bid-study.md) ·
[ar](2026-08-11-ar-apply-rules-study.md).

---

## 0 · The one-paragraph version

The autonomy model on this page is the best-designed thing in the section and I would not rebuild
it. But **every one of its three enforcement mechanisms is currently inert**: the daily cap is not
enforced for any rule (a three-valued-logic bug disabled it on 2026-08-04 and a passing test pins
the broken filter); the scope columns are bound on 8 rules, **all 8 of which are switched off**, so
**no live rule carries any scope at all**; and the conflict detector flags 0 of 22 live rules while
**every campaign in the account has at least twelve actors able to change its bids**. The ceiling —
the one mechanism that *is* working — governs rules, and the engine that performs the exact action
class the ceiling forbids is on AUTO because it is not a rule. The page does not need a new model.
It needs its own model applied to everything that acts.

### 0.1 · Three corrections to the tab study

| the tab study said | measured today | why it matters |
|---|---|---|
| *"693,704 `DAILY_CAP_EXCEEDED` rows… **It is not fixed**; that is the current sixty-day count."* | **Fixed on 2026-08-04.** Newest refusal row 2026-08-03; **0 in the last 7 days**. The 693,704 is a 60-day window still containing the pre-fix period. | The refusal question in §5 is a completely different question from the one I asked. |
| *"rules made 95 of 42,885 writes — 0.2%"* | **1,311 of 44,435 — 2.95%.** 95 rows carry an `executionId`; a further **1,216 carry `automation:<ruleId>` in `userId`**, and **zero rows carry both**. | Two mutually exclusive attribution paths. A ledger built on either one alone is wrong. |
| *"The cap is the real policy… it is the only thing between −20%-per-tick and instant collapse"* (bud §5, carried here) | **The cap is not enforced at all.** Every enabled rule, yesterday: the service's counter saw **0**; the rules really ran **94–5,846** times. | There is no brake on the budget ratchet. §5. |

---

## 1 · What exists — every wire

```
/marketing/ads/rules-automation/automations              ← already routed
└── automations/page.tsx → AutomationsClient.tsx         (26 KB)
    ├── ModeNotches.tsx    OFF · OBSERVE · PROPOSE · AUTO, ceiling-aware, disabled-with-reason
    ├── ScopeForm.tsx      market × (account|portfolio|campaign) × (all|line|variation), ANDed
    ├── RuleDetail.tsx     drawer: When/If/Then · readiness · ceiling · scope · caps · record
    ├── ruleText.ts        plain-English rendering + detectConflicts()   (+ ruleText.vitest.test.ts)
    └── borrowed: AdsPageHeader · RulesTabs · AdsDataGrid · HistoryDrawer (from tabs/RuleListTab)
```

### 1.1 The three reads

| route | file:line | what it carries |
|---|---|---|
| `GET /advertising/autonomy/rules` | `advertising.routes.ts:6443` | 51 rules: level · ceiling + reason + blockedBy · `writes` · raw `actions` + `conditions` · resolved scope names incl. product line/variation counts · caps · **7-day acted/proposed/failed/capped** · lifetime counters · `protectedTerms` |
| `GET /advertising/autonomy/graduation` | `advertising.routes.ts:10807` | the readiness board — `ready[]` / `others[]` / `totals`, `weeksRequired` |
| `GET /advertising/scope-options` | `advertising.routes.ts:6788` | 220 campaigns · portfolios · **13 product lines with children, ASINs and campaign ids** · `campaignsWithoutPortfolio` · `unnamedAdRows` |

### 1.2 The two writes

| route | file:line | semantics |
|---|---|---|
| `PATCH /advertising/autonomy/rules/:id` | `:6872` | `{level}` → re-checks the ceiling server-side, **409 `above_ceiling`** with the policy's own sentence; writes `autonomyLevel` + keeps `enabled`/`dryRun` in step; writes an `AdvertisingActionLog` row (`set_rule_autonomy`) that **must never fail the write it describes** |
| `PATCH /advertising/autonomy/rules/:id/scope` | `:6694` | all four grains, one route. Absent key = leave alone, explicit `null` = clear. Portfolio ⇄ campaign mutually exclusive. **409 `scope_matches_nothing`** when the combination resolves to zero campaigns |

### 1.3 The three services

| file | role |
|---|---|
| `services/advertising/ads-autonomy.ts` | `resolveAutonomy` (the one level contract) · `levelActs` · `levelProposes` · `nextLevel`/`prevLevel` |
| `services/advertising/ads-graduation.ts` | `graduationCeiling({actionTypes, hasKeywordProtections})` — **reversible → AUTO, structural → PROPOSE**, unclassified → default-deny PROPOSE |
| `services/advertising/ads-graduation-readiness.service.ts` | `decideVerdict` (a pure function, branch order is the substance) + `getGraduationBoard` |

Plus two the page does **not** call and should: `ads-control-room.service.ts` (`getEngineLevers` — §3)
and `automation-rule-scope.ts` (`ruleMatchesScope` — the enforcement the ScopeForm previews).

---

## 2 · How it works

### 2.1 Level resolution — one order, three writers

```ts
// ads-autonomy.ts:53
resolveAutonomy(rule) {
  if (!rule.enabled) return 'OFF'                                        // enabled still gates
  if (isAutonomyLevel(rule.autonomyLevel) && rule.autonomyLevel !== 'OFF')
      return rule.autonomyLevel                                          // the dial wins
  return rule.dryRun ? 'PROPOSE' : 'AUTO'                                // legacy fallback
}
```

`dryRun` is reachable only when `autonomyLevel` is null or `'OFF'`, and **all 51 rules carry an
explicit level** — so `dryRun` is dead for every row (the standing note holds). But it is still
*written*: the PATCH sets `enabled: level !== 'OFF'` and `dryRun: level !== 'AUTO'` to keep three
columns describing one fact. Three columns, one fact, one writer — acceptable; two writers would
not be, and the ads-console dry-run toggle is the second writer that must be retired.

**Then the account dial caps it.** `automation-rule.service.ts:601` — account `SUGGEST` demotes an
AUTO rule to PROPOSE *rather than silencing it*, and an OBSERVE rule stays OBSERVE. So the effective
level is `min(ruleLevel, accountDial)` with one asymmetry, and **the page never shows the account
dial at all**. Today `autonomy=AUTO · halted=false · envKill=false`, so the two agree; the day they
do not, this page will state a level the account is overriding.

### 2.2 The ceiling — the best primitive here, with one hole

`graduationCeiling` judges a rule by its **most dangerous action** and returns `AUTO` only when
every acting action is on `REVERSIBLE_ACTIONS`. The reasoning in the header is the strongest thing
in the section: *"A bid is a number that moves and moves back. A campaign, keyword or negative is a
thing that now exists and must be reaped by someone. Creation is where automation stops being
reversible."*

Measured: **AUTO ceiling 37 · PROPOSE ceiling 14.**

The negation family gets a *precondition* rather than a hard ceiling — `onlyNegations &&
!hasKeywordProtections` produces a different sentence naming the whitelist as the fix. That
distinction is correct and rare.

🔴 **The hole: `retail_guard` is on `REVERSIBLE_ACTIONS` and its handler pauses campaigns.**

```
automation-action-handlers.ts:946   "Pauses campaigns advertising out-of-stock products or
                                     products that lost the Buy Box… resume_campaign undoes it"
ads-graduation.ts:57 STRUCTURAL      pause_campaign, pause_ad_group, pause_all_campaigns
ads-graduation.ts:32 REVERSIBLE      …retail_guard
```

The list's own justification for putting pausing in STRUCTURAL is *"this account's house rule is to
suppress with a 2c bid rather than pause at all — a rule that pauses is doing something the operator
has said not to do."* One rule named **"Retail guard"** sits at **AUTO**, account-wide, and pauses.

**It is defensible and it is mis-encoded.** `retail_guard` is the *only* structural action in the
codebase with a designed retirement path (`resume_campaign`, and a paired "FBA in-stock resume"
rule). So the ceiling's real axis is not *reversible vs structural* — it is **"does a retirement
path exist"**, and `retail_guard` is the existence proof. The list is the wrong encoding of the
right idea.

*Measured, so the exposure is stated honestly: Retail guard has 5,042 SUCCESS executions in 60 days,
**0 action-log rows**, and there are **0 `pause_*` rows in the entire advertising action log in 60
days**. It has never paused anything. The hole is real and currently unoccupied.*

### 2.3 Readiness — three clean weeks, and the branch order is the design

`decideVerdict` is extracted as a pure function precisely so the **order** of its branches is
testable, and the header says which two would have been wrong elsewhere: `capped` outranks
everything (the ceiling is about what a rule *does*, not what it has done), and `unseen` outranks
the week thresholds (a rule that never queues a proposal cannot accumulate evidence by running
longer). Both are right.

The bar: **`decisionWeeks ≥ 3` AND `editedApplies === 0` AND not stale (14 days)** — where a
"decision week" is a distinct ISO week in which you applied one of its proposals *without editing
the magnitude*. Applying with an edit is explicitly *"agreement with the intent and disagreement
with the number — and the number is what would run unattended."*

`canGraduate` is a separate boolean from `verdict`, with the comment *"The UI must never infer
readiness from the verdict string."* The client honours it (`AutomationsClient.tsx:177`,
`ModeNotches` `earnedAuto`).

🔴 **The board only ever looks at rules at PROPOSE** (`ads-graduation-readiness.service.ts:247`,
`.filter(x => resolveAutonomy(x.r) === 'PROPOSE')`). This is the root cause of §7.

### 2.4 Scope — ANDed, enforced, previewed, and unused

`ruleMatchesScope` (`automation-rule-scope.ts:58`) ANDs four dimensions and is strict: a
campaign/portfolio/product-scoped rule does **not** fire on contexts with no campaign identity.
`ScopeForm` computes reach **client-side from `/scope-options`, using the same intersection the
server performs**, so the preview cannot disagree with enforcement — and the server recomputes and
refuses (409) on write anyway. That is the correct division and it is rare.

Measured: **8 of 51 rules bound — all 8 by marketplace only, 0 by portfolio, 0 by campaign, 0 by
product.** And:

> 🔴 **All 22 live rules are unscoped. Every bound rule is switched off.**
> Scope has never once constrained a rule that could act.

*(This sharpens the tab study, which said 8 of 51 without noticing which 8.)*

### 2.5 The cadence nothing states

`NEXUS_ADVERTISING_RULE_SCHEDULE ?? '*/15 * * * *'` — **96 evaluator ticks a day**
(`advertising-rule-evaluator.job.ts:1337`), against evidence windows of 7 days
(`BUDGET_RULE_WINDOW_DAYS`, `:524`), 14 and 30. **Nothing on the rule row shows either number.**

---

## 3 · 🔴 Should the engines get rows on this page?

**Yes — as first-class actors, read-only in Tier 0, dial-capable in Tier 2. And it is far cheaper
than it looks, because the model already exists and is already served.**

### 3.1 The argument

**(a) They are 97% of what happens.** Measured, 60 days, collapsed to the actor an operator would
recognise:

| actor | writes | fields |
|---|---|---|
| `automation:rank-defend` | **29,749** | bids + placements |
| `(unattributed — null userId)` | **9,598** | placements (9,200) + negatives |
| `user:anonymous` | 2,388 | product ads, negatives, keywords |
| `automation:budget-manager-cron` *(= `ad-budget-enforce`)* | 1,165 | budgets |
| two `automation:<ruleId>` rules | 1,216 | budgets |
| `automation:auto-harvest` | 151 | keywords + negatives |
| `user:operator-acr3-consolidation` · `htest` · `dl-requeue` · 3 more | 176 | mixed |
| **total** | **44,435** | 58 distinct actor strings |

**(b) The ceiling has a hole shaped exactly like an engine.** `ads-graduation.ts` refuses to let
*any rule* creating a keyword or a negative reach AUTO — with a reason it states twice. The
`auto-harvest` engine is on **AUTO** and created **151 keywords and negatives** in 60 days. The
policy is not wrong; it is **rule-shaped**, and the thing it exists to prevent is being done by
something outside its scope. That is the single strongest argument in this document.

**(c) It costs almost nothing.** `getEngineLevers()` (`ads-control-room.service.ts:174`) **already**
maps 12 engines onto the *same four words*, with a reason, a governed set, a cron, a last run, a
7-day failure rate, a warning, and a `haltBehaviour`. It is already served at
`GET /advertising/control-room/levers`, and `ads-control-room-detail.service.ts:51` **already** maps
engine key → the actor strings that identify its rows in the ledger. Live today:

| engine | mode | halt | runs 7d | fail | governs |
|---|---|---|---|---|---|
| Rank & Dayparting | AUTO | gated | 669 | 11 | 33 schedules |
| Classic dayparting | AUTO | gated | 672 | 0 | — *(evaluates almost nothing)* |
| Budget enforcement | AUTO | gated | 335 | 0 | 4 plans this month |
| Bid optimiser | AUTO | **honours** | 28 | 0 | — |
| Harvest & negate | AUTO | **honours** | 8 | 0 | — |
| Anomaly breaker | AUTO | exempt | 1,005 | 1 | — |
| Write delivery | AUTO | gated | 10,047 | 17 | 82 of 220 allowlisted |
| Coverage engine | OBSERVE | gated | 6 | 0 | 0 sets |
| Account reconcile | OBSERVE | exempt | 27 | 0 | — |
| Budget pools · Top-of-Search defense · Analyst fleet | OFF | | 668 / 0 / 5 | 0 | 0 pools · never armed · dark |

`haltBehaviour` is a distinction I have not seen anywhere in the research and it should be kept:
**`honours`** (stands down when the account halts) vs **`gated`** (keeps evaluating; its writes are
refused at the gate) vs **`exempt`**. Only 2 of 12 engines honour the halt. An operator debugging a
quiet account needs to know which of those they are looking at, and *"still evaluating while
stopped — its writes are refused at the gate"* is exactly the sentence.

**(d) The registry is not enough on its own.** My actor census found writers the registry does not
declare: **9,598 unattributed writes**, `user:anonymous` (2,388), `user:operator-acr3-consolidation`,
`dl-requeue`, `htest`. So:

> **Contract: the actor list is the union of the DECLARED registry and the OBSERVED ledger, and an
> actor that wrote without being declared is itself a finding, rendered as one.**

A hand-maintained list would have hidden a fifth of the account's writes behind a `null`.

### 3.2 What read-only looks like — precisely

An engine row today can carry, with **no new backend**: name · one-line "what" · mode · mode reason ·
governed set · schedule · last run + status · runs/failures 7d · warning · halt behaviour · and,
joined through the actor map, **writes in the window, by field, with the campaigns touched**.

What it **cannot** carry read-only, and why: an engine's mode is *derived* (`envEnabled('NEXUS_ENABLE_RANK_DEFEND')`,
`NEXUS_COVERAGE_ENGINE_MODE`, `pools > 0`), not stored. So the dial is not "read-only first" as a
matter of caution — **it is read-only as a matter of architecture**, and making it writable is a
schema change, not a UI change. Say so on the row: *"Mode comes from `NEXUS_ENABLE_RANK_DEFEND`.
Changing it needs a deploy."* An unexplained disabled control is what teaches an operator to
distrust a surface — the same principle `ModeNotches` already applies to a ceiling-blocked notch.

### 3.3 The design — what an engine row needs to become a peer

| property | rules have | engines need |
|---|---|---|
| **mode** | `autonomyLevel` column | a stored `AdsEngineControl.mode` per engine key, with the env flag as the *floor* — env off ⇒ OFF regardless. Never let the UI claim a mode the env contradicts. |
| **ceiling** | `graduationCeiling(actionTypes)` | the same function, over the engine's **declared** action types. `auto-harvest` → PROPOSE. `rank-defend` → AUTO. **This is the point of the exercise.** |
| **scope** | 4 columns + `ruleMatchesScope` | already declared in domain objects: rank-defend = enabled `AdSchedule` rows; budget-enforce = `AdBudgetPlan` markets; coverage = enabled `KeywordCoverageSet`. Render them; do not re-model them. |
| **cap** | `maxExecutionsPerDay` (broken, §5) | none exists. Engines are bounded only by `AdsAutomationState.maxActionsPerHour` (250 default) and the write gate. State that as the engine's cap rather than inventing a second one. |
| **audit** | `executionId` on the log row | the actor map, already written. |

**Recommendation.** One list called **Actors**, with a `kind` column (`rule` / `engine`) and one
filter. Not two sections — the whole failure this section keeps reproducing is two vocabularies for
one idea, and `getEngineLevers`' own header says it: *"an operator could look at 'AI Control' and not
see the four biggest bid movers in the account… Two endpoints would have rebuilt the same seam in a
new place."*

---

## 4 · 🔴 The rebuilt conflict detector

### 4.1 Why the current one cannot work

```ts
// ruleText.ts:276
if (a.trigger !== b.trigger || !sameScope(a, b)) continue
```

Three structural faults, all measured:

1. **Same-trigger only.** The budget ratchet pair differ (`CAMPAIGN_PERFORMANCE_BUDGET` vs
   `CAC_SPIKE`) and are therefore **never compared**. Rules collide over an **entity**, not a trigger.
2. **`sameScope` is a no-op.** It compares `marketplace` and treats null as "everywhere" — correct
   logic, but **43 of 51 rules have a null marketplace**, so it never excludes anything and never
   *includes* the other three grains. It is scope-blind in the only dimensions that shipped.
3. **`OPPOSED` is the only class.** Eight opposite pairs. **Two rules doing the same thing to the
   same entity is the more common failure and is not modelled.** Six live `bid_to_target_acos` rules
   produce nothing.

Plus: it cannot see an engine, because it takes a list of rules.

### 4.2 The replacement — built, run, and proven

Prototype: `apps/api/scripts/_auto-page-conflicts.mts`. Four stages.

**① Reach.** Every actor resolves to a **set of campaigns**. Rules from the four scope columns
(reuse `ads-scope-reach.ts` — it already exists and already returns `contradiction`). Engines from
their declared governed set, **and** from what they demonstrably wrote (`AdvertisingActionLog`, with
`AD_TARGET` rows joined back through `AdGroup` to their campaign). Declared vs observed disagreeing
is itself worth showing.

**② Field.** Every action type resolves to the **field it writes** and the **direction it pushes**:
`bid · budget · placement · negative · keyword · state`, each `up | down | either | create | destroy`.
Two actors collide over a **(campaign × field)** — which is what an entity actually experiences.

⚠️ **The direction must come from the action type, not from the stored number.** `bid_down` stores a
*positive* percent and the handler negates it (`-Math.abs(percent)`, `automation-action-handlers.ts:143`).
My first run inherited that and reported a rule compounding to **×4,909,093,465** in a day. The same
bug renders "+25%" on a rule that cuts a quarter (bid §2). *Recorded because the wrong version was
arithmetically confident.*

**③ Classes.**

| class | definition | live count |
|---|---|---|
| **SAME-FIELD** | both write field F; reaches intersect | 165 pair-flags |
| **OPPOSED** | as above, in opposite directions | 5 pair-flags |
| **DUPLICATE** | identical `trigger+actions+conditions`, **or** identical name ignoring an emoji prefix — **at any level**, because a dormant duplicate is invisible until someone arms it | 3 bodies · 4 name-pairs |
| **CADENCE** | a compounding percent, read on a window ≥7 days, evaluated 96×/day, with no cooldown | **8 rules** |

**④ 🔴 Report per ENTITY, not per pair.** This is the whole design decision. 165 pairwise warnings
is a wall. The same data as one sentence per campaign:

```
bid        220 campaigns reachable · 220 with MORE THAN ONE actor
           actors per campaign: 12→160 · 13→25 · 14→34 · 15→1
budget     220 reachable · 220 contested        4→138 · 5→42 · 6→40
negative   220 reachable · 220 contested        5→153 · 6→26 · 7→40 · 8→1
keyword    220 reachable · 220 contested        2→157 · 3→62 · 4→1
placement   60 reachable ·  45 contested        1→15 · 2→16 · 3→29
state      220 reachable ·   0 contested        1→220
```

> **Every campaign in this account has at least twelve actors able to change its bids, at least four
> able to change its budget, and at least five able to negate a term in it. The shipped detector
> reports zero conflicts.**

The worst single row, `GALE | IT | Broad | Category` — 15 actors on bids: five rules on AUTO, seven
on PROPOSE, plus `rank-defend`, `user:anonymous` and an operator script.

### 4.3 The proof

| the thing it existed to prevent | shipped detector | rebuilt |
|---|---|---|
| **budget ratchet pair** (bud §3) — `Trim budget on weak ACOS` × `Campaign ACOS rebalance` | 🔴 never compared | ✅ SAME-FIELD, both write `budget` on **220 shared campaigns** |
| **six `bid_to_target_acos` rules** (bid §2) | 🔴 0 flags | ✅ **all six flagged** — 15 flags each, 22 for the digest rule |
| **duplicate `Trim budget on weak ACOS`** (one AUTO, one OFF) | 🔴 filtered out as OFF | ✅ DUPLICATE, level shown on both |
| **the engines** | 🔴 structurally invisible | ✅ `Trim budget on weak ACOS ⇄ budget-manager-cron` (78 shared) · `New-to-brand optimizer ⇄ rank-defend` (45 shared) |

The CADENCE class, which nothing anywhere currently computes, from the rule row alone:

| rule | step | window | ticks/day | cap | at its cap, one day |
|---|---|---|---|---|---|
| **Trim budget on weak ACOS** (AUTO) | −15% | 7d | 96 | 10 | **×0.197** |
| **Campaign ACOS rebalance** (AUTO) | −20% | 7d | 96 | 5 | ×0.328 |
| Scale budget-capped winners | +20% | 7d | 96 | 10 | ×6.19 |
| Reduce bids on ACOS spike (AUTO) | −20% | 7d | 96 | 30 | ×0.001 |
| Low CTR bid reduction | −25% | 14d | 96 | 100 | ×0.000 |
| …3 more | | | | | |

That table is the bud §3 audit trail predicted **from configuration**, before it happens — and it is
exactly the shape of Pacvue's own example rule, *"if ACoS exceeds 25% **for three days**, reduce bid
by 10%"*: a **sustained** condition. Ours reads a 7-day window 96 times a day.

### 4.4 The output contract

```ts
// what the detector returns — two views of one computation
interface ConflictReport {
  byEntity: Array<{                 // the primary view
    campaignId: string; campaignName: string
    fields: Array<{ field: Field; actors: ActorRef[]; opposed: boolean }>
  }>
  byActor: Map<string, Array<{      // what a rule/engine drawer shows
    cls: 'SAME-FIELD' | 'OPPOSED' | 'DUPLICATE' | 'CADENCE'
    with: ActorRef | null; field: Field; sharedCampaigns: number; sentence: string
  }>>
}
```

**Where it runs: the server, not the client.** Today `detectConflicts` runs in the browser over the
rules payload, which is why it can never see an engine or a campaign. Reach resolution needs
`Campaign`, `AdGroup`, `AdTarget` and the action log. Move it behind
`GET /advertising/autonomy/conflicts`, and let the client render.

**Do not flag OFF actors as live conflicts** — the current instinct is right — but **do** surface
them under `DUPLICATE` and in a *"would conflict if armed"* line on the mode dial, so the ceiling
refusal and the conflict warning arrive at the same moment.

---

## 5 · 🔴 The refusals — the question changed completely

### 5.1 What I actually found

The tab study asked whether to suppress, aggregate or raise the caps. All three assume the cap
works. It does not.

```ts
// automation-rule.service.ts:568 — the cap counter
const todayCount = await prisma.automationRuleExecution.count({
  where: { ruleId, startedAt: { gte: dayStart },
           NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } },   // ← three-valued logic
})
if (todayCount >= rule.maxExecutionsPerDay) { /* refuse */ }
```

`NOT (errorMessage = 'X')` evaluates to **NULL — not TRUE** — for the null `errorMessage` that every
`SUCCESS` and `DRY_RUN` row carries. Those rows are dropped. `todayCount` counts only rows with a
non-null `errorMessage` that is not the cap string — i.e. almost nothing.

**Measured on prod, 2026-08-10, a complete UTC day, both filter forms side by side:**

| rule | cap | the service's counter saw | actually ran | tripped? |
|---|---|---|---|---|
| New-to-brand optimizer | 10 | **0** | **5,585** | 🔴 no |
| Low CTR bid reduction | 100 | **0** | 5,846 | 🔴 no |
| Wasted keyword instant negate | 200 | **0** | 3,197 | 🔴 no |
| Account-wide negative sync | 20 | **0** | 1,728 | 🔴 no |
| **Target ACOS setter (from profit)** | **1** | **0** | **765** | 🔴 no |
| **Weekend budget boost** (AUTO) | **1** | **0** | **765** | 🔴 no |
| **Trim budget on weak ACOS** (AUTO) | 10 | **0** | 288 *(08-09)* | 🔴 no |
| **Campaign ACOS rebalance** (AUTO) | 5 | **0** | 94 | 🔴 no |
| …**every** enabled rule, 19 of 19 | | **0** | 94–5,846 | 🔴 no |

**32 rules exceeded their stated cap on at least one of the last 8 full days.** A rule with a cap of
**1/day ran 765 times.**

### 5.2 How it got here, and why the tests pass

`ADX.1` (2026-08-04) fixed a genuine, severe bug: the cap counted its own refusal rows, so each
rejection raised the number the next tick compared against — *"one cap-2 rule had 2 legitimate runs
and 790 self-inflicted rejections in a single day."* Two changes shipped: refusals no longer write a
row, and the count excludes cap rows. **The second change is where the null branch was lost.**

`automation-rule-cap.vitest.test.ts:101` pins it:

```ts
expect(where?.NOT).toEqual({ errorMessage: 'DAILY_CAP_EXCEEDED' })
```

The test **mocks `prisma.automationRuleExecution.count`** and asserts the *shape of the where
clause*. No query runs, so nothing can observe that the clause returns nothing. **The test passes and
pins the defect.** This is the same trap the codebase documents correctly in three other places —
`advertising.routes.ts:6478`, `ads-graduation-readiness.service.ts:270`, and the doc for this
programme — and it caught *me* mid-study: my first `_auto-page-caps.mts` run reported "0 executions
in 8 days", which read exactly like a dead evaluator.

### 5.3 What this means for the page, today

- The **`capped` chip** on the grid and the *"Its daily cap declined to run it N times this week"*
  paragraph in `RuleDetail` both read from `errorMessage='DAILY_CAP_EXCEEDED'` over 7 days. Measured:
  **7 days → 0 rows. 14 days → 115,756. 60 days → 693,704.** As of today the column renders **0 for
  every rule, permanently** — a well-built surface over a signal that no longer exists.
- A refusal is now published only to `publishAdsExecution` — an **in-process ring buffer, 50 events,
  5-minute TTL** (`ads-execution-events.service.ts`). There is no durable record of a refusal
  anywhere. When the counter is repaired, refusals will be invisible rather than noisy.
- bud §5's *"the cap is the real policy"* and *"it fails open into 10 cuts a day"* were true under
  the old code. **It now fails open into unlimited cuts a day**, and the ratchet's only stated brake
  does not exist.

### 5.4 The answer to "suppress, aggregate, or raise?"

**None of those. In order:**

1. **Repair the counter** — `OR: [{errorMessage: null}, {errorMessage: {not: 'DAILY_CAP_EXCEEDED'}}]`
   — and **replace the mocked test with one that runs the predicate against real rows.** A shape
   assertion cannot catch a semantics bug; that is the whole lesson.
2. **Expect a shock.** With a working cap, a rule at 1/day that has been running 765 times will drop
   to 1. Several caps are wrong *for the shape of rule they sit on* (a rule matching once per
   campaign per tick needs a cap in the hundreds; a digest needs 1). Re-size them **before** turning
   the counter back on, and show the last-8-days table above next to each cap while doing it.
3. **Give the refusal a durable home** — a counter on the rule, or a `refusals` row, not an
   execution row. §4's cadence class then has a live companion: *"this rule wanted to act 5,585
   times and was allowed 10."*
4. **Purge or date-bound the 693,704.** They exit the 60-day window on **2026-10-02** on their own.
   Every consumer currently special-cases them by `errorMessage`; the honest filter is by **date**,
   and the special-casing can be deleted once they are gone.
5. **The cap is not a scope.** The deeper point: `maxExecutionsPerDay` has been doing scope's job —
   bounding blast radius by *how often* instead of *over what*. §6 is the real fix; the cap is the
   backstop.

---

## 6 · Scope, actually used

**8 of 51 bound, all by marketplace, and all 8 are switched off. Every live rule is account-wide.**
One rule additionally names 99 campaigns **inside its action body** (plc §2, *"Rank control — Top
+100% · 99 campaign(s) (IT)"*) — scope by hand, unscopable, undeletable in part, and
`ruleText.ts:194` already refuses it at the action level with a named problem.

Binding is the cheapest risk reduction available: a rule that can only touch the GALE line cannot
ratchet the account. Everything needed is built — the four grains, the AND semantics, the
enforcement, the reach preview, the contradiction refusal. **Nothing uses it because nothing asks.**

### 6.1 The flow, designed

**① A default at creation.** The builder must not be able to produce an unscoped rule silently. The
scope step defaults to the **market currently selected in the header** and states the reach: *"This
rule will be able to act on 118 of 220 campaigns."* An operator who wants account-wide chooses it
explicitly. *(Nothing retroactive — this is a create-path default.)*

**② Unscoped as a first-class state, not an absence.** The grid's Scope cell renders "Whole account"
in the same weight as a bound scope. It should read **"Whole account — 220 campaigns"** with the
warning styling reserved for the combination that actually matters: **unscoped × AUTO × writes**.
Measured: **5 rules** are in that state (`Trim budget on weak ACOS`, `Campaign ACOS rebalance`,
`Reduce bids on ACOS spike`, `Profit-native bid optimisation`, `Target ACOS setter`, plus `Weekend
budget boost` and `ACoS convergence` — 7 counting bid-writers). That is the census band the page is
missing.

**③ Bulk bind.** `AdsDataGrid` already has selection and a `selectionActions` row. Add **Set scope**
beside **Set mode**, opening the existing `ScopeForm` once for N rules, with the same
partial-success preview the mode bulk already builds (`bulkPreview`, `AutomationsClient.tsx:288`) —
because a scope can be refused per rule (409 `scope_matches_nothing`) exactly as a level can be
refused by a ceiling. **The refusal preview is the pattern to copy, not re-invent.**

**④ Suggest the binding.** The data to propose one already exists: for each rule, the campaigns it
has actually touched (action log) and the product lines those campaigns advertise (`/scope-options`).
*"This rule has only ever acted on 6 campaigns, all in the GALE line. Bind it there?"* That converts
scope from a form into a decision.

**⑤ Scope is not a substitute for scope-of-action.** `RuleDetail` already states the limitation and
it must survive any redesign: *product scope decides which **campaigns** a rule may act on; it does
not narrow the action to that product's targets.* A bid change still moves every target in a
matching campaign.

### 6.2 The order matters

Bind before arming. Today an operator raising a rule to AUTO is arming it across 220 campaigns and
the page does not say so. **The ceiling asks "is this action reversible"; nothing asks "over how much
of the account".** Those are the two halves of blast radius and only one is implemented.

---

## 7 · OBSERVE — never used, and structurally unusable

**OBSERVE = 0, and it always will be, because the ladder's second rung is a dead end by
construction.**

Three code facts, in the order that makes it inevitable:

1. `levelProposes('OBSERVE') === false` — deliberate and correct: *"the mode for a rule you want
   running and measured but do not yet want to hear from."*
2. **The graduation board only reads rules at PROPOSE** —
   `ads-graduation-readiness.service.ts:247`. An OBSERVE rule appears on no board and accrues no
   verdict.
3. The strict bar is **`decisionWeeks`** — distinct weeks in which you *applied a proposal
   unchanged*. An OBSERVE rule produces no proposals, so `decisionWeeks` can never rise.

> **Moving a rule from PROPOSE to OBSERVE takes it *off* the ladder rather than one rung up it.**
> The mode built to accumulate trust is the only mode in which trust cannot be accumulated.

And its evidence goes nowhere: an OBSERVE rule records "what it would have done" in an
`AutomationRuleExecution` row that **no surface reads**. The would-do is written and discarded.

### 7.1 Should the page suggest it?

**Not until OBSERVE has an output.** Suggesting a move to a mode that silently removes a rule from
the board would be the page arguing against its own ladder.

**Fix it in the right order:**

1. **Give OBSERVE a surface.** An "would have done" count on the row, and the would-do list in the
   drawer. `previewHarvest`-style dry-run output already exists for several handlers (hv §7 —
   *"a preview that is genuinely read-only"*); OBSERVE is where it belongs.
2. **Let OBSERVE count toward `cleanWeeks`** (it already can — `cleanWeeks` reads executions, not
   suggestions) and extend the board to include OBSERVE rules under a verdict of their own —
   *"observed N weeks, never asked you anything"*, which is the `unseen` verdict's sibling.
3. **Then** suggest it, and only in the direction that makes sense: **OFF → OBSERVE**, for the
   **29 rules that are off**. That is a rung nobody can currently step onto, and it costs nothing —
   an OBSERVE rule cannot write.

Suggesting **PROPOSE → OBSERVE** is a downgrade dressed as progress. Do not.

### 7.2 Is the ladder wanted?

The evidence says the *ladder* is fine and the *rungs* are unequal. OFF→PROPOSE is one click and 13
rules made it. PROPOSE→AUTO requires three weeks of applied proposals and **one proposal has ever
been applied, in June, by a test row**. The middle rung is unreachable and the top rung is
gated behind a queue nobody works — which is §8.

---

## 8 · The queue

**225 pending · 1 applied ever · 0 dismissed.** Measured today, and it is not the compost heap I
called it:

| | |
|---|---|
| created | **2 on 2026-06-20, then nothing until 2026-08-03**; 121 on 08-05, then 5–22/day |
| pending age | min 0 · **median 5 days** · max 51 |
| age buckets | 0–1d **40** · 2–7d **184** · 8–30d **0** · 31+d **1** |
| the one applied | `__ea manual 1781972184957`, 2026-06-23 — **a manual test row, not a real decision** |

🔴 **225 rows are 8 distinct decisions.** `distinct(proposedKey × entityType) = 8`. By kind:
`bid_down 120 · lower_bid_to_floor 65 · harvest_and_negate 18 · adjust_ad_budget 11 ·
promote_to_exact 5 · add_negative_exact 5 · budget_apply 1`. By entity: `AD_TARGET 174 · CAMPAIGN 23
· MARKETPLACE 18 · SEARCH_TERM 10`.

And the unique key `(ruleId, entityId, proposedKey)` means a repeat proposal for the same entity
**cannot create a second row**. So:

> **The queue is a standing wave, not a pile.** ~20 new rows a day, one row per (rule × entity ×
> change kind). "Clear the queue" is not a one-time job — it is a daily rate. Any design that
> assumes a backlog to be drained is designing for the wrong object.

*(Also visible here: seven rules appear twice, once with an emoji prefix and once without —
`📉 Low CTR bid reduction` 51 pending and `Low CTR bid reduction` 43 pending. The same duplication
the conflict detector's name class catches in §4.3.)*

### 8.1 Recommendation

**Make it decidable in one screen, and price the decision.**

1. **Group by (kind × field), not by row.** *"120 bid reductions across 174 targets, totalling −€X/day
   of bid exposure — Apply all · Apply the 30 above €0.40 · Dismiss."* Eight groups fit on one screen;
   225 rows do not.
2. **Show the evidence beside the proposal.** neg §6.4 and hv §7 both independently asked for the
   same thing: the term's full history before you approve. An approval without the numbers that
   caused it is a coin flip, and this account has flipped it once in two months.
3. **Expire.** A proposal computed on a 7-day window is stale after a few days; the median is already
   5. Expire at 7 days with a stated reason, so age is a policy rather than a backlog metric.
4. **Record the edit.** `appliedResult.override` is already the strict bar's discriminator
   (`ads-graduation-readiness.service.ts:313`). The apply UI must offer "apply as proposed" and
   "apply with a change" as **visibly different acts**, because the graduation model treats them
   completely differently and today nothing tells the operator that.
5. **Coordinate with sessions 7 and 8.** neg and hv fill this queue —
   `Wasted keyword instant negate` (44+10), `Auto harvest & negate` (9),
   `Auto match-type migration` (8+2). **Their Tier 0 asks and this one are the same feature:** a
   candidates table with approve/reject per row and in bulk. Build it **once, here**, and let the
   negation and harvest pages filter it — do not build three approval inboxes.

**Do not stop generating.** Proposals are the only evidence source the graduation model accepts;
turning them off closes the only path to AUTO.

---

## 9 · Industry research — features *and* interfaces

Extending `2026-08-04-ads-market-research.md` and `2026-08-04-competitor-deep-dives.md`, on
governance specifically.

### 9.1 The platforms

| platform | governance model | what the screen looks like | price / who for | steal | avoid |
|---|---|---|---|---|---|
| **Pacvue Agent** *(14 Apr 2026)* | *"approval-based execution with clear guardrails"*; **"Your team defines the guardrails, reviews every recommendation, and approves changes"**; *"every action includes change logs and full visibility into what changed, why, and what impact it had"*. Stated principle: **"autonomous where it matters, control where it counts."** | Front page is now **"Introducing the Agentic Commerce Grid"** — the campaign grid *is* the surface where agents propose and operators approve. Recommendations → approval → execution in one workflow. Amazon Ads only at launch. | ~$500/mo min or 3–4% of spend; $50k+/mo advertisers | **The change log as a product surface with *impact* on it**, not just before/after | The claim density: "200×  faster", "80× quicker to insight". Product docs describe governance conceptually and show **no named governance screen** — the approvals story is thinner than the marketing |
| **CommerceIQ** | **Role-specific agents** (Content · Sales · Shelf · Media). *"Human teams define strategy and set operational guardrails while retaining final decision authority."* | **A transparency layer on every recommendation** — the agent cites the specific signals behind it (a PDP keyword change citing search-traffic signals; a media change surfacing an incrementality drop) | enterprise | 🔴 **Citing the signal on the recommendation.** We have `AdvertisingActionLog.evidence` and it is *already this* — see §9.4 | Agent-per-role is an org chart, not a control model; it multiplies the surfaces an operator must check |
| **Skai** | *"designed around governance and approval workflows plus rule and action logging"*; **Advanced Automated Actions** as a **rule-based decision tree** holding workflow dependencies in one place; separate **Skai Audit** | The decision tree *is* the interface — dependencies visible rather than inferred from a flat list | enterprise, 100+ publishers | **The dependency tree.** Our 51 rules are a flat list and their interactions are invisible — which is §4 restated as a UI problem | A tree is authoring, not governance. It shows what *you* wired, not what *else* can touch the entity |
| **AdLabs** | *"transparent, approval-based bid control — the algorithm does the analysis and you make the final call on every change"*; **one-click undo and full change logs on every adjustment** | Recommendations surfaced, reviewed, approved; change log + undo per bid | **1% of spend + $40/mo** (Core), 2%+$40 (Enterprise) | 🔴 **One-click undo as a shipped, priced feature at the bottom of the market.** Undo is not enterprise-tier; we have 0 rollbacks in 60 days | Bid-only scope |
| **Scale Insights** | 11–12 stackable algorithms, 200+ parameters, unlimited rule-stacking, ASIN-level; the operator owns the logic | Rules you read | ~$78/mo; $2K–$10K spend | Threshold as a **visible dial with a live candidate count** | *"Unlimited rule-stacking"* is exactly our problem at 51 rules — no platform in this research states precedence when stacked rules disagree |
| **Perpetua** | Goal-based: declare target ACoS/ROAS, the engine executes. Bid adjustments can be **permanent or set to expire after a defined period** | Goals, not knobs | ~$250–550/mo + ~3%; $10K–$50K spend | 🔴 **Expiring overrides** — a temporary push that cleans itself up. The missing primitive almost everywhere, and the retirement-path idea our ceiling is built on | Black box: you cannot inspect why a bid moved |
| **Quartile** | ML owns allocation inside a goal; hourly bid adjustments | Grid as monitor, not control | $895–$10k/mo; $50K+ | Hourly as a *deliberate*, priced choice | The documented failure mode our ceiling cites: automation that leaves an account too big to run by hand |
| **Teikametrics** (Flywheel → **ARI**, rebranded CES 2026) | ML bidding since 2015 | — | free <$10K sales, then ~$99/mo + 3% | — | 🔴 **Its published pages document no undo of an applied bid change** — a bad move is corrected forward, not reversed. Same state we are in |
| **Ad Badger** | Rules-based, hourly; account-wide n-gram | Educational, beginner-first | flat, low | Account-wide n-gram as *one* decision across twelve campaigns | Thin above small accounts |

### 9.2 How agents are surfaced and supervised — the 2026 framing

The agentic-governance literature converged this year on a vocabulary that is **exactly ours**:

- **Tiered oversight by risk and reversibility** — *"fully autonomous for low-risk actions,
  human-on-the-loop for medium-risk workflows, and **hard human-in-the-loop gates for high-risk or
  irreversible decisions**."* That is `graduationCeiling` in one sentence, arrived at independently.
- **Supervision, not approval** — the human-on-the-loop reframing: *"transforming governance from a
  bureaucratic bottleneck into a prerequisite for responsible innovation at scale."* Our 225-pending /
  1-applied queue is precisely the bottleneck that reframing exists to escape.
- **Delegated authority as the unit** — *"defining what an agent can access, which tools it can
  invoke, and which actions it can take without human confirmation."* Ours is defined for rules and
  **undefined for engines** (§3).
- Singapore's **Model AI Governance Framework for Agentic AI** (Jan 2026) is the first
  government-level attempt at this, on human oversight, transparency and accountability.

**On rule conflict, the field's four documented strategies** — and none of the eight platforms
publishes which one it uses:

1. **Priority ranking** — safety rules override growth rules.
2. **Sequential execution** — cost-control before growth.
3. **Conservative defaults** — on conflict, take the more conservative action. *"Better to miss
   growth than burn budget."*
4. **Human review** — flag rather than auto-resolve.

> **We have none of the four.** Whichever rule ran last wins, and with the cap disabled (§5) they all
> run. **Recommendation: (4) now — flagging is §4 and it is cheap — and (3) as the tie-break when
> precedence is eventually implemented**, because this account's demonstrated failure mode is a
> ratchet, and a conservative default on a *decrease* means declining the second decrease.

### 9.3 Where we already lead

1. **A ceiling grounded in reversibility.** Pacvue gates on *approval*; we gate on **whether the
   action can be undone at all**. No competitor in two rounds of research has an equivalent, and the
   governance literature independently named it the right axis five months later.
2. **`haltBehaviour` as a stated property** (§3.1). Nothing in the research distinguishes "stood
   down" from "still evaluating, writes refused at the gate".
3. **Plain-English When/If/Then generated from the stored rule body**, with a vitest suite, and a
   deliberate refusal to convert `targetAcos` because two rules store it in different units
   (`ruleText.ts:144`).
4. **A named-verdict readiness board** that distinguishes *ran clean* from *you agreed*, and calls
   `unseen` **"the riskiest row on this board, not the safest."**
5. **The protected-terms whitelist enforced at the single write chokepoint** (neg §6.3).

### 9.4 The five things the field does that we do not

1. **Govern the executors, not just the rules.** §3.
2. **Conflicts by entity.** §4.
3. **Approvals that are worked.** §8.
4. **A change ledger as the primary view, with impact and undo.** 44,435 changes exist, are
   attributed, and are rendered nowhere. AdLabs ships undo at 1% of spend.
5. **🔴 Cite the signal on the change.** CommerceIQ's transparency layer. **We already have the
   field** — `AdvertisingActionLog.evidence` (`schema.prisma:3738`, shape `AdWriteEvidence`:
   `metric, observed, threshold, windowDays, sampleSize, targetKey, note`) — and its own comment says
   why: *"payloadBefore/payloadAfter answer 'what', userId answers 'who'. Neither answers the question
   an operator actually asks when a bid moves, which is 'on what evidence'."* Measured over the last 7
   days, 4,000 rows sampled:

   | action | rows | carrying evidence |
   |---|---|---|
   | `update_placement_bidding` | 1,454 | **1,454 (100%)** ✅ |
   | `AD_BID_UPDATE` | 2,017 | **81 (4%)** |
   | `AD_BUDGET_UPDATE` | 476 | **0** 🔴 |

   Example, from a placement write:
   `{"note":"above Placement — snap to 75% Placement","metric":"placementBidding","observed":150,"threshold":75}`

   **So a ledger can explain every placement change, one bid change in twenty-five, and no budget
   change at all.** The budget path — the one that produced the ratchet — is the one with no *why*.
   That is a three-line fix in one handler and it is the highest-leverage thing on this list.

---

## 10 · How it is supposed to be

> **One question: what can change my account, under what limits, and what did it change today?**

**The page becomes three views over one model, and the model is `Actor`.**

### 10.1 Ledger — the landing view

Not the configuration. **44,435 changes in 60 days**, filterable by actor · field · campaign ·
market · date, with `payloadBefore → payloadAfter`, the `evidence` sentence where it exists (and an
honest *"no reason recorded"* where it does not), and **undo where the write is reversible**. This is
what every mature tool leads with and it is the one thing here that has never been rendered.

The two attribution paths (§0.1) must be **unioned in the query, not chosen between** — 95 rows by
`executionId`, 1,216 by `automation:<ruleId>`, zero overlap. And the **9,598 unattributed writes**
get their own row labelled as such, because a fifth of the account's changes having no author is a
finding, not a blank.

### 10.2 Actors — the configuration view

One list. `kind` = rule | engine. One dial, one ceiling, one scope form, one cap, one audit link.

Census band, counting what matters rather than what is easy — and the emphasis on
**"Writing to Amazon"** (`writes && level==='AUTO'`, not merely AUTO) is already right and should
survive:

```
Actors 63    Off 29    Observing 0    Proposing 13    Writing to Amazon 8 rules + 7 engines
             Unscoped and writing 5          Contested campaigns 220
```

### 10.3 Conflicts — the entity view

"What else can touch this campaign", per field, with the actor list. §4.4.

### 10.4 The URL contract

Every view linkable, because ten sibling pages will link *into* this one:

```
/marketing/ads/rules-automation/automations
  ?view=ledger|actors|conflicts        default: ledger
  &actor=<ruleId|engineKey>            opens the drawer
  &kind=rule|engine
  &level=OFF,OBSERVE,PROPOSE,AUTO      multi
  &field=bid,budget,placement,negative,keyword,state
  &scope=account|market|portfolio|campaign|product
  &campaign=<id>                       the entity view, pinned to one campaign
  &market=<IT|DE|FR|ES>                shared with the section scope bar
  &from=<iso>&to=<iso>                 ledger only
  &q=<search>
```

`?campaign=<id>` is the important one: it is the deep link every other page needs — *"what else can
touch this campaign"* — and it is the same parameter whether it arrives from Placement, Budget or
Apply Rules.

---

## 11 · 🔴 Contracts the other ten pages must honour

*Flagged explicitly for the reconciliation pass. These are governance decisions that constrain the
other ten surfaces; each is a decision this page owns and the others consume.*

**C1 · A level is always the resolved level, and it is always one of four words.**
Every page displaying a rule's mode calls `resolveAutonomy(rule)` and renders `Off · Observe ·
Propose · Auto`. **No page may render `dryRun`, `enabled`, or "LIVE/dry-run" as a mode.** The
ads-console dry-run toggle is a second writer for the same fact and must be retired, not mirrored.

**C2 · A level is never shown without its ceiling.**
Wherever a mode is *editable*, a level above the ceiling renders **disabled and keeps its reason**
(`ModeNotches` is the reference implementation). A control that refuses silently is what teaches an
operator to distrust the surface. Wherever a mode is *read-only*, a capped rule shows the cap.

**C3 · The account dial is a ceiling over every per-actor level.**
Effective level = `min(actorLevel, accountDial)`, with one exception: `SUGGEST` demotes AUTO→PROPOSE
but leaves OBSERVE at OBSERVE. Any page showing AUTO while the account says SUGGEST is wrong in the
most expensive direction.

**C4 · Scope is four ANDed grains and one sentence.**
`market × (account|portfolio|campaign) × (all|line|variation)`. Rendered as
**"Whole account — 220 campaigns"** or **"IT + GALE line — 32 of 220 campaigns"**. A page may not
invent a fifth grain, and `scopeCampaignId` is **single-valued** — so assigning a rule *from* a
campaign page **moves** it rather than adding it (ar §4.2). Until `scope*Ids` arrays land, a
campaign-side Automations column is **read-only**.

**C5 · Reach is always stated in campaigns, out of the account total.**
One denominator, everywhere: `N of 220`. The bug this prevents has already shipped twice in this
programme (`targetAcos` units, then 40-vs-18 in the reach label) — *a guard must share the
denominator of the value it guards.*

**C6 · A conflict is a property of an ENTITY, not of a rule.**
Any page showing a campaign, target or term may show *"12 actors can change this campaign's bids"*,
sourced from `GET /advertising/autonomy/conflicts`. **No page computes conflicts locally.** A rule
badge is a *summary* of its entity conflicts, never an independent computation.

**C7 · A refusal is not a failure, and neither is a proposal.**
Four distinct outcomes, four distinct words, on every health figure in the section:
**acted · proposed · refused (cap/gate/ceiling) · failed.** No page may compute a percentage that
merges them. `DAILY_CAP_EXCEEDED` rows are excluded **by date** once purged, and until then the
null branch is spelled out — `NOT: { errorMessage: X }` is NULL, not TRUE.

**C8 · Engines are actors and are named consistently.**
One display name per engine, from the registry (`Rank & Dayparting`, not `ad-rank-defend`, not
`automation:rank-defend-cmr2693xx…`). Every page attributing a write resolves the actor string
through the same map. Placement, Bid and Rank & Dayparting all describe `ad-rank-defend` today and
none names it the same way.

**C9 · Every write carries its evidence, or says it does not.**
Any surface rendering a change shows the `evidence` sentence where present and an explicit
*"no reason recorded"* where absent. Budget writes currently carry none (§9.4); a page that renders
a blank there is claiming something it has not measured.

**C10 · The section has one approval inbox.**
Negative Targeting, Keyword Harvest and Bid all queue `AdsRuleSuggestion` rows. They filter the one
inbox; they do not build their own. One dedupe key, one expiry policy, one "applied vs applied-with-edit"
distinction — because the graduation model reads that distinction and three implementations will
disagree about it.

---

## 12 · Requirements on the shared layer

*Constraints, not solutions. Ten other sessions own these surfaces.*

**S1 · `AdsDataGrid` — a row must be able to host a live control.**
The Mode dial is four buttons in a cell, each firing a PATCH and a reload. The grid must not
remount rows on sort/filter in a way that drops focus or loses in-flight busy state, and
`stopPropagation` on in-cell controls must keep working (the name button and Details button both
rely on it today).

**S2 · `AdsDataGrid` — selection actions must survive a partial-success flow.**
Bulk mode change is `N` independent PATCHes with three outcomes (ok / 409 refused / failed). The
selection bar and its modal must support a **preview before, and a three-way summary after**. This
is built here already (`bulkPreview`, `doBulk`) and should become the grid's pattern rather than
this page's.

**S3 · Stacking.** The bulk modal is z-index 140, this drawer 161, `H10Select`'s portalled popover
200. The current workaround is that the drawer *yields* when the modal opens. **Any shared modal/drawer
layer must give a drawer-above-modal ordering that does not clip a portalled dropdown**, or this
constraint propagates to every page with a drawer containing a select.

**S4 · Tab bar — the counts must not contradict this page.**
`RulesTabs` computes counts from `RULE_TAB_ACTION_TYPES` over `/advertising/automation-rules`; this
page counts from the **server's 8-family taxonomy** over `/advertising/autonomy/rules`. They already
disagree (the bar reads "Keyword Harvest 5" while the server says harvest 0, and 17 of 51 rules have
no tab home). **One taxonomy, server-side.** Whoever owns `tabs.tsx` and whoever owns
`rule-category.ts` need to converge, and I do not own either.

**S5 · `AdsPageHeader` — the market select must be the section's one market.**
This page filters rows by market with a deliberate non-equality (a null-market rule is kept, because
it acts everywhere — `AutomationsClient.tsx:161`). Whatever the shared scope bar becomes,
**"unscoped means everywhere" must survive**, or narrowing to IT hides 43 of 51 rules and reads as a
data bug.

**S6 · Real-time sync — this page must be able to invalidate on someone else's write.**
Every one of the ten pages can change a rule's level or scope. The section needs one invalidation
signal. `ads-execution-events.service.ts` already has an SSE stream at
`/api/advertising/execution-events`, but it is a **5-minute, 50-event, in-process ring buffer** —
adequate for "a rule fired", **not** a durable sync channel and not multi-instance safe. Whoever owns
the sync layer needs to decide whether that stream is the substrate or whether a new one is; I need
*a* signal, not a specific one.

**S7 · The URL contract in §10.4 needs `?campaign=<id>` reserved section-wide**, since every page
wants to deep-link into "what can touch this campaign".

**S8 · `rules-automation.css` is one stylesheet for nine pages.** This page's classes are `h10-au-*`
(never `h10-am-*`, which is the app-wide Ads Manager grid namespace). Two namespaces in one file is
how source order starts beating specificity, and an undefined class here is **silent** — it shipped
once as the bare words "OffObserveProposeAuto" and tsc, tests, the ratchet and the build all passed.
**Any shared-CSS change must be appended at EOF and claimed in `2026-08-10-ra-session-locks.md` §2.**

---

## 13 · Tiered implementation plan

### Tier 0 — repair what is silently broken *(hours; do these first, in this order)*

| # | change | cost | unlocks |
|---|---|---|---|
| 0.1 | 🔴 **Repair the cap counter** — spell out the null branch (`automation-rule.service.ts:568`) — **and replace the mocked shape-assertion test with one that runs the predicate against rows** | 2 lines + 1 test | The only brake on the budget ratchet. **Re-size the caps first** (§5.4.2) or a cap-1 rule drops from 765 runs to 1 |
| 0.2 | **Add `evidence` to the budget write handler.** 476 budget writes in 7 days, 0 with a reason | ~5 lines | A ledger that can explain the ratchet |
| 0.3 | **Say the cap column is dark.** The `capped` chip reads 0 for every rule and will forever | 1 conditional | Stops a working surface reporting a false zero |
| 0.4 | **Union the two attribution paths** wherever "did a rule do this" is asked | 1 query | 1,216 hidden rule writes, incl. every ratchet cut |
| 0.5 | **Census band: "unscoped · AUTO · writes"** — 5–7 rules | 1 stat card | The account's actual exposure, on the landing view |

### Tier 1 — the ledger and the conflicts *(days)*

| # | change | unlocks |
|---|---|---|
| 1.1 | **`GET /advertising/autonomy/conflicts`** — reach × field × classes, per entity. Prototype exists (`_auto-page-conflicts.mts`) | *"12 actors can change this campaign's bids"*, and C6 for ten pages |
| 1.2 | **The ledger view** — 44,435 rows, actor · field · entity · before → after · evidence · date, filterable, with the unattributed bucket named | The primary view every mature tool leads with |
| 1.3 | **CADENCE on the rule row** — step, window, ticks/day, cap, "at its cap: ×0.197 in a day" | The ratchet predicted from configuration, not from an audit trail |
| 1.4 | **Fix the `bid_down` sign** in `ruleText.ts` params — direction from the action type, not the stored number | A rule that cuts 25% stops reading "+25%" (bid §8), on this page and everywhere C1 applies |
| 1.5 | **Bulk Set scope** + the unscoped-and-writing warning | §6.1 ③ |

### Tier 2 — engines as actors *(a decision, then days)*

| # | change | unlocks |
|---|---|---|
| 2.1 | **Engine rows, read-only** — from `getEngineLevers()` + the actor map, in the same list as rules | §3. The gap the whole section keeps rediscovering |
| 2.2 | **Run `graduationCeiling` over engines' declared actions** and show the verdict | The `auto-harvest` hole, stated: an engine on AUTO doing what no rule may |
| 2.3 | **`AdsEngineControl.mode`** — a stored mode with the env flag as floor | The dial becomes real; until then the row explains why it is not |
| 2.4 | **Reframe the ceiling on "does a retirement path exist"**, with `retail_guard` as the documented exception rather than a silent one | §2.2, and it is the gate on the AUTO negation the operator asked for |
| 2.5 | **Undo on the ledger** where the write is reversible | AdLabs ships this at 1% of spend; we have 0 rollbacks in 60 days |

### Tier 3 — the ladder and the queue *(a decision)*

| # | change | unlocks |
|---|---|---|
| 3.1 | **Give OBSERVE an output** and admit OBSERVE rules to the graduation board | §7. The second rung becomes steppable |
| 3.2 | **One approval inbox**, grouped by (kind × field), priced, expiring at 7 days, with apply-as-proposed vs apply-with-edit as visibly different acts | §8 and C10 — and it is neg's, hv's and bid's Tier 0 as well as this page's |
| 3.3 | **Precedence** — strategy (4) *flag* now, (3) *conservative default* as the tie-break | The field's own answer to six rules on one field; nobody publishes theirs |
| 3.4 | **Suggest a scope from observed behaviour** — *"only ever acted on 6 GALE campaigns; bind it there?"* | Scope becomes a decision rather than a form |

---

## 14 · Open questions

1. 🔴 **The cap.** Repair the counter — yes, obviously. But **before** I do: several caps are wrong
   for the shape of rule they sit on (a per-campaign rule with a cap of 1 is not a cap, it is an off
   switch). Do you want me to bring you the last-8-days table per rule and re-size them together, or
   repair first and let it bite?
2. 🔴 **Engines on this page: read-only rows in Tier 2, or Tier 0?** I have argued Tier 2 because the
   dial needs a schema change. But the *rows* need no backend at all, and the `auto-harvest`
   ceiling hole is live. If you want them sooner, they can be Tier 1.
3. **Ledger as the landing view, or Actors?** I recommend the ledger. It changes what this page *is*
   — from "what is configured" to "what happened" — and it is the biggest single departure from the
   page you have.
4. **`retail_guard` on AUTO, account-wide, able to pause.** It has never paused anything. Keep it as
   the documented exception (my recommendation), or bring it under the structural ceiling?
5. **The 9,598 unattributed writes.** 22% of the account's changes have no author, almost all
   `update_placement_bidding`. Worth tracking down the writer before the ledger ships, or shipped as
   an honest *"unattributed"* row?
6. **OBSERVE.** Fix it (§7.1) or delete it? A four-notch dial with a structurally unusable second
   notch is worse than a three-notch one, and deleting it is cheaper than fixing it.

---

**Nothing here was built. Waiting on your decision.**

---

## Appendix A — scripts

All read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

| script | measures |
|---|---|
| `_auto-page-govern.mts` | refusals bucketed **by day** (the cap-bug timeline) · every actor that wrote in 60d, raw and collapsed · the proposal queue by age/rule/kind/entity · scope coverage and live-rule reach · the engine registry live |
| `_auto-page-conflicts.mts` | **the rebuilt detector** — reach per actor (rules from scope, engines from the log) · field+direction map · conflicts by entity × field · four pair classes · the proof against the ratchet, the six ACoS rules and the engines |
| `_auto-page-attribution.mts` | the two attribution paths and their disjointness · what the `capped` chip reads at 7/14/30/60 days · queue creation by day · `retail_guard`'s record |
| `_auto-page-caps.mts` | executions per rule per UTC day vs cap, 8 full days · `evidence` coverage by action type |
| `_auto-page-capcheck.mts` | 🔴 **the cap counter, both filter forms side by side, per rule, on one complete day** |

`_auto-study.mts` (the tab study's script) is unchanged and was not overwritten.

## Appendix B — measurement errors made and corrected

*Recorded because in each case the wrong version was plausible and, twice, more dramatic.*

1. **`NOT: { errorMessage: 'X' }` returned zero rows** in `_auto-page-caps.mts`, which read exactly
   like *"the evaluator has not run in 8 days"*. It is the same three-valued-logic trap this
   programme has documented three times — and finding it in my own script is what led to finding it
   in `automation-rule.service.ts:568`, which is §5.
2. **The cadence table reported ×4,909,093,465** because `bid_down` stores a positive percent and
   the handler negates it. Direction must come from the action type. §4.2.
3. **`evidence: { not: undefined }`** is not a filter — Prisma treats `undefined` as "no condition",
   so it returned the whole table and I briefly had "100% of rows carry evidence". Re-measured by
   reading rows. §9.4.

## Sources

- [Pacvue launches Pacvue Agent](https://pacvue.com/newsroom/pacvue-launches-pacvue-agent-advancing-ai-powered-commerce-media-execution/) ·
  [Pacvue Agent — AI for retail media & commerce execution](https://pacvue.com/platform/artificial-intelligence/) ·
  [Pacvue — Introducing the Agentic Commerce Grid](https://pacvue.com/) ·
  [Pacvue Agent promises 200x faster commerce media workflows — PPC Land](https://ppc.land/pacvue-agent-promises-200x-faster-commerce-media-workflows/)
- [CommerceIQ launches AI agents for retail operations](https://www.commerceiq.ai/press-releases/martechview-commerceiq-launches-ai-agents-for-retail-operations) ·
  [2026 Ecommerce AI Agents & Data Actionability Report — CommerceIQ](https://www.commerceiq.ai/reports/2026-ecommerce-data-actionability-ai-agents)
- [Skai — Automated Actions](https://skai.io/capabilities/automated-actions/) ·
  [Advanced Automated Actions](https://skai.io/blog/advanced-automated-actions/) ·
  [Skai Custom Audit](https://skai.io/capabilities/audit/)
- [AdLabs — Amazon PPC software](https://adlabs.app/) · [AdLabs pricing](https://adlabs.app/pricing/) ·
  [AdLabs vs Ad Badger](https://adlabs.app/alternatives/adlabs-vs-ad-badger/)
- [Scale Insights](https://scaleinsights.com/) ·
  [Perpetua — AI vs rules-based automation](https://perpetua.io/blog-amazon-ppc-ai-vs-rules-based-automation/) ·
  [Teikametrics alternative 2026 — SellerStack](https://www.sellerstack.ai/compare/teikametrics)
- [Amazon PPC automation guide: scale without losing control — WisePPC](https://wiseppc.com/blog/amazon-ppc-automation-guide/) *(the four conflict-resolution strategies)*
- [Best Amazon PPC software 2026: an honest buyer's guide — SellerForge](https://www.sellerforge.ai/blog/best-amazon-ppc-software) ·
  [Amazon ads automation tools for senior PPC managers — Pare](https://pare.so/blog/amazon-ads-automation-tools-senior-ppc-managers-2026)
- [Governing the agentic enterprise — California Management Review](https://cmr.berkeley.edu/2026/03/governing-the-agentic-enterprise-a-new-operating-model-for-autonomous-ai-at-scale/) ·
  [Agent autonomy with governance constraints](https://agility-at-scale.com/ai/agents/agent-autonomy-with-governance-constraints/) ·
  [Agentic AI governance and compliance — Okta](https://www.okta.com/identity-101/agentic-ai-governance-and-compliance/) ·
  [AI autonomy governance — TM Forum](https://inform.tmforum.org/features-and-opinion/ai-autonomy-governance-a-governance-framework-for-agentic-ai-enabling-safe-accountable-and-scalable-autonomous-intelligence)
- [2026: the state of agentic AI in retail — Airia](https://airia.com/blog/2026-the-state-of-agentic-ai-in-retail/)

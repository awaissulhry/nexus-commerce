# BUD — Budget: study 6 of 11

*Rules & Automation, tab-by-tab, right to left.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md) · [4 · Budget Schedules](2026-08-11-bs-budget-schedules-study.md) · [5 · Rank & Dayparting](2026-08-11-rd-rank-dayparting-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_bud-study{,2,3}.mts`.

---

## 0 · The one-sentence version

Two rules on AUTO cut campaign budgets by 15–20% **per tick, compounding, with no cooldown and no
floor but Amazon's €1** — the audit trail shows one campaign taken from **€4.42 to €1.00 in seven
consecutive cuts over 2¾ hours** — and this, not policy, is why **58 of 86 live campaigns now sit at
the €1 minimum**, which in turn makes every future trim a no-op.

> ### 🔴 CORRECTION, 2026-08-16 (BUD.8) — the last clause of that sentence is wrong for 56 of the 58
>
> **What was asserted:** that the two AUTO rules' compounding ratchet is why 58 of 86 campaigns sit
> at €1. Repeated in §3, §4 and §9 below, and carried into four other documents.
>
> **What was measured** (`_bud-page-split816.mts`, `_bud-page-0805.mts`, prod, 2026-08-16). For each
> at-floor campaign, the transition write — the row taking it from >€1 to ≤€1 — was classified by
> author and shape:
>
> | cause | n | pre-floor/day | signature |
> |---|---|---|---|
> | **`automation:budget-manager-cron` (the pacer)** | **56** | **€1,276.00** | one write, straight to €1 |
> | the two AUTO rules | **2** | €2.16 | ≥3 rule cuts in the 72h before |
>
> **55 of the 58 were floored inside a single hour — 2026-08-05, 02:00–03:00 — carrying €1,261/day
> between them**, in writes shaped `€100 → €1`, `€60 → €1`, `€20 → €1`. Single writes, not sequences.
> The two genuine ratchet victims are `GALE EXACT IT` (€1.10 → €1) and `GALE EXACT DE` (€1.06 → €1)
> — **both were already at ~€1 when the rules reached them.**
>
> **Why the wrong version was plausible:** the ratchet is real, it is vividly documented in §3, and
> the €4.42 → €1.00 sequence is a genuine measurement. It is simply not the cause of the 58 — it is
> one campaign being re-ground *after* the sweep. A compounding sequence leaves 39 audit rows and
> tells a story; a single `€100 → €1` leaves one row and looks like a setting. The loud mechanism got
> the credit for the quiet one's damage.
>
> **What actually fired** is documented in the engine's own code comment
> (`ads-budget-enforce.service.ts:103`): pacing was *prescriptive*, rewriting every daily budget to
> the pacing target regardless of whether the cap was at risk. On 2026-08-05 the account was **€367
> into a €4,000 month — 91% under — and pacing still proposed cutting 82 campaigns by €1,826/day.**
> It has since been gated on `projected > cap` and cannot fire in that form again.
>
> Nothing else in this study is changed by the correction: the ratchet, the dead cap, the inverted
> signal and the repeat-write loop all stand as measured.

---

## 1 · What the tab is, and every wire behind it

```
?tab=budget
└── RulesAutomationClient.tsx:340  <RuleListTab noun="Budget Rule" liveType="budget" />
    └── GET /advertising/automation-rules  → RULE_TAB_ACTION_TYPES.budget = ['adjust_ad_budget']
    Columns: Automation · Criteria · Frequency  (all three edit LOCAL STATE only)
    Bulk:    … · Delete  ("cannot be undone" → removes a React row, rule survives)

Builder   builder/budget → _shared/RuleBuilder.tsx
Context   advertising-rule-evaluator.job.ts:538 buildCampaignBudgetContexts()
          trigger CAMPAIGN_PERFORMANCE_BUDGET · 7-day window, provisional tail excluded
Action    automation-action-handlers.ts:376 ACTION_HANDLERS.adjust_ad_budget
          → updateCampaignWithSync({ patch: { dailyBudget } })
          → AdvertisingActionLog actionType='AD_BUDGET_UPDATE'
Cap       maxExecutionsPerDay → automation-rule.service.ts:576 → 'DAILY_CAP_EXCEEDED'
```

### The handler, and its one structural weakness

```ts
next = current * (1 + percent / 100)
next = Math.max(1, Math.round(next * 100) / 100)   // floor €1
const delta = Math.max(0, Math.round((next - current) * 100))
```

`delta` is clamped at 0, so a **decrease costs nothing against the spend cap** — correct, a cut
does not spend money. But it means **the spend cap cannot restrain a trim rule at all**, and there
is no other brake: no cooldown, no per-entity daily limit, no floor above Amazon's €1, and no
memory of the original budget.

**`percent` is applied to the *current* budget, not a baseline.** Ten applications of −20% in a day
leave a budget at 0.8¹⁰ = **11%** of where it started. That is the whole defect.

---

## 2 · The six rules

| rule | on | level | trigger | action | conditions | caps |
|---|---|---|---|---|---|---|
| **Scale budget-capped winners** | ✓ | PROPOSE | CAMPAIGN_PERFORMANCE_BUDGET | **+20%** | roas ≥ 4 AND util ≥ 0.85 | 10/day · €200 |
| **Trim budget on weak ACOS** | ✓ | **AUTO** | CAMPAIGN_PERFORMANCE_BUDGET | **−15%** | acos ≥ 0.4 AND spend ≥ €50 | 10/day · €100 |
| Boost budget on profitable campaigns | ✓ | PROPOSE | AD_TARGET_UNDERPERFORMING | +15% | acos ≤ 0.2 AND target spend ≥ €50 | 10/day · €200 |
| Trim budget on weak ACOS *(duplicate)* | ✗ | PROPOSE | CAMPAIGN_PERFORMANCE_BUDGET | −15% | same as above | 10/day · €100 |
| Scale budget on ROAS winners | ✗ | PROPOSE | CAMPAIGN_PERFORMANCE_BUDGET | +25% | roas ≥ 5 AND util ≥ 0.9 | 3/day · €500 |
| **Campaign ACOS rebalance (cut + scale)** | ✓ | **AUTO** | CAC_SPIKE | **−20%** | acos ≥ 0.5 | 5/day · €200 |

**All six are account-scoped** — no market, portfolio, campaign or product scope on any of them.

🔴 **Both AUTO rules only cut.** "Campaign ACOS rebalance (**cut + scale**)" contains no scale
action — its two actions are `adjust_ad_budget −20%` and `notify`. Every rule that could *raise* a
budget is on PROPOSE, and the one paired increase (`Boost budget on profitable campaigns`) has
**0 matches in 3,710 evaluations** because it is bound to the wrong trigger:
`AD_TARGET_UNDERPERFORMING` supplies an ad-target context, and the rule's conditions read
`campaign.acos`.

**The account has automatic brakes and manual accelerators.**

---

## 3 · 🔴 The ratchet, in the audit trail

**2,386 `AD_BUDGET_UPDATE` rows in 60 days across 83 distinct campaigns.**

| writer | rows |
|---|---|
| `automation:budget-manager-cron` (the pacing engine, study 4) | **1,164** |
| `automation:cmpujoff…` (a budget rule) | **642** |
| `automation:cmps335ls…` (a budget rule) | **574** |
| `user:anonymous` | 5 |

**1,880 decreases · 506 increases.** And the sequence is the finding:

```
2026-08-09 23:45   €4.42 → €3.54     ×0.80
2026-08-10 00:00   €3.54 → €2.83     ×0.80
2026-08-10 00:15   €3.54 → €2.83     ×0.80   ← repeat, local value not yet settled
2026-08-10 00:30   €2.83 → €2.26     ×0.80
2026-08-10 00:45   €2.26 → €1.81     ×0.80
2026-08-10 01:00   €1.81 → €1.45     ×0.80
2026-08-10 01:30   €1.81 → €1.45     ×0.80   ← repeat
2026-08-10 01:45   €1.45 → €1.16     ×0.80
2026-08-10 02:00   €1.16 → €1.00     floor
2026-08-10 02:15   €1.16 → €1.00     ← repeat
2026-08-10 02:30   €1.16 → €1.00     ← repeat
```

**€4.42 to the floor in 2¾ hours.** Seven distinct −20% cuts plus four repeats.

Two separate faults are visible:

1. **Compounding with no cooldown.** Nothing prevents a rule from cutting a campaign it cut fifteen
   minutes ago. The `maxExecutionsPerDay` cap limits *executions*, not *repeat action on the same
   entity* — one execution can touch many campaigns, and the next tick starts fresh.
2. **A repeat-write loop.** `€1.16 → €1.00` is issued three times. **488 of 2,386 rows are
   `PENDING`** — the write is queued to Amazon but the local `Campaign.dailyBudget` still reads the
   old value, so the next tick recomputes the same cut and re-issues it. The handler reads local
   state and writes through a queue, with nothing reconciling the two in between.

### This explains study 4

Study 4 measured the median live campaign budget at **€1.00** and read it as consistent with the
standing "suppress with low bids, never pause" policy. **That reading was wrong.** The €1 median is
not a policy — it is the residue of an unbounded ratchet.

---

## 4 · 🔴 …and now the trim rules cannot do anything

| | |
|---|---|
| ENABLED campaigns | 86 |
| **at or below the €1 floor** | **58** |
| where a −15% trim changes nothing | **58** |
| where a −20% trim changes nothing | **58** |
| write gate closed anyway | 4 |
| **campaigns a trim rule can still move** | **24** |

The rules have consumed their own target space. They fire, match, write, and change nothing for 58
of 86 campaigns — which is why the `€1.16 → €1.00` write repeats without ever converging.

### The signal they read is also inverted

`budgetUtilization = 7-day avg daily spend ÷ daily budget`:

| | campaigns |
|---|---|
| ≥ 90% utilised ("budget-capped") | **2** |
| ≤ 25% utilised (over-budgeted) | **52** |

- **GALE EXACT IT — €1.00/day budget, 392% utilised.** *(This is also the campaign carrying the
  **+300% top-of-search multiplier**, live and gate-open, from study 3.)*
- **GALE EXACT DE — €1.00/day, 241% utilised.**

A 392% "utilisation" means the 7-day average daily spend is ~€3.92 against a €1.00 budget — i.e.
the budget was cut to €1 recently and the average still carries the pre-cut days. **The averaging
window hides the ratchet from the very signal meant to govern it.**

And note what `budgetUtilization` cannot see: it is a 7-day *average*, so a campaign that exhausts
its budget by 10am every day and one that spends evenly across 24 hours look identical. **Amazon's
actual out-of-budget hours are not ingested anywhere** — `grep` finds no `oobHours` / budget-util
column in the schema or routes; the Ad Manager's columns of those names are H10-parity placeholders.

---

## 5 · The cap that dominates the health numbers

`DAILY_CAP_EXCEEDED` comes from **`maxExecutionsPerDay`** (`automation-rule.service.ts:576`), not
from the spend cap.

| rule | SUCCESS | FAILED | of which DAILY_CAP | other |
|---|---|---|---|---|
| Trim budget on weak ACOS (AUTO) | 919 | 5,486 | **5,486** | 399 |
| Campaign ACOS rebalance (AUTO) | 735 | 2,252 | **2,252** | 171 |
| Scale budget-capped winners (PROPOSE) | 0 | 0 | 0 | 2,387 *(dry-run)* |

**7,738 of 7,738 "failures" are cap refusals.** Both rules match on nearly every tick, are allowed
10 (and 5) executions per day, and the remaining ~86/day are recorded as failures. Any health
percentage that includes them reads as a catastrophically broken rule; the codebase already knows
this — `ads-weekly-digest.service.ts:25` records *"693,704 DAILY_CAP_EXCEEDED rows in eight weeks"*
from an earlier version of the same problem.

**The cap is the real policy.** It is the only thing between −20%-per-tick and instant collapse to
the floor — and it fails open into 10 cuts a day, which is 0.8¹⁰ = 11% of the starting budget.

### A correction to my own measurement

My first pass reported **"0 budget audit rows in 60 days"**. That was wrong: the query selected
`actor`, `beforeValue` and `afterValue`, which are not fields on `AdvertisingActionLog` (they are
`userId`, `payloadBefore`, `payloadAfter`), and a `.catch(() => [])` swallowed the validation error
and returned an empty array. **A swallowed error read exactly like a measurement of zero.** The
correct figure is 2,386 rows. Recorded because the wrong version was entirely plausible and would
have produced the opposite conclusion.

---

## 6 · How the industry does this

### 6.1 Enterprise

| platform | budget capability | notable |
|---|---|---|
| **Pacvue** | budget **pacing, flighting and out-of-budget controls**; automatically **reallocates budget to top-performing campaigns**; rule chains — *"if ACoS exceeds 25% for three days, reduce bid by 10%"* | note the shape of that example rule: **a sustained condition ("for three days"), not an instantaneous one** |
| **Skai** | **Budget Navigator** — daily bid *and* budget algorithms; pacing across 100+ publishers | budget as a portfolio-level allocation problem, not a per-campaign if/then |
| **CommerceIQ** | automated bid and budget pacing off 50+ shelf-aware signals | budget responds to stock and Buy Box, not only ACoS |
| **Quartile · Teikametrics · Perpetua** | ML owns allocation inside a goal | no percentage knobs exposed |

### 6.2 The four things every mature budget system has that we do not

1. **Reallocation, not just reduction.** Pacvue *moves* budget from losers to winners. Ours has two
   automatic cutters and no automatic raiser — a strictly monotonic account.
2. **Sustained conditions.** *"ACoS > 25% **for three days**"*. Ours fires on a 7-day window read
   **every 15 minutes**, so one bad window authorises ten cuts a day. The window is long; the
   *cadence* is not, and that mismatch is the whole failure.
3. **A baseline to return to.** Enterprise tools hold a plan budget and express changes as
   deviations from it. Ours mutates the live value in place, so nothing knows what €4.42 was, and
   nothing can restore it. *(The `BudgetSchedule` executor in study 4 does exactly this correctly —
   it restores the base budget outside every window. The rule path does not.)*
4. **Out-of-budget hours as the primary signal.** The question is "did this campaign stop showing at
   2pm because it ran dry" — not "what was the 7-day average". Amazon reports it; we do not ingest
   it.

### 6.3 The UI shape they converge on

- **A pacing header** — month-to-date vs plan, projected finish, per market.
- **Budget vs spend as a paired bar per campaign**, with an out-of-budget marker.
- **Proposed changes as a staged diff** — current → proposed → after — approvable in bulk.
- **A change history per campaign** showing who moved it and why, with one-click restore.
- **Reallocation shown as a transfer**: "−€5/day from A, +€5/day to B", one decision, not two.

---

## 7 · What could be implemented, cheapest first

### Tier 0 — stop the ratchet *(hours, and I would do this first)*
- **A per-entity cooldown.** No rule may act on the same campaign twice within N hours. This single
  guard turns the compounding cut into a once-daily one.
- **A floor above €1** — an absolute minimum daily budget per campaign, so trims stop before the
  point where they become no-ops and the repeat-write loop starts.
- **Break the repeat-write loop**: treat a `PENDING` outbound write as the campaign's current value,
  or skip an entity with a write in flight.
- **Cap the total daily reduction** — e.g. no campaign may lose more than 25% of its budget in a
  day, regardless of how many rules fire.

### Tier 1 — make the rules honest *(days)*
- **Fix `Boost budget on profitable campaigns`** — 3,710 evaluations, 0 matches, because a
  `campaign.acos` condition is bound to an ad-target trigger.
- **Delete the duplicate** `Trim budget on weak ACOS`.
- **Rename or complete `Campaign ACOS rebalance (cut + scale)`** — it only cuts.
- **Exclude `DAILY_CAP_EXCEEDED` everywhere a health figure is shown**, and show cap refusals as
  their own number — the cap is the operating policy and should be visible as one.
- **Fix the shared `RuleListTab` lies** (local-state edits, fake Delete) — five tabs, one fix.

### Tier 2 — the missing signal
- **Ingest out-of-budget hours.** Until then "budget-capped" is a 7-day average that cannot see a
  campaign going dark at 10am.
- **Add sustained conditions** — "for N consecutive days" as a first-class condition operator.

### Tier 3 — reallocation
One decision that moves budget from a loser to a winner, within a market's monthly cap, with the
transfer shown as a single reversible act. That is Pacvue's core budget feature and the natural
partner to the `AdBudgetPlan` pacing that already exists.

---

## 8 · How this tab is *supposed* to be

> **One question: is each campaign's budget the right size — and if I change it, what happens?**

- **Budget vs actual spend per campaign**, with out-of-budget hours, not a 7-day ratio.
- **A baseline** every rule deviates from and can restore.
- **Changes as transfers** where possible, so the account total is deliberate.
- **Cooldowns and daily-movement caps** stated on the rule, next to the percentage.
- **Cap refusals shown as refusals**, never as failures.
- **A per-campaign history** with one-click restore — 2,386 writes exist and none is visible here.

---

## 9 · What I need from you

1. 🔴 **The ratchet is live.** Two AUTO rules are compounding cuts every 15 minutes and 58 of 86
   campaigns are pinned at €1. Do you want me to stop it now — disable the two AUTO rules, or add
   the cooldown — before the remaining studies?
2. **Was the €1 median deliberate?** I assumed in study 4 that it reflected your no-pause policy.
   The audit trail says otherwise. If those budgets should be higher, restoring them is a separate
   job from stopping the cause.
3. **Should any rule be allowed to raise a budget automatically?** Today none can.
4. **Ingest out-of-budget hours?** It is the signal this whole tab is missing.
5. **Precedence, again** — `budget-manager-cron` wrote 1,164 budget changes and the two rules wrote
   1,216. They are not coordinated. Who should win?

---

## Appendix — scripts

| script | measures |
|---|---|
| `_bud-study.mts` | the 6 rules in full · execution outcomes · the €1 floor vs the trims · budget utilisation |
| `_bud-study2.mts` | every `AdvertisingActionLog` actionType (this is what corrected the "0 rows" error) |
| `_bud-study3.mts` | the 2,386 `AD_BUDGET_UPDATE` rows: writers, direction, the ratchet sequence, pending writes |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [Best enterprise Amazon PPC software: Skai, Perpetua, Quartile, Feedvisor, Pacvue — SmartScout](https://www.smartscout.com/amazon-software-comparison/best-enterprise-amazon-advertising-software-tools-for-amazon-ppc-skai-perpetua-quartile-feedvisor-and-pacvue)
- [Pacvue for Amazon](https://pacvue.com/marketplaces/pacvue-for-amazon/) ·
  [Pacvue vs Skai (Kenshoo) — Atom11](https://www.atom11.co/blog/pacvue-vs-kenshoo-skai)
- [18 best Amazon PPC tools — Eva](https://eva.guru/blog/best-amazon-ppc-tools/) ·
  [Best Amazon PPC automation tools — Sequence Commerce](https://sequencecommerce.com/best-amazon-ppc-automation-tools/)
- [A complete guide to budget rules — Amazon Ads](https://advertising.amazon.com/library/guides/budget-rules) *(carried from study 4 — native budget rules remain uncalled by this codebase)*

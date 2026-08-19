# EA4 — why every rule opened blank, and the four defects behind it

**2026-08-19.** Operator: *"on almost all of the pages, like bid, keyword harvest, negative
targeting, and budget, I see multiple rows already active. When I click on any of those rules in the
rule builder, I don't see any data in the rule, anything like that, or any action that's happening
or any campaigns that are selected."*

Commits `fea083791` (EA4) · `27dcbf387` (EA4.1). Both prod-verified.

## The cause: two shapes, one direction of travel

| | Engine-native | Builder |
|---|---|---|
| conditions | `[{field:'campaign.acos', op:'lte', value:0.2}]` | `[{conditions:[…], action:{op,value}}]` |
| actions | `[{type:'adjust_ad_budget', percent:15}]` | `[{type:'budget', control, campaigns, schedule, …}]` |
| campaigns | `scopeCampaignId` / `scopePortfolioId` columns | `actions[0].campaigns` |

`maybeTranslateAdsRule()` has always converted **builder → engine** in memory at evaluation time
(`automation-rule.service.ts:521`). Nothing converted back. So the builder could only read rules it
had written itself — and **it has written none**.

**Measured on prod before the fix, across all 51 stored rules:**

| what the builder hydrates from | rules that have it |
|---|---|
| nested `conditions[].conditions` | **0** |
| `actions[0].campaigns` | **0** |
| `actions[0].schedule` | **0** |
| `actions[0].control` | **0** |

31 rules are template-seeded, 20 arrived through the API. Only `name` hydrated — exactly what the
operator saw. Provenance also explains it: the seed templates are written flat
(`automation-templates.ts:32`), and `harvest-actors.service.ts:15-18` had already recorded the
measurement — *"builder-shaped rules … 0 of 62"* — calling the adapter *"a landmine, not a leak"*.

## The four defects

### 1. No reverse translation
`engineRuleToBuilderView()` now sits beside the forward adapter **in the same file**, with every map
produced by `invert()`ing the forward map rather than re-typed, so the pair cannot drift.
`GET /automation-rules/:id` returns it as `builderView`; the web re-derives none of it.

### 2. 🔴 A save could destroy a live rule
The builder's payload **replaces** `conditions` and `actions` wholesale, and its per-group fallback
substitutes `defaultCondition(slug)`. Saving a rule it could not read would have written blank
defaults over the criteria of an automation that has executed — 18 of the 20 enabled rules have.
It was unreachable **only by luck**: `valid` happened to fail with 0 campaigns selected.

Rules the builder cannot reproduce now open read-only, with Save disabled at both buttons *and* in
`submit()`, behind a banner that names every blocker and summarises what the rule actually does.

### 3. The campaign picker did nothing on Budget and Placement rules
The adapter never passed `campaigns` through for those two slugs, and both handlers take the
campaign from the evaluation context — so a rule showing *"12 campaigns selected"* applied
**account-wide**. `bid_apply` had the allowlist check; `budget_apply` and `placement_apply` did not.
All three share `campaignAllowed()` now. **Empty still means no restriction**, so no existing rule
changes behaviour. The helper also accepts the Autopilot's `campaignIds` spelling
(`autopilot/coordination.ts:35-56`), which nothing had ever read.

### 4. 🔴 A fail-open
Builder-shaped actions + engine-native conditions gave `translateConditions` no `g.conditions` to
iterate → **zero leaves** — and `evaluateConditions` treats an empty list as `true`
(`conditions-tree.ts:87-96`). Such a rule matched **every context on every tick**. It now refuses as
untranslatable, which the evaluator already turns into a no-match and the save routes into a 400.

Of all the failure directions this is the one that must never be silent: an over-tight rule does
nothing, an over-loose one writes to the whole account.

## EA4.1 — read across contexts

First prod measurement after EA4: 10 of 51 showed criteria, and the biggest remaining blocker was
self-inflicted. `adTarget.spendCents` read as unmapped **six times although `ADTARGET_METRIC`
contains it** — the rule's slug resolved to `budget`, whose inverse map holds `campaign.*` only.
Same in reverse for `campaign.acos`, five times, on bid rules. Stored rules mix contexts freely, and
engine field names carry their own context (`campaign.acos` ≠ `adTarget.acos`), so the inverse now
falls back across all maps.

## Result, measured on prod

| | before | after |
|---|---|---|
| rules whose criteria the builder shows | **0** of 27 with conditions | **20** of 27 |
| rules protected from a destructive save | 0 | **51** |
| Budget/Placement rules whose campaign picker binds | 0 | all |

Still unmapped, and each named to the operator rather than dropped: `profit.netCents` (4),
`budget.monthlySpendCents` (2), `adTarget.ordersCount` (1), `fbaAge.daysToLtsThreshold` (1) — fields
with no builder metric at all.

## EA5 — the read-only lock was over-correction, and is gone

Operator: *"Why is every rule read-only? I intended and built it to function."* Correct, and EA4
traded the feature away rather than solving the harder problem.

**Why it locked everything:** the builder's save sends its ENTIRE payload, replacing `conditions`
**and** `actions` in one write — so "cannot represent the action" really did mean "cannot save
safely". But that is the *builder's* constraint, not the rule's:
`PATCH /automation-rules/:id` already applies only the keys present in the body
(`if (body.X !== undefined)`).

One boolean became three levels:

| level | what saves | count on prod |
|---|---|---|
| `full` | everything — a builder-shaped rule, unchanged | 0 |
| `criteria` | name · criteria · caps · scope. **`actions` is never sent** | **35 of 51** |
| `meta` | name · caps · scope; criteria held `inert` because one condition is not drawn, and writing back only the visible ones would delete it | 16 of 51 |

`conditionsForStorage()` keeps an engine-native rule engine-native: the builder sends nested groups,
and storing those on a rule with engine action types would leave a pair nothing handles —
`maybeTranslateAdsRule` fires on builder *actions* only, so the nested conditions would reach
`evaluateFlatList`, whose leaves have no `field`, and throw mid-tick.

Two validation checks also had to go, both guarding fields this save never writes: `targetsValid`
(a campaign selection these rules do not carry) and the THEN value in `criteriaValid` (part of the
action). Worth stating plainly — **a permanently-disabled Save is what made the original destructive
path look safe for as long as it did.** "The button was greyed out" is not a guarantee.

### 🔴 EA5.2 — the bug only a real save could find

Editing *"Cut bids on high ACOS"* from 40 → 45 on prod stored the threshold correctly and left both
actions byte-identical — **and silently rewrote the field from `campaign.acos` to `adTarget.acos`**,
moving the rule from reading the campaign's ACoS to the target's.

A builder metric name is **context-free**: "ACOS" resolves to either field purely by which map is
consulted, and `conditionsForStorage` chose the map from the action type (`bid_down` →
`ADTARGET_METRIC`). The view now carries the original `field` on every condition, the builder passes
it through, and storage pins it back. The metric still supplies the *conversion*, which is a
property of the metric rather than the field.

**The existing round-trip test passed while this shipped** — a budget rule and `CAMPAIGN_METRIC`
happen to agree. One fixture, one context, false confidence. The new test uses a bid rule holding a
campaign field, which is the combination that actually breaks.

Verified end to end on prod afterwards: value 0.4 → 0.45, `field` still `campaign.acos`, both
actions byte-identical, `enabled` unchanged. The rule (disabled, 0 executions) was restored.

## Not touched

Rank & Dayparting renders `RankGoalBuilder`, Budget Schedule renders `ScheduleBuilder` — neither
goes through `RuleBuilder`, so neither can be affected.

## One thing the inverse surfaced, unresolved

`Boost budget on profitable campaigns` (enabled, `CAMPAIGN_PERFORMANCE_BUDGET`) gates on
`adTarget.spendCents`, a field that trigger's context does not emit. Comparing against `undefined`
never matches — and the rule's `executionCount` is **0**. Worth an audit of condition fields against
each trigger's context; the adapter's own comment warns of exactly this
(*"an entry pointing at a missing field … silently never match"*).

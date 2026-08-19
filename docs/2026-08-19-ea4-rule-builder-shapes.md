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

**Every rule is read-only today.** That is the honest outcome, not a shortfall: the builder writes
one action from a fixed set, and no stored rule uses only those. It is now a truthful *viewer* for
them, and still a working *creator* of new ones.

## Not touched

Rank & Dayparting renders `RankGoalBuilder`, Budget Schedule renders `ScheduleBuilder` — neither
goes through `RuleBuilder`, so neither can be affected.

## One thing the inverse surfaced, unresolved

`Boost budget on profitable campaigns` (enabled, `CAMPAIGN_PERFORMANCE_BUDGET`) gates on
`adTarget.spendCents`, a field that trigger's context does not emit. Comparing against `undefined`
never matches — and the rule's `executionCount` is **0**. Worth an audit of condition fields against
each trigger's context; the adapter's own comment warns of exactly this
(*"an entry pointing at a missing field … silently never match"*).

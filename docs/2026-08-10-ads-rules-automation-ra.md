# RA — Rules & Automation, rebuilt as a section

**Date opened:** 2026-08-10
**Surface:** `/marketing/ads/rules-automation/*`
**Status:** section map agreed — **six pages, one scope bar**. The **scope bar has shipped** (§3.5). No page rebuilt yet; Automations is next.
**Read before touching anything under `/marketing/ads/rules-automation` or `/marketing/ads-console/automation`.**

Companions — read, do not re-derive:
- `2026-08-04-ads-market-research.md` — 17 platforms, the editable-vs-algorithmic axis, SOV as a category
- `2026-08-04-competitor-deep-dives.md` — Pacvue, Rithum, Perpetua, Teikametrics, Intentwise, BidX, Scale Insights, M19
- `2026-08-05-ads-control-room-coverage-acr.md` — SERP mechanics (Part 3), the coverage engine, Stage 6 retirement precedent
- `2026-08-01-dayparting-schedules-dps.md` — the routed-tab substrate this section already uses
- `2026-08-10-ra-session-locks.md` — **the parallel-session protocol. Claim a file before editing it.**

---

## Part 0 — Why this exists

The operator's ask, 2026-08-10: turn the ten tabs into real pages; get control over "51 automations"
that have no UI; never build the same thing twice; keep everything wired and in real-time sync; make
it legible to a beginner; tooltip everything; solve three similar products competing for one keyword
where only one reaches page one.

And, stated second and overriding the first: **see statistics and take action by date range, and by
portfolio / market / product / campaign — without overcomplicating the UI. "We already have a solid
base. The UI is simple, and I like it quite a lot."**

That second instruction is the more important one, and it is why this section is **six pages, not
nine and not nineteen**. The four "views" are not four pages. They are one control.

Everything below is measured against prod on 2026-08-10 (`apps/api/scripts/_ra0-census.mts`,
read-only) or read out of current code.

---

## Part 1 — What exists today (measured, not assumed)

### 1.1 The 51 automations are `AutomationRule` rows with `domain='advertising'`

| state | count | what it can do |
|---|---|---|
| `enabled=false` | 29 | nothing — resolves `OFF` |
| `enabled`, `autonomyLevel=PROPOSE` | 13 | queues an `AdsRuleSuggestion`, never writes |
| `enabled`, `autonomyLevel=AUTO` | 9 | **writes to Amazon**, inside the write gate |

- **All 51 are account-scoped.** `scopePortfolioId` / `scopeCampaignId` are null on every row — the
  ACR.7 drag-to-scope binding has never been used once. Directly relevant to the scope bar (Part 3):
  the grain the operator wants to act at is the grain no rule is bound to.
- 21 distinct action types; the tab filter map covers 14. **Nine have no home at all**: `notify`,
  `alert_operator`, `retail_guard`, `pause_ad_group`, `pause_campaign`, `pause_all_campaigns`,
  `archive_keyword`, `refresh_dayparting`, `create_amazon_promotion`.
- 18 distinct triggers, `SCHEDULE` dominant at 23.
- `AdsRuleSuggestion`: **185 pending, 1 ever applied, 0 dismissed.**

### 1.2 There are four automation surfaces, plus a dock

| surface | shape | owns |
|---|---|---|
| `/marketing/ads/rules-automation` | 10 tabs | the campaign grid + 5 filtered rule lists |
| `…/rules-automation/control-room` | 5 tabs — Today, Levers, Guardrails, Activity, Foresight | engines, breaker, posture |
| `/marketing/ads-console/automation` | ~16 tabs | **the only real manager of the 51**, + an 86-entry catalogue |
| `/marketing/ads/autopilot` | "AI Control" | north-star planner |
| `AutomationDock` | right rail on Portfolios + Family Cockpit | **the only control that writes the real autonomy knob** |

### 1.3 The ten tabs, and what is actually behind each

| # | tab | today | data behind it |
|---|---|---|---|
| 1 | Apply Rules | campaign grid, 220 rows | **3 of 5 columns persist nowhere** — see 1.4 |
| 2 | Bid | `RuleListTab liveType='bid'` | filter over the 51 |
| 3 | Keyword Harvest | `RuleListTab` | filter over the 51 |
| 4 | Negative Targeting | `RuleListTab` + `ProtectedTermsPanel` | filter over the 51 · 10 protected terms |
| 5 | Budget | `RuleListTab` | filter over the 51 |
| 6 | Rank & Dayparting | **routed page** | 16 `RankScheduleGroup`, 4 enabled · 5 `RankTarget` · 2 `ProductRankPlan` |
| 7 | Budget Schedules | `BudgetScheduleTab` | **`BudgetSchedule` = 0 rows** |
| 8 | Placement | `RuleListTab` | filter over the 51 |
| 9 | Share of Voice | `SovTrackerTab kind='sov'` | derived within-account SOV |
| 10 | Keyword Tracker | `SovTrackerTab kind='tracker'` | **`KeywordRank` = 0 rows** |

**Tabs 2, 3, 4, 5 and 8 are one React component with a different filter string.**

### 1.4 Three columns on the landing tab are decoration

`RulesAutomationClient.tsx:143-167` — **Bid Rule** (`bidAlgorithm`, "UI-only until Amazon exposes a
per-campaign field"), **Min/Max Bid** (`patchLocal` only, never PATCHed), **Budget Rule**
(hard-coded `None` for all 220 campaigns). Only Target ACoS and Bid Automation reach the API.
[[reference_fleet_stale_constant_class]].

### 1.5 Dead code

`tabs/placeholderSeeds.ts` (`TAB_RULES`) and `ComingSoon` are **unreachable** — every tab key is
handled by an explicit branch above them. Delete both.

### 1.6 🔴 The scope-and-date substrate exists and is switched off

This is the finding that makes Part 3 cheap.

- **The date range is built end-to-end.** `ads-core/date-range.ts` `resolveRange()` supports 13
  presets — today, yesterday, last 7/14/30/90, WTD, MTD, last month, QTD, YTD, last year, lifetime,
  custom. `GET /advertising/campaigns` derives spend/sales **live from `AmazonAdsDailyPerformance`**
  whenever a range is passed, falling back to stored columns when it is not. **Rules & Automation
  passes `showDateRange={false}` and sends no range.** Wiring, not building.
- **`AdsPageHeader` owns date-range state in a local `useState`** ("the header owns the state for
  now"). It is therefore per-page, not in the URL, and not shared. This is what must change.
- **`AdsMarketplaceProvider` exists and is not consumed by the header.** Its own comment says it was
  built because "each analytics page kept its own local market filter derived from whichever
  campaigns happened to load, so nothing agreed with anything else" — and `AdsPageHeader` still takes
  a `markets: string[]` prop that Rules & Automation derives from whichever campaigns loaded. The fix
  was written and never plugged in.
- **The Portfolio filter shows raw Amazon portfolio IDs.** `RulesAutomationClient.tsx:110` sets
  `label: String(p)` from `portfolioId`. Twelve portfolios, twelve opaque strings.
- **Portfolio is filtered client-side only.** `GET /advertising/campaigns` accepts `marketplace`,
  `status`, `search`, `limit` and the date params — no portfolio, no ASIN.
- **There is no product-grain page anywhere in `/marketing/ads`.** Product view exists only at
  `ads-console/products`, in the console being retired. **Of the four lenses, product is the only
  real build.**

---

## Part 2 — 🔴 The defect that must be fixed before any of this ships

**The rule manager's dry-run/live control cannot change what a rule does.**

`ads-console/automation/AutomationHub.tsx:100` toggles `dryRun` via
`PATCH /api/advertising/automation-rules/:id`. But:

```ts
// services/advertising/ads-autonomy.ts:53
export function resolveAutonomy(rule) {
  if (!rule.enabled) return 'OFF'
  if (isAutonomyLevel(rule.autonomyLevel) && rule.autonomyLevel !== 'OFF') return rule.autonomyLevel
  return rule.dryRun ? 'PROPOSE' : 'AUTO'   // ← reached only when autonomyLevel is null/OFF
}
```

**All 51 rules carry an explicit `autonomyLevel`, so that fallback is unreachable for every one of
them.** The PATCH handler (`advertising.routes.ts:5873-5905`) does not accept `autonomyLevel` at all.

Live consequences: "Set live" on a PROPOSE rule leaves it PROPOSE · bulk "Set live" appears to arm
the fleet and arms nothing · the only binding control on that page is `enabled` · the **only**
surface writing the real knob is the `AutomationDock` (`PATCH /advertising/autonomy/rules/:id
{level}`), the rail being retired.

**Law: the Automations page exposes `autonomyLevel` (OFF / OBSERVE / PROPOSE / AUTO) as the single
mode control. `dryRun` is never shown.** Verify with `resolveAutonomy(rule)` + `levelActs(level)`,
never by reading a column. See [[reference_ads_dryrun_is_dead_field]].

---

## Part 3 — The scope bar: one control, four views ⭐

**This is the organising device of the whole section. Build it before page work starts.**

The operator wants portfolio / market / product / campaign views, with statistics and actions at each,
over a date range — and explicitly does *not* want more pages. Those are not four pages, or sixteen
tabs, or twenty-four. They are **one bar rendered once in the section layout and read by all six
pages**.

```
[ Market ▾ ]   [ Scope: Account · Portfolio · Product · Campaign ▾ ]   [ Date range ▾ ]
```

### 3.1 The contract

- **State lives in the URL**: `?market=IT&scope=portfolio&id=<portfolioId>&preset=last30`
  (`&start=&end=` when `preset=custom`). Shareable, bookmarkable, survives refresh, back/forward
  works. This is the same choice DPS.3 already made when it moved the tabs off `useState` — "every
  tab is now addressable" — so it is consistent with the section, not a new idea.
- **Market resolves from `AdsMarketplaceProvider`**, never from whichever campaigns happened to load.
  Sandbox markets stay visible and unselectable, with the reason shown (that behaviour already exists
  in the provider — do not re-litigate it).
- **Date resolves through `resolveRange()`** — the same server function, so the UI's "last 30 days"
  and the API's are the same 30 days. Never hand-roll a date window; [[reference_day_grouping_utc_local_trap]]
  is invisible to `tsc` and to looking.
- **One hook, `useAdsScope()`**, returns `{ market, scope, id, range }`. Every page reads it. No page
  keeps its own copy of any of the four. That is the whole of the "real-time sync" requirement: not
  a push channel, but a single source that nothing shadows.
- **Empty scope is `Account`.** Never fabricate a default portfolio or product.

### 3.2 Actions follow the scope

The grain that is showing is the grain that acts. One selection model, four grains — not four sets
of controls:

| scope | statistics show | an action applies to |
|---|---|---|
| Account | everything in the market | all allowlisted campaigns |
| Portfolio | that portfolio's campaigns | those campaigns |
| Product | campaigns advertising that ASIN | those campaigns / their ad groups |
| Campaign | that campaign | that campaign |

Every destructive or spending action confirms with **the resolved blast radius in rows and €** —
"apply to 34 campaigns in AIREON, ~€212/day of budget affected" — computed from the current scope,
never from a hard-coded noun.

### 3.3 What has to be built vs wired

| piece | state |
|---|---|
| Date presets + resolution | **exists** — `resolveRange()`, 13 presets. Wire it. |
| Date-windowed campaign metrics | **exists** — `GET /advertising/campaigns` with `preset`/`startDate`/`endDate`. Wire it. |
| Market list + persistence | **exists** — `AdsMarketplaceProvider`. Consume it from the header. |
| Portfolio list with real names | **partly** — `AmazonAdsPortfolio` has 12 rows; the filter shows IDs. Fix the label. |
| Portfolio filter server-side | **missing** — add to `GET /advertising/campaigns`. |
| **Product scope** | **missing** — needs an ASIN → campaigns/ad-groups resolver. The one real build. |
| URL state + `useAdsScope()` | **missing** — new, small. |

**Product scope caveat, found 2026-08-06 and still true:** all 16 `B0H8*` ASINs the AIREON campaigns
advertise are Xavia listings **missing from the Product catalogue**. A product picker built today
would not be able to name them. Reconcile by running the existing Amazon import for AIREON — no new
tooling — before the product lens ships. Measured scale of the gap: **4,211 of 4,485 ad-product rows
(93.9%) link to a PIM `Product`; 274 do not.**

### 3.4 🔴 The four grains, measured — and the obvious assumption is wrong

Operator instruction, 2026-08-10: *"I must have proper control over each and everything. Even if I
want to apply a rule to just a single campaign, it should be super easy. Same for whole portfolios,
the entire market, the entire product line — always."*

That requires all four grains to be **first-class and equally easy**. Measured on prod
(`scripts/_ra1-grain.mts`, read-only), they are nowhere near equal:

| grain | campaigns it can reach | **settable** today | **enforced** today |
|---|---|---|---|
| Market | **220 / 220** — IT 150 · DE 38 · FR 22 · ES 10 | 🔴 **no** — not accepted by the scope route | ✅ yes |
| Portfolio | 🔴 **72 / 220 (33%)** across 10 portfolios | ✅ yes | ✅ yes |
| Product line | **220 / 220** via `AdProductAd` → `AdGroup` → `Campaign` | 🔴 **no field exists** | 🔴 **no** |
| Campaign | **220 / 220** | ✅ yes | ✅ yes |

Four findings, each of which changes the build:

1. **🔴 Portfolio is the weakest grain, not the strongest.** Only **72 of 220 campaigns carry a
   `portfolioId`**. A rule bound to a portfolio **can never touch 148 campaigns — 67% of the
   account.** Two of the 12 portfolios hold nothing. Any UI offering portfolio scope must say what
   share of the account that scope actually reaches, or it silently under-applies. (This also bounds
   the Family Cockpit, which is a per-portfolio view.)
2. **🔴 Market is enforced but not settable.** `ruleMatchesScope()` honours `scopeMarketplace`
   strictly, but `PATCH /advertising/autonomy/rules/:id/scope` accepts **only** `scopePortfolioId`
   and `scopeCampaignId`. The market half is reachable only through the *other* route,
   `PATCH /advertising/automation-rules/:id` — two routes, two halves of one feature. Add
   `scopeMarketplace` to the scope route so one control writes one thing.
3. **🔴 Product-line scope does not exist.** `RuleScope` is `{scopeMarketplace, scopePortfolioId,
   scopeCampaignId}` and `ContextIdentity` carries no ASIN. This is a **schema + evaluator + UI**
   build — the largest single item in the operator's grain requirement. The path is fully populated
   and ready: `AdProductAd.asin` (4,485 rows, **100% carry an ASIN**, 250 distinct) → `adGroupId` →
   `AdGroup.campaignId`, and **every one of the 220 campaigns is reachable this way**.
   *Definition to pin first:* "product line" = the `Product` parent row and its variations
   (`AdProductAd.productId`), **not** `Product.familyId` — `ProductFamily` is an Akeneo-style
   *attribute template*, and using it would be a category error.
4. **🔴 One product can mean 76 campaigns.** ASIN → campaign fan-out is severe: 105 ASINs reach 6
   campaigns each, 34 reach 17, and several reach **70–76**. So the blast-radius confirmation in
   §3.2 is not a nicety — **at product grain it is the only thing standing between "super easy" and
   "I just changed 76 campaigns by accident."** Show the resolved count *before* the action, always.

**Scope is a hierarchy, and the model treats it as mutually exclusive.** The scope route nulls the
portfolio when a campaign is set and vice versa. That is coherent, but it means "this portfolio, but
only in DE" is not expressible in one call today. Decide in the 4.2 study whether scope is one
choice or an AND of dimensions; do not let the UI imply the latter while the API does the former.

### 3.5 🔴 SHIPPED 2026-08-10 — and the two-vocabularies trap it walked into

`_shared/ads-scope.ts` + `_shared/ScopeBar.tsx`, 16 tests. The bar is live on the index page:
market · scope (+ target) · dates · **a visible line saying what that reaches**.

**The trap, found while wiring and worth the whole section:** `_shell/DateRangePicker.tsx` exports
its own `DATE_PRESETS`, and they are a **different vocabulary** from `ads-core/date-range.ts`'s
`RangePreset`, which is what the API actually resolves.

| picker | server |
|---|---|
| `today` `yesterday` | `today` `yesterday` |
| `latest7` `latest30` `latest60` | `last7` `last14` `last30` `last90` |
| `thisWeek` `thisMonth` `thisQuarter` | `wtd` `mtd` `qtd` |
| `lastWeek` `lastMonth` `lastQuarter` | `last_month` `ytd` `last_year` |
| `last3m` `last12m` `last18m` `last24m` | `lifetime` `custom` `window` |

**Only `today` and `yesterday` exist in both.** `resolveRange`'s `default:` branch falls back to
`windowDays` (**7**) for anything it does not recognise — *silently*. Forwarding the picker's key
would have returned **seven days of data under a "Last 30 days" label**, and the same for
"Last 12 Months". Two more mismatches hide inside the names that look shared: the picker's
`thisWeek` starts **Sunday**, the server's `wtd` starts **Monday (ISO)**; and the picker computes in
**browser-local** time while the server anchors to **Europe/Rome**, because the daily fact tables
are Rome calendar days stored at UTC midnight.

This is the **fifth** two-vocabularies defect in this programme, after `EXACT`/`_EXACT`, the
rule-tab filter word, `expressionType` vs `isNegative`, and the ToS-IS `location` key.

**The law, so it is not rediscovered a sixth time:** *the server owns the date vocabulary. The
client sends a key the server understands and never its own computed dates for a preset. Resolved
dates for display come back in the response's `range` echo — which
`GET /advertising/campaigns` already returns as `{ startDate, endDate, preset }` — and are never
recomputed on the client.* A `custom` range is the one case the client supplies dates, which is
exactly the case `resolveRange` accepts them for.

**Still open from this unit:** `GET /advertising/campaigns` accepts marketplace/status/search/limit
+ the date params, and **ignores `scopeGrain`/`scopeId`**. `scopeToQuery` sends them anyway (never
silently dropped), and the index narrows by grain client-side meanwhile — otherwise choosing a
portfolio would leave all 220 campaigns on screen under a "72 of 220" reach line, the surface
contradicting its own label. Teaching the endpoint the grain is the next server-side unit.

**Also note:** `DateRangePicker`'s presets remain wrong for any caller that forwards them to the
API. This unit contained the problem for Rules & Automation; it did not fix the picker.

---

## Part 4 — The section: six pages

```
1. Overview      /marketing/ads/rules-automation
2. Automations   …/automations
3. Schedules     …/schedules
4. Coverage      …/coverage
5. Activity      …/activity
6. Controls      …/controls
```

Six pages replace 10 tabs + 5 Control-Room tabs + ~16 ads-console tabs + a dock. Every one of them
sits under the Part 3 bar.

### 4.0 The boundary table — one subject, one owner

**This is the anti-duplication contract. Before adding any section to any page, find its subject
here. If it belongs to another page, link to that page instead of building it.**

| subject | the ONE page that owns it |
|---|---|
| is automation working, and does it need me | Overview |
| a rule's definition, mode, scope, caps | Automations |
| the catalogue of rules you could add | Automations |
| anything that fires on a clock | Schedules |
| who holds a keyword — us vs the market, and which of our ASINs | Coverage |
| a decision waiting for a human | Activity → Pending |
| the record of every change, and undo | Activity → Done |
| a limit that refuses a write | Controls |
| a background engine's mode, cron, health | Controls |
| **which market / portfolio / product / campaign / dates** | **the scope bar — never a page** |

The last row is the one that keeps this section at six pages. A "portfolio view" is not a page; it
is the bar set to Portfolio.

### 4.1 Overview `/rules-automation`

*One screen: is automation working, and does it need me?*

| section | purpose |
|---|---|
| Posture band | account autonomy, halted or not, and one sentence saying what that means. |
| Did / wanted / blocked | three counts for the current range and scope, each linking to its rows. |
| Needs you | top few pending suggestions; "see all 185" → Activity. A teaser, never the queue. |
| Health strip | any engine with a warning. Silent when all is well. |
| What changed | last few applied changes; full record → Activity. |

Absorbs: Control Room "Today" + "Foresight", ads-console "home", `RuleImpactStrip`.

### 4.2 Automations `/automations` ⭐ **build first**

*Every rule you have, everything you could add, and one honest mode control.*

| section | purpose |
|---|---|
| Census band | 51 · 29 off · 13 proposing · **9 writing**. The `AUTO` count gets the emphasis. |
| Type filter | Bid · Harvest · Negative · Budget · Placement · **Other**. Replaces five tabs. **"Other" is mandatory** — nine action types are currently invisible (1.1). |
| Rule list | plain-English *When / If / Then*, trigger, matches, runs, % acted, last run, scope, conflict flag. |
| Mode control | **`autonomyLevel` only** — never `dryRun`. See Part 2. |
| Scope binding | account / portfolio / campaign. **Pre-filled from the scope bar**: with the bar on a portfolio, "bind here" needs no second picker. All 51 are account-wide today. |
| Bulk actions | mode, enable/disable, delete — confirm states the blast radius per §3.2. |
| Simulate | run against real current data, show what it *would* do. `POST /advertising/automation-rules/:id/simulate` exists. Taken from Scale Insights. |
| Conflicts | enabled rules on one trigger with opposing actions. Logic exists in `AutomationHub`; port it. |
| Catalogue | 86 templates + playbooks. Born `enabled=false`, `autonomyLevel='OFF'`. |
| Builder | custom rules. `/builder/[type]` exists; fold it in. |

Absorbs: Apply Rules, Bid, Keyword Harvest, Negative Targeting, Budget, Placement · ads-console
library/playbooks/active/composer/builder/recs · Control Room "Rules" · the `AutomationDock`.
**Deletes:** the three decorative columns (1.4), `placeholderSeeds.ts`, `ComingSoon`.

#### 4.2a 🔴 Fixed on the way in — the colour said a pause-everything rule could not write

`ruleCategory()` (shared by the dock, the rules tabs and the cockpit) fell back to `alert` for any
action it did not recognise — and `alert`'s own definition is *"informs, never writes"*.

Measured (`scripts/_ra2-category.mts`): **8 of 51 rules carried a writing action while labelled
Alerts**, including **"Monthly spend cap (pause everything)"** and **"Monthly budget cap"**, whose
action is `pause_all_campaigns` — the largest blast radius in the system. Four writing action types
had no mapping at all: `pause_ad_group`, `refresh_dayparting`, `pause_all_campaigns`,
`create_amazon_promotion`.

All eight were `OFF`, so nothing had acted on the mislabel. The danger was the label: **colour is
what an operator scans to decide what is safe to arm**, and slate said "this one cannot touch
anything."

Fixed two ways, because mapping alone would only fix today's eight:
· `pause_ad_group` + `pause_all_campaigns` → **guard** (they suppress spend exactly as
  `pause_campaign` already there; they differ in blast radius, not in kind)
· `refresh_dayparting` → **placement** (it rewrites the plan the engine turns into hour-window
  multipliers — the same family as rank-defense)
· **the fallback now splits**: unmapped *with* a writing action → new **`other` / "Other changes"**;
  unmapped with only `notify`/`alert_operator`/`log_only` → `alert`. So the next unmapped write
  cannot inherit the same lie.

After: **0 mislabelled**. Distribution moved bid 13 · placement 8→11 · guard 4→9 · negative 8 ·
budget 6 · alert 12→4 · other 0. `create_amazon_promotion` is the only action with no family of its
own and lands in `other`, correctly — it is not an ads-targeting action.

---

### 4.3 Schedules `/schedules`

*Anything that changes on a clock.*

| section | purpose |
|---|---|
| Schedule list | 16 rank-goal groups (4 enabled) + budget schedules, one list, `kind` a column not a tab. |
| Week shape | the existing hour grid — the strongest thing on this surface today. |
| Next 24h | what will fire, and when. Built (`Next24Preview`). |
| Coverage & conflicts | gaps, overlapping windows. Built (`scheduleHealth.ts`). |
| Arm / disarm | with a preview of what arming changes. |
| Versions & activity | per-schedule history. Built. |

Absorbs: Rank & Dayparting (keep almost all of it), Budget Schedules, ads-console "dayparting".
**Carried operator decision, still open:** the fleet cannot arm a schedule firing less often than
every 8 days. Surface it here.

### 4.4 Coverage `/coverage`

*Who holds the keyword — us against the market, and which of our own products.*

The two lenses the operator named are the scope bar, not two pages: **Account/Market scope answers
"how much of the shelf do we hold"; Product scope answers "which of our products is holding it".**

| section | purpose |
|---|---|
| Vocabulary header | **Share of Voice = paid first-page visibility. Share of Shelf = organic.** Two metrics, never merged (DataHawk). |
| Keyword board | per keyword: our paid share, organic rank, direction. Baseline is real and sobering — **0.6–1.5% on head terms**. |
| Position / fold weighting | a slot above the fold is worth more; flat share hides it. |
| Competitor presence | named competitors over time. **Amazon does not report this** — the API gives only `topOfSearchImpressionShare`. Scope honestly in the study. |
| Keyword × ASIN matrix | *(product lens)* which of our ASINs took impressions on a term, which took none, which is the de-facto lead. |
| Starved siblings | *(product lens)* our products advertising a term with no page-one presence — **the operator's three-jackets complaint, made countable**. |
| Cost of a second slot | bid gap between lead and sibling, against the term's ACOS cap. |
| Coverage sets | `KeywordCoverageSet`/`Term` — the allocation instrument. 97 terms seeded on GALE, still DRAFT. Arming lives here. |
| Engine readout | the coverage engine's observe log: championed / would-down / held, with reasons. |
| Rank tracker | `KeywordRank`, **0 rows**. Fill it or say plainly that it is empty. |
| 🔴 The blocked lever | lead-ASIN assignment via negative-exacts **cannot work here**: all 21 enabled GALE campaigns are one ad group × all ~18 children, so a negative silences the lead too. First honest deliverable is a **campaign-restructure recommendation**, not an automation. |
| 🔴 What we do not know | the multi-ASIN experiment came back **confounded** — with one dominant family, weekly SQP cannot separate "how many children" from "how strong the parent". AIREON (live 2026-07-28) is the first comparable second family. Re-running that is this page's first study. |

Absorbs: Share of Voice, Keyword Tracker, ads-console "competitive".

### 4.5 Activity `/activity`

*One table, two states: **Pending** (undecided) and **Done** (the record). A row moves between them
and never appears in both.* Defaults to Pending while any are waiting.

| section | purpose |
|---|---|
| Pending | the 185 `AdsRuleSuggestion` rows. Filter by rule, action type, age, € at stake. |
| Decision card | what it wants, which rule proposed it, the evidence, the cost, what happens if ignored. |
| Bulk decide | approve/dismiss a filtered set; confirm states blast radius per §3.2. |
| Done — change feed | `AdvertisingActionLog` + `CampaignBidHistory`, unified. |
| Provenance | rule → trigger → evidence → timestamp (Prism's model, deep-dives §6). |
| Undo | per class: **bids 24h · budgets and placements 7d · unknown 24h** (`rollbackWindowMsFor()`). Cross-check the flag against `previewRollbackOfAction` — a button the server then refuses is worse than no button. |
| Failures | real failures only. **Must exclude `DAILY_CAP_EXCEEDED`** or every rule reads as catastrophically broken (693,704 of 693,743 failures in 56 days were cap rows). |
| Why the queue looks like this | 185 pending / 1 applied is a fact about the operator loop, not the rules. Say it. |

Note: `/fleet/approvals` exists for the agent fleet — **different queue, different table**, but read
its decision-card shape first and reuse it.

### 4.6 Controls `/controls`

*The machine, not the rules: what may happen, and what runs.*

| section | purpose |
|---|---|
| The gate, in order | `ads-write-gate.ts`: halt → live-mode → connection → allowlist → value cap → daily cap. The order **is** the policy. |
| Allowlist | 82 of 216 campaigns. Default-deny — say so. Editable at the current scope. |
| Breaker | `maxActionsPerHour` = 500. `maxHourlySpendCentsEur` = **null** → €500/h default against a measured peak of €20.91. State the gap; the number is the operator's. |
| Halt | the kill switch and its history — **`resumeAutomation` NULLs `haltedAt`/`haltReason`**, so the only durable trace is the `Notification` row. |
| Protected terms | 10 rows. Moves off Negative Targeting. |
| Per-rule caps | executions/day, € per execution, € per day. |
| Engines | the **12** engines in `ads-control-room.service.ts:260+`: name, one-sentence "what", mode **and why** (usually an env flag), cron, last run, 7-day runs/failures, scope. |
| Engine warnings | "enabled but has not run in 7 days" · ">20% of runs failed" · "still evaluating while stopped — writes refused at the gate". |
| Halt behaviour | `gated` / `honours` / `exempt` per engine. **Suppression is deliberately exempt** — a halt must never freeze bids high. |
| Run now | manual trigger, honouring each rule's resolved autonomy. |

Engines: `rank-defend`, `dayparting`, `budget-enforce`, `budget-pools`, `auto-bid`, `auto-harvest`,
`anomaly-guard`, `tos-defense`, `write-delivery`, `coverage-engine`, `structural-reconcile`,
`fleet-analysts`. 🔴 **`tos-defense` — "the most direct SERP lever" — has never run**
(`NEXUS_ENABLE_TOS_DEFENSE_CRON` unset). Its consequence belongs on Coverage.

Absorbs: Control Room "Guardrails" + "Levers", `ProtectedTermsPanel`, ads-console engine buttons.

---

## Part 5 — Laws that apply to every page

1. **One subject, one page.** §4.0 is the contract. A second surface for a subject is a defect.
2. **Views are the scope bar, never a page.** If a proposal starts "a portfolio version of…", the
   answer is the bar.
3. **All four grains are first-class, and equally easy.** Campaign, portfolio, market and product
   line get the *same* control, the *same* number of clicks and the *same* confirmation shape. No
   grain is a special case, an advanced mode, or a different screen. A surface that makes one grain
   easier than another has picked a favourite the operator did not.
4. **Never offer a scope without stating its reach.** Portfolio scope reaches 33% of campaigns;
   product scope can reach 76 at once (§3.4). Every scope control shows the resolved campaign count
   before the action, and every action confirms with rows **and** €.
5. **Nothing keeps its own copy of market, scope or date.** One hook, one URL. That *is* the
   real-time-sync requirement — a single source that nothing shadows.
6. **Reuse the base; do not reskin it.** The operator likes this UI. `AdsPageHeader`, `AdsDataGrid`,
   `MarketSelect`, `DateRangePicker` and the `h10-*` cell markup stay. New pages are new *content* in
   the existing shell.
7. **Tooltip everything, but not with `title`.** WF.7 recorded a page whose entire teaching layer
   lived in 49 keyboard-unreachable `title` attributes. Use the glossary tooltip already shipped
   across the ten fleet pages — it meets WCAG 1.4.13.
8. **Never show a number without its destination.** Every count links to its rows.
9. **State what is empty and why.** `BudgetSchedule` 0, `KeywordRank` 0, 1-of-185 applied. A `0` that
   explains itself beats a `0` that reads as "nothing to do".
10. **Never render what no executor reads.** Grep for a reader before shipping a control (1.4).
11. **The ads console is deliberately LIGHT.** `.h10-shell` sets `color-scheme: light` with hard-coded
   hex; a `.dark` block produces dark cards in a permanently light shell. Portalled DS components
   escape the pin — [[reference_fleet_portal_light_pin]].
12. **Verify on prod, in a browser, before calling a section done.** Nine Control-Room defects
    survived a clean `tsc` and were only visible on screen.

---

## Part 6 — The retirement map

Retire only when the replacement is live and verified, one surface at a time.

| retire | when | to |
|---|---|---|
| `/marketing/ads-console/automation` (~16 tabs) | Automations + Controls live | 4.2, 4.6 |
| `…/rules-automation/control-room` (5 tabs) | Overview + Activity + Controls live | 4.1, 4.5, 4.6 |
| `AutomationDock` right rail | Automations ships scope binding | 4.2 |
| the five rule-type tabs | Automations ships the type filter | 4.2 |
| `placeholderSeeds.ts`, `ComingSoon` | immediately — unreachable now | — |

**Precedent:** ACR Stage 6 retired `/marketing/advertising` (101 files, ~13,900 lines) by redirecting
39 routes in `apps/web/next.config.js` — **not** with `redirect()` stubs, because "a tree of one-line
files is a tree that gets edited back into pages". Array order is load-bearing: literal paths must
precede parameterised ones.

**Confirm before the ads-console fold:** that work has been kept **local and unpushed** by standing
instruction. Folding it in means it ships.

---

## Part 7 — Sequence

The operator's method: define sections (this doc) → study one → build it → next.
**Each section study is its own session.**

0. **The scope bar (Part 3)** — first, because every page below reads it and retrofitting it into six
   finished pages costs six times as much. Mostly wiring: only product scope is a real build.
1. **Automations** (4.2) — the 51-automation gap, the biggest consolidation, and Part 2's defect.
   Start with the mode control: it is the only part of the current surface that is actively lying.
2. **Controls** (4.6) — what may happen must be legible before more rules are armed.
3. **Overview** (4.1) — needs 1 and 2 to have anything true to summarise.
4. **Coverage** (4.4) — the operator's named concern; opens by re-running the AIREON-vs-GALE
   comparison now that a comparable second family has matured.
5. **Activity** (4.5) — 185 rows waiting.
6. **Schedules** (4.3) — least broken today, so last.

---

## Part 8 — Open questions for the operator

Not blocking; answer when each study reaches them.

1. **Sidebar shape.** Rules & Automation has one chevron child today. Six pages need a decision —
   grouped children like `/fleet`, or in-page navigation only.
2. **`maxHourlySpendCentsEur` is null** → a €500/h default against a €20.91 peak hour. Your number.
3. **The 19 paused SB/SD campaigns** carry ~€1,040/day of standing budgets. Un-pausing changes spend.
4. **Campaign restructure** (4.4) — splitting one-ad-group-per-family into per-ASIN ad groups is the
   prerequisite for the lead-ASIN lever. Real work on live campaigns; needs an explicit decision.
5. **AIREON catalogue reconcile** (§3.3) — 16 advertised ASINs are missing from the Product
   catalogue, so the product lens cannot name them. Run the existing Amazon import first.

---

## Part 9 — Ledger

| item | status |
|---|---|
| Section map agreed — 6 pages, 1 scope bar | ✅ 2026-08-10 |
| Scope bar spec (Part 3) | ✅ **SHIPPED 2026-08-10** — `_shared/ads-scope.ts` + `ScopeBar.tsx`, 16 tests |
| **Portfolio scope reaches only 72/220 campaigns (33%)** (§3.4) | 🔴 open — state the reach in the UI |
| **Market scope is enforced but not settable** by the scope route (§3.4) | 🔴 open — add `scopeMarketplace` |
| **Product-line scope does not exist** — schema + evaluator + UI (§3.4) | 🔴 open — largest grain item |
| One ASIN can reach **76 campaigns** (§3.4) | 🔴 open — blast radius before every action |
| **🔴 The picker and the server use DIFFERENT date vocabularies** (§3.5) | ✅ contained — the bar uses the server's keys; `DateRangePicker`'s remain wrong for any caller that forwards them |
| `GET /advertising/campaigns` ignores `scopeGrain`/`scopeId` (§3.5) | 🔴 open — grain is narrowed client-side meanwhile |
| **🔴 8 of 51 rules were labelled "Alerts — informs, never writes" while able to write** (§4.2a) | ✅ fixed 2026-08-10 — `rule-category.ts`, 0 remain |
| Scope is mutually exclusive; "this portfolio in DE" needs 2 calls (§3.4) | 🔴 open — decide in the 4.2 study |
| `dryRun` mode control is inert (Part 2) | 🔴 open — fix in the Automations build |
| Date picker disabled + range never sent (1.6) | ✅ fixed — the bar sends `?preset=` on the server's vocabulary |
| `AdsPageHeader` ignores `AdsMarketplaceProvider` (1.6) | ✅ fixed for this section — the bar reads the provider; `showMarket={false}` retires the duplicate picker |
| Portfolio filter labels are raw IDs (1.6) | ✅ fixed — names from `/advertising/portfolios` |
| No product-grain surface anywhere in `/marketing/ads` (1.6) | 🔴 open — the one real build |
| 3 decorative columns on Apply Rules (1.4) | 🔴 open — delete |
| `placeholderSeeds.ts` / `ComingSoon` dead (1.5) | 🔴 open — delete |
| 9 action types with no home (1.1) | 🔴 open — the "Other" filter |
| All 51 rules account-scoped (1.1) | 🔴 open — surface in 4.2 |
| Multi-ASIN experiment confounded (4.4) | 🔴 open — re-run with matured AIREON |
| `tos-defense` has never run (4.6) | 🔴 open — operator flag decision |
| AIREON's 16 ASINs missing from catalogue (§3.3) | 🔴 open — blocks product scope |
| ads-console local-only constraint (Part 6) | ⚠ confirm before folding |

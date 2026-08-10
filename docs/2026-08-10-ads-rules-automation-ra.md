# RA — Rules & Automation, rebuilt as a section

**Date opened:** 2026-08-10
**Surface:** `/marketing/ads/rules-automation/*`
**Status:** 🔴 **ONE page, perfected** (operator, 2026-08-10) — the six-page plan is superseded; see Part 4. Automations shipped and is the last new route. The scope-bar attempt was **built and reverted** (§3.0): market, portfolio and campaign already exist as controls. No page rebuilt yet; Automations is next.
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
nine and not nineteen**. And the four "views" are not four pages *or* a new control — three of them
are filters this page already has (§3).

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
  ACR.7 drag-to-scope binding has never been used once. The grain the operator wants to act at is
  the grain no rule is bound to.
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

### 1.6 The scope-and-date substrate that already exists

Read this before adding any scope or date control anywhere in the section — most of it is already
built, which is exactly why the first attempt at a new bar was wrong (§3.0).

- **The date range is built end-to-end.** `ads-core/date-range.ts` `resolveRange()` supports 13
  presets — today, yesterday, last 7/14/30/90, WTD, MTD, last month, QTD, YTD, last year, lifetime,
  custom. `GET /advertising/campaigns` derives spend/sales **live from `AmazonAdsDailyPerformance`**
  whenever a range is passed, falling back to stored columns when it is not. **Rules & Automation
  passes `showDateRange={false}` and sends no range.** Wiring, not building.
- **`AdsPageHeader` owns date-range state in a local `useState`** ("the header owns the state for
  now") — per-page, not in the URL. Fine as-is; only lift it if a page needs to share it.
- **`AdsMarketplaceProvider` exists and is not consumed by the header.** Its own comment says it was
  built because "each analytics page kept its own local market filter derived from whichever
  campaigns happened to load, so nothing agreed with anything else" — and `AdsPageHeader` still takes
  a `markets: string[]` prop that Rules & Automation derives from whichever campaigns loaded. The fix
  was written and never plugged in.
- ~~**The Portfolio filter shows raw Amazon portfolio IDs.**~~ **Fixed 2026-08-10** — it now reads
  names from `/advertising/portfolios`. The only survivor of the reverted scope-bar work.
- **Portfolio is filtered client-side only.** `GET /advertising/campaigns` accepts `marketplace`,
  `status`, `search`, `limit` and the date params — no portfolio, no ASIN.
- **There is no product grain anywhere in `/marketing/ads`** — no filter, no page, no scope column.
  Product view exists only at `ads-console/products`, in the console being retired. **Of the four
  grains, product is the only real build, and it belongs in the existing filter row.**

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

## Part 3 — Scope and dates: use the filters that already exist ⭐

**Operator correction, 2026-08-10, after the first attempt shipped:**

> *"It is important for you to understand what already exists. I don't want any unnecessary
> building of something which already is there... the market scope and dates bar you added at the
> top... could be merged into the filters. Why are we creating the new stuff, which is completely
> unnecessary and also feeds the page with unnecessary information? ... Keep it simple, plain, and
> easy to understand, but it has to be extremely efficient."*

### 3.0 🔴 What I built, why it was wrong, and what was reverted

I added a `ScopeBar` — market · grain (account/portfolio/product/campaign) · dates · a reach line —
as a new row under the page header. **It was reverted in full** (`ScopeBar.tsx`, `ads-scope.ts` and
its test deleted; `AdsPageHeader` and `rules-automation.css` restored byte-identical). Two reasons,
both of which should have stopped it before it was written:

1. **Two of the four grains already existed as grid filters.** `AdsDataGrid` on this page already
   passes a `filters` array containing **Portfolio** and **Campaign** (plus Status, Campaign Type,
   Bid Automation) and a search box. The bar re-implemented Portfolio and Campaign as a second
   control sitting directly above the first. Market already existed too — in `AdsPageHeader`.
   [[feedback_check_ds_before_handrolling]] says exactly this: check what exists before
   hand-rolling. I did not.
2. **The date range could not change anything on that page.** The Apply Rules grid has **no metric
   columns at all** — Bid Rule, Target ACoS, Min/Max Bid, Bid Automation, Budget Rule. Nothing on
   it varies by date, so a date control there is furniture that costs a row of vertical space and
   invites the reader to believe the numbers moved.

**The rule this leaves behind: a control earns its place only if some pixel on the page changes
when you move it.** Before adding any control, name the thing on screen it changes. If you cannot,
it does not go there.

### 3.1 Where the four grains actually live — nothing new required

| grain | the control that already exists |
|---|---|
| Market | `AdsPageHeader`'s `MarketSelect` (its "all" sentinel is the string `'all'`) |
| Portfolio | the grid's `Portfolio` filter — **now shows names, not raw ids** (the one fix kept) |
| Campaign | the grid's `Campaign` filter + the search box |
| Product line | **does not exist anywhere** — see 3.2 |

**Acting at a grain uses what is already there too:** filter to the grain, select rows (the grid is
`selectable`), and use the selection bar — which already carries Automation · Assign Rule · Target
ACoS · Min/Max Bid. That is the existing mechanism and it needs no grain selector.

### 3.2 What is genuinely missing (measured, `scripts/_ra1-grain.mts`)

Only two things, and neither is a bar:

- **Product-line scope does not exist at any layer.** `RuleScope` is
  `{scopeMarketplace, scopePortfolioId, scopeCampaignId}`; `ContextIdentity` carries no ASIN; there
  is no product filter on the grid and no product page in `/marketing/ads`. The data path is ready
  — `AdProductAd` has 4,485 rows, **100% carry an ASIN**, 250 distinct, 93.9% linked to a PIM
  `Product`, and all 220 campaigns are reachable via `AdProductAd → AdGroup → Campaign`. When it is
  built it belongs as **another filter in the existing filter row**, not a new control.
  *Definition:* "product line" = the `Product` parent + its variations (`AdProductAd.productId`),
  **not** `Product.familyId` — `ProductFamily` is an Akeneo attribute template.
- **A date range, on pages that actually show metrics.** Not this one. It belongs on Automations
  (rule activity over a window) and Coverage, and it goes in the grid's existing `toolbarRight`
  slot — `AdsDataGrid` already exposes `toolbarLeft`/`toolbarRight` for precisely this.

### 3.3 🔴 The three measured facts that survive the revert

These were found while building the wrong thing and remain true and load-bearing:

1. **Portfolio is the weakest grain, not the strongest.** Only **72 of 220 campaigns carry a
   `portfolioId`** — a portfolio filter or a portfolio-scoped rule **cannot reach 148 campaigns,
   67% of the account**. Two of the twelve portfolios hold nothing. This also bounds the Family
   Cockpit, which is a per-portfolio view.
2. **Market scope is enforced but not settable.** `ruleMatchesScope()` honours `scopeMarketplace`
   strictly, but `PATCH /advertising/autonomy/rules/:id/scope` accepts **only**
   `scopePortfolioId`/`scopeCampaignId`; the market half lives on the other route. One feature,
   two routes.
3. **One ASIN can reach 76 campaigns.** 105 ASINs reach 6 each, 34 reach 17, several reach 70–76.
   Whenever product grain does arrive, an action taken at it must state its resolved campaign count
   *before* it runs.

### 3.4 🔴 The date-vocabulary trap — still true, and still a live hazard elsewhere

`_shell/DateRangePicker.tsx` exports `DATE_PRESETS`, and they are a **different vocabulary** from
`ads-core/date-range.ts`'s `RangePreset`, which is what the API resolves.

| picker | server |
|---|---|
| `today` `yesterday` | `today` `yesterday` |
| `latest7` `latest30` `latest60` | `last7` `last14` `last30` `last90` |
| `thisWeek` `thisMonth` `thisQuarter` | `wtd` `mtd` `qtd` |
| `lastWeek` `lastMonth` `lastQuarter` | `last_month` `ytd` `last_year` |
| `last3m` `last12m` `last18m` `last24m` | `lifetime` `custom` `window` |

**Only `today` and `yesterday` exist in both**, and `resolveRange`'s `default:` branch silently
falls back to `windowDays` (**7**). Forwarding a picker key returns **seven days of data under a
"Last 30 days" label**. Two further mismatches hide in the names that look shared: the picker's
`thisWeek` starts **Sunday** vs the server's Monday-ISO `wtd`, and the picker computes in
**browser-local** time while the server anchors to **Europe/Rome**.

Fifth two-vocabularies defect in this programme. **The law, for whoever adds the date control to
Automations:** *the server owns the date vocabulary; the client sends a key the server understands
and never its own computed dates for a preset; resolved dates for display come from the response's
own `range` echo, which `GET /advertising/campaigns` already returns as
`{ startDate, endDate, preset }`.*

⚠ **Still unfixed and outside this session's scope:** `DateRangePicker`'s presets remain wrong for
any *other* page that forwards them to the API. Owner: whoever owns the shared ads shell.

### 3.5 The sixth one, and it was mine

The `ScopeBar` used `''` for "every market"; `MarketSelect`'s sentinel is the string `'all'`. The
chip read "No market", and choosing All markets would have emitted `?marketplace=all` — filtering
to a marketplace of that literal name, **zero rows, no error**. Caught by measuring the rendered
control on prod, not by `tsc` and not by reading the code. Recorded because the lesson outlived the
code: **a module comment stating a law does not prevent its author from breaking it; measuring
does.**

## Part 4 — 🔴 SUPERSEDED 2026-08-10: ONE page, perfected — not six

**Operator decision, 2026-08-10, after the Automations page shipped:**

> *"Actually, I do not feel the need to make separate pages for everything. Let's actually perfect
> this one, which already exists."*

**This Part previously specified six routes. It no longer does.** No further pages are to be built.

### 4.0 What this means concretely

- **`/marketing/ads/rules-automation` stays the one surface**, navigated by the tab bar it already
  has. No new routes, and **no new sidebar children** — the ads rail keeps its single
  "Rules & Automation" line. This also settles Part 8's open question 1.
- **`…/automations` stays.** It is built, reachable as a routed tab, and working. It is the last
  new route in this programme, not the first of six.
- **The remaining subjects become better TABS or sections on that surface**, not routes.
- **The work is now mostly SUBTRACTIVE.** The tab bar currently has **11** tabs — one more than
  when this started — because Automations was added before the tabs it supersedes were retired.
  Getting it *down* is the job.

### 4.0a The subtraction list — measured, in value order

Nothing here requires building a new page. Each item removes noise or removes a lie.

| # | do this | why | effect |
|---|---|---|---|
| 1 | **Retire the 5 rule-type tabs** — Bid · Keyword Harvest · Negative Targeting · Budget · Placement | They are ONE component (`RuleListTab`) with a different `liveType` string, and the Automations tab's 8-family type filter already supersedes all five — including the 9 action types that had no tab home | **11 tabs → 6**, no new code |
| 2 | **Fix or delete the 3 decorative columns** on Apply Rules — Bid Rule, Min/Max Bid (local state only), Budget Rule (hard-coded `None` on all 220 campaigns) | A surface rendering what no executor reads. Only Target ACoS and Bid Automation reach the API | the landing tab stops lying |
| 3 | **Delete `tabs/placeholderSeeds.ts` and `ComingSoon`** | Unreachable — every tab key is handled by an explicit branch above them | dead code gone |
| 4 | **Make the empty tabs honest** — `BudgetSchedule` = 0 rows, `KeywordRank` = 0 rows | An empty grid that explains itself beats one that reads as broken; a tab with no data and no path to data should say so or go | 2 tabs stop pretending |
| 5 | **Fold the Control Room's 5 tabs in** (Today · Levers · Guardrails · Activity · Foresight) | It is a parallel automation surface reachable as a chevron child — the duplication the operator forbade | one surface, not two |

**Order matters:** #1 is the biggest win and costs nothing to build — but retire a tab only once
the Automations page has been used in anger, and per §0 of the locks doc, retirement happens in the
session that owns the surface.

### 4.0a-FINAL 🔒 The tab list, LOCKED 2026-08-10

Operator decisions: *"I do not feel the need to make separate pages for everything"* → cull first;
the survivors become pages. *"For the budget schedule, we can actually drop it."*

| today (11 tabs) | verdict | why |
|---|---|---|
| Apply Rules | **DROP** | Its only two working columns — Target ACoS, Bid Automation — already exist in the Ad Manager (`CampaignsGrid.tsx:229,231`), same tooltips, same `PATCH /campaigns/:id/automation`, plus bulk edit this tab lacks. Its other three columns persist nowhere. A strictly worse copy of an existing page. |
| **Automations** | **KEEP — make it the landing tab** | The 51 rules; it *is* the subject of the section. Already built. |
| Bid · Keyword Harvest · Negative Targeting · Budget · Placement | **DROP (5)** | One component (`RuleListTab`) + a `liveType` string. The Automations 8-family type filter supersedes all five *and* covers the 9 action types that had no tab home. Their Delete also lies — "cannot be undone", then removes the row from local state only. |
| **Rank & Dayparting** | **KEEP — untouched** | Done and good. Not reopened. |
| **Budget Schedules** | **KEEP** | Operator decision 2026-08-10 (reversing a same-day drop). ⚠ `BudgetSchedule` = **0 rows** — so it must say *why* it is empty and how to create one, not render a bare empty grid. |
| **Share of Voice** | **KEEP — absorbs Keyword Tracker** | Its `SovTrackerTab` already has a Rules \| Report toggle that can carry both. |
| Keyword Tracker | **MERGE** ↑ | Same component with a different `kind` prop; `KeywordRank` = **0 rows**. |
| Control Room (5 tabs, chevron child) | **BECOMES 2 pages** | Today+Foresight+Activity → **Activity**; Guardrails+Levers → **Controls**. Real subjects, wrong home. Retire the Control Room only in the session that owns it. |

**Final: 6 pages** — Automations · Rank & Dayparting · Budget Schedules · Share of Voice ·
Activity · Controls. Two are already built. **Seven surfaces are deleted and nothing new is
invented.**

`ProtectedTermsPanel` (the 10-term whitelist deciding what can never be negated) rides on the
Negative Targeting tab today and **must not vanish with it** → it belongs on **Controls**.

#### 🔴 `_schedule/` is shared with Rank Goals — never delete it wholesale

Recorded because a same-day decision to drop Budget Schedules was reversed, and the next person to
consider it needs this: **`_schedule/ScheduleBuilder.tsx` is imported by
`_rank/RankGoalBuilder.tsx`** — Rank Goals renders it for its classic style (`?style=classic`).
Deleting `_schedule/` would take down the one page the operator said not to touch.

With Budget Schedules KEPT, nothing under `_schedule/` is deleted at all, and the risk is moot for
now. If it is ever dropped again: only `_schedule/BudgetScheduleTab.tsx` is safe to remove (single
importer, `RulesAutomationClient.tsx:32`). `ScheduleBuilder.tsx`, `CampaignSection.tsx` and
`dayparting.css` must survive.

### 4.0b The boundary table — one subject, one owner

**Still the anti-duplication contract; the owners are now tabs and sections, not routes.** Before
adding anything, find its subject here. If it belongs elsewhere, link — do not rebuild.

| subject | the ONE owner |
|---|---|
| a rule's definition, mode, scope, caps | **Automations** tab |
| the catalogue of rules you could add | **Automations** tab |
| anything that fires on a clock | **Rank & Dayparting** tab (already routed) |
| who holds a keyword — us vs the market, and which of our ASINs | **Share of Voice** tab |
| a decision waiting for a human · the record of every change, and undo | one **Activity** tab (Pending \| Done) |
| a limit that refuses a write · an engine's mode, cron, health | one **Controls** tab |
| is automation working, and does it need me | **Apply Rules** (the landing tab), once #2 above is done |
| **which market / portfolio / product / campaign / dates** | **the existing header + grid filters — never a new control, never a page** |

The specs in 4.1–4.6 below still describe WHAT each subject must show. Read them as tab/section
specs. Ignore every route path in them.

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
| Scope binding | account / portfolio / campaign, via `PATCH /autonomy/rules/:id/scope`. All 51 are account-wide today. State the reach: a portfolio binding cannot touch 148 of 220 campaigns (§3.3). |
| Bulk actions | mode, enable/disable, delete — the confirm states the resolved rule and campaign count. |
| Simulate | run against real current data, show what it *would* do. ⚠ **The endpoint I originally cited here was a loaded gun** — it called the WHOLE evaluator and would have given the 8 writing AUTO rules a live tick. Rewritten 2026-08-10 (`52f3ec0e8`) to `simulateOneRule`; it can simulate a DISABLED rule, and it writes audit rows (nothing reaches Amazon). |
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

The two lenses the operator named are **filters on one page**, not two pages: the market lens answers
"how much of the shelf do we hold"; the product lens answers "which of our products is holding it".

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
| Bulk decide | approve/dismiss a filtered set; the confirm states the resolved row count and € at stake. |
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
2. **Views are FILTERS, never a page and never a new bar.** If a proposal starts "a portfolio
   version of…", the answer is the filter row that already exists. Before adding any control, name
   the pixel that changes when you move it; if you cannot, it does not go there (§3.0).
3. **All four grains are first-class, and equally easy.** Campaign, portfolio, market and product
   line get the *same* control, the *same* number of clicks and the *same* confirmation shape. No
   grain is a special case, an advanced mode, or a different screen. A surface that makes one grain
   easier than another has picked a favourite the operator did not.
4. **Never offer a scope without stating its reach.** Portfolio scope reaches 33% of campaigns;
   product scope can reach 76 at once (§3.3). Every scope control shows the resolved campaign count
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

**⚠ This table is a MAP, not a licence.** Operator directive 2026-08-10: a session works one
page and does not reach into others. Each surface below is retired **in the session that owns
it**, after its replacement is live and verified — never as a side-effect of building the
replacement. See §0 of the locks doc.

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

**Superseded by Part 4.** No further pages. The order of work is the subtraction list in §4.0a:
retire the five rule-type tabs → fix/delete the three decorative columns → delete the dead code →
make the empty tabs honest → fold in the Control Room. Open defects (market scope not settable,
product-line scope absent, the rule catalogue not on the page) are finished on the Automations tab,
not on new routes.

## Part 8 — Open questions for the operator

Not blocking; answer when each study reaches them.

1. ~~**Sidebar shape.**~~ **RESOLVED 2026-08-10** — no new pages, so no new rail children. The ads
   rail keeps its single "Rules & Automation" line and the tab bar stays the section's navigation.
   One navigation tree, which is what the rail's own comment already required.
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
| Section map agreed — 6 pages | ✅ 2026-08-10 |
| **Automations page (4.2) SHIPPED** — census, 8-family type filter, mode dial, scope binding, conflicts, bulk mode+delete, graduation board, rule drawer | ✅ 2026-08-10 |
| `POST …/simulate` ran the whole evaluator (would have armed 8 AUTO rules) | ✅ fixed `52f3ec0e8` |
| **Refusals: a stored `30` read as a 3000% ACoS target; `campaignIds` array silently ignored** | ✅ both refuse + warn on the rule, 2026-08-10 |
| **Market scope: still enforced but NOT settable** — the scope route takes only portfolio+campaign | 🔴 **open — next unit** |
| **Product-line scope: does not exist at any layer** (schema + evaluator + UI) | 🔴 **open — needs approval** |
| Adding a rule: the 86-template catalogue + builder are not on the page yet | 🔴 open |
| Ads action handlers register only under `if (adsCronOn)` (`index.ts:1435`) | 🔴 open — app-wide boot ordering, own change |
| **Automations page (4.2) BUILT + PROD-VERIFIED 2026-08-10** — `…/rules-automation/automations` | ✅ census · type filter · rule list · mode notches · scope+reach · caps · conflicts · history · drawer. **0 contrast fails across 494 text elements, 0px dead space, no horizontal overflow.** 25 pure tests. Nothing retired |
| **The mode control's WRITE path — VERIFIED on prod 2026-08-10** | ✅ tested on `__E_probe_KEYWORD_HIGH_ACOS__` (OFF · `alert_operator` only · ceiling AUTO · 0 evaluations ever), so no setting of it could reach Amazon. Off→Observe→Auto→Off all landed, each with its toast; census tracked every move; **restored to Off**. Residual: its `autonomyLevel` column is now `OFF` rather than `PROPOSE`-while-disabled — resolved mode identical |
| **The census's own point, demonstrated live** | ✅ moving an alert-only rule to AUTO left **"Writing to Amazon" at 8** and moved the notify-only tally 1→2. Counting AUTO rules would have read 9 and implied new exposure |
| **The 409 ceiling refusal — VERIFIED** | ✅ `PATCH …/autonomy/rules/:id {level:'AUTO'}` on "Wasted keyword instant negate" → **409 `above_ceiling`**, `blockedBy:['add_negative_exact']`, reason on `message` (which is what the client reads), level unchanged at PROPOSE |
| **Scope binding — VERIFIED** | ✅ account→portfolio `xyz`→account. Server returned the resolved NAME; mode untouched; row cell updated. Reach varies correctly: IT_Gale 9 · DE_Gale 6 · IT AIREON 11 · **xyz 0** |
| **Bulk DELETE — VERIFIED on prod 2026-08-10** | ✅ tested on two throwaway rules created for it. Server count **53 → 51**, both ids absent from the board, `GET` each → **404**, banner "2 deleted". That is the precise bug the rule-type tabs had: they said "this cannot be undone" and removed the row from local state only |
| **🔴 `bid_to_target_acos` — `targetAcos` is a FRACTION, and one rule stores a percent** | ✅ guarded 2026-08-10. Measured (`_ra8-targetacos-units.mts`): of 7 rules carrying the action, 6 store a fraction or nothing; **"AIREON — Target ACoS bidding" stores `30`**, read as a **3000%** target. **Nothing lost — it is PROPOSE, 0 write-capable rules carry one, and the action has applied 0 bids in 60 days.** The hazard was one click: the ceiling admits that rule to AUTO. The handler now **refuses** an out-of-range value rather than coercing it (coercion would be a guess about intent that moves money), and the drawer names it on the rule |
| **🔴 Same rule: `campaignIds` is silently ignored** | ✅ guarded — the handler reads `campaignId` (singular); that rule stores `campaignIds`, an array of **11**, so a rule an operator scoped to eleven campaigns would have optimised the whole account. Refused rather than run account-wide. Supporting the array is a real bid-engine change and belongs in its own study |
| **Why 29 rules store `PROPOSE` while disabled** | ✅ answered — it is the column default. Creating a rule through `POST /advertising/automation-rules` yields `enabled:false, dryRun:true, autonomyLevel:'PROPOSE'`. So "off" has always been carried by `enabled`, and the dial's `OFF` value is genuinely new to this account |
| **🔴 `GET /advertising/portfolios` returns `portfolios`, NOT `items`** | ✅ fixed 2026-08-10 in both callers. Consequence: **the ledger's "✅ Portfolio filter shows names not raw ids" never worked** — `items` was always undefined so `portfolioNames` stayed `{}`. That fix was verified by reading the diff, and portfolio scope could not be bound at all until this |
| **🔴 The ads action handlers register only when ads crons are on** | 🔴 open — `automation-action-handlers.ts` mutates `ACTION_HANDLERS` at module load and its ONLY importer is `index.ts:1435`, inside `if (adsCronOn)`. On an instance without ads crons every ads action resolves to `Unknown action type: …`. `simulateOneRule` now imports it itself; nothing else does |
| **🔴 `POST /automation-rules/:id/simulate` — FIXED 2026-08-10** | ✅ `simulateOneRule(ruleId)`: one rule, one trigger's contexts, same scope enforcement, `forceDryRun` + `isTestRun`. Verified on two OFF rules — all `DRY_RUN`, 0 SUCCESS/PARTIAL, 0 outbound, 0 suggestions, both rules unmodified. Reports `reachedAmazon:false` and `wroteAuditRows:N` because it DOES write execution rows |
| **`/automation-rules/:id/test` no longer arms a rule to test it** | ✅ new additive `ignoreEnabled` on `EvaluateRuleArgs` replaces its write-`enabled:true`-and-write-it-back trick, which raced a 15-minute cron and left the rule armed on a crash |
| **Part 2's inert `dryRun` control — measured caveat** | ⚠ 0 of 51 rows currently disagree with `resolveAutonomy`, because `PATCH /autonomy/rules/:id` writes both columns. The console's chips are accurate *today*; the toggle is a **latent** lie that desyncs the row on first click |
| 🔴 **`POST /automation-rules/:id/simulate` is NOT a simulation** (`advertising-intel.routes.ts:68`) | 🔴 open — it `void`s `runAdvertisingRuleEvaluatorOnce()`: the whole evaluator, all 21 triggers, no forced dry-run. Clicking it on one PROPOSE rule lets all 8 writing AUTO rules write. Deployed; **nothing calls it**. Do not wire a Simulate button until fixed |
| **The plan's Type filter buckets were wrong** (4.2) | ✅ corrected — measured `harvest 0` and `other 0`, but **`guard 9`** incl. both pause-everything rules. Shipped with the server's 8-family taxonomy; a 6-bucket list would have folded 13 rules (25% of the account) into "Other" and re-hidden what 4.2a fixed |
| **The client tab map and the server taxonomy disagree** | 🔴 open (7th two-vocabularies defect) — the tab bar reads "Keyword Harvest 5" while `rule-category.ts` says harvest 0; the map covers **13** action types, not 14, and 17 of 51 rules have no tab home |
| **`AdsPageHeader` has no `showMarket`** — the locks-doc §2 note is stale | ✅ corrected — it went with the scope-bar revert (`7db1a4ed6`). Automations wires the market switch to filter rows instead; a rule with no market scope acts everywhere and survives narrowing |
| **Whole-run rollback is a flat 24h, not per-action** | ✅ corrected — `rollbackByExecutionId` (`rollback.service.ts:424`) uses the flat constant. `RuleListTab`'s hard-coded 24h is RIGHT; `rollbackWindowMsFor` governs the single-change Change Log only. No repair owed |
| **`AdsRuleSuggestion` is 203 pending, not 185** | ⚠ oldest is 50 days old (2026-06-20). **`status` is lowercase** `'pending'`/`'applied'` — a query written `'PENDING'` returns 0 |
| **One AUTO rule fails 100% of its runs** — "Reduce bids on ACOS spike", 0 success / 644 failed in 30d | 🔴 open — surfaced on Automations. Note `RuleImpactStrip` already names a *different* worst rule by failed ACTION RESULTS (2,132, "New-to-brand optimizer"); two grains, two answers. Reconcile in the Overview study |
| **The daily cap, not the rule, governs reach** | ✅ surfaced — "Profit-native bid optimisation" wrote 3,793 and was refused **19,423** times in 30d. `week.capped` added to `/autonomy/rules`, kept out of `failed` |
| **`bid_to_target_acos` stores `targetAcos` in TWO units** — 0.3 on one rule, 30 on another | 🔴 open, potential 100× money bug. The page prints it raw ("as stored") rather than picking a unit. **Check what the executor reads** |
| **Two doors to AUTO with different policies** | 🔴 open — `PATCH /autonomy/rules/:id` checks the ceiling only; `/graduate` checks the ceiling + 8 evidence checks. Of the 7 PROPOSE rules the ceiling admits, the notch arms **2** that `/graduate` would refuse |
| `OBSERVE` has never been used; no row stores `OFF` as a level | ⚠ 29 "off" rules all store `autonomyLevel='PROPOSE'` with `enabled=false`. Operator question in the RA.AUTO report |
| `POST /automation-rules/:id/test` momentarily flips `enabled=true` on a disabled rule | 🔴 open (low) — `advertising.routes.ts:6047-6056`, restored in a `finally`, against a 15-min evaluator cron |
| `placeholderSeeds.ts` / `ComingSoon` dead (1.5) | 🔴 open — confirmed unreachable, but it is **three** files: `tabs/NegativeTargetingTab.tsx` is also dead and is the second importer of `TAB_RULES` |
| Scope bar | ❌ **built and REVERTED 2026-08-10** (§3.0) — duplicated the grid's Portfolio/Campaign filters; its date control changed nothing on a grid with no metric columns |
| **Portfolio scope reaches only 72/220 campaigns (33%)** (§3.4) | 🔴 open — state the reach in the UI |
| **Market scope is enforced but not settable** by the scope route (§3.4) | 🔴 open — add `scopeMarketplace` |
| **Product-line scope does not exist** — schema + evaluator + UI (§3.4) | 🔴 open — largest grain item |
| One ASIN can reach **76 campaigns** (§3.4) | 🔴 open — blast radius before every action |
| **🔴 `DateRangePicker` and the server use DIFFERENT date vocabularies** (§3.4) | 🔴 open — a picker key returns 7 days under any label. Owner: the shared ads shell |
| **A control earns its place only if a pixel changes when you move it** (§3.0) | ✅ law recorded |
| **🔴 8 of 51 rules were labelled "Alerts — informs, never writes" while able to write** (§4.2a) | ✅ fixed 2026-08-10 — `rule-category.ts`, 0 remain |
| Scope is mutually exclusive; "this portfolio in DE" needs 2 calls (§3.4) | 🔴 open — decide in the 4.2 study |
| `dryRun` mode control is inert (Part 2) | 🔴 open — fix in the Automations build |
| Date range on Apply Rules | ✅ **correctly absent** — that grid has no metric columns. Belongs on Automations/Coverage, in the grid's existing `toolbarRight` |
| `AdsPageHeader` ignores `AdsMarketplaceProvider` (1.6) | 🔴 open — pre-existing, out of this session's scope |
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

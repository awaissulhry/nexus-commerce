# BS — Budget Schedules: study 4 of 11

*Rules & Automation, tab-by-tab, right to left.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_bs-study.mts` and `_bs-study2.mts`.

---

## 0 · The one-sentence version

The tab has **0 schedules**, its executor has run **4,863 times over nothing**, **five separate
systems** in this codebase can move a daily budget and the two that actually do are elsewhere — and
**Amazon offers a native budget-rules API, with hours-of-day scheduling, that this codebase does not
call once.**

---

## 1 · What the tab is, and every wire behind it

```
?tab=budget-schedules
└── RulesAutomationClient.tsx:370  <BudgetScheduleTab />        ← NOT a RuleListTab
    └── _schedule/BudgetScheduleTab.tsx
        ├── "Hourly Campaign Performance" card  (two metric pickers)
        └── AdsDataGrid: Name · Type · Days · Auto Refill · Start/End · Exclude Start/End
            └── GET /advertising/budget-schedules   → BudgetSchedule where kind='BUDGET'

Create   builder/budget-schedule → _schedule/ScheduleBuilder.tsx
         → POST /advertising/budget-schedules      (real, persisting)
Model    BudgetSchedule (schema.prisma:14529)
Executor jobs/ad-budget-schedule.job.ts — every 15 min
```

**This is the only tab of the four studied so far with a complete, honest, working stack.** The
model is well designed, the routes are real CRUD, the builder persists, and the executor is
carefully written.

### The model, and it is a good one

| field | purpose |
|---|---|
| `type` | `CAMPAIGN_BUDGET` (hourly €) or `BUDGET_MULTIPLIER` (daily ×) |
| `campaigns` | `[{ id, name, marketplace, dailyBudget }]` |
| `windows` | `[{ day: 0-6, start: "HH:MM", end: "HH:MM", adj, value }]` |
| `timezone` | default `Europe/Rome` |
| `startDate` / `endDate` / `neverExpire` / `excludeDates` | flighting + blackout ranges |
| `autoRefill` | |
| `lastApplied` | per-campaign churn guard |

The executor (`ad-budget-schedule.job.ts`) resolves the active weekday+time window in the
schedule's timezone, applies `set €` / `+%` / `−%` / `×multiplier` to the campaign's **base**
budget, clamps to Amazon's €1 floor, and — importantly — **restores the base budget outside every
window and outside the date range**. `computeBudget()` is a pure, exported, testable function.

**Nothing is wrong with this tab's engineering. Everything is wrong with its situation.**

---

## 2 · The measured state

| | |
|---|---|
| `BudgetSchedule` rows | **0** (enabled: 0) |
| `ad-budget-schedule` cron runs | **4,863** — last 2026-08-11 00:30 |

A 15-minute cron has been iterating an empty list since it shipped. It is not broken; it has
nothing to do. And it is not alone:

| cron | runs | rows it operates on |
|---|---|---|
| `ad-budget-schedule` | 4,863 | **0** BudgetSchedule |
| `budget-pool-rebalance` | 7,990 | **0** BudgetPool · 0 allocations · 0 rebalances |
| `ad-autopilot` | 4,554 | **0** AutopilotPlan |
| `ad-budget-enforce` | 2,264 | **5** AdBudgetPlan ✅ |

🔴 **Three engines, 17,407 runs, zero objects.** That is not a budget-schedule problem; it is a
pattern. Each shipped with its surface and its cron, and none was ever given a row.

---

## 3 · 🔴 The chart card is a constant

*(Carried from the RA.TABS work; still live, unchanged.)*

`BudgetScheduleTab` renders **"Hourly data is not available for this marketplace"** unconditionally.
It never calls `GET /advertising/budget-schedules/hourly-performance` — which exists, works, and
reads `AmazonAdsHourlyPerformance`. Its two metric pickers change nothing.

The message is not a measurement; it is a hard-coded string. And it is wrong twice: the data exists,
and the endpoint it would call **ignores the `marketplace` parameter entirely** — so even the
"for this marketplace" clause is unsupportable.

**This is the exact signal an operator needs to build a budget schedule, sitting behind a card that
says it does not exist.**

---

## 4 · 🔴 Five systems can move a daily budget

| # | system | object | state | executor | actually writing? |
|---|---|---|---|---|---|
| 1 | **Budget Schedules** (this tab) | `BudgetSchedule` | **0 rows** | `ad-budget-schedule` (15 min) | no |
| 2 | **Budget rules** (the Budget tab) | `AutomationRule` × `adjust_ad_budget` | **6 rules, 3 live** | rule evaluator | **YES** |
| 3 | **Budget Manager** | `AdBudgetPlan` | **5 plans, 4 live** | `ad-budget-enforce` (30 min) | **YES** |
| 4 | **Budget pools** | `BudgetPool` | **0 rows** | `budget-pool-rebalance` | no |
| 5 | **Autopilot** (budget module) | `AutopilotPlan` | **0 rows** | `ad-autopilot` | no |

*(plus `ad-rank-defend`, which suppresses bid raises when a campaign is over budget — indirect, but
it reads the same state.)*

### The two that are live

**Budget rules — 3 of 6 enabled, and two write autonomously:**

| rule | enabled | level | executions | last run |
|---|---|---|---|---|
| Trim budget on weak ACOS | ✓ | **AUTO** | 1,318 | 2026-08-09 |
| Campaign ACOS rebalance (cut + scale) | ✓ | **AUTO** | 905 | 2026-08-11 |
| Scale budget-capped winners | ✓ | PROPOSE | 2,382 | 2026-08-11 |
| Boost budget on profitable campaigns · Trim budget on weak ACOS (dup) · Scale budget on ROAS winners | ✗ | PROPOSE | 0 | never |

**Budget Manager — monthly caps with pacing, and it is the real budget system in this account:**

| market | month | monthly budget | autoPacing | stopOverSpend |
|---|---|---|---|---|
| IT | 2026-08 | €2,220.00 | ✓ | ✓ |
| DE | 2026-08 | €1,445.00 | ✓ | ✓ |
| ES | 2026-08 | €210.00 | ✓ | ✓ |
| FR | 2026-08 | €125.00 | ✓ | ✓ |
| IT | 2026-07 | €0.00 | ✗ | ✗ |

**€4,000/month committed, ≈€129/day, paced and stop-over-spend protected.**

**So the account already has budget governance — a monthly cap per market with pacing — and it lives
on a different page.** A Budget Schedules tab that does not show it is describing a different
account from the one the operator runs.

⚠️ Note the duplicate: two rules named *"Trim budget on weak ACOS"*, one AUTO-and-writing, one off.
Same defect class as the duplicated "Hold top rank" rules in study 3.

---

## 5 · The business case, measured — and it is weaker than it looks

### Daily budgets: more than half sit on the floor

86 ENABLED campaigns, **€318.59/day committed**:

| min | p25 | **median** | p75 | max |
|---|---|---|---|---|
| €1.00 | €1.00 | **€1.00** | €2.84 | €80.00 |

🔴 **The median live campaign's daily budget is Amazon's €1 minimum.** A budget schedule modulates a
daily budget — and on more than half of the live account there is nothing to modulate downward and
very little upward. This is consistent with the standing "suppress with low bids, never pause"
policy, but it means **budget scheduling is a lever for the top quartile only**: realistically the
~21 campaigns above €2.84/day, and mostly the handful near €80.

### Hour of day: a real spread, on partial data

Europe/Rome, 60 days, from `AmazonAdsHourlyPerformance`:

| best 6 hours | ROAS | spend | | worst 6 hours | ROAS | spend |
|---|---|---|---|---|---|---|
| 04:00 | 17.19 | €4.72 | | 10:00 | **0.00** | €79.51 |
| 01:00 | 7.81 | €32.62 | | 00:00 | **0.00** | €62.14 |
| 05:00 | 6.87 | €12.53 | | 07:00 | **0.00** | €42.86 |
| 02:00 | 6.14 | €14.02 | | 06:00 | **0.00** | €18.47 |
| 09:00 | 5.39 | €63.32 | | 03:00 | **0.00** | €8.03 |
| 13:00 | 5.16 | €89.39 | | 08:00 | 0.49 | €50.24 |

- Best 6 hours: **10.6%** of spend. Worst 6 hours: **12.8%** of spend.
- **Five hours returned literally zero on €211** of spend over 60 days.

**Three caveats, and they matter:**

1. **Coverage is partial.** The hourly table holds ≈€2,043 of spend for the window; the placement
   report holds €3,595.66 for the same window. **Hourly covers ~57% of measured spend** — it is not
   the whole account.
2. **Hour-grain ROAS is noisy.** 04:00's 17.19× rests on €4.72 — one or two orders. Treat the
   *shape* (night and early morning underperform, midday converts) as the signal, not any single
   hour's number.
3. **`sales7d` is attributed to the click hour**, so a click at 23:00 converting on day 3 credits
   23:00. That is the correct convention for dayparting but it is not "sales that happened at 23:00".

**The honest conclusion: there is a real diurnal shape worth exploiting, worth roughly €200–400/year
at current spend, and the correct first tool for it is dayparting on bids — which already exists and
runs — not a budget schedule on campaigns that are mostly pinned at €1.**

---

## 6 · 🔴 Amazon has this feature natively, and we call it zero times

`grep -a` across `apps/api/src` for `budgetRule|budget-rules|budgetRules`: **no matches.**

Amazon Ads offers **budget rules** as a first-class object on Sponsored Products and Sponsored
Brands, in two forms:

| type | what it does |
|---|---|
| **Schedule-based** | raise budget by a % for a date range or a named event (Prime Day, Black Friday) — **and, since Amazon added it, for specific hours of the day** |
| **Performance-based** | raise budget when the campaign hits a threshold on **ROAS, CTR or conversion rate** |

They are available **through the Amazon Ads console *and* the Amazon Ads API**, and Amazon
explicitly pairs hours-of-day budget rules with its hourly performance reporting — the same signal
in §5.

### This is the central strategic question for this tab

|  | our `BudgetSchedule` | Amazon's native budget rules |
|---|---|---|
| survives our downtime | ✗ — a missed cron is a missed window | ✓ — Amazon enforces it |
| visible in Seller Central | ✗ | ✓ |
| audit trail in our system | ✓ | ✗ (we'd have to read it back) |
| arbitrary logic | ✓ any adjustment we can express | ✗ Amazon's shapes only |
| cross-campaign / portfolio | ✓ one schedule, many campaigns | ✗ per campaign |
| **base-budget restoration** | ✓ our executor restores it | ✓ Amazon reverts automatically |
| risk if it breaks | budget stuck at a modified value | none — Amazon owns it |

**The failure mode that decides it:** if `ad-budget-schedule` misses its 15-minute tick during a
Black Friday ramp — Railway restart, deploy, crash — the budget simply does not rise. Amazon's
native rule does not have that failure mode. For *events*, native wins. For *anything Amazon can't
express*, ours wins. A serious implementation uses both and says which is which.

---

## 7 · How the industry does this

### 7.1 Enterprise

| platform | budget capability | notable |
|---|---|---|
| **Pacvue** | rules for **budget pacing** and dayparting; **Dynamic Dayparting** makes automated **hourly bid adjustments** — raising in historically high-CVR hours, cutting in low-CVR hours; **Pacvue Agent** (Apr 2026) does natural-language→AMC-SQL with *governed campaign and budget execution* | targets $50k+/month advertisers; 90+ marketplace integrations |
| **Skai** | **Budget Navigator** — daily bid *and* budget algorithms across 100+ publishers, plus Automated Actions | budget as a portfolio-level algorithm, not a per-campaign schedule |
| **CommerceIQ** | **automated bid and budget pacing** driven by 50+ shelf-aware signals; role-specific AI agents | budget responds to shelf state (stock, Buy Box), not just performance |
| **Quartile / Teikametrics** | ML owns budget allocation inside a goal | black-box |

### 7.2 Specialist / mid-market

| platform | budget capability |
|---|---|
| **Off Hours** | built entirely around Amazon's native budget rules — *"scheduled budget changes that restore themselves"*; the whole product is a better UI over the native object |
| **Sellozo** | dayparting, automated bidding, bulk changes; simple, thin past ~20 ASINs |
| **Scale Insights** | 12 stackable algorithms, ASIN-level, rules-based |
| **SellerMetrics · Zon.Tools · Xmars** | bid, budget **and placement multipliers by hour or day** |

### 7.3 The pattern across all of them

1. **Pacing beats scheduling.** The enterprise tier's primary budget object is a *monthly or
   campaign-flight target with pacing* — spend-to-date vs plan, projected end-of-period, and
   automatic throttling. Fixed hourly windows are the junior feature. **We already have the senior
   one** (`AdBudgetPlan`, 4 live plans, autoPacing + stopOverSpend) and it is on another page.
2. **Budget and bid dayparting are the same product.** Nobody ships a budget schedule without an
   hourly bid schedule; Pacvue's Dynamic Dayparting is bid-side, and the sellers' tools do both from
   one grid. **Splitting them across two tabs — Budget Schedules and Rank & Dayparting — is our
   invention, not the industry's.**
3. **Events are a first-class object.** Prime Day / Black Friday get named, dated, pre-staged
   budget plans that revert. Our `startDate`/`endDate`/`excludeDates` can express this; nothing
   surfaces it as "an event".
4. **Forecast before commit.** Pacvue's Bid Explorer, Skai's Budget Navigator: show what the change
   would cost before it is made.
5. **Pacing is shown as a burn-down.** Month-to-date vs plan, projected finish, days remaining —
   one chart every enterprise tool has and we render nowhere.

### 7.4 The UI shape they converge on

- A **pacing header**: month budget · spent to date · projected finish · over/under, per market.
- A **7×24 grid** (day × hour) with colour by the chosen metric — the same grid used for bids and
  budgets, with the schedule drawn *on top of* the performance it is reacting to.
- **Events as chips** on a calendar strip, pre-stageable and reverting.
- **Every scheduled change shown as a diff** — base → scheduled → live now.
- **One list of everything that can move a budget**, with precedence stated.

---

## 8 · What could be implemented, cheapest first

### Tier 0 — stop lying, start showing *(hours)*
- **Wire the hourly chart.** The endpoint exists, the data exists, the card claims neither.
- **State the empty grid honestly**: 0 schedules because none has been created, not because
  anything is broken. Say what a budget schedule is and what it is *not* (it is not the monthly cap
  — that is Budget Manager).
- **Show the Budget Manager plans on this tab.** €4,000/month across four markets, paced, is the
  budget truth of this account. A budget tab that hides it is the wrong map.

### Tier 1 — make the account legible *(days)*
- **One "what can move this budget" panel.** Five systems, two live, precedence undefined. Today
  `Trim budget on weak ACOS` (AUTO) and `ad-budget-enforce` pacing can both write the same campaign
  in the same hour and **nothing states who wins**.
- **Retire or seed the three dark engines.** 17,407 cron runs over zero rows. Either give
  `BudgetPool` and `AutopilotPlan` a purpose or stop the crons.
- **Deduplicate the budget rules** — two identically-named "Trim budget on weak ACOS".

### Tier 2 — the strategic decision
- **Adopt Amazon's native budget rules for events**, keep ours for logic Amazon cannot express.
  Native survives our downtime and shows in Seller Central; ours gives cross-campaign scope and a
  local audit trail. This is a genuine both/and, and it needs deciding before more is built here.
- **Merge Budget Schedules and Rank & Dayparting into one time-based surface.** Every competitor
  treats bid-by-hour and budget-by-hour as one product. We have them as two tabs, one with 16 live
  rank groups and one with zero schedules.

### Tier 3 — pacing as the headline
Promote `AdBudgetPlan` from a separate page to the top of this tab: burn-down per market, projected
finish, and the throttle that `stopOverSpend` already applies. That is what the enterprise tier
leads with, and we have the object already.

---

## 9 · How this tab is *supposed* to be

> **One question: is my money going out at the right rate, at the right hours, and will it last the
> month?**

- **Pacing first**: per market, month budget · spent · projected · days left. From `AdBudgetPlan`,
  which is live.
- **A 7×24 grid** showing what each hour actually returns, with the schedule drawn on top of it —
  and the same grid serving bids and budget.
- **Events** as named, dated, revertible objects.
- **One precedence list** naming every system that can move a budget and who wins.
- **Native vs local marked per rule**, so an operator knows which changes survive our downtime.
- **Empty states that distinguish** "nobody made one" from "it ran and did nothing" from "it broke".

---

## 10 · What I need from you

1. **Do you want budget schedules at all?** Median live budget is €1.00 and the monthly caps are
   already paced elsewhere. The honest read is that this tab's *object* is a minor lever and its
   *subject* — where the money goes and how fast — is being handled on another page.
2. **Native Amazon budget rules for events — adopt?** It is the only version that survives a
   Railway restart during Black Friday.
3. **Merge with Rank & Dayparting?** The industry treats hour-based bid and budget control as one
   product. You reversed a tab merge before, so I am asking rather than proposing.
4. **The three dark engines** — 17,407 runs over zero rows. Seed them or stop them?
5. **Precedence**: when a budget rule on AUTO and the pacing engine disagree about a campaign's
   budget in the same hour, which should win?

---

## Appendix — scripts

| script | measures |
|---|---|
| `_bs-study.mts` | BudgetSchedule rows · every budget-moving cron · the 6 budget rules · pools · Autopilot · daily-budget distribution · hour-of-day ROAS |
| `_bs-study2.mts` | Budget Manager plans (monthly caps, pacing flags) · hourly-table coverage vs the placement report |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [A complete guide to budget rules — Amazon Ads](https://advertising.amazon.com/library/guides/budget-rules) ·
  [Hours of day now available for schedule-based budget rules — Amazon Ads](https://advertising.amazon.com/resources/whats-new/hours-of-day-available-for-schedule-based-budget-rules) ·
  [Sponsored Products budget basics and best practices — Amazon Ads](https://advertising.amazon.com/library/guides/sponsored-products-budget-best-practices)
- [Amazon Ads Budget Rules: scheduled budget changes that restore themselves — Off Hours](https://www.off-hours.app/budget-rules) ·
  [Budget rules guide — Off Hours](https://www.off-hours.app/blog/amazon-ads-budget-rules-guide)
- [How to automate Amazon PPC budget — Adbrew](https://adbrew.io/blog/automate-amazon-ppc-budget)
- [Retail Media Automation 2026: platform comparison — Osmos](https://www.osmos.ai/blog/automation-auctions-the-science-of-scalable-retail-media)
- [Pacvue vs Skai (Kenshoo) — Atom11](https://www.atom11.co/blog/pacvue-vs-kenshoo-skai) ·
  [Pacvue platform](https://pacvue.com/)
- [Top Pacvue alternatives — SellerMate](https://www.sellermate.ai/post/top-10-pacvue-alternatives-for-amazon-sellers)

# BS — Budget Schedules as its own page

*Page study 4 of 11, Rules & Automation. Follows the tab study
[2026-08-11-bs-budget-schedules-study.md](2026-08-11-bs-budget-schedules-study.md), which this
document **corrects in four places**.*

**Read-only study. Nothing was changed, nothing was committed, no application code was touched.**

Measured on production 2026-08-11 with `apps/api/scripts/_bs-page-{state,hourly,binding,units}.mts`.

---

## 0 · The one-sentence version

The tab's object has never held a row and its executor has run 4,909 times over nothing — but the
reason is not that budget is a weak lever here: **a third of all campaign-days spend their entire
daily budget**, the two live budget writers **oscillate against each other on the same campaign
inside the same hour**, Amazon's native hours-of-day budget rule **is not available in any of this
account's four markets**, and the hourly signal a budget schedule would be built on **only became
real eight days ago**.

---

## 1 · (a) What exists — every wire

```
?tab=budget-schedules                                    ← NOT routed; index page, local state
└── _shared/tabs.tsx:51                { key: 'budget-schedules', label: 'Budget Schedules' }
└── RulesAutomationClient.tsx:371      <BudgetScheduleTab />        ← receives NO props
    └── _schedule/BudgetScheduleTab.tsx
        ├── :74   "Hourly Campaign Performance" card — two MetricSelects + a hard-coded string
        └── :94   AdsDataGrid  ← GET /advertising/budget-schedules

Create/edit  builder/budget-schedule → _schedule/ScheduleBuilder.tsx  (shared with dayparting)
             _schedule/scheduleConfig.ts   type radios · adjustment catalog · TIME_OPTIONS
             _schedule/CampaignSection.tsx · DaypartingChart · DaypartingHeatmap · heatMetrics.ts
Model        BudgetSchedule                     schema.prisma:14532
Routes       advertising.routes.ts:7892 GET list · :7904 GET one · :7911 POST
                                   :7926 PATCH · :7936 DELETE · :7943 GET hourly-performance
Executor     jobs/ad-budget-schedule.job.ts     cron */15, registered index.ts:1480
Write path   updateCampaignWithSync({ patch:{dailyBudget}, applyImmediately:true })
CSS          rules-automation.css:511-519       .h10-sb-listchart · .h10-sb-eye
```

All four routes are **deployed and RBAC-mapped** — `GET` unauthenticated returns 401, not 404, on
`budget-schedules`, `budget-schedules/hourly-performance`, `dayparting/heatmap` and
`budget-manager`. Nothing in Tier 0 below needs a backend deploy.

### Measured state, today

| | |
|---|---|
| `BudgetSchedule` rows | **0** — verified with an unfiltered `count()`, not a `where` clause |
| control (same client, same connection) | `Campaign` = 220 rows |
| `ad-budget-schedule` runs | **4,909** · 3 failed · last 2026-08-11 12:00 · `evaluated=0 changed=0` |

*(The tab study reported 4,863. The delta is 46 further ticks over nothing in nine hours.)*

---

## 2 · (b) How it works — and six things that do not

`computeBudget(base, type, adj, value)` (`ad-budget-schedule.job.ts:52`) is pure, exported and
correct: `set €` / `+%` / `−%` / `×multiplier` against a base, clamped up to Amazon's €1 floor. The
tick resolves the schedule's date range (`dateActive`), then the active weekday+time window
(`activeWindow`), applies the adjustment, and **restores the base budget outside every window**.
`lastApplied` guards churn. That is the right shape, and it is the same shape the leading specialist
product ships (§6.2).

Six defects sit around it. All six are read off the source; none required a row to exist.

### 2.1 🔴 The 23:00 hour cannot be scheduled, and nothing says so

`TIME_OPTIONS` (`scheduleConfig.ts:105`) offers `00:00 … 23:00` for **both** `start` and `end`.
The executor matches `minutes >= start && minutes < end`. Therefore:

- the latest coverable minute is **22:59** — hour 23 is unreachable by any window;
- a window that crosses midnight (`22:00 → 02:00`) evaluates `minutes >= 1320 && minutes < 120` and
  is **never** active;
- `00:00 → 23:00` reads as "all day" and silently drops one hour in twenty-four.

Measured cost of that hour: **€97.73 = 5.7% of all hourly-tracked spend**, the account's
**fourth-largest spend hour** (§4.2). The builder's own preview grid uses the same `h < hh(end)`
convention, so it agrees with the bug and shows nothing wrong.

### 2.2 🔴 "Exclude Dates" is a boolean pretending to be a date range, end to end

| layer | what it is |
|---|---|
| `ScheduleBuilder.tsx:124` | `useState(false)` — a checkbox |
| `:275` | sent as `excludeDates: false` |
| routes `:7920` | `(b.excludeDates as object) ?? []` — `false` is not nullish, so **`false` is stored** |
| `schema.prisma:14547` | `excludeDates Json @default("[]") // [{start,end}] blackout ranges` |
| executor `:46` | `Array.isArray(...) ? ... : []` — a boolean falls through to no blackouts |
| list route `:7899` | `excludeStart: null, excludeEnd: null` — **hard-coded nulls** |
| grid `BudgetScheduleTab.tsx:54-55` | two columns, "Exclude Start Date" / "Exclude End Date" |

Four layers disagree about what this field is, and two grid columns can never show anything but
`—`. There is no UI anywhere to choose a blackout range.

### 2.3 🔴 "Auto Refill" has exactly zero readers

`grep` across `apps/api/src`, `apps/web/src` and the schema finds `autoRefill` in four places: the
Prisma column, and three lines of `BudgetScheduleTab.tsx` that display it. The builder never sends
it, so it is always `false`, and no engine would do anything if it were `true`. A column that is
permanently "Off" and would mean nothing if it were "On".

### 2.4 🔴 The churn guard is checked against intent, not reality

```ts
// ad-budget-schedule.job.ts:79-81
nextLast[c.id] = { budget: target, at: … }     // recorded BEFORE the write is attempted
if (last[c.id]?.budget === target) continue    // memo check …
if (Number(campaign.dailyBudget ?? 0) === target) continue   // … BEFORE the reality check
```

Two consequences:

1. **A failed write is memoised as applied.** The `catch` at `:86` logs and moves on, but
   `nextLast` already claims success, and `lastApplied` is overwritten wholesale at `:88`. The
   window is then silently skipped until the target changes.
2. **The base-budget restore is a one-shot, not an invariant.** Once the schedule has written the
   base once, any *other* writer may move that budget and the schedule will not notice, because
   the memo still says "target already applied". The tab study's "the executor restores the base
   budget outside every window" is true only until something else touches the field — and on this
   account two other engines touch it constantly (§3).

### 2.5 A missed tick is a missed window, and the base snapshot goes stale

`node-cron` in-process, `*/15`, no catch-up, `running` overlap guard. A Railway restart across a
boundary shifts the transition by up to 15 minutes. That is tolerable for a *daily* budget.

The sharper problem is the base. `campaigns` stores `[{id, name, marketplace, adProduct,
dailyBudget}]` **snapshotted at creation** (`ScheduleBuilder.tsx:273`), and the executor prefers
that snapshot over the live value (`:76`). A schedule created before the August ratchet would
today keep restoring campaigns to their pre-ratchet budgets — undoing both the rules and the pacer
— and there is no way to refresh the snapshot short of re-picking every campaign.

### 2.6 No ceiling, no scope, no audit row

- `computeBudget` clamps only the **floor**. `set €500` or `+1000%` is accepted. The object has no
  maximum of any kind, and no notion of a spend cap. This is the direct opposite of the
  per-scope ceiling in §5 of the brief.
- Scope is a **frozen campaign array**. `BudgetSchedule` has no `marketplace`, no portfolio, no
  product. Meanwhile `automation-rule-scope.ts` already implements all four grains
  (`scopeMarketplace` · `scopePortfolioId` · `scopeCampaignId` · `scopeProductIds`) for
  `AutomationRule`, with a test. **The four-grain model exists in this repo and this object cannot
  use it.**
- POST / PATCH / DELETE write **no `AdvertisingActionLog` row**. The schedule's own edit history is
  unrecorded — unlike the rank side, which has `RankScheduleVersion` for exactly this reason.

### 2.7 Three UI honesty defects in 130 lines

| line | what it does |
|---|---|
| `:42` | `catch { /* backend not live yet — empty */ }` — an API 500 renders "No schedules created" |
| `:67` | `DELETE … .catch(() => {})` then removes the row locally regardless — a failed delete looks like a success, with no confirmation step |
| `:120` | the create button is labelled **"Rule"**, on a page whose noun is "Schedule" |

### 2.8 🔴 The chart card is a constant — confirmed, and worse than reported

`BudgetScheduleTab.tsx:86-89` renders *"Hourly data is not available for this marketplace."*
**unconditionally**. Confirmed verbatim in source. Three things make it worse than the tab study said:

1. `GET /advertising/budget-schedules/hourly-performance` exists, is deployed, and destructures
   `marketplace` **without ever using it** (`:7944-7963`) — so the sentence's final clause could
   not be true even if the sentence were computed.
2. That endpoint already returns `hasData: rows.length > 0`. The honest state is one field away.
3. **The same builder, one click away, renders the real chart.** `ScheduleBuilder.tsx:388-397`
   fetches `GET /advertising/dayparting/heatmap` and draws either a line chart or a **7×24
   heatmap**, for budget schedules as well as dayparting ones. The list tab is the only surface
   claiming the data does not exist.

`/advertising/dayparting/heatmap` is also the better of the two endpoints by a distance: whole-week
windows so every weekday has equal samples, excludes the in-progress day, computes boundaries from
the **database** clock, whitelists the timezone, filters by marketplace *and* by campaign set, and
returns `coverage: { daysWithData, firstDay, lastDay }`. `hourly-performance` does none of that.
**Retire `hourly-performance`; it is the inferior duplicate.**

---

## 3 · 🔴 Precedence: the two live writers oscillate, measured

Five systems can move a daily budget (tab study §4; unchanged — `BudgetSchedule` 0, `BudgetPool` 0,
`AutopilotPlan` 0, budget rules and `AdBudgetPlan` live). What is new is that the collision is no
longer hypothetical.

**2,387 `AD_BUDGET_UPDATE` rows.** Writers, last 14 days:

| writer | rows |
|---|---|
| `automation:budget-manager-cron` (the pacer, `ad-budget-enforce`) | **1,165** |
| `automation:cmpujoff…` (a budget rule) | 642 |
| `automation:cmps335ls…` (a budget rule) | 574 |
| `user:anonymous` | 5 |

`amazonResponseStatus`: SUCCESS 1,898 · **PENDING 488**. Direction: **505 increases, 1,881 decreases.**

### The audit chain is broken 41% of the time

Walking each campaign's writes in order, `payloadBefore` should equal the previous write's
`payloadAfter`. **1,367 consecutive pairs agree; 937 do not.** The disagreements are not random:

```
GALE EXACT IT   08-06T04:15  after=4.18  →  04:30  before=3.34   (rule  → pacer)
GALE EXACT IT   08-06T05:00  after=4.18  →  05:15  before=3.34   (rule  → rule)
GALE EXACT IT   08-06T06:00  after=4.18  →  06:15  before=3.34   (rule  → rule)
GALE EXACT IT   08-06T06:15  after=2.67  →  06:30  before=3.34   (rule  → pacer)
```

Two engines writing the same campaign every 15 and 30 minutes, **each reading a value the other has
already superseded**, neither converging. This is the bud study's PENDING-write loop (488 rows)
seen from the other side: it is not one engine repeating itself, it is two engines fighting, and
the audit log records both sides of the fight without ever naming a winner.

Scale: **226 campaign-hours in 14 days had two different systems writing the same campaign**, across
3 distinct campaigns and 12 campaign-days — concentrated on 2026-08-05 to 08-09. Narrow, dated, and
entirely real.

### The pacer's storm was an early-month projection artefact

`ad-budget-enforce` is **LIVE**, not dry-run — its own cron output says so
(`plans=4 … (LIVE)`), which confirms `NEXUS_BUDGET_ENFORCE_APPLY=1` in production. It is
*corrective*: it writes only when `projected > cap`, where
`projected = mtd + (mtd / daysElapsed) × remainingDays`.

On day 4 of a month that formula multiplies a 4-day sample by 7.75. Every budget write it made
happened between 08-04 and 08-09; from 08-10 it has written **once**. Today, day 11:

| market | cap | MTD | pct | expected | forecast | status |
|---|---|---|---|---|---|---|
| IT | €2,220.00 | €721.49 | 32.5% | 35.5% | €2,033.29 | on-track |
| DE | €1,445.00 | €317.59 | 22.0% | 35.5% | €895.03 | under |
| ES | €210.00 | €70.02 | 33.3% | 35.5% | €197.33 | on-track |
| FR | €125.00 | €43.64 | 34.9% | 35.5% | €122.99 | on-track |
| **total** | **€4,000.00** | **€1,152.74** | **28.8%** | | **€3,248.64** | |

Nothing is projected over. `budgetChanges=0` on every recent tick. **The entire 2,387-row budget
storm was six days of an unstable early-month projection, and it has stopped on its own.**

### What that costs, in budget headroom

`ads-budget-enforce.service.ts:79` records a measurement taken on 2026-08-05: *"this account
carries ~EUR 1,956/day of budget against ~EUR 92/day of spend"*. Today the same figure is
**€318.57/day across 86 ENABLED campaigns** — median €1.00, 58 at the floor, 25 above €2, 17 above
€5. The six-day storm removed roughly **€1,637/day of budget headroom**.

---

## 4 · (e) Is this page's own object worth keeping?

Two measurements decide it, and both correct the earlier study.

### 4.1 🔴 Correction: budget *does* bind — on a third of all campaign-days

The tab study concluded *"on more than half of the live account there is nothing to modulate"*.
That reading came from comparing budgets to nothing. Comparing **spend to the budget actually in
force that day** — reconstructed by walking `AdvertisingActionLog` backwards from each campaign's
current value — over the 8 complete days where hourly data is trustworthy:

| | campaign-days | share |
|---|---|---|
| with spend | 361 | |
| spend ≥ **100%** of the budget in force | **118** | **32.7%** |
| spend ≥ 90% | 132 | 36.6% |
| spend ≥ 50% | 204 | 56.5% |
| campaigns hitting ≥90% at least once | **34 of 63** | |

Nine campaigns were budget-bound on 6 of 8 days. Peak ratios run 110–237% — Amazon permits a day to
exceed its daily budget and settles the average over the month, so >100% is normal, not an error.

⚠️ **A methodology note, because the first version of this measurement was wrong and plausible.**
`AdvertisingActionLog.payload*.dailyBudget` is in **euros**, not cents — verified in
`_bs-page-units.mts`: for 77 of 83 campaigns the newest logged value equals `Campaign.dailyBudget`
exactly, and for **0** does it equal it after dividing by 100. Assuming cents produced ratios of
12,000–23,000% that looked like a spectacular finding. The unit check is the only reason this
section says 32.7% and not something absurd.

*(Related, and worth one line: for 4 MOSS campaigns the last logged write says €1 while
`Campaign.dailyBudget` reads €10. **The audit log is not a complete record of budget changes.**)*

### 4.2 …but the binding does not arrive early in the day

An hourly budget schedule only earns its keep when a campaign **runs dry before the day is over**.
Bucketing each campaign-day by the last Rome hour in which it spent anything:

| last hour with spend | budget-bound days | other days |
|---|---|---|
| 00:00–02:00 | 0 | 10 |
| 06:00–11:00 | **11** | 14 |
| 12:00–17:00 | 45 | 47 |
| 18:00–20:00 | 24 | 38 |
| 21:00–23:00 | 52 | 120 |
| **total** | **132** | **229** |

**11 campaign-days out of 361 — 3.0% — went quiet before noon while at their budget.** The rest
delivered to the end of the day *and* exceeded budget, because Amazon's daily budget is a rate
governor it overshoots, not a shutter that closes.

### The verdict

**The subject of this page is pacing and level, not scheduling. Say so.**

- Budget binds on **a third** of campaign-days → the money question is *how big is this budget*,
  which is the Budget tab and the pacer.
- Budget binds *early* on **3%** of campaign-days → the money question this page's object answers
  is real but small.
- The object itself should **stay** — but demoted from headline to instrument. It is the only thing
  in the system that can express "spend differently between 18:00 and 23:00 on Fridays", it is the
  only local mechanism that can *decrease* a budget on a schedule (Amazon's cannot — §5), and it is
  the correct home for events. It should not be the first thing on the page, and the page should
  not be named after it.

---

## 5 · (c) Native vs local — the strategic call

### 🔴 Correction: the native hours-of-day rule does not exist in our markets

Amazon's own availability notice, checked today:

| capability | markets | ad products |
|---|---|---|
| **Budget rules** (schedule-based by date/event, and performance-based) | US, CA, MX, BR, **DE, ES, FR, IT**, NL, UK, SA, AE, AU, IN, JP, SG | **Sponsored Products only** |
| **Hours-of-day** inside a schedule-based budget rule | **US, CA, UK, IN, JP only** | — |

Xavia sells on **IT, DE, ES, FR**. The tab study recommended adopting native budget rules partly
*because* Amazon had added hours of day. **That flavour is geo-blocked for every market we run in.**

Three further native limits, all confirmed on Amazon's pages:

- **Budget rules can only increase.** They cannot decrease, cannot pause, cannot reallocate.
- **Sponsored Products only** — nothing for SB or SD.
- **Performance-based rules require a minimum daily budget of $10.** This account has **17
  campaigns above €5/day** and a median of €1.00. Performance-based native rules are effectively
  out of reach here as well.

### The recommended split

| shape | owner | why |
|---|---|---|
| **Event raise on SP** — "+50% for Black Friday, IT, these campaigns" | **Amazon native** | Survives a Railway restart, visible in Seller Central, reverts itself, available in IT/DE/ES/FR |
| **Any decrease on a schedule** | **local** | Amazon cannot decrease at all |
| **Hour-of-day shaping** | **local — no alternative** | Not available in our markets |
| **SB / SD** | **local** | Native is SP-only |
| **Cross-campaign / market / portfolio scope** | **local** | Native is per campaign |
| **Performance-triggered raise on a >€10/day campaign** | native *if* the campaign qualifies | 17 candidates today |

**The failure mode named in the brief still decides the event case, and it decides it for native.**
If `ad-budget-schedule` misses a tick during a Black Friday ramp, the budget simply does not rise.
Amazon's rule has no such failure mode. Everything *else* on this list, native cannot do at all.

**How both appear on one page:** one list, one column headed *"Enforced by"* with two values —
`Amazon` or `Nexus` — and one sentence under the native rows: *"Amazon applies this even if Nexus
is offline; it can only raise, and only on Sponsored Products."* Native rules would be read back
from the Ads API (nothing in this codebase calls the budget-rules endpoints today: `grep -a` for
`budgetRule|budget-rules|budgetRules` across `apps/api/src` still returns nothing) and shown
read-only until we choose to author them.

---

## 6 · (g) Industry research — features and interface

### 6.1 The economic tier we are actually in

| product | price | who for |
|---|---|---|
| **Off Hours** | **$149/mo flat, per seller** | any Amazon seller wanting scheduled budget/bid windows |
| **Scale Insights** | $78–$688/mo by ASIN count; **every tier includes every algorithm** | established sellers who will learn a system |
| **SellerMetrics** | flat fee, mid-market | sellers scaling past manual |
| **Adbrew** | **$799/mo minimum**, or % of spend | brands/agencies at **$30k+/mo** ad spend |
| **Pacvue · Skai · CommerceIQ** | enterprise | **$50k+/mo** advertisers |

Xavia spends **~€105–118/day ≈ €3,500/mo**. Pacvue and Adbrew are not our peer group in either
price or data volume. **Off Hours and Scale Insights are.** Build to that bar, steal from the
enterprise tier only where it costs nothing.

### 6.2 Off Hours is the closest thing to a direct competitor, and it validates our engine

Its entire pitch is the gap this page sits in: *"Amazon's native budget rules only go up. They can
raise a budget on a schedule… but they can't lower one."* Its mechanics, verbatim from its own
page: select campaigns or portfolios → define a recurring window ("Friday 6pm to Monday 6am") →
fixed amount or percentage → **it records the original budget before modifying, restores it exactly
when the window ends, and checks every 15 minutes**. Changes are fully logged: *"read exactly what
moved, when, and back to what."*

**That is, line for line, `ad-budget-schedule.job.ts`.** Our executor already does the thing a
$149/month product is sold for. What it lacks is the log, the honest surface, and a row.

Its four rule types are worth noting as a taxonomy: **dayparting · budget rules · event rules ·
performance rules** — budget and bid scheduling live in **one product**, and events are their own
first-class type.

### 6.3 The field, on budget specifically

| platform | how budget is modelled | interface |
|---|---|---|
| **Pacvue** | pacing + flighting + out-of-budget controls; reallocates to top performers; **Budget Calendar** — a monthly envelope split across individual days | a **calendar view**: pick profile/tag, take Pacvue's suggestion from the **last three months** or author a custom curve, and *"budget allocation suggestions populate in the calendar below"*; day-of-week and day-of-month purchase-behaviour insights alongside |
| **Skai** | **Budget Navigator** — a *plan* (budget + KPI goal) over **portfolio groups** spanning campaigns, publishers, geos, products; daily bid *and* budget algorithms | a **what-if forecast curve** — "visualize potential return on any given budget" — regenerated daily, plus continuous pacing feedback and **automatic alerts on spend-pacing deviation** |
| **CommerceIQ** | bid/budget pacing off 50+ shelf-aware signals (stock, Buy Box) | budget reacts to retail state, not only ad metrics |
| **Adbrew** | hourly CVR/ACoS/clicks/spend by hour **and** day of week; *Adbrew Intelligence* generates a dayparting strategy that sets **bid and budget adjustments together** | one hourly data view driving both levers |
| **Scale Insights** | two of eleven algorithms are **Daily Budget** (by day and performance) and **Dayparting** (bids *and* budgets by hour) | "functional but not polished"; steep learning curve; every feature in every tier |
| **SellerMetrics · Zon.Tools · Xmars** | bid, budget and placement multipliers by hour/day | one grid drives all three |
| **Quartile · Teikametrics · Perpetua** | ML owns allocation inside a goal | no knobs |

### 6.4 The three patterns, tested against us

1. **Pacing beats scheduling.** ✅ Confirmed, and we already own the senior object: `AdBudgetPlan`
   with `analyzeBudgetManager()` computing spend-to-date, calendar-weighted `expectedPct`,
   `forecastSpendCents`, `projectedOverspend`, per-market daily sparklines and totals — served at
   `GET /advertising/budget-manager`, 401-verified deployed. **The enterprise-tier pacing header is
   a fetch, not a build.**
2. **Budget and bid dayparting are one product.** ✅ Off Hours, Adbrew, Scale Insights, SellerMetrics
   all confirm it. We have them as two tabs. See §8 for the boundary I want rather than a merge.
3. **Events are first-class.** ✅ Off Hours ships them as their own rule type; Amazon ships named
   shopping events. We can express one with `startDate`/`endDate` and nothing surfaces it as an
   event. Note the rank side already learned this lesson — `RankScheduleEvent`'s schema comment
   says events exist so *"an all-out Black Friday plan"* does not *"quietly run through December"*.

### 6.5 🔴 One thing worth stealing that we must NOT steal

Pacvue's Dynamic Dayparting and Adbrew's hourly strategy both key on **CVR by hour**. The rank
study recommended adopting it. **This account cannot support it.**

Over the eight complete weeks of hourly data: **3,964 clicks and 49 attributed orders**, across 168
day×hour cells. That is 23.6 clicks and **0.29 orders per cell**. A 7×24 grid coloured by CVR or
ROAS at this volume is noise rendered as insight — exactly the trap the tab study flagged when
04:00's "17.19× ROAS" turned out to rest on €4.72.

**Colour the grid by spend or clicks. Show orders as a count, never as a rate, until the sample
supports it.** This is the one place where copying the enterprise tier would make the page worse.

---

## 7 · The hourly signal — read this before designing any grid

### 🔴 Correction: coverage is not 57%, and the shape of the failure matters more than the number

The tab study compared hourly spend to the *placement* report over 60 rolling days and got ~57%.
Against the right denominator — `AmazonAdsDailyPerformance` at `entityType='CAMPAIGN'`, over the
same 8 complete weeks — hourly holds **€1,725.07 of €5,865.63 = 29.4%**.

But the aggregate is the wrong summary. Day by day:

| period | hours/day | campaigns | coverage |
|---|---|---|---|
| 2026-06-16 → 07-02 | 24 | 17–27 | **31–50%** — a partial subscription |
| **2026-07-03 → 08-02** | 3–20 | 2–14 | **0%** — rows exist, `costMicros` is **€0.00** for a month |
| **2026-08-03 → 08-10** | 24 | 57–65 | **85%, then 99–101%** |

**The hourly feed was dead for a month and came back on 2026-08-03.** Since then it is complete.
This is the same defect class as the rank study's stale SQP feed, and worse in one way: the dead
month is not missing, it is **present and zero**. Nothing distinguishes "this hour had no spend"
from "the feed was down".

Two consequences that bind the design:

- **A default 8-week window paints six dead weeks into every cell.** `GET /dayparting/heatmap`
  defaults to `weeks=8`. It returns `coverage.daysWithData` — **the surface must read it and say
  what it is looking at.**
- **A 7×24 grid is not yet supportable.** Eight complete days is **1.14 samples per weekday**. An
  hour-of-day view over 8 days is honest; a day×hour view is not. If the feed stays up, 7×24
  becomes defensible around **late September 2026**. Build the 24-cell view now and the 7×24 when
  the data earns it.

*(Also noted: `AmazonAdsDailyPerformance` has a hole on 2026-08-09 — €0.00 against €131.78 in the
hourly table. The two feeds disagree; neither is a complete account of the other.)*

### Hour of day, on the honest window

Rome, 8 complete weeks, `AmazonAdsHourlyPerformance`. Total €1,725.07 spend, €4,116.23 sales,
ROAS 2.39, **49 orders**.

| | hours | spend | share |
|---|---|---|---|
| evening peak | 19:00–23:00 | €581.70 | **33.7%** |
| afternoon | 14:00–18:00 | €541.19 | 31.4% |
| morning build | 09:00–13:00 | €380.02 | 22.0% |
| overnight | 00:00–08:00 | €222.16 | 12.9% |

Largest single hour **22:00 (€136.89, 7.9%)**, then 21:00, 19:00 and 15:00. Six hours (00, 03, 06,
07, 10, 18) show **zero attributed sales on €276.55 = 16.0% of spend** — but with 49 orders total,
those zeros are as likely to be sampling as signal, and `sales7d` credits the **click** hour.

**This is a different shape from the tab study's table**, which was computed over 60 rolling days —
i.e. mostly over the dead month — and reported an overnight-heavy ROAS pattern. Prefer this one,
and treat even this one as provisional until the sample grows.

---

## 8 · (h) Requirements on the shared layer

Stated as constraints. I am not designing any of these; ten other sessions are looking at the same
substrate and a twelfth pass reconciles us.

1. **Market must reach this page.** `<BudgetScheduleTab />` is rendered with **no props**
   (`RulesAutomationClient.tsx:371`) and the scope bar's market lives in a local
   `useState('all')` at `:93`. This page needs the selected market in its data fetch — every
   number on it (pacing, hourly, binding) is per-market — and it needs that selection to survive
   navigation and be linkable.
2. **A tab must be able to become a page.** `tabs.tsx` already models this
   (`routed: true` → `/rules-automation/<key>`); `dayparting` and `automations` have made the move.
   This page needs one additive `routed: true` and its own route. No other change to the bar.
3. **A URL contract this page can express.** It needs to encode, at minimum: market · time window
   (in **weeks**, matching the heatmap endpoint's grain) · the selected metric · which schedule or
   plan is open in the inspector. Every view the operator can reach must be linkable.
4. **Real-time sync must carry budget writes.** Three engines write `Campaign.dailyBudget` on 15-
   and 30-minute cycles. This page shows those values and their history; a stale render is a wrong
   render. It needs to be told when an `AD_BUDGET_UPDATE` lands.
5. **A shared "who wins" contract.** Precedence between the pacer, the budget rules and a budget
   schedule is not this page's to invent — but this page is where it becomes visible. It needs a
   single answer it can display, and that answer must be the same one the Budget page (tab 6) and
   the Automations page display.
6. **The four-grain scope model must be usable by objects other than `AutomationRule`.**
   `automation-rule-scope.ts` implements market/portfolio/campaign/product with a test. This page's
   object has a frozen campaign array instead. The operator has said all four grains matter
   equally.
7. **A change log the page can query.** `AdvertisingActionLog` holds 45,945 rows back to
   2026-05-31 and 2,387 `AD_BUDGET_UPDATE` rows back to 2026-06-23 — enough history for the live
   change log the brief asks for. It needs a per-entity, per-actionType read with `payloadBefore`/
   `payloadAfter` and `evidence`, filterable by market. Field names are `userId` /
   `payloadBefore` / `payloadAfter`.
8. **An empty-state vocabulary shared across all eleven pages.** The brief asks for three distinct
   states — "nobody made one" / "it ran and did nothing" / "it broke". Every page needs the same
   three, worded the same way; `_shared/NoDataIllus.tsx` exists and currently expresses one.
9. **`AdsDataGrid` must support a non-null-able column contract.** Two of this grid's seven columns
   are hard-coded `null` at the route (§2.2). Whatever the shared grid does about columns that can
   never render, it should do it visibly rather than printing `—` forever.

### The boundary with tabs 5 and 6

Session 5 owns **Rank & Dayparting** and session 6 owns **Budget**. I am not proposing a merge —
the operator reversed one before, and the industry evidence (§6.4) is an argument, not a mandate.
What I want instead:

| shared thing | who should own it | why |
|---|---|---|
| **The hourly cube** (`/dayparting/heatmap` + `heatMetrics.ts` + `DaypartingHeatmap`) | **one owner, used by both** | It already is shared — `_schedule/` serves both builders. Two copies of "what does 15:00 return" would drift the first time someone fixes a formula, which is exactly why `heatMetrics.ts` was extracted. |
| **The window grammar** (day + start + end, `TIME_OPTIONS`) | one owner | The 23:00 hole (§2.1) is in `scheduleConfig.ts`, shared by both schedule kinds. Fixing it for budget fixes it for dayparting. |
| **"Which engine owns this campaign this hour"** | neither page — the shared precedence contract | Rank writes bids, budget rules and the pacer write budgets, and `ad-rank-defend` reads budget state to suppress raises. Three pages need one answer. |
| **Budget level and budget *rules*** | **tab 6, not me** | 58 campaigns at the floor, the compounding trim, the missing cooldown — all theirs. I show the consequence; they own the cause. ⚠ **Corrected 2026-08-16 (BUD.8): 56 of the 58 were floored by `budget-manager-cron` — THIS tab's engine — in single `€100 → €1` writes on 2026-08-05, not by tab 6's trim. The cause is largely mine, not theirs.** See the [BUD.8 record](2026-08-16-bud-8-armed.md). |
| **Monthly caps and pacing** (`AdBudgetPlan`) | **me, on this page** | See §9. It is currently on `/marketing/ads/budget-manager`, a different section entirely. |

---

## 9 · (d) How this page is supposed to be

> **One question: is my money going out at the right rate, at the right hours, and will it last the
> month?**

Name the page for the question, not for the object. **Budget Pacing & Schedules.**

**1 · Pacing header — the page leads with this.** Per market: month budget · spent to date ·
expected-to-date · projected finish · days left · on-track/over/under. Straight from
`GET /advertising/budget-manager`, which computes all of it today. The account's real budget
governance — €4,000/month across four markets, paced, stop-over-spend armed — currently lives on
another page in another section, and a budget page that hides it is describing a different account
from the one the operator runs.

**2 · What is binding, right now.** The single most decision-relevant table this page can show:
campaigns whose spend is at or over the budget in force, with the budget, the spend, the ratio and
the last hour they delivered. 34 campaigns qualified in the last 8 days. This is the row that turns
"€1.00" from a number into a decision.

**3 · The hour-of-day view, wired — with its coverage stated on it.** 24 cells today, coloured by
**spend**, `coverage.daysWithData` printed on the card: *"8 complete days, 2026-08-03 → 08-10.
Earlier data is not usable — the hourly feed returned zero for the month before that."* The 7×24
grid arrives when the sample does. The schedule, when one exists, is drawn on top of the
performance it is reacting to.

**4 · Schedules as instruments, below the fold.** Flat grid, filters, minimal teaching text — with
the two dead columns gone, the 23:00 hole fixed, a real base (live, not snapshotted), a per-schedule
**ceiling**, and every row saying whether Amazon or Nexus enforces it.

**5 · Events as named, dated, revertible objects.** Prime Day, Black Friday, a product launch.
Native where native can do it (SP, increase, IT/DE/ES/FR), local where it cannot. Pre-stageable,
with a visible revert date — the `RankScheduleEvent` lesson, applied to budget.

**6 · One precedence list.** Every system that can move a daily budget, its state, its cadence, and
who wins. Today: the pacer writes every 30 minutes, two rules write every 15, and §3 shows them
overwriting each other's values inside the same hour with nothing arbitrating.

**7 · Spend ceilings per scope,** as the brief requires — market · product line · portfolio ·
campaign — with **refuse-further-spend** at the cap, not throttle. `AdBudgetPlan` is already
per-market and per-month with `stopOverSpend`; the other three grains do not exist for budget, and
`automation-rule-scope.ts` shows what they should look like. **`AdBudgetPlan` belongs on this
page** — it is the closest thing in the system to what was asked for.

**8 · Honest empty states,** distinguishing *nobody made one* (0 rows, cron green) from *it ran and
did nothing* (rows exist, `changed=0`) from *it broke* (`status=FAILED`, or the fetch threw). All
three are computable today; the tab currently renders the first for all three.

**9 · A live change log.** 2,387 budget writes exist and none is visible anywhere in the UI. Per
campaign: who moved it, from what, to what, why, and whether Amazon has accepted it yet (488 rows
are still `PENDING`).

**10 · Notifications** per the brief: daily digest · failures and refusals as *refusals*, never as
failures · the change log live on the page · immediate for anything big.

---

## 10 · (f) The three dark engines — recommendation

| cron | runs | rows | last output |
|---|---|---|---|
| `ad-budget-schedule` | **4,909** | 0 `BudgetSchedule` | `evaluated=0 changed=0` |
| `budget-pool-rebalance` | **8,036** | 0 `BudgetPool` | `pools=0 rebalanced=0 shift=0¢ 443ms` |
| `ad-autopilot` | **4,600** | 0 `AutopilotPlan` | `plans=0 decisions=0` |
| *(for contrast)* `ad-dayparting` | 6,911 | 0 classic-mode rows | `evaluated=0 changed=0` |
| *(working)* `ad-budget-enforce` | 2,287 | **5** `AdBudgetPlan` | `plans=4 … (LIVE)` |

**17,545 runs over zero rows** — and a fourth, `ad-dayparting`, brings it to 24,456.

**Recommendation, split three ways:**

- **`ad-budget-schedule` — keep, and give it a row.** It is the only local mechanism that can
  decrease a budget on a schedule, and Amazon cannot do that in any market. It costs milliseconds a
  tick. Fix §2.1–2.6 first; a schedule created against today's executor would inherit a stale base
  and an unschedulable 23:00.
- **`budget-pool-rebalance` — retire the cron, keep the model.** 8,036 runs is the largest waste of
  the four and the concept (move budget between campaigns in a pool) is genuinely valuable — it is
  Pacvue's core budget feature. But it should be rebuilt as *reallocation within an `AdBudgetPlan`
  cap*, which is a different design from a free-standing pool. Stop the cron; leave `BudgetPool` in
  the schema.
- **`ad-autopilot` — retire the cron; the plan object needs a decision it has not had.**
  `AutopilotPlan` is a goal-plus-guardrails conductor over every other engine. That is either the
  future of this whole section or it is dead; 4,600 empty ticks is neither. Out of scope for this
  page; flagging it for whoever owns the Automations page.

**In all three cases: a cron with zero rows should say so on screen.** An engine that has run 8,036
times and done nothing is either a bug or a decision, and today the page cannot tell an operator
which.

---

## 11 · (i) Tiered implementation plan

### Tier 0 — stop the page lying *(hours; no backend deploy, all four routes are live)*

| # | change | unlocks |
|---|---|---|
| 0.1 | **Delete the hard-coded no-data string.** Call `GET /advertising/dayparting/heatmap` (the endpoint the builder already uses) and render `DaypartingHeatmap`/`DaypartingChart` — both already imported in `_schedule/`. | The signal an operator needs to build a schedule, currently hidden behind a card claiming it does not exist |
| 0.2 | **Print `coverage.daysWithData` on the chart card**, and refuse to render a 7×24 grid below a sample threshold. | Stops six dead weeks being averaged into every cell |
| 0.3 | **Three honest empty states** — none created / ran and did nothing / broke. Requires removing the `catch {}` at `BudgetScheduleTab.tsx:42`. | The brief's explicit ask |
| 0.4 | **Drop the two dead columns** (`Exclude Start/End`) and the dead `Auto Refill` column, or wire them. | Seven columns, three of which can never say anything |
| 0.5 | **Fix the button label** — "Rule" → "Schedule". Add a confirm to Delete, and stop removing the row when the DELETE failed. | |
| 0.6 | **Mount the pacing header** from `GET /advertising/budget-manager`. | The enterprise-tier headline, for the price of one fetch |

### Tier 1 — make the account legible *(days)*

| # | change |
|---|---|
| 1.1 | **The "what is binding" table** (§9.2) — spend vs budget-in-force per campaign, from the hourly cube. This is the highest-value new view on the page. |
| 1.2 | **The precedence panel**: five systems, their state, their cadence, who wins. Sourced from one shared contract, not invented here. |
| 1.3 | **The live change log** from `AdvertisingActionLog`, with `PENDING` shown as pending. |
| 1.4 | **Fix the 23:00 hole** — add a `24:00` end option, or make `end` inclusive of its final hour, and allow a window to cross midnight. One change in `scheduleConfig.ts` + `activeWindow`; benefits both schedule kinds. |
| 1.5 | **Fix the churn guard order** (`ad-budget-schedule.job.ts:79-81`): record `lastApplied` only after a successful write, and check reality before memo. |
| 1.6 | **Retire `hourly-performance`** in favour of `dayparting/heatmap`. |
| 1.7 | **Stop `budget-pool-rebalance` and `ad-autopilot`.** 12,636 empty ticks. |

### Tier 2 — the object, properly

| # | change |
|---|---|
| 2.1 | **Live base, not a snapshot.** Resolve the base budget at evaluation time, with an explicit "baseline" concept the operator can see and reset. |
| 2.2 | **A ceiling on every schedule** — max € and max % — plus the per-scope spend ceilings the brief requires, at all four grains, reusing `automation-rule-scope.ts` rather than a second scope model. |
| 2.3 | **Events as first-class objects** with a visible revert date. |
| 2.4 | **Read Amazon's native budget rules back** and show them in the same list with `Enforced by: Amazon`. Read-only first. |
| 2.5 | **Audit rows on schedule create/edit/delete** — the object currently has no history of its own. |

### Tier 3 — the strategic bets *(each needs a decision, not just build time)*

| # | change |
|---|---|
| 3.1 | **Author native event rules on SP** for IT/DE/ES/FR. The only budget change that survives our downtime. |
| 3.2 | **Reallocation within a cap** — "−€3/day from A, +€3/day to B", one reversible act. Pacvue's core budget feature, and the right replacement for `BudgetPool`. |
| 3.3 | **The 7×24 grid**, when the sample supports it — late September at the earliest, coloured by spend. |
| 3.4 | **Ingest out-of-budget hours** if Amazon exposes them for our markets. §4.2 says only 3% of campaign-days go dark early, so this is lower priority than the bud study implied — but it is the only way to measure that number directly rather than infer it. |

---

## 12 · Open questions

1. **Do you accept the reframing?** This page's headline becomes **pacing** (`AdBudgetPlan`, moved
   here from `/marketing/ads/budget-manager`) and its object becomes an instrument below it. If you
   want Budget Manager to stay where it is, the pacing header can read the same endpoint from two
   places — but then two pages answer the same question.
2. **Precedence — who wins?** Today the pacer and two rules overwrite each other inside the same
   hour (§3). My recommendation: **a market's monthly cap outranks everything**, then an explicit
   schedule window, then rules — and no engine may write a campaign another engine wrote in the
   last N minutes. But this is a policy call, not a technical one.
3. **Native event rules — adopt?** IT/DE/ES/FR, Sponsored Products, increases only. It is the only
   budget change that survives a Railway restart. Note this is *narrower* than the previous study
   implied: hours-of-day is not available to us.
4. **The 23:00 hole** — fix it in `scheduleConfig.ts`, which is shared with Rank & Dayparting?
   That file is not in the locks register's §3 list, but the fix touches session 5's surface. I
   would rather you sequence it than have two sessions patch one grammar.
5. **`budget-pool-rebalance` and `ad-autopilot`** — 12,636 empty ticks. Stop them?
6. **The MOSS divergence** — 4 campaigns whose last logged write says €1 while the campaign reads
   €10. Something changes budgets without writing an audit row. Worth a separate look; it
   undermines every change log we might build.

---

## Appendix — scripts

| script | measures |
|---|---|
| `_bs-page-state.mts` | `BudgetSchedule` verified two ways · 7 crons with run counts, failures and output strings · daily-budget distribution · 14 days of budget writers and their collisions |
| `_bs-page-hourly.mts` | hourly coverage on whole weeks vs the daily report · per-day hour counts · hour-of-day in Rome · the 23:00 hole priced · `analyzeBudgetManager()` live · audit-log horizon |
| `_bs-page-binding.mts` | the hourly feed day by day · budget-in-force reconstructed from the audit log · spend vs that budget · last delivering hour, binding vs not · writers per day |
| `_bs-page-units.mts` | **the unit check that saved §4.1** — euros vs cents per writer, log-vs-`Campaign` agreement, and the 41% broken audit chain |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.
Prior scripts `_bs-study.mts` / `_bs-study2.mts` were read, not overwritten.

### Corrections to the earlier study, collected

| § | earlier | measured now |
|---|---|---|
| 4.1 | "on more than half of the live account there is nothing to modulate" | **32.7% of campaign-days spend ≥100% of the budget in force**; 34 of 63 campaigns bind |
| 5 | "Amazon added hours of day — for events, native wins" | hours-of-day is **US/CA/UK/IN/JP only**; native is SP-only and **increase-only** |
| 7 | "hourly covers ~57% of measured spend" | **29.4%** against the right denominator — and really **0% for a month, ~100% for 8 days** |
| 7 | overnight-heavy hour-of-day ROAS shape | computed over the dead month; the honest window is **evening-heavy**, on 49 orders |

### Sources

- [Budget rules now available in Amazon advertising console globally — Amazon Ads](https://advertising.amazon.com/resources/whats-new/dynamic-budget-control) *(the marketplace list, and "Sponsored Products only")*
- [Hours of day now available for schedule-based budget rules — Amazon Ads](https://advertising.amazon.com/resources/whats-new/hours-of-day-available-for-schedule-based-budget-rules) *(US, CA, UK, IN, JP)*
- [A complete guide to budget rules — Amazon Ads](https://advertising.amazon.com/library/guides/budget-rules)
- [Amazon Ads Budget Rules: scheduled budget changes that restore themselves — Off Hours](https://www.off-hours.app/budget-rules) · [Budget rules guide — Off Hours](https://www.off-hours.app/blog/amazon-ads-budget-rules-guide)
- [Budget Calendar Insights — Pacvue](https://pacvue.com/blog/budget-calendar-insights-a-dash-of-insights-goes-a-long-way/) · [Pacvue for Amazon](https://pacvue.com/marketplaces/pacvue-for-amazon/)
- [Media budget forecasting / Budget Navigator — Skai](https://skai.io/media-budget-forecasting/) · [Budget Navigator makes Smart Bidding better — Skai](https://skai.io/capabilities/budget-navigator-smart-bidding/)
- [Scale Insights review 2026 — The Price Geek](https://www.thepricegeek.com/ppc-tools/scale-insights-review/) · [Adbrew review 2026 — The Price Geek](https://www.thepricegeek.com/ppc-tools/adbrew-review/)
- [Retail Media Automation 2026: platform comparison — Osmos](https://www.osmos.ai/blog/automation-auctions-the-science-of-scalable-retail-media)

### Internal references

- [2026-08-11-bs-budget-schedules-study.md](2026-08-11-bs-budget-schedules-study.md) — the tab study this corrects
- [2026-08-11-bud-budget-study.md](2026-08-11-bud-budget-study.md) — the ratchet; the cause of the €1 median
- [2026-08-11-rd-rank-dayparting-study.md](2026-08-11-rd-rank-dayparting-study.md) — the other time-based scheduler; the stale-feed lesson applied here in §7
- [2026-08-11-auto-automations-study.md](2026-08-11-auto-automations-study.md) · [2026-08-10-ads-rules-automation-ra.md](2026-08-10-ads-rules-automation-ra.md) · [2026-08-10-ra-session-locks.md](2026-08-10-ra-session-locks.md) §0

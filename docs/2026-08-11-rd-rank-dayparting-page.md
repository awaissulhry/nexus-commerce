# RD — Rank & Dayparting Schedules as its own page

*Study 5 of 11, second pass. Read-only. No code was written, nothing was committed, the builder was
not touched.*

Measured on production 2026-08-11 with `_rd-page-state.mts`, `_rd-page-loop.mts`,
`_rd-page-churn.mts`, `_rd-page-churn2.mts`. Supersedes the measurement in
[`2026-08-11-rd-rank-dayparting-study.md`](2026-08-11-rd-rank-dayparting-study.md) where the two
disagree — §0 lists every disagreement.

---

## 0 · 🔴 I have to correct the first study before anything else

The first study's headline was **"the engine is chasing a target using a dead feed."** I measured the
controller this time instead of reading its documentation, and that sentence is wrong in a way that
inverts the whole priority order.

**The engine is not chasing anything. For 29 of 33 live campaigns the feedback loop is never
entered at all.**

`computeStep` (`rank-controller.ts:170`) derives a band before it moves anything:

```ts
// rank-controller.ts:87
const floor   = clamp(target.biasPct ?? 0, 0, 900)
const ceiling = target.allOut ? (target.maxBiasPct ?? 900) : (target.maxBiasPct ?? floor)
…
const canChase = target.allOut || ceiling > floor        // :186
if (!canChase) {                                          // :201
  if (cur > floor) return toFloorDown('above Placement')
  return { action: 'hold', nextPct: cur, reason: `holding ${floor}% Placement` }
}
```

`maxBiasPct` is **null on all five RankTargets**. So for every non-all-out target,
`ceiling === floor`, `canChase === false`, and the function **returns at line 201–204 — before it
ever reads `targetISPct`, `acosCapPct`, `achievedISFraction` or `achievedAcosFraction`.**

Measured (`_rd-page-loop.mts` §A):

| target | floor | ceiling | can chase? | consequence |
|---|---|---|---|---|
| `own-top` | 150% | 150% | **NO** | IS 70% and ACoS cap 45% never read |
| `defend-top` | 75% | 75% | **NO** | IS 35% and ACoS cap 35% never read |
| `rest-of-search` | 45% | 45% | **NO** | IS 10% and ACoS cap 30% never read |
| `pause` | 0% | 0% | **NO** | (min-bid branch, never reaches the controller) |
| `own-top-allout` | 300% | **900%** | YES | but all-out ignores IS *and* ACoS — it just climbs +25/cycle |

**Every correction that follows falls out of that one fact.**

| the first study said | measured now |
|---|---|
| "the engine … pushes bias up, bounded only by the ACoS cap and the CPC ceiling" | It pushes nothing. It snaps to `biasPct` and holds. The ACoS cap is **never evaluated** on any target in use. |
| "the SQP signal is the feedback loop of the only optimisation engine this account runs" | The SQP number is **read every tick and then discarded** — `rest-of-search` cannot chase. Fixing SQP changes **no bid today**. |
| "all 33 live schedules were holding `pause`" | Time-of-day artefact of a 00:45 sample. At 12:00 today `lastApplied` = **`own-top` × 33**, `ENABLED` × 2, null × 10. |
| "every group targets the REST lane" | `rest-of-search` is the *baseline*, and the baseline governs only **38 of 168 hours (23%)**. Windows override it for 77% of the week. The most-governing target is **`pause`, 54h (32%)**. |
| "`RankScheduleVersion` = 0 — either the save path is bypassed or the diff never fires" | Neither. The version writer shipped **2026-08-03** (`fe3f2576a`); the three group edits were 07-28, 07-31, 08-01 — **all before the feature existed.** Not a bug. (There *is* a separate real gap — §2.4.) |
| `ProductRankPlan` not mentioned | **2 rows exist**, both disabled. A second authoring path into the same engine that this page does not show. |

**What is still true from the first study:** the model is good; `RankScheduleEvent` and
`RankScheduleVersion` are genuinely empty; `ad-dayparting` genuinely iterates over zero rows;
`top-of-search-defense` has genuinely never run; SQP is genuinely stale.

---

## 1 · What exists — every wire

```
/marketing/ads/rules-automation/dayparting                 page.tsx → DaypartingSchedulesClient.tsx
└── AdsPageHeader (showMarket, showChangeLog) · RulesTabs active="dayparting"
    ├── HourlyPerformance.tsx   → GET /advertising/dayparting/heatmap    (7×24, Rome, whole weeks)
    ├── CoveragePanel.tsx       → campaigns with no schedule + add-to-schedule
    └── tabs/RankGoalsList.tsx  → GET /advertising/rank-schedule-groups  (the list, on AdsDataGrid)
        ├── ScheduleRowActions · WeekShape · TemplateLibrary
        ├── ScheduleActivityDrawer → ScheduleActivity | Next24Preview | ScheduleVersions | ScheduleEvents
        └── scheduleHealth.ts · selectionToWindows.ts   (+ vitest for both)

Builder (OFF LIMITS — §1 of the brief)   builder/dayparting-schedule → _rank/RankGoalBuilder.tsx
                                          ?style=classic → _schedule/ScheduleBuilder.tsx

Authoring   RankScheduleGroup ─┬─ RankScheduleVersion (plan-edit history)
                               └─ RankScheduleEvent   (dated overrides)
            ProductRankPlan     (a SECOND authoring path — family-level, not on this page)
Execution   AdSchedule  @@unique([campaignId])  — one campaign, one schedule, enforced by the DB
Goals       RankTarget (library) · RankScheduleTemplate
Engines     ad-rank-defend (goal mode, */15) · ad-dayparting (classic mode, */15)
            top-of-search-defense (*/30, NEXUS_ENABLE_TOS_DEFENSE_CRON — never run)
```

### Measured state

| | |
|---|---|
| groups | 16 (**4 enabled**, covering 33 campaigns) |
| `AdSchedule` rows | 45 · 33 enabled · **0 orphans** · **0 classic-mode** (verified, no `.catch`) |
| `lastApplied` @ 12:00 Rome | `own-top` 33 · `ENABLED` 2 · null 10 |
| `lastEvaluatedAt` newest | 2026-08-11 12:00:02 — the cron is alive |
| `RankTarget` | 5 · `RankScheduleTemplate` 5 · **`RankScheduleVersion` 0** · **`RankScheduleEvent` 0** |
| `ProductRankPlan` | **2, both disabled** (one last evaluated 2026-06-06, one never) |
| per-campaign `targetOverrides` | 12 rows |

### The three live IT/DE plans are byte-identical

`_rd-page-churn2.mts` §2: **IT GALE JACKET, IT AIRMESH and Rank plan — GALE EXACT DE hold the exact
same 92-window plan** (`JSON.stringify(windows)` identical). Three product lines, two markets, one
plan. IT AIREON is the only group with its own shape (65 windows).

And the shape itself is not a designed week. Rendered hour by hour (`_rd-page-churn.mts` §2):

```
Mon  r......rrATrArrAAATAATAA        T = own-top      d = defend-top
Tue  ........rdrrArTArTdTATTA        A = own-top-allout
Wed  ........rrrAATdAATArTdAd        r = rest-of-search
Thu  .........ddAATdrTTArrAdd        . = pause (min bid)
Fri  ........dTdrrdrArTrArrdr
Sat  ........rrddTTAAdTrddTAr
Sun  rr.......rTrrArrrAdAAdAT
```

**54 lane changes per week.** Nobody paints that. It reads as generated, and it was then copied to
two more groups. I am reporting the data, not proposing a builder change.

---

## 2 · How it works — and the four places it doesn't

### 2.1 Window resolution (correct, and carefully built)

`nowInTz()` sources "now" from **`SELECT now()` on Postgres**, not the container clock, because
Railway containers have drifted hours (`ad-rank-defend.job.ts:32`). `resolveActiveWindow` takes the
first window covering `(day, hour)` that names a target; `endHour` is exclusive; otherwise the
baseline. Events (`pickActiveEvents`) are half-open and resolve overlaps to the latest-started.
All of this is pure and unit-tested. No defect found.

### 2.2 The motion profile — the defect

`biasPct` is the floor ("the bid we hold"), `maxBiasPct` the ceiling. **The loop only becomes a loop
when the ceiling is raised above the floor.** With every library ceiling null, the engine is a
**scheduled placement setter**: at each tick it snaps the target's placement to `biasPct`, zeroes the
other search placement, and holds.

Per campaign, right now (Tue 14:00 Rome, all 33 resolving to `own-top`):

| cohort | n | band | live Top | behaviour |
|---|---|---|---|---|
| AIREON / AIRMESH, no override | 21 | 150–150% | 150% or capped | snap-and-hold |
| GALE, override `{biasPct:0, acosCapPct:15}` | 8 | **0–0%** | 0% | holds Top at **zero** during "own top" hours |
| GALE, override `{biasPct:100, maxBiasPct:200, targetISPct:55, stepUpPct:3}` | **4** | 100–200% | **3–6%** | the only closed loop — and it never arrives (§2.3) |

**29 open-loop · 4 closed-loop.**

### 2.3 🔴 The 4 closed-loop campaigns can never reach their own floor

Those four carry `stepUpPct: 3` — ramp +3% per 15-minute cycle, i.e. +12%/hour. To climb from 0 to
their 100% floor takes **8.3 uninterrupted hours of `own-top`**.

They never get them. Two things zero the Top multiplier:

- a `rest-of-search` hour drives Rest and **zeroes Top** (`buildSearchPlacementAdjustments` — Top and
  Rest are mutually exclusive search positions);
- a `pause` hour has `biasPct = 0` on `PLACEMENT_TOP`, so MB.3 **writes Top → 0** as well.

Those two together are **92 of 168 hours**, and the plan changes lane **54 times a week** — 31 of
which force Top to 0. Measured consequence: the four sit at **Top = 3%, 6%, 6%, 3%** against a 100%
floor and a 200% ceiling, and have burned **6,412 of 35,269 `CampaignBidHistory` rows in 60 days
(18%, from 4 of 45 schedules)** ramping toward a floor they will never touch.

The operator hand-tuned these four to chase 55% impression share. They have never once been in a
position to chase anything.

### 2.4 The CPC ceiling is the real policy on 10 of 33 campaigns

`cpcCapPct()` converts the €-ceiling into a maximum placement %:
`100 × (maxCpc / (maxBaseBid × strategyHeadroom) − 1)`, floored. It binds **last**, after every other
adjustment. Measured against `own-top`'s €1.50 ceiling:

| campaigns | highest live base bid | cap | live Top | intended |
|---|---|---|---|---|
| 5 AIRMESH (Brand ×3, Competitor ×2) | €2.14 – €2.32 | **0%, `baseAlone`** | 0% | 150% |
| 4 AIRMESH + GALE EXACT DE | €1.25 | **19%** | 19% | 150% |

`baseAlone` means *the base bid alone already exceeds the ceiling — no multiplier can rescue it.*
The engine's entire response is `logger.warn` every 15 minutes (`ad-rank-defend.job.ts:300`),
deliberately not a notification, because per-tick notifications would bury themselves.

So: **a third of the fleet is governed by the CPC ceiling rather than by its rank target, five of
them are pinned at the exact opposite of "own top of search", and nothing anywhere on screen says
so.** This is the operator's "refuse the write and tell me" case, already happening, silently.

### 2.5 Governance

- **Versions.** The writer is correct and fires on any meaningful diff (`ads-create.service.ts:1186`).
  Zero rows because it shipped after the last save. **But** the list page's Enable/Pause — the single
  most consequential click on this page, and the bulk version of it — goes to
  `PATCH /rank-schedule-groups/:id` **without** `campaignIds`, which takes the lightweight path
  (`advertising.routes.ts:9141–9169`): it updates the group row and cascades `enabled` to members,
  and **never calls `saveRankScheduleGroup`, so it writes no version** — even though `enabled` is part
  of the version diff. Arming and disarming a schedule leaves no history at all.
- **Events.** Fully wired end to end (routes 8987–9132, engine 646–661) and **inert without data**.
  Zero rows means zero behaviour change; nothing is broken.

---

## 3 · The freshness requirement — stated, not designed

Per the brief this belongs to the shared reconciliation (tabs 1, 2 and 5 all touch it). I am stating
the requirement and **two refinements the other studies could not see from their side**.

**The requirement.** `sqpImpressionShareForAsins` (`sqp.service.ts:191`) takes `MAX(startDate)` and
returns it as current, with no recency guard. A feed that died a month ago returns a confident number
indistinguishable from a fresh one.

**Refinement 1 — a recency guard alone is not enough; it needs a volume guard too.** Measured:

| week | IT | DE | ES | FR | total |
|---|---|---|---|---|---|
| 2026-07-19 | 655 | 364 | 193 | 4 | **1,216** |
| **2026-07-26** (the one it uses) | **8** | **5** | **71** | **1** | **85** |

The newest week is not merely 17 days old — it is a **collapsed partial**, 7% of the prior week for
IT. A pure age guard set at, say, 21 days would happily pass it. The guard must be
`age AND row-count relative to the trailing norm`.

**Refinement 2 — "no signal" has two different causes here, and the page must not merge them.**

| family | ASINs | share returned | SQP rows for those ASINs, all time |
|---|---|---|---|
| GALE (IT) | 18 | 0.15% | **14,940** |
| GALE EXACT (DE) | 18 | 0.97% | 14,940 |
| AIREON (IT) | 40 | 0.20% | **3** |
| **AIRMESH (IT)** | 20 | **null** | **0 — ever** |

AIREON's confident-looking 0.20% is computed from a handful of rows. AIRMESH's ASINs have **never**
appeared in Brand Analytics — it did not lapse, it never existed. *(That answers open question 3 of
the first study.)*

**What this page must show — and it is a display requirement, not a behavioural one.** Because
`rest-of-search` cannot chase, the guard changes no bid today. Its value here is that the page stops
printing a number it has no right to print. Three states, never merged:

1. **fresh** — value + age;
2. **stale** — value greyed, struck, or badged with age *and* row count vs norm ("85 rows; norm ~1,200");
3. **never had coverage** — "no Brand Analytics coverage for these ASINs", which is an onboarding
   problem, not a cron problem.

**The good news the other studies did not have.** The *other* lane's signal is healthy:
`AmazonAdsPlacementReport` where `placement = 'Top of Search on-Amazon'` — newest **2026-08-10**
(1 day old), **593 rows in 14 days, 532 carrying `topOfSearchIS`**. And 76 of 168 hours resolve to a
`PLACEMENT_TOP` target. **The lane that governs 45% of the week has a fresh, dense signal and simply
isn't being read.** Closing the loop does not depend on the SQP fix at all.

---

## 4 · Is the target reachable? — the question was aimed at the wrong lane

The brief asks whether a 10% rest-of-search goal is reachable against a measured 0.15–0.97%.

**It is not, and it does not currently matter** — `rest-of-search` cannot chase, so the number is
inert. But the question has a real answer once the loop is closed, and the honest one is:

**Do not chase a 10% rest-of-search impression share. Retire the number.** Three reasons:

1. The signal is SQP *brand share of all search impressions for a query set* — it is not a placement
   impression share, it is not comparable to the target's unit, and Amazon exposes no Rest-of-Search
   placement IS at all. The 10% was never measured against the thing it names.
2. Its measurement base is 3 rows (AIREON), 0 rows (AIRMESH) or a collapsed partial week (GALE).
3. Study 3 measured rest-of-search out-earning top-of-search in all four markets, so the *lane* is
   right even though the *goal on it* is meaningless.

**Recommendation:** make `rest-of-search` an explicitly **open-loop hold** — "hold Rest at 45%, no
target" — and say so on the row. Then put the closed loop where the signal actually is: the
`PLACEMENT_TOP` targets, against fresh Top-of-Search IS, which is exactly what `own-top`'s 70% and
`defend-top`'s 35% were written for.

That is the reconciliation the brief asks for in (d): **the caps are the real policy today — say so
out loud on the row — and move the goal to the lane that can hold one.**

---

## 5 · Industry research — features and interfaces

Searched 2026-08-11; sources at the end. The first study's Pacvue section stands; this adds the
interface detail and the tools it did not cover.

| platform | how dayparting is modelled | what the screen is | tier |
|---|---|---|---|
| **Pacvue** | fully automatic hourly, AMS-fed; trailing 14d **excluding the most recent 2**; raises bids in high-**CVR** hours | *Automated Insights*: historical hourly CVR **beside** the recommended bid adjustment for every hour of every weekday. Bulk Campaign Dayparting (beta) applies hourly changes across campaigns at once | enterprise, custom (~$114k/yr cited) |
| **Skai** | *AI Dayparting* — ML-derived bid modifiers off an AMS partnership | hourly attribution insights **embedded in the scheduling tool**; graphs comparing **CPC and CVR over time**; recommendations surface as AI tips in plain language ("decrease bids by 5% from 3:00 am to 6:00 am"). Pharma case study: **+22% ROAS** | enterprise, custom |
| **CommerceIQ** | bid/budget pacing off 50+ shelf-aware signals; dayparting responds to stock and Buy Box | role-specific AI agents rather than a painted grid | enterprise |
| **Quartile** | single-keyword campaign architecture — every ASIN×keyword×match its own campaign — enabling hourly bid adjustment at scale from AMS | portfolio/automation-led | mid–enterprise |
| **AdLabs** | percentage bid modifiers per hour per weekday | **a colour-coded 7×24 heatmap of the modifiers themselves** — green up, red down, white neutral; one schedule shown applied to **974 campaigns** | SMB |
| **Scale Insights** | rule-based hour-level dayparting; also *Dayparting Campaigns* — **24 ad groups, one per hour**, to get hourly attribution without AMS | rules + reports | **$78/mo for 5 ASINs**, per-ASIN |
| **Sellozo** | schedule ads to run/pause by hour and weekday | scheduling UI | **$250/mo flat per marketplace** |
| **Ad Badger** | rules-based, adjusts hourly | rules + education | **from $400/mo**, scales with spend |
| **SellerMetrics** | "micro-dayparting": 24 hourly segments bucketed peak / neutral / off-peak at **±20% vs the product's own CVR baseline**; **minimum 14 days of hourly data before any change** | dashboards; no distinctive grid documented | **$79/mo** to $3k ad spend |
| **Zon.Tools · Xmars** | bid, budget **and placement multipliers** by hour/day from one grid | one grid drives all three | SMB–mid |
| **Amazon native** | schedule-based bid rules for SP (launched 2023-11-06), hourly/daily/weekly | in the ads console | free — but **increase-only**, SP-only, per-campaign manual setup |

### One to steal, one to avoid

**Steal — from Skai and Pacvue, the same thing: the recommendation sits beside the observation, in a
sentence.** Both show what an hour *did* and what the system *would do about it*, before it does it.
That is the single interface idea that generalises to a page whose whole problem is that its engine's
reasoning is invisible.

**Avoid — Scale Insights' 24-ad-groups-per-hour trick.** It manufactures hourly attribution by
shredding campaign structure. We have Marketing Stream; paying for the same data in permanent
structural complexity is a bad trade, and it would collide with `@@unique([campaignId])` on
`AdSchedule`.

### The three Pacvue tests, answered against our data

1. **Exclude the most recent 2 days?** ❌ We don't. `hourlyCells` correctly uses whole weeks, the DB
   clock, and excludes *today* — but includes yesterday and the day before, which are exactly the
   unsettled ones. It does track `restatedCells` (cells where Amazon restated a metric negative),
   which is the same concern half-solved. **Cheap to add; worth adding.**
2. **CVR rather than impression share as the hourly signal?** ❌ **And we cannot adopt it.** Measured
   over 56 days across the fleet: **4,026 clicks, 49 orders**. Only **36 of 168 weekday×hour cells
   have even one order**, and the busiest cell has **3 orders in 8 weeks**. Hourly coverage itself is
   thin — 31 of 33 live campaigns have *some* data, but the median is **10 days of 56**. SellerMetrics'
   own rule (14 days minimum, ±20% vs baseline) would refuse to fire on almost every cell we have.
   **Pacvue's mechanism is right and this account is an order of magnitude too small for it.** Say so
   on the page rather than shipping a CVR heatmap that renders noise as insight.
3. **Show the recommendation beside the observation?** ❌ Today. This is the one to take.

### Where we are genuinely ahead

A **rank goal as a first-class object** — `{placement + targetIS + ACoS/CPC guardrails}`, reusable,
per-campaign overridable, with dated events and plan history. Pacvue's unit is "bid ×N in hour H".
Nobody in the table above models a goal. **`RankTarget.lanes` goes further still and I found no
competitor documenting an equivalent.** The gap is not capability. It is that four nulls in a
`RankTarget` row silently turn the whole apparatus into a placement setter, and nothing says so.

---

## 6 · How the page should be

> **One question: what is each campaign being asked to hold right now, is it holding it, and if not,
> what is stopping it?**

The list already answers *what it is holding* (`Now holding`, RDX/A3) and *whether the loop ran*
(`Health`). It cannot answer *whether the loop can do anything*, which is the question that matters
on every one of the 33 rows today.

### 6.1 Three columns, and they are all derivable server-side now

| column | value today | why it changes a decision |
|---|---|---|
| **Mode** | `Holding 150%` / `Chasing 55% IS` / `Capped 0% by €1.50 CPC` | 29 rows would read *Holding*, 4 *Chasing*, 10 *Capped*. Right now all 33 read nothing. |
| **Goal vs actual** | `— vs 31.3% IS` or `55% vs 35.0% IS` | Goal is dead on 29 rows; showing it as live is the lie. Show a dash where there is no goal. |
| **Signal** | `Top-IS · 1d old` / `SQP · 17d, 85 rows (norm ~1,200)` / `no coverage` | Names the lane and its age. The three states of §3, never merged. |

`Health` gains one state above `OK`: **"Cannot converge"** — ceiling equals floor while a target IS is
set, or the CPC cap pins the placement below the floor. Both are pure functions of data the group
endpoint already assembles, so this is a `scheduleHealth.ts` change plus fields, not new machinery.

### 6.2 The rest

- **No-signal stated as no-signal.** AIRMESH: 10 campaigns, zero Brand Analytics coverage, ever.
- **One engine list.** Which loop owns this campaign this hour — `ad-rank-defend` via schedule, via
  `ProductRankPlan` (2 rows, invisible today), or `ad-dayparting`. `Health` already has *Governed
  elsewhere*; it needs the plan to be *visible*, not just deferred to.
- **The CPC-ceiling refusal, surfaced.** Not per tick — a persistent row state plus one digest entry.
  `baseAlone` deserves its own words: *"the base bid alone exceeds the ceiling — lower the bids."*
- **Events and versions in use.** Events are inert and ready. Versions need the Enable/Pause path to
  snapshot (§2.4) or the history will stay empty no matter how much the operator uses the page.
- **A URL contract.** Verified: **there is no `useSearchParams` anywhere on this page.** Market,
  heatmap scope, drawer and drawer tab are all `useState`. Nothing is linkable but the route itself.

### 6.3 The page-one design, using `RankTarget.lanes`

The operator's goal — several of our ASINs on one results page, balanced between top-of-search and
rest-of-search, the balance chosen by us and held automatically — is **exactly what `lanes` models**,
and the engine path is already written and unit-shaped (`ad-rank-defend.job.ts:309–344`,
`laneToSpec`, `buildBlendedAdjustments`, `samePlacements`). One combined placement write, a different
signal per lane: Top = Amazon Top-IS, Rest = SQP, Product = open-loop.

**What standing it up costs — and the honest cost is smaller than it looks, with one catch.**

*Already built:* the blended write path, per-lane stepping, per-lane CPC capping, the no-op guard,
the per-scope `lanes` override (BL.9), the reason string. Nothing needs writing in the engine.

*Needed:*
1. **A lane-aware `RankTarget` with ceilings above floors** — otherwise the blend inherits exactly the
   defect in §0 and becomes a static three-placement setter. This is a data change, one row.
2. **A Rest lane that does not pretend to have a signal.** Per §4, Rest should be open-loop hold.
   So the blend is realistically: **Top = closed loop on fresh Top-IS · Rest = held at N% · Product =
   held at M%.** That is genuinely the operator's ask — chosen balance, held automatically, with the
   one lane that *can* self-correct doing so.
3. **The catch, and it is the real cost:** the single-placement path zeroes the other search placement
   every time the lane flips, and the live plans flip **54 times a week**. A blend holds all three at
   once, so **a blended target and a lane-flipping weekly plan are incompatible by construction.**
   Page-one means a *stable* blend across most hours, not a scattered plan. The plan lives in the
   builder, which is off limits to me — so this is a decision for the operator, and it is the
   gating one.
4. **Blast radius.** `own-top-allout` occupies 99 hours a week across the live groups and climbs
   +25%/cycle to 900% bounded only by CPC. Any lanes work should land behind a per-scope spend
   ceiling first (§7).

**Cost estimate: ~1 day for the target + list surfacing, gated on a plan decision I cannot make.**

---

## 7 · `ad-dayparting` and `top-of-search-defense`

- **`ad-dayparting` — retire the schedule, keep the code.** Verified with no `.catch`: **0 of 45
  `AdSchedule` rows are classic-mode**, and `@@unique([campaignId])` means a campaign cannot hold both
  a classic row and a rank row, so classic mode is not merely unused — it is now *structurally* the
  road not taken. 6,866 ticks over an empty set. Unschedule it and leave `isGoalMode` in place as the
  guard it already is. Deleting the engine is a larger call than this page should make.
- **`top-of-search-defense` — leave it off, and stop listing it as an engine.** Registered
  (`cron-registry.ts:249`, `ads-tos-defense.job.ts`), gated behind `NEXUS_ENABLE_TOS_DEFENSE_CRON`,
  never run. Arming it would put a **second** writer on `PLACEMENT_TOP` alongside `ad-rank-defend`,
  which holds 76 of 168 hours on that exact placement. Two loops, one lever, no arbitration. The
  correct fix for "we want top-of-search defended" is §0's — give `own-top` a ceiling — not a second
  engine.
- **The 12 dormant single-campaign groups** (one batch, 2026-07-02, never armed): **delete.** They
  are 12 of 16 rows on a 16-row list, they carry the same scattered plan, and four of them are
  unscoped to a marketplace. Deleting them is the cheapest legibility win the page has.

---

## 8 · Requirements on the shared layer

*Constraints, not solutions. The twelfth pass reconciles.*

1. **`AdsDataGrid` — a row needs a secondary state that is not the enable toggle.** This page needs
   *Mode* and *Health* to coexist with *Status* without three pills competing. Whatever the shared
   answer is, it must allow a row to say "on, running, and unable to converge".
2. **A shared signal-freshness chip.** Tabs 1, 2 and 5 all render an SQP-derived number. One
   component, three states (fresh / stale-with-age-and-volume / never-covered), one definition of
   stale. **It must carry row count against a trailing norm, not just age** (§3, refinement 1).
3. **The scope form must express "market ∪ product line ∪ portfolio", and the URL must carry it.**
   This page's groups are portfolio-scoped (three of four live ones) while `RankScheduleGroup.marketplace`
   is null on both large IT groups — market is *derived from members* here, not stored. The shared
   scope contract must survive a group that legitimately spans IT + DE.
4. **A URL contract this page can adopt wholesale.** Needed: `?market=`, `?scope=<groupId>`,
   `?row=<groupId>`, `?drawer=activity|next24|versions|events`. Nothing here is linkable today.
5. **One shared "who owns this campaign right now" resolver.** Three claimants exist
   (`AdSchedule` → `ad-rank-defend`, `ProductRankPlan` → same engine with precedence, `ad-dayparting`).
   Placement (3) and Bid (9) need the same answer. It should not be computed three times.
6. **A per-scope spend ceiling primitive** (market · product line · portfolio · campaign) with a
   *refusal* that is visible on the row, not a log line. §2.4 is that feature already failing silently.
7. **Real-time sync:** this page's rows change every 15 minutes from the engine, not from the
   operator. It needs push/poll of `lastEvaluatedAt` + `activeTargetKey` + mode, and its optimistic
   Enable/Pause must not be clobbered by an inbound tick.

### The boundary with Placement (3) and Bid (9)

All three are views of `ad-rank-defend`. Proposed split — **one writer, three lenses**:

| page | owns | must not |
|---|---|---|
| **5 · Rank & Dayparting (this page)** | the **plan and the goal**: which target governs which hour, for which campaigns; arming; events; versions; whether each loop *can* converge | set a placement % directly |
| **3 · Placement** | the **outcome per placement**: current Top/Rest/Product bias, what moved it and when, per-placement performance — a read-and-explain surface over the 15,185 writes (study 3) | author schedules, or add a second writer to `PLACEMENT_TOP` |
| **9 · Bid** | the **base bid** the multipliers stack on, plus min-bid floors and the CPC ceiling's *inputs* — §2.4 is a Bid-page problem surfacing as a Rank-page symptom | move placement multipliers |

The seam that matters: **the CPC ceiling lives on the `RankTarget` (page 5) but is breached by base
bids owned by page 9.** Whichever page shows the refusal, both must link to the other, or the
operator sees "capped at 0%" on one page with no way to reach the number that caused it.

---

## 9 · Tiered plan

**Nothing in any tier touches the builder, `_rank/*`, `_schedule/*`, `ArmPreview`, `ScheduleEvents`
or `rules-automation.css`.**

### Tier 0 — make the page tell the truth *(hours; no behaviour change at all)*
| # | change | unlocks |
|---|---|---|
| 0.1 | **Mode column** — derive `canChase` and `cpcCapPct` server-side per group; render *Holding / Chasing / Capped* | 29 open-loop and 10 capped rows stop looking identical to 4 working ones |
| 0.2 | **`Health` gains "Cannot converge"** in `scheduleHealth.ts` (pure, already unit-tested) | the one state the page most needs and does not have |
| 0.3 | **Goal vs actual vs signal-age**, with a dash where no goal is live and the three signal states never merged | turns the list into a decision |
| 0.4 | **Delete the 12 dormant groups** | 16 rows → 4 |

### Tier 1 — close the loop *(a day; this is where the behaviour changes)*
| # | change | note |
|---|---|---|
| 1.1 | **Give `own-top` and `defend-top` a `maxBiasPct` above their floor** | one row each. Turns a placement setter into the closed loop it was designed as, on the **fresh** Top-IS signal. **Blast radius: 33 campaigns — do it on one group first.** |
| 1.2 | **Fix the +3%/cycle ramp on the 4 GALE campaigns** — either raise `stepUpPct`, or drop it so they snap to floor | they have been stuck at 3–6% since 2026-08-01 and account for 18% of all bid writes |
| 1.3 | **Make `rest-of-search` an explicit open-loop hold** and label it so | §4 |
| 1.4 | **Surface the CPC-ceiling refusal** (row state + digest), `baseAlone` in its own words | 10 of 33 campaigns |
| 1.5 | **Snapshot a version on Enable/Pause** — route the lightweight PATCH through `saveRankScheduleGroup`, or write the version inline | §2.4 |
| 1.6 | **The recency + volume guard on SQP** — *shared, tab 1/2/5; §3* | display truth here, not behaviour |

### Tier 2 — adopt what the field proved *(days)*
- **Exclude the last 2 days** from the hourly window (`ads-hourly.service.ts`, one boundary).
- **Recommendation beside observation** on the list: the engine's own `reason` string per row, which
  it already computes and throws away outside the drawer.
- **The URL contract** (§8.4).
- **Do NOT build a CVR-by-hour signal.** Measured: 49 orders in 168 cells over 8 weeks. State the
  volume floor on the page instead of rendering noise.

### Tier 3 — page one *(gated on an operator decision, ~1 day after it)*
`RankTarget.lanes` per §6.3 — engine path already built; needs a lane-aware target with real ceilings,
an open-loop Rest lane, a per-scope spend ceiling under it, and **a stable weekly plan**, which is a
builder decision and therefore yours.

---

## 10 · Open questions

1. 🔴 **May I give `own-top` a ceiling above its floor?** This is the single change that converts the
   account's only optimiser from a placement setter into the closed loop it was designed as, on a
   signal measured fresh yesterday. It also moves real money on 33 campaigns. I would do it on **one
   group** first and read it for a week.
2. **The 4 GALE campaigns at +3%/cycle have sat at 3–6% against a 100% floor since 2026-08-01.** Was
   `stepUpPct: 3` meant as a slow ramp, or is it a typo for 30? Either way they cannot work as
   configured.
3. **Five AIRMESH campaigns have base bids of €2.14–€2.32 against a €1.50 ceiling and are pinned at
   Top +0%.** Lower the bids, raise the ceiling, or accept it — but it should not stay silent.
4. **The three live IT/DE plans are byte-identical and change lane 54 times a week.** Deliberate, or
   a template applied and never revisited? It gates page one (§6.3, catch 3). *Answer only; I will
   propose nothing about the builder.*
5. **Delete the 12 dormant groups?**
6. **Unschedule `ad-dayparting`?** 6,866 ticks over a set that is now structurally empty.
7. **The two disabled `ProductRankPlan` rows** — a second authoring path into the same engine, absent
   from this page. Delete, or surface?

---

## Appendix — scripts

Read-only, no `.catch` around any measurement. From `apps/api`:
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`

| script | measures |
|---|---|
| `_rd-page-state.mts` | the full `RankTarget` motion profile · 16 groups · governance zeros · 45 execution rows · the 12 override rows |
| `_rd-page-loop.mts` | `biasBand`/`canChase` per target · hours-of-week per target per group · live placement vs the engine's own decision per campaign · both lanes' freshness · SQP per family |
| `_rd-page-churn.mts` | the GALE week rendered hour by hour · lane flips · hour-of-day CVR |
| `_rd-page-churn2.mts` | bid writes per schedule mapped to campaign and motion profile · plan-identity check · hourly coverage per campaign · orders per weekday×hour cell |

*One note on method: my first `groupBy` in `_rd-page-churn.mts` used a column that does not exist
(`AdvertisingActionLog.reasonActor`) and my `.catch` returned `[]` — printing "TOTAL = 0". I caught it
because the fallback said so out loud. It is the exact trap the brief warns about, and the reason no
other measurement in these scripts is wrapped.*

### Sources

- [Pacvue — beverage manufacturer, 31% revenue growth with Dynamic Dayparting](https://pacvue.com/customerstories/a-leading-beverage-manufacturer-achieves-31-revenue-growth-with-pacvues-dynamic-dayparting/) · [Pacvue integrates Amazon Marketing Stream](https://pacvue.com/blog/pacvue-integrates-amazon-marketing-stream/) · [Dayparting during shopping events using SOV data](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Skai — AI Dayparting](https://skai.io/capabilities/ai-dayparting/) · [Pacvue vs Skai (Kenshoo) 2026 — atom11](https://www.atom11.co/blog/pacvue-vs-kenshoo-skai)
- [AdLabs — Amazon Dayparting Guide (the 7×24 modifier heatmap)](https://adlabs.app/guides/amazon-dayparting-guide/)
- [SellerMetrics — Micro-Dayparting on Amazon](https://sellermetrics.app/micro-dayparting-on-amazon/) · [SellerMetrics review 2026](https://www.thepricegeek.com/ppc-tools/sellermetrics-review/)
- [Scale Insights review 2026](https://www.thepricegeek.com/ppc-tools/scale-insights-review/) · [Sellozo review 2026](https://www.thepricegeek.com/ppc-tools/sellozo-review/) · [Ad Badger pricing & review](https://scaleinsights.com/learn/ad-badger-pricing-review)
- [Amazon Ads — schedule-based bid rules for Sponsored Products](https://advertising.amazon.com/resources/whats-new/schedule-based-bid-rules-available-for-sponsored-products) · [Amazon PPC Dayparting strategy guide 2026 — WisePPC](https://wiseppc.com/blog/amazon-ppc-dayparting/) · [Dayparting glossary — SellerStack](https://www.sellerstack.ai/glossary/dayparting)
- [Best Quartile alternatives 2026 — atom11](https://www.atom11.co/blog/quartile-alternatives-2026) · [Retail media automation 2026 — Osmos](https://www.osmos.ai/blog/automation-auctions-the-science-of-scalable-retail-media)

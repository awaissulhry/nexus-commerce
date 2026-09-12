# RD — Rank & Dayparting Schedules: study 5 of 11

*Rules & Automation, tab-by-tab, right to left.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md) · [4 · Budget Schedules](2026-08-11-bs-budget-schedules-study.md).*
**Read-only study. Nothing was changed. No code was written. The operator's "do not touch Rank
Goals" boundary is respected — this observes, it does not propose edits to the builder.**

Measured on production 2026-08-11 with `apps/api/scripts/_rd-study.mts` and `_rd-study2.mts`.

---

## 0 · The one-sentence version

This is the only tab in the section whose engine writes to Amazon continuously and correctly — and
**its feedback loop is reading a data feed that died 16 days ago**: every one of the 16 schedules
targets a 10% rest-of-search impression share, the signal the engine reads says **0.15%–0.97%**,
that signal comes from a week with **85 rows**, and for an entire product line (10 AIRMESH
campaigns) there is **no signal at all**.

---

## 1 · What the tab is, and every wire behind it

```
/marketing/ads/rules-automation/dayparting          (routed — its own page)
└── dayparting/DaypartingSchedulesClient.tsx
    └── tabs/RankGoalsList.tsx           the schedule list
        ├── dayparting/ScheduleRowActions · ArmPreview · Next24Preview · WeekShape
        ├── dayparting/ScheduleVersions · ScheduleEvents · CoveragePanel · TemplateLibrary
        ├── dayparting/ScheduleActivityDrawer → ScheduleActivity (what the ENGINE did)
        └── dayparting/scheduleHealth.ts · selectionToWindows.ts  (+ vitest for both)

Builder  builder/dayparting-schedule → _rank/RankGoalBuilder.tsx
         (?style=classic → _schedule/ScheduleBuilder.tsx)
         _rank/: RankTimeGrid · RankPlanBody · RankTargetEditor · RankBlendEditor
                 RankTemplateModal · DemandReadout · DeliveryChip · scheduleConflicts (+test)

Authoring   RankScheduleGroup  ─┬─ RankScheduleVersion  (plan-edit history)
                                └─ RankScheduleEvent    (dated overrides)
Execution   AdSchedule (one per campaign, bound by groupId)
Goals       RankTarget (the reusable goal library)  ·  RankScheduleTemplate
Engines     ad-rank-defend (goal mode)  ·  ad-dayparting (classic pause/multiplier mode)
```

**29 components, two engines, six tables, three vitest suites.** This is a serious piece of
software and it is the only tab in the section that behaves like one.

### The model is genuinely good, and the schema comments say why

- **`RankScheduleEvent`** exists because *"today the only way to run an event is to hand-edit the
  plan and remember to hand-revert it, and forgetting the revert is how an all-out Black Friday plan
  quietly runs through December."* Lead-in / event / lead-out are separate rows on purpose.
- **`RankScheduleVersion`** exists because without it *"`saveRankScheduleGroup` overwrites `windows`
  in place and the question 'what changed, and when did this schedule start behaving differently' is
  unanswerable."*
- **`RankTarget`** models a rank goal as `{placement + targetIS + ACoS/CPC guardrails}` — which is
  the correct abstraction, and the one the enterprise tier charges for.
- **`AdSchedule.lastApplied`** carries a warning that two writers mean different things by it.

Whoever built this understood the problem.

---

## 2 · The measured state

### The authoring layer — 16 groups, 4 armed

| group | on | mkt | campaigns | windows | baseline | updated |
|---|---|---|---|---|---|---|
| IT AIREON | **ON** | — | 11 | 65 | rest-of-search | 2026-07-28 |
| IT AIRMESH | **ON** | — | 10 | 92 | rest-of-search | 2026-07-31 |
| IT GALE JACKET | **ON** | — | 11 | 92 | rest-of-search | 2026-08-01 |
| Rank plan — GALE EXACT DE | **ON** | DE | 1 | 92 | rest-of-search | 2026-07-02 |
| 12 more "Rank plan —" / "Time×rank —" | ✗ | mixed | **1 each** | 89–92 | rest-of-search | 2026-07-02 |

The 12 disabled groups were all created in one batch on 2026-07-02, one campaign each. The 4 live
ones cover **33 campaigns**. Two are unscoped to a marketplace despite being named "IT ".

### The execution layer

| | |
|---|---|
| `AdSchedule` rows | **45** (33 enabled) |
| bound to a group | 45 — **0 orphans** ✅ |
| evaluated ever | 35 · most recent tick **2026-08-11 00:45** |
| `lastApplied` | **`pause` = 33** · null = 10 · `ENABLED` = 2 |
| with per-campaign target overrides | 12 |

**All 33 live schedules were holding `pause` at 00:45 Rome** — which in this system means *floor the
bid*, not stop the campaign (consistent with the standing no-pause policy). At 00:45 that is exactly
right. It is a night-time snapshot, not a fault.

### The goal library — 5 targets, all sane

| key | placement | IS target | ACoS cap | max CPC | bias | all-out |
|---|---|---|---|---|---|---|
| own-top | TOP | 70% | 45% | €1.50 | 150% | — |
| defend-top | TOP | 35% | 35% | €1.20 | 75% | — |
| **rest-of-search** | **REST** | **10%** | **30%** | **€0.80** | **45%** | — |
| pause | TOP | — | — | — | 0% | — |
| own-top-allout | TOP | 90% | *(ignored)* | **€2.00** | 300% | **YES** |

✅ **All-out targets with no CPC ceiling: 0.** `own-top-allout` carries a €2.00 hard ceiling. An
earlier note in my own memory recorded "EVERYDAY rank modes are unbounded" — **that is now stale and
I am correcting it**: the runaway guard is in place.

🔴 **Every single group — all 16 — uses `rest-of-search` as its baseline.** `own-top` and
`defend-top` are defined, tested, and used by nothing. The account has a rank system aimed
exclusively at the cheapest lane.

*(That is, incidentally, the right lane on the evidence — study 3 measured rest-of-search out-earning
top-of-search in all four markets. But it means the "Rank" half of "Rank & Dayparting" is not being
used for rank at all.)*

---

## 3 · 🔴 The engine is chasing a target using a dead feed

The baseline on every group is `rest-of-search`, target **10% impression share**. Per
`ad-rank-defend.job.ts:317`, the REST lane's feedback signal is **not** Amazon's top-of-search
share — it is `sqpImpressionShareForAsins()`, i.e. Brand Analytics SQP.

**What that function returns today, per live campaign:**

| campaign group | ASINs | SQP share the engine reads | target |
|---|---|---|---|
| GALE (13 campaigns) | 18 | **0.15%** | 10% |
| AIREON (10 campaigns) | 40 | **0.20%** | 10% |
| GALE EXACT DE | 18 | **0.97%** | 10% |
| **AIRMESH (10 campaigns)** | 20 | **NO SIGNAL** | 10% |

- **23 campaigns have a signal. 10 have none** — an entire product line, flying blind.
- Those with a signal are **10× to 67× short** of their target.
- 🔴 **The signal comes from the week of 2026-07-26 — 16 days old, containing 85 rows** (against a
  ~2,000-row norm; see study 1 §5).

### And the function cannot tell

```ts
// sqp.service.ts:191
const rows = await prisma.searchQueryPerformance.findMany({
  where: { marketplace, asin: { in: asins } },
  orderBy: { startDate: 'desc' }, take: 3000, …
})
const latest = +rows[0].startDate          // ← MAX(startDate), whatever it is
```

**There is no recency guard.** It takes the newest week present and returns it as current. A feed
that stopped a month ago produces a confident number indistinguishable from a fresh one.

**The consequence:** the engine sees 0.15% against a 10% goal on every tick, concludes it is
massively short, and pushes placement bias upward — bounded only by the 30% ACoS cap and the €0.80
CPC ceiling. It has made **15,185 placement writes in 60 days** (study 3). Those guardrails are
doing the real work; the goal is not.

**This is the same root cause as studies 1, 2 and 4.** The stalled SQP cron is not a reporting
inconvenience — **it is the feedback loop of the only optimisation engine this account actually
runs.**

### Correcting my own measurement

My first pass compared these schedules against `topOfSearchIS` and produced a cheerful "20 hitting
goal, 8 short". **That was the wrong number** — `topOfSearchIS` is the TOP lane's signal, and every
group targets the REST lane. The table above is the correct comparison. I am recording the error
because the wrong version looked entirely plausible.

---

## 4 · Two governance objects, both empty

| object | rows | why it was built |
|---|---|---|
| `RankScheduleEvent` | **0** | so an event reverts itself instead of "quietly running through December" |
| `RankScheduleVersion` | **0** | so "when did this schedule start behaving differently" is answerable |
| `RankScheduleTemplate` | **5** ✅ | saved plans — the one that is used |

**Versioning is wired** (`ads-create.service.ts:1195` creates a row when the plan meaningfully
differs from the previous one). Yet three groups were updated on 2026-07-28, 07-31 and 08-01, and
**zero version rows exist**. Either those edits took a path that bypasses `saveRankScheduleGroup`,
or the difference check never fires. **Worth a specific check — I am flagging it, not asserting it
is broken.**

`ScheduleVersions.tsx` and `ScheduleEvents.tsx` are both built and rendered. Two finished features
with no data.

### The engines

| cron | runs | last |
|---|---|---|
| `ad-rank-defend` (goal mode) | **6,262** | 2026-08-11 00:45 |
| `ad-dayparting` (classic pause/multiplier) | **6,866** | 2026-08-11 00:45 |
| `top-of-search-defense` | **NEVER RUN** | — |

Two engines run every tick. `ad-dayparting` handles classic `bidMultiplierPct` windows;
`ad-rank-defend` handles goal windows. Every live row is goal mode — so `ad-dayparting`'s 6,866 runs
are, like the three engines in study 4, **iterating over nothing**.

---

## 5 · How the industry does this

### 5.1 Pacvue — Dynamic Dayparting, the closest thing to a direct competitor

| | |
|---|---|
| **data** | **Amazon Marketing Stream**, hourly |
| **window** | trailing **14 days, excluding the most recent 2** (attribution settling) |
| **refresh** | daily |
| **logic** | raise bids in historically high-CVR hours, cut in low-CVR hours — automated hourly, no manual step |
| **UI** | *Automated Insights* — historical hourly CVR **plus Pacvue's recommended bid adjustment for every hour of every day of the week** |
| **reported results** | three beverage brands: **+31% revenue · +26% ROAS · +7% CVR · +33% iROAS**; Olly reduced CPC |

Three things to steal from that spec:

1. **Exclude the most recent 2 days.** Attributed sales are still landing; optimising on them chases
   noise. **We do not do this** — study 4's hour-of-day table includes yesterday.
2. **CVR, not ROAS, as the hourly signal.** More stable at hour grain, where our own 04:00 = 17.19×
   on €4.72 shows how badly ROAS behaves on thin cells.
3. **Show the recommendation next to the observation.** The grid displays what each hour did *and*
   what the system would do about it, before it does it.

### 5.2 The field

| platform | approach | notable |
|---|---|---|
| **Pacvue** | fully automatic hourly, AMS-fed | enterprise, $50k+/mo advertisers; 24×/day keyword scraping for the SOV side |
| **Skai** | Budget Navigator — daily bid *and* budget algorithms across 100+ publishers | portfolio algorithm, not a painted grid |
| **CommerceIQ** | bid/budget pacing off 50+ shelf-aware signals | dayparting responds to stock and Buy Box too |
| **Sellozo · Scale Insights · Ad Badger** | rules-based dayparting; Ad Badger adjusts hourly | you own the logic |
| **SellerMetrics · Zon.Tools · Xmars** | bid, budget **and placement multipliers** by hour/day | the same grid drives all three |

### 5.3 What the industry does NOT have, and we do

**A rank goal as a first-class object.** Pacvue's dayparting is *"bid ×N in hour H"*. Ours is
*"hold 10% of rest-of-search, spending no more than 30% ACoS and €0.80 CPC, in these windows"* —
a closed loop with guardrails, per lane, with per-campaign overrides and a reusable library.

`RankTarget.lanes` goes further still: **drive Top, Rest and Product Pages simultaneously in one
blended write**, each with its own signal source (Top = Amazon Top-IS, Rest = SQP share, Product =
open-loop). I did not find a competitor documenting a blended multi-lane closed loop.

**We are ahead here.** The gap is not capability — it is that the loop is being fed dead data, and
that nothing on screen says so.

### 5.4 The 2026 feature bar

1. **A 7×24 grid coloured by performance**, with the plan painted on top of it. *(We have
   `RankTimeGrid` + `DaypartingHeatmap` — ✅)*
2. **Recommendation shown beside observation** before arming. *(`ArmPreview`, `Next24Preview` — ✅)*
3. **Exclude unsettled attribution days.** *(❌)*
4. **CVR-based hourly signal.** *(❌ — we use impression share)*
5. **Events that revert themselves.** *(built, 0 rows)*
6. **Plan history.** *(built, 0 rows)*
7. **Signal freshness surfaced.** *(❌ — and this is the one that matters most here)*
8. **Conflict detection between overlapping schedules.** *(`scheduleConflicts.ts` + tests — ✅)*

---

## 6 · What could be implemented, cheapest first

### Tier 0 — make the loop honest *(hours)*
- 🔴 **Add a recency guard to `sqpImpressionShareForAsins`.** Return `null` — or a flagged stale
  value — when the newest week is older than N days. Right now a dead feed and a live one are
  indistinguishable to the engine. This is a handful of lines and it is the single highest-value
  change identified across all five studies.
- **Surface signal freshness on the schedule list.** Each group shows the age and row count of the
  data its loop is reading. "Optimising on data from 16 days ago" belongs on screen.
- **Show the 10 no-signal campaigns as no-signal**, not as campaigns quietly at 0%.

### Tier 1 — fix the feed and the gap *(days)*
- **Restart the SQP cron** (study 1 §5). Everything above is downstream of it.
- **Investigate the 0 version rows** against three groups edited in the last two weeks.
- **Reconcile the target with reality.** A 10% rest-of-search goal against a measured 0.15% is not a
  goal, it is an unreachable ceiling that keeps the loop permanently in "push" — the guardrails, not
  the target, are deciding behaviour. Either the target is wrong or the measurement is.
- **Retire or seed `ad-dayparting`** — 6,866 runs, zero classic-mode rows.

### Tier 2 — adopt what Pacvue proved
- **Exclude the last 2 days** from the hourly window.
- **Add a CVR-based hourly signal** alongside impression share.
- **Use the 12 dormant single-campaign groups or delete them** — one batch from 2026-07-02, never
  armed.

### Tier 3 — the thing only we can build
`RankTarget.lanes` (blended Top + Rest + Product in one write) is already modelled and, on the
evidence of study 3, is exactly the mechanism for the operator's page-one goal: put several ASINs
on one results page by aiming them at different lanes. **The schema is done. Nothing uses it.**

---

## 7 · How this tab is *supposed* to be

> **One question: what is each campaign being asked to hold, right now — and is it holding it?**

- **Goal, actual and signal age on every row.** Target 10% · actual 0.15% · *from data 16 days old*.
  Two of those three exist today; the third is what turns a chart into a decision.
- **No-signal stated as no-signal.** Ten campaigns are being optimised blind and nothing says so.
- **The 7×24 grid as the primary surface**, plan painted over measured performance — already built.
- **Events and versions in use**, not merely available.
- **One engine list**: which loop owns this campaign this hour, and what it last did.
- **Rank targets that are reachable.** A goal the loop can never satisfy makes the guardrail the
  real policy, invisibly.

---

## 8 · What I need from you

1. 🔴 **The recency guard — shall I do it?** It is small, isolated to one function, and it is the
   difference between an engine that knows it is blind and one that does not. Of everything in five
   studies, this is what I would fix first.
2. **Is 10% rest-of-search the right target?** Measured share is 0.15%–0.97%. Either the goal needs
   to come down to something the loop can converge on, or we accept that the ACoS/CPC caps are the
   real policy and say so out loud.
3. **The 10 AIRMESH campaigns have no signal at all.** Do they have SQP coverage that lapsed, or
   were their ASINs never in Brand Analytics?
4. **12 dormant groups from one batch on 2026-07-02** — delete, or arm?
5. **`ad-dayparting`: 6,866 runs, zero rows.** Same question as the three engines in study 4.

---

## Appendix — scripts

| script | measures |
|---|---|
| `_rd-study.mts` | 16 groups · 45 execution rows · the 5-target library · events/versions/templates · engine run counts |
| `_rd-study2.mts` | the engine's ACTUAL rest-of-search signal per live campaign, and the age of its source |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [A leading beverage manufacturer achieves 31% revenue growth with Pacvue's Dynamic Dayparting](https://pacvue.com/customerstories/a-leading-beverage-manufacturer-achieves-31-revenue-growth-with-pacvues-dynamic-dayparting/) ·
  [Olly: automated dayparting reduced CPC](https://pacvue.com/customerstories/olly/) ·
  [Adjusting dayparting during shopping events using SOV data — Pacvue](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Dayparting in Amazon PPC: bid by hour of day — SellerStack](https://www.sellerstack.ai/glossary/dayparting)
- [Pacvue vs Perpetua — SmartScout](https://www.smartscout.com/blog/pacvue-vs-perpetua-which-ppc-bid-management-tool-is-best-for-you)
- [Best Amazon PPC automation software 2026 — Xneeti](https://xneeti.com/blog/best-amazon-ppc-automation-software) ·
  [24 best Amazon PPC software solutions — The Retail Exec](https://theretailexec.com/tools/best-amazon-ppc-software/)

# RD — Rank & Dayparting: the page, its sections, and what each one owns

*Structure proposal, 2026-08-12. Written for approval before any code.
Evidence: [`2026-08-11-rd-rank-dayparting-page.md`](2026-08-11-rd-rank-dayparting-page.md) (study, 2nd pass).
Every number below was measured on production 2026-08-11; none is re-derived here.*

---

## 0 · The one job

> **What is each campaign being asked to hold right now, is it holding it, and if not — what is
> stopping it?**

The page today answers half of that. It says *what* is being held (`Now holding`) and *whether the
loop ran* (`Health`). It cannot say **whether the loop can do anything**, which is the answer that
matters on all 33 live campaigns:

- **29 of 33 are open-loop** — `maxBiasPct` is null, so the controller never reads the goal.
- **10 of 33 are pinned by the CPC ceiling**, five of them at Top **+0%** — the opposite of their target.
- **4 of 33** chase, and have been stuck at Top 3–6% against a 100% floor since 2026-08-01.
- **10 of 33 have no feedback signal at all**; AIRMESH has never had Brand Analytics coverage.

Today every one of those 33 rows reads **`Health: OK`**.

### The structural flaw, in one line

**The list is group-grained. Every defect is campaign-grained.** One row called "IT GALE JACKET"
hides eleven campaigns with four different fates. There is no campaign-level view on this page at
all. That is the single thing the rebuild must fix.

---

## 1 · Boundaries

### 1.1 Off limits — the builder (operator directive, unchanged)

`builder/dayparting-schedule` → `_rank/RankGoalBuilder.tsx`, all of `_rank/*`,
`_schedule/ScheduleBuilder.tsx`, `_schedule/CampaignSection.tsx`, `_schedule/dayparting.css`,
`dayparting/ArmPreview.tsx`, `dayparting/ScheduleEvents.tsx`, and **the shared
`rules-automation.css`**.

**Consequence — decision D1 below:** this page gets its own stylesheet. `rules-automation.css` is
named in the boundary, so even an append-at-EOF addition is a change to a protected file. A
page-scoped `rank-dayparting.css` imported only by this route touches nothing the builder renders.

**Also consequence:** the *goal library* (`RankTarget`) is edited in `_rank/RankTargetEditor.tsx`,
which is inside the boundary. This page may **read and explain** a target — "this target cannot
chase, its ceiling equals its floor" — but must not offer to edit one. Editing stays in the builder.

### 1.2 What each neighbouring page owns

I read *"features should not be mixed with any other page"* as: **one feature, one owner, no
duplication and no reaching in.** Correct me if you meant the opposite.

| page | owns | must not |
|---|---|---|
| **5 · Rank & Dayparting** *(this one)* | the **plan and the goal** — which target governs which hour, for which campaigns; arming; whether each loop *can* converge; events; versions | set a placement % by hand |
| **3 · Placement** | the **outcome per placement** — current Top/Rest/Product bias, what moved it, per-placement performance | author schedules; add a second writer to `PLACEMENT_TOP` |
| **9 · Bid** | the **base bid** the multipliers stack on, min-bid floors, and the CPC ceiling's *inputs* | move placement multipliers |
| **4 · Budget Schedules** | budget-by-hour | bid/placement-by-hour |
| **10 · Automations / 11 · Apply Rules** | rules | schedules |

**The seam that will bite:** the CPC ceiling lives on the `RankTarget` (this page) but is breached by
base bids owned by page 9. Five AIRMESH campaigns are pinned at Top +0% for exactly this reason.
Whichever page shows the refusal must deep-link to the other, or the operator sees "capped at 0%"
with no route to the number that caused it. **Both pages link; neither duplicates.**

---

## 2 · The control model

Everything on the page obeys one scope, and the scope is in the URL.

```
market  ⊃  portfolio  ⊃  product line  ⊃  campaign
   IT        IT GALE JACKET   GALE          GALE | IT | Exact | Brand
```

**Why portfolio is the natural spine here, measured:** 3 of the 4 live groups are portfolio-scoped
(`portfolioId` set).

**Why market must be DERIVED from members, corrected 2026-08-12 by RD-P0:**
`RankScheduleGroup.marketplace` is **null on 9 of 16 groups** — all three big IT groups and both
DE-named ones. Filtering on the stored column would hide DE groups from a DE filter. *An earlier
draft of this section justified derivation with "a group can span IT + DE". Measured: **0 of 16 do.**
That was a model possibility stated as an observed fact. The set-valued contract stays because it
costs nothing and the schema permits it — but the measured reason is the nine nulls.*

**Every control, ceiling and filter on this page resolves at one of those four levels**, most
specific wins — the same precedence the engine already uses for `targetOverrides`
(library → product → campaign, `applyTargetOverrides`).

---

## 3 · The section map

Each is one build session with its own prompt.
**Build order is D4: P0 → P2 → P1 → P4 → P3 → P6 → P5 → P7** — not the order they appear on screen.

**On-screen order — and it changes today's, deliberately.** RD-P0 measured the live page: the
heatmap (411px) and coverage panel (47px) sit *above* the grid, so **the grid — the page's actual
subject, all 16 rows of it — starts at y=739 and is entirely below the fold.** The evidence outranks
the thing it is evidence for. The rebuilt order puts the subject first:

```
header → tabs → scope bar → P1 band → P2 grid → P6 evidence (hourly + coverage) → P7 governance
                                        ▲ P3 inspector, P4 signal, P5 guardrails live inside/beside the grid
```

| § | section | grain | what it owns | gate |
|---|---|---|---|---|
| **P0** | **Foundation** | — | route shell, scope contract + URL, section slots, page stylesheet, one data layer | — |
| **P1** | **Fleet state band** | fleet | the one-glance answer; every tile is a filter | P0 |
| **P2** | **The grid — two grains** | group ⇄ **campaign** | schedules *and* campaigns in one grid, switched | P0 |
| **P3** | **Row inspector** | row | *why* — the engine's own reason, next 24h, activity | P2 |
| **P4** | **Signal & freshness** | row | goal · actual · signal age, three states never merged | P2 |
| **P5** | **Guardrails & scope ceilings** | scope | spend ceilings per market/portfolio/product/campaign; refusals made visible | P1 |
| **P6** | **Evidence — hourly + coverage** | scope | the 7×24 grid, honest about volume; unscheduled campaigns | P0 |
| **P7** | **Governance — events, versions, log** | group | dated overrides, plan history, change log | P2 |

### P1 · Fleet state band

Six tiles, each a filter onto the grid below. Measured values today:

| tile | today | meaning |
|---|---|---|
| **Holding** | 29 | snap-and-hold; the goal is not being pursued |
| **Chasing** | 4 | a real closed loop (ceiling > floor) |
| **Capped** | 10 | the CPC ceiling, not the target, is deciding |
| **Blind** | 10 | no feedback signal at all |
| **At min bid now** | varies by hour | bids floored, campaign live |
| **Unscheduled** | — | campaigns no schedule covers |

*(Tiles overlap by design — a campaign can be Capped **and** Blind. The band reports states, not a
partition.)*

### P2 · The grid — two grains

**One `AdsDataGrid`, one segmented control: `Schedules (16)` ⇄ `Campaigns (45)`.** Same scope, same
filters, same URL. This is the section that fixes §0's structural flaw, and it is the one I would
build first after the foundation.

**Schedules grain** — Name · Now holding · **Mode** · **Goal vs actual** · **Signal** · Market ·
Portfolio · Campaigns · Week shape · Last run · **Health** · Status · *(Spend/Sales/ACoS 30d, hidden)*

**Campaigns grain** — Campaign · Schedule · Now holding · **Mode** · **Live placement** (Top/Rest/Product) ·
**Goal vs actual** · **Signal** · **Ceiling state** · Last run · **Health** · Status · *(metrics hidden)*

Four new columns carry the whole argument:

- **Mode** — `Holding 150%` · `Chasing 55% IS` · `Capped 0% by €1.50 CPC`. Derived from
  `biasBand()` + `cpcCapPct()`, both pure functions that already exist.
- **Goal vs actual** — `55% vs 35.0% IS`, or a **dash** where no goal is live. Printing a dead goal
  as live is the lie the page currently tells 29 times.
- **Signal** — `Top-IS · 1d` / `SQP · 17d, 85 rows (norm ~1,200)` / `no coverage`.
- **Health** gains one state above `OK`: **"Cannot converge"** — ceiling equals floor while a target
  IS is set, or the ceiling pins the placement below the floor.

### P3 · Row inspector

The engine computes a full `reason` string every tick and throws it away outside the drawer
(`ad-rank-defend.job.ts` — `blendReason`, `capNote`, the controller's own reasons). Surface it.
Per row: what it holds now and why · the next 24 hours · what it last wrote · what it **refused** to
write and on whose authority.

### P4 · Signal & freshness

Three states, never merged: **fresh** (value + age) · **stale** (age **and** row count vs trailing
norm) · **never covered** (an onboarding problem, not a cron problem).

**Shared:** the recency guard on `sqpImpressionShareForAsins` belongs to tabs 1, 2 and 5 jointly —
this page states the requirement and consumes the shared chip; it does not build the guard.
**Refinement this page contributes:** age alone is insufficient — the newest SQP week is a
*collapsed partial* (IT: 8 rows vs 655 the week before), which any pure age guard would pass.

### P5 · Guardrails & scope ceilings

Your standing ask: **spend ceilings per scope — market · product line · portfolio · campaign, never
one global number. At the cap: refuse the write and say so.**

That feature is already happening and already failing silently: the CPC ceiling refuses writes on 10
of 33 campaigns and its entire response is `logger.warn` every 15 minutes. **P5 makes an existing
refusal visible before it adds a new ceiling.**

### P6 · Evidence — hourly + coverage

The 7×24 grid is already correct where it counts (Rome wall-clock via the `AT TIME ZONE` double-cast,
whole weeks, today excluded, DB clock). Two honest additions:

- **Exclude the last 2 unsettled days** — the field standard; we include them today.
- **State the volume floor.** Measured: **49 orders across 168 weekday×hour cells in 8 weeks**;
  busiest cell = 3. **We must not ship a CVR-by-hour heatmap** — it would render noise as insight.
  The page should say the data is too thin rather than colour it in.

### P7 · Governance

Events are fully wired and inert (0 rows) — nothing to fix, something to *use*. Versions need one
repair: the list's **Enable/Pause takes the lightweight PATCH path and writes no version**, so the
most consequential click on the page leaves no history.

---

## 4 · Data contracts the sections need

| need | today | required |
|---|---|---|
| campaign-grain runtime | ✗ — group aggregates only | one endpoint returning per-campaign: resolved target, mode, band, live placement, signal + age, ceiling state, last run |
| mode / ceiling state | computed nowhere | server-side, from `biasBand()` + `cpcCapPct()` — **reuse, do not reimplement**; a second copy would drift from the engine |
| signal freshness | ✗ | age **and** row count vs trailing norm, per lane |
| URL state | ✗ — **no `useSearchParams` anywhere on this page** | `?market= &portfolio= &product= &grain= &row= &drawer= &tile=` |
| real-time | ✗ | the engine moves rows every 15 min; poll a cursor. **The ads SSE bus carries 0.21% of writes — do not use it.** |

---

## 5 · Decisions — SETTLED, operator-approved 2026-08-12

**These are closed. Do not re-ask them; cite this section.**

| # | decision | settled as |
|---|---|---|
| **D1** | `rules-automation.css` is inside the builder boundary | ✅ **Page-scoped `rank-dayparting.css`**, imported by this route only. Touches nothing the builder renders. |
| **D2** | Campaign grain — a toggle on one grid, or a second grid? | ✅ **One grid, one segmented control.** Proven in this repo (fleet map entity mode); half the code; scope and filters stay in one place. |
| **D3** | May the page *read and explain* the goal library? | ✅ **Yes, read-only.** "This target cannot chase" is the page's core message. Editing stays in the builder. |
| **D4** | Build order after P0 | ✅ **P2 → P1 → P4 → P3 → P6 → P5 → P7.** The grid is the page; the band summarises the grid, so the grid comes first. |
| **D5** | Does "commit and push after each verified unit" apply here? | ✅ **Yes.** The local-only override covers ads-console/RPT, not this surface. |

## 6 · What this structure deliberately does NOT do

- It does not touch the builder, or propose to.
- It does not build the SQP recency guard — that is shared with tabs 1 and 2.
- It does not build a CVR-by-hour signal — measured too thin (§P6).
- It does not arm anything. Every section ships as a **truthful view first**; changing engine
  behaviour (giving `own-top` a ceiling) is a separate, explicit, one-group-first decision.

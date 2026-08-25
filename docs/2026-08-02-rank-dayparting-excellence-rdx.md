# RDX — Rank & Dayparting Schedules: what it is, what the market does, what it should become

**Status:** PROPOSAL AWAITING GATE · 2026-08-02
**Surface:** `/marketing/ads/rules-automation/dayparting` (the live console). `/marketing/ads-console` and `/marketing/advertising` are legacy.
**Predecessor:** `docs/2026-08-01-dayparting-schedules-dps.md` (DPS.0–4 shipped 2026-08-02, commits `84ee80e50`, `a01afef81`, `7705a0256`).

**Working rules for this engagement**
1. Nothing is implemented before an explicit gate.
2. Everything stays **local** — no commit, no push, until you say so.
3. **"Your rank goal & schedule" is untouchable.** `RankPlanBody` and everything it owns (`RankTimeGrid`, `rank-grid-model`, `DemandReadout`, `RankTargetEditor`, `RankTemplateModal`, the baseline chips, the window list/grid, the live defend preview) get **zero functional changes**. Where a phase below needs to reach the builder, it does so by *pre-seeding the URL* — never by editing that section.

---

## Part 1 — What exists today, and how it is wired

### 1.1 The page

`/marketing/ads/rules-automation/dayparting` → `page.tsx` → `DaypartingSchedulesClient.tsx`. Four things stack:

| # | Component | File | Purpose |
|---|---|---|---|
| 1 | `AdsPageHeader` | `_shell/AdsPageHeader.tsx` | Title "Rules & Automation", subtitle, **market switch**, primary action "+ Rank Schedule" → the builder. `showLearn/showDataSync/showDateRange` all false. |
| 2 | `RulesTabs` | `rules-automation/_shared/tabs.tsx` | The 10-tab bar. Routed tabs get `/rules-automation/<key>`; the rest ride `?tab=<key>`. Dayparting is the only `routed: true` one so far. |
| 3 | `HourlyPerformance` | `dayparting/HourlyPerformance.tsx` | The 7×24 AMS heatmap. Scope (whole account / one schedule), 11 metrics, whole-week windows (2/4/8/13), plain-English "Busiest: …", coverage + restatement disclosure. **Read-only.** |
| 4 | `RankGoalsList` | `tabs/RankGoalsList.tsx` | The schedule list on the shared `AdsDataGrid`. Columns: name + Manage · Baseline rank chip · Campaigns · Windows · Status. Bulk Enable/Pause, search, 2 filters, customise-columns. |

### 1.2 Data flow, end to end

```
RankGoalBuilder  ──POST/PATCH──▶  /advertising/rank-schedule-groups
  (name, campaigns,                      │
   §3 rank plan ← UNTOUCHABLE)           ▼
                              saveRankScheduleGroup()      ads-create.service.ts:777
                                         │
                        ┌────────────────┴──────────────────┐
                        ▼                                   ▼
              RankScheduleGroup  (authoring layer)   AdSchedule × N  (execution layer)
              name, windows, defaultTargetKey,       one row per member campaign,
              targetOverrides, portfolioId,          groupId binds it back
              marketplace, timezone, enabled
                                                            │
                                                            ▼
                                          ad-rank-defend cron  */15  ← the engine
                                          resolveActiveTargetKey(windows, baseline, day, hour)
                                          → decideAndMaybeApply → placement-bias writes
                                            (write-gated per campaign)
```

Signals the engine reads on every tick: Top-of-Search IS (`analyzeTopOfSearch`), a rank-loss proxy from `AmazonAdsHourlyPerformance`, SQP brand share for Rest-of-Search lanes, retail readiness (OOS / lost buy box), family budget + ACoS caps.

The page's heatmap reads the same `AmazonAdsHourlyPerformance` table through `GET /advertising/dayparting/heatmap` (whole weeks, local-midnight boundaries, buckets floored at zero with the count disclosed).

### 1.3 The models

| Model | Role |
|---|---|
| `RankScheduleGroup` | one named schedule spanning many campaigns — the authoring layer, one row in the list |
| `AdSchedule` | one row per campaign — the execution layer the cron actually reads |
| `RankTarget` | the rank swatches (Own Top, Defend Top, Rest of Search, Min bid, All-Out) + motion profile (jump-start, step up/down, ceiling, keep-climbing, ACoS cap, max CPC, blended lanes) |
| `RankScheduleTemplate` | saved windows + baseline, account-global (`/advertising/rank-templates` CRUD) |
| `ProductRankPlan` | the family-level Rank Director plan — a *different* object with its own guardrails and its own `lastEvaluatedAt` |
| `AmazonAdsHourlyPerformance` | Marketing Stream hourly rows — what the heatmap draws |
| `CampaignBidHistory`, `AdvertisingActionLog` | write-level audit trail; **already populated**, never surfaced on this page |

### 1.4 What is genuinely strong here

- **Real hourly signal.** 24 AMS subscriptions ACTIVE across IT/DE/FR/ES since 2026-07-29. Tools charge $500–1,000/mo to provide what we already hold.
- **Rank-goal control, not bid-nudging.** Everything live converges on a *rank target* (hold a Top-of-Search impression share, respect an ACoS ceiling, snap back when the slot is lost). Adtomic/AdLabs daypart bids and pauses; we run a closed loop against a placement outcome. That is a materially harder and better control model, and it is live.
- **Whole-week honesty in the heatmap.** Equal weekday samples, in-progress day excluded, restatements disclosed. Most competitors sum "last 30 days" and quietly hand one weekday a 20% head start.
- **The authoring cockpit is already deep** — paint grid, demand overlay, recommended windows, per-campaign target overrides, templates, live dry-run preview.

### 1.5 What the page is actually missing — evidenced, not speculative

| # | Gap | Evidence in the code |
|---|---|---|
| **G1** | **You cannot tell when a schedule last ran, or what it did.** | `ad-rank-defend.job.ts:490-499` — the schedule branch never writes `AdSchedule.lastEvaluatedAt` / `lastApplied`. Only `ProductRankPlan` (line 485) gets a summary. |
| **G2** | **You cannot tell what a schedule is holding *right now*.** | The engine computes `resolveActiveTargetKey` every tick; the page shows only the *baseline*, which is the target that applies when no window is active. At 22:00 the list still says "Rest of Search". |
| **G3** | **"Active" is a claim, not a health check.** | The status pill reads `enabled`. It is green even if every Amazon write is dead-lettering. (Ref: the ~25/day `AD_BID_UPDATE` dead-letters recorded open on 2026-07-30 — to be re-verified on prod before this phase.) |
| **G4** | **The market switch is a dead control.** | `DaypartingSchedulesClient.tsx:24` holds `market` state, passes it to the header, and **nothing consumes it.** Root cause: `RankScheduleGroup.marketplace` is never written — `RankPlanBody.tsx:143` omits it from the save body, so it is null on all 16 groups. |
| **G5** | **No delete, duplicate or rename from the list.** | `DELETE /rank-schedule-groups/:id` exists and is wired to nothing in the UI. |
| **G6** | **A schedule's shape is a number.** | The "Windows" column renders `windows.length`. You cannot see *when* it pushes without opening the builder. |
| **G7** | **No performance per schedule.** | Nothing tells you which of the 16 schedules earns its keep. Spend/sales/ACoS per group are one join away from data we already have. |
| **G8** | **No coverage view.** | 45 `AdSchedule` rows over 216 campaigns. The 171 uncovered campaigns — including whatever the top spenders are — are invisible on this page. |
| **G9** | **The heatmap is look-only.** | Every competitor authors *from* the grid. Ours renders it and stops. (The paint grid exists — but only inside the builder's untouchable section.) |
| **G10** | **No simulate-before-arm at page level.** | `POST /advertising/rank-defend/run-now?dryRun=1` returns full per-campaign decisions and is already used inside the builder. The page never calls it. |
| **G11** | **Templates are buried.** | `RankScheduleTemplate` + full CRUD exist, reachable only from a modal inside the builder. No library, no bulk apply. |
| **G12** | **No dated/event layer.** | `AdSchedule` and `RankScheduleGroup` have no start/end date, no blackout ranges. `BudgetSchedule` already has `startDate`/`endDate`/`excludeDates`/`neverExpire` — the pattern exists in our own schema. Black Friday needs a hand-edit and a hand-revert. |
| **G13** | **Timezone is fixed to Europe/Rome in the UI.** | The API whitelists 8 zones; the page hardcodes one. Fine while IT is primary, wrong the day DE/FR/ES schedules diverge. |

---

## Part 2 — What the market does

### 2.1 Amazon natively (2026)

Still **no native hourly bid dayparting**. What exists:
- **Schedule-based budget rules** now accept *hours of day* — but they can only **raise budget**. They cannot lower a bid or pause.
- **Bid schedule rules** exist for Sponsored Products, but are **increase-only**, **Sponsored Products only**, and **configured campaign-by-campaign**.
- **Sponsored Products Hourly Report** is now available in Seller Central, and Marketing Stream delivers the same hourly grain to the API.

Everything a serious operator wants is still built on top by third parties. **We already hold the input they resell.**

### 2.2 Best-in-class feature sweep

| Tool | What it gives you |
|---|---|
| **Helium 10 / Adtomic** | Schedules page: hourly graph by day×hour, filter by campaign/period/days, choose the graphed metrics, author from what you see. Hourly data is not retroactive. |
| **Pacvue** (~$1k/mo) | Hourly bid up/down · **templatised dayparting** reusable across campaigns · **Budget Calendar templates** (per-day allocation) · **lead-in / event / lead-out budgets as one workflow** with automatic pacing · Live Ad Momentum real-time pacing · SOV-informed dayparting for shopping events · heatmap over up to 5 metrics. |
| **AdLabs** | Visual schedule builder: a colour-coded 7×24 grid where **every cell is a % bid modifier** (green up / red down / white neutral), applied to **hundreds of campaigns at once** (their screenshot: one schedule over 974 campaigns). Modifiers apply at auction time so bid history stays clean. Built-in calculator that derives recommended modifiers from uploaded hourly data. |
| **Intentwise** | Dayparting *rules*: hourly and weekly frequency, increase/decrease %, pause/resume, driven off Marketing Stream. Two features worth stealing: **a preview of exactly which campaigns/targets a rule will hit before you arm it**, and **automatic Undo** that reverses the specific action at a scheduled time rather than leaving a permanent change. |
| **Perpetua** | Intraday optimisation on AMS: hourly CTR/CPC/CVR/ACoS plus **hourly Share of Voice** — SOV as both benchmark and optimisation target. |
| **Eva** | Heatmap over impressions/clicks/sales/spend/CTR/CVR/ACoS; **select slots directly in the grid, then configure the rule** for bid *or* budget. |
| **SellerMate** | Three dayparting kinds — **bid, budget, placement**. Granularity choice (1h / 4h / 6h). Scope down to campaign, ad group **or individual target**. Four allocation shapes (daily · weekday+weekend · all weekdays · custom date range for sale days). **Detailed activity logs of every bid and budget modification.** |
| **Seller Labs** | Dayparting heatmap filterable **per SKU**, not just per campaign. |
| **Quartile** | Patented hourly bidding, recomputed several times a day from Marketing Stream — notably with **no approval gate, no dry-run, no reconciliation** published. |
| **Adbrew** | Names the native limits explicitly and sells the fix: one rule across many campaigns, **bidirectional** adjustment. |

### 2.3 The patterns that recur everywhere

1. **The 7×24 grid is the primary object** — you look, then you author. ✅ we have this
2. **Direct cell selection on that grid authors the schedule.** ❌ page-level
3. **Metric switcher on the heatmap.** ✅ 11 metrics
4. **A modifier per cell, not just on/off.** ✅ (richer — a *rank target* per cell) but only in the builder
5. **One schedule → hundreds of campaigns.** ✅ groups do exactly this
6. **Templates, saved and reapplied in bulk.** ⚠️ exists, buried, no bulk apply
7. **Preview / simulate before arming.** ❌ engine supports it, page doesn't call it
8. **An activity log of what actually changed.** ❌ data exists, never surfaced
9. **Undo / auto-revert.** ❌
10. **Event phasing — lead-in / event / lead-out.** ❌
11. **Timezone stated on the surface.** ✅
12. **Coverage / bulk apply across the account.** ❌

### 2.4 Industry cautions worth encoding as guardrails

- **Compounding.** Base × day rule × hour rule × placement modifier multiplies. AdLabs' worked example: €1 base + 25% day + 25% hour + 100% placement = **€3.12**. Our engine already caps via `maxBiasPct` (default 900) / `maxCpcCents` / ACoS cap — but the page never shows the resulting ceiling.
- **Don't day-*pause*.** Reducing bids beats shutting an hour off; a pause loses ranking momentum. This matches your standing rule — suppress with ~€0.02 bids, never pause.
- **Data sufficiency.** 30 days minimum, 60–90 preferred; skip dayparting entirely if best-vs-worst hour swings under ~10%. Our heatmap should say when the pattern is too weak to act on.
- **Volume rebalances.** After a schedule arms, the hourly curve *moves* — the old peak stops being the peak. Re-read before re-tuning.

---

## Part 3 — The goal

> **The one page where you can see when your account sells, decide what rank to hold in those hours, arm it across every campaign that matters, and prove afterwards exactly what it did.**

Four properties, in priority order:

1. **Provable.** Every schedule shows when it last ran, what it is holding right now, and what it changed. No green pill over a failing write.
2. **Complete.** The list is a control surface — market, shape, spend, delete, duplicate — and it tells you what the account is *not* covering.
3. **Authored from evidence.** The grid you read is the grid you draw on.
4. **Safe to arm.** Simulate first, see the blast radius, know the ceiling, be able to undo.

Explicitly **out of scope**: the builder's "Your rank goal & schedule" section, the rank-defend decision logic, `RankTarget` semantics, and FBA/inventory anything.

---

## Part 4 — Design system

The standing rule is *new UI from `apps/web/src/design-system` only*. DPS gated a scoped deviation: this console is built from its own vocabulary — `AdsPageHeader`, `AdsSidebar`, `AdsDataGrid`, `h10-*` CSS — and `RankGoalsList` already conforms.

**Recommendation: keep the deviation, re-confirmed for RDX.** Mixing DS components into an `AdsDataGrid` row would make this page visibly foreign to the nine tabs beside it. Every new surface below reuses existing console primitives:

| Need | Reuse |
|---|---|
| list, filters, toolbar, customise, bulk | `AdsDataGrid` (+ `GridColumn` / `GridFilter`) |
| dropdowns with search | `H10Select` (edge-clamped, ranked search from `lib/option-search.ts`) |
| the grid | `DaypartingHeatmap` — same component the builder draws, so a cell means one thing everywhere |
| metric definitions | `_schedule/heatMetrics.ts` — one definition of "ACoS" |
| status pills / chips | `h10-pill`, `h10-rg-chip` |
| detail panel | a right-side drawer in console chrome |

**Gotchas already paid for, to be honoured:** `AdsDataGrid` needs scoped `table-layout: fixed` via a plain global class (never auto + nowrap); `.nds-gridcard` clips a dropdown's last option — hit-test, don't trust the DOM; the pre-push DS ratchet greps *comments*, so never write a bare `<select` in a comment.

---

## Part 5 — Phases

Every phase: built locally · reviewed by you · committed and pushed only on your word. Nothing runs against Amazon that isn't already running.

### Track A — Truth (recommended first)

| # | Phase | What lands | Touches | Risk |
|---|---|---|---|---|
| **A1** | Engine writes its own receipts | `ad-rank-defend` writes `AdSchedule.lastEvaluatedAt` + `lastApplied` on the schedule branch, mirroring what it already does for `ProductRankPlan`. Additive fields, already in the schema. | cron | low |
| **A2** | Runtime on the group endpoint | `GET /rank-schedule-groups` returns per group: `lastEvaluatedAt`, **`activeTargetKey` right now**, members enabled/total, recent write-failure count. | API | low |
| **A3** | The list tells the truth | New columns: **Now holding** (live target chip) · **Last run** (relative) · **Health** (ok / stale / writes failing). Status pill stops being the only signal. | web | low |
| **A4** | Activity log drawer | Click a schedule → drawer with the hour-by-hour change log from `CampaignBidHistory` / `AdvertisingActionLog`, filterable per campaign. The SellerMate "detailed activity logs" pattern, on data we already write. | API + web | low |

### Track B — The list becomes a control surface

| # | Phase | What lands | Risk |
|---|---|---|---|
| **B1** | Market, for real | Derive + persist `RankScheduleGroup.marketplace` from member campaigns (backfill the 16 live rows), add a Market column, wire the header switch to actually filter. **Kills a dead control.** | low |
| **B2** | Row actions | Duplicate · Rename · Delete (confirm states the member count and that member schedules are removed). Uses the existing DELETE endpoint. | low |
| **B3** | Week-shape strip | A 7×24 micro-strip per row, coloured by target, so you read a schedule's shape without opening it. Replaces the bare "Windows: 3". | low |
| **B4** | Performance per schedule | Spend / Sales / ACoS / Orders over the chosen window, aggregated across each group's member campaigns, as sortable grid columns. Answers "which of these earns its keep". | medium |

### Track C — Coverage

| # | Phase | What lands | Risk |
|---|---|---|---|
| **C1** | Coverage panel | "45 of 216 campaigns are on a schedule." Uncovered campaigns ranked by spend, with one click to add them to an existing schedule. | medium |
| **C2** | Standing integrity check | The DPS Phase-0 truth pass made permanent: zero-member groups, campaigns held twice, archived campaigns still holding a live schedule — surfaced continuously instead of audited once. | low |

### Track D — Author from the grid

| # | Phase | What lands | Risk |
|---|---|---|---|
| **D1** | Drag-select on the page heatmap | Select cells on `HourlyPerformance` → "Create schedule from selection" → opens the builder **pre-seeded via URL params**. The builder's plan section is not modified — it receives seed values the same way `?groupId=` already works. | medium |
| **D2** | Seed into an existing schedule | Same selection, "Add to existing schedule…" → opens that group pre-seeded. | medium |

> D1/D2 are the only phases that come near the builder. They are deliberately designed as *inputs* to it. If you'd rather they didn't exist at all, drop this track — nothing else depends on it.

### Track E — Simulate before arming

| # | Phase | What lands | Risk |
|---|---|---|---|
| **E1** | Next-24h preview | For a selected schedule: the 24 hours ahead, hour by hour, with the target each hour resolves to and the projected bias — plus the effective **ceiling** (maxBias / maxCPC / ACoS cap) so the compounding trap is visible. Uses `resolveActiveTargetKey` + the existing dry-run. | medium |
| **E2** | Backtest | "What would this have done last week" against AMS hourly — spend and impressions in the hours it would have pushed. Clearly labelled as an estimate, not a promise. | medium |
| **E3** | Blast-radius confirm | Before arming: N campaigns, N ad groups, N targets affected, written to M markets. The Intentwise preview pattern. | low |

### Track F — Templates as a first-class library

| # | Phase | What lands | Risk |
|---|---|---|---|
| **F1** | Template library on the page | List / preview shape / rename / delete, over the existing `/advertising/rank-templates` CRUD. Out of the modal, onto the page. | low |
| **F2** | Bulk apply | Select N schedules → apply a template's windows + baseline to all of them, with a diff preview before it commits. The Pacvue pattern, and the highest-leverage thing on this list once you run more than ~20 schedules. | medium |

### Track G — Event windows (the biggest new capability)

| # | Phase | What lands | Risk |
|---|---|---|---|
| **G1** | Dated overrides — schema | Additive: a dated override layer over a group (`startDate` / `endDate` / `excludeDates`, or lead-in / event / lead-out phases). Mirrors what `BudgetSchedule` already carries. Additive migration — pre-approved by your standing rule, but I'd still show you the DDL first. | medium |
| **G2** | Engine honours it | `resolveActiveTargetKey` consults the dated layer before the weekly layer. **This changes live bid behaviour — its own hard gate, with a dry-run diff across all 33 live schedules before anything arms.** | **high** |
| **G3** | Event UI | Author Black Friday / Prime Day as lead-in → event → lead-out in one flow, with automatic revert to the weekly plan afterwards. | medium |

### Track H — Housekeeping (carried over from DPS.9)

| # | Phase | What lands | Risk |
|---|---|---|---|
| **H1** | Retire legacy dayparting | Remove the two live cross-links (`AdvertisingSidebar.tsx:31`, `AppShell.tsx:26`), then the `/marketing/ads-console` + `/marketing/advertising` dayparting surfaces. | needs its own gate |

### Recommended order

**A1 → A2 → A3 → B1 → B2 → A4 → B3 → C1 → E1/E3 → F1 → F2 → B4 → C2 → D1 → E2 → G → H**

Rationale: the page currently shows a green "Active" pill over an engine whose failures are invisible, and a market switch that does nothing. Trust and dead controls come before new capability. Track G is last because it is the only one that changes what the engine does to live bids.

### Mapping from the old DPS phases

| Old | Now |
|---|---|
| DPS.5 drag-select | **D1/D2** — re-scoped to the *page* heatmap, because the builder already has a paint grid and it is off-limits |
| DPS.6 templates | **F1/F2** — the model and CRUD already shipped; what's missing is the library and bulk apply |
| DPS.7 simulate | **E1–E3** |
| DPS.8 observability | **A1–A4** — expanded, now that `CampaignBidHistory` is confirmed populated |
| DPS.9 retire legacy | **H1** |

---

## Part 6 — Decisions, GATED 2026-08-02

| # | Decision | Chosen |
|---|---|---|
| 1 | **Order** | **Track A first** — truth before capability. The page cannot keep showing a green pill over an engine whose failures are invisible. |
| 2 | **Track G — event windows** | **In, but last.** G2 (the engine change) gets its own hard gate with a dry-run diff across all live schedules before anything arms. |
| 3 | **Track D — grid authoring** | **Keep, URL-seed only.** The builder's plan section stays byte-identical; it receives seed params exactly as `?groupId=` already works. |
| 4 | **Design system** | **Ads-console native.** `AdsDataGrid` / `H10Select` / `DaypartingHeatmap` / `h10-*`. Re-recorded as a deliberate, scoped deviation from the standing design-system-only rule. |

Still open: whether the `AD_BID_UPDATE` dead-letters get investigated inside Track A or tracked separately. A3 makes them **visible**; it does not fix them.

---

## Part 7 — Track A — **BUILT LOCALLY 2026-08-02, awaiting your review. Not committed, not pushed.**

Gated additions to the spec below: `lastApplied` holds the **target key** (approved); dead-letters are **tracked separately** — A3 makes them visible, it does not fix them.

**What landed**

| File | Change |
|---|---|
| `apps/api/src/jobs/ad-rank-defend.job.ts` | A1 receipts + exported pure `groupReceipts` |
| `apps/api/src/routes/advertising.routes.ts` | A2 runtime on `GET /rank-schedule-groups`; A4 `GET /rank-schedule-groups/:id/activity`; `scheduleNowInTz` helper |
| `packages/database/prisma/schema.prisma` | comment only — `lastApplied` now documents its two writers. **No migration.** |
| `apps/web/.../dayparting/scheduleHealth.ts` (+ test) | the health policy, pure and testable |
| `apps/web/.../dayparting/ScheduleActivityDrawer.tsx` | A4 drawer |
| `apps/web/.../tabs/RankGoalsList.tsx` | A3 columns + health filter + drawer wiring |
| `apps/web/.../rules-automation.css` | health tones, live-chip emphasis, drawer rows |

**Verified:** `tsc --noEmit` clean on both apps · 14 API job tests pass (4 new for `groupReceipts`) · 8 new `scheduleHealth` tests pass · `ad-dayparting` tests still pass.

**Not yet verified:** the columns against real runtime. A2/A4 read fields only A1 writes, and A1 only writes when the cron runs on prod — so until this deploys, the page degrades to "Never run" everywhere (by design, and worth seeing).

> **CORRECTED 2026-08-03 by HX.1–HX.3** (`docs/2026-08-03-ads-history-audit-hx.md`). As first built, A2 and A4 read `CampaignBidHistory` / `AdMutation` — tables that the rank loop's **main** action, the placement-bias write, never wrote to. A4 therefore showed "No changes recorded yet" for a schedule working perfectly, and A2's `failedWrites` was a structural zero, so **Health rendered "OK" while every placement push failed**. HX.1–HX.3 put placement writes on the audit spine, gave them an actor and a truthful outcome, and taught both A2 and A4 to read the inline delivery path. Do not push A2/A4 without those corrections.

---

### The original spec

Two discoveries make this cheaper and sharper than the DPS.8 sketch assumed.

**Discovery 1 — the audit trail is already keyed by schedule.** `decideAndMaybeApply` is called with `actor: automation:rank-defend-${s.id}` (`ad-rank-defend.job.ts:497`), and that actor string is persisted verbatim onto **both** `CampaignBidHistory.changedBy` (`ads-mutation.service.ts:495`) **and** `AdMutation.actor` (`ads-mutation.service.ts:197`). So "what did schedule X change, and did the write land" is a direct query on existing, already-populated data. No new logging, no migration.

**Discovery 2 — a silent governance overlap.** `ad-rank-defend.job.ts:491` skips any campaign governed by a `ProductRankPlan` family plan: `if (governed.has(s.campaignId)) continue`. A campaign can therefore sit in a rank schedule, show "Active", and **never be evaluated by that schedule** because Rank Director owns it. Nothing surfaces this today. A3 should.

### A1 — the engine writes its own receipts

`ad-rank-defend.job.ts`, schedule branch (~line 490-499). After `decideAndMaybeApply`, and only when `!dryRun`, write `lastEvaluatedAt: new Date()` and `lastApplied: <resolved target key>` on the `AdSchedule` row.

- Both fields already exist on the model. **No migration.**
- `ad-dayparting.job.ts:197` writes the same two fields with `desired` = `ENABLED | PAUSED`. That job evaluates **zero** live rows (every schedule is goal-mode), so there is no live collision — but the two writers must not disagree about the column's meaning. Proposal: rank-defend writes the **target key** (`own-top`, `defend-top`, …), which is strictly more informative, and A2 reads it as an opaque label. Confirm this before I write it.
- Best-effort try/catch, exactly like the `ProductRankPlan` update above it. A receipt write must never fail a rank tick.

### A2 — runtime on the group endpoint

Extend `GET /advertising/rank-schedule-groups` (`advertising.routes.ts:7402`), additively. Per group:

| Field | Source |
|---|---|
| `lastEvaluatedAt` | max over member `AdSchedule.lastEvaluatedAt` (populated by A1) |
| `lastApplied` | most recent member value |
| `activeTargetKey` | `resolveActiveTargetKey(group.windows, group.defaultTargetKey, day, hour)` in the group's own timezone — computed, not stored |
| `membersEnabled` / `membersTotal` | `AdSchedule` group-by |
| `failedWrites` | `AdMutation` count, `state: 'FAILED'`, `actor` in the group's member actor strings, last 24h |
| `governedElsewhere` | member campaigns covered by an enabled `ProductRankPlan` — Discovery 2 |

Existing consumers are unaffected; every field is new. Keep the current `private, max-age=5` cache header.

### A3 — the list tells the truth

Three columns on `RankGoalsList`, in `AdsDataGrid`'s existing `GridColumn` shape:

- **Now holding** — a live target chip using the same palette as the Baseline chip, so "Baseline: Rest of Search / Now holding: Own Top" reads correctly at 22:00. Falls back to the baseline chip when no window is active.
- **Last run** — relative ("4m ago"), with the absolute timestamp on hover. Amber past ~40 min (the cron is `*/15`).
- **Health** — `ok` · `stale` (no evaluation in >40 min) · `writes failing` (N failed in 24h) · `partly governed` (N members owned by a family plan). The Status pill keeps meaning `enabled`; Health is the separate, honest signal.

Sorting/filtering come free from `AdsDataGrid`. Health joins the existing filter set.

### A4 — activity log drawer

Click a row → right-side drawer in console chrome:

- Query `CampaignBidHistory` where `changedBy` is in the group's member actor strings, newest first, with campaign name, field, old → new, reason, timestamp.
- Join `AdMutation` on the same actor for **delivery state** — so a row reads "bid 0.42 → 0.55 · **FAILED** · 3 attempts · `<lastError>`" rather than implying the change reached Amazon.
- Filter by member campaign; group by hour to make the hour-by-hour story legible.
- New read-only endpoint, e.g. `GET /advertising/rank-schedule-groups/:id/activity`.

**Drawer gotcha to honour:** the DS `Drawer` sits at z-61 above `Modal` z-50 — any confirm opened from inside a drawer must go through the drawer's `overlay=` slot (`StudioConfirm` is the reference), or it opens *behind* the drawer.

### Verification for Track A

- `tsc` + the DS ratchet locally; no `<select` written in a comment (the pre-push guard greps comments).
- A1 verified by running `POST /advertising/rank-defend/run-now` once and confirming member rows gain timestamps.
- A2/A3/A4 reviewed by you on `next dev :3000` against the prod API before any commit.
- Nothing committed or pushed until you say so.

## Sources

- [Hours of day now available for schedule-based budget rules — Amazon Ads](https://advertising.amazon.com/resources/whats-new/hours-of-day-available-for-schedule-based-budget-rules)
- [The Amazon PPC Dayparting Guide — AdLabs](https://adlabs.app/guides/amazon-dayparting-guide/)
- [How to Create Dayparting Automation Rules — Intentwise](https://help.intentwise.com/dayparting-rule-setup-options)
- [Dayparting Heatmap — Eva Help](https://help.eva.guru/docs/dayparting-heatmap)
- [Dayparting — SellerMate](https://www.sellermate.ai/tools/dayparting)
- [Optimization Tips Using Pacvue for Cyber 5 and the Holidays](https://pacvue.com/blog/optimization-tips-using-pacvue-for-cyber-5-and-the-holidays/)
- [Amazon PPC dayparting during shopping events using SOV — Pacvue](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Features for Event Preparation — Pacvue Knowledge Base](https://support.pacvue.com/hc/en-us/articles/31267541338269-10-23-2025-Pacvue-Academy-Live-Features-for-Event-Preparation)
- [The Amazon Intraday Optimization Guide — Perpetua](https://perpetua.io/resources/guides/the-amazon-intraday-optimization-guide/)
- [Dayparting for Amazon PPC — Limitations and Recommendations — Adbrew](https://adbrew.io/blog/dayparting-for-amazon-ppc)
- [How Amazon Dayparting Can Skyrocket Your Ad Profits in 2026 — Seller Labs](https://www.sellerlabs.com/blog/amazon-dayparting-ad-strategy-2026/)
- [Dayparting in Amazon PPC — SellerStack](https://www.sellerstack.ai/glossary/dayparting)
- [Best Quartile Alternatives for Amazon PPC in 2026 — Atom11](https://www.atom11.co/blog/quartile-alternatives-2026)

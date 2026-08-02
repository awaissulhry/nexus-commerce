# DPS — Dayparting Schedules as its own page

**Status:** PROPOSAL AWAITING GATE · 2026-08-01
**Surface:** `/marketing/ads` (the live console). `/marketing/ads-console` and `/marketing/advertising` are legacy.
**Working rule for this engagement:** every change runs locally first, and is committed/pushed only after explicit approval.

---

## Part 1 — What already exists

### 1.1 Three generations of ads UI

| Tree | Age | Dayparting code it carries | Verdict |
|---|---|---|---|
| `/marketing/advertising` (~40 pages) | oldest | `dayparting/DaypartingClient.tsx` (74 lines — raw create/list/toggle over `AdSchedule`) + `DaypartingIntel.tsx` | legacy |
| `/marketing/ads-console` (~10 pages) | middle | `automation/DaypartingTab.tsx` (394), `DemandHeatmap.tsx` (48), `TimeRankGrid.tsx` (271) | legacy |
| **`/marketing/ads`** (26 pages, Adtomic-matched) | **current** | `rules-automation/_schedule/*` + `rules-automation/_rank/*` | **the platform** |

Two live cross-links still point at the legacy tree and should eventually go:
- `apps/web/src/app/marketing/advertising/_shared/AdvertisingSidebar.tsx:31` → `/marketing/ads-console/automation`
- `apps/web/src/components/layout/AppShell.tsx:26` lists `/marketing/ads-console`

### 1.2 The Dayparting Schedules tab today

`RulesAutomationClient.tsx` is a 10-tab page. The tab state is **`useState('rules')`** — there is no URL segment, no query param, no deep link. Refreshing or sharing a link always lands you back on "Apply Rules".

The 10 tabs: Apply Rules · Bid · Keyword Harvest · Negative Targeting · Budget · **Dayparting Schedules** · Budget Schedules · Placement · Share of Voice · Keyword Tracker.

Dayparting Schedules renders `tabs/RankGoalsList.tsx`:
- `GET /advertising/rank-schedule-groups`, drawn on the shared `AdsDataGrid`
- columns: name (+ Manage link) · Baseline rank chip · Campaigns · Windows · Status
- bulk Enable/Pause, search, filters, customise-columns
- "Manage" / "Rank Schedule" open `/rules-automation/builder/dayparting-schedule[?groupId=]`

The builder route (`builder/[type]/page.tsx`) branches:
- `dayparting-schedule` → **`RankGoalBuilder`** (rank-goal authoring; 4 steps: Name · Campaigns · Rank goal & schedule · Control)
- `?style=classic` → **`ScheduleBuilder`** (classic dayparting: hourly chart + weekly table + bid multiplier)
- `budget-schedule` → `ScheduleBuilder`

### 1.3 Data model — three layers

| Model | Role | Live rows |
|---|---|---|
| `RankScheduleGroup` | authoring layer — one named schedule spanning many campaigns | **24** |
| `AdSchedule` | execution layer — one row per campaign, `groupId` binds it to a group | **45** (33 enabled) |
| `BudgetSchedule` | separate budget-schedule table | **0** |
| `AutomationRule` (domain=advertising) | criteria rules (bid/budget/harvest/negatives) | 36 enabled, 11 disabled |

`AdSchedule.windows` carries either `bidMultiplierPct` (classic intensity mode) or `targetKey` (rank-goal mode), plus `defaultTargetKey` as the out-of-window baseline.

### 1.4 The engines — verified live on prod

| Cron | Cadence | Last run | Last output |
|---|---|---|---|
| `ad-rank-defend` | */15 | 2026-08-01 08:30 | `evaluated=33 applied=0` (08:15 `applied=5`, 08:00 `applied=33`) |
| `ad-dayparting` | */15 | 2026-08-01 08:30 | `evaluated=0 changed=0` |
| `ad-budget-schedule` | */15 | 2026-08-01 08:30 | — |

**This is real actuation.** 33 enabled schedules are evaluated every 15 minutes and rank-defend is writing bid changes to live campaigns.

**Two findings fall out of this:**

1. **`ad-dayparting` evaluates zero rows.** Every live `AdSchedule` is goal-mode, so the classic dayparting job skips them all (`isGoalMode`). 100% of what runs is *rank-goal*, not *dayparting*. The tab is named for the mode nobody uses.
2. **`AdSchedule.lastEvaluatedAt` / `lastApplied` are never written by rank-defend** — it records to `ProductRankPlan.lastEvaluatedAt` instead. That is why every group-materialised row reads `lastApplied: null`. The UI currently *cannot* tell you when a schedule last ran.

### 1.5 The duplicates — root-caused

Live: **24 groups, 17 distinct names, 8 groups with ZERO members.**

```
"IT AIRMESH"  ×4   23:42:32 (0 members)  23:42:52 (0)  23:43:08 (0)  23:43:54 (10)
"IT AIREON"   ×3   04:10:03 (0)          04:10:11 (0)  04:11:40 (11)
"IT GALE JACKET" ×2  23:59:58 (0)        00:00:56 (11)
"Time×rank — XAVIA GALE…" ×2
```

**Root cause** — `_rank/RankPlanBody.tsx`:

- `saveGroup()` (line 131) chooses POST vs PATCH purely on `groupId`, which comes **only** from `useSearchParams()`.
- It returns `{ ok, id }` — and `doSave()` (line 147) **throws `r.id` away.** Nothing writes the new id back into the URL or into state.
- So the 2nd, 3rd, 4th save in a session is *still* a POST → a brand-new group each time.
- Server-side, `saveRankScheduleGroup()` (`ads-create.service.ts:807-810`) finds each campaign's existing `AdSchedule` and **rebinds it** to the newest group. The previous group is left with 0 members.

N saves = N groups, N−1 of them empty. The 80-second creation clusters in the data are exactly this.

**Severity:** cosmetic-but-corrosive, not a spend bug. `CAMPAIGNS_WITH_MULTIPLE_ENABLED_SCHEDULES = 0` — no campaign is double-scheduled, so the engine is not fighting itself. It is a list-hygiene and trust defect.

**Contributing gap:** no server-side uniqueness guard on (name, portfolioId).

---

## Part 2 — What the market does

### 2.1 Amazon natively

There is **no native hourly bid dayparting.** Amazon added *hours of day* to schedule-based budget rules, but those can only **raise budget** — they cannot pause a campaign or lower a bid. Everything real is built on the Ads API + Amazon Marketing Stream hourly data.

**Our position is strong here:** AMS is provisioned with 24 subscriptions ACTIVE across IT/DE/FR/ES since 2026-07-29. We already hold the hourly signal that tools charge $500–$1,000/mo to provide.

### 2.2 Best-in-class

| Tool | What it does for dayparting |
|---|---|
| **Helium 10 Ads / Adtomic** | Schedules page: hourly graph of selected campaigns by day×hour, filter by campaign/period/days, choose the metrics drawn on the graph, author the schedule from what you see. Hourly data is not retroactive — it starts when the account is set to "Manage". |
| **Pacvue** (~$1k/mo) | Hourly bid up/down; **templatised dayparting** reusable across campaigns; side-by-side across retailers; budget pacing with **lead-in / event / lead-out** phases; SOV-informed dayparting for shopping events; rules engine + AI agent. |
| **Perpetua** | Dayparting folded into the AI optimisation framework, AMS-powered. |
| **Quartile** ($895+/mo) | Enterprise, patented hourly bid adjustment. |
| **Sellerboard** | Dayparting controls + rule-based bid/budget automation. |
| **AdLabs** | Visual heatmap where you set a **% bid modifier for every hour of every day**, applied across hundreds of campaigns at once. |
| **Eva** | Dayparting heatmap, colour intensity = relative performance; select slots directly in the grid to create rules. |

### 2.3 The UI patterns that recur everywhere

1. **The 7×24 heatmap is the primary object** — not a form. You look first, author second.
2. **Direct cell selection / drag-select** on that grid authors the window.
3. **Metric switcher on the heatmap** — Spend · Sales · ACoS · ROAS · CVR · Orders · CPC.
4. **A % modifier per cell**, not just on/off.
5. **Templates** — author once, apply to many campaigns, save and reuse.
6. **Preview / simulate before arming** — "what would this have done last week".
7. **Timezone stated explicitly** on the surface.
8. **Event phasing** — lead-in / event / lead-out as one workflow.
9. **A change log** of what the schedule actually did, hour by hour.

We already have (1) partially, (3), (7). We are missing (2), (4) at grid level, (5), (6), (8), (9).

### 2.4 Where we are genuinely ahead

Adtomic and AdLabs daypart **bids and pauses by hour**. Our rank-goal mode converges on a **rank target** (hold Top-of-Search impression share, respect an ACoS ceiling, snap back when the slot is lost). That is a materially more advanced control loop than "raise bids 30% at 8am" — and it is already running in production. The plan below should *lead* with that strength rather than bury it under a name borrowed from a weaker product.

---

## Part 3 — Goal and approach

**Goal.** Dayparting Schedules becomes its own real page at its own URL, reached by clicking the tab — the single place to see, author and trust hourly control. And it stops manufacturing duplicates.

### Decisions — GATED 2026-08-01

- **A. Routing → substrate + Dayparting first.** Build the reusable route pattern under `/rules-automation/<tab>`, migrate Dayparting now, remaining 9 tabs one per later gated phase.
- **B. Design → ads-console native.** `AdsPageHeader` + `AdsDataGrid` + `h10-*`, matching `RankGoalsList`. Recorded as a deliberate deviation from the standing "new UI from the design system only" rule, scoped to this console.
- **C. Naming → "Rank & Dayparting Schedules".** Honest about both modes; surfaces the rank-goal capability that is what actually runs.
- **D. Order → Phase 0 → 1 → 2 → 3.** Phase 2 still stops for its own destructive-action gate.

### Original options considered

**A. Routing.** Convert the tab bar from `useState` to real routes.
- *A1 (minimal):* only dayparting gets a route; other tabs stay state-based.
- *A2 (recommended):* build a route substrate under `/rules-automation/<tab>`, move Dayparting first, and migrate the remaining tabs one per later phase. One pattern, deep links, working back button, no half-state. Shipped incrementally so each tab is separately gated.

**B. Design system.** `/marketing/ads` has its own vocabulary — `AdsPageHeader`, `AdsSidebar`, `AdsDataGrid`, `h10-*` CSS — and `RankGoalsList` already conforms. The global `apps/web/src/design-system` is **not** what this console is built from. Recommendation: stay native to the ads console so the page is seamless with its neighbours. *This needs your confirmation, since the standing rule is "new UI from the design system only".*

**C. Naming.** Everything live is rank-goal, not classic dayparting. Options: keep "Dayparting Schedules" (Adtomic parity), rename to "Rank & Dayparting Schedules", or split into two tabs. Your call.

**D. Fix duplicates before building on top.** Non-negotiable ordering — otherwise the new page ships with a known row-multiplier behind it.

---

## Part 4 — Phases

Each phase is separately gated, runs locally for your review, and is committed only on your approval.

| # | Phase | What lands | Risk |
|---|---|---|---|
| **0** ✅ | **Truth pass** | DONE 2026-08-01. Of 24 groups only **4** ran (33 schedules): IT AIREON 11 · IT GALE JACKET 11 · IT AIRMESH 10 · GALE EXACT DE 1. 8 orphans, 12 legacy single-campaign rows from a 2026-07-02 backfill. No ungrouped schedules, no archived campaign holding a live schedule. | none |
| **1** ✅ | **Stop the duplication** | DONE 2026-08-01. `RankPlanBody` holds `ownGroupId` from the first save; `RankGoalBuilder` pushes `?groupId=` into the URL and skips its reload effect for self-created ids; server adopts an existing (name, portfolioId) group instead of minting a rival. Verified: 3 consecutive saves → 1 group. | low, isolated |
| **2** ✅ | **Clean the orphans** | DONE 2026-08-01, operator-gated. 8 zero-member groups deleted with a re-check guard. **24 → 16 groups; all 45 AdSchedule rows intact; zero orphans remain.** | done |
| **3** ✅ | **Route substrate + the page** | DONE 2026-08-01. `_shared/tabs.tsx` holds the tab list + `RulesTabs` link bar. Routed tabs get `/rules-automation/<key>`; the rest ride `?tab=<key>` — so **all 10 tabs are now deep-linkable**, not just the new one. Dayparting lives at `/rules-automation/dayparting`, renamed **Rank & Dayparting Schedules**. | low |
| **4** ✅ | **Heatmap-first page body** | DONE 2026-08-01. `HourlyPerformance` panel above the list: 7×24 AMS grid + scope (account / one schedule) + 11 metrics + period, plus a plain-English "Busiest: …" read. Endpoint gained additive `scope=all` / `groupId=` so the page never pushes 200+ ids through a query string. `RawCell` + metric table extracted to `_schedule/heatMetrics.ts` and shared with `ScheduleBuilder` (one definition of "ACoS"). Fixed a real overflow in the shared `H10Select`: a right-hand select with long labels rendered **953px wide, 390px off-screen**; now edge-clamped. | done |
| **5** | **Drag-select authoring** | Select cells on the grid to author windows; per-cell modifier. Replaces form-first window entry. | medium |
| **6** | **Templates** | Save a plan, reapply across campaigns/portfolios — the Pacvue pattern. | medium |
| **7** | **Preview / simulate** | "What would this have done last week" before arming. | medium |
| **8** | **Observability** | Write `AdSchedule.lastEvaluatedAt` / `lastApplied` from rank-defend; surface last-run and an hour-by-hour change log on the page. Closes the trust gap from §1.4. | low, touches cron |
| **9** | **Retire legacy** | Remove the two live cross-links, then the `/marketing/ads-console` and `/marketing/advertising` dayparting surfaces. | needs gate |

**Suggested order to start:** 0 → 1 → 2 → 3. That gets you a clean, correct, deep-linkable page before any new capability is layered on.

---

---

## Data notes found while building

- **AMS coverage (2026-08-01):** `AmazonAdsHourlyPerformance` holds **9,778 rows across 39 campaigns**, 2026-05-21 → 2026-08-01 — €1,317 spend, 1.65M impressions, 3,358 clicks, all seven weekdays represented. Enough to draw a real heatmap, but only 39 of 216 campaigns are covered, so account-wide views are dominated by those 39.
- **Newly-created campaigns show no heatmap.** The IT AIREON group (created 2026-07-28) returns `hasData: false`. Marketing Stream fills forward from the day it was switched on and is never backfilled. The panel says so in its empty state rather than showing a misleading blank grid.
- **320 of 9,778 rows (3.3%) carry negative impressions**, netting −1,586. These are Amazon restatement/correction records. The heatmap SUMs, so corrections net out correctly and the grid shows net truth — no action needed, but worth knowing before anyone reads a per-row export and panics.
- **Peak demand is consistently evening.** Across the account the darkest cells run 18:00–23:00 every day, peaking Monday 22:00. That is the shape any dayparting or rank-hold plan should be built around.

## Sources

- [Adtomic Dayparting Schedules — Helium 10 KB](https://kb.helium10.com/hc/en-us/articles/8950447598875-Adtomic-Dayparting-Schedules)
- [Hours of day now available for schedule-based budget rules — Amazon Ads](https://advertising.amazon.com/resources/whats-new/hours-of-day-available-for-schedule-based-budget-rules)
- [Real-Time Automation & Optimization — Pacvue](https://pacvue.com/platform/real-time-automation-and-optimization/)
- [Amazon PPC dayparting during shopping events using SOV — Pacvue](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Pacvue vs Perpetua — SmartScout](https://www.smartscout.com/blog/pacvue-vs-perpetua-which-ppc-bid-management-tool-is-best-for-you)
- [Dayparting Heatmap — Eva Help](https://help.eva.guru/docs/dayparting-heatmap)
- [The Amazon PPC Dayparting Guide — AdLabs](https://adlabs.app/guides/amazon-dayparting-guide/)
- [Dayparting in Amazon PPC — SellerStack](https://www.sellerstack.ai/glossary/dayparting)
- [24 Best Amazon PPC Software Solutions for 2026 — The Retail Exec](https://theretailexec.com/tools/best-amazon-ppc-software/)

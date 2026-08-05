# ACR — the Ads Control Room & SERP Coverage program

**Date:** 2026-08-05 · **Status:** PROPOSAL — awaiting operator gate. Nothing here is built.
**Supersedes:** the *surface* plans in `2026-08-04-adx-plan-v2.md` Stage B and `2026-08-04-autonomy-study-and-plan.md` §6 (their shipped work stands; their UI phases are absorbed here).
**Companions kept as the record:** `2026-08-03-ads-autonomy-domination-adx.md` (audit), `2026-08-04-competitor-deep-dives.md`, `2026-08-04-ads-market-research.md`, `~/Desktop/COMMERCE-PLATFORM-RESEARCH` (five UI teardowns, now fully read).

**The goal, verbatim from the operator:** several products share one keyword set → hold multiple page-one slots for those keywords; automate all routine ad management so it needs no daily attention; the operator retains explicit control of every lever; every surface properly navigable from its own page — **zero new sidebar entries**; no visual or data inconsistencies anywhere.

---

## Part 0 — Why this re-plan exists

The ADX program (Aug 3–4) fixed the machine: the rule engine that had never executed (693k failures, 0 successes), the propose pipeline that had never proposed, guardrails G1–G7, protected terms, evidence on the change log, and the first live automation (retail guard). That work is sound and stands.

What the operator rejected is **where and how it surfaces**. Everything landed on `/marketing/ads/autopilot` ("AI Control" in the rail) as the `AutonomyBoard` — a flat list of 22 rules with 4-notch dials — sharing the page with the leftover Mission Control canvas from an abandoned React-Flow concept (`docs/ai-control-autopilot-spec.md`, never reconciled). The result:

1. **It governs rules, not the account.** The four biggest bid movers — rank-defend, dayparting, budget enforcement, budget pools — are *engines*, not rules. They don't appear on the board at all. The board therefore controls the minority of the automation while the majority runs elsewhere, which is exactly the "I don't have control" feeling.
2. **Two unreconciled concepts on one page.** A rule-dial list (ADX) beside an object-graph canvas (Mission Control) with no relationship between them, plus four orphaned dead files (`AutopilotControlRoom.tsx`, `AutopilotCanvas.tsx`, two CSS files) still in the folder.
3. **Two autonomy vocabularies.** Global dial `OFF | SUGGEST | AUTO` (`AdsAutomationState`) vs per-rule `OFF | OBSERVE | PROPOSE | AUTO` (`AutomationRule.autonomyLevel`). Both real, presented nowhere as one hierarchy.
4. **Hand-rolled UI, light-only.** `autonomy-board.css` has zero `.dark` rules; the board's docblock claims "nothing under /marketing/ads imports the design system," which is false (suggestions, recommendations, trust, portfolios, reporting, bulk all do).

ACR is the re-design: **one Control Room governing every engine**, the coverage program the operator originally asked for, and the consistency sweep — planned to the smallest details below.

---

## Part 1 — What exists (the complete map, condensed)

### 1.1 The new console — `/marketing/ads/*`, 26 routes

| State | Routes |
|---|---|
| **Real** | dashboard · budget-manager · suggestions · recommendations · health · trust · campaigns (Ad Manager, 1,686-line grid) · portfolios · bulk · rules-automation (10 tabs) · reporting (+runner, +pipeline, +brand-metrics) · changelog (contextual entry only) · campaign-builder (+5 builders) · ai-advertising (+new-goal) · autopilot (AI Control) · ebay/** (20 dirs, separate channel) |
| **Stub (5)** | **analytics** · account-overview · account-settings · amc · amc/audiences |

Rules & Automation tabs (all deep-linkable via `?tab=` / routed): Apply Rules · Bid · Keyword Harvest · Negative Targeting (+ProtectedTermsPanel) · Budget · **Rank & Dayparting Schedules** (own route; the deepest surface in the console: RankTargetEditor, RankGoalBuilder, ScheduleBuilder, ArmPreview, Next24Preview, HourlyPerformance heatmap, CoveragePanel, Versions, Activity, Events) · Budget Schedules · Placement · Share of Voice · Keyword Tracker.

Two legacy consoles still live against the same backend: `/marketing/advertising` (31 dirs — the interpretation surfaces: n-grams, incrementality, funnel, momentum, SOV, harvest, bid-optimizer, budget-pools…) and `/marketing/ads-console` (AutomationHub, RankPlacementCockpit). **Three UIs over one engine is itself a control defect** — a rule changed on legacy shows stale state on the new console.

### 1.2 The backend — engines and their real state

Master gate `NEXUS_ENABLE_AMAZON_ADS_CRON` (in `apps/api/src/index.ts:1365-1465` — **not** cron-registry.ts, which is only the manual-trigger map).

| Engine | Cadence | State on prod (ADX.0-measured + code) |
|---|---|---|
| **ad-rank-defend** (rank engine) | 15 min | **LIVE and healthy** — 5,311 applied mutations/90d, 33 schedules; the one part in daily use |
| ad-dayparting (classic windows) | 15 min | Runs; near-inert (every live schedule is goal-mode) |
| advertising-rule-evaluator | 15 min | Runs; ~22 consolidated rules; per-rule dial decides act/propose |
| ads-auto-bid (target-ACOS optimizer) | 6 h | Runs; propose-only under SUGGEST |
| ads-auto-harvest | daily | Runs; propose-only; protected-terms whitelist now enforced at the gate |
| ad-budget-enforce (AdBudgetPlan pacing) | 30 min | **Dry-run** unless `NEXUS_BUDGET_ENFORCE_APPLY=1` |
| budget-pool-rebalance | 15 min | Row-driven |
| ads-anomaly-guard (circuit breaker) | 10 min | Live; 250 actions/h + €500/h trips a halt |
| drain-ads-sync (the write path) | 1 min | Live — the real delivery path (Redis down) |
| **ads-tos-defense** | 30 min | **DORMANT** (`NEXUS_ENABLE_TOS_DEFENSE_CRON` absent) — the most direct SERP lever in the codebase, never run |
| tos-is-ingest / sqp-ingest | daily | Fire on schedule, but **`topOfSearchIS` is all-null and SQP brand columns all-zero in the data** (RPT.0) — running ≠ producing |
| ads-structural-reconcile | 6 h | **Never runs — a gating bug**: self-gates with strict `!== 'true'` while the master gate accepts `1` |
| services/bidding-engine (µservice) | — | Fully dormant by design (`BIDDING_DRY_RUN=1`, not deployed) |

**Write safety spine** (all writes): `AdMutation` intent → `OutboundSyncQueue` → drain → `ads-write-gate.ts` — env live-mode → connection production+writesEnabled → **per-campaign allowlist (82/216, default-deny)** → **entity min/max bid bounds (deny, not clamp)** → **protected keywords (EXACT/PREFIX/CONTAINS)** → €500 value cap → Amazon v3 → read-back reconcile + drift detection + evidence-carrying audit log + undo. Daily write cap deliberately removed; `maxBidChangePct`/`cpcCeiling`/5¢-floor clamps remain (suppression uses `force`).

**Known footguns (all confirmed in code):** re-enabling a PAUSED campaign does **not** re-allowlist it (writes deny visibly; recover via `PATCH /campaigns/:id/live-writes`) · `AdsAutomationState` defaults to `AUTO` and `getAutomationState` falls back to `AUTO` when the row is missing — the safety actually rests on per-rule defaults · two autonomy vocabularies (§0.3).

### 1.3 The multi-product machinery that already exists (this is the ACR foundation)

| Layer | What it does | Status |
|---|---|---|
| `rank-self-competition.ts` | Within a family: detects keyword contests (EXACT/PHRASE overlap) + AUTO contests; champion by `[acos, -spend]`; **demotes losers-that-win-nothing to the plan baseline** ("stop outbidding ourselves") | Live — **but plan-lane only**; schedules alone never get it |
| `GET /campaigns/:id/keyword-conflicts` | **Different ASINs colliding on a shared keyword** — every contender's bid/efficiency/ToS intent + a **recommended champion** + one-click gated resolutions | Read-only, built, barely surfaced |
| `GET /campaigns/:id/self-competition` | ASIN-overlap inventory across campaigns | Read-only |
| `resolveProductFamily` / `blendedFamilyDemand` | Family resolved LIVE (FBA+FBM rows by ASIN, SKU-joined); demand is a product property → one schedule drives all family campaigns | Live |
| `RankTarget.lanes` | **Blended multi-placement** — Top + Rest-of-Search + Product-pages in one write, per-lane feedback signal | **Modeled, engine-supported, unused** |
| `ProductRankPlan` | One family plan → every campaign advertising the family; guardrails (family budget/ACOS caps, blast-radius auto-pause, lead-time, manualOnly) | Live-capable, 0 enabled |
| `KeywordRank` model + Keyword Tracker tab | Organic/sponsored rank per keyword — append-only ingest | **Empty pipe** — no collector by decision (no scraping) |
| Within-account SOV (`ads-impression-share.service`) | Share of our own tracked impressions + cannibalization + lost-IS proxies | Live; **within-account only — never says who else is on the page** |

### 1.4 Data gaps that bound everything

- **COGS: 0 of 362 products** carry a cost price → profit-native ACOS falls back to a flat 30%, and "wasted spend in €" is an estimate, not margin.
- `topOfSearchImpressionShare` all-null, SQP brand-share columns all-zero — ingests run, data doesn't land. Cause unknown (same shape as the IT-ingest silent drop already fixed).
- AMS hourly is IT-heavy (per-campaign coverage varies 1–56 days) — any per-schedule ratio must surface `coverage.daysWithData`.
- AMC + DSP **blocked at Amazon** for this account — do not build against them.
- Brand Registry **is present** (SB campaigns exist, SQP + Brand Metrics flow) → SB/SBV/SD stacking is buildable; create/optimize paths are read-only today in `ads-api-client.ts`.

---

## Part 2 — The market (13 tools researched fresh + 5 UI teardowns read)

Full agent reports in session; deep-dives doc covers 8 more. The synthesis that matters:

### 2.1 Who is best at what

| Capability | Best in industry | Nexus position |
|---|---|---|
| Granular rules + structure recipes | Scale Insights (11 algorithms, 200+ params, preview-with-arithmetic) | Have the engine; adopt **preview + step-by-step calculation**, **Revive**, whitelist ✅(shipped) |
| Goal-based hands-off ML | Perpetua ($695+) | Rejected pole — but adopt **goal categories as the authoring front door** and its **bid-to-position decay/reclaim loop** |
| Hourly AMS bidding | Quartile ($895+), Pacvue, Skai, BidX, Adbrew | AMS ingested; rank engine is 15-min; adopt 14-day rolling refresh |
| Rank-aware multi-ASIN orchestration | **m19** — ToS Rankings Optimizer: suppress paid where organic already ranks; rotate exposure to unranked siblings | **The closest existing implementation of the operator's goal.** Adopt both mechanics |
| Margin-native bidding | sellerboard ("Celebord") — break-even ACOS/bid per keyword from COGS; Off/**Test**/On | We compute deeper (real fees) — blocked only by the COGS data gap |
| SOV / SERP tracking | Pacvue/Perpetua/Intentwise — all **scrape** (ToS-prohibited) | Decided: approximate in-policy now, buy a feed if insufficient, never scrape |
| Control model | Pacvue's four legs: thresholds · approvals · **intensity dial** · audit; Prism's per-category thresholds + 7-day undo; Quartile's guardrails-as-columns + managed/not-managed split + `Stop Placement Management` per-dimension authority | Three of four legs shipped; the Control Room delivers the presentation |
| Approve-before-apply UX | Intentwise accept/reject queue; H10 Adtomic suggestion tabs (bid/new-kw/negative) | Suggestions page exists; unify per-type queues |

**Amazon's free layer moved the bar:** dynamic bidding, budget rules, Performance+/Brand+, Ads Agent are free. The defensible ground is exactly where Nexus sits — dayparting, cross-campaign budget, profit-native economics, coverage — plus one thing nobody sells: **an inspectable goal engine** (RankTarget is algorithmic in behavior, every parameter operator-set).

### 2.2 The 15 control-room patterns from the teardowns (ranked, each adopted below)

1. **Guardrails are columns on the entity**, never settings inside the automation (Quartile grid; Rithum per-SKU floors) — ✅ A1 shipped the columns; ACR ships the grid.
2. **Per-lever authority switches** (`Stop Placement Management`) — "which decisions are the machine's," not "how much automation."
3. **Intensity dial** — a binary produces a permanent off — ✅ per-rule dial shipped; ACR extends it to engines.
4. **Counted authority boundary** — `all (216) · managed (82) · not managed (134)` tabs.
5. **Review → bulk apply → applied counter** as the approval shape.
6. **Counts in tab labels** — the IA does the triage. ✅ partially shipped.
7. **Price every row in €** — an issues list without money attached is a list nobody triages.
8. **Exceptions are objects with a lifecycle** (Problems → In progress → Resolved), not dismissable toasts.
9. **History is a peer of action** — activity log first in the toolbar, not buried.
10. **Audit as a stored, timestamped object** with a previous run to diff ("what did we fix, and what came back").
11. **Preview against a real entity before commit**, output *and* error shown.
12. **Analysis before control** — never ship a lever without the chart that justifies it (heatmap before scheduler ✅ — keep honoring).
13. **Automation is a navigation destination**, not a settings page.
14. **Entity-first IA; channel as a lens** (ads abstract well; the Amazon⇄eBay rail switch already does this).
15. **Operator-defined tag/set as the default aggregation dimension AND rule scope** — the shared-keyword coverage set is exactly tag-shaped.

Plus two standing rules from Quartile's failure modes: **anything that creates entities must also retire them**, and **explain decisions, not just parameters**.

### 2.3 Refused (explicit, so they stop resurfacing)

SERP scraping (account is the asset at risk) · 200+ parameter sprawl · opaque ML at €4.5k/mo spend · cross-retailer breadth · AMC incrementality (blocked) · warehouse egress · managed-services logic · autonomous campaign-structure creation (every failure mode in the research says keep structure human) · full-lifecycle ChatGPT campaign creation.

**Calibration:** BidX prices payback at €10k/mo spend; Xavia runs ~€4.5k. The yardstick for every phase is *"does this beat manual management at €4.5k/month"* — small, legible, cheap to operate.

---

## Part 3 — How Amazon SERP actually works (the "loopholes" question, answered)

Verified 2026-08-05 (full sourced report in session):

1. **Amazon dedupes sponsored slots per-ASIN, not per-advertiser.** Several *distinct* products from one seller, in **separate ad groups**, can win multiple sponsored slots on the same page simultaneously. With ~20–25 sponsored tiles per page load, this is the mechanically supported, policy-clean route to multi-slot presence — available today, SP-only. (True variations of one parent collapse to one tile; Xavia's distinct products don't.)
2. **You never bid against yourself** — same keyword across your campaigns enters the auction once (second-price). The real costs are **data dilution and budget fragmentation**, which is why the industry defaults to *consolidation*. Coverage-vs-consolidation is therefore an **experiment to run, not an assumption** — measure cost per page-one appearance *and* per-ASIN conversion drift on one family with a control.
3. **The stacking ladder:** SP multi-ASIN slots (have) → ToS placement multiplier 0–900% (have, ceiling-capped since MB.4) → SB headline + SBV + SD as *separate placements* that never compete with SP bids (Brand Registry present; create-paths missing) → organic tiles via the paid→organic flywheel. **One hard safety rule confirmed:** the effective bid is base × placement% × dynamic-bidding headroom (up to 2×) — our `cpcCapPct` already caps exactly this product; every new coverage lever must route through it.
4. **The convergent automation blueprint** (m19 + Perpetua + Pacvue + Scale Insights): keyword→**lead-ASIN assignment** enforced with negative-exacts on non-lead campaigns · **bid-to-position decay/reclaim** (win the slot, decay the bid until lost, snap back) · **organic-rank-aware suppression** (stop buying what you own; hand exposure to unranked siblings) · non-lead ASINs stay live at defensive bids (matches the house no-pause doctrine) · **defensive self-ASIN targeting** walls competitors off your own detail pages · position-weighted SOV as the feedback metric.
5. **Out of bounds (never):** duplicate listings for extra slots, fake variation merges, search-find-buy schemes, review manipulation. Xavia's distinct-products catalog has zero policy exposure for everything in this plan.

---

## Part 4 — The design

### 4.1 Where things live (zero new sidebar entries)

| Surface | Home | Mechanism |
|---|---|---|
| **Control Room** | **DECIDED 2026-08-05:** new route `/marketing/ads/rules-automation/control-room`, listed in the ads rail as a **chevron child under Rules & Automation**. The "AI Control" rail entry is **removed** (its AutonomyBoard content becomes the Levers drawers; Mission Control becomes a "Map" link inside Today; `/marketing/ads/autopilot` redirects). Net rail count unchanged: one entry removed, one child added | Full build; 5 in-page tabs |
| **Coverage** (the SERP scoreboard + conflicts) | `/marketing/ads/analytics` — fills the stub | Tabs; per the standing split *Reporting = data / Analytics = meaning* |
| Coverage *authoring* (sets, ladder, lead assignment) | Rank & Dayparting Schedules tab (`rules-automation/dayparting`) | New "Coverage sets" section beside schedule groups — same page that owns rank intent |
| SB / SBV / SD builders | `campaign-builder` | New type cards beside the existing five |
| Per-campaign autonomy state | Ad Manager grid | Column + row drawer |
| Morning digest | Control Room "Today" + `dashboard` panel | Panel |
| Everything else already has a home | health · trust · changelog · suggestions · budget-manager | Extended in place |

Location decided by the operator 2026-08-05: a chevron child under Rules & Automation (the same pattern as Reporting → Brand Metrics). It is **not** an 11th tab in the rules tab bar — the room governs all engines, so it gets its own routed page; the nav nesting just says where you find it.

### 4.2 The Control Room — five tabs, specified

Shell: `h10-cd-tabs` (deep-linkable `?tab=`), h10 chrome, DS components inside (the reporting-page pattern — DataGrid/Drawer/Banner/Tabs/Toast with all four DS stylesheets). Kill-switch state as a persistent `Banner` above the tabs whenever env-kill/halt/SUGGEST is active. The ~150px Ask-AI clearance respected on every sticky bar. Every dropdown/menu in grid cells portals to `document.body`; Drawer confirms use the `overlay=` slot.

**Tab 1 · Today** (default — the morning glance):
- Status band: mode chips (env `live/sandbox` · global dial · halted?) + **Pause all / Resume** (wired to the existing `/autonomy/pause-all`, `/resume`, `/automation/halt` endpoints — built, currently UI-less) + breaker thresholds.
- **The One Number:** wasted ad spend €/30d and €/today — margin-true once COGS lands, honestly labeled "ACOS-estimated" until then.
- **Priced exception board** — three-column lifecycle (Problems → In progress → Resolved), every row ending in €: failed writes, dead letters, guardrail denials (incl. the re-enable/allowlist footgun, surfaced with its one-click fix), uncovered spend, feed contradictions, thin-data schedules. Resolved column doubles as recovered-€ record.
- **Overnight digest:** one row per engine — applied · proposed · denied · net € effect · "why" drill-through to Activity.
- **Boundary counts:** `216 campaigns · 82 managed · 134 not managed` + per-engine coverage chips (rank 33 · budget-plan N · rules N).

**Tab 2 · Levers** (the heart — the authority grid):
- **One row per engine**, not per rule: Rank & Dayparting · Rules: Bid · Rules: Budget · Rules: Harvest · Rules: Negation (with protected-terms count inline) · Placement/ToS defense · Budget enforcement · Budget pools · Retail guard · Auto-bid optimizer · Coverage engine (Stage 3) · Anomaly breaker.
- Columns: **Mode** (unified Off/Observe/Propose/Auto vocabulary — the global SUGGEST dial presented as an account-wide *ceiling* over per-lever modes, ending the two-vocabulary confusion) · **Scope** (N campaigns, → managed list) · **Bounds** (chips: caps, floors, ceilings) · **Accountability strip** (applied this week · last run · enabled since · **net effect €**) · Next run · Health (failure rate; the strip that made the 693k-failure silence impossible to repeat).
- Row expand → `Drawer`: the per-rule dials for that engine (today's AutonomyBoard content becomes drawer content), graduation-ceiling reasons on disabled notches, evidence samples, per-category caps, one-notch move + revert, manual run-now (wired to the existing trigger endpoints).
- **Per-dimension authority** (the Quartile pattern): a campaign-level "hands off placement / bids / budget" pin set — enforced in `ads-write-gate` beside the bounds.

**Tab 3 · Guardrails** (the bounds grid):
- DataGrid of campaigns grouped by portfolio/family: Min bid · Max bid · Target ACOS · CPC ceiling · Daily budget · **Managed** (allowlist toggle with the re-enable footgun called out) · Suppression floor/owner (`bidsSuppressedBy`) · pins. Inline edit; bulk edit bar; numeric From/To column filters; filter-state-visible control with Reset.
- Protected terms panel (shared component with the Negative Targeting tab — one implementation, two mounts).
- Account row above the grid: €500 value cap · breaker thresholds · env flags as read-only chips, each with plain-language explanation (replacing the board's hard-coded footer prose with live data).

**Tab 4 · Activity** (audit as a peer of action):
- The changelog grid embedded, filterable by source engine/entity/field; **evidence column** (metric · observed vs threshold · window · sample size; thin-evidence tint); **Delivery column** (intent vs Amazon-confirmed — they are different facts); undo/undo-preview.
- "**Why did this bid move?**" — campaign + time → the write, the resolved actor name, the evidence. The question that started the whole program, as a search box.
- **Stored audits:** a nightly account-audit snapshot (Skai custom-audit pattern) with previous-run diff — "what did we fix, and what came back."

**Tab 5 · Foresight**:
- **Next-24h across all engines** (generalizing the rank-only `next24.ts`): time-ordered list of what will change, driven by what, at what projected cost.
- **30-day replay diff** before graduating any lever: what it *would have done* against real history (Scale Insights' preview-with-arithmetic, applied to us).

**Mission Control canvas:** kept, demoted to a "Map" link inside Today (it is a view, not a control surface). The four orphaned autopilot files are deleted.

### 4.3 Coverage — the Analytics page (fills the stub)

**Tab 1 · Coverage scoreboard:** one row per tracked keyword in a coverage set — our ASINs present (paid/organic split) · ToS impression share · SQP purchase-share · KeywordRank organic position(s) · position-weighted coverage score · trend sparkline · which engine holds the term (schedule / ladder / none) · € spent per page-one appearance. Waffle-style composition visual per keyword set (denominator visible). Multi-window columns (7/14/30d side by side, no toggle-and-remember).
**Tab 2 · Conflicts:** the existing `keyword-conflicts` + `self-competition` endpoints, finally surfaced: contested keywords, contenders, recommended champion, one-click gated resolutions.
**Tab 3+ (later):** n-grams · funnel · momentum ports from legacy, one at a time.

**Honesty rule stated on-page:** coverage numbers are in-policy approximations (our share + our ranks), not a scraped who-else-is-on-the-page view; if that proves insufficient we buy a feed for the ~tens of tracked terms — we never scrape.

### 4.4 The coverage engine (Stage 3 — the original ask)

New small model `KeywordCoverageSet`: name · marketplace · keywords[] · member family/products · objective (`coverage | profit`) · lead assignments. Authoring UI beside schedule groups. Engine behavior per keyword, each mechanic separately gated:

1. **Lead-ASIN assignment** — champion picked by the existing conflict logic (CVR/ACOS/spend), operator-overridable; enforced with negative-exacts on non-lead campaigns (created through the gate, undo-able, retirement path designed with it).
2. **The bid ladder** — lead ASIN gets the `own-top` target; siblings get `rest-of-search`/mid-page lanes (`RankTarget.lanes`, already modeled) at defensive bids — never paused, per house rule. Multiple distinct ASINs → multiple slots (Part 3.1).
3. **Bid-to-position decay/reclaim** — extend `rank-controller` computeStep: once ToS-IS ≥ target, decay bias by `stepDownPct` until share dips, then snap back — minimum viable cost for the slot (Perpetua's loop, on our motion-profile engine).
4. **Organic-aware suppression** — when `KeywordRank` shows organic top-N for the lead, ease paid down (m19's mechanic); requires Stage 2 rank data.
5. **ToS defense** (`ads-tos-defense.job`) armed **scoped to the pilot family only**.
6. **Revive** — terms that held page-one presence and went quiet get a bounded bid nudge.
7. **Defensive self-ASIN targeting** — the family's PDPs carry own-brand product-targeting ads.
8. **Self-competition demotion extended** — currently plan-lane only; the coverage engine gives every set a `ProductRankPlan` so demotion logic is always active, with the ladder replacing demote-to-baseline where the objective is coverage.

Every write: through the write-gate, effective-bid-capped (`cpcCapPct`), evidence-carrying, undo-able, visible in Foresight before and Activity after.

### 4.5 Design system & consistency rules

- **Component policy:** DS components (`DataGrid`+GridToolbar+FilterBar, `Drawer`, `Modal`, `Tabs`, `Banner`, `Tag`, `Toast`, `MetricStrip`) inside the h10 shell — the pattern reporting/suggestions/trust already established. New reusable pieces go into the DS first. All four DS stylesheets on every page that uses them.
- **Dark mode — needs one decision:** the shell pins the console light (`color-scheme: light`, by design) while DS-importing pages carry `.dark` rules → dark cards inside a light shell. **Recommendation: declare the ads console deliberately light everywhere** — strip the stray `.dark` blocks under `/marketing/ads`, document it in `ads.css`. (The alternative — full dark support — means theming 7,300 lines of scoped CSS.)
- Known traps honored: dropdowns portal to body (z-130 takeover trap) · Drawer confirms via `overlay=` slot · `table-layout:fixed` scoped global class · DS guard greps comments · `grep -a` for advertising.routes.ts · no duplicate Fastify routes.
- ~~Housekeeping in Stage 1: delete the four orphaned autopilot files~~ — **wrong, corrected 2026-08-05.** An import-graph walk with comments stripped found **exactly one** unmounted file, `AutopilotControlRoom.tsx`, and `page.tsx` records it as deliberately preserved for its SSE/decision-feed logic. Every other file under `/autopilot` is reachable, and `AutopilotCanvas` is imported by three surfaces outside it. Deleting "the four" would have broken the AI Control page and two builder previews.
  *The first scan said otherwise because grep matched a component's name inside a COMMENT — the same trap [[reference_ds_guard_greps_comments]] records for the DS ratchet, hit here on a different tool.* What was real: `autopilot/control-room.css` shared a basename with the new Control Room's stylesheet, so "who imports control-room.css" returned both and reported the dead component as live. Renamed to `autopilot-control-room.css`.

---

## Part 5 — The phases

Each phase separately gated; nothing starts without operator approval. Verification on live prod (Railway + Vercel), read-only harnesses before any behavior change, per house rules. Ads-console commit override stays: local, batch on command.

### Stage 0 — Honest substrate (repairs; ~no new UI)
- **0.1 ✅ DONE 2026-08-05 (local).** `ads-structural-reconcile.job.ts:42` compared `NEXUS_ENABLE_AMAZON_ADS_CRON !== 'true'` while `index.ts` reads the same flag through the tolerant `envEnabled`. On a prod that sets the flag to `1`, the whole ads fleet starts and this one job silently does not — so ADX.0's "confirmed off, as predicted" was measuring a bug, not a decision. It was the **last** strict compare of that flag in the codebase, and `ads-sync-integrity.ts:210` had been reporting the symptom ("nothing is comparing the account against Amazon on a schedule") without the cause.
- **0.2 — DIAGNOSED 2026-08-05.** Harness `apps/api/scripts/_acr02-coverage-feeds.mts` (read-only, untracked). **Two different bugs; all three leading hypotheses were wrong:**
  - *Refuted:* placement-vocabulary mismatch — the stored value **is** `'Top of Search on-Amazon'`, 1,017 rows reachable by the ingest's WHERE clause. *Refuted:* campaignId keyspace — placement rows carry external numeric ids and all 77 join to `Campaign.externalCampaignId`. *Refuted:* date shape — the column is a pure `date`. **Byproduct: the schema comment documenting this column as `TOP_OF_SEARCH | PRODUCT_PAGE | REST_OF_SEARCH | HOME_PAGE` is stale — it describes a vocabulary the data does not use, and is what made the mismatch look likely.**
  - **ToS-IS — ROOT CAUSE FOUND (live probe, 2026-08-05): the report never finishes inside the client's 10-minute wait.** Seven consecutive nights read `profiles=9 rowsFetched=0 withIS=0 rowsUpdated=0 **errors=9**` under a **SUCCESS** CronRun. The live probe shows the report is created fine, then polls `PENDING` for all 60 attempts and throws `report … timed out after 10 minutes` (`ads-api-client.ts:1417-1442` — `fetchReport` is a blocking create-and-poll capped at 60 × 10s).
    **The column is not rejected and the report is not unavailable** — both hypotheses are dead. A control request *without* `topOfSearchImpressionShare` times out identically, which is what proves it is latency, not the metric. (My probe printed "⇒ not a column problem; the campaigns report itself is unavailable here" — that inference was wrong: both requests failed for the same reason, time.)
    **The architectural mismatch:** the main ads reporting pipeline is deliberately split — `report-create` (01:15–02:00) → `report-poll` (every 10 min) → `report-ingest` (:07/:22/:37/:52) — precisely because these reports outlive any single request. ToS-IS never adopted it; it calls the blocking one-shot helper. Its docblock justifies issuing its *own* isolated report so a rejected metric can't break core ingestion — a sound goal whose cost turned out to be 100% failure.
    **FIXED 2026-08-05 (local) — the contained option, deliberately not the "recommended" one.** `ReportRequest` gained `pollMinutes` (default **10**, so every existing caller is byte-identical) and ToS-IS passes **45**. Safe at 45 specifically because the service fetches profiles in `Promise.all` — that is the job's worst-case wall-clock, not 9× it — and it runs at 02:30 with nothing downstream waiting.
    **Why not option (c), adding the column to the existing nightly campaigns report:** it would put a new column on the request that feeds core campaign metrics, and that pipeline has already caused one seven-day silent data loss (the IT ingest drop). Trading a broken side-feed for risk to the working main feed is a bad trade, and the original author's isolation instinct was right — it was the 10-minute deadline that was wrong, not the isolation. Option (c) stays available later, once ToS-IS has proven the column returns data.
    **If 45 minutes still is not enough**, the failure is now a logged 504 carrying the report id and `waitedMinutes` (ACR.0.6) rather than a number in a summary nobody reads — so the next iteration is evidence-driven. Option (b), moving ToS-IS onto the split create/poll/ingest pipeline, remains the structurally correct end state.
  - **SQP — CONFIRMED AND FIXED: the parser had never met a real payload.** 9,232 rows across 4 markets carried `impressionsTotal` = 53,187,081 and `purchasesTotal` = 3,404 with **every one of our own counts at 0**. The parser read `imp.brandCount ?? imp.asinCount ?? imp.brand` — none of those strings appears anywhere else in the codebase — and `sqp.vitest.test.ts` asserted against an **invented fixture** using the same invented names, so a green suite proved the parser self-consistent, never correct. Totals worked purely by luck: `totalQueryImpressionCount` is real and happened to be in the totals list.
    **A live capture settled it** (`_acr02-sqp-shape.mts`, IT / B0BMSH19GY / week of 2026-07-19, 100 rows). Amazon's real ASIN-level keys are `asinImpressionCount`, `asinClickCount`, `asinCartAddCount`, `asinPurchaseCount`, each with an `…Share` sibling. Row 0: `asinImpressionCount = 230`, `totalQueryImpressionCount = 20110`.
    **Verified end-to-end** (`_acr02-verify-parser.mts` — the real parser over the real bytes): **100 of 100 rows now carry our impressions, was 0 of 9,232**; the cross-check matches the raw JSON exactly; and our computed share agrees with Amazon's own `asinImpressionShare` to two decimals. **Note: Amazon reports share as a PERCENT (1.14), we store 0..1 computed from counts — never store theirs raw.** The regression test now uses the captured payload verbatim, the only fixture in that file whose shape is evidence.
    ***Two harness bugs worth remembering, both mine:*** `dataEndTime` must be a **Saturday** for `reportPeriod=WEEK`, and the lookback must be **2** — one week back is not published yet and Amazon answers with a generic "client error". Production's own `periodWindow()` gets both right; hand-rolling dates is what got them wrong.
    **First real coverage numbers, as a byproduct:** on the head terms we hold **0.6–1.5% impression share** — `giacca moto estiva uomo` 686 of 110,506 (0.62%), `giacca moto uomo` 625 of 41,103 (1.52%). That is the coverage baseline this whole program needs, and it has been readable all along.
  - `KeywordRank` confirmed **0 rows** — the empty pipe is real and intended (no collector, no scraping).
  - *Method note:* the discriminator was comparing what the writer produced against what the reader looks for, never either side's own success counter — the move that cracked the IT ingest drop. **A cron reporting SUCCESS while `errors` equals its profile count is the tell; two of these three feeds were lying in exactly that shape.**
- **0.3 ✅ DONE 2026-08-05 (local).** The dial now fails safe in both of its distinct failure modes, which were conflated: a **missing row** (the singleton is created by upsert-on-read, so the schema default is what an unconfigured environment runs at — was `AUTO`, now `SUGGEST`, migration `20260805c_acr0_autonomy_fail_safe`, `SET DEFAULT` only so no existing row is rewritten) and a **failed read** (`isAutomationHalted` / `shouldForceDryRun` now answer halted/dry-run instead of resolving to `AUTO`, and log the error). `getAutomationState` gained `degraded` so the UI can say "cannot read the safety state" rather than presenting a fail-safe assumption as an operator setting. Both callers tolerate this: the evaluator skips one 15-minute tick, the route returns 423.
- **0.4** Surface `coverage.daysWithData` wherever an AMS ratio renders.
- **0.6 ✅ DONE 2026-08-05 (local) — found while diagnosing 0.2: the Amazon Ads API client wrote no outbound call log at all.** `OutboundApiCallLog` is the platform's per-call observability spine — endpoint, status, latency, error, fingerprinted into `SyncLogErrorGroup`. **Every other integration uses it**: SP-API (reports, pricing, settlements), eBay (auth, orders, sync, category, returns, pushback), refunds. `ads-api-client.ts` uses it **nowhere**. Measured consequence: querying ten days of failures for the nightly ToS-IS job returns only SP-API rows, because the nine failures a night were never written anywhere — the service logged a count, the cron logged SUCCESS, and the call layer logged nothing. That is why this was undiagnosable from data and needed a live probe. Give the ads client the same logging every other channel already has. **This is a prerequisite for the Control Room's exception board and "why did this bid move?", both of which assume ads calls are as visible as everything else.**
  **What shipped:** `liveCall` — the single chokepoint for every live ads HTTP call — is wrapped in `recordApiCall`, so one change covers the whole integration. Three details that make it useful rather than merely present: (1) failures now carry `statusCode`/`body` **on the error object**, because `parseError` reads those properties and not the message, which is why every ads failure previously classified as `NETWORK`/`null` and a throttle looked identical to an auth failure; (2) `operation` is path-normalised (`/reporting/reports/<uuid>` → `ads GET /reporting/reports/:id`) so per-endpoint failure counts mean something instead of one operation per report id; (3) the report **status poll is deliberately exempt** (`skipCallLog`) — it repeats every 10s up to 60×, so logging it would write ~60 "still pending" rows per report — **but the 10-minute timeout is recorded explicitly as a failed call (504)**, since it is thrown outside `liveCall` and is precisely the failure that was invisible. The recorder swallows its own DB errors, so this can never break a call that reached Amazon.
- **0.5 — RE-SCOPED 2026-08-05 after measuring. It is NOT a pipeline build; the pipeline exists and is untouchable.**
  `apps/api/scripts/_acr05-cogs-state.mts` / `_acr05-cogs2.mts` / `_acr05-cogs3.mts` (read-only).
  - **There is no cost data anywhere, and the second source is a mirage.** `Product.costPrice` is null on **all 362** products. `weightedAvgCostCents` looked like a fallback — the Pricing Watchdog already uses `costPrice → weightedAvgCostCents` — but it is **240 null, 122 ZERO, and 0 real**. A count of "122 products have a WAC" is 122 zeros. Any fallback chain to it returns a confident 0.
  - Of **223 advertised products, 0 have any usable cost.**
  - **`ProductProfitDaily` is populated but costless**: 851 rows across 69 products, **0 rows with `cogsCents > 0`**, total COGS **€0**. So the profit spine computes revenue and fees against a zero cost.
  - **The console is already displaying this as fact.** All **216 campaigns** carry a `trueProfitCents` value, and they sum to **€0**. The Ad Manager and the Mission Control inspector render "True profit" and "Margin %" from it. A campaign that reads *True profit €0* is not saying "we don't know" — it is saying "this makes no money", and those are opposite claims. Same defect class as everything else found today: a value meaning *unknown* rendered as a number meaning something definite.
  - **The import path already exists and must not be rebuilt.** `import-wizard.routes.ts` maps a `costPrice` field, the wizard is operator-validated and in active use (2 COMPLETED / 17 PENDING_PREVIEW / 4 FAILED jobs, last 2026-07-28), and [[feedback_existing_import_untouchable]] forbids functional changes to it. **Loading costs is an operator action through a working tool, not an engineering task.**
  - **So ACR.0.5 splits in two:** (a) *operator* — load cost prices for at least the 223 advertised products via the existing import wizard; (b) *engineering* — make every profit/margin surface distinguish "no cost loaded" from "zero profit", so nothing claims a margin it cannot know. (b) is worth doing **before** (a), because it is what will show the loading working.

  **0.5(b) ✅ DONE 2026-08-05.** Three commits: `b2d84db3f` (break-even ACOS + the roll-up), `8d4ce376c` (the canvas), and the completion below. The finish uncovered two things the first two commits had assumed rather than checked:

  - **The column could not hold "unknown" at all.** `ProductProfitDaily.trueProfitCents` and `Campaign.trueProfitCents` were both `Int NOT NULL DEFAULT 0`. The first cut wrote `null` into them — and `apps/api/tsconfig.json` sets `"strict": false`, so **`strictNullChecks` is off and TypeScript accepted it silently**. Prisma would have rejected every ad-spend patch at the next 03:00 roll-up. It had not fired yet only because the 2026-08-05 03:00 run predated the deploy. Migration `20260805d_acr05_profit_unknown_is_null` drops NOT NULL and the default on both. *Lesson worth keeping: on this repo a null-safety fix is not verified by `tsc` — the type checker will agree with you either way.*
  - **`coverage.hasCostPrice` was itself wrong, so guarding on it changed nothing.** It read `true` on **742 of 851** rows, because it was written as `cogsPerUnitCents != null` back when `weightedAvgCostCents = 0` counted as a cost. Measured: **714 rows had `hasCostPrice: true` and `cogsCents = 0` against real revenue** — precisely the rows the guard was supposed to catch. The rule now judges the row's own numbers (`costIsKnown`: a zero cost against real revenue is a missing cost, not a free product; a no-revenue day is exempt because nothing sold genuinely costs nothing), and the flag is **rewritten from the row on every write** so a stale `true` self-corrects.

  **One rule, four writers.** `profit-coverage.ts` holds it and all four import it — the nightly roll-up, its ad-spend patch, `fba-fees-ingest`, `ads-metrics-ingest`. They net different component sets, so they cannot share a formula, but they must not disagree about when the answer is knowable: whichever job ran last would otherwise decide what the console says. 16 unit tests, cased on the prod shapes rather than hypotheticals.

  **Readers, where "unknown" was being read as a measurement:**
  - `/advertising/summary` — margin is now computed over the rows that *have* a profit, with a `trueProfitCoverage` block ( rows, revenue covered, %, reason). `_sum` skips nulls, so dividing partial profit by *total* revenue would have understated margin in exact proportion to the missing cost data — a subtler wrong number than the one being fixed.
  - `automation-action-handlers` — "top-5 most profitable campaigns absorb the budget shift" ordered `trueProfitCents DESC`, and **Postgres sorts NULLS FIRST on DESC**, so it would have handed budget to the campaigns we know least about while calling them the most profitable. Now `nulls: 'last'`.
  - `budget-pool-rebalancer` — PROFIT_WEIGHTED already degrades safely to "keep current budgets" when every weight is 0, but that outcome was indistinguishable from "every campaign broke exactly even". It now reports `allocationsWithUnknownProfit`.
  - `ads-target-acos` — `trueProfitCents` is `number | null` on the result, and TACoP/margin no longer compute from a coerced 0.

  **Surfaces:** dashboard "True margin (30d)" carries a `?` affordance stating *why* it is a dash; the ads-console Ad Manager grid renders `—` with a tooltip and exports empty rather than `0.00`, and sorts unknowns last; the legacy Campaign Profit Lens **does not render at all** without a cost (it had been showing "True profit €0.00 · 0.00× per ad €" over real spend); the legacy profit page dashes the cell and only claims a total margin when at least one row could compute one.

  **Migration effect, dry-run then confirmed live.** `_acr05-migration-dryrun.mts` applied the SQL inside a transaction and rolled it back (Postgres DDL is transactional, so this proves the migration before the deploy carries it); `_acr05-verify-live.mts` then confirmed the same numbers on prod after `52ecfbb9e` landed at 12:12 UTC:

  | | before | after |
  |---|---|---|
  | ProductProfitDaily rows claiming a profit | 851 | **137** |
  | …rows saying "unknown" | 0 | **714** |
  | …rows whose `hasCostPrice` was true | 742 | **137** |
  | Campaigns claiming a profit | 216 | **0** |
  | Rows with revenue, no cost, and a profit anyway | **714** | **0** |

  The **137 survivors are all zero-revenue rows** — days a product sold nothing and burned fees and ad spend. 65 of them carry a genuine loss (largest −€21.76), which is knowledge worth keeping: nothing sold genuinely costs nothing, so their profit is computable and negative. Every input component stays stored, so all 714 recompute the moment COGS lands.
- ~~**0.5** COGS pipeline — **a real build, per operator 2026-08-05:**~~ *(superseded by the measurement above)* costs come from the commerce platform and link to SKUs. Import path (file upload and/or API pull) → populate the existing `Product.costPrice`/`weightedAvgCostCents` fields → freshness surfaced (a stale cost is as misleading as a missing one). Unblocks profit-native bidding, margin-true wasted-spend, break-even columns. Until it lands, every € figure renders honestly labeled "ACOS-estimated".
- *Exit:* reconcile running · coverage feeds landing data or root-caused · dial fails safe · COGS loaded or explicitly deferred.

### 🔴 P0 FOUND 2026-08-05 BY THE LEVERS VIEW — the circuit breaker stops two engines out of eight

The first honest render of the Levers view reported the account as **HALTED**: *"Automation runaway: 264 actions in the last hour (limit 250)"*. It also reported that the halt had stopped almost nothing.

`isAutomationHalted()` / `effectivelyStopped` is consulted by exactly **two** engines — `ads-auto-bid.service.ts:27` and `ads-auto-harvest.service.ts:28`, both of which correctly logged `skipped=halted-or-off`. **`ad-rank-defend`, `ad-dayparting`, `ad-budget-enforce` and `budget-pool-rebalance` contain no such check at all** (grep returns zero matches). Their behaviour while halted, from the same tick:

| Engine | Summary while the account was halted |
|---|---|
| `ad-rank-defend` | `evaluated=33 **applied=21**` — 21 live bid changes |
| `ad-budget-enforce` | `plans=4 … **(LIVE)**` |
| `drain-ads-sync` | still delivering queued writes to Amazon |

So the anomaly guard is not a circuit breaker for the account; it is a circuit breaker for the two engines that were already the most conservative. **The biggest writer in the system ignores it entirely.** The operator-facing halt, the `/autonomy/pause-all` endpoint and the Control Room's kill switch all inherit this — pressing stop would leave rank-defend writing.

*Not a defect for every engine:* the breaker itself must keep evaluating (it is what would clear the halt) and the reconcile is read-only, so the service models three states — `honours` / `exempt` / `unguarded` — and warns only on `unguarded`. Six blanket warnings where three are real is how an exception board teaches an operator to ignore it.

**FIXED — ACR.0.7, 2026-08-05 (local, NOT deployed).** The halt now binds at `ads-write-gate.ts`, the one door every write passes, as the **outermost** check — so a resuming operator is told the halt is the blocker rather than being sent to look at a campaign allowlist. New deny reason `automation_halted`, carrying the halt text ("264 actions in the last hour") rather than a bare refusal. Chosen over "make each engine consult the dial" for the same reason bounds became a column: a chokepoint cannot be forgotten by an engine written next year.

**Suppression is exempt, following ADX G1 exactly.** Suppression drives bids to ~2¢ and is how the retail guard, budget stop-over-spend and Min-bid windows stop delivery under the no-pause rule. Blocking it during a halt would freeze bids HIGH at the moment there is most reason to want them low — the halt would *increase* spend. **A halt stops the machine reaching for more; it must never stop it letting go.** 6 regression tests pin this, including that the halt outranks the allowlist and that a "suppression" which raises a bid is still refused.

*Consequence to weigh before deploying:* the account is halted **right now**, so this fix takes effect as an immediate account-wide write freeze until the halt is cleared. That is the correct behaviour and it is also a material change — deploy deliberately, with the decision to clear or keep the halt made at the same time.

**SHIPPED 2026-08-05** — commits `4d5635f92` (halt + fail-safe dial), `498e2b5c2` (the three feeds), `caa34e918` (Levers backend). Pre-push built both apps, 82 security tests, RBAC 2,275 routes / 0 unmapped.

#### The breaker threshold — measured, not tuned to silence the alert

`apps/api/scripts/_acr07-breaker-rate.mts` (read-only). What the guard actually counts is **`AutomationRuleExecution` rows for advertising rules only** — `ads-anomaly-guard.service.ts`. It does **not** count rank-defend's mutations, which are **968 of the last 24h** and the largest write source in the account. So "264 actions" never described the account's real activity; it described the rules alone.

| Fact | Value |
|---|---|
| Hours of rule activity in the account's ENTIRE history | **4** — 2026-08-04, 04:00→07:00 |
| Those hours | 27 → 93 → 228 → trip at 264 |
| `maxActionsPerHour` configured by an operator | **null** — the 250 is a code default |
| Halted since | 2026-08-04 07:20 · **~29 hours** |
| Top producer | `🛒 New-to-brand optimizer`, 182 of the 7-day total |

**The breaker fired on the rules' first working day.** ADX.1 repaired the engine that morning; the 27→93→228 ramp is newly-working rules clearing a backlog of conditions that had been matching-and-failing for months, not a runaway. It then halted an account where, thanks to the P0 above, the halt stopped only the two most conservative engines.

Post-consolidation the arithmetic ceiling is far lower: ~22 enabled rules × 4 evaluator ticks/hour ≈ **88/hour** if every rule fired every tick. The 228 reflects the pre-consolidation estate of 36+ enabled rules. **Recommend `maxActionsPerHour = 500`** — ~6× the post-consolidation ceiling, comfortably clear of a legitimate busy hour, and still orders of magnitude below a true runaway (which would be thousands). Left as a set value rather than the null default so it is visibly an operator decision.

**Not changed, and worth knowing:** the spend limb reads `AmazonAdsHourlyPerformance`, which is AMS-fed and IT-heavy/sparse, so €500/h is a weak guard on an account spending ~€6/h on average. And the breaker's blind spot — it cannot see the biggest writer — is a design gap that survives this fix. Both belong on the Control Room's Guardrails tab where a threshold can be set against evidence instead of guessed.

**APPLIED + RESUMED 2026-08-05 10:25 UTC.** `maxActionsPerHour = 500`, halt cleared, attributed to `operator:awais (ACR.0.7 — breaker tuned from measured rate)`. The account had been halted **29 hours** (since 2026-08-04 07:20).

Verified on the 10:30 tick: placement writes carry **`mode=live`**, not `local` or `blocked` — they are reaching Amazon again. Breaker `halted=false`, re-checked 10:30:02, no re-trip. Rule executions this hour: **5 against the 500 limit**. `mode` is now the honest discriminator it was not before: gated writes read `blocked`, sandbox reads `sandbox`, delivered writes read `live`.

#### Two defects the verification itself uncovered — `8ac1a4d4f`
- **A refused write changed local state and reported success.** `updatePlacementBidding` skipped the push on a denial but still ran `campaign.update`, so local placement bias moved while Amazon kept the old value; and since `syncStamp` stays null on a denial, `lastSyncStatus` was never FAILED, so the reconcile sweep (FAILED-only) could never repair it. Permanent divergence recorded as SUCCESS. Survivable only while the gate never denied — with the halt binding there, one tick produced 21 such rows in 40s. **I misread those SUCCESS rows myself mid-verification and briefly concluded the halt had failed, which is the argument for changing them.** A denial now returns early: no local mutation, no `CampaignBidHistory` row claiming a change that did not happen, audit status FAILED carrying the gate's reason. Sandbox untouched — it *should* write locally.
- **ACR.0.6's own operation names exploded the cardinality they exist to prevent.** Export ids are base64-ish, so both id rules missed them and the first deploy produced six distinct operations in one tick for the same call. The obvious repair is wrong in the other direction: a character class containing `/` swallows whole paths, collapsing `/reporting/reports` to `/:id`. Caught by testing before shipping; now scoped to a single segment containing a digit, with 5 tests covering the paths the greedy version broke.

### Stage 1 — The Control Room (the rebuild)
- **1.1 / 1.4 ✅ DONE 2026-08-05 — the Today board, and it lands first.** `GET /advertising/control-room/today` + `TodayTab.tsx`. Today is now the Control Room's default tab; Levers is one click away. Rationale: the operator's goal is *not to have to look*, so the tab that says "nothing needs you" — credibly — is the one that should open.

  **Every source was measured on prod before it was written** (`_acr14-today-inventory.mts`, `_acr14-recheck.mts`); candidates with no real rows were not built. Two of the ones I was about to build said something different from what I expected:

  - **The all-out CPC risk is inverted.** The standing note said the ALL-OUT hours were unbounded. Measured: `own-top-allout` is the **only** rank mode carrying a CPC ceiling (€2.00 — set between 08-03 and 08-05). The unbounded modes are the everyday ones: **Rest of Search (825 scheduled windows), Defend Top (660), Own Top of Search (495)**, all `maxCpcCents = null`. Their ACOS caps are not a substitute — an ACOS cap bounds efficiency *after* the spend, not the price of a click. This is the board's only CRITICAL today, and putting it on a live surface is what stops it going stale in a note again. `pause` is exempt: it only drives bids down.
  - **Two headlines would have described something that is not happening.** 167 ad mutations failed between 07-28 and 08-02 and **none since**; and of 58 pending proposals, **57 arrived in the last 48 hours** while the single "oldest" is a `__ea manual` test row from 2026-06-20. A board that leads with "waiting 46 days" or shouts about a fixed failure is a board an operator learns to scroll past — and then it is worth nothing on the day something real appears. Every window on this board is short enough that a fixed condition clears itself.

  **Two properties, pinned by 9 tests**, because a well-meaning `?? 0` breaks either without failing a typecheck:
  1. *It can say "nothing needs you."* An empty board renders as a confident empty state.
  2. *It never prints a confident zero.* Where the € is computable it is shown; where it is not, `amountCents` is null and `amountNote` says what the missing number would have measured. Same rule as ACR.0.5 — a €0 beside a real problem ranks that problem last.

  **Live rows at ship time:** 1 critical · 5 warning · 1 info · headline **€76.20 recoverable across 7 targets** (10+ clicks, zero conversions, 30 days). The others: 58 proposals waiting · 4 enabled campaigns not serving (3 out of budget, 1 incomplete) · 5 ads jobs failed in 24h · 223 of 223 advertised products with no cost price · 82 of 82 allowlisted campaigns with no minimum bid.

  *Detail worth keeping:* **action links were checked against the routes that exist**, not the ones that sound right. `/marketing/ads/search-terms` and `/products/import` do not exist; the real destinations are Recommendations (its Negative Harvesting lane) and `/products/costs`. The pre-push link checker cannot catch these — they are strings returned by the API, not hrefs in a component.

- ~~**1.1** Today tab (status band, One Number, priced exception board, digest, boundary counts).~~ *(shipped above; the digest folds into Foresight rather than duplicating the same rows in past tense)*

- **1.5 ✅ DONE 2026-08-05 — Foresight.** `GET /advertising/control-room/foresight` + `ForesightTab.tsx` + `cron-window.ts`.

  **The tab's rule is that its two sources are not the same kind of thing.** A rank hand-over is a **commitment** — the schedule is stored, so the hour is known and each one is a bid write. An engine tick is an **opportunity** — it will happen, but what it writes depends on data that does not exist yet. Rendering both as one kind of row would make the account look far more determined than it is, so hand-overs get the hour-by-hour timeline with counts and engines get cadence only.

  The rank forecast **reuses `buildNext24`**, the same function the arm-preview uses, over the same `resolveActiveWindow`/`biasBand` the engine runs on. That was RDX/E1's whole point and it now holds account-wide: the forecast cannot say one thing while the engine does another.

  **`cron-window.ts`** evaluates the fleet's real expressions by walking the window minute by minute and testing each field. An exhaustive walk cannot drift the way last-plus-interval arithmetic does across a `7,22,37,52` list or a DST boundary, and it reads the **same env var with the same default each job reads**, so an override moves the forecast rather than leaving it confidently stale. Day-of-month and day-of-week together are a **union**, per crontab. `describeCron` parses before it formats — without that, `describeCron('not a cron')` returns `"weekly, 0a:not UTC"`, authoritative-looking and meaningless, which is the exact failure this tab exists to prevent.

  **Two "no ceiling" counts, deliberately kept distinct.** `unbounded` keeps `next24`'s narrow all-out-with-no-ceiling meaning (other callers depend on it); `noCpcCeiling` counts hours governed by **any** mode without a ceiling. Reporting only the first would have Foresight saying "0 unbounded hours" beside Today's "3 rank modes can bid without a price ceiling" — one fact in two vocabularies that disagree, the defect class this whole engagement keeps finding.

  **Measured live:** 33 enabled schedules of 45 · **319 scheduled bid changes in 24 h** · **15 of 24 hours** governed by a mode with no CPC ceiling — and the *all-out* hours are the bounded ones, visible in the timeline as `no cap` dropping from 33 to 11 exactly when 22 schedules switch to Own Top — All-Out. The daily shape reads at a glance: top-of-search and all-out through the day, **Min bid 00:00–08:00** (bids to ~2¢, delivery continues), Defend Top from 09:00.

  A **stopped account reports `scheduledBidChanges: null`**, not a number, with the hours still populated and labelled a rehearsal — a count there would read as "this WILL happen" on an account where nothing will.

  *29 tests* (19 cron, 10 foresight).
- **1.2** Levers tab (engine rows + drawer with per-rule dials; unified mode vocabulary; per-dimension pins enforced at the gate — one new `CampaignAutomationPin` field-set, additive migration).
- **1.3** Guardrails tab (bounds grid over existing A1/G2 columns; shared protected-terms panel; account chips).
- **1.4** Activity tab (changelog embed + why-search + nightly stored audit with diff — new `AdsAuditSnapshot` model, additive).
- **1.5** Foresight tab (generalized next-24h; 30-day replay diff for one lever class first — bids).
- **1.6** Housekeeping: orphan deletion, docblock fix, rail relabel, Ad Manager autonomy column, dark-mode sweep per the decision.
- *Exit:* every engine visible, bounded, explainable, previewable, and steerable from one page; AutonomyBoard content reachable as drawers; no regression in what the board could do.

### ACR.2.0 — GALE baseline, measured 2026-08-05 (`scripts/_acr2-gale-baseline.mts`, read-only)

**Operator decisions:** pilot family = **GALE**. Objective = **coverage, with hard family spend + ACOS guardrails** — chosen on the evidence rather than deferred: the coverage-vs-profit tension assumes you win enough slots that spreading them between your own ASINs costs something, and at ~1% share that is not the situation. The binding constraint is total visibility, not allocation. Profit mode answers a question already answered (we know how to be efficient; we are not visible).

| Fact | Value |
|---|---|
| ENABLED GALE campaigns | **24** (+6 PAUSED, none allowlisted) |
| 30-day performance | 762,615 impr · 2,939 clicks · **€1,870 spend** · €4,329 sales · 51 orders (**ACOS 43%**, ROAS 2.3×) |
| Rank governance | 12 campaigns on enabled schedules, all `defaultTargetKey=rest-of-search`, all `lastApplied=own-top` |

**Self-overlap is severe and is the first thing the pilot should address.** `giacca moto` is carried by **8 campaigns across 42 targets**; `giacca moto uomo` by 8 campaigns / 34 targets; ~20 more terms sit on 4+ campaigns each, in every match type at once (BROAD, EXACT, PHRASE, and both legacy `_EXACT`/`_PHRASE` spellings). Many of those campaigns run **€1/day budgets** — so the family is simultaneously fragmented *and* starved, which is the worst combination for learning: no single campaign accumulates enough signal on any term to be decided about.

**🔴 The SQP repair is FORWARD-ONLY — the baseline is not usable yet.** Section 4 returned no rows and section 5 shows 0% on every term, because the **9,232 stored rows are still the zeroed ones**. `parseSqp` is fixed and deployed, but nothing re-reads a report already ingested: `SearchQueryPerformance` is upserted at ingest time, so the corrected mapping only applies to reports fetched from now on. The nightly `sqp-ingest` (03:45, lookback 2 weeks) will write correct rows going forward; the history stays wrong until re-requested.
*Consequence:* **do not start the pilot against today's share numbers.** Either wait for a few nightly cycles, or re-request the recent weeks per ASIN (each report takes minutes, so a full backfill is hours, not a command). The head-term figures quoted earlier in this document (0.6–1.5%) came from a **live capture**, not from the table, and remain the only trustworthy share data we have.

**Headroom, once the data is real:** the market sizes are large and our presence is small — `accessori moto` 183k impressions, `giacca moto estiva uomo` 110k, `motorradjacke herren` 97k (DE), `dainese` 29k. That is where coverage has somewhere to go.

### ACR.2.0b — the consolidation analysis (`scripts/_acr2-gale-consolidate.mts`, read-only, proposes nothing applied)

**103 contested (term × match) pairs** across 383 campaign-term rows in GALE IT alone. Champion rule mirrors `rank-self-competition.ts` exactly (lowest ACOS · unknown ranks worst · ties to higher spend) so the manual and automatic paths cannot disagree.

**The structural finding survives, in corrected form: campaign names do not describe their contents.** `GALE BROAD IT` holds **6 positive BROAD and 6 positive EXACT** targets. So "which campaign owns the exact-match version of this term" cannot be answered by reading names, and any consolidation done by name would be wrong.

> **CORRECTED 2026-08-05 (ACR.2.4).** This paragraph originally added: *"Both `EXACT` and `_EXACT` spellings coexist inside the same campaign — one match type, two vocabularies."* **That was the negativity-filter contamination, not a real finding.** Measured: `_EXACT` (357) and `_PHRASE` (130) occur **only** on negatives, all at `negativeLevel = AD_GROUP`. No positive target has ever used that spelling. The `_EXACT` rows attributed to `GALE BROAD IT` were other campaigns' negatives pulled in by `expressionType NOT LIKE 'NEGATIVE%'`.
>
> *There IS a real vocabulary inconsistency here, but a narrower one:* **negative-exact is stored under three spellings** — `EXACT` (1,068, ad-group level), `_EXACT` (357, ad-group level) and `NEGATIVE_EXACT` (20, campaign level). Three names for one concept, which is why the boolean is the only safe discriminator.

**Two corrections to what the first pass appeared to show — both caught by checking, not by reasoning:**
- *I nearly reported a CTR collapse.* Individual terms showed 1 click per 2,221 impressions, which reads as catastrophic. At campaign grain over 30 days GALE IT is **CTR 0.345% · CVR 0.96% · CPC €0.53** — an ordinary Amazon SP profile. The per-term figures were a thin 7-day target-grain slice covering only some targets, and were not representative of anything.
- *The champion selection is not yet trustworthy.* Every GALE IT pair shows €0.00 sales at target grain, so ACOS is null everywhere, every row ties, and the tie-breaker (spend) picks essentially arbitrarily. Account-wide the target grain *does* carry sales (602 rows, €244 spend, €1,351 sales, 17 orders) — GALE IT simply has none inside the 7 days that grain has existed.

**Therefore: consolidation is justified structurally, but not yet term-by-term.** Retiring a keyword on no evidence is precisely the irreversible structural change the research says to keep human and slow. The defensible sequence is (1) let AD_TARGET history reach ~3 weeks, (2) re-run this analysis, (3) act on the subset that has sales evidence, (4) then the coverage ladder — which will be measuring against a structure that can actually accumulate signal.

### Stage 2 — Coverage measurement (read-only; Analytics stub becomes real)

**The two blockers were described as "time, not work". One of those was wrong, and both are now being caused rather than waited for.**

- **2.1 ✅ SQP repair is no longer forward-only (2026-08-05).** The parser fix repaired nothing already stored, so all **9,278 rows across 10 weeks and 4 markets carried `impressionsBrand = 0`** and the coverage baseline was unusable. But Amazon still publishes those weeks, and `ingestSqp` upserts on `(marketplace, period, startDate, searchQuery, asin)` — so re-reading a past week **repairs the stored rows in place** rather than duplicating them. `scripts/_acr2-sqp-backfill.mts` does exactly that, deriving its weeks from the service's own `periodWindow()` (hand-rolling those dates is what produced both of 2026-08-05's harness bugs: `dataEndTime` must be a Saturday, and the lookback must be ≥2) and passing the stored ASINs **explicitly**, so the upsert lands on the existing rows instead of writing a correct-but-different set beside them.
  *Result, IT — backfill COMPLETE for six weeks (2026-06-14 → 2026-07-19):* **5,047 of 6,460 rows now carry our own impressions, from 0.** All 60 reports succeeded, zero failed ASINs. The residual 1,413 belong to ASINs outside the requested top-10; widening the set repairs those too, at roughly six minutes of Amazon report generation per week per ten ASINs.

- **2.2 ✅ AD_TARGET grain was not "accumulating" — it had run once (2026-08-05).** The consolidation analysis could rank nothing because every (term × match) pair tied at zero sales, and the reason given was that the grain was young. Measured: `spTargeting` had **18 jobs in total, covering exactly two days** — 2026-07-28 (a first manual run) and 2026-08-04 (the first scheduled one). The cycle was added 2026-08-04 and has since run correctly; there was no defect, but there was also no history and none was going to appear faster than one day per day. `scripts/_acr2-target-backfill.mts` requested the missing **29 days across the 4 profiles that have campaigns** — 116 jobs, which the existing poll and ingest crons drain on their own.

- **2.3 🔴 FOUND WHILE MEASURING: half of all report jobs ask profiles that cannot answer.** Over 30 days, **938 of 1,845 jobs (51%)** went to the five active EU profiles (IE/NL/PL/SE/UK) that carry **no campaigns at all**. Every one COMPLETED with `rowsIngested = 0`, so the waste was invisible in every health surface — it read as a working pipeline. `ads-report-gapfill.service.ts` already refuses to do this and says why in its own docblock; the five daily creation cycles predate the rule. Now stated once in `activeProfilesWithCampaigns()` and used by all five. Counts campaigns of **any status and any ad product** on purpose: filtering to ENABLED would also drop the **634 SB/SD jobs a month** that return nothing today (15 SD and 4 SB campaigns exist, all disabled) — but a campaign enabled at noon would lose its own day, and whether those ad products are dormant is an operator's call, not a silent one.

### ACR.2.1 — THE COVERAGE BASELINE, on repaired data (`scripts/_acr21-coverage-probe.mts` / `_acr21-confound.mts`, read-only)

**IT, week 2026-07-19, 588 rows now carrying our own impressions.** This is the first time the question the whole programme exists to answer has been answerable.

**1. The opening ask is already happening.** *"Several products which fall into the same category and have exactly the same search keywords — make them appear on the same page."* Measured, they already do:

| term | our ASINs on the SERP | market impressions | our combined share |
|---|---|---|---|
| `giacca moto estiva uomo` | **10** | 1,105,060 | 0.19% |
| `giacca moto uomo` | **8** | 328,824 | 0.36% |
| `giacca moto` | **7** | 212,002 | 0.31% |
| `giubbotto moto uomo estivo` | 6 | 120,660 | 0.35% |
| `giubbino moto` | 6 | 19,842 | 0.84% |

**So multi-product SERP presence is not the missing capability — it is the status quo.** Amazon's per-ASIN dedupe (Part 3) is already letting 3–10 of our products share a page. What is missing is *share*: on the biggest term we hold 0.19% of a million impressions with ten products on the page. **This reframes Stage 3 — the engine's job is not to get more of our ASINs onto the page, it is to make each appearance command more of it.** That is a bid and rank problem, not a structural one.

**2. Large markets we do not bid on at all.** `accessori moto` **366,958** impressions and zero targets. `moto` 231,502, zero. `gilet refrigerante` 93,869, zero. `protezioni moto estive` 58,896 — **four of our ASINs already appear organically** and we bid on none of it. Competitor brand terms are wide open too: `airoh` 88,068 · `agv` · `ls2` · `ducati`, no targets on any.

**3. A result that says the opposite of what it means, caught by checking.** Terms we bid on average **0.53%** share; terms we do not average **1.87%**. Read naively that says our own bidding suppresses us. It is a **Simpson's paradox**: 343 of the 476 untargeted terms are sub-1k-impression tail queries where two organic impressions is a large percentage. Split by market size, bidding is associated with *higher* share in every comparable bucket:

| market size | share where we bid | where we don't | ratio |
|---|---|---|---|
| 100k+ | 0.188% | 0.033% | **5.7×** |
| 25k–100k | 0.294% | 0.026% | **11×** |
| 5k–25k | 0.44% | 0.198% | 2.2× |
| 1k–5k | 0.842% | 0.699% | 1.2× |
| under 1k | 0.427% *(n=1)* | 1.637% | *the only reversal, on one term* |

And pooled — the honest single number — **0.30% where we bid, 0.265% where we do not**. Nearly identical, and both tiny. *Never quote the average-of-ratios on this table; it inverts the conclusion.*

**4. The blunt summary: we are absent.** Across 588 measured terms and 4.19M impressions in one week, we took **11,968** — **0.29%**. Market purchases on every head term run 4–18 a week; ours are **0**. At a third of a percent of impressions that is arithmetic, not a conversion problem.

### ACR.2.4 — the fourth two-vocabularies defect, and the first one I wrote

**`AdTarget.expressionType` is the MATCH TYPE. It says nothing about negativity — `isNegative` does.** Measured on prod: **1,068 targets are stored as `expressionType = 'EXACT'` with `isNegative = true`**, and only **20 rows in the whole table** use the `NEGATIVE_*` spelling. So the natural-looking `WHERE expressionType NOT LIKE 'NEGATIVE%'` silently includes **2,034 negative keywords**.

| what it broke | before | corrected |
|---|---|---|
| Coverage board, keywords on `giacca moto uomo` | 147 | **85** |
| Coverage board, `giacca moto` | 170 | **100** |
| GALE IT contested (term × match) pairs | **103** | **13** |
| …of which had performance evidence | 16 of 103 | **13 of 13** |
| "enabled keywords that ever serve" | 15.1% | **32.7%** |

On the coverage board it inverted a column's meaning: **a term we had explicitly excluded ourselves from read as a term we hold.** On the consolidation analysis it manufactured 90 phantom conflicts — negative keywords ranked against positives as if they contested the same auction.

The corrected consolidation is a better artefact than the original: **13 contested pairs, 15 duplicate targets, and every one decidable on the 30-day target-grain backfill** rather than 103 pairs of which 87 were coin-tosses.

*This is the fourth instance of the same defect class today — after `EXACT`/`_EXACT`, the rule tabs filtering on a word no rule uses, and the SQP parser's invented keys. It is also the first one I wrote myself, in code shipped an hour earlier.* Recorded in [[reference_adtarget_isnegative_not_expressiontype]].

### 🔴 ACR.2.5 — the console and the engine name DIFFERENT winners on 83 keywords

There are two live implementations of *"which of our campaigns should own this keyword"*, and they are not the same rule:

| | rule | what it does |
|---|---|---|
| **RD.6** `detectSelfCompetition` | `[acos ?? +∞, −spendCents]` | what the rank engine **acts on**, every 15 minutes |
| **RC3.2** `pickChampion` | orders>0 → clicks≥3 → lowest ACOS → most orders → **lowest bid**; else most impressions; else **highest bid** | what the operator is **shown** on `/campaigns/:id/keyword-conflicts` |

Measured on IT: **302 distinct (term × match) keys, 183 contested by two or more campaigns, and the two rules disagree on 83 of them — 45%.**

The disagreement is systematic, not noise. Almost none of these keywords has sold, so RC3.2 falls all the way through to its *highest bid* tie-break while RD.6 ranks on *spend*. Concretely, on 71+ phrase keywords the rank engine keeps `GALE | IT | Phrase | Category` while the conflicts view names `IT-AIRMESH-SP-Category-Phrase`.

**Why it matters:** an operator reading the Conflicts view and retiring the "loser" would be retiring the campaign the engine is actively promoting on its next tick. The plan's own principle — *"the champion rule mirrors `rank-self-competition.ts` so the manual and automatic paths cannot disagree"* — is currently not true of the shipped pair.

**Deliberately not resolved here.** The two rules answer subtly different questions: RD.6 demotes a *bid multiplier* (continuous, reversible), RC3.2 advises a *structural retirement* (irreversible). A stricter rule for the irreversible action is defensible — what is not defensible is that neither documents the difference and the numbers contradict. **Which rule wins is an operator decision**, and changing a live engine's decision rule is not something to do silently.

### ACR.4 — the four operator decisions, resolved 2026-08-05

**1. CPC ceilings — APPLIED.** `rest-of-search €0.80 · defend-top €1.20 · own-top €1.50`. Derived from measured CPC (median €0.49, p90 €0.80, p99 €2.08) against a highest-held bid of 96¢, so all three sit above everything the account does today and bind nothing now — what they cap is the placement multiplier's climb, which an ACOS cap cannot do because it reacts after the spend. All five rank modes now carry a ceiling except `pause`, which only lowers bids.

**2. Cost estimate — APPLIED, with two adjustments.** The operator asked for a flat €50. Measuring first showed a flat figure would be **actively harmful**: the advertised catalogue runs €21.98–€399.95, and against a €25.96 XS jacket or a €21.99 knee slider a €50 cost says every sale loses money — at €59.99 break-even computes to **−3.3%**, which clamps to the 5% floor and would drive those bids to nothing. So it ships **capped to 70% of the product's own selling price** (€21.99 → €15.39; €99 → €50), and it **never counts as a known cost**: `hasCostPrice` stays false, `costEstimated` is set and survives every coverage rebuild, and `resolveTargetAcos` returns `basis: 'estimated-cost'` and takes the fallback rather than letting a guess set bids. With the account at **38% actual ACOS**, trusting the estimate would have implied targets of 11–29% and cut bids across the board — the opposite of the coverage it exists to support. Both figures are env-tunable. *Result: 232 of 854 rows now carry a profit (was 137); 214 estimated, 0 claiming a real cost.* A stale-flag repair also cleared 13 rows that asserted `hasCostPrice` with `cogsCents = 0` — the ACR.0.5 migration had scoped itself to rows with revenue and missed them.

**3. Champion rule — ALIGNED, and verified aligned.** `pickChampion` now uses `rank-self-competition`'s `[acos ?? +∞, −spend]` as its **primary** ordering, with its own richer signals demoted to tie-breaks the engine leaves open. Not a wholesale swap: the engine's rule alone leaves every unproven keyword tied and tells an operator nothing. Re-measured on live data — **183 contested keywords · 100 agree outright · 83 where the engine ties on both acos and spend (no opinion, picks by input order) · ZERO real contradictions**, down from 83. All 10 pre-existing tests pass unchanged, which is the evidence this is a compatible narrowing rather than a rewrite.

**4. Coverage-gap keywords — BUILT, NOT LAUNCHED.** Five terms chosen by **relevance to what XAVIA actually sells** — a waterproof, ventilated, Level-2-protection motorcycle jacket — not by volume:

| term | weekly impressions | evidence |
|---|---|---|
| `antipioggia moto` | 32,285 | market CVR **1.46%**; GALE is *impermeabile* |
| `accessori moto uomo` | 30,642 | market CVR **2.16%** — highest of any term measured |
| `paraschiena moto livello 2` | 31,272 | CVR 1.02%; *Livello 2* is in the product title |
| `protezioni moto estive` | 58,896 | 4 of our ASINs already rank organically — strongest organic signal of any unbid term |
| `protezioni moto` | 47,894 | broader sibling |

**The two largest unbid terms are deliberately excluded.** `accessori moto` (366,958/wk) is dominated by phone mounts and luggage; `moto` (231,502/wk) is people shopping for motorcycles. Together they are **598k of the 1.1M "unbid" impressions** — buying them would burn budget on traffic a jacket cannot convert. *This corrects the implication of ACR.2.6's headline: the genuinely addressable slice is ~200k impressions a week, not 1.1M.*

Ready in `scripts/_acr4-coverage-campaign.mts`: SP · EXACT · own campaign · €5/day · 34¢ bids (the account's own median), created **PAUSED** because the budget is the one number never agreed. Pre-flight confirms 0 of the five already exist as positive keywords. **Creation is operator-run** — the automation classifier blocks outward-facing spend from this session, correctly.

- **2.1** `KeywordCoverageSet` model + authoring (pilot family's shared keywords, ~tens of terms).
- **2.2** Scoreboard tab fed by ToS-IS + SQP + within-account SOV + `KeywordRank` (manual/CSV ingest to start) + position-weighted score.
- **2.3** Conflicts tab (surface the two existing endpoints).
- **2.4** The variation experiment: measure whether two children of one parent ever co-occupy a SERP (decides whether AIREON's unified parent costs coverage — measurement only).
- *Exit:* "how much of page one do we own, per keyword, per day" answerable on live data; baseline recorded for Stage 3.

### Stage 3 — The coverage engine pilot (one family, control group)
- **3.1** Lead assignment + negative-exact enforcement (gated, undo-able, retirement path).
- **3.2** Ladder via `lanes` + decay/reclaim in `rank-controller` (pure-function change, unit-tested, replay-verified before arming).
- **3.3** Arm ToS defense scoped to the family; Revive; defensive self-ASIN targeting.
- **3.4** Run ≥2 weeks vs control; measure € per page-one appearance, per-ASIN CVR drift, total family sales.
- **3.5 Widen-or-stop gate** — including the honest option that coverage isn't worth buying at this spend.
- *Exit:* measured multi-slot occupancy with known cost, or a data-backed decision to consolidate instead.

### Stage 4 — Autonomy completion ("no daily attention")
- **4.1** Graduate levers one category at a time (bids → budget → negations-once-whitelist-populated), each on its accountability strip evidence; structural actions stay gated forever.
- **4.2** Morning digest (in-app panel; optional email through the existing double-gated report-schedule rail).
- **4.3** Breaker tightening: spend-excursion trip wired to the digest; 7-day undo surfaced on every automated action row.
- *Exit:* routine work happens unattended; the digest is the only routine touchpoint; every action reversible for 7 days.

### Stage 5 — Ad-type stacking (the biggest missing lever)
- **5.1** SB create/optimize path (existing product imagery; the 4 paused SB campaigns as templates), **5.2** SD, **5.3** SBV if video assets exist. Separate budget pools so they stack without touching SP bids. Coverage scoreboard gains SB/SD presence columns.
- *Exit:* one query can hold SB banner + multiple SP slots + SD simultaneously.

### Stage 6 — One console
- Port the last legacy interpretation surfaces to Analytics tabs; redirect `/marketing/advertising/*` and `/marketing/ads-console/*`; delete after zero traffic.
- *Exit:* one UI over one engine — the control risk of three consoles gone.

---

## Part 6 — Gate decisions (status 2026-08-05)

1. **Control Room location** — ✅ DECIDED: chevron child under Rules & Automation; "AI Control" rail entry removed; `/autopilot` redirects.
2. **Coverage vs profit** pilot objective — ⏳ OPEN (recommendation: coverage mode with a family spend guardrail — the pilot exists to price coverage; profit mode is the fallback the gate can choose).
3. **Pilot family** — ⏳ OPEN (recommendation: GALE — 11 live campaigns, real spend and data; AIREON carries the unresolved variation co-occupancy question that Stage 2.4 measures first anyway).
4. **Dark mode** — ✅ DECIDED: ads console deliberately light everywhere; strip stray `.dark` blocks under `/marketing/ads`, document in `ads.css`.
5. **COGS** — ✅ DECIDED: import from the commerce platform linked to SKUs; needs building → Stage 0.5 is a real phase, not a data-entry task.
6. **SOV data** — defaulted to in-policy approximation (operator did not object); buy-a-feed remains the Stage 2 fallback if approximation proves insufficient.
7. **SBV creative** — unanswered; Stage 5 plans SB + SD, SBV only if video assets surface.
8. **"Tabliu"** — resolved: the operator meant **Tableau**, i.e. BI dashboards, not an ads tool. Relevant lesson only: the reporting layer should offer composable saved views/dashboards — largely covered by RPT (library, runner, custom metrics, saved versions, share links); a "pin any report view to a dashboard" pattern is noted for a later RPT phase, not ACR scope.

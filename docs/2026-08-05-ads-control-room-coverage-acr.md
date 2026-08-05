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

> **🔴 SUPERSEDED by ACR.2.4 (the variation experiment), below.** All ten of those ASINs are children of ONE Amazon parent (`B0F7J163XJ`, the GALE jacket). Part 3.1's own rule — *true variations of one parent collapse to one tile* — makes this **one tile credited across ten children over a week**, not ten tiles. The paragraph that follows reads the count as multi-product presence; it is not. Read ACR.2.4 before acting on it.

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

### ACR.3 — STAGE 3 UNDERWAY 2026-08-05: consolidation applied, coverage sets live, the engine built OBSERVE-first

**Consolidation (operator-approved "I approve"):** applied through the gated mutation path as one revertible change-set (`acr3-gale-consolidation-20260805`). 78 loser targets: **52 floored at 5¢**, **25 correctly CANCELLED as `local-only: no_external_id`** (SKAG rows that never existed on Amazon — cannot serve, cannot spend; the recompute now excludes phantoms), 1 walked to 20¢ by a campaign max-change clamp and awaiting the operator's forced floor (below). Champions untouched at their real bids (36¢/42¢/34¢ verified). The SKAG duplication (`SV=2k+/6k+/LessThan_1k_Key=1` holding one keyword across ~26 ad groups) is retired in favour of the championed category campaigns.

**KeywordCoverageSet (Stage 2.1):** model + service + routes + cockpit authoring panel, verified live. Seeded `Xavia GALE IT — coverage`: **97 terms from measured evidence**, each with live market/share and a proposed lead ASIN (the family ASIN already taking the most impressions). Draft until enabled; seeding is idempotent by (set, term) so re-seeds never undo operator edits; an unmeasured week seeds nothing.

**The engine (`ads-coverage-engine.service.ts`, cron `ads-coverage-engine` daily 07:10):** a bid ladder, not a structure builder — presence was measured to be the status quo; share is the gap, and share is a bid problem. Reads ENABLED sets only. Per ACTIVE term it moves ONE bid — the championed target's, by the engine ordering — with the guard order as the policy: **family ACOS cap outranks coverage · waste guard (≥€20/30d, no sales) outranks the share gap · daily family cap blocks ups, never decays · no setpoint or unmeasured week → hold, stated.** Steps ±12/−6%, floor 5¢, and **never unbounded**: a term with no ceiling gets the 120¢ default (the ACR.1.4 rule). OBSERVE default (`NEXUS_COVERAGE_ENGINE_MODE=off|observe|auto`): would-dos log to AdvertisingActionLog; writes require mode=auto AND an enabled set, and go through `updateAdTargetWithSync` tagged `coverage-engine-<date>`. On the Levers board and Foresight like every engine. 11 ladder tests.

**First preview against the GALE draft (read-only):** 28 of 97 terms have championed targets (the rest are organic-only — the engine does not invent keywords); 4 would step DOWN under the waste guard (€41/€33/€23/€21 of 30d spend, no sales at target grain); 24 hold with "no target share set" — **the controller refuses to move without a setpoint. The operator's two-minute pass (retire noise terms, set target shares, enable) is what arms it.**

**Control group + on-demand preview (`f31678a72`), verified live on prod:** `KeywordCoverageTerm.isControl` (migration `20260805g`) holds terms OUT of the engine in every mode — without held-out terms a week of share movement proves nothing, the market moves too. The engine counts them (`controlsSkipped`) rather than silently thinning its input. `POST /coverage-sets/:setId/preview` runs one read-only engine pass regardless of mode; the cockpit's **Preview engine decisions** button renders the non-hold moves with bid, reason and campaign, "preview never applies" on its face. Both verified on the deployed cockpit: preview returned the same 28/0/4/24 as the local run, and the per-term engine⇄control toggle round-trips.

**The last consolidation target — the clamp, not a failure:** one target ("giacca moto" EXACT in `IT_Exact_Gale_SV=2k+_Key=1`) would not floor: three writes all APPLIED and delivered, yet the bid read 45→34→26→20. Cause: that campaign carries a `dynamicBidding.maxBidChangePct = 25` guardrail, and `updateAdTargetWithSync` clamps every non-forced bid write to it — the other 51 floored in one write because their campaigns set no such guardrail. The write path behaved exactly as designed; the apply script simply asked politely for something the guardrail meters out 25% at a time. `scripts/_acr3-floor-last-one.mts` finishes it with `force: true` — the documented bypass *for deliberate bid suppression* — under the same change-set. The write is classifier-blocked for the assistant; the operator runs it (command below). Note the clamped steps carry `AdMutation.changeSetId = null` — the change-set lands on `AdvertisingActionLog.executionId` (80 rows tagged), which is where revert reads from.

**ACR.3.1b — negative-exact lead enforcement: measured RE-SCOPE, not a build (2026-08-06).** The plan's 3.1 second half ("negative-exact enforcement" so non-lead siblings stay off a lead's term) was written before the one-tile correction, and the structure probe (`_acr31-structure-probe.mts`, read-only) settles it twice over. **Structurally impossible as planned:** all 21 enabled GALE campaigns carry exactly ONE ad group advertising ALL ~18 family children (the two merged autos carry 38) — negatives live per ad-group, so a negative-exact on any of them silences the term for the lead too; there is no per-ASIN ad group anywhere to steer with. **And strategically moot within one family:** Amazon collapses a variation family to one tile and picks the featured child itself, so per-child steering inside GALE cannot change what the SERP shows. Resolution: the coverage set's `leadAsin` stays a *measurement lens* (which child carries the term's impressions), not an enforcement target; per-lead ad-group isolation remains available as a deliberate future structure build (operator-gated, and it re-introduces exactly the data fragmentation Part 3 warns about) if the featured-child choice ever measurably underperforms. The real second-tile lever is unchanged: AIREON. With this re-scope and 3.3's arming deferred to the rank-engine lane, **Stage 3's remaining gap is purely 3.4 — running the armed pilot ≥2 weeks vs control — which starts at the operator's set pass.**

### ACR.1.2b / 1.3b / 1.6 — the four deferred surfaces SHIPPED 2026-08-05 (`db91ba7d0`)

The Levers row-expand drawer, per-dimension authority pins, the editable Guardrails grid, and the Ad Manager Automation column. Verified live on prod, all four.

**The pins are the substance, so they are enforced where they cannot be forgotten.** `Campaign` gained `pinPlacement`/`pinBids`/`pinBudget` + `pinnedBy`/`pinnedAt`/`pinNote` (migration `20260805g_acr12b_authority_pins`, default false so no existing row changes). Checked in `ads-write-gate` on the **same read** as the A1 bounds and **before** them — a pin is the broader refusal, and an operator told "bid exceeds the max" would raise the max and watch nothing happen.

**Two properties pinned by tests, because both are exactly how this ships decorative:**

- **The gate has always surfaced ONE representative field.** The worker picks the bid field for the A1 bounds, so a payload carrying a bid *and* a budget change arrives as `field: 'bid'`. A pin checked against that alone holds on every single-field payload a test naturally writes and **silently passes the combined one**. The worker now passes `fields: payload.fieldChanges.map(c => c.field)`; the resolver takes the whole list.
- **`updatePlacementBidding` pushes inline, not through the queue**, so it has no `fieldChanges` at all and nothing to derive a dimension from. It names its dimension explicitly. Without that the placement pin would have been the one pin that never bound anything — on the rank engine's primary actuator, which runs to +900%.

**Suppression is exempt from the BIDS pin only**, following ADX G1 and ACR.0.7 exactly: suppression is how the retail guard, budget stop-over-spend and Min-bid windows stop delivery under the no-pause rule, so a pin that blocked it would mean "I will manage bids myself" silently also meant "stop protecting me from overspend", and would freeze bids HIGH at the moment we most want them low. **`pinBudget` gets no such exemption** — pacing writes `dailyBudget`, which is an optimisation, not a safety action. **A pin also binds the operator's own writes**, deliberately: `actor` is free text and a third of the advertising audit log carried a NULL actor as recently as 2026-08-04, so a pin that trusted it would be honoured exactly as often as that string happened to be right.

**Proved on prod, on a real row** (`scripts/_acr12-gate-proof.mts`, forcing `NEXUS_AMAZON_ADS_MODE=live` — in sandbox the gate short-circuits on its first line, so a sandbox run passes without evaluating a single check). Pinning bids on `DE_Auto_Close`: bid write **DENIED [authority_pin]** · suppression to 2¢ **ALLOWED** · budget **ALLOWED** · placement **ALLOWED** · status **ALLOWED** · multi-field bid+budget **DENIED**. Both test writes reverted; the account is back to 0 pinned · 0 with a min bid.

**Run now reaches all ten engines.** Six had no manual trigger of any kind, and they were the ones an operator most wants to force — rank-defend, harvest, the bid optimiser. Registered against their `*Once` functions, **not** the `*Cron` wrappers: every `run*Cron` opens its own `recordCronRun` and so does the trigger route, so wrapping the cron form writes **two CronRun rows per manual run** — one labelled `manual` saying "manual trigger", one carrying the real numbers labelled `cron`. The drawer reads exactly that table. (The five pre-existing ads entries still double-write; left alone rather than changed in passing.)

**The engine→evidence actor map is measured, not read out of the code** (`scripts/_acr12-engine-evidence.mts`): prod carries `automation:rank-defend-*` (17,183 action-log · 19,338 bid-history rows), `budget-manager-cron` (105), `auto-harvest` (10, last 07-27), `auto-bid` (0), `tos-optimizer` (0). **So an engine with no rows is the normal case here**, and the drawer distinguishes three reasons — writes no per-entity rows by design · wrote nothing in the window · has never run — instead of one blank list that reads like a failure. Live: Top-of-Search defense reads *"This engine has never run. It is off, so that is expected."* and *"Its cron has never been armed, so it has never written anything."*

**Guardrails.** 0 of 216 campaigns have a minimum bid — a count that was true and unusable, naming work and giving nowhere to do it. Now a per-campaign grid with inline min/max bid edit through the **existing** `PATCH /campaigns/:id/guardrails` (which validates the *pair*, so a one-sided edit cannot leave a campaign every bid is simultaneously below the floor and above the ceiling of), pin toggles, and the allowlist toggle.

**Ad Manager.** An Automation column reading the **same endpoint** as the Guardrails grid, so the two cannot drift. Bound-rule counts **exclude account-wide rules on purpose**: all 22 enabled advertising rules are account-wide today, so folding them in would print "22" on all 216 rows and say nothing about any of them; the count is in the tooltip instead.

**Own CSS throughout.** The console's other drawers use `h10-hist-*` from `rules-automation.css`, which reaches the Control Room only because a parent layout happens to import it — the borrowed-classes coupling that shipped Coverage unstyled. Light only, no `.dark` rules. *Not* the shared DataGrid, matching the four tabs already on this page: the DS stylesheets carry `.dark` rules and `.h10-shell` pins this console light.

*One copy defect the live proof caught that no type could:* a single shared dimension label produced **"this campaign's bids is held by hand"** in the deny reason. Split into noun+verb. A refusal is the one sentence that has to read cleanly, because it is the one an operator stops to argue with. 45 gate tests.

**Still open from this slice:** `PATCH /advertising/campaigns/:id` never accepted `minBidCents`/`maxBidCents` and still does not — `/guardrails` is the route that owns bid bounds and already validates them, so the grid uses that rather than giving one setting two doors. `.h10-pill.bad` is referenced by the delivery column but has never been defined in `ads.css`, so those pills render uncoloured — pre-existing, not touched. The doc's numeric From/To column filters are not built; the grid has search · marketplace · managed-only · Reset.

### ACR.1.2c — three things pressing the button proved wrong, and the bulk bar

**All three were found by USING the feature on prod, not by reading it.** Each had passed a typecheck, a test suite, and a screenshot.

- **The manual run's summary was thrown away.** The six engines were registered against their `*Once` functions *specifically* so a hand-run would record the real numbers in one row. Measured: a hand-run of `ads-structural-reconcile` landed `SUCCESS · "manual trigger"` beside scheduled rows carrying `campaigns=215 entities=7790 verified=6849 mismatch=731 …`. The generic trigger route discards the handler's result and writes that literal string — so **every** manually-triggered job in the platform has recorded a row saying only what the `triggeredBy` column already says. An operator presses the button precisely to find out what happened and got the one row that could not tell them. Fixed in `sync-logs.routes.ts`; the before/after now sit adjacent in the same table: `19:30 SUCCESS manual "manual trigger"` · `19:43 SUCCESS manual "campaigns=215 entities=7790 verified=7010 mismatch=570 …"`.
- **The engine→cron map was a SECOND list, and it broke within hours.** Another workstream added `coverage-engine` to the Levers board; the row rendered with an "Open →" like every other and the drawer **404'd**, because the cron name also lived in a map in `ads-control-room-detail.service.ts`. That is this programme's own recurring defect, hit on code written the same day — and *"the row exists but its detail does not"* is its worst shape, because the board looks complete. The detail service now resolves the engine from `getEngineLevers()`, the thing that defines it. Verified live: `coverage-engine` → 200 with cron `ads-coverage-engine`, unknown keys → 404. Evidence sources are still declared per engine, so an unmapped one now **says** it is unmapped rather than rendering "nothing recorded", which would be a claim.
- **The delivery canary reported "allowed" on a pinned campaign.** `/campaigns/:id/pending-writes` always described itself as a "representative small bid write" but passed no `field`, so the gate skipped every field-scoped check — including the pins. Now passes `field: 'bid'` with the value **clamped into the campaign's own bounds**: a flat 50¢ would report `entity_bounds` on any campaign with a higher minimum, which the Ad Manager paints as a red "Gated" pill on a campaign automation can write perfectly well at 80¢. Reporting a bound as a permission failure is the same category error as reporting unknown as zero. Proved live, set→check→clear: `allowed` → `authority_pin` → `allowed`.

**The bulk bar (ACR.1.3c).** 0 of 216 campaigns have a minimum bid; fixing that one campaign at a time across the 82 managed ones is not a fix, it is a list. Selection + bulk set of min/max bid, each authority pin (set *and* clear), and the allowlist — all through the same per-campaign endpoints the inline edits use, no bulk route invented. **Sequential and per-campaign on purpose**, because `validateGuardrails` judges the resulting *pair* per campaign: "set max to 50" legitimately succeeds on most of a selection and must be refused where the minimum is already 80. A bulk endpoint would have to choose between failing the whole batch and hiding the partial result; this reports exactly what happened and **names the first refusal and its reason**, because "2 refused" sends an operator hunting. Only fields actually typed are sent — an untouched box sent as `null` would clear the other bound on every selected campaign. Verified live on three campaigns: *"bids pinned: 3 campaigns saved"* → 3 pinned → *"bids unpinned: 3 campaigns saved"* → 0 pinned.

**Account left exactly as found:** 216 campaigns · 82 managed · 0 with a min bid · 82 with a max · **0 pinned, 0 orphaned `pinnedBy`**.

### ACR.1.2d / 1.6b — a pill that never had a colour, and manual runs that logged twice

**The delivery column's most important state had no styling at all.** `.h10-pill.bad` has been referenced there since AX2.1 and **has never existed in `ads.css`**. Measured on prod by reading computed style, not by looking: every pill using it rendered `background: transparent` with default body-colour text — 18 "Gated" pills on the first page alone, beside "Live" as a proper blue chip. The state an operator most needs to notice was the one that did not look like a state.

Defining `bad` red would have been the obvious fix and the wrong one, because the class covered **a genuine failure and two neutral facts**: `failed` (a write to Amazon failed — a defect), `gated` (default-deny, **134 of 216 campaigns**, the containment boundary working exactly as designed) and `market_blocked` (structural). Painting 134 deliberately-unmanaged campaigns red manufactures an emergency out of a working guardrail — the same category error as rendering *unknown* as €0. The neutral pair now uses `muted`; `bad` means what its name says. Verified live: `Gated` → `h10-pill muted`, `rgb(238,241,245)` on `rgb(107,116,128)`; Live and Pending untouched.

**Manual triggers are now uniform across all engines.** The five pre-existing ads registry entries were registered against their `*Cron` wrappers, each of which opens its own `recordCronRun` — so a hand-run wrote **two** rows: one labelled `manual` carrying nothing, and a nested one labelled `cron` carrying the real numbers. Two records of one event that disagree about what caused it; invisible only because nothing rendered that table until the Levers drawer. Each job now exports the function that does the work *and* returns its summary, and its `*Cron` wrapper calls that — so the **scheduled path is byte-identical** and only the manual path stops duplicating. `ads-tos-defense` reads its env *inside* that function deliberately: a hand-run must be the same run, not one configured elsewhere.

*Proved on prod with both builds' output adjacent in one table:*

```
20:30:51.415  SUCCESS  manual  manual trigger          ← old build, row 1 of 2
20:30:51.506  SUCCESS  cron    evaluated=0 changed=0   ← old build, row 2 of 2
20:35:12.619  SUCCESS  manual  evaluated=0 changed=0   ← new build, one row
```

*Measurement note worth keeping:* the first post-fix trigger still logged twice, and the fix was **not** wrong — Railway was coalescing this session's rapid commits and the live build predated the change. `list-deployments` plus `git merge-base --is-ancestor` settled it in one step. On a shared branch, "I pushed it" and "it is running" are different facts, and a 202 from an endpoint that already existed proves neither.

**Guardrails grid, two additions.** Bulk **clear** for bounds as an explicit action — an empty box must keep meaning "leave alone", or "set a max on these 40" silently becomes "and wipe every min" for anyone who did not fill both fields (pins already worked this way). And a **gap filter** — no min / no max / no bounds at all / pinned / suppressed, each carrying its own live count, because the grid exists precisely because 0 of 216 campaigns have a minimum bid and finding those rows meant scanning for blank boxes. Selection follows what is visible, so a row filtered out of view cannot stay silently selected and then receive a bulk write. Verified live: `No min bid (82)` · `No max bid (0)` · `No bounds at all (0)` — self-consistent with the account cards above the grid.

### ACR.7 / 7b — drag-to-scope SHIPPED 2026-08-05: the Automation Dock, and a binding that means it

**Operator direction:** an always-on panel of every automation, draggable onto portfolios and campaigns; no emojis in rule names — colour carries the grouping.

**The bug the feature forced into the open: rule scoping was partially decorative.** All three evaluators pre-filtered rules by `scopeMarketplace` per context — but only as a skip-check; the evaluation call re-queried and ran EVERY enabled rule for the trigger. A DE-scoped rule fired on IT contexts whenever any rule passed the check. Fixed by passing the filtered survivors into `evaluateAllRulesForTrigger` via a new `ruleIds` parameter (all three domains), with the full ladder enforced by a pure predicate: marketplace → portfolio (external id) → campaign (local id), and a campaign/portfolio-scoped rule **never fires on contexts with no campaign identity**. 10 tests.

**ACR.7b closed the second half.** Firing scope alone would still let a bound harvest rule SWEEP marketplace-wide from one firing. `resolveRuleSweepScope(ruleId)` now bounds both sweep actions — `harvest_and_negate` through the same `adGroupExternalIds` parameter the wizard-sources path already used (binding ∩ sources when both exist: a binding narrows, never widens), `sync_negatives_across_campaigns` by campaign set. **Fail-closed:** a binding resolving to zero campaigns sweeps nothing. Proven on prod, bind→measure→unbind: unscoped 16 negatives / 14 graduations → bound to `Xavia GALE IT` **4 / 1, zero candidates outside the binding**.

**The dock:** one component on the Control Room (in the formerly empty right side), Portfolios and the Family Cockpit. Category swatch (server-fixed hex: blue bids · amber budget · green harvest · red negation · purple placement · teal protection · slate alerts), plain-text names (24 emoji names renamed on prod, seed rename-map extended so a reseed cannot resurrect them), compact Off/Obs/Prop/Auto dial, week counts, and — when bound — a visible scope chip with one-click unbind. Drops: portfolio rows (Portfolios), cockpit header (portfolio-wide), campaign rows (campaign-only) → `PATCH /autonomy/rules/:id/scope`, which validates the target and clears the other scope. Layout dead-space fix from operator screenshot: with-dock pages take the full viewport.

### ACR.6 — the Family Cockpit SHIPPED 2026-08-05 (`/marketing/ads/portfolios/[id]`)

**The surface the engagement was opened for**, verified live on prod against `Xavia GALE IT`. One aggregate read (`GET /portfolios/:id/cockpit`), four tabs, and **every control is an endpoint that already existed** — the cockpit adds no write path:

- **Overview** — 11 member campaigns with controls inline: the live-writes switch (the family's hard automation boundary, at the write gate), pause/enable, editable daily budget, bounds, schedules, delivery; family bulk writable/read-only; 18 products.
- **Coverage** — the family lens on corrected SQP: GALE holds **1.88% of `giacca moto estiva uomo`** with 10 ASINs on page and 3 family keywords; `accessori moto` 183k impressions, 2 ASINs organically present, **no family keyword** — the family's next keyword, visible in the family's own cockpit.
- **Keywords** — contested terms championed by the engine-aligned rule. **Finding: `Xavia GALE IT` has NO internal contest.** The 13 contested pairs from ACR.2.4 live BETWEEN portfolios — the pre-portfolio GALE campaigns (`GALE EXACT IT`, `GALE BROAD IT`, `IT_Gale`…) vs this set — so consolidation is a cross-portfolio cleanup, not an intra-family one.
- **Automation** — the honest scoping notes (harvest/negate rules are marketplace-scoped today; the page says so instead of drawing a dial that governs nothing), plus this family's **38 pending proposals priced: €199.05 pure-waste recoverable**, each row marked ♦ where the spend produced nothing.

Vitals live: 11/11 writable · €24.38/day · 30d €741.97 → €912.33 (ACOS 81%) · page-one share 0.77%.

### 🔴 ACR.2.7 — CORRECTION: the scoreboard understated every multi-ASIN share by the number of our ASINs on the term

**SQP market columns are QUERY-level totals duplicated identically on every ASIN row.** Verified 2026-08-05: `giacca moto estiva uomo` week 2026-07-19 holds 10 rows, each reading `impressionsTotal = 110,506`, `distinct_totals = 1`. My scoreboard SUMMED them — multiplying the market by our ASIN count and **understating share exactly where coverage is strongest**. Brand columns are per-ASIN counts and were correctly summed; the ground-truth cross-checks (686 for B0BMSH19GY; `accessori moto` 183k in Part 2) all confirm.

**Corrected numbers (IT, week 2026-07-19) — these supersede ACR.2.1's:**

| | published | corrected |
|---|---|---|
| Pooled share of page one | 0.29% | **0.76%** |
| `giacca moto estiva uomo` | 0.19% | **1.88%** (2,078 of 110,506) |
| `giacca moto uomo` | 0.36% | **2.87%** |
| `giacca moto` | 0.31% | **2.19%** |
| `accessori moto` (unbid) | 366,958 mkt | **183,479** |
| bid vs unbid, pooled | 0.30% vs 0.265% | **1.57% vs 0.41%** |

The bid-vs-unbid contrast is now stark instead of ambiguous: **1.88% vs 0.067% at 100k+, 1.76% vs 0.026% at 25k–100k** — bidding is associated with ~30–70× the share on head terms, and the earlier Simpson's-paradox hedge mostly dissolves. The five recommended gap keywords keep their relevance verdicts and CVRs (ratios cancelled the duplication) but their true weekly volumes are ½–¼ of what was quoted; `accessori moto uomo` (15.3k) and `paraschiena moto livello 2` (15.6k) drop below the 25k gate. Fix: `MAX` for market columns, `SUM` for brand columns, pooled over per-term de-duplicated totals — service + probes.

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

### ACR.2.3 — the Conflicts tab: the contest is BETWEEN portfolios, and no existing surface could show it

**`/marketing/ads/analytics` → Conflicts, account-wide.** `detectKeywordConflicts` needs a campaign to stand on and the Family Cockpit stands inside one portfolio; the contest that actually exists is between them, so neither could render it. Measured live on IT:

| | |
|---|---|
| contested (term × match) pairs | **300** |
| …spanning two or more portfolios | **127** |
| campaigns involved | 97, across 6 portfolios **+ unfiled** |
| 30d spend on contested terms | €885.49 |
| …that went to a campaign the champion rule does NOT pick | **€299.70** |

That €299.70 is deliberately *not* labelled recoverable: Part 3.2 established we never bid against ourselves — the same keyword enters the auction once. It sizes the consolidation question, it is not a bill.

**`pickChampion` is imported, not reimplemented.** ACR.4 aligned it to the engine's `[acos ?? +∞, −spend]` so the manual and automatic paths cannot name different winners; a second copy of that ladder here would have re-opened the 83-keyword divergence of ACR.2.5. What differs is only scope and source: this reads the **AD_TARGET grain over 30 days** (29 days present) rather than the lifetime counters denormalised onto `AdTarget`, because a lifetime counter and a 30-day window disagree by construction on any campaign older than a month.

**Two things the measured data forced into the design.**

1. **Most contenders are dormant, and an undifferentiated list hides the collision.** `giacca moto uomo` EXACT is claimed by **21 campaigns; 5 took an impression in 30 days**. Contenders with no traffic collapse behind a disclosure and the header reads "5 of 21 active".
2. **144 of 300 contests have no performance signal at all**, so the engine's ordering ties and `pickChampion` falls through to *highest bid*. Those are tagged **"no evidence"** and say plainly: *leave this one alone* — retiring a loser there is a coin toss, which is precisely the failure ACR.2.5 warned about.

The head contest is worth reading on its own: on `giacca moto uomo` EXACT, `GALE EXACT IT` (unfiled, 300% ToS bias) spent **€110.56 at 128% ACOS** while the champion `IT-AIREON-SP-Category-Exact` spent €3.98 at 4%.

*Two defects caught while building it, both silent-by-shape:* joining `AdProductAd` in the metrics query to collect ASINs fanned each (target × day) row out once per product ad, **inflating every SUM by the ad count** with the result shape unchanged; and keying contests as `` `${term} ${match}` `` and splitting the key back on a space would have **shredded every multi-word term** — which is every term that matters here. ASINs now load in their own query; term and match are read off the rows, never parsed out of the key.

### ACR.2.2b — position: the score is real, Amazon's own ToS-IS is still UNMEASURED

**The scoreboard now answers *where* on page one, not just *how much*.** Three columns added to `ads-coverage.service.ts` (additive — the Family Cockpit and Today board consume it unchanged): position-weighted score, top mix, ToS-IS.

**🔴 `topOfSearchIS` is NULL on all 3,552 placement rows, in every market, for all time.** The metric the plan has assumed since §4.3 has never once landed. The cause is settled, not guessed: `tos-is-ingest` has run **twelve consecutive nights at ~622 seconds** — the old 10-minute poll ceiling — each one logging **SUCCESS with `errors=9`**, a 100% failure wearing a green badge. ACR.0.2's fix (`pollMinutes: 45`, plus throwing when every profile fails) is committed and pushed in `498e2b5c2`, but **today's 02:30 run predates it**; the first run under the fix is the next 02:30. It cannot be exercised from here — the local ads client is sandbox-mode (`[ADS-SANDBOX] fetchReport` returns four synthetic rows), so this one is Railway-only, like the eligibility API.

So the column ships reading **"—" with the reason stated on the page**, never 0%. A zero there would assert we never reach the top of the page, which is a conclusion an operator would act on.

**The position weight is measured from our own account, not borrowed.** Rather than an industry CTR-decay constant, the weight is the ratio of our own rest-of-search CTR to our own top-of-search CTR, IT/90d:

| placement | impressions | CTR |
|---|---|---|
| Top of Search | 37,712 | **3.784%** |
| Rest of search ("Other on-Amazon") | 377,052 | **0.482%** |
| Detail page | 1,225,544 | 0.067% *(excluded — not a SERP)* |

→ **a rest-of-search impression is worth 0.127 of a top one to us.** `pwScore = share × (topMix + (1 − topMix) × 0.127)`, returned with its inputs so the number is auditable.

**The result, and it is not flattering:** pooled share **0.76% → 0.41% position-weighted**, because our top mix on the terms we hold runs only **10–23%**. We hold what little we hold near the bottom of the page. Position also genuinely re-ranks the board — `abbigliamento moto` and `giubbotto moto uomo 4 stagioni` each climb five places on it while `giubbotto moto` drops.

**The honest limit, stated on the page:** placement data is per CAMPAIGN, so a term inherits the placement mix of the campaigns holding it — a campaign with fifty keywords has one mix applied to all fifty. Directional, not per-keyword truth; every input is nonetheless a measured impression from our own account. Terms no campaign of ours holds get `positionBasis: 'no-holding-campaign'` and a null score rather than an invented one — **109 of 142 rows**, which is itself the finding that we bid almost nothing on this board.

### 🔴 ACR.2.4 — the variation experiment: ACR.2.1's headline was measuring ONE listing, and AIREON is not in the data at all

*(Numbering note: this is Stage 2's **2.4**, the variation experiment, as defined in the phase list below. The earlier section also titled ACR.2.4 — the `isNegative` two-vocabularies defect — is separately numbered and unrelated.)*

**The question: do two child ASINs of one parent ever co-occupy a SERP — does AIREON's unified parent cost coverage?** Two facts settle what can and cannot be concluded today.

**1. Every measured ASIN in SQP is a child of ONE Amazon parent.** All 10 ASINs carrying impressions share `parentAsin = B0F7J163XJ` — they are sizes and colours of the single GALE jacket listing (`GALE-JACKET-BLACK-MEN-XL`, `…-YELLOW-MEN-M`, …). Checked against Amazon's `parentAsin`, not our internal `Product.parentId`, because our hierarchy need not match Amazon's variation family.

**This overturns ACR.2.1's headline.** That entry read "on `giacca moto estiva uomo`, **ten** of our ASINs already appear on the SERP" and concluded *"multi-product SERP presence is not the missing capability — it is the status quo"*. But Part 3.1 of this very plan states the rule: **"True variations of one parent collapse to one tile."** By our own adopted model of Amazon, those ten ASINs are **one tile**, credited to whichever child was featured across a week of searches — not ten tiles. Ten rows in a weekly per-ASIN report is not ten slots on a page.

*So the operator's original ask — several products on the same page — is **not** already satisfied. It is unmet, and Stage 3's reframing ("the engine's job is not to get more of our ASINs onto the page") rests on a miscount and should be re-opened.*

**2. AIREON has ZERO rows in `SearchQueryPerformance`** — 0 of 25 ASINs, in any week. The question cannot be answered about AIREON at all right now; the answer is not "no", it is "not in the dataset".

**Why the data is shaped this way, and it is a self-perpetuating scope.** `_acr2-sqp-backfill.mts` picks its ASINs from *what is already stored*, most-covered first, top 10 (line 43). **An ASIN with no rows can therefore never be selected** — the backfill can only ever deepen the ASINs it already has. That is why six weeks of repair produced ten ASINs of one family and left 12 more, plus all of AIREON, untouched.

**The experiment itself is built and correct; it is starved, not wrong.** `_acr24-variation.mts` discriminates the two hypotheses that a raw count cannot: under a rotating single slot a family's share is flat in *k* and per-child share falls as 1/*k*; under independent slots per-child share is flat and family share rises with *k*. Every comparison is **within-term**, so market size and term breadth are held fixed by construction. Run today it returns **zero discriminating terms — because a within-term control needs a second family on the same term, and only one family is measured.** A single-family fallback (share vs *k*, banded by market size) is reported in the script but does not separate the hypotheses: *k* is endogenous — the same relevance that puts more children on a term also raises share — and both hypotheses survive it.

**🔴 RESOLVED 2026-08-05 — AIREON's zero is REAL, and the experiment was structurally impossible
on this week.** `IT AIREON`'s eleven campaigns **started 2026-07-28**. The measured week is
**2026-07-19 → 07-25**, which ended three days earlier: AIREON spent **€0.00 and took 0
impressions** in it. Compare `Xavia GALE IT` (started 07-01, €168.93, 79,986 impressions) and
`IT_Gale` (03-03, €41.90, 73,439). So the four AIREON reports that returned `parser yielded 0
rows` were correct — there was nothing to return. No parser defect, no scope artefact.

*And the plan built on it could never have worked:* GALE's measured weeks run 06-14 → 07-19,
AIREON went live 07-28, so **there is no week in which both families are measured**. Widening
AIREON on the 07-19 week was doomed before the first report was requested — which is why the
"blocked on Railway credentials" framing was wrong twice over.

**Corrected plan:** backfill **both** families on a week from **2026-07-26 onward** (the first
that overlaps AIREON's launch), not AIREON alone on the old one. That means re-requesting GALE
for the new week too — the two-family control needs both on the *same* SERP, and GALE's existing
six weeks all predate AIREON. Note 2026-07-26 covers only four of AIREON's live days; the first
clean full week is 2026-08-02, publishable once Amazon releases it. *(`_acr24-aireon-age.mts`.)*

**When it can run — measured, not guessed (2026-08-05).** Week 2026-07-26 is **not yet
published**: requested today it ends `FATAL — "A client error occurred. Please double check that
your parameters are valid"`, Amazon's answer for a week it has not released. The request wrote
nothing (`rows=0 upserted=0`). That confirms ACR.2.1's `lookback >= 2` rule **by measurement**,
where it had been inferred from a single failure and then encoded as a hard floor in
`_acr24-sqp-widen.mts` — which made the assumption untestable. The guard is now the script's
DEFAULT rather than a floor, so "is this week published yet" stays a question Amazon answers in
one request instead of a constant nobody can check.

**So the two-family control has a date, not a blocker: ~2026-08-09**, when 07-26 becomes
`lookback = 2` (five of AIREON's live days). The first clean full week, 2026-08-02, follows from
roughly 08-16. Whichever is chosen, **both** families must be requested.

**And how much signal that week can even contain — sized before spending the reports (2026-08-06,
daily-performance grain, no quota used):** AIREON in the 07-26 week did 49,687 impressions and
€41.95 — really live — but its placement split is 25,313 detail-page against **1,677 SERP
impressions for the whole family for the whole week** (1,250 rest-of-search + 427 top). Spread
over ~20 children and dozens of queries, per-(query × ASIN) cells land in single digits, so
expect a mostly-empty SQP answer even on a correctly published week. The metric that will
actually move first is the placement mix — which is what an AIREON coverage set exists to
change — and SQP granularity becomes informative *after* that shift, not before. Calibrate
disappointment accordingly when the ~08-09 request runs.

**What unblocks it:** `_acr24-sqp-widen.mts` resolves ASINs from the **catalogue** by family instead of from stored rows, jackets first. With AIREON measured alongside GALE the within-term control exists and the experiment decides. **It can only run on Railway** — the local SP-API refresh token is revoked (`invalid grant parameter : refresh_token`), so 13 requested reports returned 13 failures and wrote nothing. Cost when run: ~6 minutes of Amazon report generation per ten ASINs, one report per ASIN, upserting in place on `(marketplace, period, startDate, searchQuery, asin)`.

### ACR.2.4c — the widen's execution record, its WRONG first reading, and what survives

**The run record:** all six CREMA-E-VINO children were requested for the 2026-07-19 week (`periodWindow` lookback 2); every report succeeded, every report empty (`rows=0 upserted=0 failedAsins=0`). Two spot-checks replaced the six NERO-NEO reports — stated rather than silently skipped: `B0H8QTNY62` also zero; the NERO-NEO XXL report itself FAILED once (`failedAsins=1`, transient).

**The first reading of those zeros was a third wrong framing — struck here.** This section originally concluded "AIREON is measured ABSENT: its per-(query × ASIN) cells sit below SQP's reporting floor", argued from 30-day ad-impression and placement figures. The RESOLVED block above is the correction: **the campaigns started 2026-07-28 — after the measured week ended — so AIREON had €0.00 and 0 impressions in the requested week, and the zeros carried no information about visibility at all.** Every "impr/30d" figure used to argue a-fortiori postdates the week it was arguing about. After "Railway-only credentials" and "backfill scope", this makes three successive wrong causes for one zero — and this one reached a pushed commit before the one-query timeline check (`_acr24-aireon-age.mts`) landed. The reports themselves were ~14 of Amazon's report quota spent confirming a fact one catalogue query already knew.

**What survives, because it never depended on the SQP week:**

1. **AIREON's *current* delivery shape is detail-page-heavy** — placement report, trailing 30 days (i.e. its live days since 07-28):

| placement | impressions | share |
|---|---|---|
| Detail Page | 66,362 | **88.7%** |
| Rest of search | 6,816 | 9.1% |
| Top of Search | 1,604 | 2.1% |

~8.4k SERP impressions versus GALE's ~415k over the same trailing window. This does NOT explain the SQP zeros (the timeline does), but it is the live fact that matters for what comes next: the auto + category campaigns are buying product-page visibility, and if that mix persists, AIREON will under-register in SQP even once its weeks are measurable.

2. **The AIREON search push stands as the route to "several products on one page"** — GALE holds one family tile; the second tile needs AIREON *in search* on the head giacca terms: a coverage set for the AIREON portfolio, exact targets, engine-held. Sequenced AFTER the corrected two-family backfill above (week ≥ 07-26; first clean full week 2026-08-02) so its baseline is measured, not asserted.

3. **The listing-identity gap is real — and now identified (2026-08-06, read-only catalog lookups):** all **16** `B0H8*` ASINs the AIREON campaigns advertise are **our own XAVIA AIREON listings** — brand `XAVIA RACING`, 8 × "Giacca Da Moto Da Uomo" jackets and 8 × "Pantaloni Moto Uomo" pants — that the Product catalogue simply does not have. Amazon's AIREON family is bigger than we track (25 catalogued + 16 not). The reconcile is therefore **running the existing Amazon import for AIREON**, not new tooling. Do it before seeding an AIREON coverage set, or the set's lead-ASIN proposals work from a 60% roster. *(The lookups cost four failed attempts to a lib trap now recorded: `callAPI` takes ONE argument and the API version must be `req_params.options.version` — a top-level `version` key is silently ignored and the oldest endpoint version is used. `detectProductTypeFromAsin` in `amazon.service.ts` carries this dormant bug today — its identifiers-based catalog calls hit 2020-12-01 and fail; owner: import tooling.)*

*Note for whoever runs it:* widening repairs the board's honesty but **will move the published baseline** — the pooled 0.76% is currently computed over ten ASINs of one family, and adding families raises our measured impressions against an unchanged market denominator.

### 🔴 ACR.2.4b — the coverage board measures 4% of the advertised catalogue, and says so now

Following ACR.2.4's finding that every measured ASIN is one variation family, the obvious next
question is how much of the account the board actually sees. Measured on prod 2026-08-05 (IT):

| | |
|---|---|
| ASINs in the live catalogue | 244 |
| ASINs advertised on Amazon IT | **250** |
| ASINs with any SQP row | 22 |
| ASINs SQP actually **measures** (`impressionsBrand > 0`) | **10** |

**So "Share of page one: 0.76%" is GALE's share, presented as the account's.** Eleven whole
families have **no SQP row whatsoever** — AIREON (25 ASINs), REGAL (25), VENTRA (25), MOSS (22),
MISANO (16), AIRMESH (13), the glove and slider lines. The market denominator is the whole query
market either way, so **every share on this board is a FLOOR** — understated by exactly whatever
the eleven unmeasured families hold, which is unknown.

That is the same defect class the programme keeps catching, one level up: not a zero that means
unmeasured, but a *ratio* whose numerator covers 4% of the catalogue while its denominator covers
all of it. ACR.2.1's "**we are absent** … 0.29%" and ACR.2.7's corrected 0.76% are both
one-family numbers. The direction of the remaining error is known — understatement — and its size
is not. **The board now states its own scope in a note** rather than implying an account-wide
fact from one product's data. *(The family-lens call from the cockpit passes `asins`, so the note
is suppressed there — it would be telling an operator that a deliberately scoped view is scoped.)*

**A second correction to ACR.2.1, from `updatedAt`.** That entry attributed the residual 1,413
zero rows to ASIN scope: *"the residual belong to ASINs outside the requested top-10"*. Since
`ingestSqp` upserts, any row a backfill touched carries a post-fix timestamp whether or not its
value changed — so the two cases separate cleanly, and they are not what was assumed:

| | rows | meaning |
|---|---|---|
| ASINs never re-read since the parser fix | **681** (11 ASINs) | genuinely **UNMEASURED** |
| zeros on ASINs that *were* re-read | **967** | **genuine zeros** — Amazon reported no impressions |

So the majority of the residual is **not** a scope problem and widening the ASIN set will not
repair it. Eight of the eleven never-re-read ASINs are more GALE children (`…-BLACK-MEN-M`,
`…-YELLOW-MEN-L`, `…-YELLOW-MEN-3XL`); the rest are X-Tuta. *`scripts/_acr24-widen-scope.mts`
prints the exact list, and `_acr24-board-scope.mts` the ratio above.*

**What this means for the widen:** repairing the 11 stale ASINs deepens GALE and still yields no
control group. The experiment needs a **complete second family**, which is a create-not-repair
operation — those ASINs have no rows to upsert onto. Priority stays AIREON, and the payoff is now
larger than the variation question alone: it is the first honest account-level coverage number.

### 🔴 ACR.0.2-bis — the ToS-IS diagnosis was WRONG, and the shipped fix cannot work

**The report was never slow. The client cannot find the download URL.**

Measured live against Amazon on 2026-08-05 (`scripts/_acr23-report-status.mts`, read-only), on a
report the ingest was polling at attempt 52:

```
status       = COMPLETED                                  ← terminal
url          = https://offline-report-storage-eu-west-1-prod.s3…   ← the download URL
location     = undefined                                  ← what the client tests for
createdAt    = 19:52:11
generatedAt  = 19:52:37                                   ← 26 SECONDS. fileSize 9,944 bytes.
```

The full key set Amazon returns is `configuration, createdAt, endDate, failureReason, fileSize,
generatedAt, name, reportId, startDate, status, updatedAt, url, urlExpiresAt`. **There is no
`location` key at all.** The poll loop's success branch was:

```ts
if (status.status === 'COMPLETED' && status.location) { …download… }
```

so it was never taken. Every finished report fell through to the `pending` branch and polled
until the ceiling, where the job recorded a timeout.

**This invalidates ACR.0.2's recorded cause and its fix.** That entry states the report "was
still PENDING at the 10-minute ceiling on every profile, every night" — an inference from the
symptom, not a measurement; the status was `COMPLETED` within half a minute. Raising
`pollMinutes` 10 → 45 therefore **cannot** work: it only makes each nightly failure take 45
minutes instead of 10. The `pollMinutes` parameter is harmless and can stay, but it fixed
nothing, and tonight's run under it would have failed exactly as the previous twelve did.

**This is the fourth two-vocabularies defect in this programme** — after `EXACT`/`_EXACT`, the
rule tabs filtering on a word no rule uses, and `expressionType` vs `isNegative`. One concept,
two spellings, and the code picked the one Amazon does not send.

**Fix (in `ads-api-client.ts`, working tree — see the note below):**
1. `const downloadUrl = status.url ?? status.location` — accept both, so a future Amazon change
   in either direction cannot re-break it.
2. A `COMPLETED` report carrying no usable URL now **throws**, naming the keys it did receive.
   Logging that state as "pending" is precisely how this hid for months: the failure mode and
   the healthy-but-slow mode were indistinguishable in the logs.

⚠️ **The code change is UNCOMMITTED**, in a file that also holds ~420 lines of another session's
SB/SD create paths, so it could not be committed without sweeping that work. If it is lost, the
one-line change above is the whole fix.

**🔴 A SECOND DEFECT SAT DIRECTLY BEHIND IT, and could not fire while the first was live.**
Fixing the key made the download branch reachable for the first time, and it failed instantly:

```
Unexpected token '\u001f', "\u001f\u008b\b\u0000…" is not valid JSON
```

`1f 8b` is the **gzip magic number**. Reports are requested as `format: GZIP_JSON` and S3 serves
those bytes **raw — no `Content-Encoding` header** — so `fetch` does not transparently inflate
them and `.json()` chokes. The code comment claimed "download + parse JSON/gzip"; it only ever
did JSON. That defect is exactly as old as the first one and had **never once executed**, because
nothing had ever reached the download. Fixed by sniffing the magic bytes rather than trusting the
requested format, so an uncompressed report type would still work.

*The general lesson, which is the reusable part: ACR.0.2 measured a **symptom** (the job times
out), inferred a **cause** (Amazon is slow), and shipped a fix for the inference. Neither real
defect was timing-related, and the second was undiscoverable until the first was gone — so no
amount of raising the ceiling could ever have surfaced it.*

**✅ PROVEN END-TO-END, live against the production profile 2026-08-05:**

```
[ADS-LIVE] report ready, downloading   fileSize=9933
[ADS-LIVE] report decoded              gzip=true bytes=9933 chars=118237
[tos-is-ingest] done   rowsFetched=1156  withIS=911  rowsUpdated=497  errors=0
```

**497 `AmazonAdsPlacementReport` rows now carry a real `topOfSearchIS`, up from ZERO in every
market for all time.** Sanity-checked: values span 0–100% with a mean of 27.08%, so the
percent-vs-fraction normalisation is right. Highest holders are `GALE | IT | PAT` at **62.8%**
over 21 days on 9,393 impressions, and `IT_Auto_Substitute` at 57.2%.

The Coverage board's ToS-IS column is live on that data — `tosIsMeasured: true`, and
`giacca moto estiva uomo` reads **13.36%**, `giacca moto uomo` **20.92%**. Note the two numbers
answer different questions and should not be compared directly: `share` is our impressions
against the whole query market; ToS-IS is our share of the top-of-search auctions we were
*eligible for*. A low share with a high ToS-IS means we win the slots we contest and contest
very few.

**✅ AND THE REAL NIGHTLY PATH, not a hand-rolled equivalent.** The proof above called
`ingestTopOfSearchIS()` directly (IT-only, 30 days). The cron calls `runTosIsIngestCron()` →
`recordCronRun()` → all nine profiles at `windowDays: 7`, and it is the **wrapper** that decides
SUCCESS vs FAILED — the exact classification that recorded nine-of-nine failures as green for
twelve nights. Run through that entry point on 2026-08-05:

```
status      SUCCESS
triggeredBy cron
summary     profiles=9 rowsFetched=540 withIS=407 rowsUpdated=256 errors=0
ToS-IS rows across all markets: 497 → 561
```

**`errors=0`, against `errors=9` on each of the previous twelve nights.** Nine reports
downloaded and decoded. Note the five profiles with no campaigns return zero rows *without*
erroring, so ACR.2.3's wasted-report finding concerns the gapfill job, not this one.

**Blast radius — bounded, and checked rather than assumed.** `fetchReport` has exactly two
callers: this job, and `ads-metrics-ingest` (campaigns/adGroups/keywords/productAds), which was
**retired in H.2e on 2026-05-18** (`cron-registry.ts:85`) and is not scheduled. Every other
report path goes through `sp-api-reports.service.ts`, which uses the SP-API SDK's
`getReportDocument` and handles decompression itself. So the defect repaired exactly one job and
there is no second silent victim.

*Both fixes are in `ads-api-client.ts` (`7f4463609`), committed together with another session's
SB/SD create paths because they could not be separated.*

*Operational note for anyone reproducing this:* `railway run --service "@nexus/api"` injects
production env into a local process and **does** reach Amazon (the "Railway-only" belief was
wrong — it was a credentials problem, not a network one). Three traps come with it: `REDIS_URL`
resolves only inside Railway (`env -u REDIS_URL`), the ads quota ledger then fails closed
(`NEXUS_AMAZON_ADS_QUOTA_MODE=off`, supervised runs only), and **secrets appear in the process
table** — never `pgrep -fl` those processes, and never `pkill -f "railway run"`, which kills
every concurrent one.

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

### Stage 4 — Autonomy completion ("no daily attention") — ✅ SHIPPED 2026-08-05

Commits: `6b7d57538` priced Suggestions · graduation readiness (its route landed inside
`87b573f63`, a sibling session's commit) · `6b182b937` digest + Activity rollup · `92aa37bd4`
and `b26feb87d` fixes found by looking · `2e59a9d22` tests · `b1a305d20` perf · `f8b72f296`
ACR.4.3. Verified on live prod (Vercel + Railway), screenshots taken on the real console.

- **4.1 ✅ Graduation runs on evidence — and the evidence does not exist yet, which is the finding.**
  Measured BEFORE building: 151 `AdsRuleSuggestion` rows — 150 pending, **one ever applied**
  (2026-06-23), none dismissed, none edited. Six rules sit at PROPOSE with an AUTO ceiling and
  not one has a single operator decision behind it. So the strict bar — proposals applied
  *unchanged* in ≥3 distinct weeks, no failures — correctly surfaces nothing, and the board says
  so rather than inventing a reason to say yes.
  `appliedResult.override` is what makes "without modification" measurable: the apply route
  already records an operator's edit, and an applied-**with**-an-edit proposal is agreement with
  the intent and disagreement with the number — and the number is what would run unattended.
  Graduation is never automatic: the only write path remains `PATCH /advertising/autonomy/rules/:id`,
  which re-checks the ceiling. The ceiling machinery is untouched and still caps 6 structural
  rules regardless of history.
  **Two tracks, labelled, because a board that can only say no gets closed.** Rules that have RUN
  clean are shown under their own verdict and never under the word *ready* — running is not
  agreeing. The verdict that earned its place is **UNSEEN**: *AIREON — Target ACoS bidding* has
  matched **564 times across 2 weeks with zero failures and has never queued a single proposal.*
  Ranked by weeks it read "2 of the 3 needed" — on track. It is not on track: no amount of
  further running can produce evidence from a rule that never puts a decision in front of you.
  So UNSEEN is judged qualitatively, before any week threshold.
  *Load-bearing detail:* 693,743 FAILED executions in the 56-day window, of which **693,704 are
  `DAILY_CAP_EXCEEDED`** (the self-ratcheting cap bug fixed 2026-08-04) and exactly **39 are
  real**. Any per-rule health read must exclude the cap rows — spelling out the null branch, or
  three-valued logic drops every clean row — else every rule reads as catastrophically broken.
- **4.2 ✅ Weekly digest — built, and the gate SURFACED rather than flipped.**
  The email rail was not merely gated off, it was **empty**: `ReportSchedule=0, SavedReport=0,
  ReportDelivery=0`, and **`NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON` is not set on Railway at all**,
  so `startAdsReportScheduleCron()` has always returned early and no scheduled ads email has ever
  dispatched. There was also nothing to un-gate *into* — that rail mails a saved-report
  spreadsheet, which is not "what acted, what's proposed, recoverable €, coverage trend".
  So the digest is its own builder on the same rail and the same two-gate discipline, with no
  third flag. **Confirmed on the prod panel: `NEXUS_ENABLE_OUTBOUND_EMAILS` is ON.** That makes
  the operator decision concrete and slightly counter-intuitive: setting the cron flag to `1`
  **mails for real, not as a dry run**, and `NEXUS_ADS_DIGEST_RECIPIENTS` must be set first or
  every run logs `SKIPPED — no recipients`. Two variables, in that order. Preview and "Send me a
  test" go through the identical path Monday will use.
  One builder, two consumers (panel + email) so the screen and the inbox cannot disagree.
  Idempotency comes from `CronRun`, not a new table — this digest hangs off no `SavedReport`, so
  `ReportDelivery` cannot hold it.
- **4.3 ✅ Undo per action class, and a breaker that admits its own gap.**
  **"7-day undo" was the wrong instruction for bids, and this codebase already knew.** Undo was
  24h/bids-only, and that 24h matches `ADS_STALE_INTENT_MS` for a stated reason: the rank engine
  re-evaluates *hourly*, so a day-old bid is already superseded. Flat 7 days would make 11,140
  bid rows undoable (vs 2,790), and restoring one is not an undo — it is a new, uninformed
  decision moving real money. Now per class via `rollbackWindowMsFor()`: **bids 24h · budgets and
  placements 7d · unknown action types 24h** (default-deny). Deliberately NOT applied to
  `rollbackByChangeSetId` — a bulksheet import mixes every type, and a half-reversed set is worse
  than a refusal.
  **The feed was hiding a capability, not lacking one:** op rows carried `undoable: false`
  hard-coded while `POST /advertising/changes/:actionLogId/undo` sat there working, and the
  readable rows (`CampaignBidHistory`) have no action-log id, so the handle had to be joined —
  the same nearest-in-time pairing that already attached delivery to placement rows, generalised
  to budgets. **200 automation rows: 0 → 200 undoable, and the flag agrees with the server's own
  `previewRollbackOfAction` 12/12.** Two-step confirm naming the value it restores.
  **The hourly SPEND breaker cannot fire:** `maxHourlySpendCentsEur` is unset, so the guard
  enforces its €500/hour code default against a **peak hour of €20.91** across 67 measured hours
  — ~24× above anything the account does. Surfaced in the digest and the panel; the number is the
  operator's to set (`maxActionsPerHour` IS set, at 500).
  **And a trip leaves almost no record:** `haltAutomation` writes the singleton and
  `resumeAutomation` **nulls `haltedAt`/`haltReason`**, so resuming erases it. The only durable
  trace is the `Notification` row (`ads-automation-halt`), fanned out one per operator profile —
  dedupe by timestamp+body. Prod holds one real trip: 2026-08-04 07:20, 264 actions vs a 250 limit.
- *Exit:* ✅ met, with one qualification recorded honestly — "every action reversible for 7 days"
  is deliberately **not** true of bids, and should not be made true of them. Routine work runs
  unattended; the digest is the single touchpoint once the operator sets its two variables.
- **What Stage 4 did NOT do, on purpose:** flip any env flag, set any live safety threshold, or
  graduate any rule. All three are operator decisions and all three are now surfaced with their
  real numbers next to them.
- **Open, and blocking nothing:** the graduation board stays empty until the priced queue gets
  worked — which is the loop closing as designed, not a defect. €495.75 of the 150 pending
  proposals is spend that produced no sales at all.

### Stage 5 — Ad-type stacking (the biggest missing lever)
- **5.1** SB create/optimize path (existing product imagery; the 4 paused SB campaigns as templates), **5.2** SD, **5.3** SBV if video assets exist. Separate budget pools so they stack without touching SP bids. Coverage scoreboard gains SB/SD presence columns.
- *Exit:* one query can hold SB banner + multiple SP slots + SD simultaneously.

### ACR.5 — the SB/SD audit, and the create paths that never existed (2026-08-05)

**Operator gate answered: GO** — build the create paths. SBV deferred (video creative planned, not yet available); a documented seam is left in the builder. Report polling gated on delivery.

#### The audit — the premise was wrong, in our favour (`scripts/_acr5-sbsd-state.mts`, `_acr5-sbsd-amazon.mts`)

The plan said the SB/SD campaigns were "disabled/archived", and memory recorded 15 SD `ARCHIVED` locally on 2026-07-30 against at least 3 `PAUSED` on Amazon. **Both halves are now stale: all 19 are `PAUSED` locally and `PAUSED` on Amazon — 19/19 agree, budgets match to the cent, zero not-returned.** The mis-archive healed itself once `reconcileCampaignDeletions` was scoped to `SPONSORED_PRODUCTS` (643384b8f) and the settings sync re-read Amazon's real state. There was no repair work to do.

Read through each family's OWN endpoints, never `/sp/*` — SD via `GET /sd/campaigns`, SB via `POST /sb/v4/campaigns/list`.

**They were never a channel — not "stopped", never started.** SD: 26 performance rows, all zero, €0.00 lifetime, 0 impressions. SB: no performance rows at all. Against SP's €22,336.92 and 18.8M impressions. So "dormant by choice vs abandoned" was a false dichotomy: they were *never launched*.

#### 🔴 Three defects the audit found

1. **Every v3/v4 `/list` read was classified as a WRITE.** `isWrite: opts.method !== 'GET'` — but Amazon reads through POST, so all **ten** list endpoints (SP campaigns/adGroups/keywords/targets/productAds/negativeKeywords, portfolios, eligibility, SB) took the write ledger's `failMode: 'closed'`. That inverts the asymmetry the two ledgers exist to express: writes fail closed because they can *mutate the live account*; a `/list` cannot mutate anything. Surfaced when a degraded Redis blocked the SB read while the GET-based SD read beside it sailed through. Fixed with `isMutatingCall()`; re-verified with Redis still down — `agree=19, readErrors=0`.
2. **`createCampaignLocal` was SP-only on the wire.** It has taken `type: 'SP' | 'SB' | 'SD'` since AX.4 and mapped it onto the right local `adProduct` — while unconditionally calling `/sp/campaigns`. An SB/SD create would have produced a *Sponsored Products* campaign wearing an SB/SD name, with a local row confidently mislabelled. Never hit only because no UI offered SB or SD. The blueprint path (`type: c.adProduct ?? 'SP'`) could already reach it. Same class as the AX-VT.4 `/sp/*` verification trap: assuming one endpoint family speaks for all three.
3. **653 of 1,882 report jobs/month (35%) could only ever return zero.** All `COMPLETED`, all `ingestedAt` set, all `rowsIngested: 0` — because paused campaigns that never delivered have no data. Not a parser bug; a targeting bug. `sdCampaigns` 270, `sbCampaigns` 200, `sbSearchTerm` 183.

#### The create paths — modelled on ground truth, not documentation (`_acr5-sbsd-shapes.mts`)

The three families share almost no conventions, and every disagreement is silent (Amazon answers 200 with an empty success array). Captured from this account's own live entities:

| field | SP (v3) | SD (legacy) | SB (v4) |
|---|---|---|---|
| body | `{campaigns:[…]}` | **bare ARRAY** | `{campaigns:[…]}` |
| campaignId | string | **number** | string |
| startDate | `2026-08-05` | **`20260805`** | `2026-08-05` |
| state | `PAUSED` | `paused` | `PAUSED` |
| budgetType | `DAILY` | `daily` | `DAILY` |
| extras | targetingType, dynamicBidding | tactic, costType, deliveryProfile | brandEntityId, goal, kpi, bidding |

`brandEntityId` already exists (`ENTITY3LAY8CBA0R3XI` for IT) — **SB is not blocked on Brand Registry.**

**Safety properties, all verified by dry run against prod:** every create supports `dryRun` (returns the exact payload, calls nothing, writes no local row — campaign count 216 → 216); SB/SD are born **PAUSED** while **SP keeps its born-ENABLED behaviour** (the five SP wizards and GALE's 11 live campaigns depend on it — flipping SP silently would have broken them).

Two further defects the dry run itself caught: `brandEntityId` resolved from *any* marketplace (a DE entity for an IT create — brand entities are per-marketplace), and SP ignored `dryRun` entirely, falling through to the sandbox branch and reporting a reassuring, wrong "no active ads connection".

⚠️ **Deploy API before web.** `dryRun` is an ordinary field: an API that predates it ignores it and *creates*. Web and API deploy independently, so a button labelled "Preview" would spend money in that window. The builder now requires the response to say `mode: 'dry-run'` and warns loudly otherwise.

⚠️ **Standing budgets total ~€1,040/day** across the 19 paused campaigns (SD €985, SB €55). Un-pausing without re-budgeting authorises ~4× the current SP daily run rate.

#### The scoreboard now attributes share by ad type

`CoverageScoreboard.adTypeMix` — impressions/clicks/spend per ad product from our own `AmazonAdsDailyPerformance`, because SQP's `impressionsBrand` has no ad-product dimension at all and cannot answer this.

**SD is deliberately NOT attributed per term, and that is not a gap to fix.** SD is not search-driven — Amazon reports no search term for it — so a per-term SP/SB/SD split would require inventing the SD half. It is reported at marketplace level, where it is true. `searchAttributable: false` says so on the row.

Baseline measured 2026-08-05, all four markets: **SP 100%, SB and SD dormant, `activeAdProducts: 1` everywhere.** IT 1,188,662 impressions / €1,597.39; DE 279,873 / €1,016.82; ES 129,094 / €159.26; FR 58,190 / €93.34. This is the instrument that makes the stacking hypothesis falsifiable — until an SB or SD campaign runs, Stage 5's premise is untested rather than proven.

#### Launch verification and the third family split

The builder reads every launch back through the existing `POST /advertising/launches/verify` (AX-VT.4) — no change to `advertising.routes.ts`, which stays append-only for the concurrent session. `verifyLaunch` already splits by `Campaign.adProduct` and reads each family from its own endpoints; **SB coverage is CAMPAIGN-only**, so SB ad groups and ads come back as `uncovered` rather than being counted as verified. The receipt is asymmetric on purpose, following `LaunchReceipt`: verified gets one quiet line, not-verified shows what disagreed and stays on screen.

**A third instance of the same endpoint-family trap, found while wiring this:** `createProductAdLocal` called `/sp/productAds` for every ad product. An SD product ad pushed there attaches to nothing and reports success. Added `createSdProductAd` (`POST /sd/productAds`, bare array, numeric ids, lowercase state — read off the account's 230 existing SD ads). SD accepts `asin` OR `sku`, so unlike SP it does not hard-fail when no seller SKU resolves (`resolveSellerSku` — see [[reference_amazon_sp_create_traps]]).

That makes three: campaign create, ad-group create, product-ad create. **When touching any ads write path, assume `/sp/*` is hardcoded until proven otherwise.**

#### The shell became a launch

A campaign alone cannot serve, so the builder now authors the whole structure in sequence — **campaign → ad group → product ads → targets → `verifyLaunch`** — through the existing endpoints (`adgroups/create`, `product-ads/create`, `targets/create`); `advertising.routes.ts` still needed no edit. Products are picked from `/api/products/search?advertisableOn=AMAZON_<mkt>` and re-scoped on marketplace change, because a Milan SKU is not advertisable in Germany.

SD targeting is offered as the two plays the blueprint names: **defensive self-ASIN targeting** (wall competitors off pages we already own, on by default) and competitor ASINs, or — under T00030 — views-remarketing audiences on the selected products. The form refuses to submit with zero products, and says plainly when zero targets are planned that *the campaign will not serve*.

**Corrected an own-goal while wiring this.** Stage 5's first pass created SD ad groups and product ads PAUSED alongside the campaign. Amazon's entity states are hierarchical — a paused campaign delivers nothing regardless — so born-paused children buy no safety and create a worse trap: the operator enables the campaign, still sees zero delivery, and reads it as a broken feature rather than a second switch they never set. **Pause at the campaign level only; children are born ENABLED.**

Each step reports itself. Once the campaign exists on Amazon a later failure leaves a *real* half-built campaign, so "which step failed" is the difference between a small fix and a hunt through Seller Central.

#### SB completed — and a fourth `/sp/*`, this one in my own new code

Wiring the launch sequence exposed that `createAdGroupLocal` special-cased SD and let **SB fall through to `/sp/adGroups`** — the same trap a fourth time, now inside code written this session. Added `createSbAdGroup` (`POST /sb/v4/adGroups`, v4 mime, string ids, UPPERCASE state, and **no `defaultBid` at all** — SB bids at target level; the 5 live SB ad groups return only `{adGroupId, campaignId, name, state}`). `createProductAdLocal` now refuses SB loudly instead of silently posting to `/sp/productAds`: **SB has no product ad**, its unit is a creative.

**SB is launchable without building an asset-upload flow.** An SB ad needs a brand logo in Amazon's asset library, a registered brand name and a landing page — none of which our database holds. `resolveSbTemplate()` reads them off the existing SB campaigns, exactly as Stage 5.1 planned. Verified live:

| | brand name | logo asset | landing page | cloned from |
|---|---|---|---|---|
| IT | Xavia Racing Italia | `amzn1.assetlibrary.asset1.46bf…` | `amazon.it/stores/page/5F31D4DF…` | MISANO JACKET BRAND |
| DE | Xavia Racing Germany | `amzn1.assetlibrary.asset1.8990…` | `amazon.de/stores/page/49CD4D20…` | Brand (Jackets) |

The brand names differ per marketplace, which is why the template is marketplace-scoped like `brandEntityId` — cloning DE's assets into an IT ad would have shipped the wrong brand name.

**Reused rather than rebuilt.** A first pass added `createSbAdViaTemplate`, then found `createSbAdLocal` + `POST /advertising/sb-creatives/create` had existed since AX2.9. The duplicate was deleted and `createSbAdLocal`'s `brandName`/`logoAssetId`/`landingUrl` made optional with a template fallback — so every existing caller gained the capability instead of a second creator appearing beside the first. It also gained the SP path's silence-is-failure guard: Amazon answers 200 with an empty success list when it *rejects* a creative, which previously stored a local row and looked like a clean launch. One route appended (`GET /advertising/sb-template`), no duplicates.

#### Verification closed where the new writes are

`verifyLaunch` read back **campaigns only** for SB, so every SB ad group and ad counted as `uncovered` — verification was blind at precisely the entities Stage 5 started creating. Added `listSbAdGroups` / `listSbAds` and wired both into the coverage map. Run over the 4 existing SB campaigns on prod:

| kind | checked | verdict |
|---|---|---|
| CAMPAIGN | 4 | all VERIFIED |
| AD_GROUP | 6 | all VERIFIED |
| PRODUCT_AD | 6 | all VERIFIED |

**16 verified · 0 mismatch · 0 MISSING_ON_AMAZON.** Twelve entities newly covered with zero invented failures — the property AX-VT.4 cares about most, since a verifier that manufactures failures gets switched off. The SB ad group's absent `defaultBid` compares correctly because `verifyEntity` skips any field Amazon does not report. `uncovered` is now 88 SB positive keywords, which no builder creates; the docstring names that instead of the SB gap it used to describe.

#### 🔴 SB keywords — a fifth `/sp/*`, and a wrong conclusion corrected

**406 is a lead; 404 is a dead end. I read them as the same failure and was wrong.**

First pass concluded the SB keyword endpoint was unreachable: `/sb/v4/keywords/list` answers 403 with an AWS-gateway error, and so does the catalogued `/sb/v4/negativeKeywords/list` control, which looked systemic. But the probe had also returned **`GET /sb/keywords` → 406 "No match for accept header"** — and 406 means *the path exists and only content negotiation failed*. Walking Accept headers against it found the answer immediately:

```
GET /sb/keywords   Accept: application/vnd.sbkeyword.v3+json
→ [{"keywordId":115320718119093,"adGroupId":451325355136482,"campaignId":484743497652875,
    "keywordText":"giacca pelle uomo","matchType":"exact","state":"enabled","bid":1.67}]
```

**SB keywords are on the LEGACY v3 API**, with SD's conventions — bare array, numeric ids, lowercase `matchType`/`state` — not SB v4's. `createKeywordLocal` now routes them there; SB is fully launchable and `uncovered` is **0**.

#### 🔴 …which immediately surfaced 88 keywords of real drift

With SB keywords finally readable, `verifyLaunch` over the 4 SB campaigns returns **104 entities, 0 uncovered, 0 MISSING_ON_AMAZON — and 88 KEYWORD mismatches.** Confirmed real, not a reader artefact (`scripts/_acr5-sb-kw-drift.mts`):

| | local DB | Amazon |
|---|---|---|
| IT | all `ARCHIVED` | **60 enabled**, 18 paused |
| DE | all `ARCHIVED` | **10 enabled** |
| bids | flat 50c (18 rows at 0c) | 38 distinct bids, **€0.68 – €2.05** |

Our database believes every SB keyword is archived at a placeholder 50c. Amazon holds 70 enabled keywords bidding up to €2.05. The 18 local rows at 0c correspond exactly to Amazon's 18 paused ones, so state was partially captured while bids were flattened wholesale.

**This is the same family as the SD/SB campaign mis-archive** ([[reference_ads_portfolio_membership_truth]]) — SP-only reconciliation writing over entities it could never see — now visible one level down. **Not auto-healed:** un-archiving 88 keywords changes what the engines manage and what bids get pushed, so it is the operator's call, exactly as the campaign mis-archive was. It matters most on the day SB resumes: the engines would optimise against a fiction.

#### The `servable` bug this exposed was mine

`finishLaunch` marked SB `servable` without any keywords — so the builder would have created an SB campaign that sits at zero impressions forever and reported success. Corrected: neither family serves on ads alone — SD needs targets, SB needs keywords — and the builder now requires them, creates them, and reports per step. The builder gained a Keywords section (match type + one-per-line entry) and refuses to submit an SB launch with none.

*Not built:* SBV, and the un-pause decision on the existing 19 plus the 88 drifted keywords (operator calls — both change what spends).

*Verification limits, stated plainly:* the create round-trip cannot be exercised locally — `adsMode()` is `sandbox` without `railway run`, and pointing the local UI at prod would hit an API that predates `dryRun` and would therefore *create* instead of preview. The UI itself was verified on a clean local build; the product search fails locally (auth + cross-origin) and now says so honestly rather than rendering "no products", which would be a failure disguised as a measured zero — the same defect class as the unmeasured-week rule at the top of this file.

### Stage 6 — One console
- Port the last legacy interpretation surfaces to Analytics tabs; redirect `/marketing/advertising/*` and `/marketing/ads-console/*`; delete after zero traffic.
- *Exit:* one UI over one engine — the control risk of three consoles gone.

#### ACR.6.0 — the retirement map for `/marketing/advertising` (measured 2026-08-05, nothing deleted yet)

41 routes across 8 shared files. Every legacy page is API-backed — none of this is UI-only scaffolding, so
retiring a *page* never retires an *engine*: `advertising.routes.ts` keeps every endpoint below, and the
Control Room, Recommendations and Health already read several of them.

Row counts are from `scripts/_stage6-usage-probe.mts` (read-only, prod, 2026-08-05). They are the deciding
evidence for three surfaces: **a page with a create button and zero rows after a year was never adopted**,
and that is a different fact from "the feature is unfinished".

| # | Legacy route | What it actually is | Prod rows | Destination | Action |
|---|---|---|---|---|---|
| 1 | `/advertising` | 5-card Trading Desk landing | — | `/ads/dashboard` | redirect |
| 2 | `/analytics` | TACOS + ACOS daily trend, inline SVG | — | `/ads/dashboard` (daily spend/ACOS chart); TACoS itself in `/ads/reporting` business context | redirect |
| 3 | `/campaigns` | campaign roster + inline budget/status edit | live | `/ads/campaigns` | redirect |
| 4 | `/campaigns/[id]` | campaign detail + bid history | live | `/ads/campaigns/[id]` (id preserved) | redirect |
| 5 | `/campaigns/[id]/ad-groups/[adGroupId]` | ad-group drill-down | live | `/ads/campaigns/[id]/ad-groups/[agId]` | redirect |
| 6 | `/create` | single-campaign builder | — | `/ads/campaign-builder/single` | redirect |
| 7 | `/architect` | paste keywords → SKAG / match-split / auto-funnel → create | — | `/ads/campaign-builder/sp-super-wizard` (same job, naming rules + structure templates on top) | redirect |
| 8 | `/goals` | full-funnel goal builder (`/goals/suggest-targets`) | — | `/ads/ai-advertising/new-goal` (AI Goal, `/ai-goals`) | redirect |
| 9 | `/automation` | rules command centre | live | `/ads/rules-automation` | redirect |
| 10 | `/automation/new` | rule builder | — | `/ads/rules-automation` (the "+ Rule" type modal picks the slug) | redirect |
| 11 | `/automation/[id]` | rule editor (read + enable/dryRun toggle) | live | `/ads/rules-automation/builder/<slug>?ruleId=<id>` — the new builder already supports `?ruleId=`; the legacy page resolves type→slug server-side before redirecting | redirect (resolving) |
| 12 | `/automation/library` | 35+ static templates, search + category filter | — | `/ads/rules-automation` type modal | redirect |
| 13 | `/automation/health` | fleet health | live | `/ads/health` | redirect |
| 14 | `/automation/executions` | account-wide execution feed | 727,015 | `/ads/rules-automation/control-room?tab=activity` | redirect |
| 15 | `/automation/executions/[id]` | per-execution action timeline + **rollback** | 34,114 log rows | see **gap R1** | port → redirect |
| 16 | `/automation/analytics` | per-rule impact over a window | live | see **gap R2** | port → redirect |
| 17 | `/autopilot` | north star → plain-language plan → apply (`/autopilot/simulate`) | live | see **gap R3** | decide |
| 18 | `/bid-optimizer` | target-ACOS bid preview/apply | live | `/ads/recommendations` (bid engine feeds the ranked inbox) | redirect |
| 19 | `/harvest` | harvest + negate preview/apply | live | `/ads/recommendations`; rules at `?tab=keyword-harvest` | redirect |
| 20 | `/pacing` | budget pacing preview/apply | live | `/ads/recommendations` | redirect |
| 21 | `/share-of-voice` | SOV + impression share | live | `/ads/rules-automation?tab=share-of-voice` | redirect |
| 22 | `/retail-readiness` | out-of-stock / lost-Buy-Box guard | live | `/ads/health` (already renders it) | redirect |
| 23 | `/momentum` | live momentum | live | `/ads/dashboard` (momentum block) | redirect |
| 24 | `/insights` | 4 rule-based insight types | live | `/ads/recommendations` | redirect |
| 25 | `/recommendations` | AI + rules feed | live | `/ads/recommendations` (explicitly ported in E3) | redirect |
| 26 | `/budget-manager` | plans + enforcement | live | `/ads/budget-manager` | redirect |
| 27 | `/dayparting` | schedules + demand intel | live | `/ads/rules-automation/dayparting` | redirect |
| 28 | `/reports` | report-job queue + manual triggers | live | `/ads/reporting/pipeline` | redirect |
| 29 | `/search-terms` | account-wide search-term explorer | 9,746 | `/ads/reporting/search-term` | redirect |
| 30 | `/ngrams` | n-gram intelligence over those terms | 9,746 | see **gap R4** | port → redirect |
| 31 | `/profit` | **per-SKU × day P&L** — revenue, COGS, fees, ad spend, margin band, coverage badge | **854 rows (160 in 30d)** | see **gap R5** | port → redirect |
| 32 | `/events` | change timeline + **custom annotations** (`POST /events/custom`) | 25,597 in 30d | `/ads/changelog` covers the feed; the note-writing does not exist — **gap R6** | port → redirect |
| 33 | `/incrementality` | modeled iROAS (branded vs non-branded lift) | derived | see **gap R7** | decide |
| 34 | `/funnel` | keyword-graduation journey + cross-match negation plan | live | see **gap R8** | decide |
| 35 | `/budget-pools` | multi-marketplace pools + rebalance strategy | **0 pools** | see **gap R9** | decide |
| 36 | `/budget-pools/[id]` | pool detail, allocations, rebalance history | **0 allocations** | ditto | decide |
| 37 | `/dsp` | Amazon DSP Plus builder (Performance+ / Brand+) | **0 DSP campaigns** | none — DSP entitlement is refused at Amazon (`reference_amazon_stack_entitlements`) | delete |
| 38 | `/audiences` | AMC-style no-SQL audiences | **0 audiences** | none — AMC likewise refused | delete |
| 39 | `/storage-age` | FBA aged-stock heatmap + LTS projection | **0 rows** | ingest has never populated; deep-linked from `/fulfillment/replenishment` — **gap R10** | decide |
| 40 | `/feeds` | Google Shopping + Meta catalog feed exports (`/api/feed-export`) | live | not an Amazon-ads surface at all — misfiled here — **gap R11** | decide |
| 41 | `/debug` | Amazon endpoint probe console (operator diagnostics) | — | no equivalent; operator-only — **gap R12** | decide |

Shared files retired with the tree: `_shared/AdvertisingNav.tsx` (already a no-op returning `null`),
`AdvertisingSidebar.tsx`, `DateRangePicker.tsx`, `DetailSkeleton.tsx`, `EnableWritesButton.tsx`,
`WriteModeBanner.tsx`, `formatters.ts`, `rule-catalog.ts`, `layout.tsx`. `rule-catalog.ts` is imported by
`/automation/[id]` and the library — both go, so it goes; **verified by import graph with comments stripped,
not by grep**, per today's false-orphan incident.

Inbound links to rewrite (grep, `apps/web`): `_shared/app-nav.ts` (the "Advertising (classic)" child),
`lib/auth/nav-permissions.ts`, `products/[id]/edit/tabs/AdsTab.tsx` (5 links), `marketing/campaigns/page.tsx`
(redirect target) + `MarketingCampaignsClient.tsx`, `marketing/reviews/automation/page.tsx` (2),
`fulfillment/replenishment/_shared/StorageAgeTile.tsx`, `marketing/ads-console/campaigns/CampaignsTable.tsx` (2),
and the legacy sidebar itself.

**`apps/api` is already clean.** Every `href` a service hands the Today board or the inbox points at
`/marketing/ads/*` (`ads-today-board.service.ts`, `ads-suggestions.service.ts`, the eBay services). The only
`/marketing/advertising` string in `apps/api/src` is a placeholder **API** route in `marketing.routes.ts:10`
(`GET /marketing/advertising` → `{items:[],count:0}`) — an endpoint path, not a web link, and out of scope.
One href does point at the *other* legacy console — `ad-rank-defend.job.ts:475` → `/marketing/ads-console/rank`
— which belongs to the rank engine another session owns and is left alone.

**Out of scope here:** `/marketing/ads-console/*` (the third console, 11 routes) is Stage 6's other half and
is entangled with the rank engine; it is a separate pass.

##### The 12 gaps — what a redirect would actually destroy

A redirect is only honest when the destination answers the same question. These twelve do not yet.

| Gap | What is lost | Proposed home (no new rail entry) |
|---|---|---|
| **R1** | Roll back a whole rule **execution** (24h window, `POST /actions/:executionId/rollback`). Changelog undoes ONE change; an execution touches many entities. | Drawer on the per-rule execution history that `rules-automation/tabs/RuleListTab.tsx` already renders |
| **R2** | Per-rule impact over a window — runs, terms negated, bids adjusted, campaigns guarded (`/automation-analytics`). | Summary strip on `/ads/rules-automation` Apply Rules |
| **R3** | North-star planner: pick profit/balanced/growth → read the plain-language plan → apply (`/autopilot/simulate` + `/apply`). Overlaps Recommendations, which ranks the same bid engine's actions individually. | ✅ Panel on `/ads/recommendations` (operator decision 2026-08-05) |
| **R4** | N-gram intelligence over the 9,746 stored search terms — which word fragments burn budget. | ⛔ **PARKED — Analytics-owned.** `ReportingClient.tsx` records the standing split verbatim: *"Interpretation — coverage, funnel, n-grams, momentum — belongs to Analytics next door. (Operator decision, 2026-08-04.)"* Filing it under Reporting would contradict that decision, and `/ads/analytics` belongs to another session. `/marketing/advertising/ngrams` therefore stays live and is NOT redirected |
| **R5** | **Per-SKU × day P&L** — revenue, COGS, fees, ad spend, refunds, margin band, per-row coverage badge. The Dashboard shows `trueProfitMargin30dPct` and a coverage explainer but never the rows behind it. | Tab on `/ads/dashboard` — the drill-down for a number the dashboard already prints |
| **R6** | Writing a custom annotation (`POST /events/custom`). `ChangeAnnotations.tsx` plots operator notes on the campaign chart; nothing in the new console can create one. | "Add note" action on `/ads/changelog` |
| **R7** | Modeled iROAS (branded vs non-branded lift, hand-set factors). Not measured — modeled from two tuning constants. | ✅ Panel on `/ads/reporting`, labelled *modeled* on its face (operator decision 2026-08-05) |
| **R8** | Keyword-graduation journey + the cross-match negation plan (Exact owns the term; negate it in Phrase/Broad/Auto). Prevents a product bidding against itself. | ⛔ **PARKED — Analytics-owned**, same standing split as R4 (which names "funnel" explicitly). `/marketing/advertising/funnel` stays live and is NOT redirected. Note for whoever takes it: the *journey view* is interpretation, but `POST /funnel/cross-match` is an ACTION and would sit naturally on `?tab=negative-targeting` — the page may want splitting rather than moving whole |
| **R9** | Creating a budget pool at all. **0 pools exist**, yet `budget-pool-rebalance.job.ts` and `ads-control-room.service.ts` both read them — the engine is live with no way to feed it. | Tab on `/ads/budget-manager` |
| **R10** | FBA aged-stock heatmap. **0 rows** — `fba-storage-age-ingest` has never populated, so the page and the `/fulfillment/replenishment` tile that deep-links into it are both empty today. | ✅ Delete, and drop the tile's dead deep-link (operator decision 2026-08-05). The ingest and both endpoints stay; if it ever populates, the data wants a home in fulfillment, not in the ads console |
| **R11** | Google Shopping + Meta catalog feed exports. A live feature (`/api/feed-export`) that has nothing to do with Amazon ads and only lives here by accident. | ✅ Tab on `/marketing/content` (operator decision 2026-08-05) — out of the ads tree entirely |
| **R12** | Amazon endpoint probe console (12+ live probes per profile). Operator diagnostics with no replacement. | Panel on `/ads/health` |

**Sequencing.** Ports land first, each verified on prod; redirects follow; the tree is deleted last, in one
commit, once nothing links into it. Redirects are permanent `redirect()` server components so bookmarks and
the operator runbook keep working. Anything ported obeys the light-only rule for `/marketing/ads` — no `.dark`
blocks (gate decision 4).

**Two routes survive this pass.** R4 (`/ngrams`) and R8 (`/funnel`) are interpretation surfaces that a
standing operator decision assigns to Analytics, and Analytics belongs to another session. They keep working
at their current URLs; the legacy `layout.tsx` is reduced to a bare passthrough so they no longer render the
retired sidebar. Everything else in the tree is ported, redirected or deleted.

##### ACR.6 — SHIPPED 2026-08-05 (local; prod verification pending a green push)

**101 files, ~13,900 lines deleted.** 39 of 41 routes now 308 into `/marketing/ads`.

Ports landed first, one commit each, before anything was redirected:

| Gap | Landed as | Commit |
|---|---|---|
| R5 | `ProfitPanel` on `/ads/dashboard` — per-SKU × day P&L under the margin KPI it explains | `fad64dbe8` |
| R9 | `BudgetPoolsDrawer` on `/ads/budget-manager` — create/enable/allocate/rebalance/history | `74d2a531d` |
| R7 | `IncrementalityPanel` on `/ads/reporting` — collapsed, labelled *modeled* in three places | `a0293f1a0` |
| R3 | `AccountPlanPanel` on `/ads/recommendations` — north star → plan → Modal-confirmed apply | `39a084172` |
| R1 + R2 | Execution rollback in the rule history drawer; fleet-impact strip on Apply Rules | `1adc14f28` |
| R6 | "Add note" on `/ads/changelog` — the console can finally write the row it already reads | `3e02983e8` |
| R12 | `ProbePanel` on `/ads/health` — probe rows kept, the stale Phase-B/C verdict dropped | `719982e41` |
| R11 | `/marketing/content/feeds` + a Content tab; preview fetch moved client-side | `bc133aa60` |

Retirement: `9ab7cb52b`.

**Three deletions, each on measured evidence rather than judgement:** DSP (0 campaigns ever created),
AMC audiences (0 rows) — both entitlements refused at Amazon — and FBA storage-age (0 rows, ingest never
ran), whose dead deep-link from the replenishment tile went with it.

**Redirects live in `next.config.js`, not as `redirect()` stubs.** A tree of one-line files is a tree that
gets edited back into pages; putting them in config is what let the directory actually be deleted. Real
308s, so bookmarks and the runbook keep working. Array order is load-bearing and commented — every literal
`/automation/*` path precedes `/automation/:id`.

**Verified** against a running local server (all 39 sources → 308 with the expected target, including
`:id` and `:id/ad-groups/:agId` pass-through and the `?tab=` destinations; all 16 distinct destinations
return 200; `/ngrams` and `/funnel` still return 200 and do NOT redirect). Guards green: link targets
(243 static · 115 breadcrumb · 197 template-literal), DS ratchet, P3 tokens, i18n parity.

⏳ **Prod verification is still outstanding.** The pre-push hook builds the working tree, and the tree
currently carries in-flight TypeScript errors from concurrent sessions (control-room, SB/SD campaign
builder). Nothing here is blocked on those; the push is. Re-run the same redirect sweep against the
deployed URL once the tree compiles.

##### ACR.6.1 — what the prod screenshots found that the redirect sweep could not

Verifying the redirects proved routing; it said nothing about whether the eight ported panels were
*right*. Reading them against their endpoints, and then against prod, turned up three defects — all
of them invisible to `tsc`, and two only visible on screen.

**1. The P&L panel and the KPI above it answered different questions.** Measured live: the panel
footer read **Margin 16.1%** directly beneath a **True margin (30d) 37%** KPI, with 268 of 500 rows
carrying no cost price. Two causes, and the first fix alone would not have been enough:
- *Window.* The panel fetched `limit=500` with no date filter — the most recent 500 of 854 lifetime
  rows — while `/advertising/summary` computes over `date >= now-30d`. Different populations.
- *Denominator.* `/advertising/summary` divides profit by the revenue of rows **that could be
  priced** (ACR.0.5 chose this deliberately: dividing partial profit by total revenue understates
  margin in exact proportion to missing cost data). The panel divided by all revenue.

  Fixed to the same window and the same denominator rule, with the coverage share printed under the
  figure the way the KPI prints its own. `8c124ca01`, `41bb3ad03`.

**2. 🔴 Three automation endpoints have been returning 500 to every caller.**
`/advertising/automation-analytics`, `/automation-feed` and `/automation-impact` all filtered
`domain: 'advertising'` **flat on `AutomationRuleExecution`**, which has no such column — `domain`
lives on `AutomationRule`. Each where-clause carried an `as never` cast, which is precisely what
stopped `tsc` objecting, and this workspace is not strict. Prisma rejects it at runtime with
*Unknown argument `domain`*.

Proven on prod, not inferred (`scripts/_acr6-analytics-probe.mts`, read-only). Routed through the
relation the same filter returns **3,577** advertising executions in 30 days — against **522,985**
across all domains, so the relation filter is also what bounds the scan.

The consequence for Stage 6: the legacy page R2 was ported *from* had been rendering an error state
all along. Nobody noticed, because a broken endpoint and an idle account looked identical.
`69f64f6f6`.

**🔴 3. The fleet emits six action types; the impact endpoint counted three of them — and none of
the failures.** Once the endpoint returned data at all, prod read **"0 actions recorded" beside
"3,622 runs that acted"**, which is not a coherent sentence. Measured rather than assumed
(`_acr6-actiontypes-probe.mts`, `_acr6-actionvalues-probe.mts`, both read-only):

| action type | results, 30d | ok | counted before? |
|---|---|---|---|
| `notify` | 3,587 | 3,587 | no (correctly — it is not a change) |
| **`bid_up`** | **2,032** | **0** | no — **every one fails** |
| `bid_to_target_acos` | 1,080 | 1,080 | yes, and `applied` sums to **0** |
| `retail_guard` | 387 | 387 | yes, and `paused` sums to **0** |
| `adjust_ad_budget` | 88 | 88 | **no** — real queued budget writes, uncounted |
| `alert_operator` | 44 | 44 | no (correctly) |
| `harvest_and_negate` | **0** | — | yes, but it never occurs |

The three counted types covered **20.3%** of 7,218 action results, and one of the three never
appears. So the surface reported "0 actions" on an account that was changing budgets that week. The
other zeros are true, and now provably so.

**The largest signal in the data was invisible: 2,032 failed `bid_up` actions in 30 days, every one
`Unsupported target=ad_group`, all from a single rule — "New-to-brand optimizer".** Its *runs*
complete (they count as SUCCESS/PARTIAL), so every run-based health read shows it working while
every action inside it fails. Failed actions are now counted, excluded from the "recorded" total,
and the worst offender is named on its own line.

✅ **RESOLVED — and it was never one rule.** `bid_down` has handled both `ad_target` and `ad_group`
since it was written; `bid_up` handled only `ad_target`. They are mirror-image actions authored
together, so the missing branch is an oversight, not a decision — and its effect on prod was a
**one-way ratchet: automation could lower ad-group bids but never raise them.** "Reduce bids on
ACOS spike" (bid_down · ad_group · enabled · live) works today; "New-to-brand optimizer" (bid_up ·
ad_group · enabled · live) failed 2,032 times on this exact error.

The new branch mirrors bid_down's structure with bid_up's own spend estimate and daily-cap check,
because raising a bid costs money and lowering one does not (`AdGroup.spendCents` gives the estimate
the same shape as the ad_target branch).

**🔴 TWO CORRECTIONS TO THE PARAGRAPH ABOVE, both found by verifying instead of assuming.**

1. **"A one-way ratchet" overstated it.** The handler asymmetry was real, but no `bid_down` on an
   ad group has ever fired either: `Reduce bids on ACOS spike` (bid_down · ad_group · enabled ·
   AUTO) has 2,469 executions all-time and **zero** `bid_down` action results in its last 500
   SUCCESS/PARTIAL runs. Neither direction was moving ad-group bids. What was true is the code gap;
   what was not true is that cuts were landing while raises failed.
2. **The rule is misconfigured beyond the handler.** After the fix the error simply moved —
   `Unsupported target=ad_group` → **`No adGroup.id in context`**. Its trigger is
   `CAMPAIGN_PERFORMANCE_BUDGET`, which supplies campaign-grained context, while its action targets
   `ad_group`; nothing can resolve an ad group from a campaign trigger. Its condition
   (`campaign.acos ≤ 0.35`) also does not match its own description (">30% of orders new-to-brand,
   from ntbOrders14d"). The template itself needs redesigning — a trigger that yields ad groups, or
   an action at campaign grain. **120,007 all-time executions have produced nothing.**

**🔴 AND THE SAFETY FLIP WAS INERT — `dryRun` is a dead field.** `resolveAutonomy` reads
`autonomyLevel` first, falling back to the `dryRun` binary only when that column is null or `'OFF'`.
**All 51 advertising rules carry an explicit `autonomyLevel`, so `dryRun` cannot bind on any of
them.** Setting `dryRun=true` left the rule resolving to **AUTO** — able to write — while its row
read `dryRun=true`: a safety measure that is worse than none, because it reads as protection.
Caught only because executions kept recording `dryRun=false` afterwards. Fixed by setting
`autonomyLevel='PROPOSE'` and verifying through `resolveAutonomy`/`levelActs` themselves rather than
by re-reading the field. **10 of 51 advertising rules currently resolve to a level that can write**
(`scripts/_acr6-autonomy-check.mts` lists them).

**Shipped behind PROPOSE, by operator decision 2026-08-05.** Repairing the handler alone would
have taken a 30-day-dead rule straight to writing live bids in one deploy — +10% per fire against
282 enabled ad groups, condition `campaign.acos ≤ 35%`, its own caps of 10 executions/day and
€200/day. A rule with **zero successful executions has zero evidence**, which is the exact bar this
programme's graduation doctrine sets, so `New-to-brand optimizer` (`cmpujofi00018rv016th0ykq9`) was
set `dryRun=true` BEFORE the fix shipped. It now proposes; the impact strip shows what it would have
done. Reverting is one field.

⏳ Still open: reviewing a week of its proposals, then deciding whether it graduates to live.

##### ACR.6.2 — why the AUTO rules do nothing, and the trap in fixing it

Nine rules resolve to AUTO. Chasing what they actually emit lands on one cause upstream of every
rule's configuration, and then on a hazard in the obvious repair.

**The cause.** `AmazonAdsDailyPerformance` carries **5,806 AD_TARGET rows** for the last 30 days
(€3,257.86, 5,996 clicks). `AdTarget.spendCents` / `.clicks` / `.salesCents` are **zero across all
5,204 rows**; `AdGroup.spendCents` is zero across all 285. `previewBidOptimization` filters
`ENABLED, isNegative=false, spendCents > 0` — the first two leave 2,685 targets, the third leaves
**0**. So it returns no proposals, every run reports `applied: 0` truthfully, and four AUTO rules
have produced ~1,174 successful executions that changed nothing.

**This is a decommission, not a bug.** `ad-autopilot.job.ts` records it: the only writer,
`ads-metrics-ingest`, was **deliberately retired in H.2e (2026-05-18)**, and that job has already
migrated its own signals to `AmazonAdsDailyPerformance` at CAMPAIGN grain. Resurrecting the ingest
would be the wrong direction; repointing readers at the daily table is the right one. (My first
read of this called it a broken denormaliser — corrected.)

**The migration is viable.** Target-grain rows exist and the join key is exact: all 458 distinct
`entityId`s resolve to an `AdTarget` via `externalTargetId` — checked, not assumed.

**🔴 And doing it naively would cost money.** Modelling the migrated engine against live data
(`scripts/_acr6-bidopt-whatif.mts`, read-only) it emits **103 proposals — of which 51 RAISE bids on
targets currently under 5¢**, carrying **€1,316.41** of 30d spend. This account does not pause; it
silences by dropping bids to ~2¢, and `FLOOR_CENTS` is 5 — so the engine's own hard-cut arithmetic
`max(FLOOR, bid × 0.5)` becomes a **raise** for anything already suppressed. Half its output was
un-suppression of what an operator deliberately silenced.

**Guarded ahead of the fact** (`1898e0f00`): the candidate filter now excludes
`suppressedFromBidCents IS NOT NULL` and any bid below the floor. Both are needed — 451 of the 600
sub-floor targets carry the marker, the rest do not. Inert today and proven so: the engine still
returns 0 proposals and the guard excludes no reachable row.

Two smaller results from the same sweep. **"Reduce bids on ACOS spike" does fire** — 539 `bid_down`
results in 30d, every one `VALUE_CAP_EXCEEDED`; it is capped, not broken, which refines the earlier
note that it emitted nothing (that probe read only SUCCESS/PARTIAL rows; these failures are in
FAILED ones). **"Alert: ACOS spike" emitting no non-notify actions is correct** — it is an
alert-only rule, not an idle one.

**4. The strip hid its own failure.** It returned `null` on a failed fetch, reasoning that a zeroed
banner would read as "the fleet did nothing". True of a zero; false of a 500 — and it is why the bug
above was invisible on prod until the schema was read. A failure now says so in one muted line.

Its three captions were also wrong, corrected in `bc2d8526e`: `totalRuns` excludes `NO_MATCH` ticks
(so it is "runs that acted", not "evaluations"), `rules[]` is grouped from those executions (so its
length is "rules that ran", not the 51 that exist), and the query never filters `dryRun` (so counts
can mix written with merely proposed).

**Nav.** "Advertising (classic)" is gone from `app-nav.ts` — a menu offering classic beside current teaches
operators the current one is optional. `nav-permissions.ts` keeps its `/marketing/advertising` mapping on
purpose: the parked pages are still ads surfaces, and dropping it would fall through to the `/marketing`
prefix and gate them on `pages.marketing`.

**`apps/api` needed no change.** Every service href already pointed at `/marketing/ads/*`.

---

## Part 6 — Gate decisions (status 2026-08-05)

1. **Control Room location** — ✅ DECIDED: chevron child under Rules & Automation; "AI Control" rail entry removed; `/autopilot` redirects.
2. **Coverage vs profit** pilot objective — ⏳ OPEN (recommendation: coverage mode with a family spend guardrail — the pilot exists to price coverage; profit mode is the fallback the gate can choose).
3. **Pilot family** — ⏳ OPEN (recommendation: GALE — 11 live campaigns, real spend and data; AIREON carries the unresolved variation co-occupancy question that Stage 2.4 measures first anyway).
4. **Dark mode** — ✅ DECIDED: ads console deliberately light everywhere; strip stray `.dark` blocks under `/marketing/ads`, document in `ads.css`.
5. **COGS** — ✅ DECIDED: import from the commerce platform linked to SKUs; needs building → Stage 0.5 is a real phase, not a data-entry task.
6. **SOV data** — defaulted to in-policy approximation (operator did not object); buy-a-feed remains the Stage 2 fallback if approximation proves insufficient.
7. **SBV creative** — unanswered; Stage 5 plans SB + SD, SBV only if video assets surface.
9. **Graduation evidence bar** — ✅ DECIDED 2026-08-05: **3 clean weeks**, and two tracks kept
   labelled apart. "Ready" requires proposals applied *unchanged*; rules that merely ran cleanly
   are shown under their own verdict and never as ready, because running is not agreeing.
10. **Undo window** — ✅ DECIDED 2026-08-05: **per action class**, not the flat 7 days the Stage 4
    exit line asks for. Bids stay at 24h (the rank engine supersedes them hourly — same reasoning
    as `ADS_STALE_INTENT_MS`); budgets and placements get 7 days. The exit criterion is recorded
    as met-with-qualification rather than quietly reinterpreted.
11. **Digest delivery** — ⏳ **OPEN, and it is two env vars, in this order.** Outbound email is
    already ON in prod, so this is not a dry-run switch:
    `NEXUS_ADS_DIGEST_RECIPIENTS=<addresses>` first (without it every run logs SKIPPED), then
    `NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON=1` to start the Monday dispatcher. Read one from the
    Control Room → Activity → *Preview last week's* before deciding.
12. **Hourly spend breaker** — ⏳ **OPEN.** `maxHourlySpendCentsEur` is unset, so the €500/hour
    code default is what is enforced, against a peak hour of €20.91. Operator picks the number;
    ~€25/hour is roughly 7× the current hourly average and was the recommendation. Until then ad
    spend has no effective ceiling — the actions/hour signal (500) is the only live one.
13. **"Tabliu"** — resolved: the operator meant **Tableau**, i.e. BI dashboards, not an ads tool. Relevant lesson only: the reporting layer should offer composable saved views/dashboards — largely covered by RPT (library, runner, custom metrics, saved versions, share links); a "pin any report view to a dashboard" pattern is noted for a later RPT phase, not ACR scope.

# AIAD — AI Advertising page: from H10-shaped shell to the goal-based command center

**Date:** 2026-08-20 · **Status: PROPOSED — awaiting operator approval, no code written**

## 0. The finding that shapes everything

The page, the goal model, and the execution arsenal all exist. The wire between them does not.

| Layer | State |
|---|---|
| `/marketing/ads/ai-advertising` (rail item #4) | H10 pixel-match shell. Overview strip + goals table render **hardcoded zeros**. Filters/Export/pagination are dead controls. Last touched 2026-06-23 — the oldest corner of the console. |
| `new-goal/AiGoalBuilder.tsx` | Genuinely complete builder: AI Target (Impression&Click / Sales / ROAS), Strict vs Shared budget mode, advanced allocation, seed/exclude keywords, product targets, portfolio. POSTs `AdProductGoal`. |
| `AdProductGoal` | Written by the builder, read by the dashboard, **touched by nothing else**. No campaign FK, no metrics, no engine linkage. Service header: "campaign materialization is a later phase" — never built. |
| `AutopilotPlan` + Conductor (`services/advertising/autopilot/`) | The right execution model already exists: goal presets LAUNCH/PROFIT/BALANCED/LIQUIDATE/DEFEND_RANK, autonomy OFF/SUGGEST/AUTO, guardrails, modules, `AutopilotDecision` with rollback, backtest. 🔴 **The `ad-autopilot` cron referenced by schema + UI comments was never registered** — plans run only via manual POST. |
| The arsenal | All live on prod: gated writes + per-campaign allowlist, harvest, negation, dayparting, rank director, budget pools, retail guard (G7), SP/SB/SD create (`ads-create.service.ts`, 92 KB), launch verify, anomaly breaker, evidence audit log, suggestions queue, per-class undo. |

So this is a **wiring project, not an invention project**: goal → materialization → conductor → engines → metrics → decision feed.

## 1. Locked constraints this plan honors (from the corpus)

1. **Zero new sidebar entries** (ADX Part 4, ACR §151). Satisfied: the page already owns rail slot #4. Detail views are sub-routes of the section, like `new-goal` already is.
2. **One autonomy vocabulary** — Off/Observe/Propose/Auto per lever, global dial as an account-wide *ceiling* (the two-vocabulary defect killed the old AI Control page; ACR:19).
3. **No parallel dials** — this page reads/writes the *same* endpoints as the Control Room (`/autonomy/*`, `/automation/*`); it never grows its own rule store (the ACR.1.6 precedent).
4. **Recorded refusals stand**: scraped SOV (never — the selling account is the asset at risk); opaque ML / 200-param bidding (not at ~€4.5k/mo spend); autonomous *structure* mutation (the AI creates a structure a human could run by hand, then never restructures it silently); AMC incrementality (blocked at Amazon for this account).
5. **House rules**: suppress via ~2¢ bids, never pause; DS + AdsDataGrid for the table; additive migrations only; ship live not dark (the conductor ships running in PROPOSE, visibly producing suggestions — not dark, not auto).

## 2. What "better than all of them combined" means here

Union of the competitor feature set, mapped to where it lands:

| Competitor capability | Source | Where it lands |
|---|---|---|
| Goal-based entry, engine picks levers | PER/TEIK/H10/M19 | Builder's AI Target extended to the **five-goal vocabulary** (LAUNch/PROFIT/BALANCED/LIQUIDATE/DEFEND_RANK) — a superset of Perpetua's 4 and H10's 3 |
| Tri-campaign scaffold (auto→broad→exact) | H10/PER/BidX | AIAD.1 materialization via `ads-create.service.ts`; + PAT campaign when product targets present |
| Learning phase | H10/PER | Life-stage on the plan (Launch→Scale→Maintain per spec) surfaced as a chip + explained |
| Predictive bidding | H10/PER/M19 | Existing engines + Bayesian shrinkage (live) + spec's bid formula; **transparent, evidence-logged** — our answer to the black box |
| Autonomous harvest + negation | all | Already live; conductor *provisions* the rules (spec's hybrid ownership) and reads back decisions |
| Hourly view / dayparting | PER/PAC/Skai | AMS hourly table + existing dayparting engine; hourly panel in drill-down when AMS present |
| Inventory/Buy-Box/price gate | PAC/CIQ | **Already live** (retail_guard, G7) — surfaced on the goal card instead of hidden |
| Budget pacing/utilization | H10/PAC/Skai | Real Budget Utilization column + pacing strip in drill-down |
| Decision transparency + undo | Prism (nobody else has undo) | `AutopilotDecision` + `AdvertisingActionLog` evidence feed = "why did this bid move", per-class undo |
| Governed autonomy dial | PAC/QRT | Existing 4-notch vocabulary, per lever, graduation on evidence |
| Backtest before AUTO | nobody | `/autopilot-plans/:id/backtest` — surfaced as the graduation gate |
| Lockout ("hands off my campaigns") | H10/PER | **Inverted** — see Decision Q2 below |

Explicitly *not* cloned (refused with recorded rationale): scraped SOV, opaque ML, autonomous restructuring, cross-retailer breadth, managed-service depth.

## 3. The phases

### AIAD.0 — Truth on the page (metrics wiring)
- New endpoint `GET /advertising/ai-goals/summary?window=…`: aggregates `AmazonAdsDailyPerformance` over each goal's linked campaigns → per-goal Spend/Sales/ACoS/Orders/Budget-Utilization + account-level series for the chart.
- Overview chart becomes real (4 metrics, lookback 14/30/60/90) reusing the existing reporting chart components.
- Goals with no linked campaigns show an honest "not materialized" state, not fake zeros.

### AIAD.1 — Materialization (goal → campaigns)
- `materializeProductGoal(goalId)`: builds the scaffold via `ads-create.service.ts` per budget mode — Strict = per-ASIN campaign set; Shared = pooled. Roles: AUTO (discovery), RESEARCH (broad, seeds), PERF (exact, seeds), + PAT when product targets exist. Exclude keywords → negatives; exclude ASINs → negative PAT. Naming: `[AI] {goal} · {ASIN|SHARED} · {ROLE}`.
- Additive migration: `AdProductGoal.campaignIds Json`, `AdProductGoal.planId` (FK → AutopilotPlan), `materializedAt`.
- Rides the existing local-first + write-gate path; verified by `ads-launch-verify` with a receipt on Trust.
- Existing DRAFT goals get an explicit **Materialize** action; new goals materialize on Launch.

### AIAD.2 — The driver (conductor cron + provisioning)
- Register the missing **`ad-autopilot` cron** (fast 15-min + slow daily loops per `ai-control-autopilot-spec.md`), driving ACTIVE plans through the existing Conductor.
- Materialization creates the `AutopilotPlan`: aiTarget→goal preset (Impression&Click→LAUNCH, Sales→BALANCED, ROAS→PROFIT; builder later exposes all five), guardrails from builder inputs, modules per preset; harvest/negate provisioned as engine rules (`linkedRuleIds`).
- **Autonomy starts at PROPOSE** — decisions land in the existing Suggestions queue; AUTO is earned per lever through the existing graduation machinery (3 clean weeks, applied-unchanged). Bid writes stay behind the per-campaign allowlist.

### AIAD.3 — Page rebuild on the DS
- Goals table → **AdsDataGrid** with URL-linkable state, working Filters + Export, saved filters. Columns: config (Status, Start, Budget Mode, Daily Budget, Target) + performance (Utilization, Spend, Sales, ACoS, Orders) + Life-stage + Autonomy + Health.
- Keep the H10 information architecture (overview → table → drill-down); replace the hand-rolled table internals with the console's conventions. All four stylesheets rule applies.

### AIAD.4 — Drill-down (goal detail)
- Sub-route `ai-advertising/goal/[id]` (inside the section; not new nav): per-goal chart, per-role campaign breakdown, **decision feed** with evidence + undo, hourly panel (AMS), pacing strip, life-stage, harvest/negation activity, drift badge for external Seller-Central edits.
- Raw material: the ~11k lines of PARKED sections are the cheapest source for several panels ("re-mounting one is a single import").

### AIAD.5 — Beyond parity (backlog, pick after 0–4 are live)
Budget auto-refill / out-of-budget prevention (open D5), starting-bid-from-evidence on harvest (E4), organic-aware suppression (ACR 3.4), Bid-Explorer-style forecast via backtest, goal-level what-if.

## 4. Decisions needed from the operator

- **Q1 — Scope of this session:** recommend AIAD.0→2 (truth + wiring) as the core, then 3–4. All five is possible but 0–2 is the part that turns the page from prop to product.
- **Q2 — Lockout policy:** H10/Perpetua lock humans out of AI campaigns. Recommend the inverse — **governed transparency**: campaigns stay visible/editable everywhere, goal-managed ones carry a "Managed by AI Goal" badge, manual rule assignment onto them is blocked with an explicit override, operator edits are recorded as authority pins the conductor respects, external edits surface as drift. Matches the corpus position (structure a human could run by hand) and avoids H10's documented rules/AI mutual-exclusion trap.
- **Q3 — Initial autonomy:** recommend PROPOSE-only until graduated (per-lever), consistent with the one-vocabulary rule and ship-live-not-dark (proposals are visible immediately).

## 5. Known data gaps that bound ambition (stated honestly on the page, not papered over)

COGS on 0/362 products (margin-anchored goals degrade to ACoS-anchored until costs are entered) · `topOfSearchImpressionShare` all-null · SOV approximated in-policy · AMS dormant until the SQS ARN is configured (hourly panel hides itself).

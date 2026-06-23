# AI Control (Autopilot) — Algorithm & Architecture Spec  ·  P-A

**Surface:** `/marketing/ads/campaign-builder/sp-super-wizard` → Step 3 "Automation & Launch" → **AI Control** mode (sibling to the *Rule Setting* mode owned by the other session) + a post-launch **Autopilot control room**.

**Decisions already locked:** React Flow node-graph canvas · new `AutopilotPlan` model + Conductor service · spec-before-code.

**Goal of AI Control:** the operator picks **one goal + guardrails**; the system then autonomously sets bids, budgets, placements, dayparting, and search-term targeting on a closed loop — within hard guardrails, write-gated, fully audited and reversible — and shows every decision live on a drag-and-drop canvas.

---

## 1. Principle: orchestrate the arsenal, don't rebuild it
The backend already has every control primitive (bid optimizer + bidding-engine µsvc, profit-native target-ACoS, budget pacing + pool rebalancer, rank-defend controller, dayparting/budget-schedule crons, harvest/negate, placement tuner, bid suppression, write-gate, audit, rollback). The Conductor is the **single brain** that drives them from one plan. It **reuses** their pure/apply functions; it never duplicates their math.

> ### ⚠ Coordination boundary (parallel sessions)
> **Harvest + Negate automation is OWNED by the parallel *Rule-Setting* session** (search-term → exact promotion, waste negation). The Autopilot **does NOT run its own harvest/negate engine.** Instead it **configures and reads** theirs: it provisions the matching harvest/negate automation rule (goal-appropriate thresholds, scoped to the plan's campaign set) and surfaces *their* decisions in our unified feed/canvas. The Conductor **orchestrates directly only** the modules we own: **bid · budget · placement · rank · dayparting.** Shared contract to agree with that session: (1) the harvest/negate rule-config shape the Autopilot writes, (2) a read API/event for their decisions so they appear on our canvas.

## 2. The Conductor control loop
A tiered closed loop, per enabled `AutopilotPlan`:

- **Fast loop — every 15 min** (aligns with existing crons): bid nudges, budget pacing, dayparting/budget windows, rank-defend step, placement modifiers, guardrail enforcement.
- **Slow loop — daily**: harvest converters → exact, negate wasters, recompute profit-native target ACoS, budget rebalance across the set, life-stage transition (Launch→Scale→Maintain).
- **Event loop — on signal**: inventory stockout → bid throttle; guardrail breach → suppress (never pause).

**Each cycle, per campaign in the plan's set:**
1. **Gather signals** — trailing perf (spend/sales/clicks/orders/ACoS/CVR/CTR/CPC), hourly perf (dayparting + rank-loss proxy), profit (margin, break-even ACoS), inventory (days-of-supply), rank (Top-of-Search impression share).
2. **Resolve effective target ACoS** — `goal preset × profit-native(SKU) × life-stage`.
3. **Module proposals** — each enabled module returns a proposed action (bid Δ, budget Δ, placement Δ, status, harvest/negate ops) using its existing service.
4. **Compose + clamp** — apply guardrails (bid band, budget band, daily-spend cap, ramp cap); resolve conflicts by priority: **safety > rank-defend > bid > budget > placement > harvest/negate**.
5. **Apply or suggest** — `AUTO` applies via the shipped mutation/sync path (write-gated); `SUGGEST` queues `AdsRuleSuggestion`-style proposals; `OFF` no-ops. Churn deadband (±2%) prevents thrash.
6. **Record** — write one `AutopilotDecision` per action (before/after/reason/status + executionId for rollback); emit to the SSE feed.

## 3. Bid algorithm (reuses `bidding-engine`)
```
bid = clamp( AOV · CR_blend · targetACoS · θ_inv · θ_intra , bidMin , bidMax )
```
- `CR_blend` — shrinkage between 7d and 30d CVR; **Bayesian Beta prior** for sparse targets (pool toward ad-group/category mean until enough clicks).
- `θ_inv = 1 − e^(−k·max(0, DoS − d0))` — inventory throttle → 0 near stockout.
- `θ_intra = clamp(1 + γ·(ACoS_target − ACoS_1h)/ACoS_target, 1−δ, 1+δ)` — intraday correction.
- **2% deadband** — no write if the delta is within band (anti-churn).
- **Exploration (auto/broad discovery):** Thompson sampling over candidate search terms — `Beta(orders+α, clicks−orders+β)` — allocate exploratory budget/bid to uncertain-but-promising terms; winners get harvested to exact, proven losers negated. This is the exploration→exploitation engine that makes "AI" better than static rules.

## 4. Goal → module preset matrix
One goal sets every module's parameters (all overridable per-node on the canvas):

| Param | **Launch** | **Profit** | **Balanced** | **Liquidate** | **Defend Rank** |
|---|---|---|---|---|---|
| Bid strategy | Max Impressions | Target ACoS (profit) | Target ACoS | Max Orders | Rank-controller |
| Effective ACoS | loose (~60%) | break-even·(1−marginKeep) | ~40% | high / none | = ACoS cap |
| Ramp aggressiveness | high | low | medium | high | medium |
| Budget posture | grow winners fast | cap losers tight | balanced | high ceiling | hold rank |
| Rank-defend | optional | off / light | defend | off | **core** (target ToS-IS) |
| Harvest / Negate *(delegated → Rule-Setting session's engine; we only set thresholds)* | aggressive | conservative | medium | aggressive | medium |
| Placement | push Top-of-Search | efficiency | balanced | volume | ToS-max |
| Never-pause | ✓ (suppress) | ✓ | ✓ | ✓ | ✓ |

## 5. Guardrails (hard clamps, always enforced)
`targetAcosPct` · `bidMin/bidMax` · `dailyBudgetMin/Max` · `maxDailySpendCents` (across the set) · `rampPct` (max % change per cycle) · **never-pause** (suppress to ~2¢ instead) · existing **write-gate** (env + per-connection + per-campaign + daily counter) · per-plan daily-spend cap · churn deadband. A breach **suppresses + flags**, never silently overspends.

## 6. Data model (new)
```prisma
model AutopilotPlan {
  id              String   @id @default(cuid())
  name            String
  marketplace     String
  productGroupName String?            // ties to the wizard launch
  campaignIds     Json     @default("[]")   // the campaign set under control
  goal            String              // LAUNCH | PROFIT | BALANCED | LIQUIDATE | DEFEND_RANK
  autonomy        String   @default("SUGGEST")  // OFF | SUGGEST | AUTO
  guardrails      Json     @default("{}")  // {targetAcosPct,bidMinCents,bidMaxCents,budgetMinCents,budgetMaxCents,maxDailySpendCents,rampPct,neverPause}
  modules         Json     @default("{}")  // per-module {on, params} (bid/budget/dayparting/rank/harvest/negate/placement)
  graph           Json     @default("{}")  // React Flow {nodes, edges} for canvas persistence
  stage           String   @default("launch")  // life-stage for auto-transitions
  enabled         Boolean  @default(true)
  lastEvaluatedAt DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  createdBy       String?
  @@index([enabled]); @@index([marketplace])
}
model AutopilotDecision {            // live feed + reversible audit
  id          String   @id @default(cuid())
  planId      String
  at          DateTime @default(now())
  cycle       String              // fast | slow | event
  module      String              // bid|budget|dayparting|rank|harvest|negate|placement|safety
  campaignId  String?
  action      String              // BID_RAISE|BID_LOWER|BUDGET_UP|BUDGET_DOWN|HARVEST|NEGATE|PLACEMENT|SUPPRESS|RESUME
  before      Json?
  after       Json?
  reason      String
  status      String              // PROPOSED|APPLIED|SKIPPED|DENIED|ROLLED_BACK
  executionId String?             // → existing audit/sync row for one-click rollback
  @@index([planId, at])
}
```

## 7. Conductor ↔ existing crons (integration) — **OPEN DECISION**
- **(a) Orchestrate directly (proposed):** a new `ad-autopilot.job` cron iterates enabled plans and calls the existing services' pure/apply functions per module, clamped to guardrails, writing `AutopilotDecision`. One brain, one audit trail, easy pause/rollback.
- **(b) Provision primitives:** the Conductor writes `RankTarget` / `AdSchedule` / `AutomationRule` rows from the plan and lets the existing crons run unchanged. Less orchestration code, but AI state is scattered and harder to pause/rollback as a unit.
- **Recommended: hybrid** — **orchestrate (a)** for **bid · budget · placement · dayparting** (we own these). **Provision (b)** for **rank-defend** (Conductor sets a `RankTarget`, lets `ad-rank-defend` run, reads status back) and for **harvest + negate** (Conductor enables/configures the *Rule-Setting* session's automation rule scoped to the plan — it does **not** reimplement it). The Conductor records everything — its own actions and the linked external ones — as `AutopilotDecision`s for one unified feed. Confirm in sign-off.

## 8. The Autopilot Canvas (React Flow)
Node types: **Signal** (perf · profit · inventory · rank) → **Goal** → **Module** nodes (Bid · Budget · Dayparting · Rank · Harvest · Negate · Placement — each tunable, on/off) → **Guardrail** → **Action/Output**. Edges = control/data flow. Editing a node writes `plan.modules`; the React Flow `{nodes,edges}` persist in `plan.graph`. A live overlay animates the edge + pulses the module node when a decision fires (SSE). Compact read-mostly embed in the wizard's AI-Control step; full editable control-room on a dedicated page post-launch.

## 9. End-to-end wiring
`Wizard AI step (goal + guardrails + autonomy + mini-canvas)` → launch `POST …/sp-super-wizard/launch` includes an `aiControl` block → backend creates campaigns **+ `AutopilotPlan`** → `ad-autopilot.job` evaluates the plan each cycle → calls module services within guardrails → writes `AutopilotDecision` + applies via existing mutation/sync (write-gated) → **SSE** streams decisions → canvas/control-room renders them live with **pause / override / rollback**.

## 10. Safety, observability, "perfect algorithms"
- **Autonomy ladder:** OFF → SUGGEST (propose-only, human applies) → AUTO (applies, write-gated). Default **SUGGEST**.
- **Dry-run simulator / backtest:** replay the last 30–60d of hourly data through the conductor to show projected actions + projected ACoS/spend **before** enabling AUTO.
- **Pure, unit-tested controllers:** every module decision function is pure (input → proposed action) and unit-tested (bid math, ramp clamp, guardrail breach, conflict priority, churn deadband, Thompson draw determinism via seeded RNG).
- **Reversibility:** each applied decision carries an `executionId` → one-click rollback via the existing `rollbackByExecutionId`.

## 11. Phases (each testable end-to-end)
- **P-A** — this spec (sign-off).
- **P-B** — `AutopilotPlan` + `AutopilotDecision` models + migration; **Conductor** service + `ad-autopilot.job` (SUGGEST/dry-run only); pure module decision fns + unit tests; backtest simulator.
- **P-C** — Wizard AI-Control step: goal + guardrails + autonomy + mini-canvas; launch payload `aiControl` + plan creation.
- **P-D** — Autopilot Canvas (React Flow) — full control room + wizard embed; node editors write the plan.
- **P-E** — Live decisions (SSE) + pause / override / rollback controls.
- **P-F** — Algorithm hardening: full controller test suite + backtest UI + guardrail proofs; enable AUTO behind the write-gate.
- **P-G** — End-to-end verification: launch → plan → conductor acts (dry-run) → canvas reflects → pause/rollback works.

## 12. Coordination
**Module-ownership boundary (critical):** the *Rule-Setting* session owns the **harvest + negate automation engine**. The Autopilot must **not** build or modify that engine — it only *provisions/configures* their automation rule for the plan's campaigns (goal-appropriate thresholds) and *reads back* their decisions into our canvas/feed. **Bid · budget · placement · rank · dayparting are ours.** Shared touch-points to agree: (1) the harvest/negate rule-config shape we write, (2) a read API/event for their decisions.

**Wizard sharing:** `LaunchStep.tsx` toggle + `SpSuperWizard.tsx` launch payload. AI Control owns the `automationMode === 'ai'` branch and adds the `aiControl` payload block; it must not disturb the rule-setting branch. New code lives in a dedicated `_autopilot/` folder + a new backend service/job to minimize collision.

# Ads Mission Control — Design Spec

- **Date:** 2026-06-30
- **Status:** Draft for review
- **Owner:** Awais
- **Surface:** `/marketing/ads/autopilot` (rebuilt and renamed **Mission Control**)
- **Process:** Program-level design. Built **phase by phase**; each phase gets its own implementation plan + explicit approval + verification before the next. Sandbox-first; live writes stay gated.

---

## 1. Summary / Vision

Rebuild the Autopilot page into **Ads Mission Control**: a Palantir-inspired **operational canvas** where the entire Amazon Ads account is a **living object graph**, **AI agents are objects you compose and wire onto any scope**, every **action is taken directly from the canvas** through the existing safety rails, and the whole system **gets smarter the more data it sees**.

"Palantir-inspired" here means the *information density, object-graph model, and operational power* — **not** a dark theme and **not** the Blueprint component library. It is rendered entirely in our existing **light H10 design system**, image-free, and held to the "never ship a visible defect" bar.

---

## 2. Goals / Non-Goals

**Goals**
- One infinite, zoomable **canvas** that represents the account as an object graph and lets the operator manage everything from there.
- **Composable agents** (not single rules): combine signals (reports) → logic → algorithms → actions → guardrails, with custom expressions for effectively unlimited strategies.
- **Bulk, multi-scope control**: apply an agent (or an action) to a whole market, a whole portfolio, or selected campaigns / ad groups / targets.
- **Rank control** as a first-class capability inside the agent model.
- **Total operator control**: dry-run → simulate/backtest → SUGGEST → AUTO, behind guardrails, approval, blast-radius caps, and a kill-switch.
- **A learning loop**: outcomes feed back so agents and the AI Strategist improve over time.
- Best-in-class: nothing better on the market for an owner-operated Amazon Ads cockpit.

**Non-Goals (this program)**
- Adopting Blueprint or any non-DS UI library (inspiration only).
- Flipping campaigns to live Amazon writes as part of the build (gated/approval-first; go-live is a separate, deliberate operator step).
- Rebuilding the existing ad backend (we reuse and extend it).
- Touching the legacy `/marketing/advertising` and `/marketing/ads-console` surfaces.

---

## 3. Locked Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Canvas scope | **Unified ops graph** — the whole account, not just autopilot plans |
| AI depth | **Agent roster + AI Strategist** (LLM, tool-calling, human-approved) |
| Live writes | **Gated + approval-first**; AUTO only on allowlisted campaigns |
| Aesthetic | **Light H10, image-free, professional** (option B) — DS-based |
| Hierarchy order | **Market → Portfolio → Campaign → Ad Group → Target** (market first) |
| Primary surface | **Infinite React Flow canvas**, with a **Tree/table view toggle** over the same graph |
| Agent shape | **Composed pipeline** (signals → logic → algorithms → actions → guardrails), reusable, versioned |
| Apply model | **Bulk, multi-scope** (market / portfolio / selected campaigns / groups / targets; static + dynamic) |
| Improvement | **Closed learning loop** (outcomes → agents + Strategist get better) |

---

## 4. Object Model (Ontology)

Typed objects + links; the canvas/tree render this graph.

- **Market** (e.g. DE, IT) → **Portfolio** → **Campaign** → **Ad Group** → **Target** (keyword / product / audience).
- Cross-links: **Product/ASIN** ↔ campaigns advertising it; **Search Term** ↔ where it converts/wastes; **Competitor** ↔ SOV/outbid relationships.
- Each node carries live metrics (spend, ACoS, ROAS, **true margin/TACOS**, top-of-search IS, orders, CTR/CVR), a **health/anomaly** state, **report-freshness ("as-of")**, and the **agents governing it**.

**Existing:** `ads-ontology.service.ts` already exposes campaign/adgroup/target with lazy one-level drill-down (sorted by spend). **Gaps:** Market and Portfolio as first-class ontology levels above campaign; Product/SearchTerm/Competitor as linked node types.

---

## 5. The Canvas (UX)

- **Engine:** React Flow (`@xyflow/react`) — already in production as the budget-manager Allocation canvas. Proper anchored bezier edges, pan/zoom, drag, minimap, grouping.
- **Expandable object nodes:** a node's `＋/−` handle spawns/collapses its children (Market → Portfolio → … → Target) as connected child nodes. Arrange freely; **saved layouts** persisted to `AutopilotPlan.graph` (existing Json field) / a new view model.
- **Agents are nodes** you build (open the Composer) and **wire** to objects by drawing an edge. One agent → many objects = bulk scope, shown as wiring.
- **Selection → deep config:** select any node for an inline toolbar (Config / Inspect / Attach agent) + a full **inspector** (DS Drawer) with properties, metrics, governing agents, and the contextual **action menu**.
- **Dual view:** **Canvas** (spatial build/wire) and **Tree/table** (dense bulk-ops at scale) over the same graph — toggle in the header. Tree rows have cascading multi-select checkboxes + a bulk action bar.
- **Command palette (⌘K):** search + natural-language entry to the AI Strategist.
- **Aesthetic:** light H10 tokens, image-free (no product thumbnails/emoji; crisp lucide icons + data only), dense and professional.
- **Reuse:** extract a shared `<OpsCanvas>` from the existing `AutopilotCanvas` `CanvasSpec` abstraction + `AllocationCanvas`, onto DS tokens.

---

## 6. The Agent Model (Composer)

An **Agent** is a named, versioned, composed pipeline:

1. **Scope** — market / portfolio / campaign / ad group / target; static selection **and** dynamic ("every target with ACoS > target over 7d").
2. **Signals (report feeds it studies)** — search-term, placement, advertised-product, SQP (Brand Analytics), daily/hourly performance, n-gram, rank/top-of-search IS, true profit/TACOS, inventory/buy-box. Each signal exposes its **as-of freshness**; agents will not act on stale data.
3. **Logic** — conditions `{field, op, value}` (8 operators: gte/gt/lte/lt/eq/ne/in/contains/exists), AND/OR groups, time windows (7/14/30/60d), branches (if/else), and a **Math/Expression** block (sandboxed DSL) for custom formulas.
4. **Algorithm blocks** (wrap the existing engines as composable, tunable blocks): Target-ACoS bidder, Bayesian smoothing, budget pacer, rank converger, harvest/n-gram miner, dayparting optimizer, anomaly detector.
5. **Actions** (the existing ~30 write-gated handlers as blocks): bid (up/down/apply/to-target/scale/rank-defense/floor), budget (adjust/set/reroute/liquidate), placement bias, add-negative/promote/harvest/archive, pause/resume/retail-guard, target-ACoS set, dayparting, promotions, notify/alert.
6. **Guardrails** — bid floor/ceiling, budget min/max, max daily spend, ramp % / max change per cycle, never-pause, **blast-radius cap**.
7. **Autonomy + cadence** — OFF / SUGGEST / AUTO (per scope); schedule (15-min/hourly/daily) or event-driven (e.g. "when the search-term report refreshes").

Agents are presets too: **mission templates** (Launch / Defend / Liquidate / Profit squads) ship pre-composed.

---

## 7. Bulk, Multi-Scope + Scope Resolver

- An agent (or a one-off action) binds to a **scope set**: whole market, whole portfolio, selected campaigns, selected ad groups, selected targets — or a **dynamic query**.
- **New backend: `scope-resolver`** — resolves a scope spec to the concrete entity set at evaluation time, shows the count ("12 campaigns · 340 targets"), and enforces blast-radius caps. Today scoping is per-entity-grain and static (`AutopilotPlan.campaignIds`); portfolio-level and dynamic scoping are **net-new**.
- **Tree bulk bar** + **canvas multi-select** both feed the same scope-resolver and action-dispatch path.

---

## 8. Rank Control

- First-class **Rank Defender** agent: target rank / top-of-search impression share, defend schedules, rank-trend, bid-bias motion profile.
- **Existing:** `rank-controller.ts`, `ad-rank-defend.job`, `ads-top-of-search.service`, RankTarget/RankScheduleTemplate, `/rank-*` + `/top-of-search` routes. Configurable per-placement, per-schedule, per-product-family.
- **Gap to consider:** per-keyword / per-ad-group rank targets (today it's per-campaign placement-bias) — scoped as a P6 extension.

---

## 9. Control & Safety

- **Ladder:** dry-run → **simulate/backtest** (Δprofit/ΔACoS/Δrank; "would have fired N×, saved €X over 30d") → SUGGEST (proposals in an approval inbox) → AUTO (live, write-gated, allowlisted campaigns only).
- **Existing safety reused:** 4-check write-gate (`NEXUS_AMAZON_ADS_MODE=live` + connection `writesEnabledAt` + per-write value cap + `Campaign.liveBidWritesEnabled` allowlist), per-rule value/daily-spend caps, `OutboundSyncQueue` grace period, full audit, `executionId` rollback, AI kill-switch.
- **New:** **blast-radius preview** before AUTO; **canvas/scope-level rollback**; approval inbox folded onto the canvas.
- **Posture:** gated + approval-first by default (honoring the FBA→FBM flip incident lessons). Go-live is a deliberate, separate operator action with an excellent enable-writes UX (P11).

---

## 10. AI Strategist (LLM)

- A natural-language command bar (⌘K) + a Strategist agent node that **reads the whole graph + reports + agent state**, proposes multi-step plays, and can **draft agents/rules for you** — all human-approved.
- **Built on existing rails:** the Anthropic **tool-use loop** (`tool-loop.service.ts`), the **autonomous-agent registry** + `AgentRun` cost/latency audit, and the **approval-gate** scaffold (whose write-back we complete). Ads action handlers + scope-resolver become Strategist **tools** behind the approval gate.
- Default provider: latest Claude model via the existing model-resolver; degrades to deterministic when unavailable.

---

## 11. Learning Loop ("smarter with more data")

- **Outcome attribution:** every action's measured result (ΔACoS, Δsales, Δrank, Δprofit over an attribution window) is recorded against the decision (`executionId`).
- **New model: `AgentOutcome`** (decision → measured result) feeding: per-agent **win-rate / scorecards**, Bayesian **prior updates** for the bidder, and a Strategist **playbook** of what worked for *this* catalog.
- **Data feeds that compound:** Amazon Marketing Stream (hourly) and the report pipeline keep enriching signals.
- Surfaced on each agent node ("learning · N outcomes · win-rate X%") and in agent scorecards.

---

## 12. Provenance & Time

- **Activity layer:** the existing SSE decision stream (`ads-execution-events`) pulses the objects/agents it touched.
- **Explain a decision:** signal → rule/algorithm → action → result chain for trust.
- **As-of time slider:** replay account state + decisions over time.
- **Audit + rollback** from the canvas at any scope.

---

## 13. Backend Additions vs Reuse

**Net-new (additive):**
- `scope-resolver` service (static + dynamic scope → entity set + blast-radius).
- **Agent-definition model + pipeline interpreter** — stores the composed pipeline (DAG) as JSON; evaluates it by orchestrating existing algorithm services + the 30 action handlers as blocks. (Layer over, do **not** replace, the automation-rule engine.)
- Sandboxed **expression evaluator** for the Math/Expression block.
- Market + Portfolio ontology levels; Product/SearchTerm/Competitor linked node types.
- **Canvas action-dispatch** endpoint (any action, any scope, dry-run param, gated/audited).
- **Decision/scope rollback** endpoint.
- `AgentOutcome` model + outcome-attribution job; agent scorecards.
- Complete the approval-gate **write-back** for mutating Strategist tools.

**Reuse (do not rebuild):** `ads-ontology.service`, the automation-rule engine + 30 action handlers, the autopilot conductor + algorithm services (bid-optimizer/pacing/rank-controller/harvest/ngram), the reports pipeline + report models, `ads-execution-events` SSE, `tool-loop`/`autonomous-agent`/`approval-gate`/`AgentRun`, the write-gate + `OutboundSyncQueue`, `AutopilotPlan.graph`, the React Flow `CanvasSpec` + `AllocationCanvas`.

> Anti-pattern to avoid (per history): do **not** create a second competing rule/automation system. The Agent model is a composition layer **on top of** what exists.

---

## 14. Design System & Tech

- **UI:** React Flow + our design system (primitives/components/patterns) + light H10 tokens. Image-free. New shared `<OpsCanvas>`, node, inspector, composer, and bulk-bar components live in the DS where reusable.
- **No third-party UI kit** — build entirely on our design system. React Flow is the only graph dependency.
- **Verification:** `tsc` both apps; unit tests for the interpreter, scope-resolver, expression evaluator; **screenshot-diff at native resolution** + numeric alignment checks before showing the owner (per the self-verify standard); sandbox-first; verifier cases protect each phase.

---

## 15. Phased Roadmap

Four arcs; each phase ships, is verified, and is approved before the next.

**Arc 0 — Foundation**
- **P0** — Spec + shared `<OpsCanvas>` (React Flow, light H10, image-free); rebuild the page as **Mission Control** shell. *Deliverable judged on a real native screenshot (the fidelity sign-off).*

**Arc A — Observe**
- **P1** — Account object graph (Market→…→Target + Product/SearchTerm/Competitor links); lazy expand/pivot/filter; live metrics + health coloring; inspector; canvas/tree dual view.
- **P2** — Report Intelligence layer (search-term/placement/SQP/n-gram/rank/profit panels) + report-freshness "as-of" indicators.

**Arc B — Control**
- **P3** — Actions from the canvas + **bulk multi-scope selector** + `scope-resolver`; gated/audited/revertible.
- **P4** — **Agent Composer** (signals → logic → algorithms → actions → guardrails + expressions); templates; backtest-before-activate; agent-definition model + interpreter.
- **P5** — **Agents** as nodes + roster + wiring to scope + autonomy dial + conflict "council".
- **P6** — **Rank Control** agent (targets, top-of-search IS, defend schedules) + per-keyword/ad-group extension.

**Arc C — Simulate, reason, prove**
- **P7** — Scenario & simulation (branch, stage, backtest, compare, diff-then-apply commit + grace + rollback).
- **P8** — **AI Strategist** (NL command bar, tool-calling, drafts agents/rules, approval-gate write-back).
- **P9** — Provenance & time (activity layer, explain-decision, as-of replay, scope rollback, agent scorecards) + **learning loop** (`AgentOutcome`, win-rates, Bayesian/playbook).

**Arc D — Breadth & hardening**
- **P10** — Competitive/SOV + anomaly overlays + market map + mission templates.
- **P11** — Perf (graph virtualization), a11y, i18n, kill-switch, enable-writes UX + go-live gating, docs + verifier tests.

---

## 16. Risks & Open Questions

- **Graph scale:** thousands of targets need virtualization (P11) and a strong tree view; canvas shows focused subgraphs, not everything at once.
- **Pipeline interpreter complexity:** keep blocks pure and well-tested; the interpreter orchestrates existing services rather than re-implementing logic.
- **Dynamic scope safety:** dynamic scopes + AUTO must be bounded by blast-radius caps and previewed before activation.
- **AMS/AMC entitlements:** hourly stream + clean-room require Amazon entitlements/infra; learning loop should degrade gracefully without them.
- **Per-keyword rank** is a backend extension beyond today's per-campaign placement-bias (P6).
- **Open:** exact expression DSL surface; how much of the Strategist is allowed to auto-draft vs. only suggest.

---

## 17. References

- External reference repos (Blueprint, amzn/ads-advanced-tools-docs, AmazonFBA) were considered and **set aside** at the owner's direction (2026-06-30). The build relies only on our codebase + React Flow. Amazon Marketing Stream / AMC remain valid *Amazon* features we may use, independent of any external repo.
- Internal: existing ads backend (advertising services/routes), `ads-ontology.service`, automation engine, autopilot conductor, reports pipeline, write-gate, React Flow canvases.

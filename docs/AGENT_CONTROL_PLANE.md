# Agent Control Plane (ACP)

> Canonical spec for Nexus's platform-wide agentic AI layer.
> Status: **Phase 0 (foundation)**. Approved 2026-06-17. Built phase-by-phase; approval before each phase.

## 1. Goal

Turn Nexus's AI from on-demand calls into a **governed agent capability layer**: every page gets contextual AI tailored to its task, **and** autonomous agents run in a synced, systematic way. "AI on every page" (interactive) and "synced autonomous automations" are two faces of *one* thing — the same tool is invoked either on-demand by a person, or autonomously by a background agent, through the same registry, the same model routing (AI-2), and the same guardrails.

**Principle — don't LLM-ify what already works.** The 92 deterministic cron jobs and the rules engine stay rule-based (cheap, fast, reliable). Agents are for judgment-heavy, open-ended, or cross-system tasks. The agent layer *orchestrates and augments* the deterministic backbone; it does not replace it.

## 2. Layers

```
L7  Memory & learning         per-entity/agent memory; eval failures → improvements
L6  Observability & Evals      trace every step + cost + outcome; eval suite; Control Center page
L5  Governed Autonomy          risk tiers; approval queue; budget; kill-switch; audit; idempotency; dry-run
L4  Per-page AI Surface         declarative: capabilities, model, autonomy tier, prompts
L3  Triggers                    on-demand (page) │ events (rules engine + SSE) │ schedule (cron-registry)
L2  Agent Runtime               interactive tool-loop + autonomous BullMQ workers + Managed Agents (heavy)
L1  Capability / Tool Registry  MCP-shaped, typed, permissioned — ONE definition, reused everywhere
L0  AI-2 Foundation             model routing • budget • kill-switch • usage audit            [SHIPPED]
```

We **reuse** existing substrate: `cron-registry` (92 jobs), the tree rules engine (`services/automation/conditions-tree.ts`), BullMQ workers, the SSE event bus, OutboundSyncQueue, and AI-2 (`services/ai/*`).

## 3. Governed Autonomy — the heart of the policy

Every tool carries a **risk tier**. The tier decides what happens when an agent (or copilot) wants to invoke it:

| Tier | Examples | Behaviour |
|---|---|---|
| **low** | read data, draft/suggest content, flag a gap, fix missing alt-text | Runs automatically; logged. |
| **medium** | edit a draft, re-tag, non-fiscal data change, queue a non-live job | Runs automatically; logged + operator notified. |
| **high** | **pricing change, channel publish, customer communication, spend, regulated/fiscal data, bulk live mutations** | **Always routes to the approval queue** with a dry-run preview; a human approves before execution. Never auto-runs. |

The **always-ask list** (pricing · publishing · customer comms · spend · regulated/fiscal data) is a hard floor — these are `high` regardless of agent confidence. This satisfies the EU AI Act (Aug 2026) human-oversight requirement for high-risk decisions.

Per-agent **autonomy tier** caps what an agent may do: `suggest` (never acts) < `low` < `medium` < `high`. An agent can never exceed its cap *or* a tool's tier — the stricter wins.

Additional guardrails: per-agent + global **budget** (on top of AI-2), the **kill-switch** (`NEXUS_AI_KILL_SWITCH` halts everything), **idempotency keys** + dedup (no double-publishing), **rate limits**, **dry-run-first** for mutations, and full **audit** (every run + every tool call + every approval is persisted).

## 4. Tool / capability registry (L1)

Tools are **code-first**: a typed function + JSON-schema input + handler, registered in a code registry (MCP-shaped so it can later be exposed as an MCP server). Each tool declares a default risk tier and required permissions. A DB row (`AgentTool`) holds the **operator-editable policy** for each tool — risk-tier override, enabled, requires-approval, rate-limit, budget — keyed by tool name (same pattern as `AiFeatureModelPref`). The code is the source of truth for *what a tool does*; the DB is the source of truth for *whether/how it may run*.

Tools act as a **scoped principal** (least privilege), not god-mode — an agent only sees the tools its definition grants.

## 5. Data model (Phase 0)

Five additive tables (ship empty, fill per phase):

- **`AgentDefinition`** — a configured agent: kind (interactive/autonomous), surface (page), tools, model-feature (AI-2), autonomy tier, system prompt, trigger (on-demand/event/schedule), enabled.
- **`AgentRun`** — one execution (or copilot turn): trigger, status, entity acted on, input/output, **step trace**, tokens/cost/model, outcome, who triggered. The observability + audit spine.
- **`AgentTool`** — per-tool operator policy (risk tier, enabled, requires-approval, rate-limit, budget).
- **`AgentApproval`** — a pending high-stakes action: run, tool, args, dry-run preview, status, decided-by. The governed-autonomy gate.
- **`AgentMemory`** — per-agent/per-entity memory for continuity + learning.

(Full Prisma definitions live in `packages/database/prisma/schema.prisma` under the `ACP` section.)

## 6. Conventions

- Series tag: **ACP** (ACP.0, ACP.1, …) matching the phase numbers.
- Everything ships **dark** (`enabled=false`) and is turned on per-phase after testing on prod.
- Naming: `Agent*` models; tool names are stable kebab-case ids; agent keys are stable kebab-case ids.

## 7. Phase map

| Phase | Delivers |
|---|---|
| **0** | This doc + schema + one thin vertical slice on /products (registry → runtime → AI-2 → audit) |
| 1 | Capability/Tool registry — 15–25 high-value platform actions as typed, permissioned tools |
| 2 | Interactive copilot v1 (read-only) on /products |
| 3 | Governed actions — copilot acts via tools behind risk-tiered approval + dry-run |
| 4 | Autonomous agents v1 (Listing-Quality Keeper, Pricing Watchdog) on BullMQ/cron |
| 5 | Observability, evals & operator Control Center |
| 6 | Memory + multi-agent orchestration |
| 7 | Scale to every page; Managed-Agents for heavy; expose registry as an MCP server |

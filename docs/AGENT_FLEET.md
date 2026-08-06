# NEXUS AGENT FLEET (NAF) — Master Brief for Claude Code

> **Series tag:** `NAF`
> **Status:** Specification. Nothing below is built yet.
> **Audience:** Claude Code, working inside `github.com/awaissulhry/nexus-commerce`.
> **Approval model:** Phase-by-phase. Written spec approved before implementation. Do not start Phase N+1 without explicit approval.

---

## PART 0 — How to use this document

This is not a single prompt. It is the **canonical spec** for a multi-phase build.

**Workflow per phase:**

1. Paste **Part 0 + Part 1 + Part 2 + Part 3** (the invariants) plus **the single phase section** you are executing.
2. Claude Code writes an implementation plan into `docs/YYYY-MM-DD-naf-<phase>.md` following the existing house format (see `docs/superpowers/plans/*.md` for the checkbox/TDD style already in use).
3. Operator reviews and approves the plan.
4. Claude Code implements task-by-task, committing per task with explicit paths (`git commit <paths>` — the working tree carries unrelated WIP).
5. Gate: `npx tsc --noEmit`, vitest green, `npm run check:drift`, `npm run tokens:check`, `.githooks/pre-push` passes.

**Recommended invocation:** `claude --model opus --permission-mode acceptEdits` for Phases A, C, G, H (architecture-heavy). `--model sonnet` for the rest.

---

## PART 1 — Verified repo state (read this before proposing anything)

These facts were established by reading the repository. Do **not** re-derive them; do **not** contradict them.

### 1.1 Shape

| Thing | Reality |
|---|---|
| Monorepo | npm workspaces + turbo. `apps/api`, `apps/web`, `apps/factory`, `packages/database`, `packages/shared`, `services/bidding-engine` |
| API | Fastify, TypeScript ESM, ~1,400 `.ts` files under `apps/api/src` |
| Web | Next.js App Router, ~1,500 `.tsx` files |
| DB | Prisma + Postgres (Neon). **375 models**, 15,396-line `schema.prisma` |
| Queue | BullMQ + Upstash Redis. Workers in `apps/api/src/workers/` |
| Cron | `apps/api/src/jobs/cron-registry.ts` — ~100 registered jobs, manual-trigger endpoint, `CronRun` history |
| Deploy | Vercel (web), Railway (api) |
| Node | >= 22.12 |

### 1.2 The Agent Control Plane already exists (partially)

`docs/AGENT_CONTROL_PLANE.md` is the approved spec (2026-06-17). Phases 0–5a are **built**:

```
apps/api/src/services/agents/
├── agent-runtime.service.ts      runAgent() · runChat() · invokeTool()
├── tool-loop.service.ts          Anthropic tool-use loop, step-capped
├── tool-registry.ts              aggregates the 4 tool files
├── tool-types.ts                 AgentTool · RiskTier · ToolResult
├── tool-policy.service.ts        code default ⊕ DB override, alwaysAsk hard floor
├── approval-gate.service.ts      dry-run → AgentApproval → atomic claim → execute
├── autonomous-agent.service.ts   scheduled scan→propose runtime + Control Center overview
├── autonomous/
│   ├── listing-quality-keeper.ts
│   └── pricing-watchdog.ts
└── tools/  read · analytics · draft · mutate   (21 tools)
```

Existing tools: `product-snapshot`, `product-search`, `order-search`, `order-detail`, `stock-levels`, `price-status`, `listing-health`, `product-analytics`, `channel-stock-drift`, `replenishment-forecast`, `insights-metric`, `detect-anomalies`, `draft-alt-text`, `draft-listing-content`, `draft-seo`, `translate-content`, `draft-customer-message`, `set-price`, `publish-listing`, `send-customer-message`, `apply-content`.

Existing Prisma models: `AgentDefinition`, `AgentRun`, `AgentTool`, `AgentApproval`, `AgentMemory`.

Routes: `apps/api/src/routes/agents.routes.ts` — `/agent/run`, `/agent/chat`, `/agent/runs`, `/agent/tools`, approvals, autonomous overview.

UI: `apps/web/src/app/settings/ai/AiAgentsClient.tsx` (thin).

**What is missing:** L4 (declarative per-surface config), real L6 (evals + Control Room), L7 (memory/learning + multi-agent orchestration), MCP exposure. Those are what this brief builds.

### 1.3 The advertising domain is already an expert system

This is the single most important fact in this document. `apps/api/src/services/advertising/` holds **~170 services**; `apps/api/src/services/ads-core/` holds ~40 more. A partial census:

**Ingestion & truth:** `ads-reports.service`, `report-task-pipeline`, `ads-metrics-ingest`, `ams-daily` / `ams-dataset` (Marketing Stream), `ads-hourly.service`, `sqp.service`, `ads-tos-is-ingest`, `ads-impression-share`, `fba-fees-ingest`, `fba-storage-age-ingest`, `data-kiosk.service`, `ads-report-gapfill`, `ads-reporting-coverage`, `data-vintage`.

**Intelligence:** `ads-ngram`, `ads-harvest` / `ads-auto-harvest`, `ads-keyword-funnel`, `ads-keyword-contests`, `ads-bayesian-bidding` (sparse-data smoothing), `ads-target-acos` (profit-native per-SKU), `ads-incrementality`, `ads-foresight`, `ads-momentum`, `ads-dayparting-intel`, `rank-controller`, `rank-self-competition`, `ads-coverage-engine`, `ads-placement-math`, `ads-position-weight`, `true-profit-rollup`, `profit-coverage`, `ads-graduation`, `ads-top-of-search`, `ads-audience`, `ads-dsp`, `keyword-conflicts`.

**Actuation & safety:** `ads-mutation.service`, `ads-write-gate.ts` (env flag → connection mode → value cap → campaign allowlist → daily cap → entity bid bounds → protected keywords → halt state → authority pins), `blast-radius-guard.ts`, `ads-guardrails`, `ads-anomaly-guard`, `rollback.service`, `ads-changes`, `ads-write-reconcile`, `ads-sync-integrity`, `quota-ledger`, `ads-authority-pins`, `ads-bid-suppression`, `ads-budget-enforce`.

**Governance:** `ads-autonomy.ts` — the `OFF | OBSERVE | PROPOSE | AUTO` intensity dial, already wired into `AutomationRule.autonomyLevel`; `AdsRuleSuggestion` (propose-only inbox with dedup key); `AutomationRule` with `maxExecutionsPerDay`, `maxValueCentsEur`, `maxDailyAdSpendCentsEur`, `scopeMarketplace`, `scopePortfolioId`, `scopeCampaignId`.

**Autopilot:** `advertising/autopilot/{conductor,coordination,modules,presets,backtest,apply}.ts` — a simulate-first, glass-box orchestrator that already composes bid optimisation + ToS defence into one plain-language plan.

**Ontology:** `ads-ontology.service.ts` (market → campaign → adgroup → target, lazy children) + `apps/web/src/app/marketing/ads/_canvas/` (React Flow account graph).

**UI:** `/marketing/ads/*` (20+ sections incl. `rules-automation`, `rules-automation/control-room`, `autopilot`, `blueprints`, `budget-manager`, `recommendations`, `trust`, `health`) and `/marketing/ads-console/*` (Amazon-console replica with its own `automation` hub).

**Cron (ads):** `ad-autopilot`, `ad-budget-enforce`, `ad-budget-schedule`, `ad-dayparting`, `ad-rank-defend`, `ads-anomaly-guard`, `ads-auto-bid`, `ads-auto-harvest`, `ads-metrics-reconcile`, `ads-structural-reconcile`, `ads-report-schedule`, `ads-tos-defense`, `ads-tos-is-ingest`, `advertising-rule-evaluator`, `ams-sqs-poll`, plus the eBay mirror set.

### 1.4 Design system has machine-checkable law

`apps/web/src/design-system/` with `tools/token-guard.mjs` (raw hex / raw ramp / raw Tailwind palette detection), `tools/api-guard.mjs`, `tools/generate-tokens-css.ts`, plus `catalog/`, `patterns/`, `primitives/`, `studies/`. `npm run tokens:check` is already a gate. This matters for Phase I.

### 1.5 Prior research already in-repo — do not redo it

`docs/2026-08-04-competitor-deep-dives.md` (615 lines: Pacvue, Rithum, Perpetua, Teikametrics, Intentwise, BidX), `docs/2026-08-04-ads-market-research.md`, `docs/2026-08-04-autonomy-study-and-plan.md`, `docs/2026-08-03-ads-autonomy-domination-adx.md`, `docs/2026-08-05-ads-control-room-coverage-acr.md`. Read them; cite them; do not re-research their contents.

---

## PART 2 — Design law (non-negotiable)

These are invariants. A phase that violates one is rejected regardless of how well it works.

### L1 — Code does the math. The model does the judgment.

The 170 advertising services **are the domain model**. An agent must never recompute ACOS, n-gram frequency, Bayesian posterior, break-even bid, impression share, or placement multiplier in a prompt. It calls the service, receives structured evidence, and reasons about *which lever, how hard, and whether now*.

Pacvue's CPO stated publicly that general-purpose LLMs cannot handle commerce-media complexity — which is why they trained a domain-specific model. Nexus's answer to the same problem is different and cheaper: the determinism is already written in TypeScript, and it is auditable in a way a fine-tune never is.

**Test:** if an agent's prompt contains numbers the model has to arithmetic over, the design is wrong. Precompute in SQL/TS, pass conclusions.

### L2 — Agents get zero new write paths.

Every mutation an agent proposes travels the existing chain:

```
Agent → AgentFinding → Plan → Critic → approval-gate.service
      → AgentApproval (dry-run preview persisted)
      → operator decision
      → tool.execute()
      → ads-mutation.service → ads-write-gate.ts → OutboundSyncQueue → ads-sync.worker
```

`ads-write-gate.ts` is the hard floor. Do not add a bypass, a "trusted agent" flag, or a fast path. The `alwaysAsk` tier in `tool-types.ts` is likewise immutable by policy.

### L3 — No agent may spawn an agent.

Fan-out is declared statically in the fleet graph and executed by one orchestrator. Recursive spawning is the documented failure mode that turns a 15× token multiplier into 150×. The orchestrator is the only thing that starts agents.

### L4 — Every agent output is schema-validated JSON.

Zod schema per artifact type. Validation failure = run failed, nothing enters the blackboard. Free text is permitted only inside a `rationale` string field, and `rationale` is never parsed by code.

### L5 — Ship dark, promote by evidence.

Every agent is born `OFF`. It reaches `OBSERVE` on merge, `PROPOSE` only after passing a backtest gate, `AUTO` only after a track record plus explicit operator sign-off per agent per marketplace. Reuse `ads-autonomy.ts` verbatim — do not invent a second dial.

### L6 — One trace, one cost line, one undo, per decision.

Every agent step lands on `AgentRun` / `AgentStep` with OpenTelemetry GenAI-shaped attributes. Every euro is attributed to an agent. Every applied action carries a rollback snapshot via `rollback.service`.

### L7 — The blackboard, not the mailbox.

Agents never message each other. They read and write typed rows in a shared working memory. This is what makes forty agents observable instead of a chat swarm you cannot debug.

### L8 — Determinism first, always.

Before adding an agent, ask: can a rule in `AutomationRule` do this? If yes, write the rule. Agents are for judgment under ambiguity, cross-domain synthesis, and open-ended diagnosis. `docs/AGENT_CONTROL_PLANE.md` already states this ("don't LLM-ify what already works"); it is restated here because fleet-building is exactly when it gets forgotten.

### L9 — Provider-agnostic from line one.

No agent code imports an Anthropic SDK directly. Everything routes through `services/ai/model-resolver.service.ts` + `services/ai/providers/`. Adding a local OpenAI-compatible provider must be a config change, never a refactor.

### L10 — EU AI Act posture.

Pricing, publishing, customer communication, spend, and fiscal data remain `alwaysAsk`. Human oversight on high-risk decisions is a legal requirement, not a preference. Audit trail must reconstruct: what the agent saw, what it proposed, who approved, what was written, what changed.

---

## PART 3 — Architecture

### 3.1 The five tiers

```
┌───────────────────────────────────────────────────────────────────┐
│ T4  AUDITOR & REPORTER          cheap · daily                     │
│     outcome attribution · agent grading · operator brief          │
├───────────────────────────────────────────────────────────────────┤
│ T3  CHIEF STRATEGIST            frontier · weekly + on-demand     │
│     north star · change budget allocation · cross-domain conflict │
├───────────────────────────────────────────────────────────────────┤
│ T2  DOMAIN DIRECTORS            mid · daily                       │
│     amazon-ads · ebay-ads · catalog · pricing · inventory · ops   │
│     deconflict findings → ranked Plan within change budget        │
│                          ▲                                        │
│                          │  CRITIC (adversarial, different model) │
├───────────────────────────────────────────────────────────────────┤
│ T1  ANALYSTS  (~25)             cheap · high volume · narrow      │
│     one lever each · fixed pipeline · emit Finding                │
├───────────────────────────────────────────────────────────────────┤
│ T0  DETERMINISTIC SUBSTRATE     free · already built              │
│     170 ads services · rules engine · ~100 cron jobs · guards     │
└───────────────────────────────────────────────────────────────────┘
```

**Why this shape and not a flat swarm:** Anthropic's published measurement puts multi-agent token use at roughly 15× a chat turn, with token volume explaining ~80% of performance variance. That multiplier is only worth paying where the task genuinely decomposes into independent directions. Analyst work does (twenty levers, twenty independent evidence sets). Strategy does not (it is a single integrative judgment) — so it runs once a week, not once an hour.

The cost profile that follows:

| Tier | Runs/day | Model class | Share of token spend |
|---|---|---|---|
| T1 Analysts | 25–200 | cheap / cacheable / batchable | ~70% |
| T2 Directors | 6–12 | mid | ~18% |
| Critic | 6–12 | mid, *different vendor* | ~8% |
| T3 Strategist | 0.15 (weekly) | frontier | ~3% |
| T4 Auditor | 1–2 | cheap | ~1% |

### 3.2 The blackboard

One typed, versioned, entity-keyed working memory. Four artifact types:

- **`Observation`** — raw structured evidence pulled from T0. Cached, deduped, TTL'd. Not LLM output.
- **`Finding`** — an analyst's conclusion: what it sees, confidence, evidence refs, proposed action, expected effect, expiry.
- **`Plan`** — a director's ranked, deconflicted, budget-bounded set of findings promoted to intended actions.
- **`Strategy`** — the strategist's period constraints that bind everyone below.

Analysts read Observations and write Findings. Directors read Findings and write Plans. The Critic annotates Plans. The gate consumes Plans. The Auditor reads everything and writes grades.

Nothing is passed as a chat transcript. Every handoff is a condensed artifact — this is what keeps the multiplier at 15× instead of 50×.

### 3.3 The fleet graph

A statically declared DAG in code:

```ts
// apps/api/src/services/agent-fleet/graph/fleet-graph.ts
export const FLEET_GRAPH: FleetGraph = {
  nodes: [ /* one per charter key */ ],
  edges: [ /* { from, to, artifact: 'finding' | 'plan' | 'strategy' } */ ],
}
```

The orchestrator topologically sorts, runs each level with bounded concurrency, and short-circuits on budget/halt. The same structure feeds the Control Room visualisation — one source of truth for "how it functions", which is exactly the control you asked for.

**Do not adopt LangGraph, Temporal, CrewAI, Mastra, or the OpenAI Agents SDK for this.** Rationale, stated once so it is not relitigated:

- The durability those frameworks sell you already exists here: BullMQ with retries, `CronRun`, `OutboundSyncQueue`, `AgentRun` step traces, Postgres transactions.
- LangGraph's centre of gravity is Python; LangGraph.js trails it. Adding it means a second state store and a second place where "what the agent did" lives — the exact opposite of the auditability requirement.
- Temporal is a genuinely good fit for hour-long multi-service workflows. Nexus's agent runs are seconds to minutes. It would be infrastructure without a matching problem.
- The fleet graph + orchestrator is ~600 lines of TypeScript you own, test with vitest, and can read in one sitting.

Revisit only if a single agent run needs to survive process restarts across hours. It will not.

### 3.4 Run modes

| Mode | Trigger | Scope | Typical cost |
|---|---|---|---|
| `tick` | cron, hourly | one analyst, one marketplace | cents |
| `sweep` | cron, nightly | all analysts, all marketplaces, batch API | low |
| `council` | cron, daily 06:00 | analysts → director → critic → plan | moderate |
| `summit` | cron, Monday | full fleet + strategist | highest, weekly |
| `incident` | anomaly-guard fires | triage analyst → director → critic, fast path | moderate |
| `ask` | operator, on-demand | strategist or a named agent, interactive | variable |

---

## PART 4 — Data model

Additive only. Ship empty. Follow the existing `Agent*` naming and the DEVELOPMENT.md migration rule (commit `schema.prisma` **and** the migration folder together).

```prisma
/// NAF.A — a versioned agent charter. The charter IS the agent: prompt,
/// scope, tools, budget, cadence, caps. Versioned so a behaviour change is
/// a diff, and a regression is a revert.
model AgentCharter {
  id              String   @id @default(cuid())
  key             String   // stable kebab-case, e.g. "amazon-negative-miner"
  version         Int      @default(1)
  tier            String   // analyst | director | strategist | critic | auditor
  domain          String   // amazon-ads | ebay-ads | catalog | pricing | inventory | ops | design
  name            String
  description     String?

  systemPrompt    String   @db.Text
  outputSchemaKey String              // registry key for the Zod schema
  toolNames       String[] @default([])
  observationKeys String[] @default([])  // T0 evidence builders it may call

  modelFeature    String              // AI-2 feature key → model-resolver
  fallbackFeature String?             // used when primary is over budget / down

  autonomyLevel   String   @default("OFF")   // OFF | OBSERVE | PROPOSE | AUTO
  autonomyCap     String   @default("PROPOSE") // ceiling; operator cannot exceed

  cadence         String?             // cron expr, null = orchestrated only
  scopeMarketplaces String[] @default([])
  scopePortfolioIds String[] @default([])
  scopeCampaignIds  String[] @default([])

  maxFindingsPerRun     Int     @default(20)
  maxToolCallsPerRun    Int     @default(12)
  maxTokensPerRun       Int     @default(60000)
  dailyBudgetUSD        Decimal @default(1.00) @db.Decimal(12, 6)
  maxProposedValueCents Int?    // hard ceiling on any single proposal

  enabled     Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String?
  supersededBy String?

  @@unique([key, version])
  @@index([tier, domain, enabled])
}

/// NAF.A — precomputed deterministic evidence. NOT model output.
model AgentObservation {
  id          String   @id @default(cuid())
  key         String   // e.g. "ngram-waste:DE:last14d"
  entityType  String?
  entityId    String?
  marketplace String?
  payload     Json
  dataVintage DateTime // freshness of the UNDERLYING data, not of this row
  computedAt  DateTime @default(now())
  expiresAt   DateTime
  costUSD     Decimal  @default(0) @db.Decimal(12, 6)

  @@unique([key, entityType, entityId, marketplace])
  @@index([expiresAt])
}

/// NAF.B — an analyst's conclusion. The atom of the whole system.
model AgentFinding {
  id           String   @id @default(cuid())
  runId        String
  charterKey   String
  charterVersion Int
  domain       String
  marketplace  String?

  entityType   String   // CAMPAIGN | AD_GROUP | AD_TARGET | SEARCH_TERM | PRODUCT | ASIN | ACCOUNT | COMPONENT
  entityId     String
  entityName   String?

  kind         String   // waste_term | harvest_candidate | bid_below_target | budget_capped | ...
  severity     String   // info | low | medium | high | critical
  confidence   Decimal  @db.Decimal(4, 3) // 0.000–1.000

  observation  Json     // what it saw (structured)
  evidenceRefs String[] @default([])      // AgentObservation ids
  dataVintage  DateTime

  proposedTool String?  // registry tool name
  proposedArgs Json?
  expectedEffect Json?  // { metric, direction, magnitudePct, horizonDays, basis }
  rationale    String   @db.Text          // never parsed by code

  status       String   @default("open")  // open | promoted | superseded | expired | dismissed
  dedupeKey    String
  expiresAt    DateTime

  planId       String?
  createdAt    DateTime @default(now())

  @@unique([charterKey, entityType, entityId, dedupeKey], map: "AgentFinding_dedupe")
  @@index([domain, status, createdAt])
  @@index([entityType, entityId])
  @@index([planId])
}

/// NAF.C — a director's ranked, deconflicted, budget-bounded intent.
model AgentPlan {
  id            String   @id @default(cuid())
  runId         String
  charterKey    String
  domain        String
  marketplace   String?
  strategyId    String?

  horizon       String   // today | week
  headline      String
  narrative     String   @db.Text

  items         Json     // ordered [{ findingId, rank, tool, args, expectedEffect, dependsOn[] }]
  droppedItems  Json     // [{ findingId, reason }] — why NOT is as important as why
  conflicts     Json     // [{ findingIds[], resolution }]

  changeBudget  Json     // { entities, valueCents, used }
  blastRadius   Json     // computed via blast-radius-guard.ts

  criticVerdict String?  // pass | revise | block
  criticNotes   Json?

  status        String   @default("draft") // draft | critiqued | queued | partial | executed | rejected | expired
  approvalIds   String[] @default([])

  createdAt     DateTime @default(now())
  decidedAt     DateTime?

  @@index([domain, status, createdAt])
}

/// NAF.G — the strategist's period constraints. Binds every tier below.
model AgentStrategy {
  id            String   @id @default(cuid())
  runId         String
  periodStart   DateTime
  periodEnd     DateTime

  northStar     String   // profit | balanced | growth | launch | liquidate
  narrative     String   @db.Text
  objectives    Json     // [{ id, statement, metric, target, marketplaces[] }]
  constraints   Json     // [{ scope, rule, reason }] — hard rules directors must obey
  allocations   Json     // per-domain change budget
  watchlist     Json     // entities under special attention

  status        String   @default("active") // draft | active | superseded
  approvedBy    String?
  approvedAt    DateTime?
  createdAt     DateTime @default(now())

  @@index([status, periodStart])
}

/// NAF.A — one step inside an AgentRun. OTel GenAI-shaped.
model AgentStep {
  id           String   @id @default(cuid())
  agentRunId   String
  seq          Int
  type         String   // observation | model | tool | validation | critic | gate
  name         String
  spanId       String?
  parentSpanId String?
  input        Json?
  output       Json?
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  cachedTokens Int      @default(0)
  costUSD      Decimal  @default(0) @db.Decimal(12, 6)
  latencyMs    Int?
  ok           Boolean  @default(true)
  errorMessage String?
  createdAt    DateTime @default(now())

  @@unique([agentRunId, seq])
  @@index([agentRunId])
}

/// NAF.E — the learning loop. An operator decision is a labelled datapoint.
model AgentExemplar {
  id           String   @id @default(cuid())
  charterKey   String
  label        String   // accepted | rejected | corrected
  situation    Json     // condensed observation snapshot
  proposal     Json
  operatorNote String?  @db.Text
  correctedArgs Json?
  embedding    Unsupported("vector(1536)")?  // only if pgvector present; else null
  weight       Decimal  @default(1.0) @db.Decimal(5, 2)
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())

  @@index([charterKey, label, active])
}

/// NAF.E — per-agent scorecard, recomputed nightly by the Auditor.
model AgentScorecard {
  id                 String   @id @default(cuid())
  charterKey         String
  periodStart        DateTime
  periodEnd          DateTime

  findings           Int      @default(0)
  promoted           Int      @default(0)
  approved           Int      @default(0)
  rejected           Int      @default(0)
  executed           Int      @default(0)
  rolledBack         Int      @default(0)

  acceptanceRate     Decimal? @db.Decimal(5, 4)
  calibrationError   Decimal? @db.Decimal(6, 4) // |stated confidence − realised hit rate|
  realisedImpactCents Int?                       // attributed € effect
  shadowAgreement    Decimal? @db.Decimal(5, 4) // OBSERVE-mode agreement with actual outcomes
  costUSD            Decimal  @default(0) @db.Decimal(12, 6)
  costPerAcceptedAction Decimal? @db.Decimal(12, 6)

  grade              String?  // A | B | C | D | F
  promotionEligible  Boolean  @default(false)

  @@unique([charterKey, periodStart, periodEnd])
  @@index([charterKey, periodEnd])
}

/// NAF.H — typed commerce entity graph (Phase H). Postgres, not Neo4j.
model GraphEdge {
  id           String   @id @default(cuid())
  fromType     String
  fromId       String
  toType       String
  toId         String
  relation     String   // TARGETS | HARVESTED_FROM | NEGATED_IN | COMPETES_WITH
                        // | CANNIBALIZES | SHARES_INVENTORY | VARIANT_OF
                        // | PROMOTED_BY | RANKS_FOR | SUPPRESSED_BY
  weight       Decimal? @db.Decimal(10, 4)
  properties   Json?
  source       String   // derived | observed | operator
  validFrom    DateTime @default(now())
  validTo      DateTime?

  @@unique([fromType, fromId, toType, toId, relation], map: "GraphEdge_unique")
  @@index([fromType, fromId, relation])
  @@index([toType, toId, relation])
  @@index([relation, validTo])
}
```

Extend `AgentRun` additively: `charterKey`, `charterVersion`, `mode` (`tick|sweep|council|summit|incident|ask`), `parentRunId`, `orchestrationId`, `findingCount`, `haltedReason`.

---

## PART 5 — Contracts

Zod, in `packages/shared`, so API and web share them.

```ts
// packages/shared/src/agent-fleet/contracts.ts

export const ExpectedEffect = z.object({
  metric: z.enum(['acos','tacos','spend','sales','clicks','impressions',
                  'conversion_rate','rank','impression_share','profit','units']),
  direction: z.enum(['increase','decrease','hold']),
  magnitudePct: z.number().min(0).max(500),
  horizonDays: z.number().int().min(1).max(90),
  basis: z.string().min(8),          // WHY this number — cite the deterministic source
  counterfactual: z.string().optional(), // what happens if we do nothing
})

export const Finding = z.object({
  entityType: z.enum(['CAMPAIGN','AD_GROUP','AD_TARGET','SEARCH_TERM',
                      'PRODUCT','ASIN','PORTFOLIO','ACCOUNT','COMPONENT','ROUTE']),
  entityId: z.string().min(1),
  entityName: z.string().optional(),
  kind: z.string().min(3),
  severity: z.enum(['info','low','medium','high','critical']),
  confidence: z.number().min(0).max(1),
  observation: z.record(z.unknown()),
  evidenceRefs: z.array(z.string()).min(1),   // ← at least one. No evidence, no finding.
  dataVintage: z.string().datetime(),
  proposedTool: z.string().optional(),
  proposedArgs: z.record(z.unknown()).optional(),
  expectedEffect: ExpectedEffect.optional(),
  rationale: z.string().min(20).max(1200),
  dedupeKey: z.string().min(3),
  expiresInHours: z.number().int().min(1).max(720),
})

export const AnalystOutput = z.object({
  findings: z.array(Finding).max(50),
  scanned: z.number().int(),
  skipped: z.array(z.object({ entityId: z.string(), reason: z.string() })).optional(),
  notes: z.string().max(600).optional(),
})

export const PlanItem = z.object({
  findingId: z.string(),
  rank: z.number().int().min(1),
  tool: z.string(),
  args: z.record(z.unknown()),
  expectedEffect: ExpectedEffect,
  dependsOn: z.array(z.string()).default([]),
  reversible: z.boolean(),
})

export const DirectorOutput = z.object({
  headline: z.string().max(140),
  narrative: z.string().min(50).max(3000),
  items: z.array(PlanItem).max(60),
  dropped: z.array(z.object({ findingId: z.string(), reason: z.string().min(10) })),
  conflicts: z.array(z.object({
    findingIds: z.array(z.string()).min(2),
    kind: z.enum(['same_entity','opposing_direction','budget_contention',
                  'self_competition','protected_scope']),
    resolution: z.string().min(10),
  })),
  changeBudgetUsed: z.object({ entities: z.number().int(), valueCents: z.number().int() }),
})

export const CriticOutput = z.object({
  verdict: z.enum(['pass','revise','block']),
  checks: z.array(z.object({
    check: z.enum([
      'evidence_sufficient','data_fresh','no_contradiction_with_recent_change',
      'no_double_counting','blast_radius_ok','respects_pins','respects_protected_terms',
      'respects_strategy_constraints','effect_estimate_plausible','reversible',
      'no_self_competition','inventory_supports_spend',
    ]),
    result: z.enum(['pass','fail','n/a']),
    note: z.string().optional(),
    offendingItems: z.array(z.string()).default([]),
  })),
  blockedItems: z.array(z.string()).default([]),
  summary: z.string().max(1500),
})
```

**Enforcement:** the runtime validates before persisting. On failure it retries once with the Zod error appended to the prompt, then fails the run. It never coerces, never partially accepts.

---

## PART 6 — Agent roster

Build in the order given. Do not build all of them at once.

### Tier 1 — Analysts (Amazon Ads)

| Key | Levers | Deterministic sources it reads |
|---|---|---|
| `amazon-negative-miner` | negative keywords/ASINs | `ads-ngram`, `ads-negative-kw`, `sqp.service`, `keyword-conflicts` |
| `amazon-keyword-harvester` | promote search terms to exact | `ads-harvest`, `ads-auto-harvest`, `ads-keyword-funnel`, `ads-graduation-readiness` |
| `amazon-bid-tuner` | keyword/target bids | `ads-bid-optimizer`, `ads-bayesian-bidding`, `ads-target-acos`, `ads-bid-suggest` |
| `amazon-budget-pacer` | daily budgets, pool rebalance | `ads-budget-pacing`, `ads-budget-manager`, `budget-pool-rebalancer` |
| `amazon-placement-tuner` | placement multipliers | `ads-placement-math`, `ads-position-weight`, `ads-top-of-search` |
| `amazon-dayparting-planner` | hour/day windows | `ads-dayparting-intel`, `ads-hourly`, `orders-dayparting`, `next24` |
| `amazon-rank-defender` | ToS defence, rank goals | `rank-controller`, `ads-tos-is-ingest`, `ads-impression-share` |
| `amazon-structure-auditor` | campaign/ad-group hygiene | `ads-dedupe-campaigns`, `ads-coverage-engine`, `ads-blueprint`, `ads-eligibility` |
| `amazon-sov-analyst` | share of voice, defend vs expand | `ads-impression-share`, `ads-keyword-contests`, `ads-coverage-sets` |
| `amazon-product-targeting-analyst` | ASIN/category targets | `ads-audience`, `ads-suggestions`, `ads-ontology` |
| `amazon-sb-sd-analyst` | Sponsored Brands / Display | `ads-brand-metrics`, `ads-dsp`, `ads-sb-keyword-reconcile` |
| `amazon-anomaly-triage` | diagnose spikes/collapses | `ads-anomaly-guard`, `ads-events`, `ads-changes`, `ads-pipeline-health` |
| `amazon-retail-readiness-auditor` | suppress ads on unready ASINs | `ads-retail-readiness`, `listing-health`, `stock-levels` |
| `amazon-seasonality-analyst` | demand shifts, event prep | `ads-foresight`, `ads-momentum`, `forecast`, `event-prep` |
| `amazon-profit-analyst` | true profit vs ad spend | `true-profit-rollup`, `profit-coverage`, `fba-fees-ingest`, `amazon-economics` |

### Tier 1 — Analysts (other domains, later phases)

`ebay-*` mirrors (reuse `services/marketing/ebay-ads-*`); `catalog-listing-quality`, `catalog-content-gap`, `catalog-image-quality`; `pricing-margin-guard`, `pricing-competitive-analyst`; `inventory-stockout-risk`, `inventory-replenishment`; `design-conformance-auditor`, `design-token-drift`, `design-a11y-auditor`; `ops-schema-drift`, `ops-sync-health`, `ops-tech-debt-triage`.

### Tier 2 — Directors

`amazon-ads-director`, `ebay-ads-director`, `catalog-director`, `pricing-director`, `inventory-director`, `platform-ops-director`.

A director's job, precisely: **deconflict, rank, bound, and explain the drops.** It never invents a finding. If it wants something no analyst produced, it records a gap for the strategist.

### Tier 3 — Chief Strategist

`chief-strategist`. Weekly. Reads: all Plans from the past period, all Scorecards, business context (`ads-business-context.service`, goals, cash position, stock cover, season, margin structure, factory capacity). Writes: one `AgentStrategy`. **The strategy itself requires operator approval before it binds.** This is the single highest-leverage approval in the system — approve it once a week and every downstream agent inherits your intent.

### Tier 3.5 — Critic

`plan-critic`. Runs on every Plan before queueing. **Must use a different model vendor than the director that wrote the plan.** Model diversity is worth more than model strength for adversarial review — a Sonnet critic reviewing a Sonnet director shares the director's blind spots. Its checks are the `CriticOutput` enum; each one maps to an existing deterministic check where possible (`blast-radius-guard`, `ads-authority-pins`, `ads-contest-flags`, `rank-self-competition`, `ads-write-gate` dry-run).

### Tier 4 — Auditor

`fleet-auditor`. Nightly. Attributes outcomes to executed actions (using `ads-changes` + the post-change metric window), recomputes every `AgentScorecard`, mints `AgentExemplar` rows from operator decisions, and writes the operator brief.

---

## PART 7 — Control surface

You asked for proper control over each and every thing. Here it is, enumerated, in order of bluntness.

| # | Control | Where | Effect |
|---|---|---|---|
| 1 | Global AI kill switch | `NEXUS_AI_KILL_SWITCH` (exists) | All inference stops. Deterministic jobs continue. |
| 2 | Fleet halt | `AgentFleetState.halted` | Orchestrator refuses to start. Deterministic ads automation continues. |
| 3 | Ads write mode | `NEXUS_AMAZON_ADS_MODE` (exists) | Nothing reaches Amazon. |
| 4 | Per-agent autonomy dial | `AgentCharter.autonomyLevel` | OFF / OBSERVE / PROPOSE / AUTO |
| 5 | Per-agent autonomy **cap** | `AgentCharter.autonomyCap` | Ceiling the UI cannot exceed. Set in code. |
| 6 | Per-agent scope | `scopeMarketplaces` / `scopePortfolioIds` / `scopeCampaignIds` | Drag-to-scope, mirroring `AutomationRule` (ACR.7) |
| 7 | Per-agent budget | `dailyBudgetUSD`, `maxTokensPerRun` | Hard stop mid-run |
| 8 | Fleet change budget | `AgentStrategy.allocations` | "At most N entities and €X of daily budget may move this week" |
| 9 | Tool policy | `AgentTool` (exists) | Disable a capability fleet-wide in one row |
| 10 | `alwaysAsk` floor | `tool-types.ts` (exists) | Pricing/publish/comms/spend can never auto-run |
| 11 | Write gate | `ads-write-gate.ts` (exists) | 10 independent denial reasons |
| 12 | Blast radius | `blast-radius-guard.ts` (exists) | Unattended runs use the tight thresholds |
| 13 | Authority pins | `ads-authority-pins.ts` (exists) | "I hold this campaign by hand" — no agent touches it |
| 14 | Protected terms | write-gate `keyword_protected` (exists) | Brand terms can never be negated |
| 15 | Approval inbox | `AgentApproval` + new Control Room | Per-item approve/reject, plus **reject-all-from-agent-X** |
| 16 | Charter versioning | `AgentCharter.version` | Behaviour change = diff + revert |
| 17 | Promotion gate | `AgentScorecard.promotionEligible` | Cannot promote an agent that has not earned it |
| 18 | Rollback | `rollback.service` (exists) | Every executed action carries an undo snapshot |
| 19 | Dry-run everything | `approval-gate` (exists) | You approve the actual diff, not a description |
| 20 | Model pinning | `AiFeatureModelPref` (exists) | Pin a version so a vendor update cannot change behaviour |

**The promotion ladder** (this is how you build trust incrementally rather than wagering it):

```
OFF ──merge──▶ OBSERVE ──14 days + backtest grade ≥ B──▶ PROPOSE
                                                            │
                              30 days + acceptance ≥ 70%    │
                              + calibration error ≤ 0.15    │
                              + zero rollbacks              │
                              + explicit operator sign-off  │
                                        ▼
                                       AUTO (scoped: one marketplace, one lever)
```

Demotion is automatic and immediate on: any rollback, acceptance rate below 40% over 10 decisions, a critic `block` verdict twice in a week, or a schema-validation failure rate above 5%.

---

## PART 8 — Observability and reporting

### 8.1 The trace

Every run emits OpenTelemetry GenAI-shaped spans onto `AgentStep`: `gen_ai.agent.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus Nexus attributes `naf.charter_key`, `naf.charter_version`, `naf.finding_count`, `naf.orchestration_id`.

Store in Postgres (`AgentStep`) as the system of record. Optionally *also* export to an OTLP endpoint so Langfuse (MIT, self-hostable) or Arize Phoenix can be pointed at it later without re-instrumenting. **Do not make an external observability vendor load-bearing.** The audit trail must live in your own database for the AI Act posture.

### 8.2 The Control Room

New route: `/marketing/agents` (or extend `rules-automation/control-room` — decide in Phase D; do not duplicate).

Six panels:

1. **Fleet map** — the `FLEET_GRAPH` rendered with `@xyflow/react` (already installed, already used in `_canvas/`). Node colour = autonomy level; node badge = pending findings; edge thickness = artifact volume. Click a node → agent drawer. *This is the "how it all functions" view.*
2. **Agent drawer** — charter (rendered, with a diff view against the previous version), autonomy dial, scope chips, budget, scorecard sparklines, last 20 runs, last 20 findings, cost.
3. **Decision timeline** — one row per decision: agent → finding → plan → critic verdict → approval → execution → outcome. Expandable to the full step trace. **This is the reporting answer: every decision is reconstructable end to end.**
4. **Approval inbox** — grouped by plan, with the dry-run diff, the expected effect, the critic's notes, the blast radius, and bulk actions.
5. **Cost ledger** — €/day by agent, by tier, by model; cost per accepted action; budget burn-down against caps.
6. **Brief** — the Auditor's daily narrative: what changed, what it did, what it cost, what needs you.

### 8.3 What it reports to

- **Immediate:** the approval inbox (blocking) and SSE toasts for critical findings — reuse the existing SSE bus.
- **Daily 07:00:** the Auditor brief, in the Control Room and by email (`services/email` exists; `ads-weekly-digest-mail.service` is the pattern to follow).
- **Weekly Monday:** strategist summit output, requiring your approval.
- **On anomaly:** incident mode, straight to the inbox with a triage narrative.

---

## PART 9 — Cost and model routing

### 9.1 Answering the local-vs-cloud question directly

Split by tier, because the honest answer is not "local is worse" — it is "local is worse at exactly the tier where being worse costs you money."

| Tier | Recommendation | Reason |
|---|---|---|
| T0 evidence building | **Local, always** — but it is not inference at all | It is SQL and TypeScript. Zero model cost. Most of the "intelligence" lives here. |
| T1 Analysts | **Cloud cheap tier now; local candidate after Phase J bake-off** | ~70% of token spend, narrow and schema-constrained. This is the only tier where local hardware could pay back. |
| T2 Directors | **Cloud mid tier. No compromise.** | Deconfliction across 200 findings is exactly what small models fail at. |
| Critic | **Cloud mid tier, different vendor.** | Diversity is the point. A local model here defeats the purpose. |
| T3 Strategist | **Cloud frontier. No compromise.** | Runs ~4×/month. Its output binds everything for a week. Optimising this is optimising the wrong number. |
| T4 Auditor | Cloud cheap tier | Mostly templating over structured data. |

**Does local pay back at your volume?** Run the arithmetic honestly:

- A model reliable enough for multi-tool JSON agentic work in 2026 needs roughly 128 GB of unified memory (M5 Max class, or a Ryzen AI MAX+ 395 mini-PC) or a dual-GPU workstation. That is €4,000–6,000 of capex plus power and maintenance.
- Your T1 workload — one seller, four EU marketplaces, low thousands of ad entities — with prompt caching on the static charter and Batch API on the nightly sweep, lands in the low tens of euros per month.
- Payback period is therefore measured in years, and you would be paying it in maintenance attention rather than money.

**So: local does not win on cost at your scale. It wins on privacy, latency, and freedom from rate limits.** If those become the binding constraint, the migration is a config change — which is why L9 exists. The one thing that genuinely *should* run on your own machine now is the local report-puller you already sketched: a worker that pulls Amazon/eBay reports, stores them, and does the deterministic crunching. That is T0 work, it is free, and it removes an API round-trip from every analyst run.

**How to decide without guessing** (Phase J): build `packages/shared/src/agent-fleet/eval/` with a frozen set of 200 historical situations and their known-good outcomes. Score any candidate model on: schema-validity rate, tool-selection accuracy, decision agreement with the frontier model, calibration error, and cost per accepted action. Flip an individual agent to local only when it passes. Quality becomes measured rather than assumed — which is the only version of "no compromise on quality" that means anything.

### 9.2 Cost mechanics to build in from Phase A

1. **Prompt caching.** The charter + tool schemas + strategy constraints are static across a whole sweep. Cache them. On a 25-analyst nightly sweep this is the single largest saving available.
2. **Batch API for sweeps.** The nightly analyst pass is not latency-sensitive. Roughly half price.
3. **Condensed-return artifacts.** A finding is ~400 tokens. A transcript is 40,000. Never hand a director raw analyst transcripts.
4. **Evidence precomputation.** `AgentObservation` is cached and TTL'd. Twenty analysts reading the same 14-day n-gram table should trigger one computation, not twenty.
5. **Per-run circuit breaker.** `maxTokensPerRun` and `maxToolCallsPerRun` abort mid-run, not after.
6. **Per-agent daily budget.** Reuse `AgentTool.dailyBudgetUSD`'s pattern on `AgentCharter`.
7. **Fleet daily ceiling.** One number, in `AgentFleetState`. When hit: halt, notify, do not degrade silently.
8. **Model routing by tier**, through `AiFeatureModelPref`. One feature key per tier so you can retune the whole tier in one row.
9. **No agent spawns an agent** (L3). This is the cost control that matters most, because it is the one that fails catastrophically rather than gradually.

Target steady-state: **under €60/month** for the full fleet at council cadence with a weekly summit. If a phase pushes past that, the architecture is wrong, not the budget.

---

## PART 10 — Learning and "training"

You asked whether you should control training. You should — but not by fine-tuning. Fine-tuning is the wrong tool here for three reasons: you do not yet have the thousands of labelled decisions it needs, it destroys the auditability the AI Act posture depends on, and it freezes behaviour you are still discovering.

What you should build instead, in ascending order of power:

1. **Charters in git.** The system prompt is a versioned artifact. Changing an agent's behaviour is a pull request with a diff, reviewed, revertible, and attached to a scorecard delta. This is 80% of what people mean by "training" and it is fully under your control.
2. **Exemplar injection.** Every approval and rejection mints an `AgentExemplar`. The runtime injects the top-k most relevant exemplars for the current situation into the prompt. The agent learns your preferences from your own decisions, without a training run. Rejections are worth more than approvals — a rejected proposal with your one-line reason is the highest-value datapoint in the system, so make the rejection UI ask for that line.
3. **Preference memory.** `AgentMemory` (already exists) holds durable operator rules: "never negate a term containing the brand name", "budget increases in steps of ≤20%", "IT market is price-sensitive, prefer efficiency over volume". These are injected as constraints, not suggestions.
4. **Eval suite + backtest gate.** `advertising/autopilot/backtest.ts` already exists. Extend it: replay a charter change against frozen historical windows, compare against the shipped charter, block the merge on regression. This is the CI gate that makes charter edits safe.
5. **Calibration feedback.** The Auditor compares stated confidence against realised hit rate and writes `calibrationError`. An agent that says 0.9 and hits 0.5 gets its confidence claims discounted in the director's ranking — and appears in your brief as needing a charter fix.

Fine-tuning becomes worth reconsidering only when you have ~10k labelled decisions *and* a specific narrow task where a local model must match a frontier model. Realistically 12+ months out, and possibly never.

---

## PART 11 — Graph engineering: what to do and what to skip

Three different things travel under this name. Do two.

### ✅ Do — Orchestration as a graph (Phase A)

The `FLEET_GRAPH` DAG. Not a framework — a declared structure your orchestrator walks and your Control Room draws. It gives you the visual, controllable model of "how it all functions" that you asked for, from one source of truth.

### ✅ Do — A typed commerce entity graph in Postgres (Phase H)

This is the genuinely high-value one, and it is the thing that separates a fleet of agents from a fleet of *coordinated* agents.

Right now an analyst can tell you "raise this bid." It cannot tell you that raising it will cannibalise a sibling campaign, cross-compete with your own exact-match on the same term, or over-commit spend against a variant whose stock cover is nine days. The signals exist in the codebase — `rank-self-competition.ts`, `keyword-conflicts.service.ts`, `ads-dedupe-campaigns`, `ProductVariation` — but they are pairwise checks, not a traversable structure.

The `GraphEdge` model in Part 4 makes them one. Entities: Product, ASIN, Variation, Keyword, SearchTerm, Target, AdGroup, Campaign, Portfolio, Marketplace, Competitor. Relations: `TARGETS`, `HARVESTED_FROM`, `NEGATED_IN`, `COMPETES_WITH`, `CANNIBALIZES`, `SHARES_INVENTORY`, `VARIANT_OF`, `PROMOTED_BY`, `RANKS_FOR`, `SUPPRESSED_BY`.

Then a director can ask, in one recursive CTE: *"what else moves if I touch this node?"* — and the critic can check `no_self_competition` and `inventory_supports_spend` structurally instead of heuristically.

**Postgres, not Neo4j.** At your scale (low tens of thousands of nodes) a depth-3 recursive CTE with the right indexes is single-digit milliseconds. A second database is a second backup story, a second migration story, and a second place for truth to drift. If you ever want Cypher specifically, Apache AGE runs inside Postgres. Neo4j earns its keep at hundreds of millions of edges; you are three orders of magnitude away.

### ❌ Skip — GraphRAG over documents

Your knowledge is not documents. It is structured rows with exact semantics. GraphRAG's indexing costs 10–40× vector RAG's and it *underperforms* plain retrieval on single-hop factual lookup — which is most of what an ads agent needs. Revisit only if you later build a large corpus of unstructured internal knowledge (supplier contracts, compliance docs, factory SOPs). Not now.

---

## PART 12 — Phase plan

Each phase: deliverable, acceptance criteria, approval gate. Do not proceed without approval.

---

### PHASE A — Foundation (ships dark)

**Build**
- Prisma: `AgentCharter`, `AgentObservation`, `AgentFinding`, `AgentPlan`, `AgentStrategy`, `AgentStep`, `AgentExemplar`, `AgentScorecard`, `AgentFleetState`. Extend `AgentRun`. Migration committed with the schema.
- `packages/shared/src/agent-fleet/contracts.ts` — every Zod schema in Part 5, unit-tested.
- `apps/api/src/services/agent-fleet/`:
  - `charter-registry.ts` — charters defined in code, seeded to DB, code is truth for *what*, DB for *whether/how*. Same split as `tool-policy.service.ts`.
  - `observation-builder.ts` — registry of deterministic evidence builders, each wrapping existing ads services, with TTL caching into `AgentObservation`.
  - `agent-executor.ts` — run one agent: resolve charter → gather observations → build prompt (charter + strategy constraints + memory + exemplars + observations) → call model via `model-resolver` → validate output → persist artifacts → emit `AgentStep` rows.
  - `orchestrator.ts` — walk `FLEET_GRAPH`, bounded concurrency, budget accounting, halt checks.
  - `fleet-graph.ts` — the DAG.
  - `budget-guard.ts` — per-run, per-agent-day, per-fleet-day ceilings with mid-run abort.
  - `tracing.ts` — OTel GenAI attribute shaping.
- Routes: `/api/agent-fleet/charters`, `/runs`, `/findings`, `/plans`, `/graph`, `/state` (read-only + halt toggle).

**Acceptance**
- `tsc --noEmit` clean; vitest green; `check:drift` clean.
- One trivial charter (`fleet-selftest`) runs end to end in OBSERVE and produces a validated `Finding` from a real observation.
- Budget abort demonstrably fires mid-run in a test.
- Zero behaviour change to any existing job, rule, or route. `enabled=false` everywhere.

**Do not:** touch `ads-write-gate.ts`, `approval-gate.service.ts`, or any existing service's signature.

---

### PHASE B — Three analysts in OBSERVE

**Build** `amazon-negative-miner`, `amazon-keyword-harvester`, `amazon-bid-tuner`. Charters, observation builders wrapping `ads-ngram` / `ads-harvest` / `ads-bid-optimizer` + `ads-bayesian-bidding` + `ads-target-acos`. Nightly sweep via cron-registry. Findings only — no plan, no approval, no write.

Plus: a shadow-grading job that, for each finding, records what the deterministic engine independently proposed for the same entity, so agreement can be measured from day one.

**Acceptance**
- 14 consecutive nightly sweeps with zero schema-validation failures.
- Every finding carries ≥1 `evidenceRef` and a `dataVintage` within its charter's staleness tolerance.
- Cost per sweep ≤ €0.50.
- A written comparison: agent findings vs. what `ads-auto-harvest` / `ads-auto-bid` proposed for the same entities. Disagreements enumerated and explained.

**Gate:** operator reads 50 findings and judges them. This is the moment to kill the project cheaply if the findings are noise.

---

### PHASE C — Director + Critic (PROPOSE)

**Build** `amazon-ads-director` and `plan-critic`. Director consumes findings → `DirectorOutput` → `AgentPlan`. Critic (different vendor) runs the twelve checks, wiring each to its deterministic counterpart where one exists. Passing plans enter the existing approval gate as `AgentApproval` rows, one per item, with dry-run previews.

**Acceptance**
- Every plan explains its drops (`dropped[].reason` non-trivial) and its conflicts.
- Critic blocks at least one genuinely bad plan during a seeded adversarial test.
- No approval is created without a dry-run preview.
- `blast-radius-guard` thresholds enforced with unattended values.
- Nothing reaches Amazon. `NEXUS_AMAZON_ADS_MODE` remains sandbox for this phase.

---

### PHASE D — Control Room

**Build** the six panels from Part 8.2. Reuse `@xyflow/react`, `_canvas/` primitives, and the H10 design tokens. Decide explicitly whether to extend `rules-automation/control-room` or create `/marketing/agents` — and write the decision into the plan doc.

**Acceptance**
- Any executed decision is reconstructable end to end from the timeline in ≤3 clicks.
- Reject-all-from-agent works.
- `npm run tokens:check` passes. No raw hex, no raw ramp, no raw Tailwind palette.
- Cost ledger reconciles to the sum of `AgentStep.costUSD` for the period.

---

### PHASE E — Promotion ladder, scorecards, exemplars

**Build** `fleet-auditor`, `AgentScorecard` computation, outcome attribution via `ads-changes` + post-change metric windows, exemplar minting on every operator decision (with a mandatory one-line reason on reject), exemplar retrieval into prompts, and the promotion/demotion state machine from Part 7.

**Acceptance**
- Scorecards computed nightly for every charter.
- Calibration error computed and displayed.
- Promotion is impossible via the API when `promotionEligible=false` — enforced server-side, not in the UI.
- Demotion fires automatically in a seeded rollback test.

---

### PHASE F — First AUTO, tightly scoped

**Build** nothing new. Promote exactly one agent — `amazon-negative-miner`, one marketplace, one campaign scope — to AUTO. Negative keywords are the correct first choice: high-frequency, low-value-per-action, immediately reversible, and the failure mode is lost impressions rather than lost money.

**Acceptance**
- 30 days at AUTO with zero rollbacks.
- Realised impact attributed and positive.
- A written post-mortem covering every action taken.

**Gate:** operator sign-off before any second agent is promoted.

---

### PHASE G — Fleet expansion + Chief Strategist

**Build** the remaining Amazon analysts (Part 6), the eBay director and its analysts, and `chief-strategist` with `AgentStrategy` binding downstream. Strategy requires operator approval before it takes effect.

**Acceptance**
- ≥15 analysts, ≥2 directors running at council cadence.
- Strategy constraints demonstrably rejected a director's item in a test.
- Total fleet cost ≤ €60/month.
- Every new agent starts at OBSERVE. No exceptions, no fast-tracking.

---

### PHASE H — Entity graph

**Build** `GraphEdge`, edge derivation jobs (from existing `ProductVariation`, `Campaign`→`AdGroup`→`Target`, harvest lineage, `keyword-conflicts`, `rank-self-competition`, stock sharing), recursive-CTE traversal service, graph-aware critic checks (`no_self_competition`, `inventory_supports_spend`, `no_cannibalization`), and a graph view in the Control Room.

**Acceptance**
- Depth-3 traversal p95 under 50 ms on production data volume.
- Critic catches a seeded self-competition case that the pairwise checks miss.
- Zero new database systems introduced.

---

### PHASE I — Non-commerce agents

**Build** `design-conformance-auditor` (AST/regex scan against the token + component catalogue, LLM only for "is this a justified exception?"), `design-token-drift`, `ops-schema-drift`, `ops-sync-health`, `ops-tech-debt-triage`. Findings feed a `platform-ops-director`; proposed actions are pull requests and issues, never direct writes.

**Acceptance**
- The design auditor finds real violations that `token-guard.mjs` cannot express (semantic inconsistency, not syntactic).
- False-positive rate under 20% on a hand-labelled sample.
- No agent has write access to the repository.

---

### PHASE J — Model economics + MCP

**Build** the eval harness (Part 9.1), the local OpenAI-compatible provider in `services/ai/providers/`, a scheduled bake-off report, and — separately — expose the tool registry as an MCP server so Claude Code, Claude Desktop, and the Excel add-in can drive Nexus through the same governed path.

**Acceptance**
- Bake-off report produced for every tier against the frozen eval set.
- Local provider works end to end for at least one analyst without code changes outside config.
- MCP server enforces the identical tool policy and approval gate — verified by test, not by inspection.

---

## PART 13 — Anti-goals

Things that will look tempting and are wrong:

1. **A general "ads copilot" that does everything.** Narrow agents with narrow charters. A broad charter is an unmeasurable charter.
2. **Agents that chat with each other.** Blackboard only (L7).
3. **Rebuilding the deterministic services as prompts.** They are the moat (L1).
4. **A second rules engine.** `AutomationRule` exists. Agents propose *through* it where a rule fits.
5. **A second autonomy dial.** `ads-autonomy.ts` exists. Reuse it.
6. **A second approval queue.** `AgentApproval` exists.
7. **An agent framework dependency.** Part 3.3.
8. **Neo4j.** Part 11.
9. **Fine-tuning before 10k labelled decisions.** Part 10.
10. **Skipping OBSERVE because an agent "obviously works".** The promotion ladder is the product.
11. **Letting an agent write to Amazon without a dry-run preview a human saw.** L2, and it is also the legal position.
12. **Optimising the strategist's token cost.** It is 3% of spend and 100% of direction.

---

## PART 14 — Ready-to-paste kickoff for Phase A

```
Read docs/AGENT_CONTROL_PLANE.md, docs/2026-08-03-ads-autonomy-domination-adx.md,
and docs/2026-08-05-ads-control-room-coverage-acr.md first.

Then read this brief: NEXUS-AGENT-FLEET-MASTER-BRIEF.md — Parts 0-3 (invariants)
and Part 12 § PHASE A.

Write the implementation plan to docs/2026-08-XX-naf-a-foundation.md in the house
format used by docs/superpowers/plans/*.md: Goal, Architecture, Tech Stack, Global
Constraints, File Structure, then numbered Tasks with checkbox steps and TDD
(failing test first) for every pure module.

Constraints for the plan:
- Additive only. No existing service signature changes. No changes to
  ads-write-gate.ts, approval-gate.service.ts, tool-policy.service.ts.
- Everything ships dark (enabled=false).
- Prisma migration committed alongside schema.prisma.
- Every pure module unit-tested with vitest.
- tsc --noEmit clean; npm run check:drift clean.
- Commit per task with explicit paths (working tree has unrelated WIP).

Do NOT write implementation code yet. Produce the plan, list the open questions
and the decisions you need from me, and stop.

ultrathink
```

---

## Appendix — Market position

From the 2026 landscape, for context on what "best in the industry" has to clear:

- **Pacvue Agent** (April 2026, Amazon-only at launch, expanding through 2026): analysis → recommendation → *governed execution* in one workflow, natural-language AMC SQL generation, plus MCP work to connect commerce data to external AI tools. Their CPO's public position is that general-purpose LLMs cannot handle commerce-media complexity, which is why they built a domain-specific model.
- **Skai Celeste** (April 2025, a year earlier): breadth-first — 200+ publishers at launch, later 300+ via MCP.
- **Yahoo DSP Agent Network** (2026): specialised third-party agents plugging into a host platform rather than one vendor's native agent.
- **PubMatic AgenticOS**, **LiveRamp** agents, **Yahoo DSP** native agents: the whole category moved from dashboards to agent execution during 2026.
- **IAB Tech Lab agentic standards roadmap** (January 2026): an attempt to keep these implementations interoperable.

Where Nexus can actually be better, stated plainly: the incumbents are building a general agent over a shallow domain model, and charging for governance as a feature. Nexus already has the deep domain model — 170 tested services, a ten-reason write gate, a blast-radius guard, an autonomy dial, authority pins, and a rollback path — and one operator who wants total control rather than a plausible dashboard. That combination is not something a platform serving 70,000 brands can offer, because per-account depth is exactly what they cannot afford.

The differentiator is therefore not "we have agents too." It is **the audit trail**: every decision reconstructable from evidence to euro, every agent graded, every promotion earned. Build that and the agents are the easy part.
